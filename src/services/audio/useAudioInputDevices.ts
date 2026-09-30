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
  const [activeDevice, setActiveDevice] = useState<AudioInputDevice | null>(null);

  // H3: the native probes are asynchronous now, so this is async too.
  const refreshDevices = useCallback(async () => {
    try {
      const inputs = await AudioHardwareRouter.getAvailableInputs();
      // H3: an empty list used to be swallowed, and the JS fallback used to
      // invent a "[JS Fallback] Built-in Mic" entry. Keeping the list empty is
      // honest — the device picker then says so instead of lying.
      setDevices(inputs ?? []);

      setSelectedDeviceId((prev) => {
        if (prev !== null && inputs.some((d) => d.id === prev)) {
          return prev;
        }
        return inputs[0]?.id ?? null;
      });

      // H4: getActiveInputDevice() used to be a stub returning null, so the UI
      // could never show what was really capturing (or spot that Bluetooth
      // routing silently failed).
      setActiveDevice(await AudioHardwareRouter.getActiveInputDevice());
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
    // Try to route immediately so the UI reflects the choice.
    AudioHardwareRouter.setPreferredInputDevice(deviceId)
      .then(() => AudioHardwareRouter.getActiveInputDevice().then(setActiveDevice).catch(() => {}))
      .catch((e) => console.warn('[useAudioInputDevices] Routing failed:', e));
  }, []);

  const activateHardwareRouting = useCallback(() => {
    if (selectedDeviceId !== null) {
      AudioHardwareRouter.setPreferredInputDevice(selectedDeviceId)
        .then(() => AudioHardwareRouter.getActiveInputDevice().then(setActiveDevice).catch(() => {}))
        .catch((e) => console.warn('[useAudioInputDevices] Routing failed:', e));
    }
  }, [selectedDeviceId]);

  const releaseHardwareRouting = useCallback(() => {
    AudioHardwareRouter.clearPreferredInputDevice()
      .then(() => AudioHardwareRouter.getActiveInputDevice().then(setActiveDevice).catch(() => {}))
      .catch(() => {});
  }, []);

  return {
    devices,
    activeDevice,
    selectedDeviceId,
    selectedDevice: devices.find((d) => d.id === selectedDeviceId) ?? devices[0] ?? null,
    selectDevice,
    refreshDevices,
    activateHardwareRouting,
    releaseHardwareRouting,
  };
}