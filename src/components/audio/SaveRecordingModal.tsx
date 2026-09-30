// src/components/audio/SaveRecordingModal.tsx
import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  TouchableWithoutFeedback,
  Keyboard,
  ScrollView,
} from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { Trash2, Check, Music2, HardDrive, X, AlertTriangle, CopyPlus, Scissors } from 'lucide-react-native';

import { useKeyboardViewport } from '../../hooks/useKeyboardViewport';
import { useAutoFocusInput, useBackPress } from '../../hooks/useOverlayInput';
import {
  MAX_TAKE_NAME_LENGTH,
  TAKES_FOLDER_NAME,
} from '../../services/storage/recordingPaths';

export type SaveMode = 'new' | 'overwrite';

interface SaveRecordingModalProps {
  visible: boolean;
  defaultName: string;
  durationMs: number;
  sizeBytes: number;
  /** Lossy formats are encoded on save, so their size is an estimate. */
  sizeIsEstimate?: boolean;
  formatBadge: string;
  /**
   * Only for problems the format selector could not have prevented.
   * Never used to report parameter substitution.
   */
  warning?: string;
  /** Set when the studio is editing an existing library take. */
  editOfName?: string | null;
  onSubmit: (chosenName: string, mode: SaveMode) => void;
  onDiscard: () => void;
  /** Close the dialog and go back to the paused take. */
  onKeepEditing: () => void;
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

/**
 * Rendered inside the activity window (not an Android dialog), so the name
 * field can take focus and raise the keyboard reliably.
 */
export const SaveRecordingModal: React.FC<SaveRecordingModalProps> = ({
  visible,
  defaultName,
  durationMs,
  sizeBytes,
  sizeIsEstimate = false,
  formatBadge,
  warning,
  editOfName,
  onSubmit,
  onDiscard,
  onKeepEditing,
}) => {
  const { offset: keyboardOffset, isVisible: isKeyboardVisible } = useKeyboardViewport();

  const [name, setName] = useState(defaultName);
  const [isFocused, setIsFocused] = useState(false);
  const inputRef = useRef<TextInput | null>(null);
  const isEdit = Boolean(editOfName);

  useEffect(() => {
    if (visible) setName(defaultName);
    else setIsFocused(false);
  }, [visible, defaultName]);

  useAutoFocusInput(visible, inputRef);
  useBackPress(visible, () => {
    Keyboard.dismiss();
    onKeepEditing();
  });

  if (!visible) return null;

  const trimmed = name.trim();
  const canSave = trimmed.length > 0;
  const isDirty = canSave && trimmed !== defaultName.trim();

  const submit = (mode: SaveMode) => {
    if (!canSave) return;
    Keyboard.dismiss();
    onSubmit(trimmed, mode);
  };

  const handleDiscard = () => {
    Keyboard.dismiss();
    onDiscard();
  };

  const handleClose = () => {
    Keyboard.dismiss();
    onKeepEditing();
  };

  return (
    <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(140)} style={styles.overlay}>
      <TouchableWithoutFeedback accessible={false} onPress={Keyboard.dismiss}>
        <View style={styles.backdrop}>
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={[
              styles.scrollContent,
              {
                // Rendered inside the app's SafeAreaView, which already
                // clears the system bars; only the keyboard is added here.
                paddingTop: 16,
                paddingBottom: keyboardOffset + 16,
              },
            ]}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            bounces={false}
          >
            <View style={styles.card}>
              <View style={styles.headerRow}>
                <View style={styles.iconCircle}>
                  {isEdit ? (
                    <Scissors size={16} color="#FFFFFF" strokeWidth={2} />
                  ) : (
                    <Music2 size={17} color="#FFFFFF" strokeWidth={2} />
                  )}
                </View>
                <View style={styles.headerTextGroup}>
                  <Text style={styles.title}>{isEdit ? 'Save your edit' : 'Name your take'}</Text>
                  <Text style={styles.subtitle} numberOfLines={1}>
                    {formatDuration(durationMs)} • {sizeIsEstimate ? '≈ ' : ''}
                    {formatSize(sizeBytes)} • {formatBadge}
                  </Text>
                </View>
                <TouchableOpacity
                  style={styles.closeBtn}
                  onPress={handleClose}
                  activeOpacity={0.7}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  accessibilityLabel="Back to the take"
                >
                  <X size={15} color="#A1A1AA" />
                </TouchableOpacity>
              </View>

              {warning ? (
                <View style={styles.warningBox}>
                  <AlertTriangle size={14} color="#F59E0B" strokeWidth={2.4} style={{ marginTop: 1 }} />
                  <View style={styles.warningCol}>
                    <Text style={styles.warningTitle}>CAPTURE NOTICE</Text>
                    <Text style={styles.warningText}>{warning}</Text>
                  </View>
                </View>
              ) : null}

              <View style={styles.fieldSection}>
                <View style={styles.labelRow}>
                  <Text style={styles.fieldLabel}>TAKE NAME</Text>
                  <Text style={styles.counter}>
                    {name.length}/{MAX_TAKE_NAME_LENGTH}
                  </Text>
                </View>

                <View style={[styles.inputShell, isFocused && styles.inputShellFocused]}>
                  <TextInput
                    ref={inputRef}
                    style={styles.input}
                    value={name}
                    onChangeText={setName}
                    onFocus={() => setIsFocused(true)}
                    onBlur={() => setIsFocused(false)}
                    placeholder={defaultName}
                    placeholderTextColor="#52525B"
                    autoFocus
                    selectTextOnFocus
                    maxLength={MAX_TAKE_NAME_LENGTH}
                    returnKeyType="done"
                    blurOnSubmit
                    underlineColorAndroid="transparent"
                    onSubmitEditing={() => submit(isEdit ? 'overwrite' : 'new')}
                  />
                  {name.length > 0 ? (
                    <TouchableOpacity
                      style={styles.clearBtn}
                      onPress={() => setName('')}
                      activeOpacity={0.7}
                      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    >
                      <X size={13} color="#8E8E93" />
                    </TouchableOpacity>
                  ) : null}
                </View>

                <View style={styles.storageRow}>
                  <HardDrive size={11} color="#A1A1AA" />
                  <Text style={styles.storageText} numberOfLines={1}>
                    {isEdit
                      ? `Editing "${editOfName}" in ${TAKES_FOLDER_NAME}/`
                      : `Stored in ${TAKES_FOLDER_NAME}/ on this device`}
                  </Text>
                </View>
              </View>

              {isEdit ? (
                <>
                  <View style={styles.actionRow}>
                    <TouchableOpacity
                      style={[styles.secondaryBtn, !canSave && styles.saveBtnDisabled]}
                      onPress={() => submit('new')}
                      disabled={!canSave}
                      activeOpacity={0.8}
                    >
                      <CopyPlus size={14} color="#FFFFFF" strokeWidth={2.2} />
                      <Text style={styles.secondaryBtnText}>Save as new</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={[styles.saveBtn, !canSave && styles.saveBtnDisabled]}
                      onPress={() => submit('overwrite')}
                      disabled={!canSave}
                      activeOpacity={0.8}
                    >
                      <Check size={14} color="#000000" strokeWidth={3} />
                      <Text style={styles.saveBtnText}>Save changes</Text>
                    </TouchableOpacity>
                  </View>
                  <TouchableOpacity style={styles.discardLink} onPress={handleDiscard} activeOpacity={0.7}>
                    <Trash2 size={12} color="#EF4444" strokeWidth={2.2} />
                    <Text style={styles.discardLinkText}>Discard changes</Text>
                  </TouchableOpacity>
                </>
              ) : (
                <View style={styles.actionRow}>
                  <TouchableOpacity style={styles.discardBtn} onPress={handleDiscard} activeOpacity={0.75}>
                    <Trash2 size={14} color="#EF4444" strokeWidth={2.2} />
                    <Text style={styles.discardBtnText}>Discard</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.saveBtn, !canSave && styles.saveBtnDisabled]}
                    onPress={() => submit('new')}
                    disabled={!canSave}
                    activeOpacity={0.8}
                  >
                    <Check size={14} color="#000000" strokeWidth={3} />
                    <Text style={styles.saveBtnText}>{isDirty ? 'Save' : 'Save take'}</Text>
                  </TouchableOpacity>
                </View>
              )}

              <Text style={styles.hint}>
                {isEdit
                  ? 'Save changes replaces the original take · Save as new keeps both'
                  : isKeyboardVisible
                  ? 'Tap Save or press done to keep this take'
                  : 'Discard permanently deletes the audio file'}
              </Text>
            </View>
          </ScrollView>
        </View>
      </TouchableWithoutFeedback>
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFill,
    zIndex: 25000,
    elevation: 130,
  },
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
  headerTextGroup: {
    flex: 1,
  },
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
  closeBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#1C1C22',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  warningBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    backgroundColor: 'rgba(245, 158, 11, 0.09)',
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.28)',
    borderRadius: 12,
    padding: 10,
    marginBottom: 18,
  },
  warningCol: {
    flex: 1,
    gap: 3,
  },
  warningTitle: {
    color: '#F59E0B',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.6,
  },
  warningText: {
    color: '#FDE68A',
    fontSize: 11,
    lineHeight: 15,
    fontWeight: '500',
  },
  fieldSection: {
    marginBottom: 20,
  },
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
    borderColor: '#FFFFFF',
    backgroundColor: '#0D0D0F',
    shadowColor: '#FFFFFF',
    shadowOpacity: 0.22,
    shadowRadius: 10,
    elevation: 6,
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
  secondaryBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#1E1E24',
    borderWidth: 1,
    borderColor: '#2A2A32',
  },
  secondaryBtnText: {
    color: '#FFFFFF',
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
  saveBtnDisabled: {
    opacity: 0.4,
  },
  saveBtnText: {
    color: '#000000',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  discardLink: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    alignSelf: 'center',
    marginTop: 14,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  discardLinkText: {
    color: '#EF4444',
    fontSize: 12,
    fontWeight: '600',
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
