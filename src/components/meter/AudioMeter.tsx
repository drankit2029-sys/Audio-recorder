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
  const barHeight = 14;

  const meterLevel = useSharedValue(0);
  const peakLevel = useSharedValue(0);

  useEffect(() => {
    if (!isRecording) {
      meterLevel.value = withTiming(0, { duration: 250 });
      peakLevel.value = withTiming(0, { duration: 400 });
      return;
    }

    const clampedDb = Math.max(MIN_DB, Math.min(MAX_DB, meteringDb));
    const targetNorm = (clampedDb - MIN_DB) / (MAX_DB - MIN_DB);

    if (targetNorm > meterLevel.value) {
      meterLevel.value = targetNorm;
    } else {
      meterLevel.value = withTiming(targetNorm, {
        duration: 320,
        easing: Easing.out(Easing.quad),
      });
    }

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
          <RoundedRect
            x={0}
            y={0}
            width={layoutWidth}
            height={barHeight}
            r={3}
            color="#1C1C1E"
          />

          <RoundedRect
            x={0}
            y={0}
            width={activeWidth}
            height={barHeight}
            r={3}
          >
            <LinearGradient
              start={vec(0, 0)}
              end={vec(layoutWidth, 0)}
              colors={['#30D158', '#FFD60A', '#FF453A']}
              positions={[0, 0.75, 1.0]}
            />
          </RoundedRect>

          <Line
            p1={vec(layoutWidth * 0.60, 0)}
            p2={vec(layoutWidth * 0.60, barHeight)}
            color="#000000"
            strokeWidth={1}
          />
          <Line
            p1={vec(layoutWidth * 0.80, 0)}
            p2={vec(layoutWidth * 0.80, barHeight)}
            color="#000000"
            strokeWidth={1}
          />
          <Line
            p1={vec(layoutWidth * 0.90, 0)}
            p2={vec(layoutWidth * 0.90, barHeight)}
            color="#000000"
            strokeWidth={1}
          />

          <Rect
            x={peakX}
            y={0}
            width={2}
            height={barHeight}
            color="#FFFFFF"
          />
        </Canvas>
      </View>

      {/* Live Readout in System Default Font */}
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
    paddingHorizontal: 8,
    marginVertical: 10,
  },
  labelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  dbText: {
    color: '#8E8E93',
    fontSize: 10,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  clipText: {
    color: '#FF453A',
  },
  canvasContainer: {
    width: '100%',
    borderRadius: 3,
    overflow: 'hidden',
    backgroundColor: '#1C1C1E',
  },
  readoutRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 6,
  },
  readoutValue: {
    color: '#A1A1A1',
    fontSize: 12,
    fontWeight: '500',
    fontVariant: ['tabular-nums'],
  },
  clipIndicator: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1,
    color: '#3A3A3C',
  },
  clipActive: {
    color: '#FF453A',
  },
});