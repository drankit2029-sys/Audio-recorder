// src/components/studio/StudioTimer.tsx
import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { EngineState } from '../../services/audio/useAudioRecording';

interface StudioTimerProps {
  telemetry: React.MutableRefObject<{
    durationMs: number;
    startTime: number;
    accumulatedMs: number;
    isPaused: boolean;
  }>;
  engineState: EngineState;
  isTablet?: boolean;
}

export const StudioTimer: React.FC<StudioTimerProps> = ({
  telemetry,
  engineState,
  isTablet = false,
}) => {
  const [displayMs, setDisplayMs] = useState(0);

  useEffect(() => {
    let frameId: number;

    const tick = () => {
      if (telemetry.current.isPaused || engineState === 'PAUSED') {
        return;
      }

      if (engineState === 'RECORDING') {
        const currentSegment = Date.now() - telemetry.current.startTime;
        const total = telemetry.current.accumulatedMs + Math.max(0, currentSegment);
        telemetry.current.durationMs = total;
        setDisplayMs(total);
        frameId = requestAnimationFrame(tick);
      }
    };

    if (engineState === 'RECORDING' && !telemetry.current.isPaused) {
      frameId = requestAnimationFrame(tick);
    } else if (engineState === 'IDLE' || engineState === 'STOPPED') {
      setDisplayMs(0);
    }

    return () => {
      if (frameId) cancelAnimationFrame(frameId);
    };
  }, [engineState, telemetry]);

  const totalSeconds = Math.floor(displayMs / 1000);
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  const centis = Math.floor((displayMs % 1000) / 10);

  const mainTime = hrs > 0
    ? `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
    : `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;

  const frameTime = '.' + centis.toString().padStart(2, '0');

  return (
    <View style={styles.container}>
      <Text
        style={[styles.timerMain, isTablet ? styles.timerMainTablet : null]}
        adjustsFontSizeToFit
        numberOfLines={1}
      >{mainTime}</Text>
      <Text style={[styles.timerFrames, isTablet ? styles.timerFramesTablet : null]}>{frameTime}</Text>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'center',
    marginTop: 4,
    marginBottom: 2,
    flexShrink: 1,
  },
  timerMain: {
    fontSize: 44,
    fontWeight: '200',
    color: '#FFFFFF',
    fontVariant: ['tabular-nums'],
    letterSpacing: -1.0,
  },
  timerMainTablet: {
    fontSize: 64,
  },
  timerFrames: {
    fontSize: 17,
    fontWeight: '300',
    color: '#71717A',
    fontVariant: ['tabular-nums'],
    marginLeft: 2,
  },
  timerFramesTablet: {
    fontSize: 24,
  },
});