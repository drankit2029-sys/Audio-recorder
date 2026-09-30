// src/components/studio/StudioTimer.tsx
import React, { useMemo, useState } from 'react';
import { View, StyleSheet, LayoutChangeEvent, Platform } from 'react-native';
import { Canvas, Text as SkiaText, matchFont, Group } from '@shopify/react-native-skia';
import { SharedValue, useDerivedValue } from 'react-native-reanimated';

interface StudioTimerProps {
  /** The studio playhead (UI thread). */
  playheadMs: SharedValue<number>;
  isTablet?: boolean;
  /** Short screens / split-screen: shrink the type so the transport still fits. */
  compact?: boolean;
}

const HOUR_MS = 3600000;
const GAP = 2;

const pad2 = (n: number): string => {
  'worklet';
  return n < 10 ? `0${n}` : `${n}`;
};

/**
 * The timer reads the studio playhead on the UI thread and is drawn with Skia,
 * so the hundredths redraw every frame (60 fps) without React renders, and it
 * follows the waveform while it is being scrolled.
 */
export const StudioTimer: React.FC<StudioTimerProps> = ({
  playheadMs,
  isTablet = false,
  compact = false,
}) => {
  const mainSize = isTablet ? 64 : compact ? 34 : 44;
  const fracSize = isTablet ? 24 : compact ? 14 : 17;
  const [width, setWidth] = useState(0);

  const fonts = useMemo(() => {
    try {
      const family = Platform.select({ ios: 'Helvetica Neue', default: 'sans-serif' });
      const main = matchFont({ fontFamily: family, fontSize: mainSize, fontWeight: '200', fontStyle: 'normal' });
      const frac = matchFont({ fontFamily: family, fontSize: fracSize, fontWeight: '300', fontStyle: 'normal' });
      const wMain = main.measureText('00:00').width;
      const wMainHours = main.measureText('00:00:00').width;
      const wFrac = frac.measureText('.00').width;
      const metrics = main.getMetrics();
      return { main, frac, wMain, wMainHours, wFrac, ascent: metrics.ascent, descent: metrics.descent };
    } catch {
      return null;
    }
  }, [mainSize, fracSize]);

  const canvasHeight = Math.ceil(mainSize * 1.22);

  const mainText = useDerivedValue(() => {
    const ms = Math.max(0, playheadMs.value);
    const total = Math.floor(ms / 1000);
    const hrs = Math.floor(total / 3600);
    const mins = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    return hrs > 0 ? `${pad2(hrs)}:${pad2(mins)}:${pad2(secs)}` : `${pad2(mins)}:${pad2(secs)}`;
  });

  const fracText = useDerivedValue(() => {
    const ms = Math.max(0, playheadMs.value);
    return `.${pad2(Math.floor((ms % 1000) / 10))}`;
  });

  const wMain = fonts?.wMain ?? 0;
  const wMainHours = fonts?.wMainHours ?? 0;
  const wFrac = fonts?.wFrac ?? 0;

  const mainX = useDerivedValue(() => {
    const mw = playheadMs.value >= HOUR_MS ? wMainHours : wMain;
    return (width - (mw + GAP + wFrac)) / 2;
  });

  const fracX = useDerivedValue(() => {
    const mw = playheadMs.value >= HOUR_MS ? wMainHours : wMain;
    return (width - (mw + GAP + wFrac)) / 2 + mw + GAP;
  });

  const onLayout = (e: LayoutChangeEvent) => {
    const w = Math.round(e.nativeEvent.layout.width);
    if (w > 0 && w !== width) setWidth(w);
  };

  // Shrink to fit narrow windows (the widest reading has hours).
  const widest = wMainHours + GAP + wFrac;
  const scale = width > 0 && widest > width ? width / widest : 1;
  const baseline = fonts
    ? (canvasHeight - (fonts.descent - fonts.ascent)) / 2 - fonts.ascent
    : canvasHeight * 0.8;

  return (
    <View style={[styles.container, { height: canvasHeight }]} onLayout={onLayout}>
      {fonts && width > 0 ? (
        <Canvas style={{ width, height: canvasHeight }}>
          <Group
            transform={[{ scale }]}
            origin={{ x: width / 2, y: canvasHeight / 2 }}
          >
            <SkiaText x={mainX} y={baseline} text={mainText} font={fonts.main} color="#FFFFFF" />
            <SkiaText x={fracX} y={baseline} text={fracText} font={fonts.frac} color="#71717A" />
          </Group>
        </Canvas>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    width: '100%',
    marginTop: 4,
    marginBottom: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
