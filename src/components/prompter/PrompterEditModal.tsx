// src/components/prompter/PrompterEditModal.tsx
import React, { useState, useEffect, useRef } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Platform,
  ScrollView,
  Keyboard,
  GestureResponderEvent,
  LayoutRectangle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { X, Check, Pencil, FileUp } from 'lucide-react-native';

import { useResponsive } from '../../hooks/useResponsive';
import { useKeyboardViewport } from '../../hooks/useKeyboardViewport';
import {
  AppToast,
  AppToastData,
  ToastVariant,
  getToastTop,
} from '../../components/common/AppToast';
import { KeyboardHelper } from '../../../modules/audio-hardware-router/src';

interface PrompterEditModalProps {
  visible: boolean;
  initialScript: string;
  topInset?: number;
  onSave: (newScript: string) => void;
  onClose: () => void;
}

export const PrompterEditModal: React.FC<PrompterEditModalProps> = ({
  visible,
  initialScript,
  topInset = 0,
  onSave,
  onClose,
}) => {
  const { isTablet } = useResponsive();
  const { offset: keyboardOffset, isVisible: keyboardVisible } = useKeyboardViewport();

  const [text, setText] = useState(initialScript);
  const [savedBaseline, setSavedBaseline] = useState(initialScript);
  const [isEditing, setIsEditing] = useState(false);
  const [toast, setToast] = useState<AppToastData | null>(null);

  const textRef = useRef(initialScript);
  const prevVisibleRef = useRef(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<TextInput | null>(null);
  const isSavingRef = useRef(false);

  const headerRightLayoutRef = useRef<LayoutRectangle | null>(null);
  const cancelBtnLayoutRef = useRef<LayoutRectangle | null>(null);
  const saveBtnLayoutRef = useRef<LayoutRectangle | null>(null);

  useEffect(() => {
    if (visible && !prevVisibleRef.current) {
      setText(initialScript);
      textRef.current = initialScript;
      setSavedBaseline(initialScript);
      setIsEditing(false);
      setToast(null);
    }
    prevVisibleRef.current = visible;
  }, [visible, initialScript]);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  const showToast = (message: string, variant: ToastVariant = 'success') => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ title: message, variant });
    toastTimerRef.current = setTimeout(() => setToast(null), 3000);
  };

  const handleTextChange = (val: string) => {
    textRef.current = val;
    setText(val);
  };

  const handleStartEditing = () => {
    setIsEditing(true);
    setTimeout(() => {
      inputRef.current?.focus();
      KeyboardHelper.show().catch(() => {});
    }, 80);
    setTimeout(() => {
      inputRef.current?.focus();
      KeyboardHelper.show().catch(() => {});
    }, 300);
  };

  const handleCancelEditing = () => {
    Keyboard.dismiss();
    inputRef.current?.blur();
    textRef.current = savedBaseline;
    setText(savedBaseline);
    setIsEditing(false);
  };

  const handleSave = () => {
    if (isSavingRef.current) return;
    isSavingRef.current = true;

    const trimmed = textRef.current.trim();
    if (trimmed.length === 0) {
      showToast('Script cannot be blank', 'error');
      isSavingRef.current = false;
      return;
    }

    Keyboard.dismiss();
    inputRef.current?.blur();

    setText(trimmed);
    setSavedBaseline(trimmed);
    onSave(trimmed);
    setIsEditing(false);
    showToast('Changes saved');

    setTimeout(() => {
      isSavingRef.current = false;
    }, 400);
  };

  const handleTopBarTouchStart = (e: GestureResponderEvent) => {
    if (!isEditing) return;

    const { locationX } = e.nativeEvent;
    const headerRight = headerRightLayoutRef.current;
    const saveLayout = saveBtnLayoutRef.current;
    const cancelLayout = cancelBtnLayoutRef.current;

    if (headerRight && saveLayout) {
      const left = headerRight.x + saveLayout.x;
      if (locationX >= left - 10 && locationX <= left + saveLayout.width + 10) {
        handleSave();
        return;
      }
    }

    if (headerRight && cancelLayout) {
      const left = headerRight.x + cancelLayout.x;
      if (locationX >= left - 10 && locationX <= left + cancelLayout.width + 10) {
        handleCancelEditing();
        return;
      }
    }
  };

  const handleImportFile = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['text/plain', 'text/*', 'application/octet-stream'],
        copyToCacheDirectory: true,
      });

      if (result.canceled || !result.assets || result.assets.length === 0) return;

      const file = result.assets[0];
      const fileName = file.name || 'document.txt';

      const isTxt = fileName.toLowerCase().endsWith('.txt') || file.mimeType === 'text/plain';
      if (!isTxt) {
        showToast('Select a plain .txt file', 'error');
        return;
      }

      const content = await FileSystem.readAsStringAsync(file.uri);
      const cleanContent = content.trim();

      if (cleanContent.length === 0) {
        showToast('Selected file is empty', 'error');
        return;
      }

      textRef.current = cleanContent;
      setText(cleanContent);
      setSavedBaseline(cleanContent);
      onSave(cleanContent);
      setIsEditing(false);
      showToast('Changes saved');
    } catch (err: any) {
      showToast(err?.message || 'Failed to read file', 'error');
    }
  };

  const words = text.trim().length > 0 ? text.trim().split(/\s+/).length : 0;
  const chars = text.length;
  const readTimeMinutes = Math.max(1, Math.round(words / 130));

  const cardContent = (
    <View style={[styles.dialogCard, isTablet && styles.dialogCardTablet]}>
      <View style={styles.topBar} onTouchStart={handleTopBarTouchStart}>
        <View style={styles.headerLeft}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {isEditing ? 'Edit Script' : 'Script'}
          </Text>
        </View>

        <View
          style={styles.headerRight}
          onLayout={(e) => {
            headerRightLayoutRef.current = e.nativeEvent.layout;
          }}
        >
          {isEditing ? (
            <>
              <View
                onLayout={(e) => {
                  cancelBtnLayoutRef.current = e.nativeEvent.layout;
                }}
                onTouchStart={handleCancelEditing}
              >
                <TouchableOpacity
                  style={styles.cancelBtn}
                  onPress={handleCancelEditing}
                  activeOpacity={0.7}
                  hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
                >
                  <Text style={styles.cancelBtnText}>Cancel</Text>
                </TouchableOpacity>
              </View>

              <View
                onLayout={(e) => {
                  saveBtnLayoutRef.current = e.nativeEvent.layout;
                }}
                onTouchStart={handleSave}
              >
                <TouchableOpacity
                  style={styles.saveBtn}
                  onPress={handleSave}
                  activeOpacity={0.8}
                  hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
                >
                  <Check size={13} color="#000000" strokeWidth={3} />
                  <Text style={styles.saveBtnText}>Save</Text>
                </TouchableOpacity>
              </View>
            </>
          ) : (
            <>
              <TouchableOpacity
                style={styles.importPill}
                onPress={handleImportFile}
                activeOpacity={0.7}
                hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
              >
                <FileUp size={12} color="#A1A1AA" />
                <Text style={styles.importPillText}>Import .txt</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.editBtn}
                onPress={handleStartEditing}
                activeOpacity={0.8}
                hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
              >
                <Pencil size={11} color="#000000" strokeWidth={2.5} />
                <Text style={styles.editBtnText}>Edit</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.closeBtn}
                onPress={onClose}
                activeOpacity={0.7}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <X size={15} color="#A1A1AA" />
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>

      {toast ? <AppToast data={toast} top={getToastTop(topInset)} /> : null}

      {isEditing ? (
        <ScrollView
          style={styles.scrollArea}
          contentContainerStyle={[
            styles.editorScrollContent,
            {
              paddingBottom: Math.max(keyboardOffset, 0) + 80,
            },
          ]}
          keyboardShouldPersistTaps="always"
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={true}
        >
          <TextInput
            ref={inputRef}
            style={styles.editorInput}
            multiline={true}
            scrollEnabled={false}
            textAlignVertical="top"
            value={text}
            onChangeText={handleTextChange}
            placeholder="Paste or type your script here..."
            placeholderTextColor="#3F3F46"
            underlineColorAndroid="transparent"
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

          <View style={styles.telemetryFooter}>
            <Text style={styles.telemetryText}>
              {words} {words === 1 ? 'word' : 'words'} • {chars} chars • ~{readTimeMinutes} min read
            </Text>
          </View>
        </View>
      )}
    </View>
  );

  return (
    <Modal
      visible={visible}
      animationType={isTablet ? 'fade' : 'slide'}
      presentationStyle={isTablet ? 'overFullScreen' : 'pageSheet'}
      transparent={isTablet}
      statusBarTranslucent={false}
      onRequestClose={isEditing ? handleCancelEditing : onClose}
    >
      {isTablet ? (
        <View
          style={[
            styles.backdrop,
            keyboardVisible && { justifyContent: 'flex-start', paddingTop: 36 },
          ]}
        >
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
    padding: 20,
  },
  dialogCard: {
    flex: 1,
    width: '100%',
    backgroundColor: '#09090C',
  },
  dialogCardTablet: {
    flex: 0,
    width: '100%',
    maxWidth: 620,
    height: '80%',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: '#1C1C22',
    overflow: 'hidden',
  },
  topBar: {
    height: 54,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    backgroundColor: '#09090C',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#18181D',
    zIndex: 10,
  },
  headerLeft: {
    flex: 1,
    height: 34,
    justifyContent: 'center',
    alignItems: 'flex-start',
  },
  headerTitle: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: -0.3,
    includeFontPadding: false,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 34,
  },
  closeBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#141418',
    borderWidth: 1,
    borderColor: '#202026',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelBtn: {
    height: 34,
    paddingHorizontal: 12,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
  },
  cancelBtnText: {
    color: '#A1A1AA',
    fontSize: 12,
    fontWeight: '600',
    includeFontPadding: false,
  },
  saveBtn: {
    height: 34,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 14,
    borderRadius: 17,
  },
  saveBtnText: {
    color: '#000000',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.1,
    includeFontPadding: false,
  },
  importPill: {
    height: 34,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingHorizontal: 11,
    borderRadius: 17,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
  },
  importPillText: {
    color: '#D4D4D8',
    fontSize: 11,
    fontWeight: '500',
    letterSpacing: 0.1,
    includeFontPadding: false,
  },
  editBtn: {
    height: 34,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 13,
    borderRadius: 17,
  },
  editBtnText: {
    color: '#000000',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.1,
    includeFontPadding: false,
  },
  scrollArea: {
    flex: 1,
  },
  editorScrollContent: {
    paddingHorizontal: 20,
    paddingTop: 16,
  },
  editorInput: {
    color: '#FFFFFF',
    fontSize: 16,
    lineHeight: 26,
    letterSpacing: 0.2,
    fontWeight: '400',
    minHeight: 220,
    padding: 0,
  },
  viewerWrapper: {
    flex: 1,
  },
  viewerScrollContent: {
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 40,
  },
  viewerText: {
    color: '#F4F4F5',
    fontSize: 16,
    lineHeight: 26,
    letterSpacing: 0.2,
    fontWeight: '400',
  },
  telemetryFooter: {
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#141418',
    backgroundColor: '#070709',
    alignItems: 'flex-end',
  },
  telemetryText: {
    color: '#71717A',
    fontSize: 10,
    fontWeight: '500',
    fontVariant: ['tabular-nums'],
    letterSpacing: 0.2,
  },
});
