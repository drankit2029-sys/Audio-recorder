// src/services/storage/sessionJournal.ts
import { createMMKV } from 'react-native-mmkv';

// Initialize using the v4 Nitro Modules factory function
export const sessionStorage = createMMKV({
  id: 'audio-session-journal',
});

export type RecordingStatus = 'RECORDING' | 'PAUSED' | 'FINALIZED' | 'INTERRUPTED';

export interface ActiveSessionRecord {
  sessionId: string;
  fileUri: string;
  formatPreset: string;
  sampleRate: number;
  channels: 1 | 2;
  startedAt: number;
  lastHeartbeatTimestamp: number;
  byteOffsetEstimate: number;
  status: RecordingStatus;
}

const ACTIVE_SESSION_KEY = 'active_recording_session';

export const SessionJournal = {
  startSession(record: Omit<ActiveSessionRecord, 'lastHeartbeatTimestamp' | 'byteOffsetEstimate' | 'status'>): void {
    const fullRecord: ActiveSessionRecord = {
      ...record,
      lastHeartbeatTimestamp: Date.now(),
      byteOffsetEstimate: 0,
      status: 'RECORDING',
    };
    sessionStorage.set(ACTIVE_SESSION_KEY, JSON.stringify(fullRecord));
  },

  updateHeartbeat(byteOffset: number): void {
    const raw = sessionStorage.getString(ACTIVE_SESSION_KEY);
    if (!raw) return;

    try {
      const record: ActiveSessionRecord = JSON.parse(raw);
      record.lastHeartbeatTimestamp = Date.now();
      record.byteOffsetEstimate = byteOffset;
      sessionStorage.set(ACTIVE_SESSION_KEY, JSON.stringify(record));
    } catch {}
  },

  setStatus(status: RecordingStatus): void {
    const raw = sessionStorage.getString(ACTIVE_SESSION_KEY);
    if (!raw) return;

    try {
      const record: ActiveSessionRecord = JSON.parse(raw);
      record.status = status;
      sessionStorage.set(ACTIVE_SESSION_KEY, JSON.stringify(record));
    } catch {}
  },

  checkOrphanedSession(): ActiveSessionRecord | null {
    try {
      const raw = sessionStorage.getString(ACTIVE_SESSION_KEY);
      if (!raw) return null;

      const record: ActiveSessionRecord = JSON.parse(raw);
      if (record.status !== 'FINALIZED') {
        return record;
      }
    } catch {
      return null;
    }
    return null;
  },

  clearSession(): void {
    sessionStorage.remove(ACTIVE_SESSION_KEY);
  }
};