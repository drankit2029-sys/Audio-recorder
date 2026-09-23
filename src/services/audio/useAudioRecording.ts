// src/services/audio/useAudioRecording.ts
import { useState, useCallback, useRef, useEffect } from 'react';
import { useAudioRecorder } from 'expo-audio';
import { SessionJournal } from '../storage/sessionJournal';
import { AudioSettingsStorage } from '../storage/audioSettingsStorage';
import { AUDIO_PRESETS, PresetKey, AudioPresetConfig } from './types';

export type EngineState = 'IDLE' | 'RECORDING' | 'PAUSED' | 'STOPPED' | 'ERROR';

export function useAudioRecording() {
  const [engineState, setEngineState] = useState<EngineState>('IDLE');
  const [durationMs, setDurationMs] = useState(0);
  const [meteringDb, setMeteringDb] = useState(-60);
  const [presetKey, setPresetKeyState] = useState<PresetKey>(AudioSettingsStorage.getPreset());

  const activePreset: AudioPresetConfig = AUDIO_PRESETS[presetKey] || AUDIO_PRESETS.broadcast_wav_48k;
  const activePresetRef = useRef<AudioPresetConfig>(activePreset);
  activePresetRef.current = activePreset;

  const recorder = useAudioRecorder(activePreset.options);

  // Synchronous operation mutex to block concurrent native invocations
  const isBusyRef = useRef(false);

  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const meterPollingRef = useRef<NodeJS.Timeout | null>(null);
  const startTimeRef = useRef<number>(0);
  const accumulatedMsRef = useRef<number>(0);
  const fileUriRef = useRef<string | null>(null);

  const changePreset = useCallback((key: PresetKey) => {
    if (engineState === 'RECORDING' || engineState === 'PAUSED') {
      throw new Error('Cannot change format preset while capture is in progress.');
    }
    setPresetKeyState(key);
    AudioSettingsStorage.setPreset(key);
  }, [engineState]);

  // Poll native decibels at 30 Hz
  const pollMetering = useCallback(async () => {
    if (!recorder) return;
    try {
      let db: number | undefined;
      if (typeof (recorder as any).getStatusAsync === 'function') {
        const status = await (recorder as any).getStatusAsync();
        db = status?.metering;
      } else if (typeof (recorder as any).getStatus === 'function') {
        const status = (recorder as any).getStatus();
        db = status?.metering;
      } else if (typeof (recorder as any).metering === 'number') {
        db = (recorder as any).metering;
      }

      if (typeof db === 'number' && !isNaN(db)) {
        setMeteringDb(Math.max(-60, Math.min(0, db)));
      }
    } catch {}
  }, [recorder]);

  // UI timer clock & MMKV crash heartbeat synchronizer
  useEffect(() => {
    if (engineState === 'RECORDING') {
      startTimeRef.current = Date.now();
      timerRef.current = setInterval(() => {
        const currentSegment = Date.now() - startTimeRef.current;
        const total = accumulatedMsRef.current + currentSegment;
        setDurationMs(total);
        SessionJournal.updateHeartbeat(total);
      }, 200);

      meterPollingRef.current = setInterval(pollMetering, 33);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      if (meterPollingRef.current) {
        clearInterval(meterPollingRef.current);
        meterPollingRef.current = null;
      }

      setMeteringDb(-60);

      if (engineState === 'PAUSED') {
        accumulatedMsRef.current += Date.now() - startTimeRef.current;
      } else if (engineState === 'IDLE' || engineState === 'STOPPED') {
        accumulatedMsRef.current = 0;
      }
    }

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (meterPollingRef.current) clearInterval(meterPollingRef.current);
    };
  }, [engineState, pollMetering]);

  const startRecording = useCallback(async () => {
    // Drop re-entrant invocations immediately
    if (isBusyRef.current) return;
    isBusyRef.current = true;

    try {
      // Self-heal: If recorder was left in a prepared or recording state, release it first
      try {
        await recorder.stop();
      } catch {}

      const currentConfig = activePresetRef.current;
      const sessionId = `session_${Date.now()}`;
      setDurationMs(0);
      accumulatedMsRef.current = 0;

      // Prepare native audio engine with active preset
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
      setEngineState('RECORDING');
    } catch (error) {
      setEngineState('ERROR');
      throw error;
    } finally {
      isBusyRef.current = false;
    }
  }, [recorder]);

  const pauseRecording = useCallback(async () => {
    if (isBusyRef.current || engineState !== 'RECORDING') return;
    isBusyRef.current = true;

    try {
      await recorder.pause();
      SessionJournal.setStatus('PAUSED');
      setEngineState('PAUSED');
    } catch (error) {
      setEngineState('ERROR');
      throw error;
    } finally {
      isBusyRef.current = false;
    }
  }, [recorder, engineState]);

  const resumeRecording = useCallback(async () => {
    if (isBusyRef.current || engineState !== 'PAUSED') return;
    isBusyRef.current = true;

    try {
      await recorder.record();
      SessionJournal.setStatus('RECORDING');
      setEngineState('RECORDING');
    } catch (error) {
      setEngineState('ERROR');
      throw error;
    } finally {
      isBusyRef.current = false;
    }
  }, [recorder, engineState]);

  const stopRecording = useCallback(async (): Promise<string | null> => {
    if (isBusyRef.current) return null;
    isBusyRef.current = true;

    try {
      await recorder.stop();
      const finalUri = recorder.uri || fileUriRef.current;

      SessionJournal.setStatus('FINALIZED');
      SessionJournal.clearSession();

      setEngineState('STOPPED');
      return finalUri;
    } catch (error) {
      setEngineState('ERROR');
      throw error;
    } finally {
      isBusyRef.current = false;
    }
  }, [recorder]);

  // Clean error recovery resetting the native session to clean state
  const resetEngine = useCallback(async () => {
    try {
      await recorder.stop();
    } catch {}
    SessionJournal.clearSession();
    setEngineState('IDLE');
    setDurationMs(0);
    setMeteringDb(-60);
    accumulatedMsRef.current = 0;
    isBusyRef.current = false;
  }, [recorder]);

  return {
    engineState,
    durationMs,
    meteringDb,
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