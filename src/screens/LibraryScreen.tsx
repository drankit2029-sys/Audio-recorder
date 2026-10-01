// src/screens/LibraryScreen.tsx
import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Modal,
  Keyboard,
  Platform,
  BackHandler,
} from 'react-native';
import Animated, { FadeIn, FadeOut, Easing } from 'react-native-reanimated';
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
  Mic,
} from 'lucide-react-native';

import { RecordingLibrary, SavedRecording } from '../services/storage/recordingLibrary';
import {
  renameTakeFile,
  sanitizeFileName,
  extractExtension,
} from '../services/storage/recordingPaths';
import { useResponsive } from '../hooks/useResponsive';
import { useKeyboardViewport } from '../hooks/useKeyboardViewport';
import { KeyboardHelper } from '../../modules/audio-hardware-router/src';
import {
  AppToast,
  AppToastData,
  ToastVariant,
  getToastTop,
} from '../components/common/AppToast';
import { DeleteConfirmationModal } from '../components/audio/DeleteConfirmationModal';
import { RenameRecordingModal } from '../components/library/RenameRecordingModal';
import { LibrarySortModal, SortOption } from '../components/library/LibrarySortModal';
import { LibrarySearchBar } from '../components/library/LibrarySearchBar';
import { useLibrarySearch } from '../services/search/useLibrarySearch';
import { LibraryBatchBar } from '../components/library/LibraryBatchBar';
import { RecordingCard } from '../components/library/RecordingCard';

interface LibraryScreenProps {
  recordings: SavedRecording[];
  onLibraryUpdate: (updated: SavedRecording[]) => void;
  onEditModeChange: (isEdit: boolean) => void;
  /** Opens a take in the studio for scrubbing / replacing / re-recording. */
  onEditRecording: (item: SavedRecording) => void;
  /** An in-window dialog (rename) covers the screen: hide the floating transport. */
  onOverlayChange?: (visible: boolean) => void;
}

type ExportTarget =
  | { type: 'single'; item: SavedRecording }
  | { type: 'batch'; items: SavedRecording[] };

