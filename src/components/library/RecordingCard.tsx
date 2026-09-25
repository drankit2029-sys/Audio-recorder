// src/components/library/RecordingCard.tsx
import React, { useState, useRef, useEffect, memo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  PanResponder,
} from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withDelay,
  cancelAnimation,
  Easing,
} from 'react-native-reanimated';
import {
  CheckSquare,
  Square,
  Play,
  Pause,
  Pencil,
  Share2,
  Trash2,
} from 'lucide-react-native';
import { SavedRecording } from '../../services/storage/recordingLibrary';

const THUMB_SIZE = 14;
const TOUCH_HEIGHT = 32;
const ACCORDION_TARGET_HEIGHT = 140;

interface RecordingCardProps {
  item: SavedRecording;
  isActive: boolean;
  isPlaying: boolean;
  isExpanded: boolean;
  isEditMode: boolean;
  isSelected: boolean;
  currentTime: number;
  duration: number;
  onToggleExpand: (id: string) => void;
  onToggleSelect: (id: string) => void;
  onPlayToggle: (item: SavedRecording) => void;
  onSeek: (item: SavedRecording, seconds: number) => void;
  onOpenRename: (item: SavedRecording) => void;
  onExport: (item: SavedRecording) => void;
  onDelete: (item: SavedRecording) => void;
}

