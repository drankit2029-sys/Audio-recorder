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
  NativeModule = NativeModulesProxy.AudioHardwareRouter ?? null;
}

export const AudioHardwareRouter = {
  getAvailableInputs(): AudioInputDevice[] {
    return NativeModule?.getAvailableInputs() ?? [];
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