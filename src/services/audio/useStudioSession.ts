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
  StudioInterruptionEvent,
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
/**
 * A mode switch used to hold the playhead frozen until the hardware proved it
 * was live, which is exactly what the eye reads as "the preview/replace button
 * lags". With the warm mic and warm output track the audio really does start
 * well inside this window, so the clock resumes after a short beat and any
 * residual error is absorbed as a smooth slide (see ANCHOR_BLEND_*).
 */
const FIRST_METER_SOFT_MS = 140;
/** Hard stop: if no meter ever arrives, the freeze cannot wedge the UI. */
const FIRST_METER_HARD_MS = 1500;
/** Fraction of a residual drift taken out of the playhead on each meter. */
const ANCHOR_BLEND_SLOW = 0.12;
/** A first meter may correct a little harder, but still never jumps. */
const ANCHOR_BLEND_FIRST = 0.45;

export interface StudioTelemetry {
  meteringDb: number;
}

export interface UseStudioSessionOptions {
  onNotificationAction?: (action: StudioNotificationEvent['action']) => void;
  onError?: (event: StudioErrorEvent) => void;
  /** Something we did not ask for stopped (or will stop) the take. */
  onInterruption?: (event: StudioInterruptionEvent) => void;
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
  /**
   * Bumped (on the JS side) whenever the peak table grew by a block. The
   * waveform rebuilds its level-of-detail tables on this signal instead of
   * reading the whole peak array on every meter tick.
   */
  const [peakVersion, setPeakVersion] = useState(0);
  const peakVersionAtRef = useRef(0);
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
  /**
   * The mode we are waiting for the first hardware meter of. The playhead
   * clock is frozen for a short beat across a mode switch (the native audio
   * path needs a moment to prime) and then released optimistically; the
   * first meter still re-anchors the clock, and if the UI had already been
   * running the residual error is absorbed as a waveform slide instead of a
   * playhead jump.
   */
  const awaitingFirstMeterRef = useRef<EngineState | null>(null);
  const firstMeterGuardRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstMeterHardGuardRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** True once the soft release let the clock run ahead of the (still
   *  unconfirmed) first meter: the correction then has to be absorbed
   *  visually instead of by moving the playhead. */
  const playheadSoftRunningRef = useRef(false);

  const releaseFirstMeterWait = useCallback(() => {
    awaitingFirstMeterRef.current = null;
    playheadSoftRunningRef.current = false;
    if (firstMeterGuardRef.current) {
      clearTimeout(firstMeterGuardRef.current);
      firstMeterGuardRef.current = null;
    }
    if (firstMeterHardGuardRef.current) {
      clearTimeout(firstMeterHardGuardRef.current);
      firstMeterHardGuardRef.current = null;
    }
    // Also clear the beginSwitch() safety timer: a stale 5 s guard could
    // otherwise fire into the middle of a *new* switch and release that
    // freeze early.
    if (switchGuardRef.current) {
      clearTimeout(switchGuardRef.current);
      switchGuardRef.current = null;
    }
    isTransitioning.value = false;
  }, [isTransitioning]);

