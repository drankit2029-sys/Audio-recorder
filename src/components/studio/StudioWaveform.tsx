// src/components/studio/StudioWaveform.tsx
import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { View, StyleSheet, LayoutChangeEvent } from 'react-native';
import { Canvas, Path, Line, Circle, Skia, vec } from '@shopify/react-native-skia';
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

/** Horizontal padding inside the canvas. */
export const PAD = 6;
/** Pixels between two bars. */
export const BAR_SPACING = 3;
/** Core stroke width in points. */
export const BAR_WIDTH = 1.6;
/** Native peak-table resolution, in seconds. */
export const PEAK_BUCKET_SEC = 0.02;
/**
 * How many 20 ms buckets one coarse table entry covers, per level. The renderer
 * picks a level so a bar reads one entry instead of scanning every bucket under
 * it - that scan (up to ~3 000 reads per path, twice a frame) is what made the
 * wave crawl on long takes.
 */
export const LOD_FACTORS = [1, 4, 16, 64, 256];
/** Rebuild-rate floor: never quantise the head finer than this (ms). */
export const MIN_REBUILD_STEP_MS = 8;
/** The newest bucket ramps up over this fraction of its own period. */
const GROW_FRACTION = 3;

export interface WaveformGeometry {
  /** Amplitudes (points from the centre line) and x positions, in points. */
  pastAmps: number[];
  pastXs: number[];
  futureAmps: number[];
  futureXs: number[];
  /** Table entries examined - the actual per-rebuild work, asserted by the test. */
  reads: number;
}

interface StudioWaveformProps {
  playheadMs: SharedValue<number>;
  durationMs: SharedValue<number>;
  /** 0-255 peak per 20 ms bucket. */
  peaks: { value: number[] };
  /** Horizontal scale: points per second of audio. */
  pxPerSec: SharedValue<number>;
  isScrubbing: SharedValue<boolean>;
  isRecording: SharedValue<boolean>;
  /** Scrolling is only possible while the take is paused or previewing. */
  interactive: boolean;
  /**
   * Bumped by the session every time the peak table grew by a block, so the
   * level-of-detail tables are rebuilt on that signal only - never on a frame.
   */
  peakVersion: number;
  /**
   * Position of the last interference seam (a call or a stolen mic that parked
   * the take). 0 hides the marker.
   */
  seamMs?: SharedValue<number>;
  height?: number;
  onScrubStart: () => void;
  onScrubEnd: (positionMs: number) => void;
  onWidthChange?: (width: number) => void;
}

