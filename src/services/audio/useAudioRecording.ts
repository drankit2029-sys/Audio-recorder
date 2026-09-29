import { useState, useCallback, useRef, useEffect } from 'react';
import { useAudioRecorder } from 'expo-audio';
import { SessionJournal } from '../storage/sessionJournal';
import { AudioSettingsStorage } from '../storage/audioSettingsStorage';
import {
  onWavMetering,
  onWavError,
  WavRecorder,
} from '../../../modules/audio-hardware-router/src';
import { PresetKey, AudioPresetConfig, EngineKind } from './types';
import { ForegroundServiceManager } from './ForegroundServiceManager';
import {
  UnifiedRecorder,
  ResumePoint,
  createUnifiedRecorder,
} from './recordingEngine';

export type EngineState = 'IDLE' | 'RECORDING' | 'PAUSED' | 'STOPPED' | 'ERROR';
export const BAR_COUNT = 156;

export interface RecordingStopOutcome {
  uri: string | null;
  durationMs: number;
  sizeBytes: number;
  /**
   * Set only for issues the format selector cannot prevent: container
   * truncation, failed relocation, or a throw while stopping.
   */
  degradationNote?: string;
  engine: EngineKind;
}

const formatTimecode = (ms: number) => {
  const totalSeconds = Math.floor(ms / 1000);
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  return hrs > 0
    ? `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
    : `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
};

export function generateResumedWaveform(barCount: number = BAR_COUNT): number[] {
  const bars: number[] = [];
  let currentVal = 0.2;
  for (let i = 0; i < barCount; i++) {
    const cadence = Math.sin(i / 5.5) * Math.cos(i / 11);
    if (cadence > 0.08) {
      const noise = Math.sin(i * 1.8) * 0.22 + (Math.random() * 0.16 - 0.08);
      currentVal = Math.max(0.14, Math.min(0.85, Math.abs(cadence) * 0.72 + noise));
    } else {
      currentVal = Math.max(0.01, Math.min(0.07, currentVal * 0.5));
    }
    bars.push(Math.round(currentVal * 1000) / 1000);
  }
  return bars;
}

/**
 * A capture pipeline can die without telling JS (mic unplugged, another app
 * stealing the input, disk full, the process being restarted). The hook now
 * notices and reports it so the UI can finalise the take instead of showing a
 * frozen "RECORDING" forever.
 */
export interface UseAudioRecordingOptions {
  onCaptureLost?: (reason: string) => void;
}

/** How long the native capture may go silent before it counts as lost. */
const CAPTURE_WATCHDOG_MS = 3000;

