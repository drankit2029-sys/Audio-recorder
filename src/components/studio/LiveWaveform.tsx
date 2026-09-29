// src/components/studio/LiveWaveform.tsx
import React, { useEffect, useRef, useState } from 'react';
import { View, StyleSheet, LayoutChangeEvent } from 'react-native';
import { Canvas, Path, Skia } from '@shopify/react-native-skia';
import { EngineState } from '../../services/audio/useAudioRecording';

interface LiveWaveformProps {
  telemetry: React.MutableRefObject<{
    meteringDb: number;
    isPaused: boolean;
    waveformHistory?: number[];
  }>;
  engineState: EngineState;
  height?: number;
}

const BAR_COUNT = 156;
const BASELINE_AMPLITUDE = 0.00;
const NOISE_FLOOR_DB = -40;
const PEAK_DB = 0;
const GLOW_PADDING = 24;

/**
 * Metering only arrives about 30 times a second, so the tape is driven by a
 * 30 Hz timer rather than requestAnimationFrame: the old per-frame loop
 * rebuilt a 156-segment Skia path 60 times a second — on top of the timer's own
 * loop — and burned a GPU blur on every frame, which is what made low-end
 * devices stutter while recording. (M3)
 */
const PUSH_INTERVAL_MS = 33;

export const LiveWaveform: React.FC<LiveWaveformProps> = ({
  telemetry,
  engineState,
  height = 112,
}) => {
  const [canvasWidth, setCanvasWidth] = useState(240);

  const historyRef = useRef<number[]>(new Array(BAR_COUNT).fill(BASELINE_AMPLITUDE));
  const currentAmpRef = useRef(BASELINE_AMPLITUDE);
  const glowRef = useRef(0);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (engineState === 'IDLE' || engineState === 'STOPPED') {
      historyRef.current = new Array(BAR_COUNT).fill(BASELINE_AMPLITUDE);
      currentAmpRef.current = BASELINE_AMPLITUDE;
      glowRef.current = 0;
      setTick((t) => (t + 1) % 10000);
      return;
    }

    // When RECORDING starts, check if telemetry has a preloaded resumed waveform tape
    if (engineState === 'RECORDING') {
      const existing = telemetry.current.waveformHistory;
      if (existing && existing.some((val) => val > 0.05)) {
        historyRef.current = [...existing];
        glowRef.current = 0.35; // Enable ambient glow right away
        setTick((t) => (t + 1) % 10000);
      }
    }

    if (engineState === 'PAUSED' || telemetry.current.isPaused) {
      return;
    }

    const step = () => {
      if (telemetry.current.isPaused) return;

      const rawDb = telemetry.current.meteringDb;

      let targetAmp = BASELINE_AMPLITUDE;
      if (rawDb > NOISE_FLOOR_DB) {
        const normalized = Math.max(0, Math.min(1.0, (rawDb - NOISE_FLOOR_DB) / (PEAK_DB - NOISE_FLOOR_DB)));
        targetAmp = Math.max(BASELINE_AMPLITUDE, Math.pow(normalized, 1.5));
      }

      if (targetAmp > currentAmpRef.current) {
        currentAmpRef.current += (targetAmp - currentAmpRef.current) * 0.90;
      } else {
        currentAmpRef.current += (targetAmp - currentAmpRef.current) * 0.40;
      }

      if (targetAmp > glowRef.current) {
        glowRef.current += (targetAmp - glowRef.current) * 0.12;
      } else {
        glowRef.current += (targetAmp - glowRef.current) * 0.035;
      }

      historyRef.current.push(currentAmpRef.current);
      if (historyRef.current.length > BAR_COUNT) {
        historyRef.current.shift();
      }
      // Mirror the active tape into the telemetry ref for session journaling
      telemetry.current.waveformHistory = historyRef.current;

      setTick((t) => (t + 1) % 10000);
    };

    const intervalId = setInterval(step, PUSH_INTERVAL_MS);
    return () => {
      clearInterval(intervalId);
    };
  }, [engineState, telemetry]);

  const onLayout = (e: LayoutChangeEvent) => {
    const w = Math.round(e.nativeEvent.layout.width);
    if (w > 0 && Math.abs(w - canvasWidth) > 1) {
      setCanvasWidth(w);
    }
  };

  const centerY = GLOW_PADDING + height / 2;
  const maxDeflection = height * 0.44;
  const stepX = canvasWidth / BAR_COUNT;
  const barWidth = 1;

  const path = Skia.Path.Make();
  const data = historyRef.current;
  const isActive = engineState === 'RECORDING' || engineState === 'PAUSED';
  const glow = isActive ? glowRef.current : 0;

  for (let i = 0; i < data.length; i++) {
    const x = GLOW_PADDING + i * stepX + stepX / 2;
    const halfAmp = Math.max(1.8, data[i] * maxDeflection);
    path.moveTo(x, centerY - halfAmp);
    path.lineTo(x, centerY + halfAmp);
  }

  return (
    <View style={[styles.container, { height }]} onLayout={onLayout} pointerEvents="none">
      <View style={[styles.centerLine, { top: height / 2 }]} />

      <Canvas
        style={{
          position: 'absolute',
          top: -GLOW_PADDING,
          left: -GLOW_PADDING,
          width: canvasWidth + GLOW_PADDING * 2,
          height: height + GLOW_PADDING * 2,
        }}
      >
        {/* Ambient glow: a wide, soft stroke. A BlurMask used to be applied to
            this path on every frame — far too expensive to run during capture
            on low-end hardware, for an effect that is barely visible. (M3) */}
        {isActive && glow > 0.01 ? (
          <Path
            path={path}
            style="stroke"
            strokeWidth={barWidth + 8}
            strokeCap="round"
            color="#FFFFFF"
            opacity={Math.min(0.28, Math.max(0.06, glow * 0.3))}
          />
        ) : null}

        {/* Sharp Solid White Waveform Bars */}
        <Path
          path={path}
          style="stroke"
          strokeWidth={barWidth}
          strokeCap="round"
          color="#FFFFFF"
          opacity={isActive ? Math.min(1.0, 0.55 + glow * 0.45) : 0.18}
        />
      </Canvas>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    width: '100%',
    position: 'relative',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 4,
    overflow: 'visible',
  },
  centerLine: {
    position: 'absolute',
    left: 8,
    right: 8,
    height: 1,
    backgroundColor: '#16161A',
    zIndex: -1,
  },
});
