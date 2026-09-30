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
  /**
   * Recorded duration in milliseconds.
   *
   * M9: this used to be called `byteOffsetEstimate` and was fed the duration,
   * which made the name a lie and left the recovery path without the byte
   * count it actually needs to patch the RIFF header.
   */
  durationMs: number;
  /**
   * Bytes of PCM written so far. Needed by WavRecorder.repair() to rebuild a
   * valid RIFF header after the process died mid-take.
   */
  dataBytes: number;
  status: RecordingStatus;
  waveformSnapshot?: number[];
  prompterOffset?: number;
}

const ACTIVE_SESSION_KEY = 'active_recording_session';
const STUDIO_SESSION_KEY = 'studio_active_session_v2';

/**
 * Crash journal for a studio session. The working WAV is written by the
 * native engine, so recovering only needs its path and how to deliver it.
 */
export interface StudioJournalRecord {
  version: 2;
  sessionId: string;
  /** Absolute path of the working WAV. */
  sessionPath: string;
  /** Preset used for new takes (ignored for edits). */
  presetKey: string;
  badge: string;
  sampleRate: number;
  channels: number;
  floatPcm: boolean;
  /** Set when the session edits a library take. */
  editOf?: { id: string; name: string; uri: string } | null;
  startedAt: number;
  lastHeartbeatTimestamp: number;
  durationMs: number;
}

/** Journals written by earlier builds used `byteOffsetEstimate` for the duration. */
interface LegacySessionRecord extends Omit<ActiveSessionRecord, 'durationMs' | 'dataBytes'> {
  byteOffsetEstimate?: number;
  durationMs?: number;
  dataBytes?: number;
}

function normalize(raw: string): ActiveSessionRecord {
  const record = (JSON.parse(raw) ?? {}) as LegacySessionRecord;
  return {
    ...record,
    durationMs: record.durationMs ?? record.byteOffsetEstimate ?? 0,
    dataBytes: record.dataBytes ?? 0,
  } as ActiveSessionRecord;
}

export interface HeartbeatPatch {
  durationMs?: number;
  dataBytes?: number;
  waveformSnapshot?: number[];
  prompterOffset?: number;
}

export const SessionJournal = {
  startSession(
    record: Omit<
      ActiveSessionRecord,
      'lastHeartbeatTimestamp' | 'durationMs' | 'dataBytes' | 'status'
    >
  ): void {
    const fullRecord: ActiveSessionRecord = {
      ...record,
      lastHeartbeatTimestamp: Date.now(),
      durationMs: 0,
      dataBytes: 0,
      status: 'RECORDING',
    };
    sessionStorage.set(ACTIVE_SESSION_KEY, JSON.stringify(fullRecord));
  },

  /**
   * M9: named arguments — the old positional signature is what let a duration
   * be stored in a field called `byteOffsetEstimate`.
   */
  updateHeartbeat(patch: HeartbeatPatch): void {
    const raw = sessionStorage.getString(ACTIVE_SESSION_KEY);
    if (!raw) return;

    try {
      const record = normalize(raw);
      record.lastHeartbeatTimestamp = Date.now();
      if (typeof patch.durationMs === 'number') {
        record.durationMs = patch.durationMs;
      }
      if (typeof patch.dataBytes === 'number') {
        record.dataBytes = patch.dataBytes;
      }
      if (patch.waveformSnapshot && patch.waveformSnapshot.length > 0) {
        record.waveformSnapshot = patch.waveformSnapshot;
      }
      if (typeof patch.prompterOffset === 'number') {
        record.prompterOffset = patch.prompterOffset;
      }
      sessionStorage.set(ACTIVE_SESSION_KEY, JSON.stringify(record));
    } catch {}
  },

  setStatus(status: RecordingStatus): void {
    const raw = sessionStorage.getString(ACTIVE_SESSION_KEY);
    if (!raw) return;

    try {
      const record = normalize(raw);
      record.status = status;
      sessionStorage.set(ACTIVE_SESSION_KEY, JSON.stringify(record));
    } catch {}
  },

  checkOrphanedSession(): ActiveSessionRecord | null {
    try {
      const raw = sessionStorage.getString(ACTIVE_SESSION_KEY);
      if (!raw) return null;

      const record = normalize(raw);
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
  },

  // ---- studio sessions (v2) ----------------------------------------------

  startStudioSession(
    record: Omit<StudioJournalRecord, 'version' | 'lastHeartbeatTimestamp' | 'durationMs'> & {
      durationMs?: number;
    }
  ): void {
    const full: StudioJournalRecord = {
      ...record,
      version: 2,
      durationMs: record.durationMs ?? 0,
      lastHeartbeatTimestamp: Date.now(),
    };
    sessionStorage.set(STUDIO_SESSION_KEY, JSON.stringify(full));
    // A studio session supersedes anything left by the old recorder.
    sessionStorage.remove(ACTIVE_SESSION_KEY);
  },

  updateStudioHeartbeat(durationMs: number): void {
    const raw = sessionStorage.getString(STUDIO_SESSION_KEY);
    if (!raw) return;
    try {
      const record = JSON.parse(raw) as StudioJournalRecord;
      record.durationMs = durationMs;
      record.lastHeartbeatTimestamp = Date.now();
      sessionStorage.set(STUDIO_SESSION_KEY, JSON.stringify(record));
    } catch {}
  },

  getStudioSession(): StudioJournalRecord | null {
    try {
      const raw = sessionStorage.getString(STUDIO_SESSION_KEY);
      if (!raw) return null;
      const record = JSON.parse(raw) as StudioJournalRecord;
      return record && record.version === 2 && record.sessionPath ? record : null;
    } catch {
      return null;
    }
  },

  clearStudioSession(): void {
    sessionStorage.remove(STUDIO_SESSION_KEY);
  },
};
