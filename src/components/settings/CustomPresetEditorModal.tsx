// src/components/settings/CustomPresetEditorModal.tsx
import React, { useState, useEffect } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  useWindowDimensions,
  TouchableWithoutFeedback,
  Keyboard,
  LayoutAnimation,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X, Check, Disc, HardDrive, Radio, Layers, AlertTriangle } from 'lucide-react-native';

import { CustomPresetConfig, AudioFormatType } from '../../services/audio/types';
import { AudioInputDevice } from '../../../modules/audio-hardware-router/src';
import { useResponsive } from '../../hooks/useResponsive';
import { useKeyboardViewport } from '../../hooks/useKeyboardViewport';

interface CustomPresetEditorModalProps {
  visible: boolean;
  initialPreset?: CustomPresetConfig | null;
  selectedDevice: AudioInputDevice | null;
  onSave: (preset: CustomPresetConfig) => void;
  onClose: () => void;
}

const ALL_SAMPLE_RATES = [
  8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000, 88200, 96000, 192000,
];

const BIT_DEPTHS = [8, 16, 24, 32];
const COMPRESSED_BITRATES = [32, 64, 96, 128, 160, 192, 256, 320, 512];

const FORMAT_OPTIONS: { id: AudioFormatType; label: string; tag: string }[] = [
  { id: 'wav', label: 'WAV', tag: 'Uncompressed RIFF' },
  { id: 'aac', label: 'AAC', tag: 'MPEG-4 LC' },
  { id: 'aac_adts', label: 'AAC-ADTS', tag: 'Raw AAC stream' },
  { id: 'he_aac', label: 'HE-AAC', tag: 'High efficiency' },
  { id: 'amr_wb', label: 'AMR-WB', tag: '16 kHz voice' },
  { id: 'amr_nb', label: 'AMR-NB', tag: '8 kHz voice' },
];

