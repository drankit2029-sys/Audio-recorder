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
   * Bumped by the session every time the peak table grows by a block, so the
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

/**
 * The waveform is a fixed playhead in the middle of the screen with the take
 * sliding underneath it. Three things make that read as smooth motion:
 *
 * 1. The bar geometry is rebuilt only when the head moves a whole pixel, not on
 *    every frame.
 * 2. Bars read a level-of-detail table, so a rebuild costs ~one read per bar.
 * 3. The bar at the head of the take grows in as its 20 ms bucket fills, so the
 *    last bucket is a short ramp rather than the "hole" the eye used to read as
 *    the wave lagging behind the playhead.
 *
 * WHY THE GEOMETRY IS WRITTEN OUT INLINE AND NOT FACTORED INTO A HELPER
 * ----------------------------------------------------------------------------
 * A worklet only receives the *values* it captures, and the worklets compiler
 * has to be able to hoist everything it calls. A helper defined in this same
 * file with a `'worklet'` directive is hoisted into the worklet's init data (the
 * pattern `StudioTimer.tsx` and `WaveformZoomControl.tsx` use). A function
 * imported from another module is not: it lands in `this.__closure` as a remote
 * reference, and calling it synchronously on the UI runtime throws
 *
 *   [Worklets] Tried to synchronously call a Remote Function. Called "quantiseHeadMs"
 *
 * which is the crash an earlier revision of this file produced while the
 * geometry lived in `./waveformModel` - `react-native-worklets/plugin` emits zero
 * `registerRemoteFunction` calls for this project, so no cross-module function is
 * callable from a worklet here, while numbers and arrays always are.
 *
 * Rather than depend on that hoisting step working for every helper, the block
 * between the two markers below is the whole algorithm, inline, using nothing but
 * shared values and the constants above. It also means one scan builds both
 * halves of the wave (the previous shape ran the loop twice, once per path).
 * `scripts/tests/waveform-model.test.ts` extracts this block between the markers
 * and executes it verbatim, so the unit test runs the shipped text rather than a
 * re-implementation - move the markers and the test fails loudly instead of
 * silently testing a copy.
 */
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
  // One table per LOD level (the count of LOD_FACTORS is fixed, so the hook
  // calls stay static). Level 0 is the raw bucket table.
  const lod0 = useSharedValue<number[]>([]);
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
  // Rebuilt when the session says the peak table grew by a block (a few ms for a
  // whole take), never on a per-frame path.
  const lastVersionRef = useRef(-1);
  useEffect(() => {
    if (lastVersionRef.current === peakVersion) return;
    lastVersionRef.current = peakVersion;

    const source = peaks.value;
    const n = source ? source.length : 0;
    if (n === 0) {
      lodCount.value = 0;
      lod0.value = [];
      lod1.value = [];
      lod2.value = [];
      lod3.value = [];
      lod4.value = [];
      return;
    }
    lod0.value = source;
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

  /**
   * The head position rounded to a whole pixel. Nothing downstream recomputes
   * while this is unchanged, which is the difference between 60 rebuilds a
   * second and the handful it actually needs.
   */
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
    const durMs = durationMs.value;
    const playMs = quantMs.value;
    const dur = durMs / 1000;
    if (!(pps > 0) || !(dur > 0) || !(w > 0)) return empty;

    const t = playMs / 1000;
    const secPerBar = BAR_SPACING / pps;
    if (!(secPerBar > 0)) return empty;
    const half = w / 2 / pps;
    const cx = PAD + w / 2;

    // Pick the coarsest table whose bucket is still finer than a bar, so one bar
    // reads one entry (up to 64 when a bar spans several buckets).
    let level = 0;
    let bucketSec = PEAK_BUCKET_SEC * LOD_FACTORS[0];
    while (level < LOD_FACTORS.length - 1 && bucketSec * 0.75 < secPerBar) {
      level = level + 1;
      bucketSec = PEAK_BUCKET_SEC * LOD_FACTORS[level];
    }
    const tables = [lod0, lod1, lod2, lod3, lod4];
    const arr = tables[level].value;
    const n = arr ? arr.length : 0;
    if (n === 0) return empty;

    const perBar = Math.max(1, Math.min(64, Math.round(secPerBar / bucketSec)));
    const iStart = Math.max(0, Math.floor((t - half) / secPerBar) - 1);
    const iEnd = Math.min(
      Math.ceil(dur / secPerBar),
      Math.ceil((t + half) / secPerBar) + 1
    );

    // The ramp for the bucket being written right now, derived from the *exact*
    // head position: a timer would dim every bar near the head between two peak
    // publishes (which arrive ~2x per second, not 50x).
    const headMs = playheadMs.value;
    const bucketMs = PEAK_BUCKET_SEC * 1000;
    const headEdge = Math.floor(headMs / bucketMs) * bucketMs;
    const age = headMs - headEdge;
    const growMs = bucketMs * GROW_FRACTION;
    const g = age >= growMs ? 1 : Math.max(0.2, age / growMs);
    const recording = isRecording.value;
    // The bucket being written runs from headEdge to headEdge + 20 ms; only the
    // bars whose centre falls inside it get the ramp.
    const edgeSec = headEdge / 1000;
    const rampEndSec = edgeSec + PEAK_BUCKET_SEC;

    let reads = 0;
    for (let i = iStart; i < iEnd; i++) {
      const t0 = i * secPerBar;
      if (t0 >= dur) break;
      const mid = t0 + secPerBar / 2;

      // Anchored on the bucket covering the bar's *middle*: when bars are finer
      // than the peak table (high zoom) neighbours repeat the same bucket, which
      // is what keeps the wave solid instead of a dotted line - and when they
      // are coarser, perBar buckets are max-reduced.
      const k0 = Math.floor(mid / bucketSec);
      if (k0 >= n) continue;
      let v = 0;
      const k1 = Math.min(n, k0 + perBar);
      for (let k = k0; k < k1; k++) {
        reads = reads + 1;
        const pk = arr[k];
        if (pk > v) v = pk;
      }
      if (v <= 0) continue;

      let amp = (v / 255) * maxDeflection;
      // Only the head of a *recording* ramps; while previewing the head is old
      // data and dimming it would flicker.
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

  // Two three-line path builders. Skia objects are worklet-safe; they are the
  // only thing touched here, so they re-run cheaply whenever the geometry moves.
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

  /** Amber tick where the take was parked by an interruption, if any. */
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

          {/* A wide low-alpha stroke reads as a glow for a fraction of a
              BlurMask, and a blur on a path of hundreds of segments was the most
              expensive element on this canvas. */}
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
