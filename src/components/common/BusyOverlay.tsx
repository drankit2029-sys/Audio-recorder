// src/components/common/BusyOverlay.tsx
import React from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

interface BusyOverlayProps {
  visible: boolean;
  title: string;
  subtitle?: string;
  /** 0-1, or null/undefined for an indeterminate spinner only. */
  progress?: number | null;
}

/**
 * Blocking progress card used while a take is opened for editing, recovered
 * after a crash, or encoded into its delivery format.
 */
export const BusyOverlay: React.FC<BusyOverlayProps> = ({ visible, title, subtitle, progress }) => {
  if (!visible) return null;
  const pct =
    typeof progress === 'number' && Number.isFinite(progress)
      ? Math.max(0, Math.min(1, progress))
      : null;

  return (
    <Animated.View
      entering={FadeIn.duration(160)}
      exiting={FadeOut.duration(140)}
      style={styles.backdrop}
      pointerEvents="auto"
    >
      <View style={styles.card}>
        <View style={styles.headerRow}>
          <ActivityIndicator size="small" color="#FFFFFF" />
          <View style={styles.textCol}>
            <Text style={styles.title} numberOfLines={1}>
              {title}
            </Text>
            {subtitle ? (
              <Text style={styles.subtitle} numberOfLines={1}>
                {subtitle}
              </Text>
            ) : null}
          </View>
          {pct !== null ? <Text style={styles.pct}>{Math.round(pct * 100)}%</Text> : null}
        </View>
        {pct !== null ? (
          <View style={styles.track}>
            <View style={[styles.fill, { width: `${Math.max(2, pct * 100)}%` }]} />
          </View>
        ) : null}
      </View>
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0, 0, 0, 0.72)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 28,
    zIndex: 30000,
    elevation: 140,
  },
  card: {
    width: '100%',
    maxWidth: 340,
    backgroundColor: '#141418',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#26262F',
    paddingHorizontal: 18,
    paddingVertical: 16,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  textCol: {
    flex: 1,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: -0.1,
  },
  subtitle: {
    color: '#8E8E93',
    fontSize: 11,
    marginTop: 2,
  },
  pct: {
    color: '#E4E4E7',
    fontSize: 12,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  track: {
    height: 4,
    borderRadius: 2,
    backgroundColor: '#26262F',
    overflow: 'hidden',
    marginTop: 14,
  },
  fill: {
    height: '100%',
    borderRadius: 2,
    backgroundColor: '#FFFFFF',
  },
});
