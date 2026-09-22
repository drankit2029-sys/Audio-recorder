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

export const AudioHardwareRouter = {
  getAvailableInputs(): AudioInputDevice[] {
    try {
      if (NativeModule && typeof NativeModule.getAvailableInputs === 'function') {
        const result = NativeModule.getAvailableInputs();
        if (Array.isArray(result)) {
          return result;
        }
      }
    } catch (e) {
      console.warn('[AudioHardwareRouter] getAvailableInputs native error:', e);
    }
    return [];
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