export const StudioWaveform: React.FC<StudioWaveformProps> = ({
  playheadMs,
  durationMs,
  peaks,
  pxPerSec,
  isScrubbing,
  isRecording,
  interactive,
  peakVersion,
  seamMs,
  height = 54,
  onScrubStart,
  onScrubEnd,
  onWidthChange,
}) => {
  const [width, setWidth] = useState(240);
  const widthSV = useSharedValue(240);
  const startMs = useSharedValue(0);
  // Level 0 is the raw bucket table, directly referencing the live peaks shared value
  // so newly recorded audio appears with zero delay.
  const lod0 = (peaks as unknown) as SharedValue<number[]>;
  const lod1 = useSharedValue<number[]>([]);
  const lod2 = useSharedValue<number[]>([]);
  const lod3 = useSharedValue<number[]>([]);
  const lod4 = useSharedValue<number[]>([]);
  const lod = [lod0, lod1, lod2, lod3, lod4];
  const lodCount = useSharedValue(0);

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

  // ---- level-of-detail tables ----------------------------------------------
  const lastVersionRef = useRef(-1);
  useEffect(() => {
    if (lastVersionRef.current === peakVersion) return;
    lastVersionRef.current = peakVersion;

    const source = peaks.value;
    const n = source ? source.length : 0;
    if (n === 0) {
      lodCount.value = 0;
      lod1.value = [];
      lod2.value = [];
      lod3.value = [];
      lod4.value = [];
      return;
    }
    for (let level = 1; level < LOD_FACTORS.length; level++) {
      const f = LOD_FACTORS[level];
      const out = new Array<number>(Math.ceil(n / f)).fill(0);
      for (let i = 0; i < n; i++) {
        const v = source[i];
        const k = (i / f) | 0;
        if (v > out[k]) out[k] = v;
      }
      lod[level].value = out;
    }
    lodCount.value = n;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peakVersion]);

  /* === quant:start === */
  const quantMs = useDerivedValue(() => {
    'worklet';
    const pps = pxPerSec.value;
    if (!(pps > 0)) return playheadMs.value;
    const step = Math.max((BAR_SPACING / pps) * 1000, MIN_REBUILD_STEP_MS);
    return Math.round(playheadMs.value / step) * step;
  });
  /* === quant:end === */

  /* === geometry:start === */
  const geometry = useDerivedValue((): WaveformGeometry => {
    'worklet';
    const pastAmps: number[] = [];
    const pastXs: number[] = [];
    const futureAmps: number[] = [];
    const futureXs: number[] = [];
    const empty: WaveformGeometry = {
      pastAmps: pastAmps,
      pastXs: pastXs,
      futureAmps: futureAmps,
      futureXs: futureXs,
      reads: 0,
    };

    const w = widthSV.value;
    const pps = pxPerSec.value;
    const durMs = Math.max(durationMs.value, isRecording.value ? playheadMs.value : 0);
    const playMs = isRecording.value ? playheadMs.value : quantMs.value;
    const dur = durMs / 1000;
    if (!(pps > 0) || !(dur > 0) || !(w > 0)) return empty;

    const t = playMs / 1000;
    const secPerBar = BAR_SPACING / pps;
    if (!(secPerBar > 0)) return empty;
    const half = w / 2 / pps;
    const cx = PAD + w / 2;

    let level = 0;
    let bucketSec = PEAK_BUCKET_SEC * LOD_FACTORS[0];
    while (level < LOD_FACTORS.length - 1 && bucketSec * 0.75 < secPerBar) {
      level = level + 1;
      bucketSec = PEAK_BUCKET_SEC * LOD_FACTORS[level];
    }
    const tables = [lod0, lod1, lod2, lod3, lod4];
    const arr = tables[level].value;
    const n = arr ? arr.length : 0;
    const rawArr = tables[0].value;
    const rawN = rawArr ? rawArr.length : 0;
    if (n === 0 && rawN === 0) return empty;

    const perBar = Math.max(1, Math.min(64, Math.round(secPerBar / bucketSec)));
    const iStart = Math.max(0, Math.floor((t - half) / secPerBar) - 1);
    const iEnd = Math.min(
      Math.ceil(dur / secPerBar),
      Math.ceil((t + half) / secPerBar) + 1
    );

    const headMs = playheadMs.value;
    const bucketMs = PEAK_BUCKET_SEC * 1000;
    const headEdge = Math.floor(headMs / bucketMs) * bucketMs;
    const age = headMs - headEdge;
    const growMs = bucketMs * GROW_FRACTION;
    const g = age >= growMs ? 1 : Math.max(0.2, age / growMs);
    const recording = isRecording.value;
    const edgeSec = headEdge / 1000;
    const rampEndSec = edgeSec + PEAK_BUCKET_SEC;

    let reads = 0;
    for (let i = iStart; i < iEnd; i++) {
      const t0 = i * secPerBar;
      if (t0 >= dur) break;
      const mid = t0 + secPerBar / 2;

      const k0 = Math.floor(mid / bucketSec);
      let v = 0;
      if (k0 < n) {
        const k1 = Math.min(n, k0 + perBar);
        for (let k = k0; k < k1; k++) {
          reads = reads + 1;
          const pk = arr[k];
          if (pk > v) v = pk;
        }
      }
      if ((k0 >= n || (recording && v <= 0)) && level > 0) {
        const rawK0 = Math.floor(mid / PEAK_BUCKET_SEC);
        if (rawK0 < rawN) {
          const rawPerBar = Math.max(1, Math.min(64, Math.round(secPerBar / PEAK_BUCKET_SEC)));
          const rawK1 = Math.min(rawN, rawK0 + rawPerBar);
          for (let k = rawK0; k < rawK1; k++) {
            reads = reads + 1;
            const pk = rawArr[k];
            if (pk > v) v = pk;
          }
        }
      }
      if (v <= 0) continue;

      let amp = (v / 255) * maxDeflection;
      if (recording && mid >= edgeSec && mid < rampEndSec) {
        amp = amp * g;
      }
      if (amp < 1.1) amp = 1.1;

      const x = cx + (mid - t) * pps;
      if (mid <= t) {
        pastAmps.push(amp);
        pastXs.push(x);
      } else {
        futureAmps.push(amp);
        futureXs.push(x);
      }
    }

    return {
      pastAmps: pastAmps,
      pastXs: pastXs,
      futureAmps: futureAmps,
      futureXs: futureXs,
      reads: reads,
    };
  }, [
    quantMs,
    playheadMs,
    pxPerSec,
    durationMs,
    widthSV,
    isRecording,
    lod0,
    lod1,
    lod2,
    lod3,
    lod4,
    lodCount,
  ]);
  /* === geometry:end === */

  const pastPath = useDerivedValue(() => {
    'worklet';
    if (isRNRuntime()) return Skia.Path.Make();
    const b = Skia.PathBuilder.Make();
    const geo = geometry.value;
    for (let i = 0; i < geo.pastAmps.length; i++) {
      const x = geo.pastXs[i];
      const amp = geo.pastAmps[i];
      b.moveTo(x, centerY - amp);
      b.lineTo(x, centerY + amp);
    }
    return b.build();
  }, [geometry]);

  const futurePath = useDerivedValue(() => {
    'worklet';
    if (isRNRuntime()) return Skia.Path.Make();
    const b = Skia.PathBuilder.Make();
    const geo = geometry.value;
    for (let i = 0; i < geo.futureAmps.length; i++) {
      const x = geo.futureXs[i];
      const amp = geo.futureAmps[i];
      b.moveTo(x, centerY - amp);
      b.lineTo(x, centerY + amp);
    }
    return b.build();
  }, [geometry]);

  const playheadColor = useDerivedValue(() => {
    'worklet';
    return isRecording.value ? '#EF4444' : '#FFFFFF';
  }, [isRecording]);

  const seamPath = useDerivedValue(() => {
    'worklet';
    const sv = seamMs ? seamMs.value : 0;
    const pps = pxPerSec.value;
    const empty = Skia.Path.Make();
    if (!(sv > 0) || !(pps > 0)) return empty;
    const w = widthSV.value;
    const x = PAD + w / 2 + ((sv - playheadMs.value) / 1000) * pps;
    if (x < PAD - 2 || x > PAD + w + 2) return empty;
    const b = Skia.PathBuilder.Make();
    b.moveTo(x, PAD + 1);
    b.lineTo(x, PAD + height - 1);
    return b.build();
  }, [seamMs, pxPerSec, playheadMs, widthSV]);

  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(interactive)
        .activeOffsetX([-4, 4])
        .onBegin(() => {
          'worklet';
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [interactive, playheadMs, durationMs, pxPerSec, isScrubbing, onScrubStart, onScrubEnd]
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
            strokeWidth={BAR_WIDTH + 2.4}
            strokeCap="round"
            color="#FFFFFF"
            opacity={0.07}
          />
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
            strokeWidth={BAR_WIDTH + 3.0}
            strokeCap="round"
            color="#FFFFFF"
            opacity={0.16}
          />
          <Path
            path={pastPath}
            style="stroke"
            strokeWidth={BAR_WIDTH}
            strokeCap="round"
            color="#FFFFFF"
            opacity={0.92}
          />

          {seamMs ? (
            <Path path={seamPath} style="stroke" strokeWidth={1.2} color="#F59E0B" opacity={0.85} />
          ) : null}

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

export default memo(StudioWaveform);