const getMimeType = (uri: string): string => {
  const clean = uri.toLowerCase();
  const ext = extractExtension(clean);
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.m4a') return 'audio/mp4';
  if (ext === '.aac') return 'audio/aac';
  if (ext === '.ogg') return 'audio/ogg';
  if (ext === '.flac') return 'audio/flac';
  if (ext === '.3gp') return 'audio/3gpp';
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
  onEditRecording,
  onOverlayChange,
}) => {
  const { isTablet, maxContentWidth, insets } = useResponsive();
  const { offset: keyboardOffset, isVisible: keyboardVisible } = useKeyboardViewport();

  const deckBottom = Math.max(insets.bottom + 20, 54);
  const toastTop = getToastTop(insets.top);

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

  const [exportModalVisible, setExportModalVisible] = useState(false);
  const [exportTarget, setExportTarget] = useState<ExportTarget | null>(null);

  const searchInputRef = useRef<TextInput | null>(null);
  /** Only used to let the hardware back button step out of search first. */
  const searchInputFocusedRef = useRef(false);
  /**
   * When the last back press consumed a search step (keyboard -> text ->
   * filter). The strip is dismissed only as the step right after those, so a
   * back press on an untouched list still leaves the screen instead of eating a
   * press to hide a bar the user was not in.
   */
  const searchStepAtRef = useRef(0);

  const [toastData, setToastData] = useState<AppToastData | null>(null);
  const toastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);


  const showToast = useCallback(
    (
      title: string,
      subtitle?: string,
      opts: { variant?: ToastVariant; isDelete?: boolean } = {}
    ) => {
      if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
      setToastData({
        title,
        subtitle,
        variant: opts.variant ?? (opts.isDelete ? 'delete' : 'success'),
      });
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

  const progressPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Set once the current player has shown any sign of life (position or duration). */
  const playbackLivedRef = useRef(false);
  const playbackProbeRef = useRef(0);

  useEffect(() => {
    playbackLivedRef.current = false;
    playbackProbeRef.current = 0;
  }, [player, activeId]);

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

        // A decode that never delivers a single frame (deleted or truncated
        // file) used to leave the row showing a spinner forever: play() is
        // fire-and-forget in expo-audio. If the position has not moved after
        // 2.5 s, drop out of the playing state and say why.
        const moved = player.currentTime > 0.05 || dur > 0;
        if (moved) {
          playbackLivedRef.current = true;
        } else if (!playbackLivedRef.current) {
          if (playbackProbeRef.current === 0) playbackProbeRef.current = Date.now();
          else if (Date.now() - playbackProbeRef.current > 2500) {
            playbackProbeRef.current = 0;
            setIsPlaying(false);
            setActiveId(null);
            showToast('Cannot Play', 'This file could not be opened. It may have been moved or deleted.', {
              variant: 'warning',
            });
            return;
          }
        }
      } catch {
        if (!playbackLivedRef.current) {
          setIsPlaying(false);
          setActiveId(null);
          showToast('Cannot Play', 'Playback failed on this file.', { variant: 'warning' });
        }
      }
    }, 40);

    return () => {
      if (progressPollRef.current) {
        clearInterval(progressPollRef.current);
        progressPollRef.current = null;
      }
    };
  }, [isPlaying, player, activeRecording]);

  // ---- search ------------------------------------------------------------------
  // The whole search surface (query, tokens, time/length filter, recents) lives
  // in one hook so the field, the list and the empty state cannot disagree.
  const search = useLibrarySearch(recordings);
  const {
    text: searchText,
    setText: setSearchText,
    query: searchQuery,
    filter: searchFilter,
    setFilter: setSearchFilter,
    recents,
    visible: searchVisible,
    setVisible: setSearchVisible,
    commit: commitSearch,
    clear: clearSearch,
    removeRecent,
    pending: searchPending,
    results: searchResults,
    highlights,
    tokens: searchTokens,
  } = search;

  const searchActive = searchQuery.trim().length > 0 || searchFilter !== 'all';

  /**
   * Order: with no explicit sort chosen, the *search* ranks the list (best
   * match first). Pick any sort and the matched set is kept but re-ordered,
   * so "search then sort by length" behaves the way people expect.
   */
  const processedRecordings = useMemo(() => {
    const hits = searchResults.hits;
    if (!searchActive || sortOption === 'date_desc') {
      return hits.map((h) => h.item);
    }
    const list = [...hits];
    list.sort((a, b) => {
      let primary = 0;
      switch (sortOption) {
        case 'name_asc':
          primary = a.item.name.localeCompare(b.item.name);
          break;
        case 'name_desc':
          primary = b.item.name.localeCompare(a.item.name);
          break;
        case 'duration_asc':
          primary = a.item.durationMs - b.item.durationMs;
          break;
        case 'duration_desc':
          primary = b.item.durationMs - a.item.durationMs;
          break;
        default:
          primary = a.item.createdAt - b.item.createdAt;
          break;
      }
      return primary !== 0 ? primary : b.score - a.score;
    });
    return list.map((h) => h.item);
  }, [searchActive, searchResults, sortOption]);

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
    seekLockRef.current = { targetSec: seconds, timestamp: Date.now() };
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

  useEffect(() => {
    onOverlayChange?.(renameModalVisible);
  }, [renameModalVisible, onOverlayChange]);

  useEffect(() => {
    return () => onOverlayChange?.(false);
  }, [onOverlayChange]);

  // Back button in library: close modals, exit search/edit, otherwise let app handle.
  useEffect(() => {
    const onBack = () => {
      if (renameModalVisible) {
        setRenameModalVisible(false);
        setRecordingToRename(null);
        return true;
      }
      if (exportModalVisible) {
        setExportModalVisible(false);
        return true;
      }
      if (deleteModalVisible) {
        setDeleteModalVisible(false);
        setDeleteTarget(null);
        return true;
      }
      if (sortModalVisible) {
        setSortModalVisible(false);
        return true;
      }
      if (menuVisible) {
        setMenuVisible(false);
        return true;
      }
      // Step out of search before leaving the screen: drop the query, then the
      // filter, then the keyboard, and only then the search strip itself. Each
      // press undoes exactly one thing, and the last one hides the bar - so Back
      // never quits the app while the user is still inside search.
      if (searchActive && (searchText.length > 0 || searchFilter !== 'all')) {
        if (searchText.length > 0) setSearchText('');
        if (searchFilter !== 'all') setSearchFilter('all');
        searchStepAtRef.current = Date.now();
        return true;
      }
      if (searchInputFocusedRef.current) {
        searchInputFocusedRef.current = false;
        try {
          searchInputRef.current?.blur();
        } catch {}
        Keyboard.dismiss();
        searchStepAtRef.current = Date.now();
        return true;
      }
      if (searchVisible && Date.now() - searchStepAtRef.current < 2000) {
        setSearchVisible(false);
        return true;
      }
      if (isEditMode) {
        setIsEditMode(false);
        setSelectedIds(new Set());
        onEditModeChange(false);
        return true;
      }
      return false;
    };
    const sub = BackHandler.addEventListener('hardwareBackPress', onBack);
    return () => sub.remove();
  }, [
    renameModalVisible,
    exportModalVisible,
    deleteModalVisible,
    sortModalVisible,
    menuVisible,
    searchActive,
    searchText,
    searchFilter,
    searchVisible,
    setSearchVisible,
    setSearchText,
    setSearchFilter,
    isEditMode,
    onEditModeChange,
  ]);

  const handleEditRecording = useCallback(
    (item: SavedRecording) => {
      // Release the preview player before the studio opens the file.
      try {
        playerRef.current?.pause();
      } catch {}
      setIsPlaying(false);
      onEditRecording(item);
    },
    [onEditRecording]
  );

  const handleSaveRename = useCallback(
    (newName: string) => {
      const target = recordingToRename;
      if (!target) {
        setRenameModalVisible(false);
        return;
      }

      const trimmed = newName.trim();
      if (trimmed.length > 0 && trimmed !== target.name) {
        const updated = RecordingLibrary.rename(target.id, trimmed);
        onLibraryUpdate(updated);
        showToast('Take Renamed', trimmed);

        void (async () => {
          try {
            const renamed = await renameTakeFile(target.uri, trimmed);
            if (renamed && renamed !== target.uri) {
              onLibraryUpdate(RecordingLibrary.updateUri(target.id, renamed));
            }
          } catch (err) {
            console.warn('[LibraryScreen] Could not rename take on disk:', err);
          }
        })();
      }

      setRenameModalVisible(false);
      setRecordingToRename(null);
    },
    [recordingToRename, onLibraryUpdate, showToast]
  );

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
      if (expandedIdRef.current === item.id) setExpandedId(null);

      const updated = await RecordingLibrary.delete(item.id);
      onLibraryUpdate(updated);
      showToast('Take Deleted', `"${item.name}" removed`, { variant: 'delete' });
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
      let failed: string[] = [];
      for (const id of selectedIds) {
        try {
          updated = await RecordingLibrary.delete(id);
        } catch {
          failed.push(id);
        }
      }
      onLibraryUpdate(updated.filter((r) => !selectedIds.has(r.id) || failed.indexOf(r.id) >= 0));
      setSelectedIds(new Set());
      setIsEditMode(false);
      onEditModeChange(false);
      showToast(
        'Takes Deleted',
        failed.length
          ? `${deletedCount - failed.length} removed, ${failed.length} could not be deleted`
          : `${deletedCount} recordings removed`,
        { variant: 'delete' }
      );
    }

    setDeleteModalVisible(false);
    setDeleteTarget(null);
  }, [deleteTarget, onEditModeChange, onLibraryUpdate, recordings, selectedIds, showToast]);

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

  const handleExportToStorage = useCallback(async () => {
    if (!exportTarget) return;
    const targets = exportTarget.type === 'single' ? [exportTarget.item] : exportTarget.items;
    setExportModalVisible(false);

    if (targets.length === 0) return;

    const validTargets: SavedRecording[] = [];
    for (const item of targets) {
      if (await checkFileValid(item.uri)) validTargets.push(item);
    }

    if (validTargets.length === 0) {
      showToast('Export Failed', 'Selected audio file(s) not found on disk', { variant: 'error' });
      return;
    }

    if (Platform.OS === 'android') {
      try {
        const permissions = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
        if (!permissions.granted) return;

        let savedCount = 0;
        for (const item of validTargets) {
          try {
            const fileData = await FileSystem.readAsStringAsync(item.uri, {
              encoding: FileSystem.EncodingType.Base64,
            });
            const mimeType = getMimeType(item.uri);
            const ext = extractExtension(item.uri) || '.wav';
            const safeName = sanitizeFileName(item.name) + ext;

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
          showToast('Export Failed', 'Could not save take(s) to the selected folder', { variant: 'error' });
        } else if (savedCount === 1) {
          showToast('Saved to Storage', validTargets[0].name);
        } else {
          showToast('Takes Saved', `${savedCount} recordings saved to folder`);
        }
      } catch (err: any) {
        showToast('Export Failed', err?.message || 'Storage Access export failed', { variant: 'error' });
      }
    } else {
      try {
        for (const item of validTargets) {
          await Sharing.shareAsync(item.uri, {
            dialogTitle: `Save ${item.name}`,
            UTI: extractExtension(item.uri) === '.wav' ? 'com.microsoft.waveform-audio' : 'public.audio',
          });
        }
        showToast(
          'Saved to Storage',
          validTargets.length === 1 ? validTargets[0].name : `${validTargets.length} takes`
        );
      } catch (err: any) {
        showToast('Export Failed', err?.message || 'Failed to save take', { variant: 'error' });
      }
    }
  }, [exportTarget, showToast]);

  const handleExportToApp = useCallback(async () => {
    if (!exportTarget) return;
    const targets = exportTarget.type === 'single' ? [exportTarget.item] : exportTarget.items;
    setExportModalVisible(false);

    if (targets.length === 0) return;

    try {
      const isAvailable = await Sharing.isAvailableAsync();
      if (!isAvailable) {
        showToast('Export Failed', 'Sharing is unavailable on this device', { variant: 'error' });
        return;
      }

      const validTargets: SavedRecording[] = [];
      for (const item of targets) {
        if (await checkFileValid(item.uri)) validTargets.push(item);
      }

      if (validTargets.length === 0) {
        showToast('Export Failed', 'Selected audio file(s) not found on disk', { variant: 'error' });
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
        validTargets.length === 1
          ? validTargets[0].name
          : `${validTargets.length} recordings processed`
      );
    } catch (err: any) {
      showToast('Export Failed', err?.message || 'Failed to send to app', { variant: 'error' });
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
          onEdit={handleEditRecording}
          highlights={highlights.get(item.id)}
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
      highlights,
      handleDeleteSingle,
      handleOpenExportSingle,
      handleOpenRename,
      handleEditRecording,
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
    exportTarget?.type === 'single' ? 1 : exportTarget?.type === 'batch' ? exportTarget.items.length : 0;

  const exportLabel =
    exportTarget?.type === 'single'
      ? `"${exportTarget.item.name}"`
      : `${exportCount} Recording${exportCount > 1 ? 's' : ''}`;

  // The field is always mounted now, so no focus juggling is needed to show
  // the keyboard. We only track focus so the hardware back key steps out of
  // the keyboard before it quits the app.
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidHide', () => {
      searchInputFocusedRef.current = false;
    });
    return () => show.remove();
  }, []);

  /** Removing a token chip edits the query in place (no full reset). */
  const handleRemoveToken = useCallback(
    (token: string) => {
      const safe = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const next = searchText
        .replace(new RegExp(`(^|\\s)${safe}(\\s|$)`, 'i'), ' ')
        .replace(/\s+/g, ' ')
        .trim();
      setSearchText(next ? `${next} ` : '');
    },
    [searchText, setSearchText]
  );

  return (
    <View style={styles.container}>
      <View style={[styles.contentConstraint, { maxWidth: maxContentWidth }]}>
        {!isEditMode ? (
          <>
            <View style={styles.header}>
              <Text style={styles.headerTitle}>
                {searchActive ? 'Filtered results' : 'All recordings'}
              </Text>
              <View style={styles.headerRightActions}>
                <TouchableOpacity
                  style={styles.headerIconBtn}
                  onPress={() => {
                    // One button, both directions: open (and focus) the strip, or
                    // close it. The query survives either way.
                    if (searchVisible) {
                      try {
                        searchInputRef.current?.blur();
                      } catch {}
                      Keyboard.dismiss();
                      setSearchVisible(false);
                      return;
                    }
                    setSearchVisible(true);
                    // The field has to be mounted before focus() will stick.
                    setTimeout(() => {
                      try {
                        searchInputRef.current?.focus();
                      } catch {}
                    }, 60);
                  }}
                  activeOpacity={0.7}
                  accessibilityLabel={searchVisible ? 'Hide search' : 'Search recordings'}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Search size={19} color={searchVisible || searchActive ? '#FFFFFF' : '#C7C7CE'} />
                  {searchActive ? <View style={styles.headerIconDot} /> : null}
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.headerIconBtn}
                  onPress={() => setMenuVisible(true)}
                  activeOpacity={0.7}
                  accessibilityLabel="Library options"
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <MoreVertical size={19} color="#C7C7CE" />
                </TouchableOpacity>
              </View>
            </View>

            {searchVisible ? (
              <LibrarySearchBar
              inputRef={searchInputRef}
              text={searchText}
              pending={searchPending}
              tokens={searchTokens}
              filter={searchFilter}
              recents={recents}
              resultCount={processedRecordings.length}
              totalCount={recordings.length}
              sortOption={sortOption}
              onChangeText={setSearchText}
              onCommit={commitSearch}
              onClear={clearSearch}
              onRemoveToken={handleRemoveToken}
              onPickRecent={(value) => {
              // Picking a recent query focuses straight into results.
              setSearchText(value);
              commitSearch();
              try {
              searchInputRef.current?.blur();
              } catch {}
              }}
              onRemoveRecent={removeRecent}
              onFilterChange={setSearchFilter}
              onPressSort={() => setSortModalVisible(true)}
              onFocusChange={(isFocused) => {
                searchInputFocusedRef.current = isFocused;
              }}
              onExit={() => {
                Keyboard.dismiss();
                try {
                  searchInputRef.current?.blur();
                } catch {}
                searchStepAtRef.current = Date.now();
              }}
              onHide={() => setSearchVisible(false)}
              />
            ) : null}
          </>
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

            <Text style={styles.editModeCountText}>{selectedIds.size} selected</Text>

            <TouchableOpacity onPress={handleSelectAll} style={styles.editModeActionBtn}>
              <Text style={styles.selectAllText}>
                {selectedIds.size === processedRecordings.length ? 'Deselect all' : 'Select all'}
              </Text>
            </TouchableOpacity>
          </View>
        )}

        {processedRecordings.length === 0 ? (
          <ScrollView
            style={styles.emptyScroll}
            contentContainerStyle={[
              styles.emptyContainer,
              { paddingBottom: keyboardOffset + 140 },
            ]}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            showsVerticalScrollIndicator={false}
            bounces={false}
          >
            <View style={styles.emptyIconCircle}>
              {searchActive ? (
                <Search size={22} color="#52525B" strokeWidth={2} />
              ) : (
                <Mic size={22} color="#52525B" strokeWidth={2} />
              )}
            </View>

            <Text style={styles.emptyTitle}>
              {searchActive ? 'Nothing matches that' : 'No Recordings Yet'}
            </Text>
            <Text style={styles.emptySub}>
              {searchActive
                ? searchResults.unmatched.length > 0
                  ? `No take matches ${searchResults.unmatched
                      .map((t) => `"${t}"`)
                      .join(' + ')}. Every term has to match, so drop the one that is wrong.`
                  : 'No take matches this combination yet. Try fewer letters - "mon" finds Monday takes, "80s" finds 80 second ones.'
                : 'Tap the microphone button below to begin your first take.'}
            </Text>

            {searchActive ? (
              <TouchableOpacity
                style={styles.emptyActionBtn}
                onPress={() => {
                  clearSearch();
                  setSearchFilter('all');
                }}
                activeOpacity={0.8}
              >
                <X size={13} color="#000000" strokeWidth={3} />
                <Text style={styles.emptyActionText}>Reset search</Text>
              </TouchableOpacity>
            ) : null}
          </ScrollView>
        ) : (
          <FlatList
            data={processedRecordings}
            keyExtractor={(item) => item.id}
            renderItem={renderItem}
            contentContainerStyle={[
              styles.listContent,
              // With adjustResize the window already shrinks; this only adds
              // the difference when the IME floats over the window instead.
              keyboardOffset > 0 ? { paddingBottom: 200 + keyboardOffset } : null,
            ]}
            showsVerticalScrollIndicator={false}
            removeClippedSubviews={false}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            extraData={`${expandedId}|${activeId}|${isPlaying}|${selectedIds.size}`}
          />
        )}

        {isEditMode ? (
          <LibraryBatchBar
            selectedCount={selectedIds.size}
            totalCount={processedRecordings.length}
            bottomOffset={deckBottom}
            onDelete={handleBatchDelete}
            onExport={handleOpenExportBatch}
          />
        ) : null}
      </View>

      {toastData ? <AppToast data={toastData} top={toastTop} /> : null}

      <Modal
        visible={menuVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setMenuVisible(false)}
      >
        <View style={styles.menuBackdrop}>
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={() => setMenuVisible(false)}
          />
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
        </View>
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
        fileUri={recordingToRename?.uri}
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
            : `Permanently delete ${deleteTarget?.count} recording${
                (deleteTarget?.count ?? 0) > 1 ? 's' : ''
              }? This action cannot be undone.`
        }
        onConfirm={handleConfirmDelete}
        onCancel={() => {
          setDeleteModalVisible(false);
          setDeleteTarget(null);
        }}
      />

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
              <TouchableOpacity style={styles.exportOptionRow} onPress={handleExportToStorage} activeOpacity={0.7}>
                <View style={styles.exportIconBox}>
                  <HardDrive size={18} color="#E4E4E7" strokeWidth={2.2} />
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

              <TouchableOpacity style={styles.exportOptionRow} onPress={handleExportToApp} activeOpacity={0.7}>
                <View style={styles.exportIconBox}>
                  <Share2 size={18} color="#E4E4E7" strokeWidth={2.2} />
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
    minHeight: 60,
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
  headerIconDot: {
    position: 'absolute',
    top: 7,
    right: 7,
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#FFFFFF',
    borderColor: '#0D0D10',
    borderWidth: 1.5,
  },
  headerIconBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#121212',
  },
  // Deterministic sizing: the input must never collapse to zero (explicit
  // full-width container, flex + minWidth:0 on the input, full height).
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
  emptyScroll: {
    flex: 1,
    width: '100%',
  },
  emptyContainer: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    paddingTop: 24,
  },
  emptyIconCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#0D0D10',
    borderWidth: 1,
    borderColor: '#1E1E22',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
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
  emptyActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 38,
    paddingHorizontal: 18,
    borderRadius: 19,
    backgroundColor: '#FFFFFF',
    marginTop: 18,
  },
  emptyActionText: {
    color: '#000000',
    fontSize: 13,
    fontWeight: '700',
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
    backgroundColor: '#1C1C2E',
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
  exportIconBox: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.16)',
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
