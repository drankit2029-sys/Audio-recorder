// src/services/storage/audioSettingsStorage.ts
import { createMMKV } from 'react-native-mmkv';
import {
  PresetKey,
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

  getCustomPresets(): CustomPresetConfig[] {
    try {
      const raw = settingsStorage.getString(CUSTOM_PRESETS_LIST_KEY);
      if (!raw) return [];
      return JSON.parse(raw) as CustomPresetConfig[];
    } catch {
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