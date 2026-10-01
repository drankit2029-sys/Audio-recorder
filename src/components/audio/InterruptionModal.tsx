// src/components/audio/InterruptionModal.tsx
import React from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  TouchableWithoutFeedback,
} from 'react-native';
import { AlertTriangle, PhoneOff, RefreshCw } from 'lucide-react-native';

import { useResponsive } from '../../hooks/useResponsive';

export interface InterruptionInfo {
  /** Why the take stopped, in plain words. */
  title: string;
  detail: string;
  /** Where the take was parked when the interruption hit. */
  positionMs: number;
  durationMs: number;
  /** The interrupted pass was a Replace (punch-in), not a plain take. */
  overwriting: boolean;
}

interface InterruptionModalProps {
  visible: boolean;
  info: InterruptionInfo | null;
  busyLabel?: string | null;
  onResume: () => void;
  onKeepPaused: () => void;
}

const formatClock = (ms: number) => {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
};

const REASONS: Record<string, { title: string; detail: string }> = {
  focus_loss: {
    title: 'Audio was interrupted',
    detail:
      'Another app took over the audio path (an incoming call, an alarm, or a voice assistant), so the take was paused to keep it safe.',
  },
  mic_taken: {
    title: 'Microphone taken over',
    detail:
      'The system handed the microphone to another app — a call is the usual reason. Everything recorded up to the pause is kept.',
  },
  capture_lost: {
    title: 'Capture stopped',
    detail:
      'The microphone stopped delivering audio, so the take was paused. It can be re-opened and the take continued.',
  },
};

/**
 * Shown when the engine paused a live take on its own (a call, another capture
 * client, a lost microphone). Deliberately has no tap-outside dismissal: the
 * user must choose to resume the capture or leave the take paused.
 */
export const InterruptionModal: React.FC<InterruptionModalProps> = ({
  visible,
  info,
  busyLabel,
  onResume,
  onKeepPaused,
}) => {
  const { isTablet } = useResponsive();
  if (!info) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={() => {}}
    >
      <TouchableWithoutFeedback onPress={() => {}}>
        <View style={styles.backdrop}>
          <TouchableWithoutFeedback
              onPress={(e: { stopPropagation?: () => void }) => e.stopPropagation?.()}
            >
            <View style={[styles.card, isTablet && styles.cardTablet]}>
              <View style={styles.iconCircle}>
                <AlertTriangle size={20} color="#F59E0B" strokeWidth={2.4} />
              </View>

              <Text style={styles.title}>{info.title}</Text>
              <Text style={styles.description}>{info.detail}</Text>

              <View style={styles.metaBox}>
                <View style={styles.metaRow}>
                  <Text style={styles.metaLabel}>KEPT UNTIL</Text>
                  <Text style={styles.metaVal}>{formatClock(info.durationMs)}</Text>
                </View>
                <View style={styles.metaDivider} />
                <View style={styles.metaRow}>
                  <Text style={styles.metaLabel}>PAUSED AT</Text>
                  <Text style={styles.metaVal}>{formatClock(info.positionMs)}</Text>
                </View>
                <View style={styles.metaDivider} />
                <View style={styles.metaRow}>
                  <Text style={styles.metaLabel}>{info.overwriting ? 'REPLACE PASS' : 'APPEND'}</Text>
                  <Text style={styles.metaVal}>
                    {info.overwriting ? 'Continue overwrites from the playhead' : 'Continues at the end'}
                  </Text>
                </View>
              </View>

              <View style={styles.actionRow}>
                <TouchableOpacity
                  style={styles.secondaryBtn}
                  onPress={onKeepPaused}
                  activeOpacity={0.75}
                  disabled={Boolean(busyLabel)}
                >
                  <PhoneOff size={14} color="#8E8E93" strokeWidth={2.2} />
                  <Text style={styles.secondaryBtnText}>Stay paused</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.primaryBtn}
                  onPress={onResume}
                  activeOpacity={0.8}
                  disabled={Boolean(busyLabel)}
                >
                  <RefreshCw size={13} color="#000000" strokeWidth={2.6} />
                  <Text style={styles.primaryBtnText}>
                    {busyLabel ? busyLabel : 'RESUME & RE-OPEN MIC'}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
};

export function describeInterruption(
  reason: string,
  positionMs: number,
  durationMs: number,
  overwriting: boolean
): InterruptionInfo {
  const known = REASONS[reason];
  return {
    title: known?.title ?? 'Take was interrupted',
    detail:
      known?.detail ??
      'The take was paused so nothing could be lost. Resume it to continue recording from where it stopped.',
    positionMs,
    durationMs,
    overwriting,
  };
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.78)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    borderRadius: 22,
    backgroundColor: '#0D0D10',
    borderWidth: 1,
    borderColor: '#232329',
    padding: 22,
    alignItems: 'center',
  },
  cardTablet: { maxWidth: 480 },
  iconCircle: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: 'rgba(245,158,11,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(245,158,11,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 8,
    textAlign: 'center',
  },
  description: {
    color: '#A1A1AA',
    fontSize: 13.5,
    lineHeight: 20,
    textAlign: 'center',
    marginBottom: 16,
  },
  metaBox: {
    width: '100%',
    borderRadius: 14,
    backgroundColor: '#121215',
    borderWidth: 1,
    borderColor: '#1F1F26',
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 18,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
    gap: 12,
  },
  metaDivider: { height: StyleSheet.hairlineWidth, backgroundColor: '#1F1F26' },
  metaLabel: {
    color: '#71717A',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.6,
  },
  metaVal: {
    color: '#E4E4E7',
    fontSize: 12.5,
    fontWeight: '600',
    flexShrink: 1,
    textAlign: 'right',
  },
  actionRow: {
    width: '100%',
    flexDirection: 'row',
    gap: 10,
  },
  secondaryBtn: {
    flex: 1,
    height: 46,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#2A2A31',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 7,
  },
  secondaryBtnText: { color: '#E4E4E7', fontSize: 13, fontWeight: '600' },
  primaryBtn: {
    flex: 1.25,
    height: 46,
    borderRadius: 14,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 7,
  },
  primaryBtnText: { color: '#000000', fontSize: 12.5, fontWeight: '800', letterSpacing: 0.2 },
});

export default InterruptionModal;
