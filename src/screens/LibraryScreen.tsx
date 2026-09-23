// src/screens/LibraryScreen.tsx
import React, { useState, useMemo, useRef, useEffect, memo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  TextInput,
  Modal,
  PanResponder,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withDelay,
  cancelAnimation,
  Easing,
} from 'react-native-reanimated';
import { useAudioPlayer } from 'expo-audio';
import * as Sharing from 'expo-sharing';
import {
  Search,
  MoreVertical,
  Edit3,
  ArrowUpDown,
  Check,
  CheckSquare,
  Square,
  Share2,
  Trash2,
  Play,
  Pause,
  X,
  Pencil,
} from 'lucide-react-native';

import { RecordingLibrary, SavedRecording } from '../services/storage/recordingLibrary';
import { useResponsive } from '../hooks/useResponsive';
import { DeleteConfirmationModal } from '../components/audio/DeleteConfirmationModal';

type SortOption =
  | 'name_asc'
  | 'name_desc'
  | 'duration_asc'
  | 'duration_desc'
  | 'date_desc'
  | 'date_asc';

interface LibraryScreenProps {
  recordings: SavedRecording[];
  onLibraryUpdate: (updated: SavedRecording[]) => void;
  onEditModeChange: (isEdit: boolean) => void;
}

const THUMB_SIZE = 14;
const TOUCH_HEIGHT = 32;
const ACCORDION_TARGET_HEIGHT = 140;

// -------------------------------------------------------------
// Isolated, Memoized Recording Card
// -------------------------------------------------------------
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

