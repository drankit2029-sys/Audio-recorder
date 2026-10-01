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

export type EngineState = 'IDLE' | 'RECORDING' | 'PAUSED' | 'PREVIEWING' | 'STOPPED' | 'ERROR';

export const isSessionState = (state: EngineState): boolean =>
  state === 'RECORDING' || state === 'PAUSED' || state === 'PREVIEWING';

export const END_EPSILON_MS = 60;
const METER_SILENCE_MS = 4000;
const FIRST_METER_HARD_MS = 1500;

export interface StudioTelemetry {
  meteringDb: number;
}

export interface UseStudioSessionOptions {
  onNotificationAction?: (action: StudioNotificationEvent['action']) => void;
  onError?: (event: StudioErrorEvent) => void;
  onInterruption?: (event: StudioInterruptionEvent) => void;
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
  const isTransitioning = useSharedValue(false);

  const anchorRef = useRef({ ms: 0, at: 0 });
  const durationRef = useRef(0);
  const peakCountRef = useRef(0);
  const [peakVersion, setPeakVersion] = useState(0);
  const peakVersionAtRef = useRef(0);
  const hasEditsRef = useRef(false);
  const lastMeterAtRef = useRef(0);
  const scrubPauseRef = useRef(false);
  const lastActionRef = useRef<{ at: number; pos: number } | null>(null);
  const switchGuardRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const awaitingFirstMeterRef = useRef<EngineState | null>(null);
  const firstMeterHardGuardRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const releaseFirstMeterWait = useCallback(() => {
    awaitingFirstMeterRef.current = null;
    if (firstMeterHardGuardRef.current) {
      clearTimeout(firstMeterHardGuardRef.current);
      firstMeterHardGuardRef.current = null;
    }
    if (switchGuardRef.current) {
      clearTimeout(switchGuardRef.current);
      switchGuardRef.current = null;
    }
    isTransitioning.value = false;
  }, [isTransitioning]);

  const armFirstMeterWait = useCallback(
    (expected: EngineState) => {
      awaitingFirstMeterRef.current = expected;
      if (firstMeterHardGuardRef.current) clearTimeout(firstMeterHardGuardRef.current);
      firstMeterHardGuardRef.current = setTimeout(() => {
        releaseFirstMeterWait();
      }, FIRST_METER_HARD_MS);
    },
    [releaseFirstMeterWait]
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

  // UI-thread clock: interpolates smoothly between native meter events
  const clock = useFrameCallback(() => {
    'worklet';
    if (!isRunning.value || isScrubbing.value || isTransitioning.value) return;
    let t = anchorMs.value + (Date.now() - anchorAt.value);
    if (t < 0) t = 0;
    if (!isRecording.value && t > durationMs.value) t = durationMs.value;
    const current = playheadMs.value;
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
          durationMs.value = snap.durationMs;
        }
        if (!running && awaitingFirstMeterRef.current !== null) {
          releaseFirstMeterWait();
        }
      }

      if (next === 'RECORDING') hasEditsRef.current = true;
      if (!running) resetMeter();
      setOverwriting(next === 'RECORDING' && snap.overwriting);
      setEngineState(next);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setEngineState, setOverwriting, setSessionInfo, releaseFirstMeterWait]
  );

  const applyPeakDelta = useCallback(
    (start: number, values: number[]) => {
      peakCountRef.current = Math.max(peakCountRef.current, start + values.length);
      const now = Date.now();
      if (now - peakVersionAtRef.current > 200) {
        peakVersionAtRef.current = now;
        setPeakVersion((v) => v + 1);
      }
      peaks.modify((arr) => {
        'worklet';
        let need = start + values.length;
        if (need > arr.length) {
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
      const waitingFor = awaitingFirstMeterRef.current;

      if (
        waitingFor !== null &&
        state === waitingFor &&
        (waitingFor === 'RECORDING' ? e.recording : !e.recording)
      ) {
        const now = Date.now();
        anchorRef.current = { ms: e.positionMs, at: now };
        anchorMs.value = e.positionMs;
        anchorAt.value = now;
        playheadMs.value = e.positionMs;
        releaseFirstMeterWait();
      } else if (!isTransitioning.value && (state === 'RECORDING' || state === 'PREVIEWING')) {
        // Sync anchor directly to the true hardware audio position on each meter tick
        const now = Date.now();
        anchorRef.current = { ms: e.positionMs, at: now };
        anchorMs.value = e.positionMs;
        anchorAt.value = now;
      }
    },
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

  const warmAudioPath = useCallback(
    (deviceId: number) => {
      void StudioEngine.prepareRecorder(deviceId);
      void StudioEngine.preparePlayer();
    },
    []
  );

  const coolAudioPath = useCallback(() => {
    void StudioEngine.dropWarmRecorder();
    void StudioEngine.dropWarmPlayer();
  }, []);

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
      StudioEngine.addListener('studioInterruption', (e) => {
        if (e.recording) {
          StudioEngine.dropWarmRecorder().catch(() => {});
        }
        void resync();
        optionsRef.current.onInterruption?.(e);
      }),
    ];
    return () => subs.forEach((s) => s?.remove());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applySnapshot, handleMeter, resync]);

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
        if (engineStateRef.current !== 'RECORDING') {
          StudioEngine.dropWarmRecorder().catch(() => {});
        }
      }
    });
    return () => sub.remove();
  }, [resync]);

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
      if (firstMeterHardGuardRef.current) clearTimeout(firstMeterHardGuardRef.current);
    };
  }, []);

  const record = useCallback(
    async (positionMs: number, inputDeviceId: number) => {
      const uiPos = positionMs < 0 ? durationRef.current : positionMs;
      if (positionMs >= 0) {
        lastActionRef.current = { at: Date.now(), pos: uiPos };
      } else {
        lastActionRef.current = null;
      }
      isTransitioning.value = true;
      isRecording.value = true;
      isRunning.value = true;
      isAppending.value = positionMs < 0;
      setEngineState('RECORDING');
      try {
        const snap = await StudioEngine.record({ positionMs, inputDeviceId });
        hasEditsRef.current = true;
        applySnapshot(snap, snap.overwriting ? 'replace' : 'record');
        if (positionMs >= 0) {
          const now = Date.now();
          anchorRef.current = { ms: uiPos, at: now };
          anchorMs.value = uiPos;
          anchorAt.value = now;
          playheadMs.value = uiPos;
        }
        armFirstMeterWait('RECORDING');
      } catch (e) {
        isRecording.value = false;
        isRunning.value = false;
        setEngineState('PAUSED');
        try {
          await resync();
        } catch {}
        throw e;
      } finally {
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

  const getPlayheadMs = useCallback(() => playheadMs.value, [playheadMs]);
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
