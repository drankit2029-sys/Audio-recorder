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
import { X, Check } from 'lucide-react-native';

import { AUDIO_PRESETS, PresetKey, AudioPresetConfig } from '../../services/audio/types';
import { EngineState } from '../../services/audio/useAudioRecording';
import { useResponsive } from '../../hooks/useResponsive';

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
  const { isTablet } = useResponsive();
  const isLocked = engineState === 'RECORDING' || engineState === 'PAUSED';
  const presetsList = Object.values(AUDIO_PRESETS);

  const cardContent = (
    <View style={[styles.dialogCard, isTablet && styles.dialogCardTablet]}>
      <View style={styles.topBar}>
        <View>
          <Text style={styles.heading}>Format Settings</Text>
          <Text style={styles.subheading}>Master Audio Encoding Profile</Text>
        </View>
        <TouchableOpacity style={styles.closeBtn} onPress={onClose} activeOpacity={0.7}>
          <X size={16} color="#FFFFFF" />
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {isLocked && (
          <View style={styles.lockNotice}>
            <Text style={styles.lockNoticeTitle}>FORMAT LOCKED</Text>
            <Text style={styles.lockNoticeText}>
              Encoding presets cannot be altered during capture. Stop recording to select profiles.
            </Text>
          </View>
        )}

        <Text style={styles.sectionTitle}>ENCODING PROFILES</Text>

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
              onPress={() => onSelectPreset(preset.key)}
              activeOpacity={0.7}
            >
              <View style={styles.presetHeader}>
                <View style={styles.titleCol}>
                  <Text style={styles.presetLabel}>{preset.label}</Text>
                  <View style={styles.badgeRow}>
                    <View style={styles.badge}>
                      <Text style={styles.badgeText}>{preset.badge}</Text>
                    </View>
                    <View style={[styles.badge, styles.channelBadge]}>
                      <Text style={styles.channelBadgeText}>MONO</Text>
                    </View>
                  </View>
                </View>

                <View style={[styles.radioOuter, isSelected && styles.radioOuterSelected]}>
                  {isSelected && <Check size={12} color="#000000" strokeWidth={3} />}
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
    </View>
  );

  return (
    <Modal
      visible={visible}
      animationType={isTablet ? 'fade' : 'slide'}
      presentationStyle={isTablet ? 'overFullScreen' : 'pageSheet'}
      transparent={isTablet}
      onRequestClose={onClose}
    >
      {isTablet ? (
        <View style={styles.backdrop}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onClose} />
          {cardContent}
        </View>
      ) : (
        <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
          {cardContent}
        </SafeAreaView>
      )}
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.82)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  dialogCard: {
    flex: 1,
    width: '100%',
    backgroundColor: '#0F0F0F',
  },
  dialogCardTablet: {
    flex: 0,
    maxWidth: 600,
    maxHeight: '84%',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: '#242424',
    overflow: 'hidden',
  },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#1E1E1E',
  },
  heading: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '700',
  },
  subheading: {
    color: '#8E8E93',
    fontSize: 12,
    marginTop: 2,
  },
  closeBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#1C1C1E',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#2C2C2E',
  },
  content: {
    padding: 16,
    gap: 12,
  },
  lockNotice: {
    backgroundColor: '#161616',
    borderWidth: 1,
    borderColor: '#2C2C2C',
    borderRadius: 12,
    padding: 12,
    marginBottom: 6,
  },
  lockNoticeTitle: {
    color: '#FFFFFF',
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
    color: '#8E8E93',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    marginBottom: 4,
    marginLeft: 4,
  },
  presetCard: {
    backgroundColor: '#141414',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#242424',
    padding: 16,
  },
  presetCardActive: {
    borderColor: '#FFFFFF',
    backgroundColor: '#181818',
  },
  presetCardDisabled: {
    opacity: 0.5,
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
    backgroundColor: '#242424',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  badgeText: {
    color: '#E5E5EA',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  channelBadge: {
    backgroundColor: '#1C1C1E',
    borderWidth: 1,
    borderColor: '#2C2C2E',
  },
  channelBadgeText: {
    color: '#8E8E93',
    fontSize: 10,
    fontWeight: '700',
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
  presetDescription: {
    color: '#8E8E93',
    fontSize: 12,
    lineHeight: 16,
    marginBottom: 12,
  },
  specsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderTopWidth: 1,
    borderTopColor: '#202020',
    paddingTop: 10,
  },
  specItem: {
    color: '#8E8E93',
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },
  specDot: {
    color: '#3A3A3C',
    fontSize: 10,
  },
});