const RecordingCard = memo<RecordingCardProps>(({
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

  // Local scrub timestamp (only active during finger drag; zero setState in useEffect)
  const [localScrubSecs, setLocalScrubSecs] = useState<number | null>(null);

  const isScrubbingRef = useRef(false);
  const startRatioRef = useRef(0);
  const trackWidthRef = useRef(240);

  // Live state reference to break closures
  const livePropsRef = useRef({ isPlaying, isActive, item, onSeek });
  livePropsRef.current = { isPlaying, isActive, item, onSeek };

  // Previous playing state tracking
  const wasPlayingRef = useRef(false);

  // Seek sync locks to prevent rubber-banding
  const seekTargetSecRef = useRef<number | null>(null);
  const seekLockedUntilRef = useRef<number>(0);

  const itemTotalSecs = isActive && duration > 0 ? duration : (item.durationMs || 0) / 1000;
  const itemTotalSecsRef = useRef(itemTotalSecs);
  itemTotalSecsRef.current = itemTotalSecs;

  // Two-Phase Accordion Values
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

  // Synchronized Continuous Progress Animation Engine
  useEffect(() => {
    if (isScrubbingRef.current) return;

    const total = itemTotalSecsRef.current;
    if (!isActive || total <= 0) {
      cancelAnimation(scrubProgress);
      scrubProgress.value = 0;
      wasPlayingRef.current = false;
      return;
    }

    // State Transition: PAUSED -> PLAYING (Start immediately with zero delay)
    if (isPlaying && !wasPlayingRef.current) {
      wasPlayingRef.current = true;
      cancelAnimation(scrubProgress);

      const currentPos = scrubProgress.value;
      const remainingMs = Math.max(0, (1 - currentPos) * total * 1000);
      if (remainingMs > 0) {
        scrubProgress.value = withTiming(1, {
          duration: remainingMs,
          easing: Easing.linear,
        });
      }
      return;
    }

    // State Transition: PLAYING -> PAUSED (Freeze in place, zero snap-back)
    if (!isPlaying && wasPlayingRef.current) {
      wasPlayingRef.current = false;
      cancelAnimation(scrubProgress);
      // scrubProgress.value is preserved exactly where it stopped
      return;
    }

    // Reset when audio has fully completed and rewound
    if (!isPlaying && currentTime === 0) {
      cancelAnimation(scrubProgress);
      scrubProgress.value = 0;
      wasPlayingRef.current = false;
      return;
    }

    // Active Playback Re-anchor (Only triggers if genuine audio stall or seek occurs)
    if (isPlaying) {
      // Guard against rubber-banding: ignore stale pre-seek timestamps
      if (seekTargetSecRef.current !== null) {
        const diff = Math.abs(currentTime - seekTargetSecRef.current);
        const isTimedOut = Date.now() > seekLockedUntilRef.current;
        if (diff < 0.25 || isTimedOut) {
          seekTargetSecRef.current = null;
        } else {
          return;
        }
      }

      const currentAnimatedSecs = scrubProgress.value * total;
      const driftSecs = Math.abs(currentAnimatedSecs - currentTime);

      // Widened threshold (0.6s) absorbs native buffer startup without snapping
      if (driftSecs > 0.6) {
        cancelAnimation(scrubProgress);
        const actualRatio = Math.max(0, Math.min(1, currentTime / total));
        scrubProgress.value = actualRatio;
        const remainingMs = Math.max(0, (1 - actualRatio) * total * 1000);
        if (remainingMs > 0) {
          scrubProgress.value = withTiming(1, {
            duration: remainingMs,
            easing: Easing.linear,
          });
        }
      }
    }
  }, [isPlaying, isActive, currentTime, scrubProgress]);

  // High-Precision PanResponder
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
        const initialRatio = touchX / usableWidth;

        startRatioRef.current = initialRatio;
        scrubProgress.value = initialRatio;
        setLocalScrubSecs(initialRatio * itemTotalSecsRef.current);
      },
      onPanResponderMove: (_, gesture) => {
        const usableWidth = Math.max(1, trackWidthRef.current);
        const deltaRatio = gesture.dx / usableWidth;
        const newRatio = Math.max(0, Math.min(1, startRatioRef.current + deltaRatio));

        scrubProgress.value = newRatio;
        setLocalScrubSecs(newRatio * itemTotalSecsRef.current);
      },
      onPanResponderRelease: () => {
        thumbScale.value = withTiming(1.0, { duration: 100 });
        isScrubbingRef.current = false;

        const finalRatio = scrubProgress.value;
        const total = itemTotalSecsRef.current;
        const finalSec = finalRatio * total;

        seekTargetSecRef.current = finalSec;
        seekLockedUntilRef.current = Date.now() + 450;

        setLocalScrubSecs(null);
        livePropsRef.current.onSeek(livePropsRef.current.item, finalSec);

        // Resume linear motion immediately upon release
        if (livePropsRef.current.isPlaying && total > 0) {
          cancelAnimation(scrubProgress);
          scrubProgress.value = finalRatio;
          const remainingMs = Math.max(0, (total - finalSec) * 1000);
          if (remainingMs > 0) {
            scrubProgress.value = withTiming(1, {
              duration: remainingMs,
              easing: Easing.linear,
            });
          }
        }
      },
      onPanResponderTerminate: () => {
        thumbScale.value = withTiming(1.0, { duration: 100 });
        isScrubbingRef.current = false;
        setLocalScrubSecs(null);
      },
    })
  ).current;

  // Animated Styles
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

  const displaySecs = localScrubSecs !== null ? localScrubSecs : (isActive ? currentTime : 0);

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
      {/* Header Row */}
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

        {/* Isolated Play/Pause Hit Area */}
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

      {/* Meta Badges */}
      <View style={[styles.metaRow, isEditMode && { marginLeft: 32 }]}>
        <Text style={styles.metaBadge}>
          {item.uri.endsWith('.wav') ? 'WAV' : 'AAC'}
        </Text>
        <Text style={styles.metaText}>{formatSecs(item.durationMs / 1000)}</Text>
        <Text style={styles.metaDot}>•</Text>
        <Text style={styles.metaText}>{formatFileSize(item.sizeBytes)}</Text>
      </View>

      {/* Two-Phase Animated Section */}
      <Animated.View style={accordionContainerStyle}>
        <Animated.View style={elementsFadeStyle}>
          {/* Centered Timeline Scrubber with Padded Bounds */}
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
                {/* Background Track */}
                <View style={styles.progressTrack} pointerEvents="none">
                  <Animated.View style={[styles.progressFill, trackFillStyle]} pointerEvents="none" />
                </View>

                {/* Draggable Thumb */}
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

          {/* Action Buttons: Rename, Export, Delete */}
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

