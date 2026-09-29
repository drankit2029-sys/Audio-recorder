import { useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export type SizeClass = 'compact' | 'medium' | 'expanded';

export interface ResponsiveMetrics {
  width: number;
  height: number;
  insets: ReturnType<typeof useSafeAreaInsets>;
  /** Shortest window edge in dp — the metric Android itself uses. */
  shortestEdge: number;
  isLandscape: boolean;
  /** >= 600dp on the shortest edge: tablets and unfolded foldables. */
  isTablet: boolean;
  /**
   * M11: `isTablet` alone left a gap. A 717x512 unfolded foldable is not a
   * tablet by the 600dp rule, and neither is a 5" phone in landscape, but both
   * need the compact treatment rather than the phone-portrait one.
   */
  sizeClass: SizeClass;
  /** Window height minus the system bars (mandatory edge-to-edge on API 36). */
  contentHeight: number;
  /** True when the studio does not have room for a full-height prompter. */
  isCompactHeight: boolean;
  maxContentWidth: number;
}

export function useResponsive(): ResponsiveMetrics {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  const isLandscape = width > height;
  const shortestEdge = Math.min(width, height);
  // Standard Android breakpoint: devices with shortest edge >= 600dp are tablets
  const isTablet = shortestEdge >= 600;

  const sizeClass: SizeClass =
    shortestEdge >= 600 ? 'expanded' : shortestEdge >= 360 ? 'medium' : 'compact';

  // Height the app can actually draw into. The old code budgeted against the
  // raw window height, which is why the transport fell off the bottom on small
  // phones and in split-screen. (M1)
  const contentHeight = Math.max(0, height - insets.top - insets.bottom);
  const isCompactHeight = contentHeight < 560;

  // Max width constraint to prevent unreadable stretching on large tablets
  const maxContentWidth = isTablet ? 840 : 480;

  return {
    width,
    height,
    insets,
    shortestEdge,
    isTablet,
    isLandscape,
    sizeClass,
    contentHeight,
    isCompactHeight,
    maxContentWidth,
  };
}