export const CustomPresetEditorModal: React.FC<CustomPresetEditorModalProps> = ({
  visible,
  initialPreset,
  selectedDevice,
  onSave,
  onClose,
}) => {
  const { height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { isTablet } = useResponsive();
  const { offset: keyboardOffset, isVisible: keyboardVisible } = useKeyboardViewport();

  const isEditing = Boolean(initialPreset);

  const [name, setName] = useState('');
  const [format, setFormat] = useState<AudioFormatType>('wav');

  const [sampleRateStr, setSampleRateStr] = useState('48000');
  const [channelsStr, setChannelsStr] = useState('1');
  const [bitDepthStr, setBitDepthStr] = useState('16');
  const [bitRateKbpsStr, setBitRateKbpsStr] = useState('256');
  const [description, setDescription] = useState('');

  useEffect(() => {
    if (visible) {
      if (initialPreset) {
        setName(initialPreset.name);
        setFormat(initialPreset.format);
        setSampleRateStr(String(initialPreset.sampleRate));
        setChannelsStr(String(initialPreset.channels));
        setBitDepthStr(String(initialPreset.bitDepth ?? 16));
        setBitRateKbpsStr(String(Math.round((initialPreset.bitRate ?? 256000) / 1000)));
        setDescription(initialPreset.description ?? '');
      } else {
        setName('');
        setFormat('wav');
        setSampleRateStr('48000');
        setChannelsStr('1');
        setBitDepthStr('16');
        setBitRateKbpsStr('256');
        setDescription('');
      }
    }
  }, [visible, initialPreset]);

  const parsedRate = Math.max(1000, parseInt(sampleRateStr, 10) || 48000);
  const parsedChannels = Math.max(1, parseInt(channelsStr, 10) || 1);
  const parsedBitDepth = Math.max(8, parseInt(bitDepthStr, 10) || 16);
  const parsedBitRateKbps = Math.max(16, parseInt(bitRateKbpsStr, 10) || 256);
  const parsedBitRateBps = parsedBitRateKbps * 1000;

  const isCompressed = format !== 'wav';

  const isUsb =
    selectedDevice?.type === 'usb_device' ||
    selectedDevice?.type === 'usb_headset' ||
    selectedDevice?.type === 'usb_accessory';

  const effectiveChannels: 1 | 2 = parsedChannels === 2 ? 2 : 1;
  const channelsWereClamped = parsedChannels !== effectiveChannels;

  const effectiveBitDepth: 16 | 32 = parsedBitDepth === 32 ? 32 : 16;
  const bitDepthWasCoerced = parsedBitDepth !== effectiveBitDepth;

  const checkRateSupported = (rate: number): boolean => {
    if (format === 'amr_nb') return rate === 8000;
    if (format === 'amr_wb') return rate === 16000;
    if (rate > 48000 && !isUsb) return false;
    if (selectedDevice?.sampleRates && selectedDevice.sampleRates.length > 0) {
      return selectedDevice.sampleRates.includes(rate);
    }
    return rate <= 48000;
  };

  const checkChannelsSupported = (ch: number): boolean => {
    if (format === 'amr_nb' || format === 'amr_wb') return ch === 1;
    if (selectedDevice?.channelCounts && selectedDevice.channelCounts.length > 0) {
      return selectedDevice.channelCounts.includes(ch);
    }
    return ch === 1;
  };

  const checkDepthSupported = (depth: number): boolean => {
    if (isCompressed) return true;
    if (depth > 16 && !isUsb) return false;
    return true;
  };

  const deviceName = selectedDevice?.name || 'Selected Mic';

  const currentWarnings: string[] = [];

  if (!checkRateSupported(parsedRate)) {
    if (parsedRate > 48000 && !isUsb) {
      currentWarnings.push(
        `• ${(parsedRate / 1000).toFixed(1)} kHz high-res capture requires an external USB Audio Interface. "${deviceName}" is clocked to 48.0 kHz.`
      );
    } else {
      currentWarnings.push(
        `• "${deviceName}" does not report native hardware clocking at ${(parsedRate / 1000).toFixed(1)} kHz. Android will resample in software.`
      );
    }
  }

  if (!checkChannelsSupported(parsedChannels)) {
    currentWarnings.push(
      `• "${deviceName}" only reports single-channel Mono support. Capturing at ${parsedChannels} channels may fail or duplicate channels.`
    );
  }

  if (!isCompressed && bitDepthWasCoerced) {
    currentWarnings.push(
      parsedBitDepth < 16
        ? `• The Android WAV pipeline does not write 8-bit PCM. This profile will record as 16-bit.`
        : `• The Android WAV pipeline does not write 24-bit PCM. This profile will record as 16-bit.`
    );
  }

  if (!isCompressed && parsedBitDepth > 16 && !isUsb) {
    currentWarnings.push(
      `• ${parsedBitDepth}-bit PCM requires a class-compliant USB Audio Interface. Built-in Android microphones are limited to 16-bit integer PCM.`
    );
  }

  if (format === 'amr_nb' && (parsedRate !== 8000 || parsedChannels !== 1)) {
    currentWarnings.push('• AMR-NB is strictly constrained to 8.0 kHz Mono voice telephony.');
  } else if (format === 'amr_wb' && (parsedRate !== 16000 || parsedChannels !== 1)) {
    currentWarnings.push('• AMR-WB is strictly constrained to 16.0 kHz Mono voice telephony.');
  }

  if (channelsWereClamped && format === 'wav') {
    currentWarnings.push(
      `• The RIFF writer only supports Mono or Stereo. This profile will record as ${effectiveChannels === 2 ? 'Stereo' : 'Mono'}.`
    );
  }

  const calculateRateEstimate = () => {
    if (!isCompressed) {
      const bytesPerSample = effectiveBitDepth / 8;
      const bytesPerSec = parsedRate * bytesPerSample * effectiveChannels;
      const mbPerMin = (bytesPerSec * 60) / (1024 * 1024);
      return {
        bandwidthStr: `${((bytesPerSec * 8) / 1000).toFixed(0)} kbps`,
        sizePerMinStr: `~${mbPerMin.toFixed(1)} MB/min`,
      };
    }
    const mbPerMin = ((parsedBitRateBps / 8) * 60) / (1024 * 1024);
    return {
      bandwidthStr: `${parsedBitRateKbps} kbps`,
      sizePerMinStr: `~${mbPerMin.toFixed(1)} MB/min`,
    };
  };

  const { bandwidthStr, sizePerMinStr } = calculateRateEstimate();

  const handleSave = () => {
    const formatName = format.toUpperCase();
    const chLabel = effectiveChannels === 1 ? 'Mono' : 'Stereo';
    const defaultName = `${formatName} ${(parsedRate / 1000).toFixed(1)}k ${chLabel}`;

    const config: CustomPresetConfig = {
      id: initialPreset?.id || `custom_${Date.now()}`,
      name: name.trim().length > 0 ? name.trim() : defaultName,
      format,
      sampleRate: parsedRate,
      channels: effectiveChannels,
      bitDepth: !isCompressed ? effectiveBitDepth : undefined,
      bitRate: isCompressed ? parsedBitRateBps : undefined,
      description: description.trim().length > 0 ? description.trim() : undefined,
      createdAt: initialPreset?.createdAt || Date.now(),
    };

    Keyboard.dismiss();
    onSave(config);
  };

  return (
    <Modal
      visible={visible}
      animationType="fade"
      transparent
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
        <View style={styles.backdrop}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onClose} />

          <View
            style={[
              styles.dialogCard,
              isTablet && styles.dialogCardTablet,
              keyboardVisible && {
                maxHeight: windowHeight - keyboardOffset - insets.top - insets.bottom - 32,
              },
            ]}
          >
            <View style={styles.topBar}>
              <View style={styles.topBarTextCol}>
                <Text style={styles.heading}>
                  {isEditing ? 'Edit Profile' : 'New Format Profile'}
                </Text>
                <Text style={styles.subheading} numberOfLines={1}>
                  Android audio hardware & encoder parameters
                </Text>
              </View>
              <TouchableOpacity style={styles.closeBtn} onPress={onClose} activeOpacity={0.7}>
                <X size={15} color="#FFFFFF" />
              </TouchableOpacity>
            </View>

            <ScrollView
              contentContainerStyle={styles.scrollContent}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
            >
              <View style={styles.fieldSection}>
                <Text style={styles.sectionLabel}>PROFILE NAME</Text>
                <View style={styles.inputWrapper}>
                  <TextInput
                    style={styles.textInput}
                    value={name}
                    onChangeText={setName}
                    placeholder="e.g. Master Studio 96k"
                    placeholderTextColor="#52525B"
                    returnKeyType="done"
                    blurOnSubmit
                    underlineColorAndroid="transparent"
                  />
                  {name.length > 0 ? (
                    <TouchableOpacity
                      style={styles.clearBtn}
                      onPress={() => setName('')}
                      activeOpacity={0.7}
                    >
                      <X size={12} color="#8E8E93" />
                    </TouchableOpacity>
                  ) : null}
                </View>
              </View>

              <View style={styles.specCard}>
                <View style={styles.specCardTop}>
                  <View style={styles.specPill}>
                    <Text style={styles.specPillText}>{format.toUpperCase()}</Text>
                  </View>
                  <Text style={styles.specCardName} numberOfLines={1}>
                    {name.trim() || 'Custom Architecture'}
                  </Text>
                </View>
                <View style={styles.specDivider} />
                <View style={styles.specStatsRow}>
                  <View style={styles.specStatItem}>
                    <HardDrive size={11} color="#71717A" />
                    <Text style={styles.specStatVal}>{sizePerMinStr}</Text>
                  </View>
                  <View style={styles.specStatItem}>
                    <Radio size={11} color="#71717A" />
                    <Text style={styles.specStatVal}>{bandwidthStr}</Text>
                  </View>
                  <View style={styles.specStatItem}>
                    <Layers size={11} color="#71717A" />
                    <Text style={styles.specStatVal}>
                      {(parsedRate / 1000).toFixed(1)}kHz • {effectiveChannels}Ch
                    </Text>
                  </View>
                </View>
              </View>

              <View style={styles.fieldSection}>
                <Text style={styles.sectionLabel}>ENCODING ARCHITECTURE</Text>
                <View style={styles.formatGrid}>
                  {FORMAT_OPTIONS.map((opt) => (
                    <TouchableOpacity
                      key={opt.id}
                      style={[styles.formatBtn, format === opt.id && styles.formatBtnActive]}
                      onPress={() => {
                        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                        setFormat(opt.id);
                        if (opt.id === 'amr_nb') {
                          setSampleRateStr('8000');
                          setChannelsStr('1');
                        } else if (opt.id === 'amr_wb') {
                          setSampleRateStr('16000');
                          setChannelsStr('1');
                        } else if (opt.id === 'wav') {
                          setBitDepthStr('16');
                        }
                      }}
                      activeOpacity={0.7}
                    >
                      <View style={styles.formatHeader}>
                        <Disc size={12} color={format === opt.id ? '#000000' : '#8E8E93'} />
                        <Text
                          style={[styles.formatBtnText, format === opt.id && styles.formatBtnTextActive]}
                        >
                          {opt.label}
                        </Text>
                      </View>
                      <Text
                        style={[styles.formatTagText, format === opt.id && styles.formatTagTextActive]}
                      >
                        {opt.tag}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>

              <View style={styles.fieldSection}>
                <View style={styles.labelWithInputRow}>
                  <Text style={styles.sectionLabel}>SAMPLING RATE (HZ)</Text>
                  <View style={styles.inlineInputBox}>
                    <TextInput
                      style={styles.inlineNumericInput}
                      value={sampleRateStr}
                      onChangeText={setSampleRateStr}
                      keyboardType="number-pad"
                      maxLength={7}
                      underlineColorAndroid="transparent"
                    />
                    <Text style={styles.unitSuffix}>Hz</Text>
                  </View>
                </View>

                <View style={styles.quickPillsRow}>
                  {ALL_SAMPLE_RATES.map((rate) => {
                    const isSupported = checkRateSupported(rate);
                    const isSelected = parsedRate === rate;

                    return (
                      <TouchableOpacity
                        key={rate}
                        style={[
                          styles.quickPill,
                          isSelected && styles.quickPillActive,
                          !isSupported && styles.quickPillUnsupported,
                        ]}
                        onPress={() => setSampleRateStr(String(rate))}
                        activeOpacity={0.7}
                      >
                        <Text
                          style={[
                            styles.quickPillText,
                            isSelected && styles.quickPillTextActive,
                            !isSupported && styles.quickPillTextUnsupported,
                          ]}
                        >
                          {rate >= 1000
                            ? `${(rate / 1000).toFixed(rate % 1000 === 0 ? 0 : 1)}k`
                            : `${rate}Hz`}
                          {!isSupported ? ' •' : ''}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>

              <View style={styles.fieldSection}>
                <View style={styles.labelWithInputRow}>
                  <Text style={styles.sectionLabel}>CHANNELS (COUNT)</Text>
                  <View style={styles.inlineInputBox}>
                    <TextInput
                      style={styles.inlineNumericInput}
                      value={channelsStr}
                      onChangeText={setChannelsStr}
                      keyboardType="number-pad"
                      maxLength={2}
                      underlineColorAndroid="transparent"
                    />
                    <Text style={styles.unitSuffix}>Ch</Text>
                  </View>
                </View>

                <View style={styles.quickPillsRow}>
                  {[1, 2, 4].map((ch) => {
                    const isSupported = checkChannelsSupported(ch);
                    const isSelected = parsedChannels === ch;
                    const chLabel =
                      ch === 1 ? '1 Ch (Mono)' : ch === 2 ? '2 Ch (Stereo)' : `${ch} Ch (Multi)`;

                    return (
                      <TouchableOpacity
                        key={ch}
                        style={[
                          styles.quickPill,
                          styles.quickPillFlex,
                          isSelected && styles.quickPillActive,
                          !isSupported && styles.quickPillUnsupported,
                        ]}
                        onPress={() => setChannelsStr(String(ch))}
                        activeOpacity={0.7}
                      >
                        <Text
                          style={[
                            styles.quickPillText,
                            isSelected && styles.quickPillTextActive,
                            !isSupported && styles.quickPillTextUnsupported,
                          ]}
                        >
                          {chLabel}
                          {!isSupported ? ' •' : ''}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>

              {!isCompressed ? (
                <View style={styles.fieldSection}>
                  <View style={styles.labelWithInputRow}>
                    <Text style={styles.sectionLabel}>PCM BIT DEPTH (BITS)</Text>
                    <View style={styles.inlineInputBox}>
                      <TextInput
                        style={styles.inlineNumericInput}
                        value={bitDepthStr}
                        onChangeText={setBitDepthStr}
                        keyboardType="number-pad"
                        maxLength={2}
                        underlineColorAndroid="transparent"
                      />
                      <Text style={styles.unitSuffix}>bit</Text>
                    </View>
                  </View>

                  <View style={styles.quickPillsRow}>
                    {BIT_DEPTHS.map((depth) => {
                      const isSupported = checkDepthSupported(depth);
                      const isSelected = parsedBitDepth === depth;

                      return (
                        <TouchableOpacity
                          key={depth}
                          style={[
                            styles.quickPill,
                            styles.quickPillFlex,
                            isSelected && styles.quickPillActive,
                            !isSupported && styles.quickPillUnsupported,
                          ]}
                          onPress={() => setBitDepthStr(String(depth))}
                          activeOpacity={0.7}
                        >
                          <Text
                            style={[
                              styles.quickPillText,
                              isSelected && styles.quickPillTextActive,
                              !isSupported && styles.quickPillTextUnsupported,
                            ]}
                          >
                            {depth}-bit
                            {!isSupported ? ' •' : ''}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </View>
              ) : (
                <View style={styles.fieldSection}>
                  <View style={styles.labelWithInputRow}>
                    <Text style={styles.sectionLabel}>COMPRESSION BITRATE (KBPS)</Text>
                    <View style={styles.inlineInputBox}>
                      <TextInput
                        style={styles.inlineNumericInput}
                        value={bitRateKbpsStr}
                        onChangeText={setBitRateKbpsStr}
                        keyboardType="number-pad"
                        maxLength={4}
                        underlineColorAndroid="transparent"
                      />
                      <Text style={styles.unitSuffix}>kbps</Text>
                    </View>
                  </View>

                  <View style={styles.quickPillsRow}>
                    {COMPRESSED_BITRATES.map((kbps) => {
                      const isSelected = parsedBitRateKbps === kbps;
                      return (
                        <TouchableOpacity
                          key={kbps}
                          style={[styles.quickPill, isSelected && styles.quickPillActive]}
                          onPress={() => setBitRateKbpsStr(String(kbps))}
                          activeOpacity={0.7}
                        >
                          <Text style={[styles.quickPillText, isSelected && styles.quickPillTextActive]}>
                            {kbps}k
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </View>
              )}

              {currentWarnings.length > 0 ? (
                <View style={styles.hardwareAdvisoryBox}>
                  <View style={styles.warningHeader}>
                    <AlertTriangle size={13} color="#F59E0B" />
                    <Text style={styles.warningTitle}>CAPSULE COMPATIBILITY NOTICE</Text>
                  </View>
                  {currentWarnings.map((warn, i) => (
                    <Text key={i} style={styles.warningDesc}>
                      {warn}
                    </Text>
                  ))}
                  <Text style={styles.warningFooterNote}>
                    You can still save this preset. It will be disabled in the format selector whenever an
                    incompatible microphone is active.
                  </Text>
                </View>
              ) : null}

              <View style={styles.fieldSection}>
                <Text style={styles.sectionLabel}>ENGINEERING NOTES (OPTIONAL)</Text>
                <View style={styles.notesWrapper}>
                  <TextInput
                    style={styles.notesInput}
                    value={description}
                    onChangeText={setDescription}
                    placeholder="e.g. Master uncompressed capture for external DAW post-production."
                    placeholderTextColor="#52525B"
                    multiline
                    underlineColorAndroid="transparent"
                  />
                </View>
              </View>
            </ScrollView>

            <View style={styles.bottomBar}>
              <TouchableOpacity style={styles.cancelBtn} onPress={onClose} activeOpacity={0.7}>
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.saveBtn} onPress={handleSave} activeOpacity={0.8}>
                <Check size={14} color="#000000" strokeWidth={3} />
                <Text style={styles.saveBtnText}>
                  {isEditing ? 'Save Changes' : 'Create Preset'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.82)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 24,
  },
  dialogCard: {
    width: '100%',
    maxWidth: 440,
    maxHeight: '88%',
    backgroundColor: '#121215',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: '#24242A',
    overflow: 'hidden',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.65,
    shadowRadius: 20,
    elevation: 20,
  },
  dialogCardTablet: {
    maxWidth: 560,
    maxHeight: '85%',
  },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#1E1E24',
  },
  topBarTextCol: {
    flex: 1,
    marginRight: 10,
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
  scrollContent: {
    padding: 16,
    gap: 14,
  },
  fieldSection: {
    gap: 6,
  },
  sectionLabel: {
    color: '#71717A',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.6,
  },
  labelWithInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  inlineInputBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#09090C',
    borderWidth: 1,
    borderColor: '#24242C',
    borderRadius: 8,
    paddingHorizontal: 8,
    height: 28,
  },
  inlineNumericInput: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
    padding: 0,
    fontVariant: ['tabular-nums'],
    minWidth: 46,
    textAlign: 'right',
  },
  unitSuffix: {
    color: '#71717A',
    fontSize: 10,
    fontWeight: '600',
    marginLeft: 4,
  },
  inputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#09090C',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#1E1E24',
    paddingHorizontal: 12,
    height: 44,
  },
  textInput: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '500',
    padding: 0,
  },
  clearBtn: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#1C1C22',
    alignItems: 'center',
    justifyContent: 'center',
  },
  specCard: {
    backgroundColor: '#0A0A0D',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#1E1E26',
    padding: 12,
  },
  specCardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  specPill: {
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  specPillText: {
    color: '#000000',
    fontSize: 10,
    fontWeight: '800',
  },
  specCardName: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
    flex: 1,
  },
  specDivider: {
    height: 1,
    backgroundColor: '#1C1C24',
    marginVertical: 10,
  },
  specStatsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  specStatItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  specStatVal: {
    color: '#A1A1AA',
    fontSize: 10,
    fontWeight: '500',
    fontVariant: ['tabular-nums'],
  },
  formatGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  formatBtn: {
    flexBasis: '48%',
    flexGrow: 1,
    paddingVertical: 9,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    gap: 2,
  },
  formatBtnActive: {
    backgroundColor: '#FFFFFF',
    borderColor: '#FFFFFF',
  },
  formatHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  formatBtnText: {
    color: '#E4E4E7',
    fontSize: 12,
    fontWeight: '700',
  },
  formatBtnTextActive: {
    color: '#000000',
  },
  formatTagText: {
    color: '#71717A',
    fontSize: 9,
    fontWeight: '500',
  },
  formatTagTextActive: {
    color: '#3F3F46',
  },
  quickPillsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  quickPill: {
    paddingVertical: 6,
    paddingHorizontal: 9,
    borderRadius: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickPillFlex: {
    flex: 1,
  },
  quickPillActive: {
    backgroundColor: '#FFFFFF',
    borderColor: '#FFFFFF',
    shadowColor: '#FFFFFF',
    shadowOpacity: 0.3,
    shadowRadius: 9,
    elevation: 6,
  },
  quickPillUnsupported: {
    backgroundColor: 'rgba(255, 255, 255, 0.015)',
    borderColor: 'rgba(245, 158, 11, 0.15)',
    opacity: 0.42,
  },
  quickPillText: {
    color: '#A1A1AA',
    fontSize: 11,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  quickPillTextActive: {
    color: '#000000',
    fontWeight: '700',
  },
  quickPillTextUnsupported: {
    color: '#71717A',
  },
  hardwareAdvisoryBox: {
    backgroundColor: 'rgba(245, 158, 11, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.24)',
    borderRadius: 12,
    padding: 10,
    gap: 4,
  },
  warningHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 2,
  },
  warningTitle: {
    color: '#F59E0B',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  warningDesc: {
    color: '#FDE68A',
    fontSize: 10.5,
    lineHeight: 15,
  },
  warningFooterNote: {
    color: '#92400E',
    fontSize: 9.5,
    fontStyle: 'italic',
    marginTop: 4,
  },
  notesWrapper: {
    backgroundColor: '#09090C',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#1E1E24',
    paddingHorizontal: 12,
    paddingVertical: 8,
    minHeight: 54,
  },
  notesInput: {
    color: '#FFFFFF',
    fontSize: 12,
    padding: 0,
    textAlignVertical: 'top',
  },
  bottomBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderTopWidth: 1,
    borderTopColor: '#1E1E24',
    backgroundColor: '#0F0F13',
  },
  cancelBtn: {
    flex: 1,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 21,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
  },
  cancelBtnText: {
    color: '#8E8E93',
    fontSize: 13,
    fontWeight: '600',
  },
  saveBtn: {
    flex: 1.4,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#FFFFFF',
  },
  saveBtnText: {
    color: '#000000',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
});
