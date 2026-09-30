// src/components/studio/WaveformZoomControl.tsx
import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Animated, {
  SharedValue,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { Plus, Minus } from 'lucide-react-native';

import {
  DEFAULT_WAVEFORM_ZOOM,
  MAX_WAVEFORM_ZOOM,
  MIN_WAVEFORM_ZOOM,
} from '../../services/storage/audioSettingsStorage';

interface WaveformZoomControlProps {
  pxPerSec: SharedValue<number>;
  /** Width of the waveform, used to label how much audio is on screen. */
  viewportWidth: number;
  height: number;
  onCommit: (pxPerSec: number) => void;
}

const STEP = 1.5;
/** Points of vertical drag that double (up) or halve (down) the scale. */
const DRAG_PER_DOUBLING = 36;

const formatSpan = (seconds: number): string => {
  'worklet';
  if (!Number.isFinite(seconds) || seconds <= 0) return '--';
  if (seconds < 10) return `${Math.round(seconds * 10) / 10}s`;
  if (seconds < 90) return `${Math.round(seconds)}s`;
  return `${Math.round(seconds / 60)}m`;
};

const clampZoom = (v: number): number => {
  'worklet';
  return Math.max(MIN_WAVEFORM_ZOOM, Math.min(MAX_WAVEFORM_ZOOM, v));
};

/**
 * Vertical zoom rocker for the studio waveform: tap + / - to step the scale,
 * drag up or down anywhere on it to scrub the scale (like the prompter's
 * value pills), tap the middle label to go back to the default.
 */
export const WaveformZoomControl: React.FC<WaveformZoomControlProps> = ({
  pxPerSec,
  viewportWidth,
  height,
  onCommit,
}) => {
  const [label, setLabel] = useState(() => formatSpan(viewportWidth / DEFAULT_WAVEFORM_ZOOM));
  const startZoom = useSharedValue(DEFAULT_WAVEFORM_ZOOM);
  const isScrubbing = useSharedValue(false);

  useAnimatedReaction(
    () => formatSpan(viewportWidth / pxPerSec.value),
    (current, previous) => {
      if (current !== previous) runOnJS(setLabel)(current);
    },
    [viewportWidth]
  );

  const gesture = useMemo(() => {
    const pan = Gesture.Pan()
      .activeOffsetY([-5, 5])
      .failOffsetX([-14, 14])
      .onBegin(() => {
        'worklet';
        startZoom.value = pxPerSec.value;
        isScrubbing.value = true;
      })
      .onUpdate((e) => {
        'worklet';
        pxPerSec.value = clampZoom(startZoom.value * Math.pow(2, -e.translationY / DRAG_PER_DOUBLING));
      })
      .onEnd(() => {
        'worklet';
        runOnJS(onCommit)(pxPerSec.value);
      })
      .onFinalize(() => {
        'worklet';
        isScrubbing.value = false;
      });

    const tap = Gesture.Tap()
      .maxDuration(400)
      .onEnd((e, success) => {
        'worklet';
        if (!success) return;
        const zone = e.y / Math.max(1, height);
        let target: number;
        if (zone < 0.36) {
          target = clampZoom(pxPerSec.value * STEP);
        } else if (zone > 0.64) {
          target = clampZoom(pxPerSec.value / STEP);
        } else {
          target = DEFAULT_WAVEFORM_ZOOM;
        }
        pxPerSec.value = withTiming(target, { duration: 180, easing: Easing.out(Easing.cubic) });
        runOnJS(onCommit)(target);
      });

    return Gesture.Exclusive(pan, tap);
  }, [height, pxPerSec, startZoom, isScrubbing, onCommit]);

  const containerAnim = useAnimatedStyle(() => ({
    backgroundColor: isScrubbing.value ? 'rgba(255, 255, 255, 0.18)' : '#18181D',
    borderColor: isScrubbing.value ? '#FFFFFF' : '#26262F',
    shadowOpacity: isScrubbing.value ? 0.4 : 0,
    elevation: isScrubbing.value ? 8 : 0,
  }));

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        style={[styles.container, { height }, containerAnim]}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={`Waveform zoom, ${label} on screen`}
      >
        <View style={styles.zone} pointerEvents="none">
          <Plus size={12} color="#FFFFFF" strokeWidth={2.4} />
        </View>
        <View style={styles.labelZone} pointerEvents="none">
          <Text style={styles.label} numberOfLines={1} maxFontSizeMultiplier={1.1}>
            {label}
          </Text>
        </View>
        <View style={styles.zone} pointerEvents="none">
          <Minus size={12} color="#FFFFFF" strokeWidth={2.4} />
        </View>
      </Animated.View>
    </GestureDetector>
  );
};

const styles = StyleSheet.create({
  container: {
    width: 30,
    borderRadius: 15,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 4,
    shadowColor: '#FFFFFF',
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 0 },
  },
  zone: {
    flex: 1,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  labelZone: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 2,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: '#2E2E36',
  },
  label: {
    color: '#A1A1AA',
    fontSize: 8.5,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
    letterSpacing: -0.2,
  },
});
