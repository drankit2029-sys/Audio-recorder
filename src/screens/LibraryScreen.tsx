// src/screens/LibraryScreen.tsx
import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  TextInput,
  Modal,
  Platform,
} from 'react-native';
import Animated, {
  FadeInDown,
  FadeOutUp,
  Easing,
} from 'react-native-reanimated';
import { useAudioPlayer } from 'expo-audio';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system/legacy';
import {
  Search,
  MoreVertical,
  Edit3,
  ArrowUpDown,
  X,
  Check,
  Trash2,
  AlertCircle,
  HardDrive,
  Share2,
  ChevronRight,
} from 'lucide-react-native';

import { RecordingLibrary, SavedRecording } from '../services/storage/recordingLibrary';
import { useResponsive } from '../hooks/useResponsive';
import { DeleteConfirmationModal } from '../components/audio/DeleteConfirmationModal';
import { RenameRecordingModal } from '../components/library/RenameRecordingModal';
import { LibrarySortModal, SortOption } from '../components/library/LibrarySortModal';
import { LibraryBatchBar } from '../components/library/LibraryBatchBar';
import { RecordingCard } from '../components/library/RecordingCard';

interface LibraryScreenProps {
  recordings: SavedRecording[];
  onLibraryUpdate: (updated: SavedRecording[]) => void;
  onEditModeChange: (isEdit: boolean) => void;
}

interface ToastData {
  title: string;
  subtitle: string;
  isDelete?: boolean;
  isError?: boolean;
}

type ExportTarget =
  | { type: 'single'; item: SavedRecording }
  | { type: 'batch'; items: SavedRecording[] };

const getMimeType = (uri: string): string => {
  const clean = uri.toLowerCase();
  if (clean.endsWith('.wav')) return 'audio/wav';
  if (clean.endsWith('.m4a')) return 'audio/mp4';
  if (clean.endsWith('.ogg')) return 'audio/ogg';
  if (clean.endsWith('.flac')) return 'audio/flac';
  if (clean.endsWith('.3gp')) return 'audio/3gpp';
  return 'audio/*';
};

const checkFileValid = async (uri: string): Promise<boolean> => {
  try {
    const info = await FileSystem.getInfoAsync(uri);
    return Boolean(info.exists && !info.isDirectory && (info.size ?? 0) > 0);
  } catch {
    return false;
  }
};

