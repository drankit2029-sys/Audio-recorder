// src/services/audio/useAudioRecording.ts
import { useState, useCallback, useRef, useEffect } from 'react';
import { useAudioRecorder } from 'expo-audio';
import { SessionJournal } from '../storage/sessionJournal';
import { AudioSettingsStorage } from '../storage/audioSettingsStorage';
import { PresetKey, AudioPresetConfig } from './types';
import { ForegroundServiceManager } from './ForegroundServiceManager';

export type EngineState = 'IDLE' | 'RECORDING' | 'PAUSED' | 'STOPPED' | 'ERROR';

const formatTimecode = (ms: number) => {
  const totalSeconds = Math.floor(ms / 1000);
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  return hrs > 0
    ? `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
    : `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
};

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
        SessionJournal.updateHeartbeat(total);

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

  const startRecording = useCallback(async () => {
    if (engineStateRef.current === 'RECORDING') return;

    engineStateRef.current = 'RECORDING';
    telemetry.current.isPaused = false;
    telemetry.current.durationMs = 0;
    telemetry.current.accumulatedMs = 0;
    telemetry.current.startTime = Date.now();
    isCapturingRef.current = true;
    smoothedDbRef.current = -60;
    telemetry.current.meteringDb = -60;

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
          startedAt: Date.now(),
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

  const pauseRecording = useCallback(() => {
    if (engineStateRef.current !== 'RECORDING') return;

    isCapturingRef.current = false;
    telemetry.current.isPaused = true;
    telemetry.current.accumulatedMs = telemetry.current.durationMs;
    telemetry.current.startTime = Date.now();

    engineStateRef.current = 'PAUSED';
    setEngineState('PAUSED');
    SessionJournal.setStatus('PAUSED');

    nativeQueueRef.current = nativeQueueRef.current.then(async () => {
      try {
        await recorder.pause();
        ForegroundServiceManager.updateProgress(
          formatTimecode(telemetry.current.durationMs),
          activePresetRef.current.badge,
          true
        );
      } catch (err) {
        console.warn('[useAudioRecording] recorder.pause failed:', err);
      }
    });
  }, [recorder]);

  const resumeRecording = useCallback(() => {
    if (engineStateRef.current !== 'PAUSED') return;

    telemetry.current.isPaused = false;
    telemetry.current.startTime = Date.now();
    isCapturingRef.current = true;

    engineStateRef.current = 'RECORDING';
    setEngineState('RECORDING');
    SessionJournal.setStatus('RECORDING');

    nativeQueueRef.current = nativeQueueRef.current.then(async () => {
      try {
        await recorder.record();
      } catch (err) {
        console.warn('[useAudioRecording] recorder.record failed:', err);
      }
    });
  }, [recorder]);

  const stopRecording = useCallback(async (): Promise<string | null> => {
    engineStateRef.current = 'STOPPED';
    isCapturingRef.current = false;
    telemetry.current.isPaused = true;
    setEngineState('STOPPED');

    return new Promise<string | null>((resolve, reject) => {
      nativeQueueRef.current = nativeQueueRef.current.then(async () => {
        try {
          await recorder.stop();
          const finalUri = recorder.uri || fileUriRef.current;
          SessionJournal.setStatus('FINALIZED');
          SessionJournal.clearSession();
          resolve(finalUri);
        } catch (error) {
          setEngineState('ERROR');
          engineStateRef.current = 'ERROR';
          reject(error);
        }
      });
    });
  }, [recorder]);

  const resetEngine = useCallback(async () => {
    try { await recorder.stop(); } catch {}
    SessionJournal.clearSession();
    setEngineState('IDLE');
    engineStateRef.current = 'IDLE';
    telemetry.current.durationMs = 0;
    telemetry.current.accumulatedMs = 0;
    telemetry.current.startTime = 0;
    telemetry.current.meteringDb = -60;
    telemetry.current.isPaused = false;
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