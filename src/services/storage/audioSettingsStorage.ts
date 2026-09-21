// src/services/storage/audioSettingsStorage.ts
import { createMMKV } from 'react-native-mmkv';
import { PresetKey } from '../audio/types';

const settingsStorage = createMMKV({
  id: 'audio-recorder-settings',
});

const PRESET_STORAGE_KEY = 'active_audio_format_preset';

export const AudioSettingsStorage = {
  getPreset(): PresetKey {
    const saved = settingsStorage.getString(PRESET_STORAGE_KEY) as PresetKey;
    if (saved === 'broadcast_wav_48k' || saved === 'podcast_wav_44k' || saved === 'share_aac_48k') {
      return saved;
    }
    return 'broadcast_wav_48k';
  },

  setPreset(key: PresetKey): void {
    settingsStorage.set(PRESET_STORAGE_KEY, key);
  },
};