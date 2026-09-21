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
      } else if (inputs.length > 0 && selectedDeviceId === null) {
        setSelectedDeviceId(inputs[0].id);
      }
    } catch (e) {
      console.warn('[useAudioInputDevices] Query failed:', e);
    }
  }, [selectedDeviceId]);

  useEffect(() => {
    refreshDevices();

    if (!AudioHardwareRouterEmitter) return;

    const sub = AudioHardwareRouterEmitter.addListener(
      'onAudioDevicesUpdated',
      (event: { devices: AudioInputDevice[] }) => {
        if (event?.devices) {
          setDevices(event.devices);
          // Auto-verify if currently selected device was unplugged
          setSelectedDeviceId((prevId) => {
            const exists = event.devices.some((d) => d.id === prevId);
            return exists ? prevId : (event.devices[0]?.id ?? null);
          });
        }
      }
    );

    return () => {
      sub.remove();
    };
  }, [refreshDevices]);

  const selectDevice = useCallback((deviceId: number) => {
    try {
      const success = AudioHardwareRouter.setPreferredInputDevice(deviceId);
      if (success) {
        setSelectedDeviceId(deviceId);
      }
      return success;
    } catch {
      return false;
    }
  }, []);

  const resetToDefault = useCallback(() => {
    try {
      AudioHardwareRouter.clearPreferredInputDevice();
      setSelectedDeviceId(devices[0]?.id ?? null);
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