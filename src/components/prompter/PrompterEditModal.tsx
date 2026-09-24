// src/components/prompter/PrompterEditModal.tsx
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
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, {
  FadeInDown,
  FadeOutUp,
  Easing,
} from 'react-native-reanimated';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import {
  X,
  Check,
  Pencil,
  FileUp,
  AlertCircle,
  CheckCircle2,
} from 'lucide-react-native';

import { useResponsive } from '../../hooks/useResponsive';

interface PrompterEditModalProps {
  visible: boolean;
  initialScript: string;
  onSave: (newScript: string) => void;
  onClose: () => void;
}

interface BannerToast {
  type: 'error' | 'success';
  title: string;
  message: string;
}

export const PrompterEditModal: React.FC<PrompterEditModalProps> = ({
  visible,
  initialScript,
  onSave,
  onClose,
}) => {
  const { isTablet } = useResponsive();
  const [text, setText] = useState(initialScript);
  const [savedBaseline, setSavedBaseline] = useState(initialScript);
  const [isEditing, setIsEditing] = useState(false);
  const [toast, setToast] = useState<BannerToast | null>(null);

  const toastTimerRef = useRef<NodeJS.Timeout | null>(null);
  const inputRef = useRef<TextInput | null>(null);

  useEffect(() => {
    if (visible) {
      setText(initialScript);
      setSavedBaseline(initialScript);
      setIsEditing(false);
      setToast(null);
    }
  }, [visible, initialScript]);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  const showToast = (type: 'error' | 'success', title: string, message: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ type, title, message });
    toastTimerRef.current = setTimeout(() => {
      setToast(null);
    }, 4000);
  };

  const handleStartEditing = () => {
    setIsEditing(true);
    setTimeout(() => {
      inputRef.current?.focus();
    }, 100);
  };

  const handleCancelEditing = () => {
    setText(savedBaseline);
    setIsEditing(false);
  };

  const handleSave = () => {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      showToast('error', 'Empty Script', 'The teleprompter script cannot be left blank.');
      return;
    }

    setSavedBaseline(trimmed);
    onSave(trimmed);
    setIsEditing(false);
    showToast('success', 'Script Saved', 'Your script changes are now live in the studio.');
  };

  const handleImportFile = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['text/plain', 'text/*', 'application/octet-stream'],
        copyToCacheDirectory: true,
      });

      if (result.canceled || !result.assets || result.assets.length === 0) {
        return;
      }

      const file = result.assets[0];
      const fileName = file.name || 'document.txt';

      // Validate file extension
      const isTxt = fileName.toLowerCase().endsWith('.txt') || file.mimeType === 'text/plain';
      if (!isTxt) {
        showToast(
          'error',
          'Unsupported File Type',
          `"${fileName}" is not a plain text file. Please select a file ending in .txt.`
        );
        return;
      }

      // Read file content from disk
      const content = await FileSystem.readAsStringAsync(file.uri);
      const cleanContent = content.trim();

      if (cleanContent.length === 0) {
        showToast('error', 'Empty Document', `"${fileName}" contains no readable text.`);
        return;
      }

      setText(cleanContent);
      setSavedBaseline(cleanContent);
      onSave(cleanContent);
      setIsEditing(false);

      showToast('success', 'Script Imported', `Successfully loaded "${fileName}".`);
    } catch (err: any) {
      showToast('error', 'Import Failed', err?.message || 'Could not read the selected file.');
    }
  };

  // Telemetry: word count and reading duration (~130 words per minute)
  const words = text.trim().length > 0 ? text.trim().split(/\s+/).length : 0;
  const chars = text.length;
  const readTimeMinutes = Math.max(1, Math.round(words / 130));

  const cardContent = (
    <View style={[styles.dialogCard, isTablet && styles.dialogCardTablet]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.keyboardView}
      >
        {/* Top Header Bar */}
        <View style={styles.topBar}>
          {isEditing ? (
            <TouchableOpacity
              style={styles.btnSecondary}
              onPress={handleCancelEditing}
              activeOpacity={0.7}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <X size={14} color="#8E8E93" />
              <Text style={styles.btnSecondaryText}>Cancel</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={styles.btnSecondary}
              onPress={onClose}
              activeOpacity={0.7}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <X size={14} color="#8E8E93" />
              <Text style={styles.btnSecondaryText}>Close</Text>
            </TouchableOpacity>
          )}

          <Text style={styles.title}>{isEditing ? 'Editing Script' : 'Teleprompter Script'}</Text>

          {isEditing ? (
            <TouchableOpacity
              style={styles.btnPrimary}
              onPress={handleSave}
              activeOpacity={0.8}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Check size={13} color="#000000" strokeWidth={3} />
              <Text style={styles.btnPrimaryText}>Save</Text>
            </TouchableOpacity>
          ) : (
            <View style={styles.headerRightActions}>
              <TouchableOpacity
                style={styles.headerPillBtn}
                onPress={handleImportFile}
                activeOpacity={0.65}
                hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
              >
                <FileUp size={12} color="#8E8E93" />
                <Text style={styles.headerPillText}>Import .txt</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.btnPrimary}
                onPress={handleStartEditing}
                activeOpacity={0.8}
                hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
              >
                <Pencil size={12} color="#000000" strokeWidth={2.5} />
                <Text style={styles.btnPrimaryText}>Edit</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>

        {/* Stylized Floating Banner Popup */}
        {toast ? (
          <Animated.View
            entering={FadeInDown.duration(220).easing(Easing.out(Easing.cubic))}
            exiting={FadeOutUp.duration(160).easing(Easing.in(Easing.cubic))}
            style={[
              styles.toastBanner,
              toast.type === 'error' ? styles.toastBannerError : styles.toastBannerSuccess,
            ]}
          >
            <View style={styles.toastIconWrapper}>
              {toast.type === 'error' ? (
                <AlertCircle size={16} color="#EF4444" strokeWidth={2.2} />
              ) : (
                <CheckCircle2 size={16} color="#10B981" strokeWidth={2.2} />
              )}
            </View>
            <View style={styles.toastTextCol}>
              <Text
                style={[
                  styles.toastTitle,
                  toast.type === 'error' ? styles.toastTitleError : styles.toastTitleSuccess,
                ]}
              >
                {toast.title}
              </Text>
              <Text style={styles.toastMessage}>{toast.message}</Text>
            </View>
            <TouchableOpacity
              onPress={() => setToast(null)}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              style={styles.toastCloseBtn}
            >
              <X size={12} color="#71717A" />
            </TouchableOpacity>
          </Animated.View>
        ) : null}

        {/* Script Content: Read-Only Scroll vs Interactive Auto-Shifting Editor */}
        {isEditing ? (
          <ScrollView
            style={styles.scrollArea}
            contentContainerStyle={styles.editorScrollContent}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
            automaticallyAdjustKeyboardInsets={true}
          >
            <TextInput
              ref={inputRef}
              style={styles.editorInput}
              multiline
              scrollEnabled={false}
              textAlignVertical="top"
              value={text}
              onChangeText={setText}
              placeholder="Paste or type your script here..."
              placeholderTextColor="#3F3F46"
            />
          </ScrollView>
        ) : (
          <View style={styles.viewerWrapper}>
            <ScrollView
              style={styles.scrollArea}
              contentContainerStyle={styles.viewerScrollContent}
              showsVerticalScrollIndicator={false}
            >
              <Text selectable={true} style={styles.viewerText}>
                {text}
              </Text>
            </ScrollView>

            {/* Read Telemetry Footer */}
            <View style={styles.telemetryFooter}>
              <Text style={styles.telemetryText}>
                {words} {words === 1 ? 'word' : 'words'} • {chars} chars • ~{readTimeMinutes} min read
              </Text>
            </View>
          </View>
        )}
      </KeyboardAvoidingView>
    </View>
  );

  return (
    <Modal
      visible={visible}
      animationType={isTablet ? 'fade' : 'slide'}
      presentationStyle={isTablet ? 'overFullScreen' : 'pageSheet'}
      transparent={isTablet}
      onRequestClose={isEditing ? handleCancelEditing : onClose}
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
    backgroundColor: '#09090C',
  },
  dialogCardTablet: {
    flex: 0,
    width: '100%',
    maxWidth: 640,
    height: '78%',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: '#1C1C22',
    overflow: 'hidden',
  },
  keyboardView: {
    flex: 1,
  },

  /* Header */
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#18181D',
  },
  title: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: -0.2,
  },
  headerRightActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  btnSecondary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  btnSecondaryText: {
    color: '#8E8E93',
    fontSize: 12,
    fontWeight: '500',
  },
  headerPillBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 14,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
  },
  headerPillText: {
    color: '#D4D4D8',
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  btnPrimary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 13,
    paddingVertical: 6,
    borderRadius: 14,
  },
  btnPrimaryText: {
    color: '#000000',
    fontSize: 12,
    fontWeight: '700',
  },

  /* Stylized Banner Popups */
  toastBanner: {
    position: 'absolute',
    top: 58,
    left: 14,
    right: 14,
    zIndex: 100,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 14,
    borderWidth: 1,
    gap: 10,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 8,
    elevation: 8,
  },
  toastBannerError: {
    backgroundColor: '#1E1212',
    borderColor: '#3B1818',
  },
  toastBannerSuccess: {
    backgroundColor: '#101B14',
    borderColor: '#193D24',
  },
  toastIconWrapper: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  toastTextCol: {
    flex: 1,
  },
  toastTitle: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  toastTitleError: {
    color: '#EF4444',
  },
  toastTitleSuccess: {
    color: '#10B981',
  },
  toastMessage: {
    color: '#A1A1AA',
    fontSize: 11,
    fontWeight: '500',
    marginTop: 1,
    lineHeight: 15,
  },
  toastCloseBtn: {
    padding: 4,
  },

  /* Content Scroll Regions */
  scrollArea: {
    flex: 1,
  },
  viewerWrapper: {
    flex: 1,
  },
  viewerScrollContent: {
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 40,
  },
  viewerText: {
    color: '#F4F4F5',
    fontSize: 16,
    lineHeight: 27,
    letterSpacing: 0.2,
    fontWeight: '400',
  },
  editorScrollContent: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 80,
  },
  editorInput: {
    color: '#FFFFFF',
    fontSize: 16,
    lineHeight: 27,
    letterSpacing: 0.2,
    fontWeight: '400',
    minHeight: 220,
    padding: 0,
  },

  /* Telemetry Footer */
  telemetryFooter: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#16161A',
    backgroundColor: '#070709',
    alignItems: 'flex-end',
  },
  telemetryText: {
    color: '#71717A',
    fontSize: 11,
    fontWeight: '500',
    fontVariant: ['tabular-nums'],
    letterSpacing: 0.2,
  },
});