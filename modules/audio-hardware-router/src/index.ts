// modules/audio-hardware-router/src/index.ts
import { EventEmitter, NativeModulesProxy, requireNativeModule } from 'expo-modules-core';

export interface AudioInputDevice {
  id: number;
  name: string;
  type: 'builtin_mic' | 'wired_headset' | 'usb_device' | 'usb_headset' | 'usb_accessory' | 'bluetooth_sco' | 'bluetooth_a2dp' | 'external_input';
  typeCode: number;
  sampleRates: number[];
  channelCounts: number[];
}

let NativeModule: any = null;
try {
  NativeModule = requireNativeModule('AudioHardwareRouter');
} catch {
  NativeModule = NativeModulesProxy?.AudioHardwareRouter ?? null;
}

if (!NativeModule) {
  console.warn(
    '[AudioHardwareRouter] Native module not detected. Ensure "audio-hardware-router": "file:./modules/audio-hardware-router" is in package.json and rebuild the native APK.'
  );
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
      const result = NativeModule?.getAvailableInputs();
      if (Array.isArray(result) && result.length > 0) {
        return result;
      }
    } catch (e) {
      console.warn('[AudioHardwareRouter] getAvailableInputs error:', e);
    }
    return [DEFAULT_BUILTIN_DEVICE];
  },
  setPreferredInputDevice(deviceId: number): boolean {
    return NativeModule?.setPreferredInputDevice(deviceId) ?? false;
  },
  clearPreferredInputDevice(): boolean {
    return NativeModule?.clearPreferredInputDevice() ?? false;
  },
  getActiveInputDevice(): AudioInputDevice | null {
    return NativeModule?.getActiveInputDevice() ?? null;
  },
};

export const AudioHardwareRouterEmitter = NativeModule
  ? new EventEmitter(NativeModule)
  : null;