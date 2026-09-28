import { NativeModules, NativeEventEmitter, EmitterSubscription } from 'react-native';

const { AudioHardwareRouter: NativeRouter, WavRecorder: NativeWavRecorder } = NativeModules;

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
      if (NativeRouter && typeof NativeRouter.getAvailableInputs === 'function') {
        const result = NativeRouter.getAvailableInputs();
        if (Array.isArray(result) && result.length > 0) {
          return result;
        }
      }
    } catch (e) {
      console.warn('[AudioHardwareRouter] native error:', e);
    }
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
      return NativeRouter?.setPreferredInputDevice?.(deviceId) ?? false;
    } catch {
      return false;
    }
  },

  clearPreferredInputDevice(): boolean {
    try {
      return NativeRouter?.clearPreferredInputDevice?.() ?? false;
    } catch {
      return false;
    }
  },

  getActiveInputDevice(): AudioInputDevice | null {
    try {
      return NativeRouter?.getActiveInputDevice?.() ?? null;
    } catch {
      return null;
    }
  },
};

export const AudioHardwareRouterEmitter = NativeRouter
  ? new NativeEventEmitter(NativeRouter)
  : null;

// ---------------------------------------------------------------------------
// WavRecorder: AudioRecord -> RIFF/WAVE
// ---------------------------------------------------------------------------

export interface WavPrepareOptions {
  filePath: string;
  sampleRate: number;
  numberOfChannels: number;
  /** 16 or 32. 32 requests IEEE float and degrades to 16-bit if unsupported. */
  bitDepth: 16 | 32;
  /** -1 to skip preferred-device routing. */
  inputDeviceId: number;
}

export interface WavPrepareResult {
  filePath: string;
  sampleRate: number;
  numberOfChannels: number;
  bitDepth: number;
  floatPcm: boolean;
}

export interface WavStatus {
  isRecording: boolean;
  isPaused: boolean;
  canRecord: boolean;
  durationMs: number;
  metering: number;
  filePath: string | null;
}

export interface WavStopResult {
  filePath: string | null;
  durationMs: number;
  sizeBytes: number;
  truncated: boolean;
}

export interface WavMeteringEvent {
  metering: number;
  sizeBytes: number;
}

export const WavRecorderEmitter = NativeWavRecorder
  ? new NativeEventEmitter(NativeWavRecorder)
  : null;

export const WavRecorder = {
  isAvailable(): boolean {
    return !!NativeWavRecorder;
  },

  async prepare(options: WavPrepareOptions): Promise<WavPrepareResult> {
    if (!NativeWavRecorder) {
      throw new Error(
        'WavRecorder native module is not linked. Rebuild the Android app after adding the module.'
      );
    }
    return NativeWavRecorder.prepare(options) as Promise<WavPrepareResult>;
  },

  async start(): Promise<void> {
    await NativeWavRecorder?.start();
  },

  async pause(): Promise<void> {
    await NativeWavRecorder?.pause();
  },

  async resume(): Promise<void> {
    await NativeWavRecorder?.resume();
  },

  async stop(): Promise<WavStopResult> {
    const result = (await NativeWavRecorder?.stop()) as WavStopResult | undefined;
    return result ?? { filePath: null, durationMs: 0, sizeBytes: 0, truncated: false };
  },

  getStatus(): WavStatus | null {
    try {
      return NativeWavRecorder?.getStatus() ?? null;
    } catch {
      return null;
    }
  },

  release(): void {
    try {
      NativeWavRecorder?.release();
    } catch {
      /* noop */
    }
  },
};

export function onWavMetering(
  listener: (event: WavMeteringEvent) => void
): EmitterSubscription | null {
  return WavRecorderEmitter?.addListener('wavRecorderMetering', listener) ?? null;
}