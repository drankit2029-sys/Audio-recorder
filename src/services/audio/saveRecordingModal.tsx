import React, { useEffect, useRef, useState } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  TouchableWithoutFeedback,
  Keyboard,
  ScrollView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Trash2, Check, Music2, HardDrive, X } from 'lucide-react-native';

import { useKeyboardViewport } from '../../hooks/useKeyboardViewport';
import {
  MAX_TAKE_NAME_LENGTH,
  TAKES_FOLDER_NAME,
} from '../../services/storage/recordingPaths';

interface SaveRecordingModalProps {
  visible: boolean;
  defaultName: string;
  durationMs: number;
  sizeBytes: number;
  formatBadge: string;
  onSubmit: (chosenName: string) => void;
  onDiscard: () => void;
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

export const SaveRecordingModal: React.FC<SaveRecordingModalProps> = ({
  visible,
  defaultName,
  durationMs,
  sizeBytes,
  formatBadge,
  onSubmit,
  onDiscard,
}) => {
  const insets = useSafeAreaInsets();
  const { offset: keyboardOffset, isVisible: isKeyboardVisible } = useKeyboardViewport();

  const [name, setName] = useState(defaultName);
  const [isFocused, setIsFocused] = useState(false);
  const inputRef = useRef<TextInput | null>(null);
  const focusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (focusTimerRef.current) clearTimeout(focusTimerRef.current);

    if (!visible) {
      setIsFocused(false);
      return;
    }

    setName(defaultName);
    focusTimerRef.current = setTimeout(() => {
      inputRef.current?.focus();
    }, 240);

    return () => {
      if (focusTimerRef.current) clearTimeout(focusTimerRef.current);
    };
  }, [visible, defaultName]);

  const trimmed = name.trim();
  const canSave = trimmed.length > 0;
  const isDirty = trimmed.length > 0 && trimmed !== defaultName.trim();

  const handleSave = () => {
    if (!canSave) return;
    Keyboard.dismiss();
    onSubmit(trimmed);
  };

  const handleDiscard = () => {
    Keyboard.dismiss();
    onDiscard();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={handleDiscard}
    >
      <TouchableWithoutFeedback accessible={false} onPress={Keyboard.dismiss}>
        <View style={styles.backdrop}>
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={[
              styles.scrollContent,
              {
                paddingTop: insets.top + 16,
                paddingBottom: insets.bottom + keyboardOffset + 16,
              },
            ]}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            showsVerticalScrollIndicator={false}
            bounces={false}
          >
            <View style={styles.card}>
              <View style={styles.headerRow}>
                <View style={styles.iconCircle}>
                  <Music2 size={17} color="#FFFFFF" strokeWidth={2} />
                </View>
                <View style={styles.headerTextGroup}>
                  <Text style={styles.title}>Name your take</Text>
                  <Text style={styles.subtitle} numberOfLines={1}>
                    {formatDuration(durationMs)} • {formatSize(sizeBytes)} • {formatBadge}
                  </Text>
                </View>
              </View>

              <View style={styles.fieldSection}>
                <View style={styles.labelRow}>
                  <Text style={styles.fieldLabel}>TAKE NAME</Text>
                  <Text style={styles.counter}>
                    {name.length}/{MAX_TAKE_NAME_LENGTH}
                  </Text>
                </View>

                <View
                  style={[
                    styles.inputShell,
                    isFocused && styles.inputShellFocused,
                  ]}
                >
                  <TextInput
                    ref={inputRef}
                    style={styles.input}
                    value={name}
                    onChangeText={setName}
                    onFocus={() => setIsFocused(true)}
                    onBlur={() => setIsFocused(false)}
                    placeholder={defaultName}
                    placeholderTextColor="#52525B"
                    selectTextOnFocus
                    maxLength={MAX_TAKE_NAME_LENGTH}
                    returnKeyType="done"
                    blurOnSubmit
                    underlineColorAndroid="transparent"
                    onSubmitEditing={handleSave}
                  />
                  {name.length > 0 && (
                    <TouchableOpacity
                      style={styles.clearBtn}
                      onPress={() => setName('')}
                      activeOpacity={0.7}
                      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    >
                      <X size={13} color="#8E8E93" />
                    </TouchableOpacity>
                  )}
                </View>

                <View style={styles.storageRow}>
                  <HardDrive size={11} color="#34D399" />
                  <Text style={styles.storageText} numberOfLines={1}>
                    Already stored in {TAKES_FOLDER_NAME}/ on this device
                  </Text>
                </View>
              </View>

              <View style={styles.actionRow}>
                <TouchableOpacity
                  style={styles.discardBtn}
                  onPress={handleDiscard}
                  activeOpacity={0.75}
                >
                  <Trash2 size={14} color="#EF4444" strokeWidth={2.2} />
                  <Text style={styles.discardBtnText}>Discard</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.saveBtn, !canSave && styles.saveBtnDisabled]}
                  onPress={handleSave}
                  disabled={!canSave}
                  activeOpacity={0.8}
                >
                  <Check size={14} color="#000000" strokeWidth={3} />
                  <Text style={styles.saveBtnText}>
                    {isDirty ? 'Save' : 'Save take'}
                  </Text>
                </TouchableOpacity>
              </View>

              {isKeyboardVisible ? (
                <Text style={styles.hint}>Tap Save or press done to keep this take</Text>
              ) : (
                <Text style={styles.hint}>
                  Discard permanently deletes the audio file
                </Text>
              )}
            </View>
          </ScrollView>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.86)',
  },
  scroll: {
    flex: 1,
    width: '100%',
  },
  scrollContent: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 22,
  },
  card: {
    width: '100%',
    maxWidth: 400,
    backgroundColor: '#121215',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: '#222228',
    padding: 20,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.6,
    shadowRadius: 20,
    elevation: 18,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 18,
  },
  iconCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#1C1C22',
    borderWidth: 1,
    borderColor: '#2A2A32',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTextGroup: { flex: 1 },
  title: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  subtitle: {
    color: '#8E8E93',
    fontSize: 11,
    fontWeight: '500',
    marginTop: 3,
    letterSpacing: 0.2,
  },
  fieldSection: { marginBottom: 20 },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
    paddingHorizontal: 2,
  },
  fieldLabel: {
    color: '#71717A',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.8,
  },
  counter: {
    color: '#52525B',
    fontSize: 9,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  inputShell: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#09090B',
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: '#1C1C22',
    paddingHorizontal: 14,
    height: 48,
  },
  inputShellFocused: {
    borderColor: '#38BDF8',
    backgroundColor: '#0A0E14',
  },
  input: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '500',
    padding: 0,
  },
  clearBtn: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#18181D',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 8,
  },
  storageRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 8,
    paddingHorizontal: 2,
  },
  storageText: {
    flex: 1,
    color: '#52525B',
    fontSize: 10.5,
    fontWeight: '500',
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
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
    letterSpacing: 0.2,
  },
  saveBtn: {
    flex: 1.15,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#FFFFFF',
  },
  saveBtnDisabled: { opacity: 0.4 },
  saveBtnText: {
    color: '#000000',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  hint: {
    color: '#52525B',
    fontSize: 10,
    fontWeight: '500',
    textAlign: 'center',
    marginTop: 12,
  },
});
