import React from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  TouchableWithoutFeedback,
} from 'react-native';
import { AlertTriangle, Trash2, Play } from 'lucide-react-native';

import { ActiveSessionRecord } from '../../services/storage/sessionJournal';
import { AudioSettingsStorage } from '../../services/storage/audioSettingsStorage';
import { useResponsive } from '../../hooks/useResponsive';

interface InterruptedTakeModalProps {
  visible: boolean;
  session: ActiveSessionRecord | null;
  sizeBytes: number;
  onDiscard: () => void;
  onResume: () => void;
}

const formatDuration = (ms: number) => {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  return hrs > 0
    ? `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
    : `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
};

const formatSize = (bytes: number) => {
  if (bytes <= 0) return '0 KB';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};

export const InterruptedTakeModal: React.FC<InterruptedTakeModalProps> = ({
  visible,
  session,
  sizeBytes,
  onDiscard,
  onResume,
}) => {
  const { isTablet } = useResponsive();

  if (!session) return null;

  const durationMs =
    session.byteOffsetEstimate > 0
      ? session.byteOffsetEstimate
      : Math.max(1000, session.lastHeartbeatTimestamp - session.startedAt);

  const presetBadge =
    AudioSettingsStorage.getResolvedPreset(session.formatPreset)?.badge ?? 'WAV Master';

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onDiscard}
    >
      <TouchableWithoutFeedback onPress={onDiscard}>
        <View style={styles.backdrop}>
          <TouchableWithoutFeedback onPress={(e) => e.stopPropagation()}>
            <View style={[styles.card, isTablet && styles.cardTablet]}>
              <View style={styles.iconCircle}>
                <AlertTriangle size={20} color="#F59E0B" strokeWidth={2.4} />
              </View>

              <Text style={styles.title}>Interrupted Take Detected</Text>
              <Text style={styles.description}>
                The app closed during active audio capture. Continue the session from
                where it stopped, or discard the partial recording permanently.
              </Text>

              <View style={styles.metaBox}>
                <View style={styles.metaRow}>
                  <Text style={styles.metaLabel}>RECOVERED TIME</Text>
                  <Text style={styles.metaVal}>{formatDuration(durationMs)}</Text>
                </View>
                <View style={styles.metaDivider} />
                <View style={styles.metaRow}>
                  <Text style={styles.metaLabel}>CAPTURED FILE</Text>
                  <Text style={styles.metaVal}>{formatSize(sizeBytes)}</Text>
                </View>
                <View style={styles.metaDivider} />
                <View style={styles.metaRow}>
                  <Text style={styles.metaLabel}>FORMAT</Text>
                  <Text style={styles.metaVal}>{presetBadge}</Text>
                </View>
              </View>

              <View style={styles.actionRow}>
                <TouchableOpacity
                  style={styles.discardBtn}
                  onPress={onDiscard}
                  activeOpacity={0.75}
                >
                  <Trash2 size={14} color="#EF4444" strokeWidth={2.2} />
                  <Text style={styles.discardBtnText}>Discard</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.resumeBtn}
                  onPress={onResume}
                  activeOpacity={0.8}
                >
                  <Play size={13} color="#000000" fill="#000000" />
                  <Text style={styles.resumeBtnText}>CONTINUE TAKE</Text>
                </TouchableOpacity>
              </View>
            </View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
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
    maxWidth: 380,
    backgroundColor: '#121215',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: '#24242A',
    padding: 22,
    alignItems: 'center',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.6,
    shadowRadius: 20,
    elevation: 18,
  },
  cardTablet: {
    maxWidth: 440,
    padding: 26,
  },
  iconCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(245, 158, 11, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.28)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: -0.2,
    textAlign: 'center',
  },
  description: {
    color: '#8E8E93',
    fontSize: 12.5,
    lineHeight: 18,
    textAlign: 'center',
    marginTop: 6,
    marginBottom: 16,
  },
  metaBox: {
    width: '100%',
    backgroundColor: '#09090C',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#1C1C22',
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginBottom: 18,
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 4,
  },
  metaLabel: {
    color: '#71717A',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  metaVal: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  metaDivider: {
    height: 1,
    backgroundColor: '#15151A',
    marginVertical: 2,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    width: '100%',
  },
  discardBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.24)',
  },
  discardBtnText: {
    color: '#EF4444',
    fontSize: 13,
    fontWeight: '600',
  },
  resumeBtn: {
    flex: 1.25,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#FFFFFF',
  },
  resumeBtnText: {
    color: '#000000',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.4,
  },
});
