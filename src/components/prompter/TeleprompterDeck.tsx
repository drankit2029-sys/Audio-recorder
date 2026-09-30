import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
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
  Platform,
} from 'react-native';
import {
  Canvas,
  Text as SkiaText,
  matchFont,
  Rect,
  LinearGradient,
  vec,
  Group,
} from '@shopify/react-native-skia';
import Animated, {
  SharedValue,
  useSharedValue,
  useDerivedValue,
  useAnimatedStyle,
  useFrameCallback,
  withTiming,
  cancelAnimation,
  Easing,
  runOnJS,
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
  Play,
  Pause,
  UnfoldVertical,
  Keyboard as KeyboardIcon,
} from 'lucide-react-native';

import {
  PrompterStorage,
  clampLineSpacing,
  MIN_LINE_SPACING,
  MAX_LINE_SPACING,
} from '../../services/storage/prompterStorage';
import { PrompterEditModal } from './PrompterEditModal';
import { EngineState } from '../../services/audio/useStudioSession';

export interface TeleprompterDeckProps {
  engineState: EngineState;
  /** Status-bar inset, forwarded so the in-modal toast clears the notch. */
  topInset?: number;
  /** Studio playhead: the script position follows it while synced. */
  playheadMs: SharedValue<number>;
  /** The waveform is being dragged: the script follows it. */
  isScrubbing: SharedValue<boolean>;
  /** Recording or previewing. */
  isRunning: SharedValue<boolean>;
  /**
   * Bumped when a take is opened for editing or recovered, so the script is
   * re-aligned to "speed x playhead" from the top of the text.
   */
  syncResetKey?: number;
}

type StepperKind = 'font' | 'speed' | 'spacing';

const FALLBACK_SCRIPT = `Welcome to the studio. This is your synchronized teleprompter.

Speak with a steady, natural cadence and maintain consistent distance from the microphone capsule.

Watch the real-time Skia meter below to protect your dynamic range. Target your speech peaks between -18 dBFS and -6 dBFS for broadcast-ready master audio.

Use the Mirror toggle if you are shooting through a beam-splitter glass rig, or adjust the speed stepper above to match your reading tempo.`;

const MAX_FONT_SIZE = 34;
const ALL_FONT_SIZES = Array.from({ length: MAX_FONT_SIZE }, (_, i) => i + 1);
const ALL_SPEEDS = Array.from({ length: 201 }, (_, i) => i);
const ALL_SPACINGS = Array.from(
  { length: Math.round((MAX_LINE_SPACING - MIN_LINE_SPACING) * 10) + 1 },
  (_, i) => Math.round((MIN_LINE_SPACING + i / 10) * 10) / 10
);
const formatSpacing = (v: number) => `${v.toFixed(1)}×`;
const ITEM_ROW_HEIGHT = 44;
const FALLBACK_VIEWPORT = 160;

