// src/components/studio/StudioWaveform.tsx
import React, { useMemo, useState } from 'react';
import { View, StyleSheet, LayoutChangeEvent } from 'react-native';
import {
  Canvas,
  Path,
  Line,
  Circle,
  Rect,
  LinearGradient,
  Skia,
  vec,
  SkPathBuilder,
} from '@shopify/react-native-skia';
import {
  SharedValue,
  cancelAnimation,
  runOnJS,
  useDerivedValue,
  useSharedValue,
  withDecay,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { isRNRuntime } from 'react-native-worklets';

interface StudioWaveformProps {
  playheadMs: SharedValue<number>;
  durationMs: SharedValue<number>;
  /** 0-255 peak per 20 ms bucket. */
  peaks: SharedValue<number[]>;
  /** Horizontal scale: points per second of audio. */
  pxPerSec: SharedValue<number>;
  isScrubbing: SharedValue<boolean>;
  isRecording: SharedValue<boolean>;
  /** Scrolling is only possible while the take is paused or previewing. */
  interactive: boolean;
  height?: number;
  onScrubStart: () => void;
  onScrubEnd: (positionMs: number) => void;
  onWidthChange?: (width: number) => void;
}

const PAD = 6;
const BAR_SPACING = 3;
const BAR_WIDTH = 1.6;
const PEAK_BUCKET_SEC = 0.02;
const EDGE_FADE = 22;

/**
 * Tape-style waveform with a fixed playhead in the middle. Bars are anchored
 * to absolute time, so the tape slides smoothly under the playhead while
 * recording or previewing, and can be dragged (with momentum) to any point of
 * the take while paused. Everything is drawn on the UI thread.
 */
export const StudioWaveform: React.FC<StudioWaveformProps> = ({
  playheadMs,
  durationMs,
  peaks,
  pxPerSec,
  isScrubbing,
  isRecording,
  interactive,
  height = 54,
  onScrubStart,
  onScrubEnd,
  onWidthChange,
}) => {
  const [width, setWidth] = useState(240);
  const widthSV = useSharedValue(240);
  const startMs = useSharedValue(0);

  const onLayout = (e: LayoutChangeEvent) => {
    const w = Math.round(e.nativeEvent.layout.width);
    if (w > 0 && Math.abs(w - width) > 1) {
      setWidth(w);
      widthSV.value = w;
      onWidthChange?.(w);
    }
  };

  const centerY = PAD + height / 2;
  const maxDeflection = height * 0.46;

  /**
   * Pure helper: every shared value is read by the derived values below and
   * passed in, because Reanimated only tracks shared values that appear
   * directly in a derived value's own closure.
   */
  const drawBars = (
    b: SkPathBuilder,
    past: boolean,
    w: number,
    pps: number,
    durMs: number,
    arr: number[],
    playMs: number
  ) => {
    'worklet';
    const dur = durMs / 1000;
    const n = arr.length;
    if (pps <= 0 || dur <= 0 || w <= 0) return;

    const t = playMs / 1000;
    const secPerBar = BAR_SPACING / pps;
    const half = w / 2 / pps;
    const cx = PAD + w / 2;
    const iStart = Math.max(0, Math.floor((t - half) / secPerBar) - 1);
    const iEnd = Math.min(Math.ceil(dur / secPerBar), Math.ceil((t + half) / secPerBar) + 1);

    for (let i = iStart; i < iEnd; i++) {
      const t0 = i * secPerBar;
      if (t0 >= dur) break;
      const mid = t0 + secPerBar / 2;
      if (past ? mid > t : mid <= t) continue;

      let k0 = Math.floor(t0 / PEAK_BUCKET_SEC);
      let k1 = Math.floor((t0 + secPerBar) / PEAK_BUCKET_SEC);
      if (k1 <= k0) k1 = k0 + 1;
      if (k1 > n) k1 = n;
      let v = 0;
      for (let k = k0; k < k1; k++) {
        const pk = arr[k];
        if (pk > v) v = pk;
      }
      const x = cx + (mid - t) * pps;
      const amp = Math.max(1.1, (v / 255) * maxDeflection);
      b.moveTo(x, centerY - amp);
      b.lineTo(x, centerY + amp);
    }
  };

  // The initial run happens on the JS thread during render; skip it there so a
  // long take's peak table is never copied across threads synchronously.
  const pastPath = useDerivedValue(() => {
    if (isRNRuntime()) return Skia.Path.Make();
    const b = Skia.PathBuilder.Make();
    drawBars(b, true, widthSV.value, pxPerSec.value, durationMs.value, peaks.value, playheadMs.value);
    return b.build();
  });

  const futurePath = useDerivedValue(() => {
    if (isRNRuntime()) return Skia.Path.Make();
    const b = Skia.PathBuilder.Make();
    drawBars(b, false, widthSV.value, pxPerSec.value, durationMs.value, peaks.value, playheadMs.value);
    return b.build();
  });

  const playheadColor = useDerivedValue(() => (isRecording.value ? '#EF4444' : '#FFFFFF'));

  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(interactive)
        .activeOffsetX([-4, 4])
        .onBegin(() => {
          'worklet';
          // A touch stops any momentum that is still running.
          cancelAnimation(playheadMs);
        })
        .onStart(() => {
          'worklet';
          isScrubbing.value = true;
          startMs.value = playheadMs.value;
          runOnJS(onScrubStart)();
        })
        .onUpdate((e) => {
          'worklet';
          const next = startMs.value - (e.translationX / pxPerSec.value) * 1000;
          playheadMs.value = Math.max(0, Math.min(durationMs.value, next));
        })
        .onEnd((e, success) => {
          'worklet';
          const velocity = -(e.velocityX / pxPerSec.value) * 1000;
          if (!success || Math.abs(velocity) < 40) {
            isScrubbing.value = false;
            runOnJS(onScrubEnd)(playheadMs.value);
            return;
          }
          playheadMs.value = withDecay(
            { velocity, deceleration: 0.996, clamp: [0, durationMs.value] },
            () => {
              'worklet';
              isScrubbing.value = false;
              runOnJS(onScrubEnd)(playheadMs.value);
            }
          );
        }),
    [interactive, playheadMs, durationMs, pxPerSec, isScrubbing, startMs, onScrubStart, onScrubEnd]
  );

  const canvasW = width + PAD * 2;
  const canvasH = height + PAD * 2;
  const cx = PAD + width / 2;

  return (
    <GestureDetector gesture={gesture}>
      <View style={[styles.container, { height }]} onLayout={onLayout} collapsable={false}>
        <Canvas
          style={{
            position: 'absolute',
            top: -PAD,
            left: -PAD,
            width: canvasW,
            height: canvasH,
          }}
        >
          <Line p1={vec(PAD + 4, centerY)} p2={vec(PAD + width - 4, centerY)} color="#16161A" strokeWidth={1} />

          <Path
            path={futurePath}
            style="stroke"
            strokeWidth={BAR_WIDTH}
            strokeCap="round"
            color="#FFFFFF"
            opacity={0.26}
          />
          <Path
            path={pastPath}
            style="stroke"
            strokeWidth={BAR_WIDTH}
            strokeCap="round"
            color="#FFFFFF"
            opacity={0.92}
          />

          <Rect x={PAD} y={0} width={EDGE_FADE} height={canvasH}>
            <LinearGradient
              start={vec(PAD, 0)}
              end={vec(PAD + EDGE_FADE, 0)}
              colors={['#000000', 'rgba(0, 0, 0, 0)']}
            />
          </Rect>
          <Rect x={PAD + width - EDGE_FADE} y={0} width={EDGE_FADE} height={canvasH}>
            <LinearGradient
              start={vec(PAD + width - EDGE_FADE, 0)}
              end={vec(PAD + width, 0)}
              colors={['rgba(0, 0, 0, 0)', '#000000']}
            />
          </Rect>

          <Line p1={vec(cx, PAD - 2)} p2={vec(cx, PAD + height + 2)} color={playheadColor} strokeWidth={1.5} />
          <Circle cx={cx} cy={PAD - 2} r={2.6} color={playheadColor} />
          <Circle cx={cx} cy={PAD + height + 2} r={2.6} color={playheadColor} />
        </Canvas>
      </View>
    </GestureDetector>
  );
};

const styles = StyleSheet.create({
  container: {
    width: '100%',
    position: 'relative',
    marginBottom: 4,
    overflow: 'visible',
  },
});
