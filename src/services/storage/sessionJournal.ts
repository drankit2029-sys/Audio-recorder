import { MMKV } from 'react-native-mmkv';

export const sessionStorage = new MMKV({
  id: 'audio-session-journal',
  encryptionKey: 'session-journal-secure-key'
});

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
  /**
   * Commits a new recording session to synchronous storage.
   */
  startSession(record: Omit<ActiveSessionRecord, 'lastHeartbeatTimestamp' | 'byteOffsetEstimate' | 'status'>): void {
    const fullRecord: ActiveSessionRecord = {
      ...record,
      lastHeartbeatTimestamp: Date.now(),
      byteOffsetEstimate: 0,
      status: 'RECORDING',
    };
    sessionStorage.set(ACTIVE_SESSION_KEY, JSON.stringify(fullRecord));
  },

  /**
   * Invoked every 2 seconds by the recording loop to maintain a crash-recovery point.
   */
  updateHeartbeat(byteOffset: number): void {
    const raw = sessionStorage.getString(ACTIVE_SESSION_KEY);
    if (!raw) return;

    try {
      const record: ActiveSessionRecord = JSON.parse(raw);
      record.lastHeartbeatTimestamp = Date.now();
      record.byteOffsetEstimate = byteOffset;
      sessionStorage.set(ACTIVE_SESSION_KEY, JSON.stringify(record));
    } catch {
      // In-memory corruption guard
    }
  },

  /**
   * Sets the session state to PAUSED or INTERRUPTED.
   */
  setStatus(status: RecordingStatus): void {
    const raw = sessionStorage.getString(ACTIVE_SESSION_KEY);
    if (!raw) return;

    try {
      const record: ActiveSessionRecord = JSON.parse(raw);
      record.status = status;
      sessionStorage.set(ACTIVE_SESSION_KEY, JSON.stringify(record));
    } catch {}
  },

  /**
   * Inspects storage for orphaned sessions after an app crash or system kill.
   */
  checkOrphanedSession(): ActiveSessionRecord | null {
    const raw = sessionStorage.getString(ACTIVE_SESSION_KEY);
    if (!raw) return null;

    try {
      const record: ActiveSessionRecord = JSON.parse(raw);
      if (record.status !== 'FINALIZED') {
        return record;
      }
    } catch {
      return null;
    }
    return null;
  },

  /**
   * Clears the active session journal once the audio file is safely finalized.
   */
  clearSession(): void {
    sessionStorage.delete(ACTIVE_SESSION_KEY);
  }
};