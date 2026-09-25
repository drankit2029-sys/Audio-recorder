// src/components/library/RenameRecordingModal.tsx
import React, { useState, useEffect, useRef } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  TouchableWithoutFeedback,
  Keyboard,
  Platform,
  LayoutAnimation,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Check, X, Pencil } from 'lucide-react-native';
import { useResponsive } from '../../hooks/useResponsive';

interface RenameRecordingModalProps {
  visible: boolean;
  initialName: string;
  onSave: (name: string) => void;
  onClose: () => void;
}

export const RenameRecordingModal: React.FC<RenameRecordingModalProps> = ({
  visible,
  initialName,
  onSave,
  onClose,
}) => {
  const { height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { isTablet } = useResponsive();

  const [name, setName] = useState(initialName);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const inputRef = useRef<TextInput | null>(null);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const showSub = Keyboard.addListener(showEvent, (e) => {
      const kh = e.endCoordinates?.height || 0;
      if (kh > 0) {
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        setKeyboardHeight(kh);
      }
    });

    const hideSub = Keyboard.addListener(hideEvent, () => {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setKeyboardHeight(0);
    });

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  useEffect(() => {
    if (visible) {
      setName(initialName);
      const timer = setTimeout(() => {
        inputRef.current?.focus();
      }, 120);
      return () => clearTimeout(timer);
    } else {
      setKeyboardHeight(0);
    }
  }, [visible, initialName]);

  const handleSave = () => {
    const trimmed = name.trim();
    if (trimmed.length > 0) {
      Keyboard.dismiss();
      onSave(trimmed);
    }
  };

  const handleCancel = () => {
    Keyboard.dismiss();
    onClose();
  };

  const availableHeight =
    keyboardHeight > 0
      ? Math.max(0, windowHeight - keyboardHeight - insets.top)
      : Math.max(0, windowHeight - insets.top - insets.bottom);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={handleCancel}
    >
      <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
        <View style={[styles.backdrop, { paddingTop: insets.top }]}>
          <View style={[styles.centerContainer, { height: availableHeight }]}>
            <TouchableWithoutFeedback onPress={(e) => e.stopPropagation()}>
              <View style={[styles.card, isTablet && styles.cardTablet]}>
                <View style={styles.headerRow}>
                  <View style={styles.iconCircle}>
                    <Pencil size={16} color="#FFFFFF" strokeWidth={2} />
                  </View>
                  <View style={styles.headerTextGroup}>
                    <Text style={styles.title}>Rename Recording</Text>
                    <Text style={styles.subtitle}>Update metadata label for this take</Text>
                  </View>
                </View>

                <View style={styles.inputWrapper}>
                  <Text style={styles.inputLabel}>RECORDING NAME</Text>
                  <View style={styles.inputInnerRow}>
                    <TextInput
                      ref={inputRef}
                      style={styles.input}
                      value={name}
                      onChangeText={setName}
                      placeholder="Take title..."
                      placeholderTextColor="#52525B"
                      selectTextOnFocus
                      returnKeyType="done"
                      onSubmitEditing={handleSave}
                    />
                    {name.length > 0 && (
                      <TouchableOpacity
                        style={styles.clearBtn}
                        onPress={() => setName('')}
                        activeOpacity={0.7}
                      >
                        <X size={13} color="#8E8E93" />
                      </TouchableOpacity>
                    )}
                  </View>
                </View>

                <View style={styles.actionRow}>
                  <TouchableOpacity
                    style={styles.cancelBtn}
                    onPress={handleCancel}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.cancelBtnText}>Cancel</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.saveBtn, name.trim().length === 0 && styles.saveBtnDisabled]}
                    onPress={handleSave}
                    disabled={name.trim().length === 0}
                    activeOpacity={0.8}
                  >
                    <Check size={14} color="#000000" strokeWidth={3} />
                    <Text style={styles.saveBtnText}>Save</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </TouchableWithoutFeedback>
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
    alignItems: 'center',
    justifyContent: 'flex-start',
  },
  centerContainer: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  card: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: '#121215',
    borderRadius: 22,
    borderWidth: 1,
    borderColor: '#222228',
    padding: 20,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.6,
    shadowRadius: 20,
    elevation: 16,
  },
  cardTablet: {
    maxWidth: 440,
    padding: 24,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 16,
  },
  iconCircle: {
    width: 38,
    height: 38,
    borderRadius: 19,
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
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  subtitle: {
    color: '#8E8E93',
    fontSize: 11,
    fontWeight: '500',
    marginTop: 2,
    letterSpacing: 0.2,
  },
  inputWrapper: {
    backgroundColor: '#09090B',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#1C1C22',
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 10,
    marginBottom: 18,
  },
  inputLabel: {
    color: '#71717A',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.8,
    marginBottom: 4,
  },
  inputInnerRow: {
    flexDirection: 'row',
    alignItems: 'center',
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
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
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
    letterSpacing: 0.2,
  },
  saveBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: 42,
    borderRadius: 21,
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
});