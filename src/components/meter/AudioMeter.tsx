// src/components/meter/AudioMeter.tsx
import React, { useEffect, useRef } from 'react';
import { View, StyleSheet, Text } from 'react-native';
import {
  Canvas,
  RoundedRect,
  LinearGradient,
  vec,
  Rect,
} from '@shopify/react-native-skia';
import {
  useSharedValue,
  useDerivedValue,
  withTiming,
  Easing,
  cancelAnimation,
} from 'react-native-reanimated';
import { EngineState } from '../../services/audio/useAudioRecording';

interface AudioMeterProps {
  telemetry: React.MutableRefObject<{ meteringDb: number }>;
  engineState: EngineState;
}

const DB_TICKS = [0, -6, -12, -18, -24, -36, -48, -60];

// Non-linear piecewise mapping matching the 7 intervals of the legend ticks
function dbToNorm(db: number): number {
  if (db <= -60) return 0;
  if (db >= 0) return 1;

  if (db < -48) {
    return (0 + (db - -60) / 12) / 7;
  } else if (db < -36) {
    return (1 + (db - -48) / 12) / 7;
  } else if (db < -24) {
    return (2 + (db - -36) / 12) / 7;
  } else if (db < -18) {
    return (3 + (db - -24) / 6) / 7;
  } else if (db < -12) {
    return (4 + (db - -18) / 6) / 7; // Sweet spot lower threshold (-18 dBFS)
  } else if (db < -6) {
    return (5 + (db - -12) / 6) / 7; // Sweet spot upper threshold (-12 dBFS)
  } else {
    return (6 + (db - -6) / 6) / 7; // Danger headroom zone (-6 to 0 dBFS)
  }
}

export const AudioMeter: React.FC<AudioMeterProps> = ({ telemetry, engineState }) => {
  const barWidth = 9;
  const layoutHeight = 140;

  const meterLevel = useSharedValue(0);
  const peakHoldLevel = useSharedValue(0);
  const peakDecayTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (engineState === 'IDLE' || engineState === 'STOPPED') {
      if (peakDecayTimeoutRef.current) clearTimeout(peakDecayTimeoutRef.current);
      cancelAnimation(meterLevel);
      cancelAnimation(peakHoldLevel);
      meterLevel.value = withTiming(0, { duration: 180, easing: Easing.out(Easing.quad) });
      peakHoldLevel.value = withTiming(0, { duration: 200, easing: Easing.out(Easing.quad) });
      return;
    }

    if (engineState === 'PAUSED') {
      if (peakDecayTimeoutRef.current) clearTimeout(peakDecayTimeoutRef.current);
      cancelAnimation(meterLevel);
      cancelAnimation(peakHoldLevel);
      return;
    }

    let frameId: number;
    let lastDb = -999;

    const tick = () => {
      const rawDb = telemetry.current.meteringDb;
      if (rawDb !== lastDb) {
        lastDb = rawDb;
        const targetNorm = dbToNorm(rawDb);

        // Immediate assignment: ballistics are computed smoothly in useAudioRecording
        meterLevel.value = targetNorm;

        if (targetNorm >= peakHoldLevel.value) {
          if (peakDecayTimeoutRef.current) clearTimeout(peakDecayTimeoutRef.current);
          peakHoldLevel.value = targetNorm;

          peakDecayTimeoutRef.current = setTimeout(() => {
            peakHoldLevel.value = withTiming(0, {
              duration: 1600,
              easing: Easing.linear,
            });
          }, 900);
        }
      }
      frameId = requestAnimationFrame(tick);
    };

    frameId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frameId);
      if (peakDecayTimeoutRef.current) clearTimeout(peakDecayTimeoutRef.current);
    };
  }, [engineState, telemetry, meterLevel, peakHoldLevel]);

  const activeHeight = useDerivedValue(() => Math.max(0, meterLevel.value * layoutHeight));
  const activeY = useDerivedValue(() => layoutHeight - activeHeight.value);
  const cornerRadius = useDerivedValue(() => Math.min(2.5, activeHeight.value / 2));
  const peakY = useDerivedValue(() => Math.max(0, layoutHeight - peakHoldLevel.value * layoutHeight - 2));
  const peakOpacity = useDerivedValue(() => (peakHoldLevel.value > 0.02 ? 1 : 0));

  return (
    <View style={styles.container}>
      <View style={[styles.canvasFrame, { width: barWidth, height: layoutHeight }]}>
        <Canvas style={{ width: barWidth, height: layoutHeight }}>
          <RoundedRect x={0} y={0} width={barWidth} height={layoutHeight} r={2.5} color="#0D0D10" />

          <RoundedRect x={0} y={activeY} width={barWidth} height={activeHeight} r={cornerRadius}>
            <LinearGradient
              start={vec(0, layoutHeight)}
              end={vec(0, 0)}
              colors={['#10B981', '#34D399', '#FBBF24', '#F97316', '#EF4444']}
              positions={[0, 0.571, 0.714, 0.857, 1.0]}
            />
          </RoundedRect>

          <Rect x={0} y={peakY} width={barWidth} height={2} color="#FFFFFF" opacity={peakOpacity} />
        </Canvas>
      </View>

      <View style={[styles.legendColumn, { height: layoutHeight }]}>
        {DB_TICKS.map((db) => {
          const label = db === 0 ? '0' : String(db);
          const isSweet = db === -18 || db === -12;
          const isClip = db === 0;
          return (
            <Text
              key={db}
              style={[
                styles.tickText,
                isSweet ? styles.sweetSpotText : null,
                isClip ? styles.clipTickText : null,
              ]}
            >
              {label}
            </Text>
          );
        })}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'center',
    gap: 4,
  },
  canvasFrame: {
    borderRadius: 2.5,
    overflow: 'hidden',
    backgroundColor: '#09090B',
    borderWidth: 1,
    borderColor: '#1E1E22',
  },
  legendColumn: {
    justifyContent: 'space-between',
    paddingVertical: 1,
  },
  tickText: {
    color: '#636366',
    fontSize: 8,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
    width: 16,
  },
  sweetSpotText: {
    color: '#34D399',
  },
  clipTickText: {
    color: '#EF4444',
  },
});