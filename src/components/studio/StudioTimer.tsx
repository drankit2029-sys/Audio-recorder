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
  /** Short screens / split-screen: shrink the type so the transport still fits. */
  compact?: boolean;
}

/**
 * The timer is a *display*, not the clock.
 *
 * The duration is owned by useAudioRecording, which ticks on a timer instead of
 * requestAnimationFrame: rAF is paused whenever the app is backgrounded or the
 * UI is occluded, which used to freeze the on-screen readout AND the
 * notification timecode during a background take.
 */
const REDRAW_INTERVAL_MS = 50;

export const StudioTimer: React.FC<StudioTimerProps> = ({
  telemetry,
  engineState,
  isTablet = false,
  compact = false,
}) => {
  const [displayMs, setDisplayMs] = useState(telemetry.current.durationMs || 0);

  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const sync = () => setDisplayMs(telemetry.current.durationMs);

    if (engineState === 'RECORDING' && !telemetry.current.isPaused) {
      sync();
      // 20 fps is plenty for a hundredths readout and costs a fifth of the
      // renders the old per-frame loop did. (M3)
      intervalId = setInterval(sync, REDRAW_INTERVAL_MS);
    } else if (engineState === 'PAUSED') {
      setDisplayMs(telemetry.current.durationMs);
    } else if (engineState === 'IDLE' || engineState === 'STOPPED') {
      setDisplayMs(0);
    }

    return () => {
      if (intervalId) clearInterval(intervalId);
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
        style={[
          styles.timerMain,
          isTablet ? styles.timerMainTablet : null,
          compact ? styles.timerMainCompact : null,
        ]}
        adjustsFontSizeToFit
        numberOfLines={1}
        maxFontSizeMultiplier={1.2}
      >{mainTime}</Text>
      <Text
        style={[
          styles.timerFrames,
          isTablet ? styles.timerFramesTablet : null,
          compact ? styles.timerFramesCompact : null,
        ]}
        maxFontSizeMultiplier={1.2}
      >{frameTime}</Text>
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
  timerMainCompact: {
    fontSize: 34,
    letterSpacing: -0.5,
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
  timerFramesCompact: {
    fontSize: 14,
  },
});
