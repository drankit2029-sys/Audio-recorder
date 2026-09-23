// src/hooks/useResponsive.ts
import { useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export function useResponsive() {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  const isLandscape = width > height;
  const smallestDimension = Math.min(width, height);
  // Standard Android breakpoint: devices with shortest edge >= 600dp are tablets
  const isTablet = smallestDimension >= 600;

  // Max width constraint to prevent unreadable stretching on large tablets
  const maxContentWidth = isTablet ? 840 : 480;
  
  // Adaptive heights for teleprompter viewing window
  const prompterHeight = isTablet ? 240 : height < 700 ? 110 : 140;

  return {
    width,
    height,
    insets,
    isTablet,
    isLandscape,
    maxContentWidth,
    prompterHeight,
  };
}