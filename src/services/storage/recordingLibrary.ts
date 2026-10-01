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

/**
 * A record is only as trustworthy as the JSON blob it came from: one entry
 * written by a future app version (or a half-written MMKV value) used to be
 * enough to crash the library list on the next `.name` access. Everything that
 * leaves this module goes through `valid` so the UI can rely on the shape.
 */
const valid = (item: unknown): item is SavedRecording => {
  if (!item || typeof item !== 'object') return false;
  const r = item as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    r.id.length > 0 &&
    typeof r.name === 'string' &&
    typeof r.uri === 'string' &&
    r.uri.length > 0 &&
    typeof r.sizeBytes === 'number' &&
    Number.isFinite(r.sizeBytes) &&
    typeof r.durationMs === 'number' &&
    Number.isFinite(r.durationMs) &&
    typeof r.createdAt === 'number' &&
    Number.isFinite(r.createdAt)
  );
};

export const RecordingLibrary = {
  getAll(): SavedRecording[] {
    try {
      const raw = libraryStorage.getString(LIBRARY_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        libraryStorage.remove(LIBRARY_STORAGE_KEY);
        return [];
      }
      const clean = parsed.filter(valid);
      // Rewrite only when something was actually dropped, so a healthy index is
      // never churned (and a corrupt one repairs itself once).
      if (clean.length !== parsed.length) {
        libraryStorage.set(LIBRARY_STORAGE_KEY, JSON.stringify(clean));
      }
      return clean;
    } catch {
      libraryStorage.remove(LIBRARY_STORAGE_KEY);
      return [];
    }
  },

  save(recording: SavedRecording): SavedRecording[] {
    // Same-id re-save must replace: two entries with one id make delete and
    // rename ambiguous (they would patch only one of the two).
    const existing = this.getAll().filter((item) => item.id !== recording.id);
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
    const trimmed = newName.trim();
    const existing = this.getAll();
    const updated = existing.map((item) =>
      item.id === id ? { ...item, name: trimmed.length ? trimmed : item.name } : item
    );
    libraryStorage.set(LIBRARY_STORAGE_KEY, JSON.stringify(updated));
    return updated;
  },
  updateUri(id: string, uri: string): SavedRecording[] {
    return this.update(id, { uri });
  },

  /** Same as the free function below, exposed on the object for call sites. */
  pruneMissing(): Promise<SavedRecording[]> {
    return pruneMissingRecordings();
  },

  /** Patches one entry in place (used when an edited take is saved over the original). */
  update(id: string, patch: Partial<Omit<SavedRecording, 'id'>>): SavedRecording[] {
    const existing = this.getAll();
    const safe: Partial<Omit<SavedRecording, 'id'>> = { ...patch };
    if (typeof safe.name !== 'string' || !safe.name.trim()) delete safe.name;
    if (typeof safe.uri !== 'string' || !safe.uri) delete safe.uri;
    if (typeof safe.sizeBytes !== 'number' || !Number.isFinite(safe.sizeBytes) || safe.sizeBytes < 0) {
      delete safe.sizeBytes;
    }
    if (typeof safe.durationMs !== 'number' || !Number.isFinite(safe.durationMs) || safe.durationMs < 0) {
      delete safe.durationMs;
    }
    const updated = existing.map((item) => (item.id === id ? { ...item, ...safe } : item));
    libraryStorage.set(LIBRARY_STORAGE_KEY, JSON.stringify(updated));
    return updated;
  },
};

/**
 * Entries whose file is gone (user cleaned the folder with a file manager, an
 * OS "free up space" pass, or a failed copy) are dropped from the index. Called
 * once at start-up, where an async stat pass is affordable.
 */
export async function pruneMissingRecordings(): Promise<SavedRecording[]> {
  const all = RecordingLibrary.getAll();
  const missing: string[] = [];
  await Promise.all(
    all.map(async (item) => {
      try {
        const info = await FileSystem.getInfoAsync(item.uri);
        if (!info.exists) missing.push(item.id);
      } catch {
        // Unreadable stat is not evidence that the file is gone: keep the entry.
      }
    })
  );
  if (!missing.length) return all;
  const kept = all.filter((item) => missing.indexOf(item.id) === -1);
  libraryStorage.set(LIBRARY_STORAGE_KEY, JSON.stringify(kept));
  return kept;
}
