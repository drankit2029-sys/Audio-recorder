// src/components/settings/AudioSettingsModal.tsx
import React, { useState } from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
} from 'react-native';
import { X, Check, Plus, Pencil, Trash2, AlertTriangle, Slash } from 'lucide-react-native';

import {
  AUDIO_PRESETS,
  PresetKey,
  AudioPresetConfig,
  CustomPresetConfig,
  customPresetToAudioPreset,
  checkDeviceCompatibility,
} from '../../services/audio/types';
import { AudioSettingsStorage } from '../../services/storage/audioSettingsStorage';
import { EngineState } from '../../services/audio/useAudioRecording';
import { AudioInputDevice } from '../../../modules/audio-hardware-router/src';
import { useResponsive } from '../../hooks/useResponsive';
import { CustomPresetEditorModal } from './CustomPresetEditorModal';

interface AudioSettingsModalProps {
  visible: boolean;
  onClose: () => void;
  activePresetKey: PresetKey;
  onSelectPreset: (key: PresetKey) => void;
  engineState: EngineState;
  selectedDevice: AudioInputDevice | null;
}

export const AudioSettingsModal: React.FC<AudioSettingsModalProps> = ({
  visible,
  onClose,
  activePresetKey,
  onSelectPreset,
  engineState,
  selectedDevice,
}) => {
  const { isTablet } = useResponsive();
  const isLocked = engineState === 'RECORDING' || engineState === 'PAUSED';

  const [customPresets, setCustomPresets] = useState<CustomPresetConfig[]>(() =>
    AudioSettingsStorage.getCustomPresets()
  );
  const [editorVisible, setEditorVisible] = useState(false);
  const [editingTarget, setEditingTarget] = useState<CustomPresetConfig | null>(null);

  const factoryPresetsList = Object.values(AUDIO_PRESETS);

  const handleOpenCreate = () => {
    setEditingTarget(null);
    setEditorVisible(true);
  };

  const handleOpenEdit = (preset: CustomPresetConfig) => {
    setEditingTarget(preset);
    setEditorVisible(true);
  };

  const handleDeletePreset = (id: string, name: string) => {
    Alert.alert(
      'Delete Custom Profile',
      `Permanently remove "${name}" from your studio encoding presets?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            const updated = AudioSettingsStorage.deleteCustomPreset(id);
            setCustomPresets(updated);
            if (activePresetKey === id) {
              onSelectPreset('broadcast_wav_48k');
            }
          },
        },
      ]
    );
  };

  const handleSaveCustomConfig = (config: CustomPresetConfig) => {
    const updated = AudioSettingsStorage.saveCustomPreset(config);
    setCustomPresets(updated);
    setEditorVisible(false);
    setEditingTarget(null);

    // Auto-select newly created or updated preset
    onSelectPreset(config.id);
  };

  const renderPresetCard = (preset: AudioPresetConfig, customConfig?: CustomPresetConfig) => {
    const isSelected = activePresetKey === preset.key;
    const compatibility = checkDeviceCompatibility(preset, selectedDevice);
    const isSelectionDisabled = isLocked || !compatibility.isSupported;

    return (
      <View
        key={preset.key}
        style={[
          styles.presetCard,
          isSelected && styles.presetCardActive,
          isSelectionDisabled && styles.presetCardDisabled,
          !compatibility.isSupported && styles.presetCardUnsupported,
        ]}
      >
        <TouchableOpacity
          disabled={isSelectionDisabled}
          onPress={() => onSelectPreset(preset.key)}
          activeOpacity={0.7}
        >
          <View style={styles.presetHeader}>
            <View style={styles.titleCol}>
              <View style={styles.titleRow}>
                <Text style={styles.presetLabel}>{preset.label}</Text>
                {!compatibility.isSupported && (
                  <View style={styles.unsupportedBadge}>
                    <Text style={styles.unsupportedBadgeText}>UNSUPPORTED</Text>
                  </View>
                )}
              </View>

              <View style={styles.badgeRow}>
                <View
                  style={[
                    styles.badge,
                    customConfig ? styles.customChip : null,
                  ]}
                >
                  <Text
                    style={[
                      styles.badgeText,
                      customConfig ? styles.customChipText : null,
                    ]}
                  >
                    {preset.badge}
                  </Text>
                </View>
              </View>
            </View>

            {/* Radio Circle or Disabled Lock */}
            <View
              style={[
                styles.radioOuter,
                isSelected && styles.radioOuterSelected,
                !compatibility.isSupported && styles.radioOuterDisabled,
              ]}
            >
              {isSelected ? (
                <Check size={12} color="#000000" strokeWidth={3} />
              ) : !compatibility.isSupported ? (
                <Slash size={10} color="#78350F" />
              ) : null}
            </View>
          </View>

          <Text style={styles.presetDescription}>{preset.description}</Text>

          {/* Explicit Error Box for Incompatible Formats */}
          {!compatibility.isSupported && (
            <View style={styles.hardwareWarningBox}>
              <AlertTriangle size={13} color="#F59E0B" style={{ marginTop: 1 }} />
              <View style={styles.hardwareWarningCol}>
                <Text style={styles.hardwareWarningTitle}>
                  FORMAT INCOMPATIBLE WITH {selectedDevice?.name?.toUpperCase() || 'CURRENT CAPSULE'}
                </Text>
                {compatibility.reasons.map((reason, idx) => (
                  <Text key={idx} style={styles.hardwareWarningText}>
                    • {reason}
                  </Text>
                ))}
              </View>
            </View>
          )}
        </TouchableOpacity>

        {/* Custom Edit / Delete Actions */}
        {customConfig && (
          <View style={styles.customFooterRow}>
            <View style={styles.specsRow}>
              <Text style={styles.specItem}>Format: {preset.extension.toUpperCase()}</Text>
              <Text style={styles.specDot}>•</Text>
              <Text style={styles.specItem}>{(preset.sampleRate / 1000).toFixed(1)} kHz</Text>
            </View>

            {!isLocked && (
              <View style={styles.customActionsGroup}>
                <TouchableOpacity
                  style={styles.actionIconBtn}
                  onPress={() => handleOpenEdit(customConfig)}
                  activeOpacity={0.7}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Pencil size={13} color="#A1A1AA" />
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.actionIconBtn, styles.deleteIconBtn]}
                  onPress={() => handleDeletePreset(customConfig.id, customConfig.name)}
                  activeOpacity={0.7}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Trash2 size={13} color="#EF4444" />
                </TouchableOpacity>
              </View>
            )}
          </View>
        )}
      </View>
    );
  };

  return (
    <>
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
                <Text style={styles.heading}>Format Settings</Text>
                <Text style={styles.subheading}>
                  Active Capsule: {selectedDevice?.name || 'Built-in Mic'}
                </Text>
              </View>
              <TouchableOpacity style={styles.closeBtn} onPress={onClose} activeOpacity={0.7}>
                <X size={15} color="#FFFFFF" />
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

              {/* 1. Factory Profiles */}
              <Text style={styles.sectionTitle}>BUILT-IN FACTORY PROFILES</Text>
              {factoryPresetsList.map((p) => renderPresetCard(p))}

              {/* 2. Custom User Profiles */}
              {customPresets.length > 0 && (
                <>
                  <Text style={[styles.sectionTitle, { marginTop: 14 }]}>CUSTOM USER PROFILES</Text>
                  {customPresets.map((c) => renderPresetCard(customPresetToAudioPreset(c), c))}
                </>
              )}

              {/* 3. Add Custom Preset Button */}
              {!isLocked && (
                <TouchableOpacity
                  style={styles.addCustomBtn}
                  onPress={handleOpenCreate}
                  activeOpacity={0.75}
                >
                  <View style={styles.addIconCircle}>
                    <Plus size={14} color="#38BDF8" strokeWidth={2.5} />
                  </View>
                  <Text style={styles.addCustomBtnText}>CREATE CUSTOM PRESET</Text>
                </TouchableOpacity>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>

      <CustomPresetEditorModal
        visible={editorVisible}
        initialPreset={editingTarget}
        selectedDevice={selectedDevice}
        onSave={handleSaveCustomConfig}
        onClose={() => {
          setEditorVisible(false);
          setEditingTarget(null);
        }}
      />
    </>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.78)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 26,
  },
  dialogCard: {
    width: '100%',
    maxWidth: 440,
    maxHeight: '86%',
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
    maxWidth: 580,
    maxHeight: '84%',
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
  presetCard: {
    backgroundColor: '#0A0A0D',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#1E1E24',
    padding: 14,
  },
  presetCardActive: {
    borderColor: '#FFFFFF',
    backgroundColor: '#141418',
  },
  presetCardDisabled: {
    opacity: 0.55,
  },
  presetCardUnsupported: {
    borderColor: 'rgba(245, 158, 11, 0.35)',
    backgroundColor: '#13100A',
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
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  presetLabel: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  unsupportedBadge: {
    backgroundColor: 'rgba(245, 158, 11, 0.15)',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
  },
  unsupportedBadgeText: {
    color: '#F59E0B',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.4,
  },
  badgeRow: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 4,
  },
  badge: {
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  badgeText: {
    color: '#E4E4E7',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  customChip: {
    backgroundColor: 'rgba(56, 189, 248, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.3)',
  },
  customChipText: {
    color: '#38BDF8',
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
  radioOuterDisabled: {
    borderColor: 'rgba(245, 158, 11, 0.4)',
    backgroundColor: '#1E170C',
  },
  presetDescription: {
    color: '#8E8E93',
    fontSize: 12,
    lineHeight: 16,
    marginBottom: 6,
  },
  hardwareWarningBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    backgroundColor: 'rgba(245, 158, 11, 0.09)',
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.28)',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
    marginTop: 6,
  },
  hardwareWarningCol: {
    flex: 1,
    gap: 2,
  },
  hardwareWarningTitle: {
    color: '#F59E0B',
    fontSize: 9.5,
    fontWeight: '800',
    letterSpacing: 0.4,
    marginBottom: 2,
  },
  hardwareWarningText: {
    color: '#FDE68A',
    fontSize: 10.5,
    lineHeight: 14,
    fontWeight: '500',
  },
  specsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingTop: 8,
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
  customFooterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#1A1A22',
    marginTop: 2,
  },
  customActionsGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingTop: 6,
  },
  actionIconBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteIconBtn: {
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
  },
  addCustomBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    borderRadius: 16,
    backgroundColor: 'rgba(56, 189, 248, 0.07)',
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.22)',
    marginTop: 6,
    marginBottom: 8,
  },
  addIconCircle: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: 'rgba(56, 189, 248, 0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  addCustomBtnText: {
    color: '#38BDF8',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.6,
  },
});