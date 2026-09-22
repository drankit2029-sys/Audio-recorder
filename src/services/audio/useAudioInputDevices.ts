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
      if (!inputs || inputs.length === 0) return;
      setDevices(inputs);

      setSelectedDeviceId((prev) => {
        if (prev !== null && inputs.some((d) => d.id === prev)) {
          return prev;
        }
        return inputs[0]?.id ?? null;
      });
    } catch (e) {
      console.warn('[useAudioInputDevices] Query failed:', e);
    }
  }, []);

  useEffect(() => {
    refreshDevices();

    if (!AudioHardwareRouterEmitter) return;
    const sub = AudioHardwareRouterEmitter.addListener(
      'onAudioDevicesUpdated',
      refreshDevices
    );

    return () => {
      sub.remove();
    };
  }, [refreshDevices]);

  const selectDevice = useCallback((deviceId: number) => {
    setSelectedDeviceId(deviceId);
  }, []);

  const activateHardwareRouting = useCallback(() => {
    if (selectedDeviceId !== null) {
      AudioHardwareRouter.setPreferredInputDevice(selectedDeviceId);
    }
  }, [selectedDeviceId]);

  const releaseHardwareRouting = useCallback(() => {
    AudioHardwareRouter.clearPreferredInputDevice();
  }, []);

  return {
    devices,
    selectedDeviceId,
    selectedDevice: devices.find((d) => d.id === selectedDeviceId) ?? devices[0] ?? null,
    selectDevice,
    refreshDevices,
    activateHardwareRouting,
    releaseHardwareRouting,
  };
}