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
  const [text, setText] = useState(initialScript);

  const handleSave = () => {
    onSave(text);
    onClose();
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.keyboardView}
        >
          <View style={styles.topBar}>
            <TouchableOpacity style={styles.btnSecondary} onPress={onClose}>
              <Text style={styles.btnSecondaryText}>CANCEL</Text>
            </TouchableOpacity>
            <Text style={styles.title}>Edit Teleprompter Script</Text>
            <TouchableOpacity style={styles.btnPrimary} onPress={handleSave}>
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
            placeholderTextColor="#555555"
            autoFocus
          />
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#121212',
  },
  keyboardView: {
    flex: 1,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#262626',
  },
  title: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  btnSecondary: {
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  btnSecondaryText: {
    color: '#9E9E9E',
    fontSize: 12,
    fontWeight: '600',
  },
  btnPrimary: {
    backgroundColor: '#00E676',
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 14,
  },
  btnPrimaryText: {
    color: '#121212',
    fontSize: 12,
    fontWeight: '700',
  },
  textInput: {
    flex: 1,
    color: '#E0E0E0',
    fontSize: 16,
    lineHeight: 24,
    padding: 16,
    backgroundColor: '#181818',
  },
});