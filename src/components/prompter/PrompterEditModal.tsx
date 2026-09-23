// src/components/prompter/PrompterEditModal.tsx
import React, { useState } from 'react';
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
import { SafeAreaView } from 'react-native-safe-area-context';
import { X, Check } from 'lucide-react-native';

import { useResponsive } from '../../hooks/useResponsive';

interface PrompterEditModalProps {
  visible: boolean;
  initialScript: string;
  onSave: (newScript: string) => void;
  onClose: () => void;
}

export const PrompterEditModal: React.FC<PrompterEditModalProps> = ({
  visible,
  initialScript,
  onSave,
  onClose,
}) => {
  const { isTablet } = useResponsive();
  const [text, setText] = useState(initialScript);

  const handleSave = () => {
    onSave(text);
    onClose();
  };

  const cardContent = (
    <View style={[styles.dialogCard, isTablet && styles.dialogCardTablet]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.keyboardView}
      >
        <View style={styles.topBar}>
          <TouchableOpacity style={styles.btnSecondary} onPress={onClose} activeOpacity={0.7}>
            <X size={15} color="#8E8E93" />
            <Text style={styles.btnSecondaryText}>CANCEL</Text>
          </TouchableOpacity>

          <Text style={styles.title}>Teleprompter Script</Text>

          <TouchableOpacity style={styles.btnPrimary} onPress={handleSave} activeOpacity={0.8}>
            <Check size={14} color="#000000" />
            <Text style={styles.btnPrimaryText}>SAVE</Text>
          </TouchableOpacity>
        </View>

        <TextInput
          style={styles.textInput}
          multiline
          textAlignVertical="top"
          value={text}
          onChangeText={setText}
          placeholder="Paste or type your recording script here..."
          placeholderTextColor="#48484A"
          autoFocus
        />
      </KeyboardAvoidingView>
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
    backgroundColor: 'rgba(0, 0, 0, 0.85)',
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
    width: '100%',
    maxWidth: 680,
    height: '75%',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: '#262626',
    overflow: 'hidden',
  },
  keyboardView: {
    flex: 1,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#1F1F1F',
  },
  title: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  btnSecondary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  btnSecondaryText: {
    color: '#8E8E93',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  btnPrimary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 14,
  },
  btnPrimaryText: {
    color: '#000000',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  textInput: {
    flex: 1,
    color: '#F2F2F7',
    fontSize: 16,
    lineHeight: 24,
    padding: 20,
    backgroundColor: '#121212',
  },
});