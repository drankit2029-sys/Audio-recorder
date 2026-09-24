// src/components/prompter/TeleprompterDeck.tsx
import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  PanResponder,
  LayoutChangeEvent,
} from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  cancelAnimation,
  Easing,
} from 'react-native-reanimated';
import {
  FileText,
  FlipHorizontal,
  RotateCcw,
  Type,
  Gauge,
  Plus,
  Minus,
} from 'lucide-react-native';

import { PrompterStorage } from '../../services/storage/prompterStorage';
import { PrompterEditModal } from './PrompterEditModal';
import { EngineState } from '../../services/audio/useAudioRecording';

export interface TeleprompterDeckProps {
  engineState: EngineState;
  customHeight?: number;
}

const EYELINE_OFFSET = 38;

export const TeleprompterDeck: React.FC<TeleprompterDeckProps> = ({
  engineState,
  customHeight,
}) => {
  const [script, setScript] = useState(PrompterStorage.getScript());
  const [speed, setSpeed] = useState(PrompterStorage.getSpeed());
  const [fontSize, setFontSize] = useState(PrompterStorage.getFontSize());
  const [isMirrored, setIsMirrored] = useState(PrompterStorage.getIsMirrored());
  const [editModalVisible, setEditModalVisible] = useState(false);

  const [containerHeight, setContainerHeight] = useState(customHeight ?? 140);
  const [contentHeight, setContentHeight] = useState(300);

  const activeViewportHeight = customHeight ?? containerHeight;
  const maxScroll = Math.max(0, contentHeight - activeViewportHeight + 80);

  const translateY = useSharedValue(0);
  const startDragYRef = useRef(0);

  const maxScrollRef = useRef(maxScroll);
  maxScrollRef.current = maxScroll;

  const speedRef = useRef(speed);
  speedRef.current = speed;

  const engineStateRef = useRef(engineState);
  engineStateRef.current = engineState;

  useEffect(() => {
    if (engineState === 'RECORDING') {
      const remainingDistance = Math.abs(-maxScroll - translateY.value);
      const durationMs = (remainingDistance / speed) * 1000;

      if (durationMs > 0) {
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

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dy) > 4,
      onPanResponderGrant: () => {
        cancelAnimation(translateY);
        startDragYRef.current = translateY.value;
      },
      onPanResponderMove: (_, gesture) => {
        const nextY = startDragYRef.current + gesture.dy;
        translateY.value = Math.max(-maxScrollRef.current, Math.min(0, nextY));
      },
      onPanResponderRelease: () => {
        if (engineStateRef.current === 'RECORDING') {
          const remainingDistance = Math.abs(
            -maxScrollRef.current - translateY.value
          );
          const durationMs = (remainingDistance / speedRef.current) * 1000;
          if (durationMs > 0) {
            translateY.value = withTiming(-maxScrollRef.current, {
              duration: durationMs,
              easing: Easing.linear,
            });
          }
        }
      },
    })
  ).current;

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
    const next = Math.max(15, Math.min(100, speed + delta));
    setSpeed(next);
    PrompterStorage.setSpeed(next);
  };

  const changeFontSize = (delta: number) => {
    const next = Math.max(14, Math.min(36, fontSize + delta));
    setFontSize(next);
    PrompterStorage.setFontSize(next);
  };

  const handleSaveScript = (newScript: string) => {
    setScript(newScript);
    PrompterStorage.setScript(newScript);
    handleReset();
  };

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: translateY.value },
      { scaleX: isMirrored ? -1 : 1 },
    ],
  }));

  return (
    <View style={styles.deckContainer}>
      {/* Sleek Minimalist Control Strip */}
      <View style={styles.controlStrip}>
        {/* Left Actions */}
        <View style={styles.leftButtonGroup}>
          <TouchableOpacity
            style={styles.pillBtn}
            onPress={() => setEditModalVisible(true)}
            activeOpacity={0.6}
          >
            <FileText size={11} color="#8E8E93" />
            <Text style={styles.pillBtnText}>Script</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.pillBtn, isMirrored && styles.pillBtnActive]}
            onPress={handleToggleMirror}
            activeOpacity={0.6}
          >
            <FlipHorizontal size={11} color={isMirrored ? '#FFFFFF' : '#8E8E93'} />
            <Text style={[styles.pillBtnText, isMirrored && styles.pillBtnTextActive]}>
              Mirror
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.iconOnlyBtn}
            onPress={handleReset}
            activeOpacity={0.6}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <RotateCcw size={12} color="#8E8E93" />
          </TouchableOpacity>
        </View>

        {/* Right Steppers */}
        <View style={styles.rightStepperGroup}>
          {/* Font Size Stepper */}
          <View style={styles.stepperPill}>
            <Type size={11} color="#71717A" />
            <TouchableOpacity
              style={styles.stepperTouch}
              onPress={() => changeFontSize(-2)}
              activeOpacity={0.5}
              hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
            >
              <Minus size={9} color="#A1A1AA" />
            </TouchableOpacity>
            <Text style={styles.stepperVal}>{fontSize}</Text>
            <TouchableOpacity
              style={styles.stepperTouch}
              onPress={() => changeFontSize(2)}
              activeOpacity={0.5}
              hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
            >
              <Plus size={9} color="#A1A1AA" />
            </TouchableOpacity>
          </View>

          {/* Speed Stepper */}
          <View style={styles.stepperPill}>
            <Gauge size={11} color="#71717A" />
            <TouchableOpacity
              style={styles.stepperTouch}
              onPress={() => changeSpeed(-5)}
              activeOpacity={0.5}
              hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
            >
              <Minus size={9} color="#A1A1AA" />
            </TouchableOpacity>
            <Text style={styles.stepperVal}>{speed}</Text>
            <TouchableOpacity
              style={styles.stepperTouch}
              onPress={() => changeSpeed(5)}
              activeOpacity={0.5}
              hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
            >
              <Plus size={9} color="#A1A1AA" />
            </TouchableOpacity>
          </View>
        </View>
      </View>

      {/* Prompter Viewing Viewport */}
      <View
        style={[styles.viewport, { height: activeViewportHeight }]}
        onLayout={(e: LayoutChangeEvent) => {
          setContainerHeight(e.nativeEvent.layout.height);
        }}
        {...panResponder.panHandlers}
      >
        {/* Subtle Studio Laser Reading Cue */}
        <View pointerEvents="none" style={styles.eyelineGuide}>
          <View style={styles.eyelineDot} />
          <View style={styles.eyelineLine} />
          <View style={styles.eyelineDot} />
        </View>

        {/* Animated Text */}
        <Animated.View
          style={[styles.textWrapper, animatedStyle]}
          onLayout={(e: LayoutChangeEvent) => {
            setContentHeight(e.nativeEvent.layout.height);
          }}
        >
          <Text
            style={[
              styles.prompterText,
              { fontSize, lineHeight: Math.round(fontSize * 1.55) },
            ]}
          >
            {script}
          </Text>
        </Animated.View>
      </View>

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
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#18181B',
    overflow: 'hidden',
  },
  controlStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#0C0C0E',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#18181C',
  },
  leftButtonGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  rightStepperGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  pillBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
  },
  pillBtnActive: {
    backgroundColor: 'rgba(255, 255, 255, 0.14)',
  },
  pillBtnText: {
    color: '#8E8E93',
    fontSize: 10,
    fontWeight: '500',
    letterSpacing: 0.2,
  },
  pillBtnTextActive: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
  iconOnlyBtn: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.035)',
  },
  stepperPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 3,
    paddingHorizontal: 6,
    borderRadius: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    gap: 3,
  },
  stepperTouch: {
    width: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperVal: {
    color: '#E4E4E7',
    fontSize: 10,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    minWidth: 16,
    textAlign: 'center',
  },
  viewport: {
    backgroundColor: '#060608',
    overflow: 'hidden',
    position: 'relative',
    justifyContent: 'flex-start',
  },
  eyelineGuide: {
    position: 'absolute',
    top: EYELINE_OFFSET,
    left: 0,
    right: 0,
    zIndex: 10,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    gap: 4,
    opacity: 0.35,
  },
  eyelineDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#38BDF8',
  },
  eyelineLine: {
    flex: 1,
    height: 1,
    backgroundColor: '#38BDF8',
  },
  textWrapper: {
    paddingHorizontal: 20,
    paddingTop: EYELINE_OFFSET,
    paddingBottom: 48,
  },
  prompterText: {
    color: '#E4E4E7',
    fontWeight: '400',
    textAlign: 'center',
    letterSpacing: 0.2,
  },
});