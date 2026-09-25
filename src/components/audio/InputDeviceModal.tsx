// src/components/audio/InputDeviceModal.tsx
import React from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
} from 'react-native';
import {
  X,
  Mic,
  Bluetooth,
  Usb,
  Headphones,
  Check,
} from 'lucide-react-native';

import { AudioInputDevice } from '../../../modules/audio-hardware-router/src';
import { EngineState } from '../../services/audio/useAudioRecording';
import { useResponsive } from '../../hooks/useResponsive';

interface InputDeviceModalProps {
  visible: boolean;
  onClose: () => void;
  devices: AudioInputDevice[];
  selectedDeviceId: number | null;
  onSelectDevice: (deviceId: number) => void;
  engineState: EngineState;
}

export const InputDeviceModal: React.FC<InputDeviceModalProps> = ({
  visible,
  onClose,
  devices,
  selectedDeviceId,
  onSelectDevice,
  engineState,
}) => {
  const { isTablet } = useResponsive();
  const isLocked = engineState === 'RECORDING' || engineState === 'PAUSED';

  const getTypeMeta = (type: AudioInputDevice['type']) => {
    switch (type) {
      case 'usb_device':
      case 'usb_headset':
      case 'usb_accessory':
        return { label: 'USB INTERFACE', Icon: Usb };
      case 'bluetooth_sco':
      case 'bluetooth_a2dp':
        return { label: 'BLUETOOTH', Icon: Bluetooth };
      case 'wired_headset':
        return { label: 'HEADSET MIC', Icon: Headphones };
      default:
        return { label: 'INTERNAL MIC', Icon: Mic };
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="fade"
      transparent={true}
      statusBarTranslucent={true}
      onRequestClose={onClose}
    >
      <View style={styles.backdrop}>
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onClose} />
        
        <View style={[styles.dialogCard, isTablet && styles.dialogCardTablet]}>
          <View style={styles.topBar}>
            <View>
              <Text style={styles.heading}>Input Hardware</Text>
              <Text style={styles.subheading}>{devices.length} Detected Capsules</Text>
            </View>
            <TouchableOpacity style={styles.closeBtn} onPress={onClose} activeOpacity={0.7}>
              <X size={16} color="#FFFFFF" />
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
            {isLocked && (
              <View style={styles.lockNotice}>
                <Text style={styles.lockNoticeTitle}>ROUTING LOCKED</Text>
                <Text style={styles.lockNoticeText}>
                  Capsule selection is locked during active recording.
                </Text>
              </View>
            )}

            <Text style={styles.sectionTitle}>AUDIO INPUT CAPSULES</Text>

            {devices.map((device) => {
              const isSelected = selectedDeviceId === device.id;
              const { label, Icon } = getTypeMeta(device.type);

              return (
                <TouchableOpacity
                  key={device.id}
                  disabled={isLocked}
                  style={[
                    styles.deviceCard,
                    isSelected && styles.deviceCardActive,
                    isLocked && styles.deviceCardDisabled,
                  ]}
                  onPress={() => onSelectDevice(device.id)}
                  activeOpacity={0.7}
                >
                  <View style={styles.deviceHeader}>
                    <View style={styles.titleCol}>
                      <Text style={styles.deviceName}>{device.name}</Text>
                      <View style={styles.badgeRow}>
                        <View style={styles.typeBadge}>
                          <Icon size={11} color="#FFFFFF" />
                          <Text style={styles.typeBadgeText}>{label}</Text>
                        </View>
                        <Text style={styles.idBadge}>PORT #{device.id}</Text>
                      </View>
                    </View>

                    <View style={[styles.radioOuter, isSelected && styles.radioOuterSelected]}>
                      {isSelected && <Check size={12} color="#000000" strokeWidth={3} />}
                    </View>
                  </View>

                  <View style={styles.specsRow}>
                    <Text style={styles.specItem}>
                      Rates:{' '}
                      {device.sampleRates.length > 0
                        ? device.sampleRates.map((r) => `${r / 1000}k`).join(', ')
                        : 'System Native'}
                    </Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.78)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 30,
  },
  dialogCard: {
    width: '100%',
    maxWidth: 420,
    maxHeight: '82%',
    backgroundColor: '#121215',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: '#24242A',
    overflow: 'hidden',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.65,
    shadowRadius: 20,
    elevation: 18,
  },
  dialogCardTablet: {
    maxWidth: 540,
    maxHeight: '80%',
  },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#1E1E24',
  },
  heading: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  subheading: {
    color: '#8E8E93',
    fontSize: 11,
    marginTop: 2,
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#1C1C22',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#2A2A32',
  },
  content: {
    padding: 16,
    gap: 10,
  },
  lockNotice: {
    backgroundColor: '#1C1414',
    borderWidth: 1,
    borderColor: '#381C1C',
    borderRadius: 12,
    padding: 12,
    marginBottom: 4,
  },
  lockNoticeTitle: {
    color: '#EF4444',
    fontWeight: '700',
    fontSize: 11,
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  lockNoticeText: {
    color: '#8E8E93',
    fontSize: 12,
    lineHeight: 16,
  },
  sectionTitle: {
    color: '#71717A',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1,
    marginBottom: 2,
    marginLeft: 2,
  },
  deviceCard: {
    backgroundColor: '#0A0A0D',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#1E1E24',
    padding: 14,
  },
  deviceCardActive: {
    borderColor: '#FFFFFF',
    backgroundColor: '#141418',
  },
  deviceCardDisabled: {
    opacity: 0.45,
  },
  deviceHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 8,
  },
  titleCol: {
    flex: 1,
  },
  deviceName: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 6,
  },
  typeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  typeBadgeText: {
    color: '#E4E4E7',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  idBadge: {
    color: '#71717A',
    fontSize: 10,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  radioOuter: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: '#48484A',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 12,
    marginTop: 2,
  },
  radioOuterSelected: {
    backgroundColor: '#FFFFFF',
    borderColor: '#FFFFFF',
  },
  specsRow: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#1A1A22',
    paddingTop: 8,
    marginTop: 2,
  },
  specItem: {
    color: '#8E8E93',
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },
});