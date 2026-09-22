// src/services/audio/useAudioInputDevices.ts
import { useState, useEffect, useCallback } from 'react';
import {
  AudioHardwareRouter,
  AudioHardwareRouterEmitter,
  AudioInputDevice,
} from '../../../modules/audio-hardware-router/src';

export function useAudioInputDevices() {
  const [devices, setDevices] = useState<AudioInputDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<number | null>(null);

  const refreshDevices = useCallback(() => {
    try {
      const inputs = AudioHardwareRouter.getAvailableInputs();
      setDevices(inputs);

      const active = AudioHardwareRouter.getActiveInputDevice();
      if (active) {
        setSelectedDeviceId(active.id);
      } else {
        setSelectedDeviceId((prev) => {
          if (prev !== null && inputs.some((d) => d.id === prev)) {
            return prev;
          }
          return inputs[0]?.id ?? null;
        });
      }
    } catch (e) {
      console.warn('[useAudioInputDevices] Query failed:', e);
    }
  }, []); // Stable callback

  useEffect(() => {
    refreshDevices();

    if (!AudioHardwareRouterEmitter) return;

    const sub = AudioHardwareRouterEmitter.addListener(
      'onAudioDevicesUpdated',
      () => {
        refreshDevices();
      }
    );

    return () => {
      sub.remove();
    };
  }, [refreshDevices]);

  const selectDevice = useCallback((deviceId: number) => {
    try {
      // Optimistically select so radio button and border illuminate immediately
      setSelectedDeviceId(deviceId);

      const success = AudioHardwareRouter.setPreferredInputDevice(deviceId);
      if (!success) {
        const active = AudioHardwareRouter.getActiveInputDevice();
        if (active) setSelectedDeviceId(active.id);
      }
      return success;
    } catch {
      return false;
    }
  }, []);

  const resetToDefault = useCallback(() => {
    try {
      AudioHardwareRouter.clearPreferredInputDevice();
      const active = AudioHardwareRouter.getActiveInputDevice();
      setSelectedDeviceId(active?.id ?? devices[0]?.id ?? null);
    } catch {}
  }, [devices]);

  return {
    devices,
    selectedDeviceId,
    selectedDevice: devices.find((d) => d.id === selectedDeviceId) ?? devices[0] ?? null,
    selectDevice,
    resetToDefault,
    refreshDevices,
  };
}