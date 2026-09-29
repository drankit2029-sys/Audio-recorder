import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Animated, {
  FadeInDown,
  FadeOutUp,
  Easing,
} from 'react-native-reanimated';
import { Check, Trash2, AlertTriangle, AlertCircle } from 'lucide-react-native';

export type ToastVariant = 'success' | 'error' | 'warning' | 'delete';

export interface AppToastData {
  title: string;
  subtitle?: string;
  /** Long-form line, used to surface capture/engine warnings in full. */
  detail?: string;
  variant?: ToastVariant;
}

/**
 * SINGLE SOURCE OF TRUTH for toast placement.
 *
 * All toasts are absolutely positioned, so `top` is measured from the top of
 * the containing block. Adding the status-bar inset here guarantees an identical
 * gap across every screen and modal.
 */
const TOAST_TOP_GAP = 10;
const TOAST_MIN_TOP = 26;

export function getToastTop(topInset: number | undefined): number {
  return Math.max((topInset ?? 0) + TOAST_TOP_GAP, TOAST_MIN_TOP);
}

const VARIANT_BG: Record<ToastVariant, string> = {
  success: '#FFFFFF',
  error: '#EF4444',
  warning: '#F59E0B',
  delete: '#EF4444',
};

interface AppToastProps {
  data: AppToastData;
  top: number;
  /** Widen for multi-line warnings. */
  wide?: boolean;
}

export const AppToast: React.FC<AppToastProps> = ({ data, top, wide }) => {
  const variant: ToastVariant = data.variant ?? 'success';

  return (
    <View style={[styles.overlay, { top }]} pointerEvents="none">
      <Animated.View
        entering={FadeInDown.duration(240).easing(Easing.out(Easing.cubic))}
        exiting={FadeOutUp.duration(180).easing(Easing.in(Easing.cubic))}
        style={[styles.card, wide && styles.cardWide]}
      >
        <View
          style={[
            styles.iconCircle,
            { backgroundColor: VARIANT_BG[variant] },
          ]}
        >
          {variant === 'delete' ? (
            <Trash2 size={13} color="#FFFFFF" strokeWidth={2.5} />
          ) : variant === 'success' ? (
            <Check size={14} color="#000000" strokeWidth={3} />
          ) : variant === 'warning' ? (
            <AlertTriangle size={13} color="#000000" strokeWidth={2.6} />
          ) : (
            <AlertCircle size={14} color="#FFFFFF" strokeWidth={2.5} />
          )}
        </View>

        <View style={styles.textCol}>
          <Text style={styles.title} numberOfLines={1}>
            {data.title}
          </Text>
          {data.subtitle ? (
            <Text style={styles.subtitle} numberOfLines={1}>
              {data.subtitle}
            </Text>
          ) : null}
          {data.detail ? (
            <Text style={styles.detail} numberOfLines={3}>
              {data.detail}
            </Text>
          ) : null}
        </View>
      </Animated.View>
    </View>
  );
};

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 10000,
    elevation: 100,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#18181B',
    borderWidth: 1,
    borderColor: '#27272A',
    borderRadius: 30,
    paddingHorizontal: 16,
    paddingVertical: 10,
    maxWidth: 380,
    gap: 10,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.45,
    shadowRadius: 12,
    elevation: 8,
  },
  cardWide: {
    borderRadius: 22,
    alignItems: 'flex-start',
  },
  iconCircle: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textCol: {
    flexShrink: 1,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  subtitle: {
    color: '#8E8E93',
    fontSize: 11,
    fontWeight: '500',
    marginTop: 1,
  },
  detail: {
    color: '#D4D4D8',
    fontSize: 11,
    lineHeight: 15,
    marginTop: 5,
  },
});
