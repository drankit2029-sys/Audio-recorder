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
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [toast, setToast] = useState<BannerToast | null>(null);

  const textRef = useRef(initialScript);
  const prevVisibleRef = useRef(false);
  const toastTimerRef = useRef<NodeJS.Timeout | null>(null);
  const inputRef = useRef<TextInput | null>(null);
  const isSavingRef = useRef(false);

  // Layout rectangles for hit-testing touches outside the input
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
      setKeyboardHeight(0);
    }
    prevVisibleRef.current = visible;
  }, [visible, initialScript]);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const showSub = Keyboard.addListener(showEvent, (e) => {
      setKeyboardHeight(e.endCoordinates?.height || 0);
    });
    const hideSub = Keyboard.addListener(hideEvent, () => {
      setKeyboardHeight(0);
    });

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  const showToast = (type: 'error' | 'success', message: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ type, message });
    toastTimerRef.current = setTimeout(() => {
      setToast(null);
    }, 3000);
  };

  const handleTextChange = (val: string) => {
    textRef.current = val;
    setText(val);
  };

  const handleStartEditing = () => {
    setIsEditing(true);
    setTimeout(() => {
      inputRef.current?.focus();
    }, 80);
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
      showToast('error', 'Script cannot be blank');
      isSavingRef.current = false;
      return;
    }

    Keyboard.dismiss();
    inputRef.current?.blur();

    setText(trimmed);
    setSavedBaseline(trimmed);
    onSave(trimmed);
    setIsEditing(false);
    showToast('success', 'Changes saved');

    setTimeout(() => {
      isSavingRef.current = false;
    }, 400);
  };

  // Direct hit-test interceptor on the TopBar
  const handleTopBarTouchStart = (e: GestureResponderEvent) => {
    if (!isEditing) return;

    const { locationX } = e.nativeEvent;
    const headerRight = headerRightLayoutRef.current;
    const saveLayout = saveBtnLayoutRef.current;
    const cancelLayout = cancelBtnLayoutRef.current;

    if (headerRight && saveLayout) {
      const saveLeftInTopBar = headerRight.x + saveLayout.x;
      const saveRightInTopBar = saveLeftInTopBar + saveLayout.width;

      if (locationX >= saveLeftInTopBar - 10 && locationX <= saveRightInTopBar + 10) {
        handleSave();
        return;
      }
    }

    if (headerRight && cancelLayout) {
      const cancelLeftInTopBar = headerRight.x + cancelLayout.x;
      const cancelRightInTopBar = cancelLeftInTopBar + cancelLayout.width;

      if (locationX >= cancelLeftInTopBar - 10 && locationX <= cancelRightInTopBar + 10) {
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
        showToast('error', 'Select a plain .txt file');
        return;
      }

      const content = await FileSystem.readAsStringAsync(file.uri);
      const cleanContent = content.trim();

      if (cleanContent.length === 0) {
        showToast('error', 'Selected file is empty');
        return;
      }

      textRef.current = cleanContent;
      setText(cleanContent);
      setSavedBaseline(cleanContent);
      onSave(cleanContent);
      setIsEditing(false);
      showToast('success', 'Changes saved');
    } catch (err: any) {
      showToast('error', err?.message || 'Failed to read file');
    }
  };

  const words = text.trim().length > 0 ? text.trim().split(/\s+/).length : 0;
  const chars = text.length;
  const readTimeMinutes = Math.max(1, Math.round(words / 130));

  const cardContent = (
    <View style={[styles.dialogCard, isTablet && styles.dialogCardTablet]}>
      {/* 
        Top Header Bar: 
        Left-Aligned Title, Synchronous Touch-Interception for Save & Cancel 
      */}
      <View
        style={styles.topBar}
        onTouchStart={handleTopBarTouchStart}
      >
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
              {/* Cancel Button with direct touch detection */}
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

              {/* Save Button with direct touch detection */}
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

      {/* Floating Save Toast Notification: Matching the Take Saved layout */}
      {toast ? (
        <View style={styles.toastOverlay} pointerEvents="none">
          <Animated.View
            entering={FadeInDown.duration(240).easing(Easing.out(Easing.cubic))}
            exiting={FadeOutUp.duration(180).easing(Easing.in(Easing.cubic))}
            style={styles.toastCard}
          >
            <View
              style={[
                styles.toastIconCircle,
                toast.type === 'error' && styles.toastIconCircleError,
              ]}
            >
              {toast.type === 'error' ? (
                <AlertCircle size={14} color="#FFFFFF" strokeWidth={2.5} />
              ) : (
                <Check size={14} color="#000000" strokeWidth={3} />
              )}
            </View>
            <Text style={styles.toastSingleText}>{toast.message}</Text>
          </Animated.View>
        </View>
      ) : null}

      {/* Workspace Area */}
      {isEditing ? (
        <ScrollView
          style={styles.scrollArea}
          contentContainerStyle={[
            styles.editorScrollContent,
            { paddingBottom: keyboardHeight > 0 ? keyboardHeight + 80 : 80 },
          ]}
          keyboardShouldPersistTaps="always"
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
      statusBarTranslucent={true}
      onRequestClose={isEditing ? handleCancelEditing : onClose}
    >
      {isTablet ? (
        <View
          style={[
            styles.backdrop,
            keyboardHeight > 0 && { justifyContent: 'flex-start', paddingTop: 36 },
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

  /* Fixed 54dp Header with Left-Aligned Title */
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

  /* Matched 34dp Height Controls (Zero Vertical Baseline Offset) */
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

  /* Floating Toast Notification (Take Saved Style) */
  toastOverlay: {
    position: 'absolute',
    top: 68,
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 9999,
    elevation: 99,
  },
  toastCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#18181B',
    borderWidth: 1,
    borderColor: '#27272A',
    borderRadius: 30,
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 10,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.45,
    shadowRadius: 12,
    elevation: 8,
  },
  toastIconCircle: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#10B981',
    alignItems: 'center',
    justifyContent: 'center',
  },
  toastIconCircleError: {
    backgroundColor: '#EF4444',
  },
  toastSingleText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.1,
  },

  /* Content & Editor Regions */
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

  /* Telemetry Footer */
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