export const TeleprompterDeck: React.FC<TeleprompterDeckProps> = ({
  engineState,
  topInset = 0,
  playheadMs,
  isScrubbing,
  isRunning,
  syncResetKey = 0,
}) => {
  const [script, setScript] = useState(() => {
    const stored = PrompterStorage.getScript();
    return stored && stored.trim().length > 0 ? stored : FALLBACK_SCRIPT;
  });
  const [speed, setSpeed] = useState(() => PrompterStorage.getSpeed() || 35);
  const [fontSize, setFontSize] = useState(() =>
    Math.min(MAX_FONT_SIZE, PrompterStorage.getFontSize() || 22)
  );
  const [lineSpacing, setLineSpacing] = useState(() => PrompterStorage.getLineSpacing());
  const [isMirrored, setIsMirrored] = useState(() => !!PrompterStorage.getIsMirrored());
  const [isAutoScrolling, setIsAutoScrolling] = useState(false);
  const [editModalVisible, setEditModalVisible] = useState(false);

  const [listPickerType, setListPickerType] = useState<StepperKind | null>(null);
  const [keyboardEditType, setKeyboardEditType] = useState<StepperKind | null>(null);
  const [stripWidth, setStripWidth] = useState(360);
  const [keyboardInputVal, setKeyboardInputVal] = useState('');

  const [canvasLayout, setCanvasLayout] = useState({
    width: 360,
    height: FALLBACK_VIEWPORT,
  });

  const prevEngineStateRef = useRef<EngineState>(engineState);

  const activeViewportHeight = Math.max(72, canvasLayout.height);
  /** Three steppers share the strip; tighten them on phone-width decks. */
  const isCompactStrip = stripWidth < 400;

  const safeFontSize = Math.min(
    MAX_FONT_SIZE,
    Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 22
  );

  const skiaFont = useMemo(() => {
    try {
      const family = Platform.select({ ios: 'Helvetica', default: 'sans-serif' });
      return matchFont({
        fontFamily: family,
        fontSize: safeFontSize,
        fontStyle: 'normal',
        fontWeight: 'bold',
      });
    } catch {
      return null;
    }
  }, [safeFontSize]);

  const safeSpacing = clampLineSpacing(lineSpacing);

  /** Line pitch = text size x line spacing (the bottom-strip stepper). */
  const chunkHeight = useMemo(
    () => Math.max(1, Math.round(safeFontSize * safeSpacing)),
    [safeFontSize, safeSpacing]
  );

  const chunks = useMemo(() => {
    if (!script) return [''];
    if (!skiaFont) return script.split('\n');

    const maxLineWidth = Math.max(120, canvasLayout.width - 56);
    const paragraphs = script.split('\n');
    const lines: string[] = [];

    for (const rawPara of paragraphs) {
      const para = rawPara.trim();
      if (!para) {
        lines.push('');
        continue;
      }

      const words = para.split(/\s+/).filter(Boolean);
      let currentLine = '';

      for (const word of words) {
        if (!currentLine) {
          currentLine = word;
          continue;
        }

        const candidateLine = `${currentLine} ${word}`;
        const candidateWidth = skiaFont.measureText(candidateLine).width;

        if (candidateWidth <= maxLineWidth) {
          currentLine = candidateLine;
        } else {
          lines.push(currentLine);
          currentLine = word;
        }
      }

      if (currentLine) lines.push(currentLine);
    }

    return lines.length > 0 ? lines : [''];
  }, [script, skiaFont, canvasLayout.width]);

  const preparedChunks = useMemo(() => {
    // The first line sits in the upper part of the viewport whatever the
    // spacing, so wide spacing never starts the script off screen.
    const firstCenter = Math.min(chunkHeight * 1.5, activeViewportHeight * 0.45);
    const baselineShift = safeFontSize * 0.35;
    return chunks.map((text, i) => {
      const textWidth = skiaFont ? skiaFont.measureText(text).width : 0;
      const x = Math.max(16, (canvasLayout.width - textWidth) / 2);
      const y = firstCenter + i * chunkHeight + baselineShift;
      return { text, x, y };
    });
  }, [chunks, chunkHeight, safeFontSize, skiaFont, canvasLayout.width, activeViewportHeight]);

  const maxScroll = Math.max(0, (chunks.length - 1) * chunkHeight);

  const translateY = useSharedValue(0);
  const startDragY = useSharedValue(0);
  const isDraggingShared = useSharedValue(false);
  const maxScrollShared = useSharedValue(maxScroll);
  const speedShared = useSharedValue(speed);
  const fontSizeShared = useSharedValue(safeFontSize);
  const isAutoScrollingShared = useSharedValue(false);

  const startFontScrub = useSharedValue(safeFontSize);
  const isScrubbingFont = useSharedValue(false);
  const startSpeedScrub = useSharedValue(speed);
  const isScrubbingSpeed = useSharedValue(false);
  const spacingShared = useSharedValue(safeSpacing);
  const startSpacingScrub = useSharedValue(safeSpacing);
  const isScrubbingSpacing = useSharedValue(false);

  /**
   * Script offset = speed x playhead + userOffset. userOffset keeps manual
   * drags, the Reset button and free scrolling continuous with the synced
   * position, so nothing jumps when recording, previewing or scrubbing starts.
   */
  const userOffset = useSharedValue(0);
  const lastSyncSpeed = useSharedValue(speed);
  const pendingSnap = useSharedValue(false);

  useEffect(() => { maxScrollShared.value = maxScroll; }, [maxScroll, maxScrollShared]);
  useEffect(() => { speedShared.value = speed; }, [speed, speedShared]);
  useEffect(() => { fontSizeShared.value = safeFontSize; }, [safeFontSize, fontSizeShared]);
  useEffect(() => { isAutoScrollingShared.value = isAutoScrolling; }, [isAutoScrolling, isAutoScrollingShared]);
  useEffect(() => { spacingShared.value = safeSpacing; }, [safeSpacing, spacingShared]);

  /**
   * Makes a scroll position the reference for "speed x playhead". The
   * position is passed in when it was just assigned from JS, because a JS
   * write to a shared value lands on the UI thread asynchronously.
   */
  const realignToPlayhead = useCallback(
    (scrollY?: number) => {
      const y = typeof scrollY === 'number' ? scrollY : translateY.value;
      userOffset.value = -y - speedShared.value * (playheadMs.value / 1000);
      lastSyncSpeed.value = speedShared.value;
    },
    [userOffset, translateY, speedShared, playheadMs, lastSyncSpeed]
  );

  // Opening a take for editing / recovering it aligns the script to the take.
  useEffect(() => {
    if (syncResetKey <= 0) return;
    cancelAnimation(translateY);
    userOffset.value = 0;
    pendingSnap.value = true;
  }, [syncResetKey, translateY, userOffset, pendingSnap]);

  useEffect(() => {
    const prev = prevEngineStateRef.current;
    prevEngineStateRef.current = engineState;

    if (engineState === 'RECORDING' || engineState === 'PREVIEWING') {
      if (prev === 'IDLE' && engineState === 'RECORDING') {
        // A brand new take: start from wherever the script was left, or from
        // the top if it had already been read to the end.
        cancelAnimation(translateY);
        let y = translateY.value;
        if (y <= -maxScrollShared.value + 2) {
          y = 0;
          translateY.value = 0;
        }
        userOffset.value = -y;
        lastSyncSpeed.value = speedShared.value;
      }
      setIsAutoScrolling(true);
    } else if (engineState === 'PAUSED') {
      setIsAutoScrolling(false);
    } else if (engineState === 'STOPPED' || engineState === 'IDLE') {
      setIsAutoScrolling(false);
      if (prev !== 'IDLE') {
        cancelAnimation(translateY);
        userOffset.value = 0;
        translateY.value = withTiming(0, { duration: 250, easing: Easing.out(Easing.quad) });
      }
    }
  }, [engineState, translateY, maxScrollShared, speedShared, userOffset, lastSyncSpeed]);

  useFrameCallback((frameInfo) => {
    'worklet';
    if (isDraggingShared.value) return;
    const sp = speedShared.value;
    const max = maxScrollShared.value;
    const t = playheadMs.value / 1000;

    if (pendingSnap.value) {
      pendingSnap.value = false;
      translateY.value = -Math.max(0, Math.min(max, sp * t + userOffset.value));
      lastSyncSpeed.value = sp;
      return;
    }

    const synced = isScrubbing.value || (isRunning.value && isAutoScrollingShared.value);
    if (synced) {
      if (sp !== lastSyncSpeed.value) {
        // Speed changed mid-take: keep the current line under the reader.
        userOffset.value = -translateY.value - sp * t;
        lastSyncSpeed.value = sp;
      }
      translateY.value = -Math.max(0, Math.min(max, sp * t + userOffset.value));
      return;
    }

    if (!isAutoScrollingShared.value || sp <= 0 || max <= 0) return;

    // Free scrolling (rehearsal while idle or paused).
    const rawDt = frameInfo.timeSincePreviousFrame;
    if (rawDt === null || rawDt === undefined || rawDt <= 0) return;
    const dtSeconds = Math.min(rawDt, 64) / 1000;
    const nextY = translateY.value - sp * dtSeconds;
    translateY.value = nextY <= -max ? -max : nextY;
    userOffset.value = -translateY.value - sp * t;
    lastSyncSpeed.value = sp;
  });

  const prompterPanGesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetY([-4, 4])
        .onBegin(() => {
          'worklet';
          cancelAnimation(translateY);
          isDraggingShared.value = true;
          startDragY.value = translateY.value;
        })
        .onUpdate((e) => {
          'worklet';
          const nextY = startDragY.value + e.translationY;
          translateY.value = Math.max(-maxScrollShared.value, Math.min(0, nextY));
        })
        .onEnd(() => {
          'worklet';
          isDraggingShared.value = false;
          userOffset.value = -translateY.value - speedShared.value * (playheadMs.value / 1000);
          lastSyncSpeed.value = speedShared.value;
        })
        .onFinalize(() => { 'worklet'; isDraggingShared.value = false; }),
    [translateY, startDragY, isDraggingShared, maxScrollShared, userOffset, speedShared, playheadMs, lastSyncSpeed]
  );

  const canvasGroupTransform = useDerivedValue(() => [{ translateY: translateY.value }]);

  const handleToggleAutoScroll = () => {
    if (isAutoScrolling) {
      setIsAutoScrolling(false);
    } else {
      if (translateY.value <= -maxScroll + 2) {
        translateY.value = 0;
        realignToPlayhead(0);
      } else {
        realignToPlayhead();
      }
      setIsAutoScrolling(true);
    }
  };

  const handleReset = () => {
    setIsAutoScrolling(false);
    isDraggingShared.value = false;
    cancelAnimation(translateY);
    startDragY.value = 0;
    // The top of the script becomes the reference for the current playhead.
    userOffset.value = -speedShared.value * (playheadMs.value / 1000);
    lastSyncSpeed.value = speedShared.value;
    translateY.value = withTiming(0, { duration: 250, easing: Easing.out(Easing.quad) });
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
    const next = Math.max(1, Math.min(MAX_FONT_SIZE, fontSize + delta));
    setFontSize(next);
    PrompterStorage.setFontSize(next);
  };

  const selectFontSize = (val: number) => {
    const clamped = Math.max(1, Math.min(MAX_FONT_SIZE, val));
    setFontSize(clamped);
    PrompterStorage.setFontSize(clamped);
    setListPickerType(null);
  };

  const changeLineSpacing = (delta: number) => {
    const next = clampLineSpacing(safeSpacing + delta);
    setLineSpacing(next);
    PrompterStorage.setLineSpacing(next);
  };

  const selectLineSpacing = (val: number) => {
    const clamped = clampLineSpacing(val);
    setLineSpacing(clamped);
    PrompterStorage.setLineSpacing(clamped);
    setListPickerType(null);
  };

  const onScrubSpacingUpdate = useCallback((val: number) => setLineSpacing(val), []);
  const onScrubSpacingEnd = useCallback((val: number) => PrompterStorage.setLineSpacing(val), []);

  const onScrubFontSizeUpdate = useCallback((val: number) => setFontSize(val), []);
  const onScrubFontSizeEnd = useCallback((val: number) => PrompterStorage.setFontSize(val), []);
  const onScrubSpeedUpdate = useCallback((val: number) => setSpeed(val), []);
  const onScrubSpeedEnd = useCallback((val: number) => PrompterStorage.setSpeed(val), []);

  const handleOpenKeyboardEdit = useCallback(
    (type: StepperKind) => {
      setKeyboardEditType(type);
      setKeyboardInputVal(
        type === 'font' ? String(safeFontSize) : type === 'speed' ? String(speed) : safeSpacing.toFixed(1)
      );
    },
    [safeFontSize, speed, safeSpacing]
  );

  const fontScrubGesture = useMemo(() => {
    const pan = Gesture.Pan()
      .activeOffsetX([-5, 5])
      .failOffsetY([-12, 12])
      .onBegin(() => {
        'worklet';
        startFontScrub.value = fontSizeShared.value;
        isScrubbingFont.value = true;
      })
      .onUpdate((e) => {
        'worklet';
        const delta = Math.round(e.translationX / 8);
        const next = Math.max(1, Math.min(MAX_FONT_SIZE, startFontScrub.value + delta));
        if (next !== fontSizeShared.value) {
          fontSizeShared.value = next;
          runOnJS(onScrubFontSizeUpdate)(next);
        }
      })
      .onEnd(() => { 'worklet'; runOnJS(onScrubFontSizeEnd)(fontSizeShared.value); })
      .onFinalize(() => { 'worklet'; isScrubbingFont.value = false; });

    const tap = Gesture.Tap().onEnd((_e, success) => {
      'worklet';
      if (success) runOnJS(setListPickerType)('font');
    });

    const longPress = Gesture.LongPress().minDuration(280).onEnd((_e, success) => {
      'worklet';
      if (success) runOnJS(handleOpenKeyboardEdit)('font');
    });

    return Gesture.Exclusive(pan, longPress, tap);
  }, [fontSizeShared, startFontScrub, isScrubbingFont, onScrubFontSizeUpdate, onScrubFontSizeEnd, handleOpenKeyboardEdit]);

  const speedScrubGesture = useMemo(() => {
    const pan = Gesture.Pan()
      .activeOffsetX([-5, 5])
      .failOffsetY([-12, 12])
      .onBegin(() => {
        'worklet';
        startSpeedScrub.value = speedShared.value;
        isScrubbingSpeed.value = true;
      })
      .onUpdate((e) => {
        'worklet';
        const delta = Math.round(e.translationX / 2);
        const next = Math.max(0, Math.min(200, startSpeedScrub.value + delta));
        if (next !== speedShared.value) {
          speedShared.value = next;
          runOnJS(onScrubSpeedUpdate)(next);
        }
      })
      .onEnd(() => { 'worklet'; runOnJS(onScrubSpeedEnd)(speedShared.value); })
      .onFinalize(() => { 'worklet'; isScrubbingSpeed.value = false; });

    const tap = Gesture.Tap().onEnd((_e, success) => {
      'worklet';
      if (success) runOnJS(setListPickerType)('speed');
    });

    const longPress = Gesture.LongPress().minDuration(280).onEnd((_e, success) => {
      'worklet';
      if (success) runOnJS(handleOpenKeyboardEdit)('speed');
    });

    return Gesture.Exclusive(pan, longPress, tap);
  }, [speedShared, startSpeedScrub, isScrubbingSpeed, onScrubSpeedUpdate, onScrubSpeedEnd, handleOpenKeyboardEdit]);

  const spacingScrubGesture = useMemo(() => {
    const pan = Gesture.Pan()
      .activeOffsetX([-5, 5])
      .failOffsetY([-12, 12])
      .onBegin(() => {
        'worklet';
        startSpacingScrub.value = spacingShared.value;
        isScrubbingSpacing.value = true;
      })
      .onUpdate((e) => {
        'worklet';
        const steps = Math.round(e.translationX / 8);
        const raw = startSpacingScrub.value + steps / 10;
        const next = Math.round(Math.max(MIN_LINE_SPACING, Math.min(MAX_LINE_SPACING, raw)) * 10) / 10;
        if (next !== spacingShared.value) {
          spacingShared.value = next;
          runOnJS(onScrubSpacingUpdate)(next);
        }
      })
      .onEnd(() => { 'worklet'; runOnJS(onScrubSpacingEnd)(spacingShared.value); })
      .onFinalize(() => { 'worklet'; isScrubbingSpacing.value = false; });

    const tap = Gesture.Tap().onEnd((_e, success) => {
      'worklet';
      if (success) runOnJS(setListPickerType)('spacing');
    });

    const longPress = Gesture.LongPress().minDuration(280).onEnd((_e, success) => {
      'worklet';
      if (success) runOnJS(handleOpenKeyboardEdit)('spacing');
    });

    return Gesture.Exclusive(pan, longPress, tap);
  }, [spacingShared, startSpacingScrub, isScrubbingSpacing, onScrubSpacingUpdate, onScrubSpacingEnd, handleOpenKeyboardEdit]);

  const fontPillAnimStyle = useAnimatedStyle(() => ({
    backgroundColor: isScrubbingFont.value ? 'rgba(255, 255, 255, 0.18)' : 'rgba(255, 255, 255, 0.04)',
    borderColor: isScrubbingFont.value ? '#FFFFFF' : 'transparent',
    shadowColor: '#FFFFFF',
    shadowOpacity: isScrubbingFont.value ? 0.4 : 0,
    shadowRadius: 10,
    elevation: isScrubbingFont.value ? 8 : 0,
  }));

  const speedPillAnimStyle = useAnimatedStyle(() => ({
    backgroundColor: isScrubbingSpeed.value ? 'rgba(255, 255, 255, 0.18)' : 'rgba(255, 255, 255, 0.04)',
    borderColor: isScrubbingSpeed.value ? '#FFFFFF' : 'transparent',
    shadowColor: '#FFFFFF',
    shadowOpacity: isScrubbingSpeed.value ? 0.4 : 0,
    shadowRadius: 10,
    elevation: isScrubbingSpeed.value ? 8 : 0,
  }));

  const spacingPillAnimStyle = useAnimatedStyle(() => ({
    backgroundColor: isScrubbingSpacing.value ? 'rgba(255, 255, 255, 0.18)' : 'rgba(255, 255, 255, 0.04)',
    borderColor: isScrubbingSpacing.value ? '#FFFFFF' : 'transparent',
    shadowColor: '#FFFFFF',
    shadowOpacity: isScrubbingSpacing.value ? 0.4 : 0,
    shadowRadius: 10,
    elevation: isScrubbingSpacing.value ? 8 : 0,
  }));

  const handleSaveScript = (newScript: string) => {
    const clean = newScript.trim().length > 0 ? newScript.trim() : FALLBACK_SCRIPT;
    setScript(clean);
    PrompterStorage.setScript(clean);
    handleReset();
  };

  const handleSaveKeyboardEdit = () => {
    if (!keyboardEditType) return;
    const parsed = parseInt(keyboardInputVal.trim(), 10);

    if (keyboardEditType === 'spacing') {
      const parsedSpacing = parseFloat(keyboardInputVal.trim().replace(',', '.'));
      const target = isNaN(parsedSpacing) ? safeSpacing : clampLineSpacing(parsedSpacing);
      setLineSpacing(target);
      PrompterStorage.setLineSpacing(target);
    } else if (keyboardEditType === 'font') {
      const target = isNaN(parsed) ? fontSize : Math.max(1, Math.min(MAX_FONT_SIZE, parsed));
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

  const handleViewportLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (width > 0 && height > 0) {
      setCanvasLayout((prev) =>
        Math.abs(prev.width - width) < 1 && Math.abs(prev.height - height) < 1
          ? prev
          : { width, height }
      );
    }
  };

  return (
    <View style={styles.deckContainer}>
      <View style={styles.topControlStrip}>
        <TouchableOpacity
          style={styles.solidPillBtn}
          onPress={() => setEditModalVisible(true)}
          activeOpacity={0.7}
          hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
        >
          <FileText size={12} color="#FFFFFF" strokeWidth={2.2} />
          <Text style={styles.solidPillBtnText} maxFontSizeMultiplier={1.3}>Script</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.solidPillBtn, isAutoScrolling && styles.solidPillBtnActive]}
          onPress={handleToggleAutoScroll}
          activeOpacity={0.7}
          hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
        >
          {isAutoScrolling ? (
            <Pause size={12} color="#FFFFFF" strokeWidth={2.2} />
          ) : (
            <Play size={12} color="#FFFFFF" strokeWidth={2.2} />
          )}
          <Text style={[styles.solidPillBtnText, isAutoScrolling && styles.solidPillBtnTextActive]}>
            {isAutoScrolling ? 'Pause' : 'Scroll'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.solidPillBtn}
          onPress={handleReset}
          activeOpacity={0.7}
          hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
        >
          <RotateCcw size={12} color="#FFFFFF" strokeWidth={2.2} />
          <Text style={styles.solidPillBtnText} maxFontSizeMultiplier={1.3}>Reset</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.solidPillBtn, isMirrored && styles.solidPillBtnActive]}
          onPress={handleToggleMirror}
          activeOpacity={0.7}
          hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
        >
          <FlipHorizontal size={12} color={isMirrored ? '#FFFFFF' : '#FFFFFF'} strokeWidth={2.2} />
          <Text style={[styles.solidPillBtnText, isMirrored && styles.solidPillBtnTextActive]}>
            Mirror
          </Text>
        </TouchableOpacity>
      </View>

      <GestureDetector gesture={prompterPanGesture}>
        <View style={styles.viewport} collapsable={false} onLayout={handleViewportLayout}>
          {skiaFont ? (
            <Canvas style={{ width: canvasLayout.width, height: canvasLayout.height }}>
              <Group
                origin={vec(canvasLayout.width / 2, canvasLayout.height / 2)}
                transform={[{ scaleX: isMirrored ? -1 : 1 }]}
              >
                <Group transform={canvasGroupTransform}>
                  {preparedChunks.map((item, idx) => (
                    <SkiaText
                      key={`chunk-${idx}`}
                      x={item.x}
                      y={item.y}
                      text={item.text}
                      font={skiaFont}
                      color="#FFFFFF"
                    />
                  ))}
                </Group>
              </Group>

              <Rect x={0} y={0} width={canvasLayout.width} height={canvasLayout.height}>
                <LinearGradient
                  start={vec(0, 0)}
                  end={vec(0, canvasLayout.height)}
                  colors={[
                    '#060608',
                    'rgba(6, 6, 8, 0.85)',
                    'rgba(6, 6, 8, 0.35)',
                    'rgba(6, 6, 8, 0)',
                    'rgba(6, 6, 8, 0)',
                    'rgba(6, 6, 8, 0.35)',
                    'rgba(6, 6, 8, 0.85)',
                    '#060608',
                  ]}
                  positions={[0.0, 0.16, 0.32, 0.44, 0.56, 0.68, 0.84, 1.0]}
                />
              </Rect>
            </Canvas>
          ) : (
            <View style={styles.loadingPlaceholder} />
          )}
        </View>
      </GestureDetector>

      <View
        style={[styles.bottomControlStrip, isCompactStrip && styles.bottomControlStripCompact]}
        onLayout={(e) => {
          const w = Math.round(e.nativeEvent.layout.width);
          if (w > 0 && Math.abs(w - stripWidth) > 1) setStripWidth(w);
        }}
      >
        <View style={[styles.stepperPill, isCompactStrip && styles.stepperPillCompact]}>
          <Type size={11} color="#A1A1AA" />
          <TouchableOpacity
            style={[styles.stepperTouch, isCompactStrip && styles.stepperTouchCompact]}
            onPress={() => changeFontSize(-1)}
            activeOpacity={0.5}
            hitSlop={{ top: 8, bottom: 8, left: 6, right: 4 }}
          >
            <Minus size={10} color="#FFFFFF" />
          </TouchableOpacity>

          <GestureDetector gesture={fontScrubGesture}>
            <Animated.View style={[styles.stepperValTouch, isCompactStrip && styles.stepperValTouchCompact, fontPillAnimStyle]}>
              <Text style={[styles.stepperVal, isCompactStrip && styles.stepperValCompact]} maxFontSizeMultiplier={1.2}>
                {isCompactStrip ? `${safeFontSize}px` : `${safeFontSize} px`}
              </Text>
            </Animated.View>
          </GestureDetector>

          <TouchableOpacity
            style={[styles.stepperTouch, isCompactStrip && styles.stepperTouchCompact]}
            onPress={() => changeFontSize(1)}
            activeOpacity={0.5}
            hitSlop={{ top: 8, bottom: 8, left: 4, right: 6 }}
          >
            <Plus size={10} color="#FFFFFF" />
          </TouchableOpacity>
        </View>

        <View style={[styles.stepperPill, isCompactStrip && styles.stepperPillCompact]}>
          <Gauge size={11} color="#A1A1AA" />
          <TouchableOpacity
            style={[styles.stepperTouch, isCompactStrip && styles.stepperTouchCompact]}
            onPress={() => changeSpeed(-5)}
            activeOpacity={0.5}
            hitSlop={{ top: 8, bottom: 8, left: 6, right: 4 }}
          >
            <Minus size={10} color="#FFFFFF" />
          </TouchableOpacity>

          <GestureDetector gesture={speedScrubGesture}>
            <Animated.View style={[styles.stepperValTouch, isCompactStrip && styles.stepperValTouchCompact, speedPillAnimStyle]}>
              <Text style={[styles.stepperVal, isCompactStrip && styles.stepperValCompact]} maxFontSizeMultiplier={1.2}>
                {speed}
              </Text>
            </Animated.View>
          </GestureDetector>

          <TouchableOpacity
            style={[styles.stepperTouch, isCompactStrip && styles.stepperTouchCompact]}
            onPress={() => changeSpeed(5)}
            activeOpacity={0.5}
            hitSlop={{ top: 8, bottom: 8, left: 4, right: 6 }}
          >
            <Plus size={10} color="#FFFFFF" />
          </TouchableOpacity>
        </View>

        <View style={[styles.stepperPill, isCompactStrip && styles.stepperPillCompact]}>
          <UnfoldVertical size={11} color="#A1A1AA" />
          <TouchableOpacity
            style={[styles.stepperTouch, isCompactStrip && styles.stepperTouchCompact]}
            onPress={() => changeLineSpacing(-0.1)}
            activeOpacity={0.5}
            hitSlop={{ top: 8, bottom: 8, left: 6, right: 4 }}
            accessibilityLabel="Decrease line spacing"
          >
            <Minus size={10} color="#FFFFFF" />
          </TouchableOpacity>

          <GestureDetector gesture={spacingScrubGesture}>
            <Animated.View style={[styles.stepperValTouch, isCompactStrip && styles.stepperValTouchCompact, spacingPillAnimStyle]}>
              <Text style={[styles.stepperVal, isCompactStrip && styles.stepperValCompact]} maxFontSizeMultiplier={1.2}>
                {formatSpacing(safeSpacing)}
              </Text>
            </Animated.View>
          </GestureDetector>

          <TouchableOpacity
            style={[styles.stepperTouch, isCompactStrip && styles.stepperTouchCompact]}
            onPress={() => changeLineSpacing(0.1)}
            activeOpacity={0.5}
            hitSlop={{ top: 8, bottom: 8, left: 4, right: 6 }}
            accessibilityLabel="Increase line spacing"
          >
            <Plus size={10} color="#FFFFFF" />
          </TouchableOpacity>
        </View>
      </View>

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
              <View style={{ flex: 1 }}>
                <Text style={styles.listPickerTitle}>
                  {listPickerType === 'font'
                    ? 'Select Text Size'
                    : listPickerType === 'spacing'
                    ? 'Select Line Spacing'
                    : 'Select Scroll Speed'}
                </Text>
                <Text style={styles.listPickerSubtitle}>
                  {listPickerType === 'font'
                    ? `1 px to ${MAX_FONT_SIZE} px`
                    : listPickerType === 'spacing'
                    ? `${formatSpacing(MIN_LINE_SPACING)} to ${formatSpacing(MAX_LINE_SPACING)} the text size`
                    : '0 to 200 px/s'}
                </Text>
              </View>
              <TouchableOpacity style={styles.closeRoundBtn} onPress={() => setListPickerType(null)} activeOpacity={0.7}>
                <X size={15} color="#FFFFFF" />
              </TouchableOpacity>
            </View>

            <FlatList
              data={
                listPickerType === 'font'
                  ? ALL_FONT_SIZES
                  : listPickerType === 'spacing'
                  ? ALL_SPACINGS
                  : ALL_SPEEDS
              }
              keyExtractor={(item) => String(item)}
              initialScrollIndex={Math.max(
                0,
                listPickerType === 'font'
                  ? safeFontSize - 3
                  : listPickerType === 'spacing'
                  ? Math.round((safeSpacing - MIN_LINE_SPACING) * 10) - 3
                  : speed - 3
              )}
              onScrollToIndexFailed={() => {}}
              getItemLayout={(_, index) => ({ length: ITEM_ROW_HEIGHT, offset: ITEM_ROW_HEIGHT * index, index })}
              renderItem={({ item }) => {
                const isSelected =
                  listPickerType === 'font'
                    ? item === safeFontSize
                    : listPickerType === 'spacing'
                    ? Math.abs(item - safeSpacing) < 0.001
                    : item === speed;
                return (
                  <TouchableOpacity
                    style={[styles.valueRowItem, isSelected && styles.valueRowItemActive]}
                    onPress={() =>
                      listPickerType === 'font'
                        ? selectFontSize(item)
                        : listPickerType === 'spacing'
                        ? selectLineSpacing(item)
                        : selectSpeed(item)
                    }
                    activeOpacity={0.7}
                  >
                    <Text style={[styles.valueRowText, isSelected && styles.valueRowTextActive]}>
                      {listPickerType === 'spacing'
                        ? formatSpacing(item)
                        : `${item} ${listPickerType === 'font' ? 'px' : ''}`}
                    </Text>
                    {isSelected && <Check size={16} color="#FFFFFF" strokeWidth={2.8} />}
                  </TouchableOpacity>
                );
              }}
              showsVerticalScrollIndicator
              contentContainerStyle={styles.listPickerScrollContent}
            />
          </View>
        </View>
      </Modal>

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
                  <KeyboardIcon size={16} color="#FFFFFF" strokeWidth={2.2} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.keyboardTitle}>
                    {keyboardEditType === 'font'
                      ? 'Edit Text Size'
                      : keyboardEditType === 'spacing'
                      ? 'Edit Line Spacing'
                      : 'Edit Scroll Speed'}
                  </Text>
                  <Text style={styles.keyboardSubtitle}>
                    {keyboardEditType === 'font'
                      ? `Type an integer from 1 to ${MAX_FONT_SIZE} px`
                      : keyboardEditType === 'spacing'
                      ? `Type a multiple from ${MIN_LINE_SPACING.toFixed(1)} to ${MAX_LINE_SPACING.toFixed(1)}`
                      : 'Type an integer from 0 to 200'}
                  </Text>
                </View>
              </View>

              <View style={styles.keyboardInputRow}>
                <TextInput
                  style={styles.keyboardNumericInput}
                  value={keyboardInputVal}
                  onChangeText={setKeyboardInputVal}
                  keyboardType={keyboardEditType === 'spacing' ? 'decimal-pad' : 'number-pad'}
                  autoFocus
                  selectTextOnFocus
                  maxLength={keyboardEditType === 'spacing' ? 4 : 3}
                  returnKeyType="done"
                  blurOnSubmit
                  underlineColorAndroid="transparent"
                  onSubmitEditing={handleSaveKeyboardEdit}
                />
                <Text style={styles.keyboardUnit}>
                  {keyboardEditType === 'font' ? 'px' : keyboardEditType === 'spacing' ? '× size' : 'speed'}
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

                <TouchableOpacity style={styles.keyboardSaveBtn} onPress={handleSaveKeyboardEdit} activeOpacity={0.8}>
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
        topInset={topInset}
        onSave={handleSaveScript}
        onClose={() => setEditModalVisible(false)}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  deckContainer: {
    flex: 1,
    width: '100%',
    backgroundColor: '#09090B',
    borderRadius: 18,
    overflow: 'hidden',
  },
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
    backgroundColor: 'rgba(255, 255, 255, 0.14)',
    borderColor: '#FFFFFF',
    shadowColor: '#FFFFFF',
    shadowOpacity: 0.28,
    shadowRadius: 9,
    elevation: 6,
  },
  solidPillBtnText: {
    color: '#F4F4F5',
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  solidPillBtnTextActive: {
    color: '#FFFFFF',
    fontWeight: '700',
  },
  viewport: {
    flex: 1,
    backgroundColor: '#060608',
    overflow: 'hidden',
    position: 'relative',
    justifyContent: 'center',
    alignItems: 'center',
    width: '100%',
  },
  loadingPlaceholder: {
    ...StyleSheet.absoluteFill,
    backgroundColor: '#060608',
  },
  bottomControlStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#0E0E12',
    zIndex: 2,
  },
  bottomControlStripCompact: {
    gap: 6,
    paddingHorizontal: 6,
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
  stepperPillCompact: {
    paddingHorizontal: 5,
    gap: 2,
    flexShrink: 1,
  },
  stepperTouch: { width: 20, height: 20, alignItems: 'center', justifyContent: 'center' },
  stepperTouchCompact: { width: 17 },
  stepperValTouchCompact: { paddingHorizontal: 3 },
  stepperValCompact: { minWidth: 26, fontSize: 10.5 },
  stepperValTouch: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  stepperVal: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
    minWidth: 32,
    textAlign: 'center',
  },
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
  listPickerTitle: { color: '#FFFFFF', fontSize: 16, fontWeight: '700', letterSpacing: -0.2 },
  listPickerSubtitle: { color: '#8E8E93', fontSize: 11, marginTop: 2 },
  closeRoundBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#202028',
    alignItems: 'center',
    justifyContent: 'center',
  },
  listPickerScrollContent: { paddingVertical: 4 },
  valueRowItem: {
    height: ITEM_ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    borderRadius: 10,
    marginVertical: 1,
  },
  valueRowItemActive: { backgroundColor: 'rgba(255, 255, 255, 0.12)' },
  valueRowText: {
    color: '#A1A1AA',
    fontSize: 15,
    fontWeight: '500',
    fontVariant: ['tabular-nums'],
  },
  valueRowTextActive: { color: '#FFFFFF', fontWeight: '700' },
  keyboardCard: {
    width: '100%',
    maxWidth: 320,
    backgroundColor: '#141418',
    borderRadius: 22,
    borderWidth: 1,
    borderColor: '#26262F',
    padding: 20,
  },
  keyboardHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 16 },
  keyboardIconCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyboardTitle: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
  keyboardSubtitle: { color: '#8E8E93', fontSize: 11, marginTop: 2 },
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
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '700',
    textAlign: 'center',
    minWidth: 60,
    padding: 0,
    fontVariant: ['tabular-nums'],
  },
  keyboardUnit: { color: '#71717A', fontSize: 13, fontWeight: '600' },
  keyboardActionRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  keyboardCancelBtn: {
    flex: 1,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#1E1E24',
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyboardCancelText: { color: '#8E8E93', fontSize: 13, fontWeight: '600' },
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
  keyboardSaveText: { color: '#000000', fontSize: 13, fontWeight: '700' },
});