// -------------------------------------------------------------
// Main Library Screen
// -------------------------------------------------------------
export const LibraryScreen: React.FC<LibraryScreenProps> = ({
  recordings,
  onLibraryUpdate,
  onEditModeChange,
}) => {
  const { isTablet, maxContentWidth } = useResponsive();

  const [isSearching, setIsSearching] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [menuVisible, setMenuVisible] = useState(false);
  const [sortModalVisible, setSortModalVisible] = useState(false);
  const [sortOption, setSortOption] = useState<SortOption>('date_desc');

  const [isEditMode, setIsEditMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Expand / Collapse state
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // In-line Audio Player State
  const [activeId, setActiveId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const currentTimeRef = useRef(0);
  const durationRef = useRef(0);
  const ignorePollUntilRef = useRef(0);

  // Dialog States
  const [renameModalVisible, setRenameModalVisible] = useState(false);
  const [recordingToRename, setRecordingToRename] = useState<SavedRecording | null>(null);
  const [renameText, setRenameText] = useState('');

  const [deleteModalVisible, setDeleteModalVisible] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{
    type: 'single' | 'batch';
    item?: SavedRecording;
    count?: number;
  } | null>(null);

  const activeRecording = recordings.find((r) => r.id === activeId) ?? null;
  const player = useAudioPlayer(activeRecording?.uri ?? null);

  const playerRef = useRef(player);
  playerRef.current = player;

  const progressPollRef = useRef<NodeJS.Timeout | null>(null);

  // Audio Playback Trigger Loop
  useEffect(() => {
    if (!isPlaying || !player || !activeRecording) return;
    let cancelled = false;

    const triggerPlay = () => {
      if (cancelled) return;
      try {
        player.play();
      } catch {}
    };

    triggerPlay();

    const checkInterval = setInterval(() => {
      if (cancelled || player.playing) {
        clearInterval(checkInterval);
      } else {
        triggerPlay();
      }
    }, 50);

    return () => {
      cancelled = true;
      clearInterval(checkInterval);
    };
  }, [isPlaying, player, activeId, activeRecording]);

  // Audio Poller (Protected against infinite loops & false-0 readings)
  useEffect(() => {
    if (isPlaying && player) {
      progressPollRef.current = setInterval(() => {
        if (Date.now() < ignorePollUntilRef.current) {
          return;
        }

        try {
          const rawCur = player.currentTime;
          const dur =
            player.duration > 0
              ? player.duration
              : activeRecording?.durationMs
              ? activeRecording.durationMs / 1000
              : 0;

          if (typeof rawCur === 'number' && !isNaN(rawCur)) {
            // Drop false 0.00s native readings while playback is active
            if (rawCur === 0 && currentTimeRef.current > 0) {
              return;
            }

            // Only update React state when time actually shifts
            if (Math.abs(rawCur - currentTimeRef.current) >= 0.05) {
              currentTimeRef.current = rawCur;
              setCurrentTime(rawCur);
            }
          }

          // Guard setDuration from dispatching on every tick
          if (dur > 0 && Math.abs(dur - durationRef.current) > 0.1) {
            durationRef.current = dur;
            setDuration(dur);
          }

          // Natural take completion
          if (dur > 0.5 && typeof rawCur === 'number' && rawCur >= dur - 0.08) {
            setIsPlaying(false);
            currentTimeRef.current = 0;
            setCurrentTime(0);
            player.pause();
            if (typeof player.seekTo === 'function') {
              const res = player.seekTo(0);
              if (res && typeof res.catch === 'function') res.catch(() => {});
            }
          }
        } catch {}
      }, 50);
    } else {
      if (progressPollRef.current) {
        clearInterval(progressPollRef.current);
        progressPollRef.current = null;
      }
    }

    return () => {
      if (progressPollRef.current) clearInterval(progressPollRef.current);
    };
  }, [isPlaying, player, activeRecording]);

  const processedRecordings = useMemo(() => {
    let list = [...recordings];

    if (searchQuery.trim().length > 0) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter((item) => item.name.toLowerCase().includes(q));
    }

    list.sort((a, b) => {
      switch (sortOption) {
        case 'name_asc':
          return a.name.localeCompare(b.name);
        case 'name_desc':
          return b.name.localeCompare(a.name);
        case 'duration_asc':
          return a.durationMs - b.durationMs;
        case 'duration_desc':
          return b.durationMs - a.durationMs;
        case 'date_asc':
          return a.createdAt - b.createdAt;
        case 'date_desc':
        default:
          return b.createdAt - a.createdAt;
      }
    });

    return list;
  }, [recordings, searchQuery, sortOption]);

  // Plays audio AND automatically expands the card on first press
  const handlePlayToggle = (item: SavedRecording) => {
    if (expandedId !== item.id) {
      setExpandedId(item.id);
    }

    if (activeId === item.id) {
      if (isPlaying) {
        try {
          player?.pause();
        } catch {}
        setIsPlaying(false);
      } else {
        setIsPlaying(true);
      }
    } else {
      try {
        player?.pause();
      } catch {}
      setActiveId(item.id);
      currentTimeRef.current = 0;
      setCurrentTime(0);
      const initialDur = item.durationMs ? item.durationMs / 1000 : 0;
      durationRef.current = initialDur;
      setDuration(initialDur);
      setIsPlaying(true);
    }
  };

  const handleSeek = (item: SavedRecording, seconds: number) => {
    // 60ms lock gives native driver enough time to acknowledge seek without stuttering
    ignorePollUntilRef.current = Date.now() + 60;
    currentTimeRef.current = seconds;
    setCurrentTime(seconds);

    if (activeId !== item.id) {
      setActiveId(item.id);
      const initialDur = item.durationMs ? item.durationMs / 1000 : 0;
      durationRef.current = initialDur;
      setDuration(initialDur);
    }

    const activeNativePlayer = playerRef.current;
    if (activeNativePlayer && typeof activeNativePlayer.seekTo === 'function') {
      try {
        const seekPromise = activeNativePlayer.seekTo(seconds);
        if (seekPromise && typeof seekPromise.catch === 'function') {
          seekPromise.catch(() => {});
        }
      } catch {}
    }
  };

  const handleToggleExpand = (id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  const handleToggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleSelectAll = () => {
    if (selectedIds.size === processedRecordings.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(processedRecordings.map((r) => r.id)));
    }
  };

  // --- Single Item Actions ---
  const handleOpenRename = (item: SavedRecording) => {
    setRecordingToRename(item);
    setRenameText(item.name);
    setRenameModalVisible(true);
  };

  const handleSaveRename = () => {
    if (!recordingToRename) return;
    const trimmed = renameText.trim();
    if (trimmed.length > 0 && trimmed !== recordingToRename.name) {
      const updated = RecordingLibrary.rename(recordingToRename.id, trimmed);
      onLibraryUpdate(updated);
    }
    setRenameModalVisible(false);
    setRecordingToRename(null);
  };

  const handleExportSingle = async (item: SavedRecording) => {
    try {
      const isAvailable = await Sharing.isAvailableAsync();
      if (!isAvailable) return;

      await Sharing.shareAsync(item.uri, {
        dialogTitle: `Export ${item.name}`,
        mimeType: item.uri.endsWith('.wav') ? 'audio/wav' : 'audio/m4a',
      });
    } catch {}
  };

  const handleDeleteSingle = (item: SavedRecording) => {
    setDeleteTarget({ type: 'single', item });
    setDeleteModalVisible(true);
  };

  const handleBatchDelete = () => {
    if (selectedIds.size === 0) return;
    setDeleteTarget({ type: 'batch', count: selectedIds.size });
    setDeleteModalVisible(true);
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;

    if (deleteTarget.type === 'single' && deleteTarget.item) {
      const item = deleteTarget.item;
      if (activeId === item.id) {
        try {
          player?.pause();
        } catch {}
        setIsPlaying(false);
        setActiveId(null);
      }
      if (expandedId === item.id) {
        setExpandedId(null);
      }
      const updated = await RecordingLibrary.delete(item.id);
      onLibraryUpdate(updated);
    } else if (deleteTarget.type === 'batch') {
      if (activeId && selectedIds.has(activeId)) {
        try {
          player?.pause();
        } catch {}
        setIsPlaying(false);
        setActiveId(null);
      }
      if (expandedId && selectedIds.has(expandedId)) {
        setExpandedId(null);
      }

      let updated = recordings;
      for (const id of selectedIds) {
        updated = await RecordingLibrary.delete(id);
      }
      onLibraryUpdate(updated);
      setSelectedIds(new Set());
      setIsEditMode(false);
      onEditModeChange(false);
    }

    setDeleteModalVisible(false);
    setDeleteTarget(null);
  };

  const handleBatchExport = async () => {
    if (selectedIds.size === 0) return;
    const targets = recordings.filter((r) => selectedIds.has(r.id));

    try {
      const isAvailable = await Sharing.isAvailableAsync();
      if (!isAvailable) return;

      for (const item of targets) {
        await Sharing.shareAsync(item.uri, {
          dialogTitle: `Export ${item.name}`,
          mimeType: item.uri.endsWith('.wav') ? 'audio/wav' : 'audio/m4a',
        });
      }
    } catch {}
  };

  const sortLabels: Record<SortOption, string> = {
    date_desc: 'Date created (Latest to oldest)',
    date_asc: 'Date created (Oldest to latest)',
    name_asc: 'Name (A to Z)',
    name_desc: 'Name (Z to A)',
    duration_asc: 'Length (Short to long)',
    duration_desc: 'Length (Long to short)',
  };

  const renderItem = ({ item }: { item: SavedRecording }) => {
    const isThisActive = activeId === item.id;
    const isThisPlaying = isThisActive && isPlaying;
    const isSelected = selectedIds.has(item.id);
    const isExpanded = expandedId === item.id;

    return (
      <RecordingCard
        item={item}
        isActive={isThisActive}
        isPlaying={isThisPlaying}
        isExpanded={isExpanded}
        isEditMode={isEditMode}
        isSelected={isSelected}
        currentTime={currentTime}
        duration={duration}
        onToggleExpand={handleToggleExpand}
        onToggleSelect={handleToggleSelect}
        onPlayToggle={handlePlayToggle}
        onSeek={handleSeek}
        onOpenRename={handleOpenRename}
        onExport={handleExportSingle}
        onDelete={handleDeleteSingle}
      />
    );
  };

  return (
    <View style={styles.container}>
      <View style={[styles.contentConstraint, { maxWidth: maxContentWidth }]}>
        {!isEditMode ? (
          <View style={styles.header}>
            {isSearching ? (
              <View style={styles.searchBarContainer}>
                <Search size={16} color="#8E8E93" />
                <TextInput
                  style={styles.searchInput}
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                  placeholder="Search recordings..."
                  placeholderTextColor="#636366"
                  autoFocus
                />
                <TouchableOpacity
                  onPress={() => {
                    setSearchQuery('');
                    setIsSearching(false);
                  }}
                  style={styles.searchClearBtn}
                >
                  <X size={16} color="#8E8E93" />
                </TouchableOpacity>
              </View>
            ) : (
              <>
                <Text style={styles.headerTitle}>All recordings</Text>
                <View style={styles.headerRightActions}>
                  <TouchableOpacity
                    style={styles.headerIconBtn}
                    onPress={() => setIsSearching(true)}
                    activeOpacity={0.7}
                  >
                    <Search size={20} color="#FFFFFF" />
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={styles.headerIconBtn}
                    onPress={() => setMenuVisible(true)}
                    activeOpacity={0.7}
                  >
                    <MoreVertical size={20} color="#FFFFFF" />
                  </TouchableOpacity>
                </View>
              </>
            )}
          </View>
        ) : (
          <View style={styles.header}>
            <TouchableOpacity
              onPress={() => {
                setIsEditMode(false);
                setSelectedIds(new Set());
                onEditModeChange(false);
              }}
              style={styles.editModeActionBtn}
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>

            <Text style={styles.editModeCountText}>
              {selectedIds.size} selected
            </Text>

            <TouchableOpacity onPress={handleSelectAll} style={styles.editModeActionBtn}>
              <Text style={styles.selectAllText}>
                {selectedIds.size === processedRecordings.length ? 'Deselect all' : 'Select all'}
              </Text>
            </TouchableOpacity>
          </View>
        )}

        {processedRecordings.length === 0 ? (
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyTitle}>
              {searchQuery ? 'No Results Found' : 'No Recordings Yet'}
            </Text>
            <Text style={styles.emptySub}>
              {searchQuery
                ? 'Try searching with a different term.'
                : 'Tap the microphone button below to begin your first take.'}
            </Text>
          </View>
        ) : (
          <FlatList
            data={processedRecordings}
            keyExtractor={(item) => item.id}
            renderItem={renderItem}
            contentContainerStyle={styles.listContent}
            showsVerticalScrollIndicator={false}
            removeClippedSubviews={false}
            extraData={`${expandedId}-${activeId}-${isPlaying}-${selectedIds.size}`}
          />
        )}

        {isEditMode && (
          <View style={styles.bottomActionBar}>
            <TouchableOpacity
              style={[
                styles.batchActionBtn,
                selectedIds.size === 0 && styles.batchActionBtnDisabled,
              ]}
              disabled={selectedIds.size === 0}
              onPress={handleBatchExport}
              activeOpacity={0.7}
            >
              <Share2 size={16} color={selectedIds.size > 0 ? '#FFFFFF' : '#48484A'} />
              <Text
                style={[
                  styles.batchActionText,
                  selectedIds.size === 0 && styles.batchActionTextDisabled,
                ]}
              >
                Export ({selectedIds.size})
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.batchActionBtn,
                styles.batchDeleteBtn,
                selectedIds.size === 0 && styles.batchActionBtnDisabled,
              ]}
              disabled={selectedIds.size === 0}
              onPress={handleBatchDelete}
              activeOpacity={0.7}
            >
              <Trash2 size={16} color={selectedIds.size > 0 ? '#FF453A' : '#48484A'} />
              <Text
                style={[
                  styles.batchActionText,
                  styles.batchDeleteText,
                  selectedIds.size === 0 && styles.batchActionTextDisabled,
                ]}
              >
                Delete ({selectedIds.size})
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      {/* Overflow Menu */}
      <Modal
        visible={menuVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setMenuVisible(false)}
      >
        <TouchableOpacity
          style={styles.menuBackdrop}
          activeOpacity={1}
          onPress={() => setMenuVisible(false)}
        >
          <View style={styles.popoverMenu}>
            <TouchableOpacity
              style={styles.popoverItem}
              onPress={() => {
                setMenuVisible(false);
                setIsEditMode(true);
                onEditModeChange(true);
              }}
              activeOpacity={0.7}
            >
              <Edit3 size={16} color="#FFFFFF" />
              <Text style={styles.popoverItemText}>Edit</Text>
            </TouchableOpacity>

            <View style={styles.popoverDivider} />

            <TouchableOpacity
              style={styles.popoverItem}
              onPress={() => {
                setMenuVisible(false);
                setSortModalVisible(true);
              }}
              activeOpacity={0.7}
            >
              <ArrowUpDown size={16} color="#FFFFFF" />
              <Text style={styles.popoverItemText}>Sort</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Sort Options Modal */}
      <Modal
        visible={sortModalVisible}
        transparent
        animationType={isTablet ? 'fade' : 'slide'}
        onRequestClose={() => setSortModalVisible(false)}
      >
        <View style={styles.sortBackdrop}>
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={() => setSortModalVisible(false)}
          />
          <View style={[styles.sortCard, isTablet && styles.sortCardTablet]}>
            <View style={styles.sortHeader}>
              <Text style={styles.sortHeading}>Sort by</Text>
              <TouchableOpacity
                onPress={() => setSortModalVisible(false)}
                style={styles.sortCloseBtn}
              >
                <X size={16} color="#FFFFFF" />
              </TouchableOpacity>
            </View>

            {(Object.keys(sortLabels) as SortOption[]).map((key) => {
              const isSelected = sortOption === key;
              return (
                <TouchableOpacity
                  key={key}
                  style={styles.sortOptionRow}
                  onPress={() => {
                    setSortOption(key);
                    setSortModalVisible(false);
                  }}
                  activeOpacity={0.7}
                >
                  <Text
                    style={[
                      styles.sortOptionText,
                      isSelected && styles.sortOptionTextSelected,
                    ]}
                  >
                    {sortLabels[key]}
                  </Text>
                  {isSelected && <Check size={16} color="#FFFFFF" />}
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      </Modal>

      {/* Stylized Rename Recording Dialog */}
      <Modal
        visible={renameModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setRenameModalVisible(false)}
      >
        <View style={styles.modalBackdrop}>
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            style={styles.keyboardAvoidingView}
          >
            <View style={[styles.renameCard, isTablet && styles.renameCardTablet]}>
              <Text style={styles.renameTitle}>Rename Recording</Text>

              <View style={styles.renameInputWrapper}>
                <TextInput
                  style={styles.renameInput}
                  value={renameText}
                  onChangeText={setRenameText}
                  placeholder="Enter recording name..."
                  placeholderTextColor="#636366"
                  autoFocus
                  selectTextOnFocus
                  returnKeyType="done"
                  onSubmitEditing={handleSaveRename}
                />
                {renameText.length > 0 && (
                  <TouchableOpacity
                    style={styles.clearBtn}
                    onPress={() => setRenameText('')}
                    activeOpacity={0.7}
                  >
                    <X size={14} color="#8E8E93" />
                  </TouchableOpacity>
                )}
              </View>

              <View style={styles.renameActionsRow}>
                <TouchableOpacity
                  style={styles.renameCancelBtn}
                  onPress={() => {
                    setRenameModalVisible(false);
                    setRecordingToRename(null);
                  }}
                  activeOpacity={0.7}
                >
                  <Text style={styles.renameCancelBtnText}>CANCEL</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.renameSaveBtn}
                  onPress={handleSaveRename}
                  activeOpacity={0.8}
                >
                  <Check size={15} color="#000000" strokeWidth={2.5} />
                  <Text style={styles.renameSaveBtnText}>SAVE</Text>
                </TouchableOpacity>
              </View>
            </View>
          </KeyboardAvoidingView>
        </View>
      </Modal>

      {/* Stylized Delete Confirmation Dialog */}
      <DeleteConfirmationModal
        visible={deleteModalVisible}
        title={deleteTarget?.type === 'single' ? 'Delete Take' : 'Delete Recordings'}
        description={
          deleteTarget?.type === 'single'
            ? `Permanently delete "${deleteTarget.item?.name}"? This action cannot be undone.`
            : `Permanently delete ${deleteTarget?.count} recording${(deleteTarget?.count ?? 0) > 1 ? 's' : ''}? This action cannot be undone.`
        }
        onConfirm={handleConfirmDelete}
        onCancel={() => {
          setDeleteModalVisible(false);
          setDeleteTarget(null);
        }}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  contentConstraint: {
    flex: 1,
    width: '100%',
    alignSelf: 'center',
  },
  header: {
    height: 60,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#1F1F1F',
  },
  headerTitle: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  headerRightActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerIconBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#121212',
  },
  searchBarContainer: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#161618',
    borderRadius: 10,
    paddingHorizontal: 12,
    height: 42,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: 15,
    padding: 0,
  },
  searchClearBtn: {
    padding: 4,
  },
  editModeActionBtn: {
    paddingVertical: 6,
    paddingHorizontal: 8,
  },
  cancelText: {
    color: '#8E8E93',
    fontSize: 15,
    fontWeight: '500',
  },
  editModeCountText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  selectAllText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  listContent: {
    padding: 16,
    paddingBottom: 180,
    gap: 10,
  },
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

  /* Isolated Play/Pause Hit Area */
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

  /* Scrubber Layout with Unified Coordinates */
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

  /* In-Line Action Buttons */
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

  /* Batch Bottom Action Bar */
  bottomActionBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingVertical: 16,
    paddingHorizontal: 24,
    backgroundColor: '#121212',
    borderTopWidth: 1,
    borderTopColor: '#242424',
  },
  batchActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: '#1E1E20',
  },
  batchActionBtnDisabled: {
    opacity: 0.4,
  },
  batchActionText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  batchActionTextDisabled: {
    color: '#636366',
  },
  batchDeleteBtn: {
    backgroundColor: '#211212',
  },
  batchDeleteText: {
    color: '#FF453A',
  },

  /* Overlays & Modals */
  menuBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  popoverMenu: {
    position: 'absolute',
    top: 60,
    right: 18,
    width: 160,
    backgroundColor: '#1C1C1E',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#2C2C2E',
    paddingVertical: 4,
    elevation: 10,
  },
  popoverItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  popoverItemText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  popoverDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#2C2C2E',
  },
  sortBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.85)',
    justifyContent: 'flex-end',
  },
  sortCard: {
    backgroundColor: '#141414',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    borderColor: '#262626',
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 32,
    gap: 4,
  },
  sortCardTablet: {
    alignSelf: 'center',
    width: 480,
    borderRadius: 24,
    marginBottom: 60,
  },
  sortHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#222222',
    marginBottom: 8,
  },
  sortHeading: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
  },
  sortCloseBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#202020',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sortOptionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    paddingHorizontal: 8,
  },
  sortOptionText: {
    color: '#8E8E93',
    fontSize: 15,
    fontWeight: '500',
  },
  sortOptionTextSelected: {
    color: '#FFFFFF',
    fontWeight: '700',
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    marginTop: 100,
  },
  emptyTitle: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 6,
  },
  emptySub: {
    color: '#71717A',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.82)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  keyboardAvoidingView: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  renameCard: {
    width: '100%',
    maxWidth: 400,
    backgroundColor: '#141416',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: '#262628',
    padding: 22,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.5,
    shadowRadius: 18,
    elevation: 16,
  },
  renameCardTablet: {
    maxWidth: 460,
    padding: 26,
  },
  renameTitle: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: -0.3,
    marginBottom: 16,
  },
  renameInputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0C0C0E',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#26262A',
    paddingHorizontal: 14,
    height: 50,
    marginBottom: 18,
  },
  renameInput: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '500',
    padding: 0,
  },
  clearBtn: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#1E1E22',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 8,
  },
  renameActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 10,
  },
  renameCancelBtn: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 12,
    backgroundColor: '#1C1C1E',
    borderWidth: 1,
    borderColor: '#2A2A2E',
  },
  renameCancelBtnText: {
    color: '#8E8E93',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  renameSaveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 12,
    backgroundColor: '#FFFFFF',
  },
  renameSaveBtnText: {
    color: '#000000',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
});