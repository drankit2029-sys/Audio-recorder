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

const EYELINE_OFFSET = 36;

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
      {/* Action Toolbar: Evenly Spaced Script, Mirror, Reset */}
      <View style={styles.actionToolbar}>
        <TouchableOpacity
          style={styles.actionBtn}
          onPress={() => setEditModalVisible(true)}
          activeOpacity={0.7}
        >
          <FileText size={13} color="#FFFFFF" />
          <Text style={styles.actionBtnText}>SCRIPT</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.actionBtn, isMirrored && styles.actionBtnActive]}
          onPress={handleToggleMirror}
          activeOpacity={0.7}
        >
          <FlipHorizontal size={13} color={isMirrored ? '#000000' : '#FFFFFF'} />
          <Text style={[styles.actionBtnText, isMirrored && styles.actionBtnTextActive]}>
            MIRROR
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.actionBtn}
          onPress={handleReset}
          activeOpacity={0.7}
        >
          <RotateCcw size={13} color="#FFFFFF" />
          <Text style={styles.actionBtnText}>RESET</Text>
        </TouchableOpacity>
      </View>

      {/* Adjusters Toolbar: Evenly Spaced Size & Speed Steppers */}
      <View style={styles.stepperToolbar}>
        {/* Size Stepper */}
        <View style={styles.stepperItem}>
          <View style={styles.stepperLabelGroup}>
            <Type size={13} color="#8E8E93" />
            <Text style={styles.stepperLabel}>SIZE</Text>
          </View>
          <View style={styles.stepperControls}>
            <TouchableOpacity
              style={styles.stepperBtn}
              onPress={() => changeFontSize(-2)}
              activeOpacity={0.7}
            >
              <Minus size={12} color="#FFFFFF" />
            </TouchableOpacity>
            <Text style={styles.stepperValue}>{fontSize}</Text>
            <TouchableOpacity
              style={styles.stepperBtn}
              onPress={() => changeFontSize(2)}
              activeOpacity={0.7}
            >
              <Plus size={12} color="#FFFFFF" />
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.stepperDivider} />

        {/* Speed Stepper */}
        <View style={styles.stepperItem}>
          <View style={styles.stepperLabelGroup}>
            <Gauge size={13} color="#8E8E93" />
            <Text style={styles.stepperLabel}>SPEED</Text>
          </View>
          <View style={styles.stepperControls}>
            <TouchableOpacity
              style={styles.stepperBtn}
              onPress={() => changeSpeed(-5)}
              activeOpacity={0.7}
            >
              <Minus size={12} color="#FFFFFF" />
            </TouchableOpacity>
            <Text style={styles.stepperValue}>{speed}</Text>
            <TouchableOpacity
              style={styles.stepperBtn}
              onPress={() => changeSpeed(5)}
              activeOpacity={0.7}
            >
              <Plus size={12} color="#FFFFFF" />
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
        {/* Optical Reading Eye-line Cue in Crisp White */}
        <View pointerEvents="none" style={styles.eyelineGuide}>
          <View style={styles.eyelineArrowLeft} />
          <View style={styles.eyelineLine} />
          <View style={styles.eyelineArrowRight} />
        </View>

        {/* Animated Text Core */}
        <Animated.View
          style={[styles.textWrapper, animatedStyle]}
          onLayout={(e: LayoutChangeEvent) => {
            setContentHeight(e.nativeEvent.layout.height);
          }}
        >
          <Text
            style={[
              styles.prompterText,
              { fontSize, lineHeight: Math.round(fontSize * 1.5) },
            ]}
          >
            {script}
          </Text>
        </Animated.View>
      </View>

      {/* Script Editor Modal */}
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
    backgroundColor: '#121212',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#242424',
    overflow: 'hidden',
    marginBottom: 8,
  },
  actionToolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#161616',
    borderBottomWidth: 1,
    borderBottomColor: '#242424',
    gap: 8,
  },
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#202020',
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#2C2C2C',
  },
  actionBtnActive: {
    backgroundColor: '#FFFFFF',
    borderColor: '#FFFFFF',
  },
  actionBtnText: {
    color: '#F2F2F7',
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  actionBtnTextActive: {
    color: '#000000',
  },
  stepperToolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: '#141414',
    borderBottomWidth: 1,
    borderBottomColor: '#242424',
  },
  stepperItem: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 6,
  },
  stepperDivider: {
    width: 1,
    height: 20,
    backgroundColor: '#262626',
    marginHorizontal: 8,
  },
  stepperLabelGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  stepperLabel: {
    color: '#8E8E93',
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  stepperControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  stepperBtn: {
    width: 24,
    height: 24,
    backgroundColor: '#242424',
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperValue: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
    minWidth: 20,
    textAlign: 'center',
  },
  viewport: {
    backgroundColor: '#080808',
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
    opacity: 0.5,
  },
  eyelineArrowLeft: {
    width: 0,
    height: 0,
    borderTopWidth: 5,
    borderBottomWidth: 5,
    borderLeftWidth: 8,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
    borderLeftColor: '#FFFFFF',
  },
  eyelineLine: {
    flex: 1,
    height: 1,
    backgroundColor: '#FFFFFF',
  },
  eyelineArrowRight: {
    width: 0,
    height: 0,
    borderTopWidth: 5,
    borderBottomWidth: 5,
    borderRightWidth: 8,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
    borderRightColor: '#FFFFFF',
  },
  textWrapper: {
    paddingHorizontal: 18,
    paddingTop: EYELINE_OFFSET,
    paddingBottom: 48,
  },
  prompterText: {
    color: '#F2F2F7',
    fontWeight: '400',
    textAlign: 'center',
  },
});