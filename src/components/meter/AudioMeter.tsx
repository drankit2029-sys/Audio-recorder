// src/components/meter/AudioMeter.tsx
import React, { useEffect, useState } from 'react';
import { View, StyleSheet, Text, LayoutChangeEvent } from 'react-native';
import {
  Canvas,
  Rect,
  LinearGradient,
  vec,
  Line,
  RoundedRect,
} from '@shopify/react-native-skia';
import {
  useSharedValue,
  useDerivedValue,
  withTiming,
  Easing,
} from 'react-native-reanimated';

interface AudioMeterProps {
  meteringDb: number;
  isRecording: boolean;
}

const MIN_DB = -60;
const MAX_DB = 0;

export const AudioMeter: React.FC<AudioMeterProps> = ({ meteringDb, isRecording }) => {
  const [layoutWidth, setLayoutWidth] = useState(260);
  const barHeight = 16;

  // Reanimated Shared Values
  const meterLevel = useSharedValue(0); // 0.0 to 1.0
  const peakLevel = useSharedValue(0);  // 0.0 to 1.0

  useEffect(() => {
    if (!isRecording) {
      meterLevel.value = withTiming(0, { duration: 250 });
      peakLevel.value = withTiming(0, { duration: 400 });
      return;
    }

    // Normalize dB to range [0, 1]
    const clampedDb = Math.max(MIN_DB, Math.min(MAX_DB, meteringDb));
    const targetNorm = (clampedDb - MIN_DB) / (MAX_DB - MIN_DB);

    // Ballistics: Instant attack, smooth exponential decay
    if (targetNorm > meterLevel.value) {
      meterLevel.value = targetNorm;
    } else {
      meterLevel.value = withTiming(targetNorm, {
        duration: 320,
        easing: Easing.out(Easing.quad),
      });
    }

    // Peak-hold ballistics
    if (targetNorm >= peakLevel.value) {
      peakLevel.value = targetNorm;
    } else {
      peakLevel.value = withTiming(targetNorm, {
        duration: 1200,
        easing: Easing.linear,
      });
    }
  }, [meteringDb, isRecording, meterLevel, peakLevel]);

  const onLayout = (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    if (w > 0) setLayoutWidth(w);
  };

  // Shared scalar values consumed directly by Skia components
  const activeWidth = useDerivedValue(() => {
    return Math.max(0, meterLevel.value * layoutWidth);
  });

  const peakX = useDerivedValue(() => {
    return Math.max(0, Math.min(layoutWidth - 2, peakLevel.value * layoutWidth));
  });

  return (
    <View style={styles.wrapper}>
      {/* Header labels */}
      <View style={styles.labelRow}>
        <Text style={styles.dbText}>-60</Text>
        <Text style={styles.dbText}>-24</Text>
        <Text style={styles.dbText}>-12</Text>
        <Text style={styles.dbText}>-6</Text>
        <Text style={styles.dbText}>-3</Text>
        <Text style={[styles.dbText, styles.clipText]}>0 dBFS</Text>
      </View>

      {/* Skia Metering Canvas */}
      <View style={[styles.canvasContainer, { height: barHeight }]} onLayout={onLayout}>
        <Canvas style={{ width: layoutWidth, height: barHeight }}>
          {/* Background trough */}
          <RoundedRect
            x={0}
            y={0}
            width={layoutWidth}
            height={barHeight}
            r={4}
            color="#262626"
          />

          {/* Active audio level bar */}
          <RoundedRect
            x={0}
            y={0}
            width={activeWidth}
            height={barHeight}
            r={4}
          >
            <LinearGradient
              start={vec(0, 0)}
              end={vec(layoutWidth, 0)}
              colors={['#00E676', '#76FF03', '#FFD600', '#FF1744']}
              positions={[0, 0.65, 0.85, 1.0]}
            />
          </RoundedRect>

          {/* Calibration ticks */}
          <Line
            p1={vec(layoutWidth * 0.60, 0)}
            p2={vec(layoutWidth * 0.60, barHeight)}
            color="#121212"
            strokeWidth={1}
          />
          <Line
            p1={vec(layoutWidth * 0.80, 0)}
            p2={vec(layoutWidth * 0.80, barHeight)}
            color="#121212"
            strokeWidth={1}
          />
          <Line
            p1={vec(layoutWidth * 0.90, 0)}
            p2={vec(layoutWidth * 0.90, barHeight)}
            color="#121212"
            strokeWidth={1}
          />

          {/* Floating Peak Hold Line (rendered via scalar Rect) */}
          <Rect
            x={peakX}
            y={0}
            width={2}
            height={barHeight}
            color="#FFFFFF"
          />
        </Canvas>
      </View>

      {/* Live Readout */}
      <View style={styles.readoutRow}>
        <Text style={styles.readoutValue}>
          {isRecording ? `${meteringDb.toFixed(1)} dBFS` : 'OFFLINE'}
        </Text>
        <Text style={[styles.clipIndicator, meteringDb >= -0.5 && styles.clipActive]}>
          CLIP
        </Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  wrapper: {
    width: '100%',
    paddingHorizontal: 16,
    marginVertical: 12,
  },
  labelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  dbText: {
    color: '#757575',
    fontSize: 10,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  clipText: {
    color: '#FF5252',
  },
  canvasContainer: {
    width: '100%',
    borderRadius: 4,
    overflow: 'hidden',
    backgroundColor: '#262626',
  },
  readoutRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 6,
  },
  readoutValue: {
    color: '#B0BEC5',
    fontSize: 12,
    fontFamily: 'monospace',
  },
  clipIndicator: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1,
    color: '#424242',
  },
  clipActive: {
    color: '#FF1744',
  },
});