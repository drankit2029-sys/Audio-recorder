// src/services/audio/useAudioInputDevices.ts
import { useState, useEffect, useCallback, useRef } from 'react';
import {
  AudioHardwareRouter,
  AudioHardwareRouterEmitter,
  AudioInputDevice,
} from '../../../modules/audio-hardware-router/src';

export function useAudioInputDevices() {
  const [devices, setDevices] = useState<AudioInputDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<number | null>(null);

  // Guard against broadcast storms resetting user selection
  const userSelectedIdRef = useRef<number | null>(null);
  const isTransitioningRef = useRef<boolean>(false);

  const refreshDevices = useCallback(() => {
    try {
      const inputs = AudioHardwareRouter.getAvailableInputs();
      if (!inputs || inputs.length === 0) return;

      setDevices(inputs);

      // If user recently selected a device, lock onto it if it's in the list
      const lockedId = userSelectedIdRef.current;
      if (lockedId !== null && inputs.some((d) => d.id === lockedId)) {
        setSelectedDeviceId(lockedId);
        return;
      }

      // If in a transition handshake, don't clobber state
      if (isTransitioningRef.current) return;

      const active = AudioHardwareRouter.getActiveInputDevice();
      if (active && inputs.some((d) => d.id === active.id)) {
        setSelectedDeviceId(active.id);
        userSelectedIdRef.current = active.id;
      } else {
        setSelectedDeviceId((prev) => {
          if (prev !== null && inputs.some((d) => d.id === prev)) {
            return prev;
          }
          const defaultId = inputs[0]?.id ?? null;
          userSelectedIdRef.current = defaultId;
          return defaultId;
        });
      }
    } catch (e) {
      console.warn('[useAudioInputDevices] Query failed:', e);
    }
  }, []);

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
      isTransitioningRef.current = true;
      userSelectedIdRef.current = deviceId;
      setSelectedDeviceId(deviceId);

      const success = AudioHardwareRouter.setPreferredInputDevice(deviceId);

      // Release transition lock after handshake settles
      setTimeout(() => {
        isTransitioningRef.current = false;
        const active = AudioHardwareRouter.getActiveInputDevice();
        if (active) {
          userSelectedIdRef.current = active.id;
          setSelectedDeviceId(active.id);
        }
      }, 600);

      return success;
    } catch {
      isTransitioningRef.current = false;
      return false;
    }
  }, []);

  const resetToDefault = useCallback(() => {
    try {
      AudioHardwareRouter.clearPreferredInputDevice();
      userSelectedIdRef.current = null;
      isTransitioningRef.current = false;
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