  const armFirstMeterWait = useCallback(
    (expected: EngineState) => {
      awaitingFirstMeterRef.current = expected;
      playheadSoftRunningRef.current = false;
      if (firstMeterGuardRef.current) clearTimeout(firstMeterGuardRef.current);
      // Resume the clock shortly after the switch instead of waiting for the
      // first hardware meter: at display rate a frozen playhead reads as lag,
      // while a warm mic / warm output starts well inside one frame budget.
      firstMeterGuardRef.current = setTimeout(() => {
        if (awaitingFirstMeterRef.current === expected) {
          isTransitioning.value = false;
          playheadSoftRunningRef.current = true;
        }
      }, FIRST_METER_SOFT_MS);
      // Safety: if the meter never arrives at all (the engine never really
      // started), drop the wait entirely so nothing can wedge.
      firstMeterHardGuardRef.current = setTimeout(() => {
        releaseFirstMeterWait();
      }, FIRST_METER_HARD_MS);
    },
    [isTransitioning, releaseFirstMeterWait]
  );

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
        setPeakVersion((v) => v + 1);
        hasEditsRef.current = false;
        scrubPauseRef.current = false;
        lastActionRef.current = null;
        releaseFirstMeterWait();
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
        // If the mode we were waiting for can no longer happen (e.g. a
        // notification paused the take), release the freeze right away.
        if (!running && awaitingFirstMeterRef.current !== null) {
          releaseFirstMeterWait();
        }
      }

      if (next === 'RECORDING') hasEditsRef.current = true;
      if (!running) resetMeter();
      setOverwriting(next === 'RECORDING' && snap.overwriting);
      setEngineState(next);
    },
    // Shared values and refs are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setEngineState, setOverwriting, setSessionInfo, releaseFirstMeterWait]
  );

  const applyPeakDelta = useCallback(
    (start: number, values: number[]) => {
      peakCountRef.current = Math.max(peakCountRef.current, start + values.length);
      const now = Date.now();
      if (now - peakVersionAtRef.current > 500) {
        peakVersionAtRef.current = now;
        setPeakVersion((v) => v + 1);
      }
      // In-place update: `peaks` is a long-lived array (one entry per 20 ms),
      // and rebuilding it on every meter is what made the bar crawl past a
      // few minutes in.
      peaks.modify((arr) => {
        'worklet';
        let need = start + values.length;
        if (need > arr.length) {
          // Grow in blocks so a long take does not reallocate per bucket.
          let cap = Math.max(4096, arr.length * 2);
          while (cap < need) cap *= 2;
          for (let i = arr.length; i < cap; i++) arr.push(0);
        }
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

      // The first hardware meter for the mode we just switched into proves
      // the audio path is live. Anchor the clock to the true position and
      // release the transition freeze so the UI starts moving in step with
      // the audio instead of ahead of it. (A stale meter from the *other*
      // mode is ignored via the recording flag, which mirrors the engine
      // mode each worker ran under.)
      const waitingFor = awaitingFirstMeterRef.current;
      if (
        waitingFor !== null &&
        state === waitingFor &&
        (waitingFor === 'RECORDING' ? e.recording : !e.recording)
      ) {
        const now = Date.now();
        if (playheadSoftRunningRef.current) {
          // The clock was already running: correct it gently (the same rule
          // the steady-state blend uses) so the first meter cannot produce a
          // visible snap. The waveform covers the rest (see StudioWaveform).
          const predicted = anchorRef.current.ms + (now - anchorRef.current.at);
          const drift = e.positionMs - predicted;
          if (Math.abs(drift) > DRIFT_SNAP_MS) {
            anchorRef.current = { ms: e.positionMs, at: now };
            playheadMs.value = e.positionMs;
          } else {
            anchorRef.current = {
              ms: anchorRef.current.ms + drift * ANCHOR_BLEND_FIRST,
              at: anchorRef.current.at,
            };
          }
          anchorMs.value = anchorRef.current.ms;
          anchorAt.value = anchorRef.current.at;
        } else {
          anchorRef.current = { ms: e.positionMs, at: now };
          anchorMs.value = e.positionMs;
          anchorAt.value = now;
          playheadMs.value = e.positionMs;
        }
        releaseFirstMeterWait();
      }

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
            : { ms: a.ms + drift * ANCHOR_BLEND_SLOW, at: a.at };
        anchorMs.value = anchorRef.current.ms;
        anchorAt.value = anchorRef.current.at;
      }
    },
    // Shared values and refs are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [applyPeakDelta, releaseFirstMeterWait]
  );

  const loadPeaks = useCallback(async () => {
    const arr = await StudioEngine.getPeaks(0, -1);
    peaks.value = arr;
    peakCountRef.current = arr.length;
    setPeakVersion((v) => v + 1);
  }, [peaks]);

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

  /**
   * Keep both halves of the audio path ready: a pre-opened (stopped) mic and a
   * pre-opened (paused, flushed) output track. This is what makes the
   * record/preview toggle feel instant instead of paying device setup on
   * whichever side is being switched to.
   */
  const warmAudioPath = useCallback(
    (deviceId: number) => {
      void StudioEngine.prepareRecorder(deviceId);
      void StudioEngine.preparePlayer();
    },
    []
  );

  /** Give the hardware back (backgrounded, or the user left the studio). */
  const coolAudioPath = useCallback(() => {
    void StudioEngine.dropWarmRecorder();
    void StudioEngine.dropWarmPlayer();
  }, []);

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
      // Something took the audio path away (call, alarm, another capture
      // client, screen locked). The engine has already parked the take safely;
      // JS decides what the user should do about it.
      StudioEngine.addListener('studioInterruption', (e) => {
        if (e.recording) {
          // A capture that stopped on its own must not keep the warm mic, and
          // the playhead belongs to the engine now.
          StudioEngine.dropWarmRecorder().catch(() => {});
        }
        void resync();
        optionsRef.current.onInterruption?.(e);
      }),
    ];
    return () => subs.forEach((s) => s?.remove());
    // resync is stable; listed so the linter keeps the closure honest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applySnapshot, handleMeter, resync]);

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
      } else if (next === 'background') {
        if (engineStateRef.current === 'PREVIEWING') {
          StudioEngine.pause().catch(() => {});
        }
        // Release the warm mic so backgrounding the app does not keep the
        // microphone held from other apps. The studio screen re-warms it on
        // foreground return (and on every idle/paused entry).
        if (engineStateRef.current !== 'RECORDING') {
          StudioEngine.dropWarmRecorder().catch(() => {});
        }
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
        // Freeze the clock while the mic opens, exactly like a mode
        // switch: on a cold start the audio path needs up to ~0.5 s to
        // prime, and the UI must not run ahead of it.
        isTransitioning.value = true;
        const snap = await StudioEngine.record({ positionMs: -1, inputDeviceId: o.inputDeviceId });
        applySnapshot(snap, 'record');
        armFirstMeterWait('RECORDING');
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
    [applySnapshot, armFirstMeterWait, isTransitioning, setSessionInfo]
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
      if (firstMeterGuardRef.current) clearTimeout(firstMeterGuardRef.current);
      if (firstMeterHardGuardRef.current) clearTimeout(firstMeterHardGuardRef.current);
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
      // Flip the transport (and freeze the clock) on the UI thread *before*
      // the native call, so the button answers the tap on the next frame
      // rather than after the round trip. applySnapshot() below reconciles.
      isTransitioning.value = true;
      isRecording.value = true;
      isRunning.value = true;
      setEngineState('RECORDING');
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
        // The mic was (re)opened natively: freeze the clock until the first
        // capture meter proves audio is actually flowing (see
        // armFirstMeterWait). That meter re-anchors the clock to the true
        // position, so the UI never leads the hardware.
        armFirstMeterWait('RECORDING');
      } catch (e) {
        // The engine refused: undo the optimistic flip before resyncing, so a
        // failed record never leaves the transport showing a live take.
        isRecording.value = false;
        isRunning.value = false;
        setEngineState('PAUSED');
        try {
          await resync();
        } catch {}
        throw e;
      } finally {
        // On success the freeze is released by the first meter (or the
        // guard timer); on failure the resync snapshot released it.
        if (!awaitingFirstMeterRef.current) {
          releaseFirstMeterWait();
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [applySnapshot, anchorAt, anchorMs, playheadMs, armFirstMeterWait, releaseFirstMeterWait, resync, setEngineState]
  );

  const preview = useCallback(async (positionMs: number) => {
    const dur = durationRef.current;
    const uiPos = Math.max(0, Math.min(positionMs, dur));
    lastActionRef.current = { at: Date.now(), pos: uiPos };
    isTransitioning.value = true;
    isRecording.value = false;
    isRunning.value = true;
    setEngineState('PREVIEWING');
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
      // The speaker path was just (re)opened natively: freeze the clock
      // until the first playback meter proves audio is actually flowing
      // (see armFirstMeterWait).
      armFirstMeterWait('PREVIEWING');
    } catch (e) {
      isRecording.value = false;
      isRunning.value = false;
      setEngineState('PAUSED');
      try {
        await resync();
      } catch {}
      throw e;
    } finally {
      // On success the freeze is released by the first meter (or the
      // guard timer); on failure the resync snapshot released it.
      if (!awaitingFirstMeterRef.current) {
        releaseFirstMeterWait();
      }
    }
  }, [
    applySnapshot,
    anchorAt,
    anchorMs,
    armFirstMeterWait,
    playheadMs,
    releaseFirstMeterWait,
    resync,
    setEngineState,
  ]);

  /**
   * Flip the transport UI before the native call resolves. Pausing has to
   * join the capture thread (it is inside a blocking read), so the round
   * trip is not free, and waiting for it is what made the button feel slow.
   * The native snapshot is applied as soon as it lands; if the call fails we
   * resynchronise instead of leaving the UI on a lie.
   */
  const optimisticPause = useCallback(async (): Promise<StudioSnapshot> => {
    const wasRunning =
      engineStateRef.current === 'RECORDING' || engineStateRef.current === 'PREVIEWING';
    if (wasRunning) {
      isTransitioning.value = true;
      isRunning.value = false;
      isRecording.value = false;
      setEngineState('PAUSED');
    }
    try {
      const snap = await StudioEngine.pause();
      applySnapshot(snap, 'pause');
      return snap;
    } catch (e) {
      if (wasRunning) {
        try {
          await resync();
        } catch {}
      }
      throw e;
    } finally {
      isTransitioning.value = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applySnapshot, resync]);

  /**
   * Announce a mode switch to the UI immediately (icon, "Replace armed" pill,
   * frozen clock) while the native transport is still catching up. Every
   * command path ends with applySnapshot(), which corrects the picture if the
   * engine disagreed.
   */
  const armTransition = useCallback(
    (next: 'RECORDING' | 'PREVIEWING') => {
      beginSwitch();
      isRecording.value = next === 'RECORDING';
      setEngineState(next);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [beginSwitch, isRecording]
  );

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

  /**
   * Re-arm capture after an interruption: the native side throws away the
   * possibly-dead AudioRecord, opens a fresh one and continues the take.
   */
  const reinitializeAfterInterruption = useCallback(
    async (inputDeviceId: number, appendAtEnd = true) => {
      beginSwitch();
      try {
        const snap = await StudioEngine.reinitializeCapture({
          inputDeviceId,
          appendAtEnd,
        });
        hasEditsRef.current = true;
        applySnapshot(snap, appendAtEnd ? 'record' : 'replace');
        armFirstMeterWait('RECORDING');
        return snap;
      } catch (e) {
        endSwitch();
        throw e;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [applySnapshot, armFirstMeterWait, beginSwitch, endSwitch]
  );

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
    peakVersion,
    getPlayheadMs,
    getDurationMs,
    createAndRecord,
    openSession,
    reattach,
    record,
    preview,
    pause,
    optimisticPause,
    armTransition,
    pauseForScrub,
    seek,
    finalize,
    discard,
    resync,
    beginSwitch,
    endSwitch,
    warmAudioPath,
    coolAudioPath,
    reinitializeAfterInterruption,
  };
}

export type StudioSession = ReturnType<typeof useStudioSession>;