export const RecordingCard = memo<RecordingCardProps>(({
  item,
  isActive,
  isPlaying,
  isExpanded,
  isEditMode,
  isSelected,
  currentTime,
  duration,
  onToggleExpand,
  onToggleSelect,
  onPlayToggle,
  onSeek,
  onOpenRename,
  onExport,
  onDelete,
}) => {
  const scrubProgress = useSharedValue(0);
  const thumbScale = useSharedValue(1);

  const [localScrubSecs, setLocalScrubSecs] = useState<number | null>(null);

  const isScrubbingRef = useRef(false);
  const startRatioRef = useRef(0);
  const trackWidthRef = useRef(240);
  const lastScrubUpdateRef = useRef(0);

  // Seek latch protecting against stale React props right after finger release
  const seekRatioRef = useRef<number | null>(null);
  const lastSeekTimestampRef = useRef<number>(0);

  const livePropsRef = useRef({ isPlaying, isActive, item, onSeek });
  livePropsRef.current = { isPlaying, isActive, item, onSeek };

  const itemTotalSecs = item.durationMs > 0 ? item.durationMs / 1000 : duration > 0 ? duration : 0;
  const itemTotalSecsRef = useRef(itemTotalSecs);
  itemTotalSecsRef.current = itemTotalSecs;

  const expandHeight = useSharedValue(0);
  const contentOpacity = useSharedValue(0);
  const hasOpenedRef = useRef(false);

  useEffect(() => {
    const cubicEase = Easing.out(Easing.cubic);

    if (isExpanded) {
      hasOpenedRef.current = true;
      expandHeight.value = withTiming(ACCORDION_TARGET_HEIGHT, {
        duration: 240,
        easing: cubicEase,
      });
      contentOpacity.value = withDelay(
        150,
        withTiming(1, { duration: 180, easing: Easing.out(Easing.quad) })
      );
    } else {
      if (hasOpenedRef.current) {
        contentOpacity.value = withTiming(0, {
          duration: 80,
          easing: Easing.in(Easing.quad),
        });
        expandHeight.value = withDelay(
          60,
          withTiming(0, { duration: 210, easing: Easing.inOut(Easing.cubic) })
        );
      }
    }
  }, [isExpanded, expandHeight, contentOpacity]);

  // Audio-Clock Synchronized Progress Engine with Zero Snap-Back
  useEffect(() => {
    if (isScrubbingRef.current) return;

    const total = itemTotalSecsRef.current;
    if (!isActive || total <= 0) {
      cancelAnimation(scrubProgress);
      scrubProgress.value = 0;
      seekRatioRef.current = null;
      return;
    }

    const targetRatio = Math.max(0, Math.min(1, currentTime / total));

    // Latch guard: Ignore lagging pre-seek incoming currentTime for 500ms
    if (seekRatioRef.current !== null) {
      const timeSinceSeek = Date.now() - lastSeekTimestampRef.current;
      const ratioDiff = Math.abs(targetRatio - seekRatioRef.current);

      if (ratioDiff < 0.04 || timeSinceSeek > 500) {
        seekRatioRef.current = null;
      } else {
        return;
      }
    }

    if (!isPlaying) {
      cancelAnimation(scrubProgress);
      scrubProgress.value = targetRatio;
    } else {
      scrubProgress.value = withTiming(targetRatio, {
        duration: 50,
        easing: Easing.linear,
      });
    }
  }, [currentTime, isPlaying, isActive, scrubProgress]);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (evt) => {
        isScrubbingRef.current = true;
        cancelAnimation(scrubProgress);
        thumbScale.value = withTiming(1.35, { duration: 100 });

        const usableWidth = Math.max(1, trackWidthRef.current);
        const touchX = Math.max(0, Math.min(usableWidth, evt.nativeEvent.locationX));
        const initialRatio = Math.max(0, Math.min(1, touchX / usableWidth));

        startRatioRef.current = initialRatio;
        scrubProgress.value = initialRatio;
        lastScrubUpdateRef.current = Date.now();
        setLocalScrubSecs(initialRatio * itemTotalSecsRef.current);
      },
      onPanResponderMove: (_, gesture) => {
        const usableWidth = Math.max(1, trackWidthRef.current);
        const deltaRatio = gesture.dx / usableWidth;
        const newRatio = Math.max(0, Math.min(1, startRatioRef.current + deltaRatio));

        scrubProgress.value = newRatio;

        const now = Date.now();
        if (now - lastScrubUpdateRef.current > 40) {
          lastScrubUpdateRef.current = now;
          setLocalScrubSecs(newRatio * itemTotalSecsRef.current);
        }
      },
      onPanResponderRelease: () => {
        thumbScale.value = withTiming(1.0, { duration: 100 });
        const finalRatio = scrubProgress.value;
        const total = itemTotalSecsRef.current;
        const finalSec = finalRatio * total;

        // Establish post-seek latch
        seekRatioRef.current = finalRatio;
        lastSeekTimestampRef.current = Date.now();

        setLocalScrubSecs(null);
        isScrubbingRef.current = false;

        // Immediately project forward motion without waiting for native thread
        if (livePropsRef.current.isPlaying && total > 0) {
          cancelAnimation(scrubProgress);
          scrubProgress.value = finalRatio;
          const remainingMs = Math.max(0, (1 - finalRatio) * total * 1000);
          if (remainingMs > 0) {
            scrubProgress.value = withTiming(1, {
              duration: remainingMs,
              easing: Easing.linear,
            });
          }
        }

        livePropsRef.current.onSeek(livePropsRef.current.item, finalSec);
      },
      onPanResponderTerminate: () => {
        thumbScale.value = withTiming(1.0, { duration: 100 });
        setLocalScrubSecs(null);
        isScrubbingRef.current = false;
        seekRatioRef.current = null;
      },
    })
  ).current;

  const accordionContainerStyle = useAnimatedStyle(() => ({
    height: expandHeight.value,
    overflow: 'hidden',
  }));

  const elementsFadeStyle = useAnimatedStyle(() => ({
    opacity: contentOpacity.value,
  }));

  const trackFillStyle = useAnimatedStyle(() => ({
    width: `${Math.max(0, Math.min(100, scrubProgress.value * 100))}%`,
  }));

  const scrubThumbStyle = useAnimatedStyle(() => ({
    left: `${Math.max(0, Math.min(100, scrubProgress.value * 100))}%`,
    transform: [{ scale: thumbScale.value }],
  }));

  const formatFileSize = (bytes: number): string => {
    if (bytes <= 0) return '0 KB';
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  const formatSecs = (seconds: number): string => {
    const s = Math.floor(seconds || 0);
    const mins = Math.floor(s / 60);
    const secs = s % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const displaySecs =
    localScrubSecs !== null
      ? localScrubSecs
      : seekRatioRef.current !== null
      ? seekRatioRef.current * itemTotalSecs
      : isActive
      ? currentTime
      : 0;

  return (
    <TouchableOpacity
      style={[
        styles.card,
        isExpanded && styles.cardActive,
        isSelected && styles.cardSelected,
      ]}
      onPress={() => {
        if (isEditMode) {
          onToggleSelect(item.id);
        } else {
          onToggleExpand(item.id);
        }
      }}
      activeOpacity={0.88}
    >
      <View style={styles.cardHeaderRow}>
        {isEditMode && (
          <TouchableOpacity
            style={styles.checkboxTouch}
            onPress={() => onToggleSelect(item.id)}
          >
            {isSelected ? (
              <CheckSquare size={20} color="#FFFFFF" />
            ) : (
              <Square size={20} color="#555555" />
            )}
          </TouchableOpacity>
        )}

        <View style={styles.cardInfoCol}>
          <Text style={styles.cardTitle} numberOfLines={1}>
            {item.name}
          </Text>
          <Text style={styles.cardTimestamp}>
            {new Date(item.createdAt).toLocaleDateString([], {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </Text>
        </View>

        {!isEditMode && (
          <TouchableOpacity
            style={styles.playCircleTouchArea}
            onPress={() => onPlayToggle(item)}
            hitSlop={{ top: 14, bottom: 14, left: 14, right: 14 }}
            activeOpacity={0.75}
          >
            <View style={styles.playCircleBtn}>
              {isPlaying && isActive ? (
                <Pause size={15} color="#000000" fill="#000000" />
              ) : (
                <Play size={15} color="#000000" fill="#000000" style={{ marginLeft: 2 }} />
              )}
            </View>
          </TouchableOpacity>
        )}
      </View>

      <View style={[styles.metaRow, isEditMode && { marginLeft: 32 }]}>
        <Text style={styles.metaBadge}>
          {item.uri.endsWith('.wav') ? 'WAV' : 'AAC'}
        </Text>
        <Text style={styles.metaText}>{formatSecs(itemTotalSecs)}</Text>
        <Text style={styles.metaDot}>•</Text>
        <Text style={styles.metaText}>{formatFileSize(item.sizeBytes)}</Text>
      </View>

      <Animated.View style={accordionContainerStyle}>
        <Animated.View style={elementsFadeStyle}>
          <View style={styles.progressSection}>
            <View style={styles.scrubWrapper}>
              <View
                style={styles.scrubTouchArea}
                onLayout={(e) => {
                  const w = e.nativeEvent.layout.width;
                  if (w > 0) trackWidthRef.current = w;
                }}
                {...panResponder.panHandlers}
              >
                <View style={styles.progressTrack} pointerEvents="none">
                  <Animated.View style={[styles.progressFill, trackFillStyle]} pointerEvents="none" />
                </View>

                <Animated.View
                  style={[styles.scrubThumb, scrubThumbStyle]}
                  pointerEvents="none"
                />
              </View>
            </View>

            <View style={styles.timeRow}>
              <Text style={styles.timeText}>{formatSecs(displaySecs)}</Text>
              <Text style={styles.timeText}>{formatSecs(itemTotalSecs)}</Text>
            </View>
          </View>

          <View style={styles.actionsRow}>
            <TouchableOpacity
              style={styles.actionBtn}
              onPress={() => onOpenRename(item)}
              activeOpacity={0.7}
            >
              <Pencil size={13} color="#FFFFFF" />
              <Text style={styles.actionBtnText}>RENAME</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.actionBtn}
              onPress={() => onExport(item)}
              activeOpacity={0.7}
            >
              <Share2 size={13} color="#FFFFFF" />
              <Text style={styles.actionBtnText}>EXPORT</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.actionBtn, styles.deleteBtn]}
              onPress={() => onDelete(item)}
              activeOpacity={0.7}
            >
              <Trash2 size={13} color="#FF453A" />
              <Text style={styles.deleteBtnText}>DELETE</Text>
            </TouchableOpacity>
          </View>
        </Animated.View>
      </Animated.View>
    </TouchableOpacity>
  );
});

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#121212',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#1E1E1E',
    padding: 16,
  },
  cardActive: {
    borderColor: '#383838',
    backgroundColor: '#161616',
  },
  cardSelected: {
    borderColor: '#FFFFFF',
    backgroundColor: '#1A1A1A',
  },
  cardHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  checkboxTouch: {
    paddingRight: 4,
  },
  cardInfoCol: {
    flex: 1,
  },
  cardTitle: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  cardTimestamp: {
    color: '#71717A',
    fontSize: 12,
    marginTop: 2,
  },
  playCircleTouchArea: {
    padding: 10,
    marginRight: -10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playCircleBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 10,
  },
  metaBadge: {
    backgroundColor: '#242426',
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '700',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  metaText: {
    color: '#8E8E93',
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },
  metaDot: {
    color: '#3A3A3C',
    fontSize: 10,
  },
  progressSection: {
    marginTop: 14,
  },
  scrubWrapper: {
    paddingHorizontal: 8,
  },
  scrubTouchArea: {
    height: TOUCH_HEIGHT,
    justifyContent: 'center',
    position: 'relative',
    width: '100%',
  },
  progressTrack: {
    height: 4,
    backgroundColor: '#262628',
    borderRadius: 2,
    overflow: 'hidden',
    width: '100%',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#FFFFFF',
  },
  scrubThumb: {
    position: 'absolute',
    top: (TOUCH_HEIGHT - THUMB_SIZE) / 2,
    marginLeft: -THUMB_SIZE / 2,
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: THUMB_SIZE / 2,
    backgroundColor: '#FFFFFF',
  },
  timeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    marginTop: 4,
  },
  timeText: {
    color: '#8E8E93',
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },
  actionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 14,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#202022',
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#1E1E22',
    borderWidth: 1,
    borderColor: '#2A2A2E',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  actionBtnText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  deleteBtn: {
    marginLeft: 'auto',
    backgroundColor: '#1E1212',
    borderColor: '#301818',
  },
  deleteBtnText: {
    color: '#FF453A',
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
});