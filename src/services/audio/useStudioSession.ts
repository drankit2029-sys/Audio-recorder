// src/services/audio/useStudioSession.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import {
  runOnJS,
  useAnimatedReaction,
  useFrameCallback,
  useSharedValue,
} from 'react-native-reanimated';

import {
  StudioEngine,
  StudioErrorEvent,
  StudioFinalizeOptions,
  StudioFinalizeResult,
  StudioMeterEvent,
  StudioMode,
  StudioNotificationEvent,
  StudioProgressEvent,
  StudioSessionInfo,
  StudioSnapshot,
  StudioStatus,
} from '../../../modules/audio-hardware-router/src';

/**
 * PREVIEWING = playing the take back from the playhead (Replace not armed).
 * STOPPED / ERROR are kept for components that still switch on them.
 */
export type EngineState = 'IDLE' | 'RECORDING' | 'PAUSED' | 'PREVIEWING' | 'STOPPED' | 'ERROR';

export const isSessionState = (state: EngineState): boolean =>
  state === 'RECORDING' || state === 'PAUSED' || state === 'PREVIEWING';

/** A playhead this close to the end counts as "at the end" (the next take appends). */
export const END_EPSILON_MS = 60;

/** Native position reports further than this from the UI clock re-anchor it hard. */
const DRIFT_SNAP_MS = 80;
/** Watchdog: a running capture that stops reporting for this long is re-synced. */
const METER_SILENCE_MS = 4000;

export interface StudioTelemetry {
  meteringDb: number;
}

export interface UseStudioSessionOptions {
  onNotificationAction?: (action: StudioNotificationEvent['action']) => void;
  onError?: (event: StudioErrorEvent) => void;
  /** A Replace pass reached the end of the old audio and is now appending. */
  onCaughtUp?: () => void;
}

const IDLE_SNAPSHOT: StudioSnapshot = {
  hasSession: false,
  mode: 'idle',
  positionMs: 0,
  durationMs: 0,
  overwriting: false,
};

const mapMode = (mode: StudioMode | undefined, hasSession: boolean): EngineState => {
  if (!hasSession) return 'IDLE';
  switch (mode) {
    case 'recording':
      return 'RECORDING';
    case 'previewing':
      return 'PREVIEWING';
    case 'paused':
      return 'PAUSED';
    default:
      return 'IDLE';
  }
};

/**
 * One studio take at a time, owned by the native StudioEngine.
 *
 * Native state is the source of truth. The playhead that the waveform, the
 * timer and the prompter follow lives on the UI thread: it is extrapolated
 * every frame from the last native position report and gently corrected, so
 * it moves at display rate without a 60 Hz bridge stream.
 */
