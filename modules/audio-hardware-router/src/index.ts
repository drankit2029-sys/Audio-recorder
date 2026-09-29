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
  /** True when the platform actually reported the supported sample rates. */
  sampleRatesKnown: boolean;
  channelCountsKnown: boolean;
  /** True for playback-only devices (e.g. an A2DP speaker listed as a fallback). */
  isSink: boolean;
}

export const AudioHardwareRouter = {
  /** False when the native module is missing (e.g. Expo Go or a stale build). */
  isAvailable(): boolean {
    return !!NativeRouter && typeof NativeRouter.getAvailableInputs === 'function';
  },

  /**
   * H3: the native methods are async now (synchronous bridge methods do not
   * exist under the New Architecture), so this returns a Promise.
   *
   * M7/H3: the old version silently invented a "[JS Fallback] Built-in Mic"
   * entry whenever the native call failed, which hid link errors and made the
   * UI claim a device was selected when nothing had been routed. It now returns
   * an empty list and lets the caller explain the situation.
   */
  async getAvailableInputs(): Promise<AudioInputDevice[]> {
    if (!NativeRouter || typeof NativeRouter.getAvailableInputs !== 'function') {
      return [];
    }
    try {
      const result = await NativeRouter.getAvailableInputs();
      return Array.isArray(result) ? (result as AudioInputDevice[]) : [];
    } catch (e) {
      console.warn('[AudioHardwareRouter] native error:', e);
      return [];
    }
  },

  async setPreferredInputDevice(deviceId: number): Promise<boolean> {
    if (!NativeRouter || typeof NativeRouter.setPreferredInputDevice !== 'function') {
      return false;
    }
    try {
      return (await NativeRouter.setPreferredInputDevice(deviceId)) === true;
    } catch (e) {
      console.warn('[AudioHardwareRouter] setPreferredInputDevice failed:', e);
      return false;
    }
  },

  async clearPreferredInputDevice(): Promise<boolean> {
    if (!NativeRouter || typeof NativeRouter.clearPreferredInputDevice !== 'function') {
      return false;
    }
    try {
      return (await NativeRouter.clearPreferredInputDevice()) === true;
    } catch {
      return false;
    }
  },

  async getActiveInputDevice(): Promise<AudioInputDevice | null> {
    if (!NativeRouter || typeof NativeRouter.getActiveInputDevice !== 'function') {
      return null;
    }
    try {
      return (await NativeRouter.getActiveInputDevice()) as AudioInputDevice | null;
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
  /** Append to an existing take instead of starting a new file (resume). */
  append?: boolean;
  /** PCM bytes already in the file when appending. */
  existingDataBytes?: number;
  /** Recorded duration already in the file when appending. */
  initialDurationMs?: number;
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
  sizeBytes: number;
  filePath: string | null;
  lastError: string | null;
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
  durationMs: number;
}

export interface WavErrorEvent {
  message: string;
}

export const WavRecorderEmitter = NativeWavRecorder
  ? new NativeEventEmitter(NativeWavRecorder)
  : null;

const IDLE_STATUS: WavStatus = {
  isRecording: false,
  isPaused: false,
  canRecord: false,
  durationMs: 0,
  metering: -160,
  sizeBytes: 0,
  filePath: null,
  lastError: null,
};

/**
 * Live snapshot maintained from the native metering event.
 *
 * H3: `getStatus()` used to be a synchronous bridge call that the UI polled
 * every animation frame. Under the New Architecture that call does not exist,
 * so per-frame reads come from here instead (no bridge traffic, no jank) and
 * the Promise-based native call is only used to resynchronise.
 */
let statusCache: WavStatus = { ...IDLE_STATUS };

function updateCache(patch: Partial<WavStatus>): void {
  statusCache = { ...statusCache, ...patch };
}

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
    const result = (await NativeWavRecorder.prepare(options)) as WavPrepareResult;
    updateCache({
      ...IDLE_STATUS,
      canRecord: true,
      filePath: result?.filePath ?? options.filePath,
    });
    return result;
  },

  async start(): Promise<void> {
    await NativeWavRecorder?.start();
    updateCache({ isRecording: true, isPaused: false, canRecord: true, lastError: null });
  },

  async pause(): Promise<void> {
    await NativeWavRecorder?.pause();
    updateCache({ isRecording: false, isPaused: true });
  },

  async resume(): Promise<void> {
    await NativeWavRecorder?.resume();
    updateCache({ isRecording: true, isPaused: false });
  },

  async stop(): Promise<WavStopResult> {
    const result = (await NativeWavRecorder?.stop()) as WavStopResult | undefined;
    updateCache({ ...IDLE_STATUS });
    return result ?? { filePath: null, durationMs: 0, sizeBytes: 0, truncated: false };
  },

  /** Promise-based truth. Prefer `getStatusSync()` on hot paths. */
  async getStatus(): Promise<WavStatus | null> {
    if (!NativeWavRecorder) {
      return null;
    }
    try {
      const status = (await NativeWavRecorder.getStatus()) as WavStatus | null;
      if (status) {
        statusCache = { ...statusCache, ...status };
      }
      return statusCache;
    } catch {
      return null;
    }
  },

  /** Last known status, fed by the metering event. Safe to call every frame. */
  getStatusSync(): WavStatus {
    return statusCache;
  },

  resetStatusCache(): void {
    statusCache = { ...IDLE_STATUS };
  },

  /**
   * Rewrites the RIFF header of a take whose process died before stop() ran.
   * M9: without this the recovered file declares a zero-length data chunk even
   * though the PCM bytes are on disk.
   */
  async repair(
    filePath: string,
    dataBytes: number,
    frameSize: number = 1
  ): Promise<{ ok: boolean; dataBytes: number }> {
    if (!NativeWavRecorder || typeof NativeWavRecorder.repair !== 'function') {
      return { ok: false, dataBytes: 0 };
    }
    try {
      const result = await NativeWavRecorder.repair({ filePath, dataBytes, frameSize });
      return { ok: true, dataBytes: Number(result?.dataBytes ?? dataBytes) };
    } catch (e) {
      console.warn('[WavRecorder] repair failed:', e);
      return { ok: false, dataBytes: 0 };
    }
  },

  release(): void {
    try {
      NativeWavRecorder?.release();
    } catch {
      /* noop */
    }
    statusCache = { ...IDLE_STATUS };
  },
};

export function onWavMetering(
  listener: (event: WavMeteringEvent) => void
): EmitterSubscription | null {
  return WavRecorderEmitter?.addListener('wavRecorderMetering', (event) => {
    listener(event);
    updateCache({
      metering: event?.metering ?? -160,
      sizeBytes: event?.sizeBytes ?? 0,
      durationMs: event?.durationMs ?? 0,
      isRecording: true,
      isPaused: false,
    });
  }) ?? null;
}

/**
 * C3: emitted when the capture thread dies (device unplugged, disk full,
 * AudioRecord error). Previously the take kept "recording" forever and the
 * resulting file was unplayable.
 */
export function onWavError(
  listener: (event: WavErrorEvent) => void
): EmitterSubscription | null {
  return WavRecorderEmitter?.addListener('wavRecorderError', (event) => {
    updateCache({ isRecording: false, isPaused: false, lastError: event?.message ?? null });
    listener(event ?? { message: 'Unknown WAV capture error' });
  }) ?? null;
}
