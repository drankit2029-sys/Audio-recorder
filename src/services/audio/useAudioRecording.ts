// src/services/audio/useAudioRecording.ts
import { useState, useCallback, useRef, useEffect } from 'react';
import { useAudioRecorder } from 'expo-audio';
import { SessionJournal } from '../storage/sessionJournal';
import { AudioSettingsStorage } from '../storage/audioSettingsStorage';
import { PresetKey, AudioPresetConfig } from './types';
import { ForegroundServiceManager } from './ForegroundServiceManager';

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

  const [presetKey, setPresetKeyState] = useState<string>(AudioSettingsStorage.getPreset());

  const activePreset: AudioPresetConfig = AudioSettingsStorage.getResolvedPreset(presetKey);
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

  const telemetry = useRef({
    meteringDb: -60,
    durationMs: 0,
    startTime: 0,
    accumulatedMs: 0,
    isPaused: false,
    waveformHistory: new Array<number>(BAR_COUNT).fill(0),
  });

  // Accurate Broadcast Meter Ballistics (Instant Attack, Natural Decay)
  const processMeterDb = useCallback((rawDb: number) => {
    if (!isCapturingRef.current) return;
    const clamped = Math.max(-60, Math.min(0, isFinite(rawDb) ? rawDb : -60));

    if (clamped > smoothedDbRef.current) {
      smoothedDbRef.current += (clamped - smoothedDbRef.current) * 0.85; // Fast attack
    } else {
      smoothedDbRef.current += (clamped - smoothedDbRef.current) * 0.18; // Smooth broadcast release
    }

    // Exact 1-decimal rounding (no scaling distortion)
    telemetry.current.meteringDb = Math.round(smoothedDbRef.current * 10) / 10;
  }, []);

  // Pass live status listener directly to expo-audio
  const handleStatusUpdate = useCallback((status: any) => {
    if (typeof status?.metering === 'number') {
      processMeterDb(status.metering);
    }
  }, [processMeterDb]);

  const recorder = useAudioRecorder(activePreset.options, handleStatusUpdate);

  // Subscribe to native event emitter for builds where callback is event-based
  useEffect(() => {
    if (!recorder) return;
    const rec = recorder as any;
    let sub1: any;
    let sub2: any;

    if (typeof rec.addListener === 'function') {
      try {
        sub1 = rec.addListener('recordingStatusUpdate', (status: any) => {
          if (typeof status?.metering === 'number') processMeterDb(status.metering);
        });
      } catch {}
      try {
        sub2 = rec.addListener('statusUpdate', (status: any) => {
          if (typeof status?.metering === 'number') processMeterDb(status.metering);
        });
      } catch {}
    }

    return () => {
      try { sub1?.remove?.(); } catch {}
      try { sub2?.remove?.(); } catch {}
    };
  }, [recorder, processMeterDb]);

  const changePreset = useCallback((key: string) => {
    if (engineStateRef.current === 'RECORDING' || engineStateRef.current === 'PAUSED') {
      throw new Error('Cannot change format preset while capture is in progress.');
    }
    setPresetKeyState(key);
    AudioSettingsStorage.setPreset(key);
  }, []);

  const pollMetering = useCallback(async () => {
    if (!recorder || isPollingRef.current || !isCapturingRef.current) return;
    isPollingRef.current = true;

    try {
      let db: number | undefined;

      // Handle both Promise-returning and synchronous getStatus()
      if (typeof (recorder as any).getStatus === 'function') {
        const res = (recorder as any).getStatus();
        const status = res instanceof Promise ? await res : res;
        db = status?.metering;
      } else if (typeof (recorder as any).getStatusAsync === 'function') {
        const status = await (recorder as any).getStatusAsync();
        db = status?.metering;
      } else if (typeof (recorder as any).metering === 'number') {
        db = (recorder as any).metering;
      }

      if (typeof db === 'number' && !isNaN(db)) {
        processMeterDb(db);
      }
    } catch {
    } finally {
      isPollingRef.current = false;
    }
  }, [recorder, processMeterDb]);

  useEffect(() => {
    if (engineState === 'RECORDING') {
      timerRef.current = setInterval(() => {
        const total = telemetry.current.durationMs;
        // Persist byte offset and current waveform snapshot
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

      const startPollingLoop = async () => {
        if (!isCapturingRef.current) return;
        await pollMetering();
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

  const getExactDurationMs = useCallback(() => {
    return telemetry.current.durationMs;
  }, []);

  // In src/services/audio/useAudioRecording.ts

const startRecording = useCallback(async (
    initialDurationMs: number = 0,
    initialWaveform?: number[]
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
        try { await recorder.stop(); } catch {}

        const currentConfig = activePresetRef.current;
        const sessionId = `session_${Date.now()}`;
        await recorder.prepareToRecordAsync(currentConfig.options);
        fileUriRef.current = recorder.uri;

        SessionJournal.startSession({
          sessionId,
          fileUri: recorder.uri ?? '',
          formatPreset: currentConfig.key,
          sampleRate: currentConfig.sampleRate,
          channels: currentConfig.channels,
          startedAt: Date.now() - initialDurationMs,
        });

      await recorder.record();
      } catch (error) {
        setEngineState('ERROR');
        engineStateRef.current = 'ERROR';
        throw error;
      }
    });

  await nativeQueueRef.current;
}, [recorder]);

  // In src/services/audio/useAudioRecording.ts

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
      await recorder.pause();
    } catch (err) {
      console.warn('[useAudioRecording] recorder.pause failed:', err);
    }

    await ForegroundServiceManager.updateProgress(
      formatTimecode(telemetry.current.durationMs),
      activePresetRef.current.badge,
      true
    );
  }, [recorder]);

  const resumeRecording = useCallback(async () => {
    if (engineStateRef.current !== 'PAUSED') return;

    telemetry.current.isPaused = false;
    telemetry.current.startTime = Date.now();
    isCapturingRef.current = true;

    engineStateRef.current = 'RECORDING';
    setEngineState('RECORDING');
    SessionJournal.setStatus('RECORDING');

    try {
      await recorder.record();
    } catch (err) {
      console.warn('[useAudioRecording] recorder.record failed:', err);
    }

    await ForegroundServiceManager.updateProgress(
      formatTimecode(telemetry.current.durationMs),
      activePresetRef.current.badge,
      false
    );
  }, [recorder]);

  const stopRecording = useCallback(async (): Promise<string | null> => {
    if (engineStateRef.current !== 'RECORDING' && engineStateRef.current !== 'PAUSED') {
      return recorder.uri || fileUriRef.current;
    }

    engineStateRef.current = 'STOPPED';
    isCapturingRef.current = false;
    telemetry.current.isPaused = true;
    setEngineState('STOPPED');

    try {
      await recorder.stop();
    } catch (error) {
      console.warn('[useAudioRecording] recorder.stop caught non-fatal exception:', error);
    }

    const finalUri = recorder.uri || fileUriRef.current;
    SessionJournal.setStatus('FINALIZED');
    SessionJournal.clearSession();
    return finalUri;
  }, [recorder]);

  const resetEngine = useCallback(async () => {
    if (engineStateRef.current === 'RECORDING' || engineStateRef.current === 'PAUSED') {
      try { await recorder.stop(); } catch {}
    }
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
  }, [recorder]);

  return {
    engineState,
    engineStateRef,
    telemetry,
    getExactDurationMs,
    currentUri: recorder.uri ?? fileUriRef.current,
    activePreset,
    setPresetKey: changePreset,
    startRecording,
    pauseRecording,
    resumeRecording,
    stopRecording,
    resetEngine,
  };
}