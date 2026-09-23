// src/components/audio/SaveRecordingModal.tsx
import React, { useState, useEffect } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { FileAudio, Check, X, Trash2 } from 'lucide-react-native';
import { useResponsive } from '../../hooks/useResponsive';

interface SaveRecordingModalProps {
  visible: boolean;
  defaultName: string;
  durationMs: number;
  sizeBytes: number;
  formatBadge: string;
  onSubmit: (finalName: string) => void;
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
  const { isTablet } = useResponsive();
  const [name, setName] = useState(defaultName);

  useEffect(() => {
    if (visible) {
      setName(defaultName);
    }
  }, [visible, defaultName]);

  const formatSecs = (ms: number): string => {
    const totalSecs = Math.floor(ms / 1000);
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes <= 0) return '0 KB';
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  const handleSubmit = () => {
    const trimmed = name.trim();
    onSubmit(trimmed.length > 0 ? trimmed : defaultName);
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onDiscard}
    >
      <View style={styles.backdrop}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.avoidingView}
        >
          <View style={[styles.card, isTablet && styles.cardTablet]}>
            {/* Header Icon & Title */}
            <View style={styles.headerRow}>
              <View style={styles.iconCircle}>
                <FileAudio size={20} color="#FFFFFF" />
              </View>
              <View style={styles.headerTextCol}>
                <Text style={styles.title}>Save Recording</Text>
                <Text style={styles.metaText}>
                  {formatBadge} • {formatSecs(durationMs)} • {formatFileSize(sizeBytes)}
                </Text>
              </View>
            </View>

            {/* Input Field with Clear Button */}
            <View style={styles.inputWrapper}>
              <TextInput
                style={styles.input}
                value={name}
                onChangeText={setName}
                placeholder="Name your take..."
                placeholderTextColor="#636366"
                autoFocus
                selectTextOnFocus
                returnKeyType="done"
                onSubmitEditing={handleSubmit}
              />
              {name.length > 0 && (
                <TouchableOpacity
                  style={styles.clearBtn}
                  onPress={() => setName('')}
                  activeOpacity={0.7}
                >
                  <X size={14} color="#8E8E93" />
                </TouchableOpacity>
              )}
            </View>

            {/* Actions: Discard vs Save */}
            <View style={styles.actionsRow}>
              <TouchableOpacity
                style={styles.discardBtn}
                onPress={onDiscard}
                activeOpacity={0.7}
              >
                <Trash2 size={14} color="#FF453A" />
                <Text style={styles.discardBtnText}>DISCARD</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.primaryBtn}
                onPress={handleSubmit}
                activeOpacity={0.8}
              >
                <Check size={16} color="#000000" strokeWidth={2.5} />
                <Text style={styles.primaryBtnText}>SAVE</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.82)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  avoidingView: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: '#141416',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: '#262628',
    padding: 22,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.5,
    shadowRadius: 18,
    elevation: 16,
  },
  cardTablet: {
    maxWidth: 480,
    padding: 26,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginBottom: 18,
  },
  iconCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#1E1E22',
    borderWidth: 1,
    borderColor: '#2E2E34',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTextCol: {
    flex: 1,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  metaText: {
    color: '#8E8E93',
    fontSize: 12,
    fontWeight: '500',
    marginTop: 2,
  },
  inputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0C0C0E',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#26262A',
    paddingHorizontal: 14,
    height: 52,
    marginBottom: 20,
  },
  input: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '500',
    padding: 0,
  },
  clearBtn: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#1E1E22',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 8,
  },
  actionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 10,
  },
  discardBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 14,
    backgroundColor: '#211212',
    borderWidth: 1,
    borderColor: '#381C1C',
  },
  discardBtnText: {
    color: '#FF453A',
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 12,
    paddingHorizontal: 22,
    borderRadius: 14,
    backgroundColor: '#FFFFFF',
  },
  primaryBtnText: {
    color: '#000000',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
});