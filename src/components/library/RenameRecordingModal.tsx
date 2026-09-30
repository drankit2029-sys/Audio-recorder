// src/components/library/RenameRecordingModal.tsx
import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  TouchableWithoutFeedback,
  Keyboard,
} from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { Check, X, Pencil } from 'lucide-react-native';

import { useKeyboardViewport } from '../../hooks/useKeyboardViewport';
import { useResponsive } from '../../hooks/useResponsive';
import { useAutoFocusInput, useBackPress } from '../../hooks/useOverlayInput';
import {
  MAX_TAKE_NAME_LENGTH,
  sanitizeFileName,
  extractExtension,
} from '../../services/storage/recordingPaths';

interface RenameRecordingModalProps {
  visible: boolean;
  initialName: string;
  fileUri?: string;
  onSave: (name: string) => void;
  onClose: () => void;
}

export const RenameRecordingModal: React.FC<RenameRecordingModalProps> = ({
  visible,
  initialName,
  fileUri,
  onSave,
  onClose,
}) => {
  const { isTablet } = useResponsive();
  const { offset: keyboardOffset, isVisible: isKeyboardVisible } = useKeyboardViewport();

  const [name, setName] = useState(initialName);
  const [isFocused, setIsFocused] = useState(false);
  const inputRef = useRef<TextInput | null>(null);

  useEffect(() => {
    if (visible) setName(initialName);
    else setIsFocused(false);
  }, [visible, initialName]);

  // In-window dialog (not an Android dialog window): the field takes focus
  // and the keyboard opens reliably. See useAutoFocusInput for the details.
  useAutoFocusInput(visible, inputRef);
  useBackPress(visible, () => {
    Keyboard.dismiss();
    onClose();
  });

  const trimmed = name.trim();
  const canSave = trimmed.length > 0;

  const previewFileName =
    fileUri && canSave
      ? `${sanitizeFileName(trimmed)}${extractExtension(fileUri)}`
      : null;

  const handleSave = () => {
    if (!canSave) return;
    Keyboard.dismiss();
    onSave(trimmed);
  };

  const handleCancel = () => {
    Keyboard.dismiss();
    onClose();
  };

  if (!visible) return null;

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
            <TouchableWithoutFeedback onPress={(e) => e.stopPropagation()}>
              <View style={[styles.card, isTablet && styles.cardTablet]}>
                <View style={styles.headerRow}>
                  <View style={styles.iconCircle}>
                    <Pencil size={16} color="#FFFFFF" strokeWidth={2} />
                  </View>
                  <View style={styles.headerTextGroup}>
                    <Text style={styles.title}>Rename Recording</Text>
                    <Text style={styles.subtitle}>Update the label for this take</Text>
                  </View>
                </View>

                <View style={styles.fieldSection}>
                  <View style={styles.labelRow}>
                    <Text style={styles.fieldLabel}>RECORDING NAME</Text>
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
                      placeholder="Take title..."
                      placeholderTextColor="#52525B"
                      autoFocus
                      selectTextOnFocus
                      maxLength={MAX_TAKE_NAME_LENGTH}
                      returnKeyType="done"
                      blurOnSubmit
                      underlineColorAndroid="transparent"
                      onSubmitEditing={handleSave}
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

                  {previewFileName ? (
                    <View style={styles.previewRow}>
                      <Text style={styles.previewLabel}>SAVES AS</Text>
                      <Text style={styles.previewName} numberOfLines={1}>
                        {previewFileName}
                      </Text>
                    </View>
                  ) : null}
                </View>

                <View style={styles.actionRow}>
                  <TouchableOpacity style={styles.cancelBtn} onPress={handleCancel} activeOpacity={0.75}>
                    <Text style={styles.cancelBtnText}>Cancel</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.saveBtn, !canSave && styles.saveBtnDisabled]}
                    onPress={handleSave}
                    disabled={!canSave}
                    activeOpacity={0.8}
                  >
                    <Check size={14} color="#000000" strokeWidth={3} />
                    <Text style={styles.saveBtnText}>Save</Text>
                  </TouchableOpacity>
                </View>

                <Text style={styles.hint}>
                  {isKeyboardVisible
                    ? 'Tap Save or press done to apply'
                    : 'The audio file is renamed to match'}
                </Text>
              </View>
            </TouchableWithoutFeedback>
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
    backgroundColor: 'rgba(0, 0, 0, 0.82)',
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
    maxWidth: 380,
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
  cardTablet: {
    maxWidth: 440,
    padding: 24,
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
  previewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
    paddingHorizontal: 2,
  },
  previewLabel: {
    color: '#52525B',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.6,
  },
  previewName: {
    flex: 1,
    color: '#E4E4E7',
    fontSize: 10.5,
    fontWeight: '600',
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  cancelBtn: {
    flex: 1,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 22,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    borderWidth: 1,
    borderColor: '#24242A',
  },
  cancelBtnText: {
    color: '#8E8E93',
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
  hint: {
    color: '#52525B',
    fontSize: 10,
    fontWeight: '500',
    textAlign: 'center',
    marginTop: 12,
  },
});
