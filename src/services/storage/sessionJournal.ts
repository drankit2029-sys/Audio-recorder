import { MMKV } from 'react-native-mmkv';

let _storage: MMKV | null = null;

function getStorage(): MMKV {
  if (!_storage) {
    _storage = new MMKV({
      id: 'audio-session-journal',
    });
  }
  return _storage;
}

export type RecordingStatus = 'RECORDING' | 'PAUSED' | 'FINALIZED' | 'INTERRUPTED';

export interface ActiveSessionRecord {
  sessionId: string;
  fileUri: string;
  formatPreset: 'broadcast_wav_48k' | 'podcast_wav_44k' | 'share_aac_48k';
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
    getStorage().set(ACTIVE_SESSION_KEY, JSON.stringify(fullRecord));
  },

  updateHeartbeat(byteOffset: number): void {
    const raw = getStorage().getString(ACTIVE_SESSION_KEY);
    if (!raw) return;

    try {
      const record: ActiveSessionRecord = JSON.parse(raw);
      record.lastHeartbeatTimestamp = Date.now();
      record.byteOffsetEstimate = byteOffset;
      getStorage().set(ACTIVE_SESSION_KEY, JSON.stringify(record));
    } catch {}
  },

  setStatus(status: RecordingStatus): void {
    const raw = getStorage().getString(ACTIVE_SESSION_KEY);
    if (!raw) return;

    try {
      const record: ActiveSessionRecord = JSON.parse(raw);
      record.status = status;
      getStorage().set(ACTIVE_SESSION_KEY, JSON.stringify(record));
    } catch {}
  },

  checkOrphanedSession(): ActiveSessionRecord | null {
    try {
      const raw = getStorage().getString(ACTIVE_SESSION_KEY);
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
    getStorage().delete(ACTIVE_SESSION_KEY);
  }
};