export function useAudioRecording(options: UseAudioRecordingOptions = {}) {
  const [engineState, setEngineState] = useState<EngineState>('IDLE');
  const engineStateRef = useRef<EngineState>('IDLE');

  const [presetKey, setPresetKeyState] = useState<string>(
    AudioSettingsStorage.getPreset()
  );

  const activePreset: AudioPresetConfig =
    AudioSettingsStorage.getResolvedPreset(presetKey);
  const activePresetRef = useRef<AudioPresetConfig>(activePreset);
  activePresetRef.current = activePreset;

  const isPollingRef = useRef(false);
  const isCapturingRef = useRef(false);
  const nativeQueueRef = useRef<Promise<void>>(Promise.resolve());

  const smoothedDbRef = useRef(-60);
  const lastNotifTimeRef = useRef(0);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const meterPollingRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileUriRef = useRef<string | null>(null);
  const engineRef = useRef<UnifiedRecorder | null>(null);
  const meteringSubscriptionRef = useRef<{ remove: () => void } | null>(null);

  const telemetry = useRef({
    meteringDb: -60,
    durationMs: 0,
    startTime: 0,
    accumulatedMs: 0,
    isPaused: false,
    waveformHistory: new Array<number>(BAR_COUNT).fill(0),
  });

  const captureLostRef = useRef(false);
  const watchdogRef = useRef({ lastProgressAt: 0, lastDuration: -1 });
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const processMeterDb = useCallback((rawDb: number) => {
    if (!isCapturingRef.current) return;
    const clamped = Math.max(-60, Math.min(0, isFinite(rawDb) ? rawDb : -60));

    if (clamped > smoothedDbRef.current) {
      smoothedDbRef.current += (clamped - smoothedDbRef.current) * 0.85; // Fast attack
    } else {
      smoothedDbRef.current += (clamped - smoothedDbRef.current) * 0.18; // Smooth release
    }

    telemetry.current.meteringDb = Math.round(smoothedDbRef.current * 10) / 10;
  }, []);

  const mediaRecorder = useAudioRecorder(activePreset.options);

  const reportCaptureLost = useCallback((reason: string) => {
    if (captureLostRef.current) return;
    captureLostRef.current = true;
    isCapturingRef.current = false;
    console.warn('[useAudioRecording] capture lost:', reason);
    optionsRef.current.onCaptureLost?.(reason);
  }, []);

  useEffect(() => {
    if (activePreset.engine !== 'audiorecord') return;
    const meteringSub = onWavMetering((event) => {
      if (typeof event?.metering === 'number') {
        processMeterDb(event.metering);
      }
    });
    // C3: the native capture thread now reports fatal errors (device
    // disconnected, disk full, AudioRecord failure). Without this the UI would
    // keep showing RECORDING and the user would lose the take.
    const errorSub = onWavError((event) => {
      if (
        engineStateRef.current !== 'RECORDING' &&
        engineStateRef.current !== 'PAUSED'
      ) {
        return;
      }
      reportCaptureLost(event.message || 'The audio capture stopped unexpectedly.');
    });
    meteringSubscriptionRef.current = meteringSub;
    return () => {
      meteringSub?.remove();
      errorSub?.remove();
      meteringSubscriptionRef.current = null;
    };
  }, [activePreset.engine, processMeterDb, reportCaptureLost]);

  const getEngine = useCallback((): UnifiedRecorder => {
    if (!engineRef.current) {
      engineRef.current = createUnifiedRecorder(activePresetRef.current, mediaRecorder);
    }
    return engineRef.current;
  }, [mediaRecorder]);

  const changePreset = useCallback((key: string) => {
    if (
      engineStateRef.current === 'RECORDING' ||
      engineStateRef.current === 'PAUSED'
    ) {
      throw new Error('Cannot change format preset while capture is in progress.');
    }
    engineRef.current?.release();
    engineRef.current = null;
    setPresetKeyState(key);
    AudioSettingsStorage.setPreset(key);
  }, []);

  const pollMetering = useCallback(() => {
    if (!isCapturingRef.current) return;
    if (activePresetRef.current.engine === 'audiorecord') return;
    const db = getEngine().getMetering();
    if (typeof db === 'number' && !isNaN(db)) {
      processMeterDb(db);
    }
  }, [getEngine, processMeterDb]);

  useEffect(() => {
    if (engineState === 'RECORDING') {
      timerRef.current = setInterval(() => {
        const now = Date.now();

        // The clock lives here, not in the timer component: requestAnimationFrame
        // is paused whenever the app is backgrounded or the UI is occluded, which
        // froze both the on-screen timer AND the notification timecode during a
        // background take on the old code.
        if (!telemetry.current.isPaused) {
          telemetry.current.durationMs =
            telemetry.current.accumulatedMs + Math.max(0, now - telemetry.current.startTime);
        }
        const total = telemetry.current.durationMs;

        SessionJournal.updateHeartbeat({
          durationMs: total,
          dataBytes:
            activePresetRef.current.engine === 'audiorecord'
              ? WavRecorder.getStatusSync().sizeBytes
              : 0,
          waveformSnapshot: telemetry.current.waveformHistory,
        });

        // Watchdog: the engines report their own duration. If it stops
        // advancing while we believe we are capturing, the pipeline is dead
        // (mic unplugged, input stolen by a phone call, process restart).
        if (!telemetry.current.isPaused && !captureLostRef.current) {
          const nativeDuration = getEngine().getDurationMs();
          const watchdog = watchdogRef.current;
          if (nativeDuration <= 0) {
            // Still waiting for the first samples: preparing AudioRecord can
            // take a second or more on slow hardware, so this is not a stall.
            watchdog.lastProgressAt = now;
          } else if (nativeDuration > watchdog.lastDuration + 50) {
            watchdog.lastDuration = nativeDuration;
            watchdog.lastProgressAt = now;
          } else if (watchdog.lastProgressAt > 0 && now - watchdog.lastProgressAt > CAPTURE_WATCHDOG_MS) {
            reportCaptureLost(
              'The microphone stopped delivering audio. The take has been saved up to this point.'
            );
          }
        }

        if (now - lastNotifTimeRef.current >= 1000) {
          lastNotifTimeRef.current = now;
          ForegroundServiceManager.updateProgress(
            formatTimecode(total),
            activePresetRef.current.badge,
            false
          );
        }
      }, 200);

      const startPollingLoop = () => {
        if (!isCapturingRef.current) return;
        pollMetering();
        if (isCapturingRef.current) {
          meterPollingRef.current = setTimeout(startPollingLoop, 33);
        }
      };
      startPollingLoop();
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
      if (meterPollingRef.current) clearTimeout(meterPollingRef.current);

      if (engineState === 'IDLE' || engineState === 'STOPPED') {
        captureLostRef.current = false;
        watchdogRef.current = { lastProgressAt: 0, lastDuration: -1 };
        smoothedDbRef.current = -60;
        telemetry.current.meteringDb = -60;
        telemetry.current.accumulatedMs = 0;
        telemetry.current.durationMs = 0;
        telemetry.current.waveformHistory = new Array<number>(BAR_COUNT).fill(0);
      }
    }

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (meterPollingRef.current) clearTimeout(meterPollingRef.current);
    };
  }, [engineState, pollMetering, getEngine, reportCaptureLost]);

  const getExactDurationMs = useCallback(
    () => telemetry.current.durationMs,
    []
  );

  const startRecording = useCallback(
    async (
      initialDurationMs: number = 0,
      initialWaveform?: number[],
      displayName?: string,
      inputDeviceId: number = -1,
      resumePoint?: ResumePoint
    ): Promise<void> => {
      if (engineStateRef.current === 'RECORDING') return;

      engineStateRef.current = 'RECORDING';
      telemetry.current.isPaused = false;
      telemetry.current.durationMs = initialDurationMs;
      telemetry.current.accumulatedMs = initialDurationMs;
      telemetry.current.startTime = Date.now();
      isCapturingRef.current = true;
      captureLostRef.current = false;
      watchdogRef.current = { lastProgressAt: Date.now(), lastDuration: -1 };
      smoothedDbRef.current = -60;
      telemetry.current.meteringDb = -60;

      if (initialWaveform && initialWaveform.length > 0) {
        telemetry.current.waveformHistory = [...initialWaveform];
      }

      setEngineState('RECORDING');

      nativeQueueRef.current = nativeQueueRef.current.then(async () => {
        try {
          const currentConfig = activePresetRef.current;
          const engine = getEngine();
          const sessionId = `session_${Date.now()}`;

          await engine.prepare(
            currentConfig,
            displayName ?? `Take ${new Date().toISOString()}`,
            inputDeviceId,
            resumePoint
          );

          const rawUri = engine.rawUri;
          fileUriRef.current = rawUri;

          // Store the URI, not a stripped path: the recovery path feeds this
          // back into FileSystem.getInfoAsync / deleteAsync, which need a URI.
          SessionJournal.startSession({
            sessionId,
            fileUri: rawUri ?? '',
            formatPreset: currentConfig.key,
            sampleRate: currentConfig.sampleRate,
            channels: currentConfig.channels as 1 | 2,
            startedAt: Date.now() - initialDurationMs,
          });

          await engine.start();
        } catch (error) {
          setEngineState('ERROR');
          engineStateRef.current = 'ERROR';
          isCapturingRef.current = false;
          throw error;
        }
      });

      await nativeQueueRef.current;
    },
    [getEngine]
  );

  const pauseRecording = useCallback(async () => {
    if (engineStateRef.current !== 'RECORDING') return;

    isCapturingRef.current = false;
    telemetry.current.isPaused = true;
    telemetry.current.accumulatedMs = telemetry.current.durationMs;
    telemetry.current.startTime = Date.now();

    engineStateRef.current = 'PAUSED';
    setEngineState('PAUSED');
    SessionJournal.setStatus('PAUSED');

    try {
      await getEngine().pause();
    } catch (err) {
      console.warn('[useAudioRecording] engine.pause failed:', err);
    }

    await ForegroundServiceManager.updateProgress(
      formatTimecode(telemetry.current.durationMs),
      activePresetRef.current.badge,
      true
    );
  }, [getEngine]);

  const resumeRecording = useCallback(async () => {
    if (engineStateRef.current !== 'PAUSED') return;

    telemetry.current.isPaused = false;
    telemetry.current.startTime = Date.now();
    isCapturingRef.current = true;

    engineStateRef.current = 'RECORDING';
    setEngineState('RECORDING');
    SessionJournal.setStatus('RECORDING');

    try {
      await getEngine().resume();
    } catch (err) {
      console.warn('[useAudioRecording] engine.resume failed:', err);
    }

    await ForegroundServiceManager.updateProgress(
      formatTimecode(telemetry.current.durationMs),
      activePresetRef.current.badge,
      false
    );
  }, [getEngine]);

  const stopRecording = useCallback(async (): Promise<RecordingStopOutcome> => {
    const preset = activePresetRef.current;
    const fallbackDuration = telemetry.current.durationMs;

    if (
      engineStateRef.current !== 'RECORDING' &&
      engineStateRef.current !== 'PAUSED'
    ) {
      return {
        uri: fileUriRef.current,
        durationMs: fallbackDuration,
        sizeBytes: 0,
        engine: preset.engine,
      };
    }

    engineStateRef.current = 'STOPPED';
    isCapturingRef.current = false;
    telemetry.current.isPaused = true;
    setEngineState('STOPPED');

    let finalUri: string | null = fileUriRef.current;
    let durationMs = fallbackDuration;
    let sizeBytes = 0;
    let degradationNote: string | undefined;

    try {
      const engine = getEngine();
      const stamp = new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });

      const result = await engine.stop(`Take ${stamp}`, preset.extension);

      finalUri = result.uri ?? finalUri;
      if (result.durationMs > 0) durationMs = result.durationMs;
      sizeBytes = result.sizeBytes;
      degradationNote = result.degradationNote;
    } catch (error: any) {
      // The take is still recoverable from fileUriRef.current. Report, don't throw.
      console.warn('[useAudioRecording] engine.stop caught exception:', error);
      degradationNote = error?.message
        ? `Capture ended with an error: ${error.message}`
        : 'Capture ended with an unknown error. The take was recovered from the partial file.';
    }

    fileUriRef.current = finalUri;
    SessionJournal.setStatus('FINALIZED');
    SessionJournal.clearSession();

    return {
      uri: finalUri,
      durationMs,
      sizeBytes,
      degradationNote,
      engine: preset.engine,
    };
  }, [getEngine]);

  const resetEngine = useCallback(async () => {
    if (
      engineStateRef.current === 'RECORDING' ||
      engineStateRef.current === 'PAUSED'
    ) {
      try {
        await getEngine().release();
      } catch {
        /* ignore */
      }
    }
    engineRef.current?.release();
    engineRef.current = null;
    fileUriRef.current = null;

    SessionJournal.clearSession();
    setEngineState('IDLE');
    engineStateRef.current = 'IDLE';
    telemetry.current.durationMs = 0;
    telemetry.current.accumulatedMs = 0;
    telemetry.current.startTime = 0;
    telemetry.current.meteringDb = -60;
    telemetry.current.isPaused = false;
    telemetry.current.waveformHistory = new Array<number>(BAR_COUNT).fill(0);
    smoothedDbRef.current = -60;
  }, [getEngine]);

  return {
    engineState,
    engineStateRef,
    telemetry,
    getExactDurationMs,
    currentUri: fileUriRef.current,
    activePreset,
    setPresetKey: changePreset,
    startRecording,
    pauseRecording,
    resumeRecording,
    stopRecording,
    resetEngine,
  };
}
