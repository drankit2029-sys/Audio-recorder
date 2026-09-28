import { useState, useCallback, useRef, useEffect } from 'react';
import { useAudioRecorder } from 'expo-audio';
import { SessionJournal } from '../storage/sessionJournal';
import { AudioSettingsStorage } from '../storage/audioSettingsStorage';
import { onWavMetering } from '../../../modules/audio-hardware-router/src';
import { PresetKey, AudioPresetConfig } from './types';
import { ForegroundServiceManager } from './ForegroundServiceManager';
import {
  UnifiedRecorder,
  createUnifiedRecorder,
  stripToFileUri,
} from './recordingEngine';

export type EngineState = 'IDLE' | 'RECORDING' | 'PAUSED' | 'STOPPED' | 'ERROR';
export const BAR_COUNT = 156;

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

export function useAudioRecording() {
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

  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const meterPollingRef = useRef<NodeJS.Timeout | null>(null);
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

  useEffect(() => {
    if (activePreset.engine !== 'audiorecord') return;
    const sub = onWavMetering((event) => {
      if (typeof event?.metering === 'number') {
        processMeterDb(event.metering);
      }
    });
    meteringSubscriptionRef.current = sub;
    return () => {
      sub?.remove();
      meteringSubscriptionRef.current = null;
    };
  }, [activePreset.engine, processMeterDb]);

  const getEngine = useCallback((): UnifiedRecorder => {
    if (!engineRef.current) {
      engineRef.current = createUnifiedRecorder(activePresetRef.current, mediaRecorder);
    }
    return engineRef.current;
  }, [mediaRecorder]);

  const changePreset = useCallback(
    (key: string) => {
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
    },
    []
  );

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
        const total = telemetry.current.durationMs;
        SessionJournal.updateHeartbeat(total, telemetry.current.waveformHistory);

        const now = Date.now();
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
  }, [engineState, pollMetering]);

  const getExactDurationMs = useCallback(
    () => telemetry.current.durationMs,
    []
  );

  const startRecording = useCallback(
    async (
      initialDurationMs: number = 0,
      initialWaveform?: number[],
      displayName?: string,
      inputDeviceId: number = -1
    ) => {
      if (engineStateRef.current === 'RECORDING') return;

      engineStateRef.current = 'RECORDING';
      telemetry.current.isPaused = false;
      telemetry.current.durationMs = initialDurationMs;
      telemetry.current.accumulatedMs = initialDurationMs;
      telemetry.current.startTime = Date.now();
      isCapturingRef.current = true;
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
            inputDeviceId
          );

          const rawUri = engine.rawUri;
          fileUriRef.current = rawUri;

          SessionJournal.startSession({
            sessionId,
            fileUri: stripToFileUri(rawUri) ?? '',
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

  const stopRecording = useCallback(async (): Promise<string | null> => {
    if (
      engineStateRef.current !== 'RECORDING' &&
      engineStateRef.current !== 'PAUSED'
    ) {
      return fileUriRef.current;
    }

    engineStateRef.current = 'STOPPED';
    isCapturingRef.current = false;
    telemetry.current.isPaused = true;
    setEngineState('STOPPED');

    let finalUri: string | null = fileUriRef.current;

    try {
      const engine = getEngine();
      const result = await engine.stop(
        `Take ${new Date().toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })}`,
        activePresetRef.current.extension
      );
      finalUri = result.uri ?? finalUri;
      if (result.degraded && result.degradationNote) {
        console.warn('[useAudioRecording] ' + result.degradationNote);
      }
    } catch (error) {
      console.warn('[useAudioRecording] engine.stop caught exception:', error);
    }

    fileUriRef.current = finalUri;
    SessionJournal.setStatus('FINALIZED');
    SessionJournal.clearSession();
    return finalUri;
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