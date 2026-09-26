// src/components/prompter/TeleprompterDeck.tsx
import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  LayoutChangeEvent,
  Modal,
  FlatList,
  TextInput,
  TouchableWithoutFeedback,
  Keyboard,
} from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  cancelAnimation,
  Easing,
} from 'react-native-reanimated';
import { GestureDetector, Gesture } from 'react-native-gesture-handler';
import {
  FileText,
  FlipHorizontal,
  RotateCcw,
  Type,
  Gauge,
  Plus,
  Minus,
  Check,
  X,
  Keyboard as KeyboardIcon,
} from 'lucide-react-native';

import { PrompterStorage } from '../../services/storage/prompterStorage';
import { PrompterEditModal } from './PrompterEditModal';
import { EngineState } from '../../services/audio/useAudioRecording';

export interface TeleprompterDeckProps {
  engineState: EngineState;
  customHeight?: number;
}

const FALLBACK_SCRIPT = `Welcome to the studio. This is your synchronized teleprompter.

Speak with a steady, natural cadence and maintain consistent distance from the microphone capsule.

Watch the real-time Skia meter below to protect your dynamic range. Target your speech peaks between -18 dBFS and -6 dBFS for broadcast-ready master audio.

Use the Mirror toggle if you are shooting through a beam-splitter glass rig, or adjust the speed stepper above to match your reading tempo.`;

// All integer values from 1 to 50 for text size
const ALL_FONT_SIZES = Array.from({ length: 50 }, (_, i) => i + 1);

// All integer values from 0 to 200 for speed
const ALL_SPEEDS = Array.from({ length: 201 }, (_, i) => i);

const ITEM_ROW_HEIGHT = 44;

