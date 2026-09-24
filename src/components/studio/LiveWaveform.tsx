// src/components/studio/LiveWaveform.tsx
import React, { useEffect, useRef, useState } from 'react';
import { View, StyleSheet, LayoutChangeEvent } from 'react-native';
import { Canvas, Path, Skia, LinearGradient, vec, BlurMask } from '@shopify/react-native-skia';
import { EngineState } from '../../services/audio/useAudioRecording';

interface LiveWaveformProps {
  telemetry: React.MutableRefObject<{
    meteringDb: number;
    isPaused: boolean;
  }>;
  engineState: EngineState;
  height?: number;
}

const HISTORY_POINTS = 46;
const BASELINE_AMPLITUDE = 0.04;
const NOISE_FLOOR_DB = -52;
const GLOW_PADDING = 36;

export const LiveWaveform: React.FC<LiveWaveformProps> = ({
  telemetry,
  engineState,
  height = 56,
}) => {
  const [canvasWidth, setCanvasWidth] = useState(200);
  const historyRef = useRef<number[]>(new Array(HISTORY_POINTS).fill(BASELINE_AMPLITUDE));

  const envelopeRef = useRef<number>(BASELINE_AMPLITUDE);
  const glowEnvelopeRef = useRef<number>(0);

  const [, setTick] = useState(0);

  useEffect(() => {
    if (engineState === 'IDLE' || engineState === 'STOPPED') {
      historyRef.current = new Array(HISTORY_POINTS).fill(BASELINE_AMPLITUDE);
      envelopeRef.current = BASELINE_AMPLITUDE;
      glowEnvelopeRef.current = 0;
      setTick((t) => (t + 1) % 10000);
      return;
    }

    if (engineState === 'PAUSED' || telemetry.current.isPaused) {
      return;
    }

    let frameId: number;
    let lastTime = Date.now();

    const tick = () => {
      // Instantly freezes waveform on Frame 0
      if (telemetry.current.isPaused) {
        return;
      }

      const now = Date.now();
      if (now - lastTime >= 33) {
        lastTime = now;
        const rawDb = telemetry.current.meteringDb;
        let targetAmp = BASELINE_AMPLITUDE;
        let targetGlow = 0;

        if (rawDb > NOISE_FLOOR_DB) {
          const normalized = Math.max(0, Math.min(1.0, (rawDb - NOISE_FLOOR_DB) / (0 - NOISE_FLOOR_DB)));
          targetAmp = Math.max(BASELINE_AMPLITUDE, Math.pow(normalized, 1.8));
          targetGlow = Math.pow(normalized, 1.8);
        }

        if (targetAmp > envelopeRef.current) {
          envelopeRef.current += (targetAmp - envelopeRef.current) * 0.60;
        } else {
          envelopeRef.current += (targetAmp - envelopeRef.current) * 0.15;
        }

        if (targetGlow > glowEnvelopeRef.current) {
          glowEnvelopeRef.current += (targetGlow - glowEnvelopeRef.current) * 0.035;
        } else {
          glowEnvelopeRef.current += (targetGlow - glowEnvelopeRef.current) * 0.015;
        }

        historyRef.current.push(envelopeRef.current);
        if (historyRef.current.length > HISTORY_POINTS) {
          historyRef.current.shift();
        }

        setTick((t) => (t + 1) % 10000);
      }

      frameId = requestAnimationFrame(tick);
    };

    frameId = requestAnimationFrame(tick);
    return () => {
      if (frameId) cancelAnimationFrame(frameId);
    };
  }, [engineState, telemetry]);

  const onLayout = (e: LayoutChangeEvent) => {
    const w = Math.round(e.nativeEvent.layout.width);
    if (w > 0 && Math.abs(w - canvasWidth) > 1) {
      setCanvasWidth(w);
    }
  };

  const centerY = GLOW_PADDING + height / 2;
  const maxDeflection = height * 0.38;
  const stepX = canvasWidth / HISTORY_POINTS;
  const barWidth = Math.max(2.0, stepX * 0.40);

  const path = Skia.Path.Make();
  const data = historyRef.current;

  for (let i = 0; i < data.length; i++) {
    const x = GLOW_PADDING + i * stepX + stepX / 2;
    const amp = Math.max(2, data[i] * maxDeflection);
    path.moveTo(x, centerY - amp);
    path.lineTo(x, centerY + amp);
  }

  const isActive = engineState === 'RECORDING' || engineState === 'PAUSED';
  const glow = isActive ? glowEnvelopeRef.current : 0;

  const neonPalette = ['#00F0FF', '#7000FF', '#FF0078', '#FF8A00'];
  const hotCorePalette = ['#E0FFFF', '#F5E6FF', '#FFE6F0', '#FFF0E6'];
  const idlePalette = ['#27272A', '#3F3F46', '#27272A'];

  const baseColors = isActive ? neonPalette : idlePalette;

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
        {glow > 0.01 ? (
          <Path
            path={path}
            style="stroke"
            strokeWidth={barWidth + 14}
            strokeCap="round"
            opacity={glow * 0.55}
          >
            <LinearGradient start={vec(GLOW_PADDING, centerY)} end={vec(GLOW_PADDING + canvasWidth, centerY)} colors={neonPalette} />
            <BlurMask blur={24} style="normal" />
          </Path>
        ) : null}

        {glow > 0.01 ? (
          <Path
            path={path}
            style="stroke"
            strokeWidth={barWidth + 6}
            strokeCap="round"
            opacity={glow * 0.85}
          >
            <LinearGradient start={vec(GLOW_PADDING, centerY)} end={vec(GLOW_PADDING + canvasWidth, centerY)} colors={neonPalette} />
            <BlurMask blur={10} style="normal" />
          </Path>
        ) : null}

        <Path
          path={path}
          style="stroke"
          strokeWidth={barWidth}
          strokeCap="round"
          opacity={isActive ? 0.35 + glow * 0.5 : 0.15}
        >
          <LinearGradient start={vec(GLOW_PADDING, centerY)} end={vec(GLOW_PADDING + canvasWidth, centerY)} colors={baseColors} />
        </Path>

        {glow > 0.05 ? (
          <Path
            path={path}
            style="stroke"
            strokeWidth={barWidth * 0.4}
            strokeCap="round"
            opacity={glow * 0.95}
          >
            <LinearGradient start={vec(GLOW_PADDING, centerY)} end={vec(GLOW_PADDING + canvasWidth, centerY)} colors={hotCorePalette} />
          </Path>
        ) : null}
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