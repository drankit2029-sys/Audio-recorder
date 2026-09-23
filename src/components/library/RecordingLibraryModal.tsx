// src/components/library/RecordingLibraryModal.tsx
import React, { useState, useEffect, useRef } from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Alert,
  PanResponder,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAudioPlayer } from 'expo-audio';
import * as Sharing from 'expo-sharing';
import { Play, Pause, Share2, Trash2, X, Music } from 'lucide-react-native';

import { RecordingLibrary, SavedRecording } from '../../services/storage/recordingLibrary';
import { useResponsive } from '../../hooks/useResponsive';

interface RecordingLibraryModalProps {
  visible: boolean;
  onClose: () => void;
  recordings: SavedRecording[];
  onLibraryUpdate: (updated: SavedRecording[]) => void;
}

export const RecordingLibraryModal: React.FC<RecordingLibraryModalProps> = ({
  visible,
  onClose,
  recordings,
  onLibraryUpdate,
}) => {
  const { isTablet } = useResponsive();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const [isScrubbing, setIsScrubbing] = useState(false);
  const [scrubTime, setScrubTime] = useState(0);

  const activeRecording = recordings.find((r) => r.id === activeId) ?? null;
  const player = useAudioPlayer(activeRecording?.uri ?? null);

  const playerRef = useRef(player);
  playerRef.current = player;

  const totalSecs = duration > 0 ? duration : (activeRecording?.durationMs ?? 0) / 1000;
  const totalSecsRef = useRef(totalSecs);
  totalSecsRef.current = totalSecs;

  const progressPollRef = useRef<NodeJS.Timeout | null>(null);
  const trackWidthRef = useRef<number>(260);
  const startXRef = useRef<number>(0);

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

  useEffect(() => {
    if (isPlaying && player && !isScrubbing) {
      progressPollRef.current = setInterval(() => {
        try {
          const cur = player.currentTime || 0;
          const dur =
            player.duration > 0
              ? player.duration
              : activeRecording?.durationMs
              ? activeRecording.durationMs / 1000
              : 0;

          setCurrentTime(cur);
          if (dur > 0) setDuration(dur);

          if (dur > 0 && cur >= dur) {
            setIsPlaying(false);
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
  }, [isPlaying, player, isScrubbing, activeRecording]);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (evt) => {
        setIsScrubbing(true);
        startXRef.current = evt.nativeEvent.locationX;
        const width = trackWidthRef.current || 260;
        const maxSecs = totalSecsRef.current || 1;
        const ratio = Math.max(0, Math.min(1, startXRef.current / width));
        setScrubTime(ratio * maxSecs);
      },
      onPanResponderMove: (_, gesture) => {
        const width = trackWidthRef.current || 260;
        const maxSecs = totalSecsRef.current || 1;
        const currentX = Math.max(0, Math.min(width, startXRef.current + gesture.dx));
        const ratio = currentX / width;
        setScrubTime(ratio * maxSecs);
      },
      onPanResponderRelease: (_, gesture) => {
        const width = trackWidthRef.current || 260;
        const maxSecs = totalSecsRef.current || 1;
        const currentX = Math.max(0, Math.min(width, startXRef.current + gesture.dx));
        const finalSec = (currentX / width) * maxSecs;

        const activeNativePlayer = playerRef.current;
        if (activeNativePlayer && typeof activeNativePlayer.seekTo === 'function') {
          try {
            const seekPromise = activeNativePlayer.seekTo(finalSec);
            if (seekPromise && typeof seekPromise.catch === 'function') {
              seekPromise.catch((err: any) => {
                console.warn('[RecordingLibraryModal] Native seek rejected:', err);
              });
            }
          } catch (err) {
            console.warn('[RecordingLibraryModal] Synchronous seek error:', err);
          }
        }

        setCurrentTime(finalSec);
        setIsScrubbing(false);
      },
      onPanResponderTerminate: () => {
        setIsScrubbing(false);
      },
    })
  ).current;

  const handlePlayToggle = (item: SavedRecording) => {
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
      setCurrentTime(0);
      setDuration(item.durationMs ? item.durationMs / 1000 : 0);
      setIsPlaying(true);
    }
  };

  const handleClose = () => {
    if (isPlaying) {
      try {
        player?.pause();
      } catch {}
      setIsPlaying(false);
    }
    onClose();
  };

  const handleShare = async (item: SavedRecording) => {
    try {
      const isAvailable = await Sharing.isAvailableAsync();
      if (!isAvailable) {
        Alert.alert('Sharing Unavailable', 'Native sharing is not supported on this device.');
        return;
      }
      await Sharing.shareAsync(item.uri, {
        dialogTitle: `Export ${item.name}`,
        mimeType: item.uri.endsWith('.wav') ? 'audio/wav' : 'audio/m4a',
      });
    } catch (err: any) {
      Alert.alert('Share Failed', err.message);
    }
  };

  const handleDelete = (item: SavedRecording) => {
    Alert.alert('Delete Take', `Permanently delete "${item.name}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          if (activeId === item.id) {
            try {
              player?.pause();
            } catch {}
            setIsPlaying(false);
            setActiveId(null);
          }
          const updated = await RecordingLibrary.delete(item.id);
          onLibraryUpdate(updated);
        },
      },
    ]);
  };

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

  const renderItem = ({ item }: { item: SavedRecording }) => {
    const isThisActive = activeId === item.id;
    const isThisPlaying = isThisActive && isPlaying;

    const itemTotalSecs = isThisActive && duration > 0 ? duration : item.durationMs / 1000;
    const displayTime = isThisActive ? (isScrubbing ? scrubTime : currentTime) : 0;
    const progressPct =
      isThisActive && itemTotalSecs > 0
        ? Math.min(100, Math.max(0, (displayTime / itemTotalSecs) * 100))
        : 0;

    return (
      <View style={[styles.card, isThisActive && styles.cardActive]}>
        <View style={styles.cardHeader}>
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

        <View style={styles.metaRow}>
          <View style={styles.metaBadge}>
            <Text style={styles.metaBadgeText}>
              {item.uri.endsWith('.wav') ? 'WAV' : 'AAC'}
            </Text>
          </View>
          <Text style={styles.metaText}>{formatSecs(item.durationMs / 1000)}</Text>
          <Text style={styles.metaDivider}>•</Text>
          <Text style={styles.metaText}>{formatFileSize(item.sizeBytes)}</Text>
        </View>

        {isThisActive && (
          <View style={styles.progressSection}>
            <View
              style={styles.scrubTouchArea}
              {...panResponder.panHandlers}
              onLayout={(e) => {
                trackWidthRef.current = e.nativeEvent.layout.width;
              }}
            >
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: `${progressPct}%` }]} />
              </View>

              <View
                style={[
                  styles.scrubThumb,
                  {
                    left: `${progressPct}%`,
                    transform: [{ scale: isScrubbing ? 1.25 : 1.0 }],
                  },
                ]}
              />
            </View>

            <View style={styles.timeRow}>
              <Text style={styles.timeText}>{formatSecs(displayTime)}</Text>
              <Text style={styles.timeText}>{formatSecs(itemTotalSecs)}</Text>
            </View>
          </View>
        )}

        <View style={styles.actionsRow}>
          <TouchableOpacity
            style={[styles.playCircleBtn, isThisPlaying && styles.playCircleBtnActive]}
            onPress={() => handlePlayToggle(item)}
            activeOpacity={0.8}
          >
            {isThisPlaying ? (
              <Pause size={18} color="#000000" />
            ) : (
              <Play size={18} color="#000000" style={{ marginLeft: 2 }} />
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.btnAction}
            onPress={() => handleShare(item)}
            activeOpacity={0.7}
          >
            <Share2 size={13} color="#D1D1D6" />
            <Text style={styles.btnActionText}>EXPORT</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.btnAction, styles.btnDelete]}
            onPress={() => handleDelete(item)}
            activeOpacity={0.7}
          >
            <Trash2 size={13} color="#8E8E93" />
            <Text style={styles.deleteText}>DELETE</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  const cardContent = (
    <View style={[styles.dialogCard, isTablet && styles.dialogCardTablet]}>
      <View style={styles.topBar}>
        <View>
          <Text style={styles.heading}>Library</Text>
          <Text style={styles.subheading}>{recordings.length} Recorded Takes</Text>
        </View>
        <TouchableOpacity style={styles.closeBtn} onPress={handleClose} activeOpacity={0.7}>
          <X size={16} color="#FFFFFF" />
        </TouchableOpacity>
      </View>

      {recordings.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Music size={40} color="#3A3A3C" style={{ marginBottom: 12 }} />
          <Text style={styles.emptyTitle}>No Recorded Takes</Text>
          <Text style={styles.emptyText}>
            Audio sessions captured on the console will automatically appear here.
          </Text>
        </View>
      ) : (
        <FlatList
          data={recordings}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
        />
      )}
    </View>
  );

  return (
    <Modal
      visible={visible}
      animationType={isTablet ? 'fade' : 'slide'}
      presentationStyle={isTablet ? 'overFullScreen' : 'pageSheet'}
      transparent={isTablet}
      onRequestClose={handleClose}
    >
      {isTablet ? (
        <View style={styles.backdrop}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={handleClose} />
          {cardContent}
        </View>
      ) : (
        <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
          {cardContent}
        </SafeAreaView>
      )}
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.82)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  dialogCard: {
    flex: 1,
    width: '100%',
    backgroundColor: '#0F0F0F',
  },
  dialogCardTablet: {
    flex: 0,
    maxWidth: 680,
    maxHeight: '86%',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: '#242424',
    overflow: 'hidden',
  },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#1E1E1E',
  },
  heading: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '700',
  },
  subheading: {
    color: '#8E8E93',
    fontSize: 12,
    marginTop: 2,
  },
  closeBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#1C1C1E',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#2C2C2E',
  },
  listContent: {
    padding: 16,
    gap: 12,
  },
  card: {
    backgroundColor: '#141414',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#242424',
    padding: 16,
  },
  cardActive: {
    borderColor: '#FFFFFF',
    backgroundColor: '#181818',
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 6,
  },
  cardTitle: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
    flex: 1,
    marginRight: 8,
  },
  cardTimestamp: {
    color: '#8E8E93',
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 14,
  },
  metaBadge: {
    backgroundColor: '#242424',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  metaBadgeText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  metaText: {
    color: '#8E8E93',
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
  metaDivider: {
    color: '#3A3A3C',
    fontSize: 10,
  },
  progressSection: {
    marginBottom: 14,
  },
  scrubTouchArea: {
    height: 30,
    justifyContent: 'center',
    position: 'relative',
  },
  progressTrack: {
    height: 4,
    backgroundColor: '#2C2C2E',
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#FFFFFF',
  },
  scrubThumb: {
    position: 'absolute',
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#FFFFFF',
    marginLeft: -7,
  },
  timeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 2,
  },
  timeText: {
    color: '#8E8E93',
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },
  actionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  playCircleBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  playCircleBtnActive: {
    backgroundColor: '#FFFFFF',
  },
  btnAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#1F1F1F',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#2A2A2A',
  },
  btnActionText: {
    color: '#D1D1D6',
    fontWeight: '600',
    fontSize: 11,
    letterSpacing: 0.5,
  },
  btnDelete: {
    marginLeft: 'auto',
    backgroundColor: '#181818',
    borderColor: '#262626',
  },
  deleteText: {
    color: '#8E8E93',
    fontWeight: '600',
    fontSize: 11,
    letterSpacing: 0.5,
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    minHeight: 220,
  },
  emptyTitle: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '600',
    marginBottom: 6,
  },
  emptyText: {
    color: '#8E8E93',
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 18,
  },
});