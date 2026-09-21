// modules/audio-hardware-router/src/index.ts
import { NativeModules, NativeEventEmitter } from 'react-native';

const { AudioHardwareRouter: NativeModule } = NativeModules;

export interface AudioInputDevice {
  id: number;
  name: string;
  type:
    | 'builtin_mic'
    | 'wired_headset'
    | 'usb_device'
    | 'usb_headset'
    | 'usb_accessory'
    | 'bluetooth_sco'
    | 'bluetooth_a2dp'
    | 'external_input';
  typeCode: number;
  sampleRates: number[];
  channelCounts: number[];
}

const DEFAULT_BUILTIN_DEVICE: AudioInputDevice = {
  id: 1,
  name: 'Built-in Microphone',
  type: 'builtin_mic',
  typeCode: 15,
  sampleRates: [44100, 48000],
  channelCounts: [1, 2],
};

export const AudioHardwareRouter = {
  getAvailableInputs(): AudioInputDevice[] {
    try {
      const result = NativeModule?.getAvailableInputs?.();
      if (Array.isArray(result) && result.length > 0) {
        return result;
      }
    } catch (e) {
      console.warn('[AudioHardwareRouter] getAvailableInputs error:', e);
    }
    return [DEFAULT_BUILTIN_DEVICE];
  },

  setPreferredInputDevice(deviceId: number): boolean {
    try {
      return NativeModule?.setPreferredInputDevice?.(deviceId) ?? false;
    } catch {
      return false;
    }
  },

  clearPreferredInputDevice(): boolean {
    try {
      return NativeModule?.clearPreferredInputDevice?.() ?? false;
    } catch {
      return false;
    }
  },

  getActiveInputDevice(): AudioInputDevice | null {
    try {
      return NativeModule?.getActiveInputDevice?.() ?? null;
    } catch {
      return null;
    }
  },
};

export const AudioHardwareRouterEmitter = NativeModule
  ? new NativeEventEmitter(NativeModule)
  : null;