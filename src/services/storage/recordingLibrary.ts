// src/services/storage/recordingLibrary.ts
import { createMMKV } from 'react-native-mmkv';
import * as FileSystem from 'expo-file-system/legacy';

export interface SavedRecording {
  id: string;
  name: string;
  uri: string;
  sizeBytes: number;
  durationMs: number;
  createdAt: number;
}

const libraryStorage = createMMKV({
  id: 'audio-recordings-library',
});

const LIBRARY_STORAGE_KEY = 'saved_recordings_index';

export const RecordingLibrary = {
  getAll(): SavedRecording[] {
    try {
      const raw = libraryStorage.getString(LIBRARY_STORAGE_KEY);
      if (!raw) return [];
      return JSON.parse(raw) as SavedRecording[];
    } catch {
      return [];
    }
  },

  save(recording: SavedRecording): SavedRecording[] {
    const existing = this.getAll();
    const updated = [recording, ...existing];
    libraryStorage.set(LIBRARY_STORAGE_KEY, JSON.stringify(updated));
    return updated;
  },

  async delete(id: string): Promise<SavedRecording[]> {
    const existing = this.getAll();
    const target = existing.find((item) => item.id === id);

    if (target?.uri) {
      try {
        await FileSystem.deleteAsync(target.uri, { idempotent: true });
      } catch (err) {
        console.warn('[RecordingLibrary] Failed to delete file on disk:', err);
      }
    }

    const updated = existing.filter((item) => item.id !== id);
    libraryStorage.set(LIBRARY_STORAGE_KEY, JSON.stringify(updated));
    return updated;
  },

  rename(id: string, newName: string): SavedRecording[] {
    const existing = this.getAll();
    const updated = existing.map((item) =>
      item.id === id ? { ...item, name: newName } : item
    );
    libraryStorage.set(LIBRARY_STORAGE_KEY, JSON.stringify(updated));
    return updated;
  },
};