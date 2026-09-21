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
import { SafeAreaView } from 'react-native-safe-area-context';
import { AudioInputDevice } from '../../../modules/audio-hardware-router/src';
import { EngineState } from '../../services/audio/useAudioRecording';

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
  const isLocked = engineState === 'RECORDING' || engineState === 'PAUSED';

  const getTypeLabel = (type: AudioInputDevice['type']) => {
    switch (type) {
      case 'usb_device':
      case 'usb_headset':
      case 'usb_accessory':
        return { label: 'USB INTERFACE', bg: '#1A3326', text: '#00E676' };
      case 'bluetooth_sco':
      case 'bluetooth_a2dp':
        return { label: 'BLUETOOTH', bg: '#1C2938', text: '#64B5F6' };
      case 'wired_headset':
        return { label: 'ANALOG HEADSET', bg: '#33261A', text: '#FFB74D' };
      default:
        return { label: 'INTERNAL MIC', bg: '#262626', text: '#B0BEC5' };
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <View style={styles.topBar}>
          <View>
            <Text style={styles.heading}>Hardware Routing</Text>
            <Text style={styles.subheading}>{devices.length} Audio Inputs Detected</Text>
          </View>
          <TouchableOpacity style={styles.closeBtn} onPress={onClose}>
            <Text style={styles.closeText}>DONE</Text>
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={styles.content}>
          {isLocked && (
            <View style={styles.lockNotice}>
              <Text style={styles.lockNoticeTitle}>Hardware Routing Locked</Text>
              <Text style={styles.lockNoticeText}>
                Microphone capsule routing cannot be changed while recording is active.
              </Text>
            </View>
          )}

          <Text style={styles.sectionTitle}>DETECTED INPUT CAPSULES</Text>

          {devices.map((device) => {
            const isSelected = selectedDeviceId === device.id;
            const typeInfo = getTypeLabel(device.type);

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
                      <View style={[styles.badge, { backgroundColor: typeInfo.bg }]}>
                        <Text style={[styles.badgeText, { color: typeInfo.text }]}>
                          {typeInfo.label}
                        </Text>
                      </View>
                      <Text style={styles.idBadge}>ID #{device.id}</Text>
                    </View>
                  </View>

                  <View style={[styles.radioOuter, isSelected && styles.radioOuterSelected]}>
                    {isSelected && <View style={styles.radioInner} />}
                  </View>
                </View>

                <View style={styles.specsRow}>
                  <Text style={styles.specItem}>
                    Supported Rates:{' '}
                    {device.sampleRates.length > 0
                      ? device.sampleRates.map((r) => `${r / 1000}k`).join(', ')
                      : 'Hardware Dynamic'}
                  </Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#121212',
  },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#262626',
  },
  heading: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '700',
  },
  subheading: {
    color: '#757575',
    fontSize: 12,
    marginTop: 2,
  },
  closeBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: '#262626',
    borderRadius: 16,
  },
  closeText: {
    color: '#00E676',
    fontWeight: '700',
    fontSize: 12,
  },
  content: {
    padding: 16,
    gap: 12,
  },
  lockNotice: {
    backgroundColor: '#261C0D',
    borderWidth: 1,
    borderColor: '#FFD600',
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
  },
  lockNoticeTitle: {
    color: '#FFD600',
    fontWeight: '700',
    fontSize: 12,
    marginBottom: 2,
  },
  lockNoticeText: {
    color: '#E0E0E0',
    fontSize: 11,
    lineHeight: 16,
  },
  sectionTitle: {
    color: '#757575',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    marginBottom: 4,
    marginLeft: 4,
  },
  deviceCard: {
    backgroundColor: '#1E1E1E',
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: '#2A2A2A',
    padding: 16,
  },
  deviceCardActive: {
    borderColor: '#00E676',
    backgroundColor: '#1C2620',
  },
  deviceCardDisabled: {
    opacity: 0.6,
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
    fontSize: 16,
    fontWeight: '700',
  },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 4,
  },
  badge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: '700',
  },
  idBadge: {
    backgroundColor: '#262626',
    color: '#757575',
    fontSize: 10,
    fontWeight: '600',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  radioOuter: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: '#555555',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 12,
    marginTop: 2,
  },
  radioOuterSelected: {
    borderColor: '#00E676',
  },
  radioInner: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#00E676',
  },
  specsRow: {
    borderTopWidth: 1,
    borderTopColor: '#262626',
    paddingTop: 8,
    marginTop: 4,
  },
  specItem: {
    color: '#757575',
    fontSize: 11,
  },
});