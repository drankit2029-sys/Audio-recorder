// src/components/audio/SaveRecordingModal.tsx
import React, { useState, useEffect, useRef } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  TouchableWithoutFeedback,
  Keyboard,
} from 'react-native';
import { Trash2, Check, Music2 } from 'lucide-react-native';

interface SaveRecordingModalProps {
  visible: boolean;
  defaultName: string;
  durationMs: number;
  sizeBytes: number;
  formatBadge: string;
  onSubmit: (chosenName: string) => void;
  onDiscard: () => void;
}

export const SaveRecordingModal: React.FC<SaveRecordingModalProps> = ({
  visible,
  defaultName,
  durationMs,
  sizeBytes,
  formatBadge,
  onSubmit,
  onDiscard,
}) => {
  const [name, setName] = useState(defaultName);
  const inputRef = useRef<TextInput | null>(null);

  useEffect(() => {
    if (visible) {
      setName(defaultName);
      setTimeout(() => {
        inputRef.current?.focus();
      }, 120);
    }
  }, [visible, defaultName]);

  const formatDuration = (ms: number) => {
    const totalSeconds = Math.floor(ms / 1000);
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    const centis = Math.floor((ms % 1000) / 10);
    return `${mins.toString().padStart(2, '0')}:${secs
      .toString()
      .padStart(2, '0')}.${centis.toString().padStart(2, '0')}`;
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  const handleSave = () => {
    Keyboard.dismiss();
    onSubmit(name.trim().length > 0 ? name.trim() : defaultName);
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
      <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
        <View style={styles.backdrop}>
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            style={styles.keyboardAvoid}
          >
            <View style={styles.card}>
              {/* Header Icon & Title */}
              <View style={styles.headerRow}>
                <View style={styles.iconCircle}>
                  <Music2 size={16} color="#FFFFFF" strokeWidth={2} />
                </View>
                <View style={styles.headerTextGroup}>
                  <Text style={styles.title}>Save Take</Text>
                  <Text style={styles.subtitle}>
                    {formatDuration(durationMs)} • {formatSize(sizeBytes)} • {formatBadge}
                  </Text>
                </View>
              </View>

              {/* Name Input Field */}
              <View style={styles.inputWrapper}>
                <Text style={styles.inputLabel}>TAKE NAME</Text>
                <TextInput
                  ref={inputRef}
                  style={styles.input}
                  value={name}
                  onChangeText={setName}
                  placeholder={defaultName}
                  placeholderTextColor="#52525B"
                  selectTextOnFocus
                  returnKeyType="done"
                  onSubmitEditing={handleSave}
                />
              </View>

              {/* Action Buttons Row: Discard on Left, Save on Right */}
              <View style={styles.actionRow}>
                <TouchableOpacity
                  style={styles.discardBtn}
                  onPress={handleDiscard}
                  activeOpacity={0.7}
                >
                  <Trash2 size={14} color="#EF4444" strokeWidth={2.2} />
                  <Text style={styles.discardBtnText}>Discard</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.saveBtn}
                  onPress={handleSave}
                  activeOpacity={0.8}
                >
                  <Check size={14} color="#000000" strokeWidth={3} />
                  <Text style={styles.saveBtnText}>Save</Text>
                </TouchableOpacity>
              </View>
            </View>
          </KeyboardAvoidingView>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  keyboardAvoid: {
    width: '100%',
    alignItems: 'center',
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
    elevation: 12,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 18,
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
    marginBottom: 20,
  },
  inputLabel: {
    color: '#71717A',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.8,
    marginBottom: 4,
  },
  input: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '500',
    padding: 0,
  },
  /* Action Buttons Spaced to the Left & Right */
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  discardBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.22)',
  },
  discardBtnText: {
    color: '#EF4444',
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
  saveBtnText: {
    color: '#000000',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
});