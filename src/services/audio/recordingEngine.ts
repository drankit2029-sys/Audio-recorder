import { AudioRecorder, RecordingOptions } from 'expo-audio';
import { WavRecorder, WavStopResult } from '../../../modules/audio-hardware-router/src';
import { AudioPresetConfig, EngineKind } from './types';
import {
  moveIntoTakesFolder,
  reserveNativeTakePath,
  ensureTakesFolder,
} from '../storage/recordingPaths';


export interface UnifiedStopResult {
  uri: string | null;
  durationMs: number;
  sizeBytes: number;
  /** True when the engine silently substituted different parameters. */
  degraded: boolean;
  degradationNote?: string;
}

export interface UnifiedRecorder {
  readonly kind: EngineKind;
  readonly rawUri: string | null;
  prepare(preset: AudioPresetConfig, displayName: string, inputDeviceId: number): Promise<void>;
  start(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(displayName: string, extension: string): Promise<UnifiedStopResult>;
  /** dBFS, or null when metering is unavailable. */
  getMetering(): number | null;
  getDurationMs(): number;
  release(): void;
}

function stripToFileUri(uri: string | null | undefined): string | null {
  if (!uri) return null;
  return uri.startsWith('file://') ? uri.replace('file://', '') : uri;
}

// ---------------------------------------------------------------------------
// Tier A — MediaRecorder (lossy formats)
// ---------------------------------------------------------------------------

class MediaRecorderEngine implements UnifiedRecorder {
  readonly kind: EngineKind = 'mediarecorder';

  private prepared = false;

  constructor(private readonly recorder: AudioRecorder) {}

  get rawUri(): string | null {
    return this.recorder.uri ?? null;
  }

  async prepare(
    preset: AudioPresetConfig,
    _displayName: string,
    _inputDeviceId: number
  ): Promise<void> {
    try {
      await this.recorder.stop();
    } catch {
      /* not recording - fine */
    }

    const options = preset.options as Partial<RecordingOptions>;
    await this.recorder.prepareToRecordAsync(options);
    this.prepared = true;
  }

  async start(): Promise<void> {
    this.recorder.record();
  }

  async pause(): Promise<void> {
    this.recorder.pause();
  }

  async resume(): Promise<void> {
    this.recorder.record();
  }

  async stop(displayName: string, extension: string): Promise<UnifiedStopResult> {
    let durationMs = 0;
    try {
      const status = this.recorder.getStatus();
      durationMs = status?.durationMillis ?? 0;
    } catch {
      /* ignore */
    }

    let raw: string | null = null;
    try {
      await this.recorder.stop();
      raw = this.recorder.uri ?? null;
    } catch (e) {
      console.warn('[recordingEngine] MediaRecorder.stop() threw:', e);
      raw = this.recorder.uri ?? null;
    }

    this.prepared = false;

    if (!raw) {
      return { uri: null, durationMs, sizeBytes: 0, degraded: false };
    }

    const result = await moveIntoTakesFolder(raw, displayName, extension);

    return {
      uri: result.uri,
      durationMs,
      sizeBytes: result.sizeBytes,
      degraded: !result.relocated,
      degradationNote: result.relocated
        ? undefined
        : 'The take could not be moved into the AudioRecorder folder; it is still readable from the app cache.',
    };
  }

  getMetering(): number | null {
    try {
      const status = this.recorder.getStatus();
      return typeof status?.metering === 'number' ? status.metering : null;
    } catch {
      return null;
    }
  }

  getDurationMs(): number {
    try {
      return this.recorder.getStatus()?.durationMillis ?? 0;
    } catch {
      return 0;
    }
  }

  release(): void {
    try {
      this.recorder.stop();
    } catch {
      /* ignore */
    }
    this.prepared = false;
  }
}

// ---------------------------------------------------------------------------
// Tier B — AudioRecord + RIFF (real WAV)
// ---------------------------------------------------------------------------

class AudioRecordEngine implements UnifiedRecorder {
  readonly kind: EngineKind = 'audiorecord';

  private degradationNote: string | undefined;
  private active = false;

  get rawUri(): string | null {
    const status = WavRecorder.getStatus();
    const path = status?.filePath ?? null;
    return path ? `file://${path}` : null;
  }

    async prepare(
    preset: AudioPresetConfig,
    displayName: string,
    inputDeviceId: number
  ): Promise<void> {
    WavRecorder.release();

    // Write straight into the dedicated folder - no cache round-trip.
    // toNativePath() strips file:// so java.io.File gets an absolute path.
    await ensureTakesFolder();
    const filePath = await reserveNativeTakePath(displayName, preset.extension);

    const result = await WavRecorder.prepare({
      filePath,
      sampleRate: preset.sampleRate,
      numberOfChannels: preset.channels,
      bitDepth: (preset.bitDepth === 32 ? 32 : 16) as 16 | 32,
      inputDeviceId,
    });

    const notes: string[] = [];

    if (result.sampleRate !== preset.sampleRate) {
      notes.push(`Hardware delivered ${result.sampleRate} Hz instead of ${preset.sampleRate} Hz.`);
    }
    if (result.bitDepth !== (preset.bitDepth === 32 ? 32 : 16) * 8) {
      notes.push(`Hardware delivered ${result.bitDepth}-bit instead of ${preset.bitDepth}-bit.`);
    }
    if (result.numberOfChannels !== preset.channels) {
      notes.push(`Hardware delivered ${result.numberOfChannels} channel(s) instead of ${preset.channels}.`);
    }

    this.degradationNote = notes.length > 0 ? notes.join(' ') : undefined;
  }


  async start(): Promise<void> {
    await WavRecorder.start();
    this.active = true;
  }

  async pause(): Promise<void> {
    await WavRecorder.pause();
  }

  async resume(): Promise<void> {
    await WavRecorder.resume();
  }

  async stop(_displayName: string, _extension: string): Promise<UnifiedStopResult> {
    const result: WavStopResult = await WavRecorder.stop();
    this.active = false;

    const uri = result.filePath ? `file://${result.filePath}` : null;
    const note = result.truncated
      ? 'Recording stopped early: the WAV container 32-bit size field was reached.'
      : this.degradationNote;

    return {
      uri,
      durationMs: result.durationMs,
      sizeBytes: result.sizeBytes,
      degraded: Boolean(note),
      degradationNote: note,
    };
  }

  getMetering(): number | null {
    if (!this.active) return null;
    const status = WavRecorder.getStatus();
    return typeof status?.metering === 'number' ? status.metering : null;
  }

  getDurationMs(): number {
    return WavRecorder.getStatus()?.durationMs ?? 0;
  }

  release(): void {
    WavRecorder.release();
    this.active = false;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createUnifiedRecorder(
  preset: AudioPresetConfig,
  mediaRecorderInstance: AudioRecorder
): UnifiedRecorder {
  return preset.engine === 'audiorecord'
    ? new AudioRecordEngine()
    : new MediaRecorderEngine(mediaRecorderInstance);
}

export { stripToFileUri };