export const TeleprompterDeck: React.FC<TeleprompterDeckProps> = ({
  engineState,
  customHeight,
}) => {
  const [script, setScript] = useState(() => {
    const stored = PrompterStorage.getScript();
    return stored && stored.trim().length > 0 ? stored : FALLBACK_SCRIPT;
  });
  const [speed, setSpeed] = useState(PrompterStorage.getSpeed());
  const [fontSize, setFontSize] = useState(PrompterStorage.getFontSize());
  const [isMirrored, setIsMirrored] = useState(PrompterStorage.getIsMirrored());
  const [editModalVisible, setEditModalVisible] = useState(false);

  // Vertical Pickers: 'font' | 'speed' | null
  const [listPickerType, setListPickerType] = useState<'font' | 'speed' | null>(null);

  // Keyboard Edit Dialog: 'font' | 'speed' | null
  const [keyboardEditType, setKeyboardEditType] = useState<'font' | 'speed' | null>(null);
  const [keyboardInputVal, setKeyboardInputVal] = useState('');

  const [containerHeight, setContainerHeight] = useState(customHeight ?? 140);
  const [contentHeight, setContentHeight] = useState(600);

  const activeViewportHeight = customHeight ?? containerHeight;
  const maxScroll = Math.max(0, contentHeight - activeViewportHeight + 80);

  // Worklet-safe Shared Values (Replaces useRef to prevent worklet modification errors)
  const translateY = useSharedValue(0);
  const startDragY = useSharedValue(0);
  const maxScrollShared = useSharedValue(maxScroll);
  const speedShared = useSharedValue(speed);
  const isRecordingShared = useSharedValue(engineState === 'RECORDING');

  useEffect(() => {
    maxScrollShared.value = maxScroll;
  }, [maxScroll, maxScrollShared]);

  useEffect(() => {
    speedShared.value = speed;
  }, [speed, speedShared]);

  useEffect(() => {
    isRecordingShared.value = engineState === 'RECORDING';
  }, [engineState, isRecordingShared]);

  // Auto-scrolling in RECORDING mode
  useEffect(() => {
    if (engineState === 'RECORDING') {
      if (speed <= 0) {
        cancelAnimation(translateY);
        return;
      }
      const remainingDistance = Math.abs(-maxScroll - translateY.value);
      const durationMs = (remainingDistance / speed) * 1000;

      if (durationMs > 0 && isFinite(durationMs)) {
        translateY.value = withTiming(-maxScroll, {
          duration: durationMs,
          easing: Easing.linear,
        });
      }
    } else if (
      engineState === 'PAUSED' ||
      engineState === 'STOPPED' ||
      engineState === 'IDLE'
    ) {
      cancelAnimation(translateY);
    }
  }, [engineState, speed, maxScroll, translateY]);

  // Clamping when content layout changes
  useEffect(() => {
    if (translateY.value < -maxScroll) {
      translateY.value = withTiming(-maxScroll, { duration: 150 });
    }
  }, [maxScroll, translateY]);

  // Worklet gesture handler using purely shared values
  const panGesture = Gesture.Pan()
    .activeOffsetY([-4, 4])
    .onBegin(() => {
      'worklet';
      cancelAnimation(translateY);
      startDragY.value = translateY.value;
    })
    .onUpdate((e) => {
      'worklet';
      const nextY = startDragY.value + e.translationY;
      translateY.value = Math.max(-maxScrollShared.value, Math.min(0, nextY));
    })
    .onEnd(() => {
      'worklet';
      if (isRecordingShared.value && speedShared.value > 0) {
        const remainingDistance = Math.abs(-maxScrollShared.value - translateY.value);
        const durationMs = (remainingDistance / speedShared.value) * 1000;
        if (durationMs > 0 && isFinite(durationMs)) {
          translateY.value = withTiming(-maxScrollShared.value, {
            duration: durationMs,
            easing: Easing.linear,
          });
        }
      }
    });

  const handleReset = () => {
    cancelAnimation(translateY);
    translateY.value = withTiming(0, {
      duration: 250,
      easing: Easing.out(Easing.quad),
    });
  };

  const handleToggleMirror = () => {
    const next = !isMirrored;
    setIsMirrored(next);
    PrompterStorage.setIsMirrored(next);
  };

  const changeSpeed = (delta: number) => {
    const next = Math.max(0, Math.min(200, speed + delta));
    setSpeed(next);
    PrompterStorage.setSpeed(next);
  };

  const selectSpeed = (val: number) => {
    const clamped = Math.max(0, Math.min(200, val));
    setSpeed(clamped);
    PrompterStorage.setSpeed(clamped);
    setListPickerType(null);
  };

  const changeFontSize = (delta: number) => {
    const next = Math.max(1, Math.min(50, fontSize + delta));
    setFontSize(next);
    PrompterStorage.setFontSize(next);
  };

  const selectFontSize = (val: number) => {
    const clamped = Math.max(1, Math.min(50, val));
    setFontSize(clamped);
    PrompterStorage.setFontSize(clamped);
    setListPickerType(null);
  };

  const handleSaveScript = (newScript: string) => {
    const clean = newScript.trim().length > 0 ? newScript.trim() : FALLBACK_SCRIPT;
    setScript(clean);
    PrompterStorage.setScript(clean);
    handleReset();
  };

  const handleOpenKeyboardEdit = (type: 'font' | 'speed') => {
    setKeyboardEditType(type);
    setKeyboardInputVal(type === 'font' ? String(fontSize) : String(speed));
  };

  const handleSaveKeyboardEdit = () => {
    if (!keyboardEditType) return;
    const parsed = parseInt(keyboardInputVal.trim(), 10);

    if (keyboardEditType === 'font') {
      const target = isNaN(parsed) ? fontSize : Math.max(1, Math.min(50, parsed));
      setFontSize(target);
      PrompterStorage.setFontSize(target);
    } else {
      const target = isNaN(parsed) ? speed : Math.max(0, Math.min(200, parsed));
      setSpeed(target);
      PrompterStorage.setSpeed(target);
    }

    setKeyboardEditType(null);
    Keyboard.dismiss();
  };

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: translateY.value },
      { scaleX: isMirrored ? -1 : 1 },
    ],
  }));

  return (
    <View style={styles.deckContainer}>
      {/* 1. Top Strip (3 Buttons: Script, Reset, Mirror) */}
      <View style={styles.topControlStrip}>
        <TouchableOpacity
          style={styles.solidPillBtn}
          onPress={() => setEditModalVisible(true)}
          activeOpacity={0.7}
        >
          <FileText size={12} color="#FFFFFF" strokeWidth={2.2} />
          <Text style={styles.solidPillBtnText}>Script</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.solidPillBtn}
          onPress={handleReset}
          activeOpacity={0.7}
        >
          <RotateCcw size={12} color="#FFFFFF" strokeWidth={2.2} />
          <Text style={styles.solidPillBtnText}>Reset</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.solidPillBtn, isMirrored && styles.solidPillBtnActive]}
          onPress={handleToggleMirror}
          activeOpacity={0.7}
        >
          <FlipHorizontal
            size={12}
            color={isMirrored ? '#38BDF8' : '#FFFFFF'}
            strokeWidth={2.2}
          />
          <Text
            style={[
              styles.solidPillBtnText,
              isMirrored && styles.solidPillBtnTextActive,
            ]}
          >
            Mirror
          </Text>
        </TouchableOpacity>
      </View>

      {/* 2. Central Scrollable Viewport (Borderless, No Laser) */}
      <View
        style={[styles.viewport, { height: activeViewportHeight }]}
        onLayout={(e: LayoutChangeEvent) => {
          setContainerHeight(e.nativeEvent.layout.height);
        }}
      >
        <GestureDetector gesture={panGesture}>
          <Animated.View
            style={[styles.textWrapper, animatedStyle]}
            onLayout={(e: LayoutChangeEvent) => {
              if (e.nativeEvent.layout.height > 0) {
                setContentHeight(e.nativeEvent.layout.height);
              }
            }}
          >
            <Text
              style={[
                styles.prompterText,
                { fontSize, lineHeight: Math.max(14, Math.round(fontSize * 1.55)) },
              ]}
            >
              {script}
            </Text>
          </Animated.View>
        </GestureDetector>
      </View>

      {/* 3. Bottom Strip (2 Controls: Text Size & Speed) */}
      <View style={styles.bottomControlStrip}>
        {/* Text Size Stepper */}
        <View style={styles.stepperPill}>
          <Type size={11} color="#A1A1AA" />
          <TouchableOpacity
            style={styles.stepperTouch}
            onPress={() => changeFontSize(-1)}
            activeOpacity={0.5}
            hitSlop={{ top: 8, bottom: 8, left: 6, right: 4 }}
          >
            <Minus size={10} color="#FFFFFF" />
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.stepperValTouch}
            onPress={() => setListPickerType('font')}
            onLongPress={() => handleOpenKeyboardEdit('font')}
            delayLongPress={280}
            activeOpacity={0.7}
          >
            <Text style={styles.stepperVal}>{fontSize} px</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.stepperTouch}
            onPress={() => changeFontSize(1)}
            activeOpacity={0.5}
            hitSlop={{ top: 8, bottom: 8, left: 4, right: 6 }}
          >
            <Plus size={10} color="#FFFFFF" />
          </TouchableOpacity>
        </View>

        {/* Speed Stepper */}
        <View style={styles.stepperPill}>
          <Gauge size={11} color="#A1A1AA" />
          <TouchableOpacity
            style={styles.stepperTouch}
            onPress={() => changeSpeed(-5)}
            activeOpacity={0.5}
            hitSlop={{ top: 8, bottom: 8, left: 6, right: 4 }}
          >
            <Minus size={10} color="#FFFFFF" />
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.stepperValTouch}
            onPress={() => setListPickerType('speed')}
            onLongPress={() => handleOpenKeyboardEdit('speed')}
            delayLongPress={280}
            activeOpacity={0.7}
          >
            <Text style={styles.stepperVal}>{speed}</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.stepperTouch}
            onPress={() => changeSpeed(5)}
            activeOpacity={0.5}
            hitSlop={{ top: 8, bottom: 8, left: 4, right: 6 }}
          >
            <Plus size={10} color="#FFFFFF" />
          </TouchableOpacity>
        </View>
      </View>

      {/* Vertical List Selector Modal (1 to 50 for text, 0 to 200 for speed) */}
      <Modal
        visible={listPickerType !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setListPickerType(null)}
      >
        <View style={styles.modalBackdrop}>
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={() => setListPickerType(null)}
          />

          <View style={styles.listPickerCard}>
            <View style={styles.listPickerHeader}>
              <View>
                <Text style={styles.listPickerTitle}>
                  {listPickerType === 'font' ? 'Select Text Size' : 'Select Scroll Speed'}
                </Text>
                <Text style={styles.listPickerSubtitle}>
                  {listPickerType === 'font' ? '1 px to 50 px' : '0 to 200 px/s'}
                </Text>
              </View>
              <TouchableOpacity
                style={styles.closeRoundBtn}
                onPress={() => setListPickerType(null)}
                activeOpacity={0.7}
              >
                <X size={15} color="#FFFFFF" />
              </TouchableOpacity>
            </View>

            <FlatList
              data={listPickerType === 'font' ? ALL_FONT_SIZES : ALL_SPEEDS}
              keyExtractor={(item) => String(item)}
              initialScrollIndex={Math.max(
                0,
                listPickerType === 'font' ? fontSize - 3 : speed - 3
              )}
              onScrollToIndexFailed={() => {}}
              getItemLayout={(_, index) => ({
                length: ITEM_ROW_HEIGHT,
                offset: ITEM_ROW_HEIGHT * index,
                index,
              })}
              renderItem={({ item }) => {
                const isSelected =
                  listPickerType === 'font' ? item === fontSize : item === speed;
                return (
                  <TouchableOpacity
                    style={[
                      styles.valueRowItem,
                      isSelected && styles.valueRowItemActive,
                    ]}
                    onPress={() =>
                      listPickerType === 'font'
                        ? selectFontSize(item)
                        : selectSpeed(item)
                    }
                    activeOpacity={0.7}
                  >
                    <Text
                      style={[
                        styles.valueRowText,
                        isSelected && styles.valueRowTextActive,
                      ]}
                    >
                      {item} {listPickerType === 'font' ? 'px' : ''}
                    </Text>
                    {isSelected && <Check size={16} color="#38BDF8" strokeWidth={2.8} />}
                  </TouchableOpacity>
                );
              }}
              showsVerticalScrollIndicator={true}
              contentContainerStyle={styles.listPickerScrollContent}
            />
          </View>
        </View>
      </Modal>

      {/* Manual Keyboard Input Modal (Triggered on Touch & Hold) */}
      <Modal
        visible={keyboardEditType !== null}
        transparent
        animationType="fade"
        onRequestClose={() => {
          setKeyboardEditType(null);
          Keyboard.dismiss();
        }}
      >
        <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
          <View style={styles.modalBackdrop}>
            <View style={styles.keyboardCard}>
              <View style={styles.keyboardHeader}>
                <View style={styles.keyboardIconCircle}>
                  <KeyboardIcon size={16} color="#38BDF8" strokeWidth={2.2} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.keyboardTitle}>
                    {keyboardEditType === 'font' ? 'Edit Text Size' : 'Edit Scroll Speed'}
                  </Text>
                  <Text style={styles.keyboardSubtitle}>
                    {keyboardEditType === 'font'
                      ? 'Type an integer from 1 to 50 px'
                      : 'Type an integer from 0 to 200'}
                  </Text>
                </View>
              </View>

              <View style={styles.keyboardInputRow}>
                <TextInput
                  style={styles.keyboardNumericInput}
                  value={keyboardInputVal}
                  onChangeText={setKeyboardInputVal}
                  keyboardType="number-pad"
                  autoFocus
                  selectTextOnFocus
                  maxLength={3}
                  returnKeyType="done"
                  onSubmitEditing={handleSaveKeyboardEdit}
                />
                <Text style={styles.keyboardUnit}>
                  {keyboardEditType === 'font' ? 'px' : 'speed'}
                </Text>
              </View>

              <View style={styles.keyboardActionRow}>
                <TouchableOpacity
                  style={styles.keyboardCancelBtn}
                  onPress={() => {
                    setKeyboardEditType(null);
                    Keyboard.dismiss();
                  }}
                  activeOpacity={0.7}
                >
                  <Text style={styles.keyboardCancelText}>Cancel</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.keyboardSaveBtn}
                  onPress={handleSaveKeyboardEdit}
                  activeOpacity={0.8}
                >
                  <Check size={14} color="#000000" strokeWidth={3} />
                  <Text style={styles.keyboardSaveText}>Apply</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </TouchableWithoutFeedback>
      </Modal>

      <PrompterEditModal
        visible={editModalVisible}
        initialScript={script}
        onSave={handleSaveScript}
        onClose={() => setEditModalVisible(false)}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  deckContainer: {
    width: '100%',
    backgroundColor: '#09090B',
    borderRadius: 18,
    overflow: 'hidden',
  },

  /* Top 3-Button Strip */
  topControlStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    backgroundColor: '#0E0E12',
    zIndex: 2,
  },
  solidPillBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 14,
    backgroundColor: '#18181D',
    borderWidth: 1,
    borderColor: '#26262F',
  },
  solidPillBtnActive: {
    backgroundColor: '#16222F',
    borderColor: '#2563EB',
  },
  solidPillBtnText: {
    color: '#F4F4F5',
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  solidPillBtnTextActive: {
    color: '#38BDF8',
  },

  /* Viewport Area */
  viewport: {
    backgroundColor: '#060608',
    overflow: 'hidden',
    position: 'relative',
    justifyContent: 'flex-start',
    width: '100%',
  },
  textWrapper: {
    width: '100%',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 220,
  },
  prompterText: {
    color: '#FFFFFF',
    fontWeight: '400',
    textAlign: 'center',
    letterSpacing: 0.2,
  },

  /* Bottom 2-Control Strip */
  bottomControlStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#0E0E12',
    zIndex: 2,
  },
  stepperPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 14,
    backgroundColor: '#18181D',
    borderWidth: 1,
    borderColor: '#26262F',
    gap: 5,
  },
  stepperTouch: {
    width: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperValTouch: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
  },
  stepperVal: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
    minWidth: 32,
    textAlign: 'center',
  },

  /* Modal Styles */
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.82)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  listPickerCard: {
    width: '100%',
    maxWidth: 320,
    height: 420,
    backgroundColor: '#141418',
    borderRadius: 22,
    borderWidth: 1,
    borderColor: '#26262F',
    overflow: 'hidden',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
  },
  listPickerHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#202028',
    marginBottom: 6,
  },
  listPickerTitle: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  listPickerSubtitle: {
    color: '#8E8E93',
    fontSize: 11,
    marginTop: 2,
  },
  closeRoundBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#202028',
    alignItems: 'center',
    justifyContent: 'center',
  },
  listPickerScrollContent: {
    paddingVertical: 4,
  },
  valueRowItem: {
    height: ITEM_ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    borderRadius: 10,
    marginVertical: 1,
  },
  valueRowItemActive: {
    backgroundColor: 'rgba(56, 189, 248, 0.12)',
  },
  valueRowText: {
    color: '#A1A1AA',
    fontSize: 15,
    fontWeight: '500',
    fontVariant: ['tabular-nums'],
  },
  valueRowTextActive: {
    color: '#38BDF8',
    fontWeight: '700',
  },

  /* Keyboard Dialog Card */
  keyboardCard: {
    width: '100%',
    maxWidth: 320,
    backgroundColor: '#141418',
    borderRadius: 22,
    borderWidth: 1,
    borderColor: '#26262F',
    padding: 20,
  },
  keyboardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 16,
  },
  keyboardIconCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(56, 189, 248, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyboardTitle: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  keyboardSubtitle: {
    color: '#8E8E93',
    fontSize: 11,
    marginTop: 2,
  },
  keyboardInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#09090C',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#24242C',
    height: 48,
    paddingHorizontal: 16,
    marginBottom: 18,
    gap: 6,
  },
  keyboardNumericInput: {
    color: '#38BDF8',
    fontSize: 20,
    fontWeight: '700',
    textAlign: 'center',
    minWidth: 60,
    padding: 0,
    fontVariant: ['tabular-nums'],
  },
  keyboardUnit: {
    color: '#71717A',
    fontSize: 13,
    fontWeight: '600',
  },
  keyboardActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  keyboardCancelBtn: {
    flex: 1,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#1E1E24',
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyboardCancelText: {
    color: '#8E8E93',
    fontSize: 13,
    fontWeight: '600',
  },
  keyboardSaveBtn: {
    flex: 1.2,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#FFFFFF',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  keyboardSaveText: {
    color: '#000000',
    fontSize: 13,
    fontWeight: '700',
  },
});