export function useStudioSession(options: UseStudioSessionOptions = {}) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [engineState, setEngineStateRaw] = useState<EngineState>('IDLE');
  const engineStateRef = useRef<EngineState>('IDLE');
  const [overwriting, setOverwritingRaw] = useState(false);
  const overwritingRef = useRef(false);
  const [isBeforeEnd, setIsBeforeEnd] = useState(false);
  const [progress, setProgress] = useState<StudioProgressEvent | null>(null);
  const [sessionInfo, setSessionInfoRaw] = useState<StudioSessionInfo | null>(null);
  const sessionInfoRef = useRef<StudioSessionInfo | null>(null);

  const telemetry = useRef<StudioTelemetry>({ meteringDb: -60 });
  const smoothedDbRef = useRef(-60);

  const playheadMs = useSharedValue(0);
  const durationMs = useSharedValue(0);
  const peaks = useSharedValue<number[]>([]);
  const isScrubbing = useSharedValue(false);
  const isRunning = useSharedValue(false);
  const isRecording = useSharedValue(false);
  const isAppending = useSharedValue(false);
  const anchorMs = useSharedValue(0);
  const anchorAt = useSharedValue(0);
  /**
   * True while a user-initiated mode switch (preview <-> record) is in
   * flight. The native switch takes a few hundred ms (AudioTrack /
   * AudioRecord setup); freezing the playhead clock across it is what makes
   * the punch-in / punch-out transition read as one continuous motion
   * instead of a jump backwards.
   */
  const isTransitioning = useSharedValue(false);

  const anchorRef = useRef({ ms: 0, at: 0 });
  const durationRef = useRef(0);
  const peakCountRef = useRef(0);
  const hasEditsRef = useRef(false);
  const lastMeterAtRef = useRef(0);
  const scrubPauseRef = useRef(false);
  /**
   * The position the user last asked the engine to start from. Snapshots
   * that merely echo that start (command return + native state event) must
   * not re-anchor the clock, or the playhead snaps back to the start frame.
   */
  const lastActionRef = useRef<{ at: number; pos: number } | null>(null);
  const switchGuardRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setEngineState = useCallback((next: EngineState) => {
    engineStateRef.current = next;
    setEngineStateRaw(next);
  }, []);

  const setOverwriting = useCallback((next: boolean) => {
    overwritingRef.current = next;
    setOverwritingRaw(next);
  }, []);

  const setSessionInfo = useCallback((info: StudioSessionInfo | null) => {
    sessionInfoRef.current = info;
    setSessionInfoRaw(info);
  }, []);

  // ---- UI-thread clock -----------------------------------------------------
  const clock = useFrameCallback(() => {
    'worklet';
    if (!isRunning.value || isScrubbing.value || isTransitioning.value) return;
    let t = anchorMs.value + (Date.now() - anchorAt.value);
    if (t < 0) t = 0;
    if (!isRecording.value && t > durationMs.value) t = durationMs.value;
    const current = playheadMs.value;
    // Small corrections never move the playhead backwards.
    if (t < current && current - t < 40) t = current;
    playheadMs.value = t;
    if (isAppending.value && t > durationMs.value) durationMs.value = t;
  }, false);

  useEffect(() => {
    clock.setActive(engineState === 'RECORDING' || engineState === 'PREVIEWING');
  }, [engineState, clock]);

  useAnimatedReaction(
    () => playheadMs.value < durationMs.value - END_EPSILON_MS,
    (current, previous) => {
      if (current !== previous) runOnJS(setIsBeforeEnd)(current);
    },
    []
  );

  // ---- state application -----------------------------------------------------
  const resetMeter = () => {
    smoothedDbRef.current = -60;
    telemetry.current.meteringDb = -60;
  };

  const applySnapshot = useCallback(
    (snap: StudioSnapshot, reason?: string) => {
      const next = mapMode(snap.mode, snap.hasSession);
      const now = Date.now();
      const running = next === 'RECORDING' || next === 'PREVIEWING';
      const appending = next === 'RECORDING' && !snap.overwriting;

      // A snapshot that merely echoes a user-initiated start (the command's
      // return value, then the native state event for the same switch) keeps
      // the playhead and anchor where the user saw them; the command path is
      // authoritative. Without this the playhead snaps back to the exact
      // start frame on every punch-in / punch-out.
      const last = lastActionRef.current;
      const preserveAnchor =
        (reason === 'record' || reason === 'replace' || reason === 'play') &&
        last !== null &&
        now - last.at < 1500 &&
        Math.abs(snap.positionMs - last.pos) < 250;

      if (!preserveAnchor) {
        anchorRef.current = { ms: snap.positionMs, at: now };
        anchorMs.value = snap.positionMs;
        anchorAt.value = now;
      }
      durationRef.current = preserveAnchor
        ? Math.max(durationRef.current, snap.durationMs)
        : snap.durationMs;
      isRunning.value = running;
      isRecording.value = next === 'RECORDING';
      isAppending.value = appending;

      if (next === 'IDLE') {
        playheadMs.value = 0;
        durationMs.value = 0;
        peaks.value = [];
        peakCountRef.current = 0;
        hasEditsRef.current = false;
        scrubPauseRef.current = false;
        lastActionRef.current = null;
        isTransitioning.value = false;
        if (sessionInfoRef.current) setSessionInfo(null);
      } else {
        const fromScrubPause = scrubPauseRef.current && next === 'PAUSED';
        if (fromScrubPause) scrubPauseRef.current = false;
        const keepPlayhead =
          fromScrubPause || reason === 'caught_up' || preserveAnchor || isScrubbing.value;
        if (!keepPlayhead) playheadMs.value = snap.positionMs;
        if (reason !== 'caught_up' && !preserveAnchor) {
          durationMs.value = snap.durationMs;
        } else if (snap.durationMs > durationMs.value) {
          // While a Replace pass catches up and appends, the take keeps
          // growing; never shrink the bar backwards.
          durationMs.value = snap.durationMs;
        }
      }

      if (next === 'RECORDING') hasEditsRef.current = true;
      if (!running) resetMeter();
      setOverwriting(next === 'RECORDING' && snap.overwriting);
      setEngineState(next);
    },
    // Shared values and refs are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setEngineState, setOverwriting, setSessionInfo]
  );

  const applyPeakDelta = useCallback(
    (start: number, values: number[]) => {
      peakCountRef.current = Math.max(peakCountRef.current, start + values.length);
      peaks.modify((arr) => {
        'worklet';
        for (let i = arr.length; i < start; i++) arr.push(0);
        for (let i = 0; i < values.length; i++) arr[start + i] = values[i];
        return arr;
      });
    },
    [peaks]
  );

  const handleMeter = useCallback(
    (e: StudioMeterEvent) => {
      lastMeterAtRef.current = Date.now();

      const raw = Number.isFinite(e.db) ? e.db : -60;
      const clamped = Math.max(-60, Math.min(0, raw));
      const prev = smoothedDbRef.current;
      smoothedDbRef.current =
        clamped > prev ? prev + (clamped - prev) * 0.85 : prev + (clamped - prev) * 0.18;
      telemetry.current.meteringDb = Math.round(smoothedDbRef.current * 10) / 10;

      if (e.peaks && e.peaks.length > 0) applyPeakDelta(e.peakStart, e.peaks);
      durationRef.current = e.durationMs;

      const state = engineStateRef.current;
      // Meter events that arrive while a mode switch is in flight belong to
      // the old (or newly starting) engine; let the command path own the
      // re-anchor instead of pulling the frozen playhead around.
      if (!isTransitioning.value && (state === 'RECORDING' || state === 'PREVIEWING')) {
        const now = Date.now();
        const a = anchorRef.current;
        const predicted = a.ms + (now - a.at);
        const drift = e.positionMs - predicted;
        anchorRef.current =
          Math.abs(drift) > DRIFT_SNAP_MS
            ? { ms: e.positionMs, at: now }
            : { ms: a.ms + drift * 0.12, at: a.at };
        anchorMs.value = anchorRef.current.ms;
        anchorAt.value = anchorRef.current.at;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [applyPeakDelta]
  );

  const loadPeaks = useCallback(async () => {
    const arr = await StudioEngine.getPeaks(0, -1);
    peaks.value = arr;
    peakCountRef.current = arr.length;
  }, [peaks]);

  // ---- native events -----------------------------------------------------------
  useEffect(() => {
    const subs = [
      StudioEngine.addListener('studioState', (e) => {
        applySnapshot(e, e.reason);
        if (e.reason === 'caught_up') optionsRef.current.onCaughtUp?.();
      }),
      StudioEngine.addListener('studioMeter', handleMeter),
      StudioEngine.addListener('studioProgress', (e) => setProgress(e)),
      StudioEngine.addListener('studioError', (e) => optionsRef.current.onError?.(e)),
      StudioEngine.addListener('studioNotificationAction', (e) =>
        optionsRef.current.onNotificationAction?.(e.action)
      ),
    ];
    return () => subs.forEach((s) => s?.remove());
  }, [applySnapshot, handleMeter]);

  const resync = useCallback(async () => {
    const status = await StudioEngine.getStatus();
    if (!status) return;
    if (!status.hasSession && engineStateRef.current === 'IDLE') return;
    if (status.hasSession && (status.peakCount ?? 0) !== peakCountRef.current) {
      try {
        await loadPeaks();
      } catch {}
    }
    applySnapshot(status, 'resync');
  }, [applySnapshot, loadPeaks]);

  // Watchdog: capture that stops reporting is re-read from native.
  useEffect(() => {
    if (engineState !== 'RECORDING') return;
    lastMeterAtRef.current = Date.now();
    const id = setInterval(() => {
      if (AppState.currentState !== 'active') return;
      if (Date.now() - lastMeterAtRef.current < METER_SILENCE_MS) return;
      lastMeterAtRef.current = Date.now();
      void resync();
    }, 2000);
    return () => clearInterval(id);
  }, [engineState, resync]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        void resync();
      } else if (next === 'background' && engineStateRef.current === 'PREVIEWING') {
        StudioEngine.pause().catch(() => {});
      }
    });
    return () => sub.remove();
  }, [resync]);

  // ---- commands ------------------------------------------------------------------
  const createAndRecord = useCallback(
    async (o: {
      sampleRate: number;
      channels: number;
      bitDepth: 16 | 32;
      badge: string;
      inputDeviceId: number;
    }): Promise<StudioSessionInfo> => {
      const info = await StudioEngine.createSession({
        sampleRate: o.sampleRate,
        channels: o.channels,
        bitDepth: o.bitDepth,
        badge: o.badge,
      });
      setSessionInfo(info);
      peaks.value = [];
      peakCountRef.current = 0;
      durationMs.value = 0;
      playheadMs.value = 0;
      hasEditsRef.current = false;
      try {
        const snap = await StudioEngine.record({ positionMs: -1, inputDeviceId: o.inputDeviceId });
        applySnapshot(snap, 'record');
      } catch (e) {
        try {
          await StudioEngine.discard();
        } catch {}
        applySnapshot(IDLE_SNAPSHOT, 'closed');
        throw e;
      }
      return info;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [applySnapshot, setSessionInfo]
  );

  const openSession = useCallback(
    async (sourcePath: string, mode: 'edit' | 'recover', badge: string) => {
      setProgress({ phase: 'open', progress: 0 });
      try {
        const info = await StudioEngine.openSession({ sourcePath, mode, badge });
        setSessionInfo(info);
        await loadPeaks();
        hasEditsRef.current = mode === 'recover';
        applySnapshot(
          {
            hasSession: true,
            mode: 'paused',
            positionMs: mode === 'recover' ? info.durationMs : 0,
            durationMs: info.durationMs,
            overwriting: false,
          },
          'open'
        );
        return info;
      } finally {
        setProgress(null);
      }
    },
    [applySnapshot, loadPeaks, setSessionInfo]
  );

  const reattach = useCallback(
    async (status: StudioStatus) => {
      setSessionInfo({
        sessionId: status.sessionId ?? '',
        sessionPath: status.sessionPath ?? '',
        sampleRate: status.sampleRate ?? 48000,
        channels: status.channels ?? 1,
        floatPcm: !!status.floatPcm,
        durationMs: status.durationMs,
        dataBytes: status.dataBytes ?? 0,
        peakCount: status.peakCount ?? 0,
        peakBucketMs: status.peakBucketMs ?? 20,
      });
      await loadPeaks();
      hasEditsRef.current = !!status.hasEdits;
      applySnapshot(status, 'reattach');
    },
    [applySnapshot, loadPeaks, setSessionInfo]
  );

  /**
   * Freeze the playhead clock before a mode switch. The caller must let
   * record()/preview() finish (they release the freeze) or call endSwitch()
   * if the switch is abandoned. A safety timer releases the freeze even if
   * nothing else does.
   */
  const beginSwitch = useCallback(() => {
    lastActionRef.current = { at: Date.now(), pos: playheadMs.value };
    isTransitioning.value = true;
    if (switchGuardRef.current) clearTimeout(switchGuardRef.current);
    switchGuardRef.current = setTimeout(() => {
      isTransitioning.value = false;
    }, 5000);
  }, [playheadMs]);

  const endSwitch = useCallback(() => {
    isTransitioning.value = false;
    if (switchGuardRef.current) {
      clearTimeout(switchGuardRef.current);
      switchGuardRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (switchGuardRef.current) clearTimeout(switchGuardRef.current);
    };
  }, []);

  /** Negative position = append at the end. */
  const record = useCallback(
    async (positionMs: number, inputDeviceId: number) => {
      // The playhead the user saw is the truth for the transition; the
      // native snapshot may differ by frame rounding or switch latency.
      const uiPos = positionMs < 0 ? durationRef.current : positionMs;
      if (positionMs >= 0) {
        lastActionRef.current = { at: Date.now(), pos: uiPos };
      } else {
        lastActionRef.current = null;
      }
      isTransitioning.value = true;
      try {
        const snap = await StudioEngine.record({ positionMs, inputDeviceId });
        hasEditsRef.current = true;
        applySnapshot(snap, snap.overwriting ? 'replace' : 'record');
        // Re-anchor the clock at the position the user saw, so the take
        // keeps moving from exactly there.
        if (positionMs >= 0) {
          const now = Date.now();
          anchorRef.current = { ms: uiPos, at: now };
          anchorMs.value = uiPos;
          anchorAt.value = now;
          playheadMs.value = uiPos;
        }
      } catch (e) {
        try {
          await resync();
        } catch {}
        throw e;
      } finally {
        endSwitch();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [applySnapshot, anchorAt, anchorMs, playheadMs, endSwitch, resync]
  );

  const preview = useCallback(async (positionMs: number) => {
    const dur = durationRef.current;
    const uiPos = Math.max(0, Math.min(positionMs, dur));
    lastActionRef.current = { at: Date.now(), pos: uiPos };
    isTransitioning.value = true;
    try {
      await StudioEngine.play(positionMs);
      // Flip the UI immediately instead of waiting for the native state
      // event to round-trip; the event will echo this same snapshot.
      applySnapshot(
        {
          hasSession: true,
          mode: 'previewing',
          positionMs: uiPos,
          durationMs: dur,
          overwriting: false,
        },
        'play'
      );
      const now = Date.now();
      anchorRef.current = { ms: uiPos, at: now };
      anchorMs.value = uiPos;
      anchorAt.value = now;
      playheadMs.value = uiPos;
    } catch (e) {
      try {
        await resync();
      } catch {}
      throw e;
    } finally {
      endSwitch();
    }
  }, [applySnapshot, anchorAt, anchorMs, playheadMs, endSwitch, resync]);

  const pause = useCallback(async (): Promise<StudioSnapshot> => {
    const snap = await StudioEngine.pause();
    applySnapshot(snap, 'pause');
    return snap;
  }, [applySnapshot]);

  /** The waveform grabbed the playhead: stop a preview without moving it. */
  const pauseForScrub = useCallback(async () => {
    if (engineStateRef.current !== 'PREVIEWING') return;
    scrubPauseRef.current = true;
    try {
      await StudioEngine.pause();
    } catch {
      scrubPauseRef.current = false;
    }
  }, []);

  const seek = useCallback(async (positionMs: number) => {
    try {
      await StudioEngine.seek(positionMs);
    } catch {}
  }, []);

  const finalize = useCallback(
    async (o: StudioFinalizeOptions): Promise<StudioFinalizeResult> => {
      setProgress({ phase: 'save', progress: 0 });
      try {
        const result = await StudioEngine.finalize(o);
        applySnapshot(IDLE_SNAPSHOT, 'closed');
        return result;
      } finally {
        setProgress(null);
      }
    },
    [applySnapshot]
  );

  const discard = useCallback(async () => {
    await StudioEngine.discard();
    applySnapshot(IDLE_SNAPSHOT, 'closed');
  }, [applySnapshot]);

  /** UI-thread playhead (authoritative while scrubbing). */
  const getPlayheadMs = useCallback(() => playheadMs.value, [playheadMs]);
  /**
   * Native take length, mirrored synchronously on the JS side (a shared value
   * written from JS reaches the UI thread asynchronously).
   */
  const getDurationMs = useCallback(() => durationRef.current, []);

  return {
    engineState,
    engineStateRef,
    overwriting,
    overwritingRef,
    isBeforeEnd,
    progress,
    sessionInfo,
    sessionInfoRef,
    hasEditsRef,
    telemetry,
    playheadMs,
    durationMs,
    peaks,
    isScrubbing,
    isRunning,
    isRecording,
    getPlayheadMs,
    getDurationMs,
    createAndRecord,
    openSession,
    reattach,
    record,
    preview,
    pause,
    pauseForScrub,
    seek,
    finalize,
    discard,
    resync,
    beginSwitch,
    endSwitch,
  };
}

export type StudioSession = ReturnType<typeof useStudioSession>;