export const LibraryScreen: React.FC<LibraryScreenProps> = ({
  recordings,
  onLibraryUpdate,
  onEditModeChange,
}) => {
  const { isTablet, maxContentWidth, insets } = useResponsive();

  const deckBottom = Math.max(insets.bottom + 20, 54);
  const toastTop = Math.max(insets.top + 10, 26);

  const [isSearching, setIsSearching] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [menuVisible, setMenuVisible] = useState(false);
  const [sortModalVisible, setSortModalVisible] = useState(false);
  const [sortOption, setSortOption] = useState<SortOption>('date_desc');

  const [isEditMode, setIsEditMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const expandedIdRef = useRef(expandedId);
  expandedIdRef.current = expandedId;

  const [activeId, setActiveId] = useState<string | null>(null);
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  const [isPlaying, setIsPlaying] = useState(false);
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;

  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const currentTimeRef = useRef(0);
  const durationRef = useRef(0);

  const seekLockRef = useRef<{
    targetSec: number;
    timestamp: number;
  } | null>(null);

  const [renameModalVisible, setRenameModalVisible] = useState(false);
  const [recordingToRename, setRecordingToRename] = useState<SavedRecording | null>(null);

  const [deleteModalVisible, setDeleteModalVisible] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{
    type: 'single' | 'batch';
    item?: SavedRecording;
    count?: number;
  } | null>(null);

  // Unified Export State
  const [exportModalVisible, setExportModalVisible] = useState(false);
  const [exportTarget, setExportTarget] = useState<ExportTarget | null>(null);

  const [toastData, setToastData] = useState<ToastData | null>(null);
  const toastTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const showToast = useCallback(
    (title: string, subtitle: string, isDelete = false, isError = false) => {
      if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
      setToastData({ title, subtitle, isDelete, isError });
      toastTimeoutRef.current = setTimeout(() => setToastData(null), 3500);
    },
    []
  );

  useEffect(() => {
    return () => {
      if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    };
  }, []);

  const activeRecording = recordings.find((r) => r.id === activeId) ?? null;
  const player = useAudioPlayer(activeRecording?.uri ?? null);

  const playerRef = useRef(player);
  playerRef.current = player;

  const progressPollRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (!player || !activeRecording) return;
    if (isPlaying) {
      try {
        player.play();
      } catch {}
    } else {
      try {
        player.pause();
      } catch {}
    }
  }, [isPlaying, player, activeId, activeRecording]);

  useEffect(() => {
    if (!isPlaying || !player || !activeRecording) {
      if (progressPollRef.current) {
        clearInterval(progressPollRef.current);
        progressPollRef.current = null;
      }
      return;
    }

    progressPollRef.current = setInterval(() => {
      try {
        const rawCur = player.currentTime;
        const dur =
          activeRecording?.durationMs && activeRecording.durationMs > 0
            ? activeRecording.durationMs / 1000
            : player.duration > 0
            ? player.duration
            : 0;

        if (typeof rawCur === 'number' && !isNaN(rawCur)) {
          let effectiveCur = rawCur;

          if (seekLockRef.current !== null) {
            const { targetSec, timestamp } = seekLockRef.current;
            const elapsedMs = Date.now() - timestamp;
            const diffFromTarget = Math.abs(rawCur - targetSec);

            if (diffFromTarget <= 0.35) {
              seekLockRef.current = null;
              effectiveCur = rawCur;
            } else if (elapsedMs > 1200) {
              seekLockRef.current = null;
              effectiveCur = rawCur;
            } else {
              effectiveCur = isPlayingRef.current ? targetSec + elapsedMs / 1000 : targetSec;
            }
          }

          if (dur > 0.5 && effectiveCur >= dur - 0.08) {
            setIsPlaying(false);
            currentTimeRef.current = 0;
            setCurrentTime(0);
            seekLockRef.current = null;
            try {
              player.pause();
              player.seekTo(0);
            } catch {}
            return;
          }

          if (Math.abs(effectiveCur - currentTimeRef.current) >= 0.03) {
            currentTimeRef.current = effectiveCur;
            setCurrentTime(effectiveCur);
          }
        }

        if (dur > 0 && Math.abs(dur - durationRef.current) > 0.1) {
          durationRef.current = dur;
          setDuration(dur);
        }
      } catch {}
    }, 40);

    return () => {
      if (progressPollRef.current) {
        clearInterval(progressPollRef.current);
        progressPollRef.current = null;
      }
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

  const handlePlayToggle = useCallback((item: SavedRecording) => {
    if (expandedIdRef.current !== item.id) {
      setExpandedId(item.id);
    }

    if (activeIdRef.current === item.id) {
      if (isPlayingRef.current) {
        try {
          playerRef.current?.pause();
        } catch {}
        setIsPlaying(false);
      } else {
        const dur = durationRef.current > 0 ? durationRef.current : (item.durationMs || 0) / 1000;
        if (dur > 0 && currentTimeRef.current >= dur - 0.12) {
          currentTimeRef.current = 0;
          setCurrentTime(0);
          try {
            playerRef.current?.seekTo(0);
          } catch {}
        }
        setIsPlaying(true);
      }
    } else {
      try {
        playerRef.current?.pause();
      } catch {}
      activeIdRef.current = item.id;
      setActiveId(item.id);
      currentTimeRef.current = 0;
      setCurrentTime(0);
      seekLockRef.current = null;
      const initialDur = item.durationMs ? item.durationMs / 1000 : 0;
      durationRef.current = initialDur;
      setDuration(initialDur);
      setIsPlaying(true);
    }
  }, []);

  const handleSeek = useCallback((item: SavedRecording, seconds: number) => {
    seekLockRef.current = {
      targetSec: seconds,
      timestamp: Date.now(),
    };
    currentTimeRef.current = seconds;
    setCurrentTime(seconds);

    if (activeIdRef.current !== item.id) {
      activeIdRef.current = item.id;
      setActiveId(item.id);
      const initialDur = item.durationMs ? item.durationMs / 1000 : 0;
      durationRef.current = initialDur;
      setDuration(initialDur);
    }

    const activeNativePlayer = playerRef.current;
    if (activeNativePlayer && typeof activeNativePlayer.seekTo === 'function') {
      try {
        activeNativePlayer.seekTo(seconds);
      } catch {}
    }
  }, []);

  const handleToggleExpand = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  const handleToggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  // Long press handler: activates edit mode and selects the pressed card
  const handleCardLongPress = useCallback(
    (id: string) => {
      if (!isEditMode) {
        setIsEditMode(true);
        onEditModeChange(true);
        setSelectedIds(new Set([id]));
      } else {
        handleToggleSelect(id);
      }
    },
    [isEditMode, onEditModeChange, handleToggleSelect]
  );

  const handleSelectAll = useCallback(() => {
    if (selectedIds.size === processedRecordings.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(processedRecordings.map((r) => r.id)));
    }
  }, [processedRecordings, selectedIds.size]);

  const handleOpenRename = useCallback((item: SavedRecording) => {
    setRecordingToRename(item);
    setRenameModalVisible(true);
  }, []);

  const handleSaveRename = useCallback((newName: string) => {
    if (!recordingToRename) return;
    const trimmed = newName.trim();
    if (trimmed.length > 0 && trimmed !== recordingToRename.name) {
      const updated = RecordingLibrary.rename(recordingToRename.id, trimmed);
      onLibraryUpdate(updated);
      showToast('Take Renamed', trimmed);
    }
    setRenameModalVisible(false);
    setRecordingToRename(null);
  }, [recordingToRename, onLibraryUpdate, showToast]);

  const handleDeleteSingle = useCallback((item: SavedRecording) => {
    setDeleteTarget({ type: 'single', item });
    setDeleteModalVisible(true);
  }, []);

  const handleBatchDelete = useCallback(() => {
    if (selectedIds.size === 0) return;
    setDeleteTarget({ type: 'batch', count: selectedIds.size });
    setDeleteModalVisible(true);
  }, [selectedIds.size]);

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget) return;

    if (deleteTarget.type === 'single' && deleteTarget.item) {
      const item = deleteTarget.item;
      if (activeIdRef.current === item.id) {
        try {
          playerRef.current?.pause();
        } catch {}
        setIsPlaying(false);
        setActiveId(null);
      }
      if (expandedIdRef.current === item.id) {
        setExpandedId(null);
      }
      const updated = await RecordingLibrary.delete(item.id);
      onLibraryUpdate(updated);
      showToast('Take Deleted', `"${item.name}" removed`, true);
    } else if (deleteTarget.type === 'batch') {
      if (selectedIds.size === 0) return;

      if (activeIdRef.current && selectedIds.has(activeIdRef.current)) {
        try {
          playerRef.current?.pause();
        } catch {}
        setIsPlaying(false);
        setActiveId(null);
      }
      if (expandedIdRef.current && selectedIds.has(expandedIdRef.current)) {
        setExpandedId(null);
      }

      const deletedCount = selectedIds.size;
      let updated = recordings;
      for (const id of selectedIds) {
        updated = await RecordingLibrary.delete(id);
      }
      onLibraryUpdate(updated);
      setSelectedIds(new Set());
      setIsEditMode(false);
      onEditModeChange(false);
      showToast('Takes Deleted', `${deletedCount} recordings removed`, true);
    }

    setDeleteModalVisible(false);
    setDeleteTarget(null);
  }, [deleteTarget, onEditModeChange, onLibraryUpdate, recordings, selectedIds, showToast]);

  // Unified Export Triggers
  const handleOpenExportSingle = useCallback((item: SavedRecording) => {
    setExportTarget({ type: 'single', item });
    setExportModalVisible(true);
  }, []);

  const handleOpenExportBatch = useCallback(() => {
    if (selectedIds.size === 0) return;
    const targets = recordings.filter((r) => selectedIds.has(r.id));
    if (targets.length === 0) return;
    setExportTarget({ type: 'batch', items: targets });
    setExportModalVisible(true);
  }, [recordings, selectedIds]);

  // Action 1: Save to Device Storage
  const handleExportToStorage = useCallback(async () => {
    if (!exportTarget) return;
    const targets = exportTarget.type === 'single' ? [exportTarget.item] : exportTarget.items;
    setExportModalVisible(false);

    if (targets.length === 0) return;

    // Validate files on disk first
    const validTargets: SavedRecording[] = [];
    for (const item of targets) {
      if (await checkFileValid(item.uri)) {
        validTargets.push(item);
      }
    }

    if (validTargets.length === 0) {
      showToast('Export Failed', 'Selected audio file(s) not found on disk', false, true);
      return;
    }

    if (Platform.OS === 'android') {
      try {
        const permissions = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
        if (!permissions.granted) {
          // User backed out of directory selection without picking a folder
          return;
        }

        let savedCount = 0;
        for (const item of validTargets) {
          try {
            const fileData = await FileSystem.readAsStringAsync(item.uri, {
              encoding: FileSystem.EncodingType.Base64,
            });
            const mimeType = getMimeType(item.uri);
            const ext = item.uri.includes('.') ? item.uri.substring(item.uri.lastIndexOf('.')) : '.wav';
            const safeName = item.name.replace(/[/\\?%*:|"<>]/g, '_') + ext;

            const createdUri = await FileSystem.StorageAccessFramework.createFileAsync(
              permissions.directoryUri,
              safeName,
              mimeType
            );
            await FileSystem.writeAsStringAsync(createdUri, fileData, {
              encoding: FileSystem.EncodingType.Base64,
            });
            savedCount++;
          } catch (writeErr) {
            console.warn('[LibraryScreen] Failed to save take to folder:', item.name, writeErr);
          }
        }

        if (savedCount === 0) {
          showToast('Export Failed', 'Could not save take(s) to selected folder', false, true);
        } else if (savedCount === 1) {
          showToast('Saved to Storage', validTargets[0].name);
        } else {
          showToast('Takes Saved', `${savedCount} recordings saved to folder`);
        }
      } catch (err: any) {
        showToast('Export Failed', err?.message || 'Storage Access export failed', false, true);
      }
    } else {
      // iOS: Save to Files via share sheet
      try {
        for (const item of validTargets) {
          await Sharing.shareAsync(item.uri, {
            dialogTitle: `Save ${item.name}`,
            UTI: item.uri.endsWith('.wav') ? 'com.microsoft.waveform-audio' : 'public.audio',
          });
        }
        showToast('Saved to Storage', validTargets.length === 1 ? validTargets[0].name : `${validTargets.length} takes`);
      } catch (err: any) {
        showToast('Export Failed', err?.message || 'Failed to save take', false, true);
      }
    }
  }, [exportTarget, showToast]);

  // Action 2: Send to an App (Share Sheet)
  const handleExportToApp = useCallback(async () => {
    if (!exportTarget) return;
    const targets = exportTarget.type === 'single' ? [exportTarget.item] : exportTarget.items;
    setExportModalVisible(false);

    if (targets.length === 0) return;

    try {
      const isAvailable = await Sharing.isAvailableAsync();
      if (!isAvailable) {
        showToast('Export Failed', 'Sharing is unavailable on this device', false, true);
        return;
      }

      const validTargets: SavedRecording[] = [];
      for (const item of targets) {
        if (await checkFileValid(item.uri)) {
          validTargets.push(item);
        }
      }

      if (validTargets.length === 0) {
        showToast('Export Failed', 'Selected audio file(s) not found on disk', false, true);
        return;
      }

      for (const item of validTargets) {
        await Sharing.shareAsync(item.uri, {
          dialogTitle: `Share ${item.name}`,
          mimeType: getMimeType(item.uri),
        });
      }

      showToast(
        validTargets.length === 1 ? 'Share Dialog Opened' : 'Share Completed',
        validTargets.length === 1 ? validTargets[0].name : `${validTargets.length} recordings processed`
      );
    } catch (err: any) {
      showToast('Export Failed', err?.message || 'Failed to send to app', false, true);
    }
  }, [exportTarget, showToast]);

  const renderItem = useCallback(
    ({ item }: { item: SavedRecording }) => {
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
          currentTime={isThisActive ? currentTime : 0}
          duration={isThisActive ? duration : 0}
          onToggleExpand={handleToggleExpand}
          onToggleSelect={handleToggleSelect}
          onPlayToggle={handlePlayToggle}
          onSeek={handleSeek}
          onOpenRename={handleOpenRename}
          onExport={handleOpenExportSingle}
          onDelete={handleDeleteSingle}
          onLongPress={handleCardLongPress}
        />
      );
    },
    [
      activeId,
      currentTime,
      duration,
      expandedId,
      handleDeleteSingle,
      handleOpenExportSingle,
      handleOpenRename,
      handlePlayToggle,
      handleSeek,
      handleToggleExpand,
      handleToggleSelect,
      handleCardLongPress,
      isEditMode,
      isPlaying,
      selectedIds,
    ]
  );

  const exportCount =
    exportTarget?.type === 'single'
      ? 1
      : exportTarget?.type === 'batch'
      ? exportTarget.items.length
      : 0;

  const exportLabel =
    exportTarget?.type === 'single'
      ? `"${exportTarget.item.name}"`
      : `${exportCount} Recording${exportCount > 1 ? 's' : ''}`;

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
          <LibraryBatchBar
            selectedCount={selectedIds.size}
            totalCount={processedRecordings.length}
            bottomOffset={deckBottom}
            onDelete={handleBatchDelete}
            onExport={handleOpenExportBatch}
          />
        )}
      </View>

      {/* Status-Bar Safe Toast */}
      {toastData ? (
        <View style={[styles.toastOverlay, { top: toastTop }]} pointerEvents="box-none">
          <Animated.View
            entering={FadeInDown.duration(240).easing(Easing.out(Easing.cubic))}
            exiting={FadeOutUp.duration(180).easing(Easing.in(Easing.cubic))}
            style={styles.toastCard}
          >
            <View
              style={[
                styles.toastIconCircle,
                toastData.isDelete && styles.toastIconCircleDelete,
                toastData.isError && styles.toastIconCircleError,
              ]}
            >
              {toastData.isDelete ? (
                <Trash2 size={13} color="#FFFFFF" strokeWidth={2.5} />
              ) : toastData.isError ? (
                <AlertCircle size={14} color="#FFFFFF" strokeWidth={2.5} />
              ) : (
                <Check size={14} color="#000000" strokeWidth={3} />
              )}
            </View>
            <View style={styles.toastTextCol}>
              <Text style={styles.toastTitle}>{toastData.title}</Text>
              <Text style={styles.toastSubtitle} numberOfLines={1}>{toastData.subtitle}</Text>
            </View>
          </Animated.View>
        </View>
      ) : null}

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

      <LibrarySortModal
        visible={sortModalVisible}
        activeSort={sortOption}
        onSelectSort={(opt) => {
          setSortOption(opt);
          setSortModalVisible(false);
        }}
        onClose={() => setSortModalVisible(false)}
      />

      <RenameRecordingModal
        visible={renameModalVisible}
        initialName={recordingToRename?.name ?? ''}
        onSave={handleSaveRename}
        onClose={() => {
          setRenameModalVisible(false);
          setRecordingToRename(null);
        }}
      />

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

      {/* Unified Export Destination Modal */}
      <Modal
        visible={exportModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setExportModalVisible(false)}
      >
        <View style={styles.exportBackdrop}>
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={() => setExportModalVisible(false)}
          />

          <View style={[styles.exportCard, isTablet && styles.exportCardTablet]}>
            <View style={styles.exportHeader}>
              <View style={styles.exportHeaderCol}>
                <Text style={styles.exportHeading}>Export Audio</Text>
                <Text style={styles.exportSubheading} numberOfLines={1}>
                  {exportLabel}
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => setExportModalVisible(false)}
                style={styles.exportCloseBtn}
                activeOpacity={0.7}
              >
                <X size={15} color="#FFFFFF" />
              </TouchableOpacity>
            </View>

            <View style={styles.exportOptionsList}>
              {/* Option A: Save to Device Storage */}
              <TouchableOpacity
                style={styles.exportOptionRow}
                onPress={handleExportToStorage}
                activeOpacity={0.7}
              >
                <View style={styles.exportIconBoxStorage}>
                  <HardDrive size={18} color="#38BDF8" strokeWidth={2.2} />
                </View>
                <View style={styles.exportOptionTextCol}>
                  <Text style={styles.exportOptionTitle}>Save to device storage</Text>
                  <Text style={styles.exportOptionDesc}>
                    Choose a folder on your phone to store the audio files
                  </Text>
                </View>
                <ChevronRight size={16} color="#71717A" />
              </TouchableOpacity>

              <View style={styles.exportDivider} />

              {/* Option B: Send to an App */}
              <TouchableOpacity
                style={styles.exportOptionRow}
                onPress={handleExportToApp}
                activeOpacity={0.7}
              >
                <View style={styles.exportIconBoxApp}>
                  <Share2 size={18} color="#10B981" strokeWidth={2.2} />
                </View>
                <View style={styles.exportOptionTextCol}>
                  <Text style={styles.exportOptionTitle}>Send to an app</Text>
                  <Text style={styles.exportOptionDesc}>
                    Share via WhatsApp, Drive, Gmail, or other installed apps
                  </Text>
                </View>
                <ChevronRight size={16} color="#71717A" />
              </TouchableOpacity>
            </View>

            <TouchableOpacity
              style={styles.exportCancelBtn}
              onPress={() => setExportModalVisible(false)}
              activeOpacity={0.7}
            >
              <Text style={styles.exportCancelBtnText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
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
    paddingBottom: 200,
    gap: 10,
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

  toastOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 10000,
    elevation: 100,
  },
  toastCard: {
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
  toastIconCircle: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#10B981',
    alignItems: 'center',
    justifyContent: 'center',
  },
  toastIconCircleDelete: {
    backgroundColor: '#EF4444',
  },
  toastIconCircleError: {
    backgroundColor: '#EF4444',
  },
  toastTextCol: {
    flexShrink: 1,
  },
  toastTitle: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  toastSubtitle: {
    color: '#8E8E93',
    fontSize: 11,
    fontWeight: '500',
    marginTop: 1,
  },

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

  /* Export Destination Modal Styles */
  exportBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.82)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 22,
  },
  exportCard: {
    width: '100%',
    maxWidth: 400,
    backgroundColor: '#141417',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: '#26262D',
    paddingHorizontal: 20,
    paddingTop: 22,
    paddingBottom: 18,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.65,
    shadowRadius: 20,
    elevation: 18,
  },
  exportCardTablet: {
    maxWidth: 460,
    paddingHorizontal: 26,
    paddingTop: 24,
    paddingBottom: 20,
  },
  exportHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#202026',
    marginBottom: 8,
  },
  exportHeaderCol: {
    flex: 1,
    marginRight: 10,
  },
  exportHeading: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  exportSubheading: {
    color: '#8E8E93',
    fontSize: 12,
    fontWeight: '500',
    marginTop: 2,
  },
  exportCloseBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: '#1C1C22',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#2A2A32',
  },
  exportOptionsList: {
    paddingVertical: 6,
  },
  exportOptionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 6,
    gap: 12,
  },
  exportIconBoxStorage: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(56, 189, 248, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.28)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  exportIconBoxApp: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(16, 185, 129, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.28)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  exportOptionTextCol: {
    flex: 1,
  },
  exportOptionTitle: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
    letterSpacing: -0.2,
  },
  exportOptionDesc: {
    color: '#71717A',
    fontSize: 11,
    lineHeight: 15,
    marginTop: 2,
  },
  exportDivider: {
    height: 1,
    backgroundColor: '#1E1E26',
    marginHorizontal: 4,
  },
  exportCancelBtn: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: 14,
    backgroundColor: '#1C1C20',
    borderWidth: 1,
    borderColor: '#2A2A30',
    marginTop: 10,
  },
  exportCancelBtnText: {
    color: '#8E8E93',
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
});