// src/services/storage/audioSettingsStorage.ts
import { createMMKV } from 'react-native-mmkv';
import {
  PresetKey,
  AudioFormatType,
  CustomPresetConfig,
  AudioPresetConfig,
  AUDIO_PRESETS,
  customPresetToAudioPreset,
} from '../audio/types';

const settingsStorage = createMMKV({
  id: 'audio-recorder-settings',
});

const PRESET_STORAGE_KEY = 'active_audio_format_preset';
const CUSTOM_PRESETS_LIST_KEY = 'custom_audio_presets_list';
const WAVEFORM_ZOOM_KEY = 'studio_waveform_px_per_second';

/** Horizontal scale of the studio waveform, in points per second of audio. */
export const MIN_WAVEFORM_ZOOM = 2.5;
export const MAX_WAVEFORM_ZOOM = 150;
export const DEFAULT_WAVEFORM_ZOOM = 40;

/** Formats the platform encoders are actually wired for. */
const KNOWN_FORMATS: AudioFormatType[] = [
  'wav',
  'aac',
  'aac_eld',
  'he_aac',
  'aac_adts',
  'amr_wb',
  'amr_nb',
];

/** Rates AudioRecord accepts for PCM capture. */
const KNOWN_RATES = [8000, 11025, 16000, 22050, 32000, 44100, 48000, 96000];

function sanitizeCustomPreset(input: unknown): CustomPresetConfig | null {
  if (!input || typeof input !== 'object') return null;
  const p = input as Record<string, unknown>;
  if (typeof p.id !== 'string' || !p.id) return null;
  const format = KNOWN_FORMATS.indexOf(p.format as AudioFormatType) >= 0
    ? (p.format as AudioFormatType)
    : 'wav';
  const rawRate = Number(p.sampleRate);
  const sampleRate =
    Number.isFinite(rawRate) && KNOWN_RATES.indexOf(Math.round(rawRate)) >= 0
      ? Math.round(rawRate)
      : 48000;
  const channels = Number(p.channels) === 2 ? 2 : 1;
  const rawDepth = Number(p.bitDepth);
  const bitDepth = format === 'wav' && rawDepth === 32 ? 32 : format === 'wav' ? 16 : undefined;
  const rawBitRate = Number(p.bitRate);
  const bitRate =
    format === 'wav' || !Number.isFinite(rawBitRate)
      ? undefined
      : Math.max(16000, Math.min(512000, Math.round(rawBitRate)));
  return {
    id: p.id,
    name: typeof p.name === 'string' && p.name.trim() ? p.name : 'Custom preset',
    format,
    sampleRate,
    channels,
    ...(bitDepth ? { bitDepth } : {}),
    ...(bitRate ? { bitRate } : {}),
    ...(typeof p.description === 'string' ? { description: p.description } : {}),
    createdAt: Number.isFinite(Number(p.createdAt)) ? Number(p.createdAt) : Date.now(),
  } as CustomPresetConfig;
}

export const clampWaveformZoom = (value: number): number => {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_WAVEFORM_ZOOM;
  return Math.max(MIN_WAVEFORM_ZOOM, Math.min(MAX_WAVEFORM_ZOOM, value));
};

export const AudioSettingsStorage = {
  getPreset(): PresetKey {
    const saved = settingsStorage.getString(PRESET_STORAGE_KEY);
    if (saved) return saved;
    return 'broadcast_wav_48k';
  },

  setPreset(key: PresetKey): void {
    settingsStorage.set(PRESET_STORAGE_KEY, key);
  },

  /**
   * Custom presets are hand-edited JSON in MMKV and are fed straight into the
   * native recorder: an entry missing `format` used to take the settings sheet
   * down on `FORMAT_LABELS[format]`, and a nonsense `sampleRate` would be
   * accepted by `AudioRecord` only to produce a silent or rejected capture. So
   * nothing leaves this getter unnormalised.
   */
  getCustomPresets(): CustomPresetConfig[] {
    try {
      const raw = settingsStorage.getString(CUSTOM_PRESETS_LIST_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        settingsStorage.remove(CUSTOM_PRESETS_LIST_KEY);
        return [];
      }
      return parsed.map(sanitizeCustomPreset).filter((p): p is CustomPresetConfig => !!p);
    } catch {
      settingsStorage.remove(CUSTOM_PRESETS_LIST_KEY);
      return [];
    }
  },

  saveCustomPreset(preset: CustomPresetConfig): CustomPresetConfig[] {
    const existing = this.getCustomPresets();
    const index = existing.findIndex((p) => p.id === preset.id);

    let updated: CustomPresetConfig[];
    if (index >= 0) {
      updated = [...existing];
      updated[index] = preset;
    } else {
      updated = [preset, ...existing];
    }

    settingsStorage.set(CUSTOM_PRESETS_LIST_KEY, JSON.stringify(updated));
    return updated;
  },

  deleteCustomPreset(id: string): CustomPresetConfig[] {
    const existing = this.getCustomPresets();
    const updated = existing.filter((p) => p.id !== id);
    settingsStorage.set(CUSTOM_PRESETS_LIST_KEY, JSON.stringify(updated));

    if (this.getPreset() === id) {
      this.setPreset('broadcast_wav_48k');
    }

    return updated;
  },

  getWaveformZoom(): number {
    const val = settingsStorage.getNumber(WAVEFORM_ZOOM_KEY);
    return typeof val === 'number' ? clampWaveformZoom(val) : DEFAULT_WAVEFORM_ZOOM;
  },

  setWaveformZoom(pxPerSecond: number): void {
    settingsStorage.set(WAVEFORM_ZOOM_KEY, clampWaveformZoom(pxPerSecond));
  },

  getResolvedPreset(key: PresetKey): AudioPresetConfig {
    if (AUDIO_PRESETS[key]) {
      return AUDIO_PRESETS[key];
    }

    const customList = this.getCustomPresets();
    const found = customList.find((p) => p.id === key);
    if (found) {
      return customPresetToAudioPreset(found);
    }

    return AUDIO_PRESETS.broadcast_wav_48k;
  },
};