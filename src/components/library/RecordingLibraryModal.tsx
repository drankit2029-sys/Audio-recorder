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
import { useAudioPlayer } from 'expo-audio';
import * as Sharing from 'expo-sharing';
import { RecordingLibrary, SavedRecording } from '../../services/storage/recordingLibrary';

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
  const [activeId, setActiveId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  // Scrubber state
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [scrubTime, setScrubTime] = useState(0);

  const activeRecording = recordings.find((r) => r.id === activeId) ?? null;
  const player = useAudioPlayer(activeRecording?.uri ?? null);

  // Mutable refs to prevent stale closures inside PanResponder
  const playerRef = useRef(player);
  playerRef.current = player;

  const totalSecs = duration > 0 ? duration : (activeRecording?.durationMs ?? 0) / 1000;
  const totalSecsRef = useRef(totalSecs);
  totalSecsRef.current = totalSecs;

  const progressPollRef = useRef<NodeJS.Timeout | null>(null);
  const trackWidthRef = useRef<number>(260);
  const startXRef = useRef<number>(0);

  // 1. Guaranteed first-tap playback synchronizer
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

  // 2. High-frequency progress poller (20 Hz)
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

          // End of take reached
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

  // 3. PanResponder with active refs and safe promise handling
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
          <Text style={styles.metaBadge}>
            {item.uri.endsWith('.wav') ? 'WAV 48k' : 'AAC 256k'}
          </Text>
          <Text style={styles.metaText}>{formatSecs(item.durationMs / 1000)}</Text>
          <Text style={styles.metaText}>•</Text>
          <Text style={styles.metaText}>{formatFileSize(item.sizeBytes)}</Text>
        </View>

        {/* Dynamic Interactive Timeline with Scrubbing */}
        {isThisActive && (
          <View style={styles.progressSection}>
            <View
              style={styles.scrubTouchArea}
              {...panResponder.panHandlers}
              onLayout={(e) => {
                trackWidthRef.current = e.nativeEvent.layout.width;
              }}
            >
              {/* Background Track */}
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: `${progressPct}%` }]} />
              </View>

              {/* Scrub Thumb Knob */}
              <View
                style={[
                  styles.scrubThumb,
                  {
                    left: `${progressPct}%`,
                    transform: [{ scale: isScrubbing ? 1.3 : 1.0 }],
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
              <View style={styles.pauseBarsContainer}>
                <View style={styles.pauseBar} />
                <View style={styles.pauseBar} />
              </View>
            ) : (
              <View style={styles.playTriangle} />
            )}
          </TouchableOpacity>

          <TouchableOpacity style={styles.btnAction} onPress={() => handleShare(item)}>
            <Text style={styles.btnActionText}>EXPORT</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.btnAction, styles.btnDelete]}
            onPress={() => handleDelete(item)}
          >
            <Text style={[styles.btnActionText, styles.deleteText]}>DELETE</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={handleClose}
    >
      <View style={styles.container}>
        <View style={styles.topBar}>
          <View>
            <Text style={styles.heading}>Session Library</Text>
            <Text style={styles.subheading}>{recordings.length} Saved Takes</Text>
          </View>
          <TouchableOpacity style={styles.closeBtn} onPress={handleClose}>
            <Text style={styles.closeText}>DONE</Text>
          </TouchableOpacity>
        </View>

        {recordings.length === 0 ? (
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyTitle}>No Recorded Takes</Text>
            <Text style={styles.emptyText}>
              Recordings saved from the main console will automatically appear here.
            </Text>
          </View>
        ) : (
          <FlatList
            data={recordings}
            keyExtractor={(item) => item.id}
            renderItem={renderItem}
            contentContainerStyle={styles.listContent}
          />
        )}
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#121212',
  },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#262626',
  },
  heading: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '700',
  },
  subheading: {
    color: '#757575',
    fontSize: 12,
    marginTop: 2,
  },
  closeBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: '#262626',
    borderRadius: 16,
  },
  closeText: {
    color: '#00E676',
    fontWeight: '700',
    fontSize: 12,
  },
  listContent: {
    padding: 16,
    gap: 12,
  },
  card: {
    backgroundColor: '#1E1E1E',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    padding: 16,
  },
  cardActive: {
    borderColor: '#00E676',
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
    color: '#757575',
    fontSize: 11,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 14,
  },
  metaBadge: {
    backgroundColor: '#2C3440',
    color: '#64B5F6',
    fontSize: 10,
    fontWeight: '700',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  metaText: {
    color: '#9E9E9E',
    fontSize: 12,
  },
  progressSection: {
    marginBottom: 14,
  },
  scrubTouchArea: {
    height: 32,
    justifyContent: 'center',
    position: 'relative',
  },
  progressTrack: {
    height: 5,
    backgroundColor: '#333333',
    borderRadius: 2.5,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#00E676',
  },
  scrubThumb: {
    position: 'absolute',
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#FFFFFF',
    marginLeft: -7,
    elevation: 4,
  },
  timeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 2,
  },
  timeText: {
    color: '#9E9E9E',
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },
  actionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  playCircleBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#00E676',
    alignItems: 'center',
    justifyContent: 'center',
  },
  playCircleBtnActive: {
    backgroundColor: '#00E676',
  },
  playTriangle: {
    width: 0,
    height: 0,
    backgroundColor: 'transparent',
    borderStyle: 'solid',
    borderLeftWidth: 14,
    borderRightWidth: 0,
    borderBottomWidth: 8,
    borderTopWidth: 8,
    borderLeftColor: '#121212',
    borderRightColor: 'transparent',
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
    marginLeft: 3,
  },
  pauseBarsContainer: {
    flexDirection: 'row',
    gap: 4.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pauseBar: {
    width: 3.5,
    height: 15,
    backgroundColor: '#121212',
    borderRadius: 1.5,
  },
  btnAction: {
    backgroundColor: '#2A2A2A',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
  },
  btnActionText: {
    color: '#B0BEC5',
    fontWeight: '600',
    fontSize: 12,
  },
  btnDelete: {
    marginLeft: 'auto',
    backgroundColor: '#2A1818',
  },
  deleteText: {
    color: '#FF5252',
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  emptyTitle: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 8,
  },
  emptyText: {
    color: '#757575',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
});