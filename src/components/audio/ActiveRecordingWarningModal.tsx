// src/components/audio/ActiveRecordingWarningModal.tsx
import React from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import { AlertCircle, Square, Check } from 'lucide-react-native';
import { useResponsive } from '../../hooks/useResponsive';

interface ActiveRecordingWarningModalProps {
  visible: boolean;
  onClose: () => void;
  onStopAndExit: () => void;
}

export const ActiveRecordingWarningModal: React.FC<ActiveRecordingWarningModalProps> = ({
  visible,
  onClose,
  onStopAndExit,
}) => {
  const { isTablet } = useResponsive();

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View style={styles.backdrop}>
        <View style={[styles.card, isTablet && styles.cardTablet]}>
          {/* Warning Icon Badge */}
          <View style={styles.iconCircle}>
            <AlertCircle size={24} color="#FF3B30" strokeWidth={2.2} />
          </View>

          {/* Heading & Notice */}
          <Text style={styles.title}>Recording in Progress</Text>
          <Text style={styles.description}>
            Audio capture is currently active. Please stop and finalize your take before returning to the library.
          </Text>

          {/* Action Buttons */}
          <View style={styles.actionsColumn}>
            <TouchableOpacity
              style={styles.primaryBtn}
              onPress={onClose}
              activeOpacity={0.8}
            >
              <Check size={16} color="#000000" strokeWidth={2.5} />
              <Text style={styles.primaryBtnText}>KEEP RECORDING</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.stopExitBtn}
              onPress={() => {
                onClose();
                onStopAndExit();
              }}
              activeOpacity={0.7}
            >
              <Square size={13} color="#FF453A" fill="#FF453A" />
              <Text style={styles.stopExitBtnText}>STOP & EXIT</Text>
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
    backgroundColor: 'rgba(0, 0, 0, 0.82)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: '#141416',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: '#262628',
    paddingHorizontal: 22,
    paddingTop: 26,
    paddingBottom: 20,
    alignItems: 'center',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.5,
    shadowRadius: 18,
    elevation: 16,
  },
  cardTablet: {
    maxWidth: 440,
    paddingHorizontal: 28,
    paddingTop: 30,
    paddingBottom: 24,
  },
  iconCircle: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#261414',
    borderWidth: 1,
    borderColor: '#3D1C1C',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: -0.3,
    marginBottom: 8,
    textAlign: 'center',
  },
  description: {
    color: '#8E8E93',
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    marginBottom: 22,
    paddingHorizontal: 6,
  },
  actionsColumn: {
    width: '100%',
    gap: 10,
  },
  primaryBtn: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 13,
    borderRadius: 14,
    backgroundColor: '#FFFFFF',
  },
  primaryBtnText: {
    color: '#000000',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  stopExitBtn: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: 14,
    backgroundColor: '#1E1414',
    borderWidth: 1,
    borderColor: '#331C1C',
  },
  stopExitBtnText: {
    color: '#FF453A',
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
});