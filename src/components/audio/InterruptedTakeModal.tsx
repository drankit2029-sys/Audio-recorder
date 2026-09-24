// src/components/audio/InterruptedTakeModal.tsx
import React from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import { RotateCcw, Trash2, Clock, HardDrive, AlertTriangle } from 'lucide-react-native';
import { ActiveSessionRecord } from '../../services/storage/sessionJournal';
import { AUDIO_PRESETS } from '../../services/audio/types';
import { useResponsive } from '../../hooks/useResponsive';

interface InterruptedTakeModalProps {
  visible: boolean;
  session: ActiveSessionRecord | null;
  sizeBytes: number;
  onDiscard: () => void;
  onRestore: () => void;
}

export const InterruptedTakeModal: React.FC<InterruptedTakeModalProps> = ({
  visible,
  session,
  sizeBytes,
  onDiscard,
  onRestore,
}) => {
  const { isTablet } = useResponsive();

  if (!session) return null;

  const durationMs =
    session.byteOffsetEstimate > 0
      ? session.byteOffsetEstimate
      : Math.max(0, session.lastHeartbeatTimestamp - session.startedAt);

  const formatDuration = (ms: number) => {
    const totalSeconds = Math.floor(ms / 1000);
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    const centis = Math.floor((ms % 1000) / 10);
    return `${mins.toString().padStart(2, '0')}:${secs
      .toString()
      .padStart(2, '0')}.${centis.toString().padStart(2, '0')}`;
  };

  const formatSize = (bytes: number) => {
    if (bytes <= 0) return '0 KB';
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  const presetBadge = AUDIO_PRESETS[session.formatPreset]?.badge ?? 'WAV Master';
  const startedTime = new Date(session.startedAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onDiscard}
    >
      <View style={styles.backdrop}>
        <View style={[styles.card, isTablet && styles.cardTablet]}>
          {/* Glowing Amber Warning Icon Circle */}
          <View style={styles.iconCircle}>
            <AlertTriangle size={24} color="#F59E0B" strokeWidth={2.2} />
          </View>

          <Text style={styles.title}>Interrupted Take Detected</Text>
          <Text style={styles.description}>
            The app closed during active audio capture. You can restore this audio take to your library or permanently discard it.
          </Text>

          {/* Session Metadata Card */}
          <View style={styles.metaBox}>
            <View style={styles.metaRow}>
              <View style={styles.metaItem}>
                <Clock size={12} color="#71717A" />
                <Text style={styles.metaLabel}>Started at {startedTime}</Text>
              </View>
              <View style={styles.formatBadge}>
                <Text style={styles.formatBadgeText}>{presetBadge}</Text>
              </View>
            </View>

            <View style={styles.divider} />

            <View style={styles.statsRow}>
              <View style={styles.statCol}>
                <Text style={styles.statLabel}>DURATION</Text>
                <Text style={styles.statValue}>{formatDuration(durationMs)}</Text>
              </View>
              <View style={styles.statCol}>
                <Text style={styles.statLabel}>SIZE ON DISK</Text>
                <View style={styles.sizeRow}>
                  <HardDrive size={11} color="#A1A1AA" />
                  <Text style={styles.statValue}>{formatSize(sizeBytes)}</Text>
                </View>
              </View>
            </View>
          </View>

          {/* Action Buttons */}
          <View style={styles.actionsRow}>
            <TouchableOpacity
              style={styles.discardBtn}
              onPress={onDiscard}
              activeOpacity={0.7}
            >
              <Trash2 size={14} color="#EF4444" strokeWidth={2.2} />
              <Text style={styles.discardBtnText}>DISCARD</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.restoreBtn}
              onPress={onRestore}
              activeOpacity={0.8}
            >
              <RotateCcw size={14} color="#000000" strokeWidth={2.5} />
              <Text style={styles.restoreBtnText}>RESTORE TAKE</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.84)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 390,
    backgroundColor: '#131316',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: '#24242A',
    paddingHorizontal: 22,
    paddingTop: 24,
    paddingBottom: 20,
    alignItems: 'center',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.6,
    shadowRadius: 20,
    elevation: 16,
  },
  cardTablet: {
    maxWidth: 440,
    paddingHorizontal: 28,
    paddingTop: 28,
    paddingBottom: 24,
  },
  iconCircle: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: 'rgba(245, 158, 11, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.28)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: -0.3,
    marginBottom: 6,
    textAlign: 'center',
  },
  description: {
    color: '#8E8E93',
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
    marginBottom: 18,
    paddingHorizontal: 4,
  },
  metaBox: {
    width: '100%',
    backgroundColor: '#09090C',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#1F1F24',
    padding: 12,
    marginBottom: 20,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  metaItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  metaLabel: {
    color: '#8E8E93',
    fontSize: 11,
    fontWeight: '500',
  },
  formatBadge: {
    backgroundColor: '#1E1E24',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  formatBadgeText: {
    color: '#E4E4E7',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#1C1C22',
    marginVertical: 10,
  },
  statsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  statCol: {
    gap: 3,
  },
  statLabel: {
    color: '#71717A',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.6,
  },
  statValue: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  sizeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  actionsRow: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  discardBtn: {
    flex: 1,
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: 22,
    backgroundColor: 'rgba(239, 68, 68, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.25)',
  },
  discardBtnText: {
    color: '#EF4444',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  restoreBtn: {
    flex: 1.3,
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: 22,
    backgroundColor: '#FFFFFF',
  },
  restoreBtnText: {
    color: '#000000',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
});