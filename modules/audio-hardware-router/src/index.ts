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
        if (Array.isArray(result) && result.length > 0) {
          return result;
        }
      }
    } catch (e) {
      console.warn('[AudioHardwareRouter] native error:', e);
    }
    
    // Diagnostic Fallback: If you see this exact string in the UI, Autolinking failed.
    return [
      {
        id: 999,
        name: '[JS Fallback] Built-in Mic',
        type: 'builtin_mic',
        typeCode: 15,
        sampleRates: [48000],
        channelCounts: [1],
      },
    ];
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