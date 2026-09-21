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
import { PrompterStorage } from '../../services/storage/prompterStorage';
import { PrompterEditModal } from './PrompterEditModal';
import { EngineState } from '../../services/audio/useAudioRecording';

interface TeleprompterDeckProps {
  engineState: EngineState;
}

export const TeleprompterDeck: React.FC<TeleprompterDeckProps> = ({ engineState }) => {
  const [script, setScript] = useState(PrompterStorage.getScript());
  const [speed, setSpeed] = useState(PrompterStorage.getSpeed());
  const [fontSize, setFontSize] = useState(PrompterStorage.getFontSize());
  const [isMirrored, setIsMirrored] = useState(PrompterStorage.getIsMirrored());
  const [editModalVisible, setEditModalVisible] = useState(false);

  const containerHeightRef = useRef(150);
  const contentHeightRef = useRef(300);

  // Reanimated scroll offset
  const translateY = useSharedValue(0);
  const startDragYRef = useRef(0);

  const maxScroll = Math.max(0, contentHeightRef.current - containerHeightRef.current + 80);

  // Synchronize scrolling with engine state
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
    } else if (engineState === 'PAUSED' || engineState === 'STOPPED' || engineState === 'IDLE') {
      cancelAnimation(translateY);
    }
  }, [engineState, speed, maxScroll]);

  // Pan gesture for manual repositioning
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
        translateY.value = Math.max(-maxScroll, Math.min(0, nextY));
      },
      onPanResponderRelease: () => {
        if (engineState === 'RECORDING') {
          const remainingDistance = Math.abs(-maxScroll - translateY.value);
          const durationMs = (remainingDistance / speed) * 1000;
          if (durationMs > 0) {
            translateY.value = withTiming(-maxScroll, {
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
    translateY.value = withTiming(0, { duration: 250, easing: Easing.out(Easing.quad) });
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
      {/* Top Toolbar */}
      <View style={styles.toolbar}>
        <View style={styles.toolGroup}>
          <TouchableOpacity style={styles.toolBtn} onPress={() => setEditModalVisible(true)}>
            <Text style={styles.toolBtnText}>SCRIPT</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.toolBtn, isMirrored && styles.toolBtnActive]}
            onPress={handleToggleMirror}
          >
            <Text style={[styles.toolBtnText, isMirrored && styles.toolBtnTextActive]}>
              MIRROR
            </Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.toolBtn} onPress={handleReset}>
            <Text style={styles.toolBtnText}>RESET</Text>
          </TouchableOpacity>
        </View>

        {/* Speed Stepper */}
        <View style={styles.speedGroup}>
          <Text style={styles.speedLabel}>SPEED</Text>
          <TouchableOpacity style={styles.stepperBtn} onPress={() => changeSpeed(-5)}>
            <Text style={styles.stepperText}>-</Text>
          </TouchableOpacity>
          <Text style={styles.speedValue}>{speed}</Text>
          <TouchableOpacity style={styles.stepperBtn} onPress={() => changeSpeed(5)}>
            <Text style={styles.stepperText}>+</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Prompter Viewing Window */}
      <View
        style={styles.viewport}
        onLayout={(e: LayoutChangeEvent) => {
          containerHeightRef.current = e.nativeEvent.layout.height;
        }}
        {...panResponder.panHandlers}
      >
        {/* Optical Reading Eye-line Cue */}
        <View pointerEvents="none" style={styles.eyelineGuide}>
          <View style={styles.eyelineArrowLeft} />
          <View style={styles.eyelineLine} />
          <View style={styles.eyelineArrowRight} />
        </View>

        {/* Animated Text Core */}
        <Animated.View
          style={[styles.textWrapper, animatedStyle]}
          onLayout={(e: LayoutChangeEvent) => {
            contentHeightRef.current = e.nativeEvent.layout.height;
          }}
        >
          <Text style={[styles.prompterText, { fontSize, lineHeight: fontSize * 1.5 }]}>
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
    backgroundColor: '#181818',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    overflow: 'hidden',
    marginBottom: 12,
  },
  toolbar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#202020',
    borderBottomWidth: 1,
    borderBottomColor: '#2C2C2C',
  },
  toolGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  toolBtn: {
    backgroundColor: '#2A2A2A',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
  },
  toolBtnActive: {
    backgroundColor: '#00E676',
  },
  toolBtnText: {
    color: '#B0BEC5',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  toolBtnTextActive: {
    color: '#121212',
  },
  speedGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  speedLabel: {
    color: '#757575',
    fontSize: 10,
    fontWeight: '700',
  },
  stepperBtn: {
    width: 24,
    height: 24,
    backgroundColor: '#2A2A2A',
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
    lineHeight: 16,
  },
  speedValue: {
    color: '#00E676',
    fontSize: 12,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
    minWidth: 20,
    textAlign: 'center',
  },
  viewport: {
    height: 140,
    backgroundColor: '#0E0E0E',
    overflow: 'hidden',
    position: 'relative',
    justifyContent: 'flex-start',
  },
  eyelineGuide: {
    position: 'absolute',
    top: 36,
    left: 0,
    right: 0,
    zIndex: 10,
    flexDirection: 'row',
    alignItems: 'center',
    opacity: 0.4,
  },
  eyelineArrowLeft: {
    width: 0,
    height: 0,
    borderTopWidth: 5,
    borderBottomWidth: 5,
    borderLeftWidth: 8,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
    borderLeftColor: '#00E676',
  },
  eyelineLine: {
    flex: 1,
    height: 1,
    backgroundColor: '#00E676',
  },
  eyelineArrowRight: {
    width: 0,
    height: 0,
    borderTopWidth: 5,
    borderBottomWidth: 5,
    borderRightWidth: 8,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
    borderRightColor: '#00E676',
  },
  textWrapper: {
    paddingHorizontal: 16,
    paddingTop: 36, // Start text aligned directly on the reading cue
    paddingBottom: 40,
  },
  prompterText: {
    color: '#F5F5F5',
    fontWeight: '500',
    textAlign: 'center',
  },
});