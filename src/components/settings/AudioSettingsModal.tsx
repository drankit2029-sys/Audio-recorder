// src/components/settings/AudioSettingsModal.tsx
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
import { AUDIO_PRESETS, PresetKey, AudioPresetConfig } from '../../services/audio/types';
import { EngineState } from '../../services/audio/useAudioRecording';

interface AudioSettingsModalProps {
  visible: boolean;
  onClose: () => void;
  activePresetKey: PresetKey;
  onSelectPreset: (key: PresetKey) => void;
  engineState: EngineState;
}

export const AudioSettingsModal: React.FC<AudioSettingsModalProps> = ({
  visible,
  onClose,
  activePresetKey,
  onSelectPreset,
  engineState,
}) => {
  const isLocked = engineState === 'RECORDING' || engineState === 'PAUSED';
  const presetsList = Object.values(AUDIO_PRESETS);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        {/* Header */}
        <View style={styles.topBar}>
          <View>
            <Text style={styles.heading}>Format Settings</Text>
            <Text style={styles.subheading}>Master Audio Encoding Profile</Text>
          </View>
          <TouchableOpacity style={styles.closeBtn} onPress={onClose}>
            <Text style={styles.closeText}>DONE</Text>
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={styles.content}>
          {isLocked && (
            <View style={styles.lockNotice}>
              <Text style={styles.lockNoticeTitle}>Settings Locked</Text>
              <Text style={styles.lockNoticeText}>
                Encoding presets cannot be altered during active recording. Stop capture to change formats.
              </Text>
            </View>
          )}

          <Text style={styles.sectionTitle}>ENCODING PRESETS</Text>

          {presetsList.map((preset: AudioPresetConfig) => {
            const isSelected = activePresetKey === preset.key;

            return (
              <TouchableOpacity
                key={preset.key}
                disabled={isLocked}
                style={[
                  styles.presetCard,
                  isSelected && styles.presetCardActive,
                  isLocked && styles.presetCardDisabled,
                ]}
                onPress={() => {
                  onSelectPreset(preset.key);
                }}
                activeOpacity={0.7}
              >
                <View style={styles.presetHeader}>
                  <View style={styles.titleCol}>
                    <Text style={styles.presetLabel}>{preset.label}</Text>
                    <View style={styles.badgeRow}>
                      <Text style={styles.badge}>{preset.badge}</Text>
                      <Text style={styles.channelBadge}>Mono</Text>
                    </View>
                  </View>

                  {/* Radio Indicator */}
                  <View style={[styles.radioOuter, isSelected && styles.radioOuterSelected]}>
                    {isSelected && <View style={styles.radioInner} />}
                  </View>
                </View>

                <Text style={styles.presetDescription}>{preset.description}</Text>

                <View style={styles.specsRow}>
                  <Text style={styles.specItem}>Format: {preset.extension.toUpperCase()}</Text>
                  <Text style={styles.specDot}>•</Text>
                  <Text style={styles.specItem}>Rate: {(preset.sampleRate / 1000).toFixed(1)} kHz</Text>
                  <Text style={styles.specDot}>•</Text>
                  <Text style={styles.specItem}>
                    {preset.bitRate ? `${preset.bitRate / 1000} kbps` : `${preset.bitDepth}-bit Linear`}
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
  presetCard: {
    backgroundColor: '#1E1E1E',
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: '#2A2A2A',
    padding: 16,
  },
  presetCardActive: {
    borderColor: '#00E676',
    backgroundColor: '#1C2620',
  },
  presetCardDisabled: {
    opacity: 0.6,
  },
  presetHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 8,
  },
  titleCol: {
    flex: 1,
  },
  presetLabel: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  badgeRow: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 4,
  },
  badge: {
    backgroundColor: '#2C3440',
    color: '#64B5F6',
    fontSize: 10,
    fontWeight: '700',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  channelBadge: {
    backgroundColor: '#262626',
    color: '#9E9E9E',
    fontSize: 10,
    fontWeight: '700',
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
  presetDescription: {
    color: '#9E9E9E',
    fontSize: 12,
    lineHeight: 17,
    marginBottom: 12,
  },
  specsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderTopWidth: 1,
    borderTopColor: '#262626',
    paddingTop: 10,
  },
  specItem: {
    color: '#757575',
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },
  specDot: {
    color: '#424242',
    fontSize: 10,
  },
});