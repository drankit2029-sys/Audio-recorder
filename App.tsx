import 'react-native-gesture-handler';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  Pressable,
  Alert,
  AppState,
  LayoutChangeEvent,
  BackHandler,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  FadeIn,
  FadeOut,
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withSpring,
  cancelAnimation,
  Easing,
} from 'react-native-reanimated';
import * as FileSystem from 'expo-file-system/legacy';
import { StatusBar } from 'expo-status-bar';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { setAudioModeAsync } from 'expo-audio';
import {
  Sliders,
  Mic,
  ChevronLeft,
  Radio,
  AlignLeft,
  Usb,
  Bluetooth,
  Headphones,
  Replace,
  Play,
} from 'lucide-react-native';

import {
  SessionJournal,
  ActiveSessionRecord,
  StudioJournalRecord,
} from './src/services/storage/sessionJournal';
import { AudioPresetConfig } from './src/services/audio/types';
import { AudioSettingsStorage } from './src/services/storage/audioSettingsStorage';
import { RecordingLibrary, SavedRecording } from './src/services/storage/recordingLibrary';
import {
  useStudioSession,
  isSessionState,
  END_EPSILON_MS,
} from './src/services/audio/useStudioSession';
import { StudioTimer } from './src/components/studio/StudioTimer';
import { StudioWaveform } from './src/components/studio/StudioWaveform';
import { WaveformZoomControl } from './src/components/studio/WaveformZoomControl';
import { AudioMeter } from './src/components/meter/AudioMeter';
import { TeleprompterDeck } from './src/components/prompter/TeleprompterDeck';
import { AudioSettingsModal } from './src/components/settings/AudioSettingsModal';
import { SaveRecordingModal, SaveMode } from './src/components/audio/SaveRecordingModal';
import { ActiveRecordingWarningModal } from './src/components/audio/ActiveRecordingWarningModal';
import {
  InterruptedTakeModal,
  InterruptedTakeInfo,
} from './src/components/audio/InterruptedTakeModal';
import { useAudioInputDevices } from './src/services/audio/useAudioInputDevices';
import { InputDeviceModal } from './src/components/audio/InputDeviceModal';
import { BusyOverlay } from './src/components/common/BusyOverlay';
import { useResponsive } from './src/hooks/useResponsive';
import { LibraryScreen } from './src/screens/LibraryScreen';
import {
  StudioEngine,
  StudioOutputFormat,
  StudioSessionInfo,
} from './modules/audio-hardware-router/src';
import {
  ensureCapturePermissions,
  describeMissingPermissions,
} from './src/services/audio/permissions';
import {
  ensureTakesFolder,
  extractExtension,
  renameTakeFile,
  reserveNativeTakePath,
  toNativePath,
} from './src/services/storage/recordingPaths';
import {
  AppToast,
  AppToastData,
  ToastVariant,
  getToastTop,
} from './src/components/common/AppToast';

type AppScreen = 'library' | 'studio';

/** How a studio session is delivered when it is saved. */
interface DeliveryFormat {
  format: StudioOutputFormat;
  bitRate: number;
  sampleRate: number;
  channels: number;
  extension: string;
  badge: string;
}

interface PendingSave {
  defaultName: string;
  durationMs: number;
  sizeBytes: number;
  sizeIsEstimate: boolean;
  badge: string;
  editOfName: string | null;
}

interface EditContext {
  recording: SavedRecording;
}

type Orphan =
  | { kind: 'studio'; journal: StudioJournalRecord; sizeBytes: number }
  | { kind: 'legacy'; legacy: ActiveSessionRecord; sizeBytes: number };

type MainIcon = 'mic' | 'record' | 'pause' | 'play';

/**
 * M1: the prompter used to be sized by `flex` plus a hard 150pt floor, which
 * pushed the transport off the bottom of any screen shorter than roughly
 * 500dp — small phones, split-screen, and landscape windows on tablets that
 * Android 16 refuses to keep in portrait. The prompter now gets exactly the
 * space that is left over and is the first thing to go when there is none.
 */
const MIN_PROMPTER_HEIGHT = 120;
/** Header + spacing + cockpit + transport clearance. */
const STUDIO_CHROME_REGULAR = 356;
const STUDIO_CHROME_COMPACT = 322;

const khzLabel = (rate: number) =>
  `${(rate / 1000).toFixed(rate % 1000 === 0 ? 0 : 1)}kHz`;
const channelLabel = (n: number) => (n === 1 ? 'Mono' : 'Stereo');

const presetToDelivery = (preset: AudioPresetConfig): DeliveryFormat => ({
  format: preset.format as StudioOutputFormat,
  bitRate: preset.bitRate ?? 0,
  sampleRate: preset.sampleRate,
  channels: preset.channels,
  extension: preset.extension,
  badge: preset.badge,
});

/** An edited take is saved back in the format it already had. */
function deliveryForSource(uri: string, info: StudioSessionInfo): DeliveryFormat {
  const ext = extractExtension(uri);
  const rate = info.sampleRate;
  const ch = Math.max(1, Math.min(2, info.channels));
  const source = info.sourceBitRate ?? 0;
  const roundKbps = (bps: number, min: number, max: number) =>
    Math.max(min, Math.min(max, Math.round(bps / 1000) * 1000));

  switch (ext) {
    case '.m4a':
    case '.mp4': {
      const he = source > 0 && source <= 72000;
      const bitRate = source > 0 ? roundKbps(source, he ? 24000 : 64000, 320000) : 128000;
      return {
        format: he ? 'he_aac' : 'aac',
        bitRate,
        sampleRate: rate,
        channels: ch,
        extension: '.m4a',
        badge: `${he ? 'HE-AAC' : 'AAC'} ${Math.round(bitRate / 1000)} kbps ${khzLabel(rate)} ${channelLabel(ch)}`,
      };
    }
    case '.aac': {
      const bitRate = source > 0 ? roundKbps(source, 64000, 320000) : 192000;
      return {
        format: 'aac_adts',
        bitRate,
        sampleRate: rate,
        channels: ch,
        extension: '.aac',
        badge: `AAC-ADTS ${Math.round(bitRate / 1000)} kbps ${khzLabel(rate)} ${channelLabel(ch)}`,
      };
    }
    case '.3gp':
    case '.amr': {
      const wb = rate > 8000;
      return {
        format: wb ? 'amr_wb' : 'amr_nb',
        bitRate: wb ? 23850 : 12200,
        sampleRate: wb ? 16000 : 8000,
        channels: 1,
        extension: '.3gp',
        badge: wb ? 'AMR-WB 23.85 kbps 16 kHz Mono' : 'AMR-NB 12.2 kbps 8 kHz Mono',
      };
    }
    default:
      return {
        format: 'wav',
        bitRate: 0,
        sampleRate: rate,
        channels: ch,
        extension: '.wav',
        badge: `WAV ${khzLabel(rate)} ${info.floatPcm ? '32-bit float' : '16-bit'} ${channelLabel(ch)}`,
      };
  }
}

function estimateSize(
  delivery: DeliveryFormat,
  info: StudioSessionInfo | null,
  durationMs: number
): { bytes: number; estimate: boolean } {
  const seconds = Math.max(0, durationMs) / 1000;
  if (delivery.format === 'wav') {
    const rate = info?.sampleRate ?? delivery.sampleRate;
    const ch = info?.channels ?? delivery.channels;
    const bps = info?.floatPcm ? 4 : 2;
    return { bytes: 44 + Math.round(seconds * rate) * ch * bps, estimate: false };
  }
  return { bytes: Math.round((delivery.bitRate / 8) * seconds) + 1024, estimate: true };
}

const formatClock = (ms: number) => {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
};

const timeStamp = () =>
  new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function AudioRecorderApp() {
  const [currentScreen, setCurrentScreen] = useState<AppScreen>('library');
  const [showPrompter, setShowPrompter] = useState(true);

  const [settingsVisible, setSettingsVisible] = useState(false);
  const [deviceModalVisible, setDeviceModalVisible] = useState(false);
  const [recordings, setRecordings] = useState<SavedRecording[]>([]);
  const [isLibraryEditMode, setIsLibraryEditMode] = useState(false);
  const [isLibraryOverlayOpen, setIsLibraryOverlayOpen] = useState(false);

  const [pendingSave, setPendingSave] = useState<PendingSave | null>(null);
  const pendingSaveRef = useRef<PendingSave | null>(null);
  const [saveVisible, setSaveVisible] = useState(false);
  const saveVisibleRef = useRef(false);
  const [warningModalVisible, setWarningModalVisible] = useState(false);
  const [toastData, setToastData] = useState<AppToastData | null>(null);
  const [busy, setBusy] = useState<{ title: string; subtitle?: string } | null>(null);

  const [orphan, setOrphan] = useState<Orphan | null>(null);
  const [interruptedModalVisible, setInterruptedModalVisible] = useState(false);

  const [editContext, setEditContextState] = useState<EditContext | null>(null);
  const editContextRef = useRef<EditContext | null>(null);
  const [replaceArmed, setReplaceArmedState] = useState(false);
  const replaceArmedRef = useRef(false);
  const [syncResetKey, setSyncResetKey] = useState(0);

  const [presetKey, setPresetKeyState] = useState<string>(() => AudioSettingsStorage.getPreset());
  const activePreset = AudioSettingsStorage.getResolvedPreset(presetKey);
  const activePresetRef = useRef(activePreset);
  activePresetRef.current = activePreset;
  const deliveryRef = useRef<DeliveryFormat>(presetToDelivery(activePreset));

  const toastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTransportBusyRef = useRef(false);
  const isSavingRef = useRef(false);
  const isAppForegroundRef = useRef(true);
  const exitAfterSaveRef = useRef(false);
  const sessionResourcesRef = useRef({ micGranted: false, routing: false, keepAwake: false });

  // Keep refs in sync for notification handler.
  useEffect(() => {
    pendingSaveRef.current = pendingSave;
  }, [pendingSave]);
  useEffect(() => {
    saveVisibleRef.current = saveVisible;
    if (saveVisible) {
      // Collapse the foreground notification while the save dialog is open,
      // so Resume cannot be triggered behind it.
      StudioEngine.stopForegroundService().catch(() => {});
    }
  }, [saveVisible]);

  const pxPerSec = useSharedValue(AudioSettingsStorage.getWaveformZoom());
  const [cockpitCenterY, setCockpitCenterY] = useState(0);
  const [waveFrame, setWaveFrame] = useState({ y: 0, height: 54 });
  const [waveWidth, setWaveWidth] = useState(240);

  const {
    isTablet,
    maxContentWidth,
    insets,
    contentHeight,
    isCompactHeight,
  } = useResponsive();

  const toastTop = getToastTop(insets.top);
  const transportBottom = insets.bottom + 24;
  const transportClearance = insets.bottom + 112;

  const prompterHeight = Math.max(
    0,
    contentHeight - (isCompactHeight ? STUDIO_CHROME_COMPACT : STUDIO_CHROME_REGULAR)
  );
  const prompterVisible = showPrompter && prompterHeight >= MIN_PROMPTER_HEIGHT;
  const waveformHeight = isCompactHeight ? 42 : isTablet ? 72 : 54;
  const zoomHeight = Math.max(66, waveformHeight + 14);

  const setEditContext = (ctx: EditContext | null) => {
    editContextRef.current = ctx;
    setEditContextState(ctx);
  };

  const setReplaceArmed = (armed: boolean) => {
    replaceArmedRef.current = armed;
    setReplaceArmedState(armed);
  };

  const showToast = (
    title: string,
    subtitle?: string,
    opts: { variant?: ToastVariant; detail?: string } = {}
  ) => {
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    setToastData({ title, subtitle, ...opts });
    toastTimeoutRef.current = setTimeout(() => setToastData(null), 3600);
  };
  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;

  const formatBytes = (bytes: number) =>
    bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / (1024 * 1024)).toFixed(2)} MB`;

  useEffect(() => {
    isAppForegroundRef.current = AppState.currentState === 'active';
    const sub = AppState.addEventListener('change', (next) => {
      isAppForegroundRef.current = next === 'active';
    });
    return () => sub.remove();
  }, []);

  // Back button: studio should pause or prompt, library should exit search/edit, otherwise let system handle.
  useEffect(() => {
    const onBack = () => {
      if (saveVisibleRef.current) {
        exitAfterSaveRef.current = false;
        setSaveVisible(false);
        return true;
      }
      if (warningModalVisible) {
        setWarningModalVisible(false);
        return true;
      }
      if (settingsVisible) {
        setSettingsVisible(false);
        return true;
      }
      if (deviceModalVisible) {
        setDeviceModalVisible(false);
        return true;
      }
      if (interruptedModalVisible) {
        return true;
      }
      if (currentScreen === 'studio') {
        if (isSessionState(engineStateRef.current)) {
          setWarningModalVisible(true);
        } else {
          setCurrentScreen('library');
        }
        return true;
      }
      // library: let LibraryScreen handle search/edit/overlay via its own handler.
      // If overlay is open, we consume back to avoid exiting app.
      if (isLibraryOverlayOpen) {
        return true;
      }
      if (isLibraryEditMode) {
        return true;
      }
      return false;
    };
    const sub = BackHandler.addEventListener('hardwareBackPress', onBack);
    return () => sub.remove();
  }, [
    currentScreen,
    warningModalVisible,
    settingsVisible,
    deviceModalVisible,
    interruptedModalVisible,
    isLibraryOverlayOpen,
    isLibraryEditMode,
  ]);

  const {
    devices,
    activeDevice,
    selectedDeviceId,
    selectedDevice,
    selectDevice,
    refreshDevices,
    activateHardwareRouting,
    releaseHardwareRouting,
  } = useAudioInputDevices();

  const selectedDeviceIdRef = useRef(selectedDeviceId);
  selectedDeviceIdRef.current = selectedDeviceId;
  const activateHardwareRoutingRef = useRef(activateHardwareRouting);
  activateHardwareRoutingRef.current = activateHardwareRouting;
  const releaseHardwareRoutingRef = useRef(releaseHardwareRouting);
  releaseHardwareRoutingRef.current = releaseHardwareRouting;

  // Routed through refs: the handlers are defined further down.
  const notificationActionRef = useRef<(action: 'resume' | 'stop' | 'pause') => void>(() => {});

  const session = useStudioSession({
    onNotificationAction: (action) => notificationActionRef.current(action),
    onError: (e) => {
      showToastRef.current(
        e.code === 'size_limit' ? 'Take Paused' : 'Capture Stopped',
        e.message,
        { variant: 'warning', detail: e.message }
      );
    },
  });

  const {
    engineState,
    engineStateRef,
    overwriting,
    isBeforeEnd,
    telemetry,
    playheadMs,
    durationMs,
    peaks,
    isScrubbing,
    isRunning,
    isRecording,
  } = session;

  const isSessionActive = isSessionState(engineState);
  const replaceEnabled =
    isBeforeEnd &&
    (engineState === 'PAUSED' ||
      engineState === 'PREVIEWING' ||
      (engineState === 'RECORDING' && overwriting));

  // Replace switches itself off once it can no longer apply (the playhead
  // reached the end of the old audio, or a normal take is running).
  useEffect(() => {
    if (!replaceEnabled && replaceArmedRef.current) setReplaceArmed(false);
  }, [replaceEnabled]);

  // Keep a warm (pre-opened, stopped) microphone while the studio is idle
  // or paused: reopening AudioRecord on every start/resume used to cost
  // 200-500 ms, which is what produced the silent gap at the head of a
  // segment and the UI timer running ahead of the audio. Warming is
  // best-effort (native swallows failures) and is dropped on background.
  const [appActive, setAppActive] = useState(() => AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setAppActive(s === 'active'));
    return () => sub.remove();
  }, []);
  useEffect(() => {
    if (!appActive || currentScreen !== 'studio' || isSessionActive) return;
    void StudioEngine.prepareRecorder(selectedDeviceId ?? -1);
  }, [appActive, currentScreen, isSessionActive, selectedDeviceId]);

  const mainIcon: MainIcon =
    engineState === 'RECORDING' || engineState === 'PREVIEWING'
      ? 'pause'
      : engineState === 'PAUSED'
      ? isBeforeEnd && !replaceArmed
        ? 'play'
        : 'record'
      : 'mic';

  // ---- transport animation --------------------------------------------------
  // Derived early: the slide effect below needs it, and it is a pure function
  // of state.
  const transportHidden = isLibraryEditMode || isLibraryOverlayOpen;

  const slideProgress = useSharedValue(0);
  const redCircleOpacity = useSharedValue(1);
  const redCircleScale = useSharedValue(1);
  const micOpacity = useSharedValue(1);
  const pauseOpacity = useSharedValue(0);
  const pauseScale = useSharedValue(0.7);
  const playOpacity = useSharedValue(0);
  const playScale = useSharedValue(0.7);

  const slidePrimedRef = useRef(false);
  const transportShownRef = useRef(!transportHidden);
  const appMountedAtRef = useRef<number | null>(null);
  if (appMountedAtRef.current === null) appMountedAtRef.current = Date.now();

  useEffect(() => {
    const target = isSessionActive ? 1 : 0;
    // Jump straight to the final layout (no slide) when:
    //  - the transport has not painted yet,
    //  - it is being re-shown after the save/rename overlays hid it,
    //  - we are still inside the bootstrap window, i.e. the session became
    //    "active" because a live native take was re-attached on cold start.
    // In those cases the slide reads as the record button drifting to the
    // left on its own.
    const jump =
      !slidePrimedRef.current ||
      transportShownRef.current !== !transportHidden ||
      Date.now() - (appMountedAtRef.current ?? 0) < 1200;
    slidePrimedRef.current = true;
    transportShownRef.current = !transportHidden;
    if (jump) {
      slideProgress.value = target;
    } else {
      // Slightly overdamped (critical for these params ~= 30.5): the button
      // must settle into its slot without overshooting past it.
      slideProgress.value = withSpring(target, {
        damping: 32,
        stiffness: 260,
        mass: 0.9,
      });
    }
  }, [isSessionActive, transportHidden, slideProgress]);

  useEffect(() => {
    const ease = Easing.out(Easing.cubic);
    const show = (v: typeof redCircleOpacity, on: boolean, ms = 180) => {
      v.value = withTiming(on ? 1 : 0, { duration: ms, easing: ease });
    };
    const scale = (v: typeof redCircleScale, on: boolean, off: number) => {
      v.value = withTiming(on ? 1 : off, { duration: 180, easing: ease });
    };
    const red = mainIcon === 'mic' || mainIcon === 'record';
    show(redCircleOpacity, red, red ? 180 : 160);
    scale(redCircleScale, red, 0.8);
    show(micOpacity, mainIcon === 'mic', 140);
    show(pauseOpacity, mainIcon === 'pause', 200);
    scale(pauseScale, mainIcon === 'pause', 0.7);
    show(playOpacity, mainIcon === 'play', 200);
    scale(playScale, mainIcon === 'play', 0.7);
  }, [mainIcon, redCircleOpacity, redCircleScale, micOpacity, pauseOpacity, pauseScale, playOpacity, playScale]);

  const mainBtnAnimatedStyle = useAnimatedStyle(() => ({ transform: [{ translateX: -46 * slideProgress.value }] }));
  const stopBtnAnimatedStyle = useAnimatedStyle(() => ({
    opacity: slideProgress.value,
    transform: [{ translateX: 46 * slideProgress.value }, { scale: 0.5 + 0.5 * slideProgress.value }],
  }));
  const redCircleAnimStyle = useAnimatedStyle(() => ({ opacity: redCircleOpacity.value, transform: [{ scale: redCircleScale.value }] }));
  const micIconAnimStyle = useAnimatedStyle(() => ({ opacity: micOpacity.value }));
  const pauseBarsAnimStyle = useAnimatedStyle(() => ({ opacity: pauseOpacity.value, transform: [{ scale: pauseScale.value }] }));
  const playIconAnimStyle = useAnimatedStyle(() => ({ opacity: playOpacity.value, transform: [{ scale: playScale.value }] }));

  // ---- session resources ------------------------------------------------------
  const acquireCaptureResources = async (): Promise<boolean> => {
    const r = sessionResourcesRef.current;
    if (!r.micGranted) {
      // Notifications are requested too (the recording notification), but a
      // denial does not block capture: the service still runs without it.
      const gate = await ensureCapturePermissions({});
      if (!gate.granted) {
        Alert.alert('Permission needed', describeMissingPermissions(gate.missing, gate.canAskAgain));
        return false;
      }
      r.micGranted = true;
    }
    if (!r.routing) {
      activateHardwareRoutingRef.current();
      r.routing = true;
    }
    if (!r.keepAwake) {
      activateKeepAwakeAsync().catch(() => {});
      r.keepAwake = true;
    }
    return true;
  };

  const releaseSessionResources = () => {
    const r = sessionResourcesRef.current;
    if (r.keepAwake) {
      try {
        void deactivateKeepAwake();
      } catch {}
    }
    if (r.routing) releaseHardwareRoutingRef.current();
    sessionResourcesRef.current = { micGranted: false, routing: false, keepAwake: false };
  };

  const writeJournal = (
    info: StudioSessionInfo,
    edit: SavedRecording | null,
    delivery: DeliveryFormat,
    presetKeyForJournal: string
  ) => {
    SessionJournal.startStudioSession({
      sessionId: info.sessionId,
      sessionPath: info.sessionPath,
      presetKey: presetKeyForJournal,
      badge: delivery.badge,
      sampleRate: info.sampleRate,
      channels: info.channels,
      floatPcm: info.floatPcm,
      editOf: edit ? { id: edit.id, name: edit.name, uri: edit.uri } : null,
      startedAt: Date.now(),
      durationMs: info.durationMs,
    });
  };

  const finishSessionUi = () => {
    SessionJournal.clearStudioSession();
    releaseSessionResources();
    setEditContext(null);
    setReplaceArmed(false);
    if (exitAfterSaveRef.current) {
      exitAfterSaveRef.current = false;
      setCurrentScreen('library');
    }
  };

  // Journal heartbeat while a take runs (the working file is the real truth).
  const getSessionDurationMs = session.getDurationMs;
  useEffect(() => {
    if (!isSessionActive) return;
    SessionJournal.updateStudioHeartbeat(getSessionDurationMs());
    if (engineState !== 'RECORDING') return;
    const id = setInterval(() => {
      SessionJournal.updateStudioHeartbeat(getSessionDurationMs());
    }, 3000);
    return () => clearInterval(id);
  }, [engineState, isSessionActive, getSessionDurationMs]);

  // ---- saving -------------------------------------------------------------------
  const commitTakeToLibrary = (
    uri: string,
    sizeBytes: number,
    takeDurationMs: number,
    name: string
  ) => {
    const record: SavedRecording = {
      id: `take_${Date.now()}`,
      name,
      uri,
      sizeBytes,
      durationMs: takeDurationMs,
      createdAt: Date.now(),
    };

    setRecordings(RecordingLibrary.save(record));
    showToast('Take Saved', `${record.name} • ${formatBytes(sizeBytes)}`, { variant: 'success' });

    void (async () => {
      try {
        const renamed = await renameTakeFile(uri, name);
        if (renamed && renamed !== uri) {
          setRecordings(RecordingLibrary.updateUri(record.id, renamed));
        }
      } catch (err) {
        console.warn('[App] Could not rename take on disk:', err);
      }
    })();
  };

  const performSave = async (chosenName: string, mode: SaveMode) => {
    if (isSavingRef.current) return;
    isSavingRef.current = true;
    const delivery = deliveryRef.current;
    const edit = editContextRef.current;
    let name = chosenName.trim() || `Take ${timeStamp()}`;
    if (mode === 'new' && edit && name === edit.recording.name) name = `${name} (edit)`;

    setSaveVisible(false);
    setBusy({ title: mode === 'overwrite' ? 'Saving changes' : 'Saving take', subtitle: delivery.badge });
    try {
      const original = mode === 'overwrite' && edit ? edit.recording : null;
      const sameFile = !!original && extractExtension(original.uri) === delivery.extension;
      const targetPath = sameFile && original
        ? toNativePath(original.uri)
        : await reserveNativeTakePath(name, delivery.extension);

      const result = await session.finalize({
        targetPath,
        format: delivery.format,
        bitRate: delivery.bitRate,
        sampleRate: delivery.sampleRate,
        channels: delivery.channels,
      });

      if (original) {
        const uri = sameFile ? original.uri : `file://${result.path}`;
        if (!sameFile) {
          FileSystem.deleteAsync(original.uri, { idempotent: true }).catch(() => {});
        }
        setRecordings(
          RecordingLibrary.update(original.id, {
            uri,
            name,
            sizeBytes: result.sizeBytes,
            durationMs: result.durationMs,
          })
        );
        if (name !== original.name) {
          void renameTakeFile(uri, name)
            .then((renamed) => {
              if (renamed && renamed !== uri) setRecordings(RecordingLibrary.updateUri(original.id, renamed));
            })
            .catch(() => {});
        }
        showToast('Changes Saved', `${name} • ${formatBytes(result.sizeBytes)}`, { variant: 'success' });
      } else {
        commitTakeToLibrary(`file://${result.path}`, result.sizeBytes, result.durationMs, name);
      }
      setPendingSave(null);
      finishSessionUi();
    } catch (e: any) {
      Alert.alert(
        'Could not save the take',
        `${e?.message ?? 'Unknown error'}\n\nNothing was lost: the take is still open in the studio, so you can try again.`
      );
    } finally {
      setBusy(null);
      isSavingRef.current = false;
    }
  };

  const handleStopPress = async (autoSave = false) => {
    if (isTransportBusyRef.current || isSavingRef.current) return;
    if (!isSessionState(engineStateRef.current)) return;
    isTransportBusyRef.current = true;

    try {
      try {
        await session.pause();
      } catch {}

      const takeMs = session.getDurationMs();
      const edit = editContextRef.current;

      if (takeMs <= 0) {
        await session.discard();
        finishSessionUi();
        showToast('Nothing Captured', 'The take was empty, so it was not saved.', { variant: 'warning' });
        return;
      }

      if (edit && !session.hasEditsRef.current) {
        // Opened for editing but nothing was recorded: just close it.
        await session.discard();
        finishSessionUi();
        showToast('Take Closed', `No changes were made to ${edit.recording.name}`, { variant: 'success' });
        return;
      }

      const delivery = deliveryRef.current;
      const shouldPrompt = !autoSave || isAppForegroundRef.current;
      if (shouldPrompt) {
        const size = estimateSize(delivery, session.sessionInfoRef.current, takeMs);
        setPendingSave({
          defaultName: edit ? edit.recording.name : `Take ${timeStamp()}`,
          durationMs: takeMs,
          sizeBytes: size.bytes,
          sizeIsEstimate: size.estimate,
          badge: delivery.badge,
          editOfName: edit ? edit.recording.name : null,
        });
        setSaveVisible(true);
      } else {
        // "Stop & save" from the notification while the app is in the
        // background: never overwrite an original silently.
        isTransportBusyRef.current = false;
        await performSave(edit ? `${edit.recording.name} (edit)` : `Take ${timeStamp()}`, 'new');
      }
    } catch (e: any) {
      Alert.alert('Stop Error', e?.message ?? 'Unknown error');
    } finally {
      isTransportBusyRef.current = false;
    }
  };

  const handleStopPressRef = useRef(handleStopPress);
  handleStopPressRef.current = handleStopPress;

  const handleDiscardTake = async () => {
    setSaveVisible(false);
    const wasEdit = !!editContextRef.current;
    try {
      await session.discard();
    } catch (err) {
      console.warn('[App] Failed to discard take:', err);
    }
    setPendingSave(null);
    finishSessionUi();
    showToast(
      wasEdit ? 'Changes Discarded' : 'Take Discarded',
      wasEdit ? 'The original take was not modified' : 'Audio file deleted from this device',
      { variant: 'delete' }
    );
  };

  const handleKeepEditing = () => {
    exitAfterSaveRef.current = false;
    setSaveVisible(false);
  };

  // ---- transport ----------------------------------------------------------------
  /** Negative position appends at the end of the take. */
  const startCapture = async (positionMs: number) => {
    // Freeze the playhead before (not only during) the native switch:
    // acquiring routing / wake-lock can take a few hundred ms, and the
    // playhead must not keep extrapolating across that gap.
    session.beginSwitch();
    if (!(await acquireCaptureResources())) {
      session.endSwitch();
      return;
    }
    await session.record(positionMs, selectedDeviceIdRef.current ?? -1);
  };

  /** What the main button does while the take is paused. */
  const resumeFromPause = async () => {
    // Stop any waveform momentum so the take starts exactly where it shows.
    if (isScrubbing.value) cancelAnimation(playheadMs);
    const pos = session.getPlayheadMs();
    const dur = session.getDurationMs();
    if (pos >= dur - END_EPSILON_MS) {
      await startCapture(-1);
    } else if (replaceArmedRef.current) {
      await startCapture(pos);
    } else {
      await session.preview(pos);
    }
  };

  const startNewTake = async () => {
    if (!(await acquireCaptureResources())) return;
    const preset = activePresetRef.current;
    const delivery = presetToDelivery(preset);
    deliveryRef.current = delivery;
    setEditContext(null);
    setReplaceArmed(false);
    const info = await session.createAndRecord({
      sampleRate: preset.sampleRate,
      channels: preset.channels === 2 ? 2 : 1,
      bitDepth: preset.format === 'wav' && preset.bitDepth === 32 ? 32 : 16,
      badge: preset.badge,
      inputDeviceId: selectedDeviceIdRef.current ?? -1,
    });
    writeJournal(info, null, delivery, preset.key);
  };

  const handleMainButtonPress = async () => {
    if (currentScreen === 'library') {
      setCurrentScreen('studio');
      return;
    }
    if (isTransportBusyRef.current || isSavingRef.current) return;
    isTransportBusyRef.current = true;
    const state = engineStateRef.current;

    try {
      if (state === 'RECORDING' || state === 'PREVIEWING') {
        await session.pause();
      } else if (state === 'PAUSED') {
        await resumeFromPause();
      } else {
        await startNewTake();
      }
    } catch (e: any) {
      if (!isSessionState(engineStateRef.current)) releaseSessionResources();
      Alert.alert('Capture Fault', e?.message ?? 'Unknown error');
    } finally {
      isTransportBusyRef.current = false;
    }
  };

  const handleToggleReplace = async () => {
    if (!replaceEnabled) return;
    // Never flip the armed state while a punch-in/out is in flight, or the
    // pill would desync from what the engine is actually doing.
    if (isTransportBusyRef.current) return;
    const next = !replaceArmedRef.current;
    setReplaceArmed(next);
    const state = engineStateRef.current;
    // Live punch in / out while the take is running.
    const punchIn = next && state === 'PREVIEWING';
    const punchOut = !next && state === 'RECORDING' && session.overwritingRef.current;
    if (!punchIn && !punchOut) return;
    isTransportBusyRef.current = true;
    try {
      if (punchIn) {
        await startCapture(session.getPlayheadMs());
      } else {
        await session.preview(session.getPlayheadMs());
      }
    } catch (e: any) {
      Alert.alert('Capture Fault', e?.message ?? 'Unknown error');
    } finally {
      isTransportBusyRef.current = false;
    }
  };

  notificationActionRef.current = (action) => {
    // While the save dialog is open, ignore transport actions from the
    // notification so Resume cannot continue recording behind the modal.
    if (saveVisibleRef.current || pendingSaveRef.current) {
      if (action === 'stop') {
        // Already in save flow, just ensure notification is collapsed.
        StudioEngine.stopForegroundService().catch(() => {});
      }
      return;
    }
    if (action === 'stop') {
      void handleStopPressRef.current(true);
    } else if (action === 'pause') {
      session.pause().catch(() => {});
    } else if (action === 'resume') {
      if (engineStateRef.current !== 'PAUSED' || isTransportBusyRef.current) return;
      isTransportBusyRef.current = true;
      resumeFromPause()
        .catch((e: any) => showToastRef.current('Could not resume', e?.message, { variant: 'warning' }))
        .finally(() => {
          isTransportBusyRef.current = false;
        });
    }
  };

  const handleScrubStart = useCallback(() => {
    void session.pauseForScrub();
  }, [session.pauseForScrub]);

  const handleScrubEnd = useCallback(
    (positionMs: number) => {
      void session.seek(positionMs);
    },
    [session.seek]
  );

  const handleZoomCommit = useCallback((value: number) => {
    AudioSettingsStorage.setWaveformZoom(value);
  }, []);

  // ---- editing library takes -----------------------------------------------------
  const handleEditRecording = async (item: SavedRecording) => {
    if (isSessionState(engineStateRef.current) || isTransportBusyRef.current) {
      showToast('Take in progress', 'Save or discard the open take first.', { variant: 'warning' });
      return;
    }
    isTransportBusyRef.current = true;
    setBusy({ title: 'Opening take', subtitle: item.name });
    try {
      const info = await session.openSession(toNativePath(item.uri), 'edit', '');
      const delivery = deliveryForSource(item.uri, info);
      deliveryRef.current = delivery;
      StudioEngine.setBadge(delivery.badge);
      setEditContext({ recording: item });
      setReplaceArmed(false);
      writeJournal(info, item, delivery, activePresetRef.current.key);
      setSyncResetKey((k) => k + 1);
      setCurrentScreen('studio');
    } catch (e: any) {
      Alert.alert('Could not open the take', e?.message ?? 'Unknown error');
    } finally {
      setBusy(null);
      isTransportBusyRef.current = false;
    }
  };

  const handleEditRecordingRef = useRef(handleEditRecording);
  handleEditRecordingRef.current = handleEditRecording;
  const handleEditRecordingStable = useCallback((item: SavedRecording) => {
    void handleEditRecordingRef.current(item);
  }, []);

  // ---- crash recovery ------------------------------------------------------------
  const discardOrphanFiles = async (o: Orphan) => {
    try {
      const uri = o.kind === 'studio' ? `file://${o.journal.sessionPath}` : o.legacy.fileUri;
      if (uri) await FileSystem.deleteAsync(uri, { idempotent: true });
    } catch (err) {
      console.warn('[InterruptedTake] Failed to delete orphaned file:', err);
    }
    SessionJournal.clearStudioSession();
    SessionJournal.clearSession();
  };

  const handleDiscardInterruptedTake = async () => {
    const o = orphan;
    setInterruptedModalVisible(false);
    setOrphan(null);
    if (o) await discardOrphanFiles(o);
    showToast('Take Discarded', 'Interrupted recording removed', { variant: 'delete' });
  };

  const handleResumeInterruptedTake = async () => {
    const o = orphan;
    if (!o) return;
    setInterruptedModalVisible(false);
    setOrphan(null);
    setBusy({ title: 'Recovering take' });
    isTransportBusyRef.current = true;

    let info: StudioSessionInfo;
    try {
      if (o.kind === 'studio') {
        const j = o.journal;
        const editRec = j.editOf
          ? RecordingLibrary.getAll().find((r) => r.id === j.editOf?.id) ?? null
          : null;
        info = await session.openSession(j.sessionPath, 'recover', j.badge);
        const delivery = editRec
          ? deliveryForSource(editRec.uri, info)
          : presetToDelivery(AudioSettingsStorage.getResolvedPreset(j.presetKey));
        deliveryRef.current = delivery;
        StudioEngine.setBadge(delivery.badge);
        setEditContext(editRec ? { recording: editRec } : null);
        writeJournal(info, editRec, delivery, j.presetKey);
      } else {
        const l = o.legacy;
        const preset = AudioSettingsStorage.getResolvedPreset(l.formatPreset);
        const isWav = extractExtension(l.fileUri) === '.wav';
        info = await session.openSession(toNativePath(l.fileUri), isWav ? 'recover' : 'edit', preset.badge);
        if (!isWav) FileSystem.deleteAsync(l.fileUri, { idempotent: true }).catch(() => {});
        const delivery = presetToDelivery(preset);
        deliveryRef.current = delivery;
        setEditContext(null);
        SessionJournal.clearSession();
        writeJournal(info, null, delivery, preset.key);
      }
    } catch (e: any) {
      setBusy(null);
      isTransportBusyRef.current = false;
      Alert.alert('Could not recover the take', e?.message ?? 'Unknown error', [
        { text: 'Keep for later', style: 'cancel' },
        {
          text: 'Discard',
          style: 'destructive',
          onPress: () => {
            void discardOrphanFiles(o);
          },
        },
      ]);
      return;
    }

    setBusy(null);
    setReplaceArmed(false);
    setSyncResetKey((k) => k + 1);
    setCurrentScreen('studio');

    // Continue the take where it stopped, as before.
    try {
      await startCapture(-1);
      showToast('Take Resumed', `Continuing from ${formatClock(info.durationMs)}`, { variant: 'success' });
    } catch (e: any) {
      showToast('Take Recovered', `Paused at ${formatClock(info.durationMs)}. ${e?.message ?? ''}`, {
        variant: 'warning',
      });
    } finally {
      isTransportBusyRef.current = false;
    }
  };

  const interruptedInfo: InterruptedTakeInfo | null = orphan
    ? orphan.kind === 'studio'
      ? {
          durationMs:
            ((Math.max(0, orphan.sizeBytes - 44) /
              Math.max(
                1,
                orphan.journal.sampleRate * orphan.journal.channels * (orphan.journal.floatPcm ? 4 : 2)
              )) *
              1000),
          badge: orphan.journal.badge,
          editOfName: orphan.journal.editOf?.name ?? null,
        }
      : {
          durationMs:
            orphan.legacy.durationMs > 0
              ? orphan.legacy.durationMs
              : Math.max(1000, orphan.legacy.lastHeartbeatTimestamp - orphan.legacy.startedAt),
          badge: AudioSettingsStorage.getResolvedPreset(orphan.legacy.formatPreset)?.badge ?? 'WAV',
          editOfName: null,
        }
    : null;

  // ---- bootstrap ------------------------------------------------------------------
  useEffect(() => {
    return () => {
      if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function bootstrap() {
      try {
        // Only the library player uses expo-audio now; capture is native.
        await setAudioModeAsync({
          playsInSilentMode: true,
          interruptionMode: 'doNotMix',
          allowsBackgroundRecording: false,
          shouldPlayInBackground: false,
        });
      } catch (err) {
        console.warn('[App] setAudioModeAsync failed:', err);
      }

      try {
        await ensureTakesFolder();
      } catch {}

      refreshDevices();
      setRecordings(RecordingLibrary.getAll());

      try {
        // 1. A JS reload while the native session kept running: re-attach.
        const status = await StudioEngine.getStatus();
        if (cancelled) return;
        const journal = SessionJournal.getStudioSession();
        if (status?.hasSession) {
          const editRec = journal?.editOf
            ? RecordingLibrary.getAll().find((r) => r.id === journal.editOf?.id) ?? null
            : null;
          const info: StudioSessionInfo = {
            sessionId: status.sessionId ?? '',
            sessionPath: status.sessionPath ?? '',
            sampleRate: status.sampleRate ?? 48000,
            channels: status.channels ?? 1,
            floatPcm: !!status.floatPcm,
            durationMs: status.durationMs,
            dataBytes: status.dataBytes ?? 0,
            peakCount: status.peakCount ?? 0,
            peakBucketMs: status.peakBucketMs ?? 20,
          };
          deliveryRef.current = editRec
            ? deliveryForSource(editRec.uri, info)
            : presetToDelivery(
                AudioSettingsStorage.getResolvedPreset(journal?.presetKey ?? AudioSettingsStorage.getPreset())
              );
          setEditContext(editRec ? { recording: editRec } : null);
          sessionResourcesRef.current.micGranted = true;
          if (status.mode === 'recording') {
            activateHardwareRoutingRef.current();
            sessionResourcesRef.current.routing = true;
            activateKeepAwakeAsync().catch(() => {});
            sessionResourcesRef.current.keepAwake = true;
          }
          await session.reattach(status);
          if (!cancelled) setCurrentScreen('studio');
          return;
        }

        // 2. A take left behind by a process that died.
        if (journal) {
          try {
            const info = await FileSystem.getInfoAsync(`file://${journal.sessionPath}`);
            const size = info.exists && !info.isDirectory ? info.size ?? 0 : 0;
            if (size > 44) {
              setOrphan({ kind: 'studio', journal, sizeBytes: size });
              setInterruptedModalVisible(true);
            } else {
              SessionJournal.clearStudioSession();
            }
          } catch {
            SessionJournal.clearStudioSession();
          }
          return;
        }

        // 3. A take left behind by the previous (pre-studio) recorder.
        const legacy = SessionJournal.checkOrphanedSession();
        if (legacy) {
          try {
            const info = await FileSystem.getInfoAsync(legacy.fileUri);
            const size = info.exists && !info.isDirectory ? info.size ?? 0 : 0;
            if (size > 0) {
              setOrphan({ kind: 'legacy', legacy, sizeBytes: size });
              setInterruptedModalVisible(true);
            } else {
              SessionJournal.clearSession();
            }
          } catch {
            SessionJournal.clearSession();
          }
        }
      } catch (err) {
        console.error('Bootstrap error:', err);
      }
    }
    bootstrap();
    return () => {
      cancelled = true;
    };
    // Runs once; the callbacks it uses are stable or read through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- navigation / pickers --------------------------------------------------------
  const handleBackToLibrary = () => {
    if (isSessionActive) {
      setWarningModalVisible(true);
      return;
    }
    setCurrentScreen('library');
  };

  const setPresetKey = (key: string) => {
    if (isSessionState(engineStateRef.current)) return;
    setPresetKeyState(key);
    AudioSettingsStorage.setPreset(key);
  };

  const handleOpenDeviceModal = () => {
    if (isSessionActive) return;
    // Bluetooth is only needed to name a BT capsule, so it is asked for here
    // rather than at launch.
    void ensureCapturePermissions({ needsBluetooth: true });
    refreshDevices();
    setDeviceModalVisible(true);
  };

  const handleSelectDevice = (deviceId: number) => {
    selectDevice(deviceId);
    setDeviceModalVisible(false);
  };

  const getDeviceIcon = (type?: string) => {
    switch (type) {
      case 'usb_device':
      case 'usb_headset':
      case 'usb_accessory':
        return Usb;
      case 'bluetooth_sco':
      case 'bluetooth_a2dp':
        return Bluetooth;
      case 'wired_headset':
        return Headphones;
      default:
        return Mic;
    }
  };

  const DeviceIcon = getDeviceIcon(selectedDevice?.type);

  const micLabel = selectedDevice
    ? selectedDevice.name.length > 7
      ? selectedDevice.name.slice(0, 6) + '…'
      : selectedDevice.name
    : 'Mic';

  const formatLabel = editContext
    ? (extractExtension(editContext.recording.uri).replace('.', '') || 'wav').toUpperCase()
    : activePreset
    ? activePreset.key === 'share_aac_48k'
      ? 'AAC'
      : activePreset.key === 'podcast_wav_44k'
      ? '44.1k'
      : activePreset.key === 'broadcast_wav_48k'
      ? '48k'
      : activePreset.badge.split(' ')[0] || 'FORMAT'
    : 'WAV';

  const isRecordingNow = engineState === 'RECORDING';
  const waveformInteractive = engineState === 'PAUSED' || engineState === 'PREVIEWING';

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right', 'bottom']}>
      {/* H5: target SDK 36 forces edge-to-edge, so the bar is drawn over the
          app. Only the icon tint is set here; the colour comes from styles.xml. */}
      <StatusBar style="light" />

      <View style={styles.screensContainer}>
        {currentScreen === 'library' ? (
          <Animated.View
            key="screen-lib"
            entering={FadeIn.duration(240)}
            exiting={FadeOut.duration(180)}
            style={StyleSheet.absoluteFill}
          >
            <LibraryScreen
              recordings={recordings}
              onLibraryUpdate={setRecordings}
              onEditModeChange={setIsLibraryEditMode}
              onEditRecording={handleEditRecordingStable}
              onOverlayChange={setIsLibraryOverlayOpen}
            />
          </Animated.View>
        ) : (
          <Animated.View
            key="screen-std"
            entering={FadeIn.duration(240)}
            exiting={FadeOut.duration(180)}
            style={StyleSheet.absoluteFill}
          >
            <View style={[styles.contentConstraint, { maxWidth: maxContentWidth }]}>
              <View style={styles.header}>
                <TouchableOpacity
                  style={styles.headerBtn}
                  onPress={handleBackToLibrary}
                  activeOpacity={0.7}
                  hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                >
                  <ChevronLeft size={24} color="#FFFFFF" strokeWidth={2} />
                </TouchableOpacity>

                {editContext ? (
                  <View style={styles.headerTitleWrap} pointerEvents="none">
                    <Text style={styles.headerEyebrow}>EDITING</Text>
                    <Text style={styles.headerTitle} numberOfLines={1}>
                      {editContext.recording.name}
                    </Text>
                  </View>
                ) : null}

                <TouchableOpacity
                  style={styles.headerBtn}
                  onPress={() => setSettingsVisible(true)}
                  activeOpacity={0.7}
                  hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                >
                  <Sliders size={19} color="#8E8E93" />
                </TouchableOpacity>
              </View>

              <View
                style={[styles.studioBody, !prompterVisible && styles.studioBodyNoPrompter]}
              >
                {prompterVisible ? (
                  <Animated.View
                    entering={FadeIn.duration(220)}
                    exiting={FadeOut.duration(160)}
                    style={[styles.prompterFlex, { height: prompterHeight }]}
                  >
                    <TeleprompterDeck
                      engineState={engineState}
                      topInset={insets.top}
                      playheadMs={playheadMs}
                      isScrubbing={isScrubbing}
                      isRunning={isRunning}
                      syncResetKey={syncResetKey}
                    />
                  </Animated.View>
                ) : null}

                <View style={styles.cockpitRow}>
                  <View style={styles.cockpitLeft}>
                    <AudioMeter
                      telemetry={telemetry}
                      engineState={engineState}
                      height={isCompactHeight ? 112 : 140}
                    />
                  </View>

                  <View
                    style={styles.cockpitCenter}
                    onLayout={(e: LayoutChangeEvent) => setCockpitCenterY(e.nativeEvent.layout.y)}
                  >
                    <View
                      style={styles.waveformWrap}
                      onLayout={(e: LayoutChangeEvent) => {
                        const { y, height } = e.nativeEvent.layout;
                        setWaveFrame((prev) =>
                          Math.abs(prev.y - y) < 1 && Math.abs(prev.height - height) < 1
                            ? prev
                            : { y, height }
                        );
                      }}
                    >
                      <StudioWaveform
                        playheadMs={playheadMs}
                        durationMs={durationMs}
                        peaks={peaks}
                        pxPerSec={pxPerSec}
                        isScrubbing={isScrubbing}
                        isRecording={isRecording}
                        interactive={waveformInteractive}
                        height={waveformHeight}
                        onScrubStart={handleScrubStart}
                        onScrubEnd={handleScrubEnd}
                        onWidthChange={setWaveWidth}
                      />
                    </View>

                    <StudioTimer
                      playheadMs={playheadMs}
                      isTablet={isTablet}
                      compact={isCompactHeight}
                    />

                    <View style={styles.optionsHorizontalRow}>
                      <TouchableOpacity
                        style={[styles.cleanOptionBtn, isSessionActive ? styles.cleanOptionBtnDisabled : null]}
                        onPress={handleOpenDeviceModal}
                        disabled={isSessionActive}
                        activeOpacity={0.6}
                        hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}
                      >
                        <DeviceIcon
                          size={11}
                          color={selectedDevice && selectedDevice.type !== 'builtin_mic' ? '#E4E4E7' : '#8E8E93'}
                        />
                        <Text
                          style={styles.cleanOptionText}
                          numberOfLines={1}
                          maxFontSizeMultiplier={1.3}
                        >{micLabel}</Text>
                      </TouchableOpacity>

                      <TouchableOpacity
                        style={[styles.cleanOptionBtn, isSessionActive ? styles.cleanOptionBtnDisabled : null]}
                        onPress={() => setSettingsVisible(true)}
                        disabled={isSessionActive}
                        activeOpacity={0.6}
                        hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}
                      >
                        <Radio size={11} color="#A1A1AA" />
                        <Text
                          style={styles.cleanOptionText}
                          numberOfLines={1}
                          maxFontSizeMultiplier={1.3}
                        >{formatLabel}</Text>
                      </TouchableOpacity>

                      <TouchableOpacity
                        style={[
                          styles.cleanOptionBtn,
                          prompterVisible ? styles.cleanOptionBtnActive : null,
                        ]}
                        onPress={() => setShowPrompter((prev) => !prev)}
                        activeOpacity={0.6}
                        hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}
                      >
                        <AlignLeft size={11} color={prompterVisible ? '#FFFFFF' : '#8E8E93'} />
                        <Text
                          style={[
                            styles.cleanOptionText,
                            prompterVisible ? styles.cleanOptionTextActive : null,
                          ]}
                          numberOfLines={1}
                          maxFontSizeMultiplier={1.3}
                        >
                          {prompterVisible ? 'Hide' : 'Script'}
                        </Text>
                      </TouchableOpacity>

                      <TouchableOpacity
                        style={[
                          styles.cleanOptionBtn,
                          replaceArmed && replaceEnabled ? styles.cleanOptionBtnActive : null,
                          !replaceEnabled ? styles.cleanOptionBtnDisabled : null,
                        ]}
                        onPress={() => {
                          void handleToggleReplace();
                        }}
                        disabled={!replaceEnabled}
                        activeOpacity={0.6}
                        hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}
                        accessibilityRole="switch"
                        accessibilityState={{ checked: replaceArmed, disabled: !replaceEnabled }}
                        accessibilityLabel="Replace from the playhead"
                      >
                        <Replace size={11} color={replaceArmed && replaceEnabled ? '#FFFFFF' : '#8E8E93'} />
                        <Text
                          style={[
                            styles.cleanOptionText,
                            replaceArmed && replaceEnabled ? styles.cleanOptionTextActive : null,
                          ]}
                          numberOfLines={1}
                          maxFontSizeMultiplier={1.3}
                        >
                          Replace
                        </Text>
                      </TouchableOpacity>
                    </View>
                  </View>

                  <View style={styles.cockpitRight} pointerEvents="none" />

                  <View
                    style={[
                      styles.zoomDock,
                      {
                        top: cockpitCenterY + waveFrame.y + waveFrame.height / 2 - zoomHeight / 2,
                        height: zoomHeight,
                      },
                    ]}
                    pointerEvents="box-none"
                  >
                    <WaveformZoomControl
                      pxPerSec={pxPerSec}
                      viewportWidth={waveWidth}
                      height={zoomHeight}
                      onCommit={handleZoomCommit}
                    />
                  </View>
                </View>
              </View>

              <View style={{ height: transportClearance }} />
            </View>
          </Animated.View>
        )}
      </View>

      {toastData ? (
        <AppToast data={toastData} top={toastTop} wide={Boolean(toastData.detail)} />
      ) : null}

      {!transportHidden ? (
        <View style={[styles.transportChassis, { bottom: transportBottom }]} pointerEvents="box-none">
          <View style={styles.transportBezel} pointerEvents="box-none">
            <Animated.View
              style={[styles.stopBtnWrapper, stopBtnAnimatedStyle]}
              pointerEvents={isSessionActive ? 'auto' : 'none'}
            >
              <Pressable
                // Wrapped on purpose: passing the handler directly fed the
                // press event in as the `autoSave` flag, which is always truthy.
                onPress={() => {
                  void handleStopPress();
                }}
                disabled={!isSessionActive}
                style={({ pressed }) => [styles.stopOuterBtn, pressed && { opacity: 0.82, transform: [{ scale: 0.94 }] }]}
                hitSlop={10}
              >
                <View style={styles.stopInnerSquare} />
              </Pressable>
            </Animated.View>

            <Animated.View style={[styles.mainBtnWrapper, mainBtnAnimatedStyle]} pointerEvents="box-none">
              <Pressable
                onPress={() => {
                  void handleMainButtonPress();
                }}
                style={({ pressed }) => [styles.mainOuterRing, pressed && { opacity: 0.88, transform: [{ scale: 0.95 }] }]}
                hitSlop={10}
                accessibilityLabel={
                  mainIcon === 'pause'
                    ? 'Pause'
                    : mainIcon === 'play'
                    ? 'Preview from the playhead'
                    : mainIcon === 'record' && replaceArmed && isBeforeEnd
                    ? 'Replace from the playhead'
                    : 'Record'
                }
              >
                <Animated.View style={[styles.redCircle, redCircleAnimStyle]} pointerEvents="none">
                  <Animated.View style={[styles.micIconWrapper, micIconAnimStyle]}>
                    <Mic size={24} color="#FFFFFF" strokeWidth={2.4} />
                  </Animated.View>
                </Animated.View>
                <Animated.View style={[styles.pauseBarsWrapper, pauseBarsAnimStyle]} pointerEvents="none">
                  <View style={styles.pauseBar} />
                  <View style={styles.pauseBar} />
                </Animated.View>
                <Animated.View style={[styles.playIconWrapper, playIconAnimStyle]} pointerEvents="none">
                  <Play size={26} color="#FFFFFF" fill="#FFFFFF" strokeWidth={2} style={{ marginLeft: 4 }} />
                </Animated.View>
              </Pressable>
            </Animated.View>
          </View>
        </View>
      ) : null}

      <ActiveRecordingWarningModal
        visible={warningModalVisible}
        onClose={() => setWarningModalVisible(false)}
        onStopAndExit={() => {
          exitAfterSaveRef.current = true;
          void handleStopPress();
        }}
        title={isRecordingNow ? 'Recording in Progress' : 'Take in Progress'}
        description={
          isRecordingNow
            ? 'Audio capture is currently active. Please stop and finalize your take before returning to the library.'
            : 'This take is still open. Stop it to save or discard it before returning to the library.'
        }
        keepLabel={isRecordingNow ? 'KEEP RECORDING' : 'KEEP EDITING'}
      />

      <InterruptedTakeModal
        visible={interruptedModalVisible}
        info={interruptedInfo}
        sizeBytes={orphan?.sizeBytes ?? 0}
        onDiscard={handleDiscardInterruptedTake}
        onResume={handleResumeInterruptedTake}
      />

      <InputDeviceModal
        visible={deviceModalVisible}
        onClose={() => setDeviceModalVisible(false)}
        devices={devices}
        selectedDeviceId={selectedDeviceId}
        onSelectDevice={handleSelectDevice}
        engineState={engineState}
        activeDevice={activeDevice}
      />

      <AudioSettingsModal
        visible={settingsVisible}
        onClose={() => setSettingsVisible(false)}
        activePresetKey={activePreset.key}
        onSelectPreset={setPresetKey}
        engineState={engineState}
        selectedDevice={selectedDevice}
      />

      {pendingSave ? (
        <SaveRecordingModal
          visible={saveVisible}
          defaultName={pendingSave.defaultName}
          durationMs={pendingSave.durationMs}
          sizeBytes={pendingSave.sizeBytes}
          sizeIsEstimate={pendingSave.sizeIsEstimate}
          formatBadge={pendingSave.badge}
          editOfName={pendingSave.editOfName}
          onSubmit={(name, mode) => {
            void performSave(name, mode);
          }}
          onDiscard={() => {
            void handleDiscardTake();
          }}
          onKeepEditing={handleKeepEditing}
        />
      ) : null}

      <BusyOverlay
        visible={busy !== null}
        title={busy?.title ?? ''}
        subtitle={busy?.subtitle}
        progress={session.progress?.progress ?? null}
      />
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider><AudioRecorderApp /></SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000000' },
  container: { flex: 1, backgroundColor: '#000000' },
  screensContainer: { flex: 1 },
  contentConstraint: { flex: 1, width: '100%', alignSelf: 'center' },

  header: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
  },
  headerBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitleWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  headerEyebrow: {
    color: '#71717A',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1,
  },
  headerTitle: {
    color: '#E4E4E7',
    fontSize: 13,
    fontWeight: '600',
    marginTop: 1,
    maxWidth: '100%',
  },

  studioBody: {
    flex: 1,
    justifyContent: 'flex-start',
    paddingHorizontal: 8,
    paddingTop: 8,
  },
  studioBodyNoPrompter: {
    justifyContent: 'center',
  },
  prompterFlex: {
    width: '100%',
    marginBottom: 14,
  },

  cockpitRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'center',
    width: '100%',
  },
  cockpitLeft: {
    width: 44,
    alignItems: 'flex-start',
    justifyContent: 'flex-end',
    paddingBottom: 2,
  },
  cockpitCenter: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingHorizontal: 4,
  },
  cockpitRight: {
    width: 44,
  },
  zoomDock: {
    position: 'absolute',
    right: 7,
    width: 30,
    justifyContent: 'center',
    alignItems: 'center',
  },
  waveformWrap: {
    width: '100%',
  },

  optionsHorizontalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    marginTop: 12,
    maxWidth: 300,
    width: '100%',
  },
  cleanOptionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 5,
    paddingHorizontal: 6,
    borderRadius: 14,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    flexShrink: 1,
  },
  cleanOptionBtnActive: {
    backgroundColor: 'rgba(255, 255, 255, 0.14)',
  },
  cleanOptionBtnDisabled: {
    opacity: 0.35,
  },
  cleanOptionText: {
    color: '#8E8E93',
    fontSize: 10,
    fontWeight: '500',
    letterSpacing: 0.2,
    maxWidth: 52,
    flexShrink: 1,
  },
  cleanOptionTextActive: {
    color: '#FFFFFF',
    fontWeight: '600',
  },

  transportChassis: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 80,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 9999,
    elevation: 99,
  },
  transportBezel: {
    width: 220,
    height: 80,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Both buttons share one explicit slot (bezel is 220x80, button 76) so
  // their resting position never depends on layout-engine static positions.
  mainBtnWrapper: {
    position: 'absolute',
    top: 2,
    left: 72,
    width: 76,
    height: 76,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2,
  },
  stopBtnWrapper: {
    position: 'absolute',
    top: 2,
    left: 72,
    width: 76,
    height: 76,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
  },
  mainOuterRing: {
    width: 76,
    height: 76,
    borderRadius: 38,
    borderWidth: 2.5,
    borderColor: '#27272A',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#09090B',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 8,
  },
  redCircle: {
    position: 'absolute',
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#EF4444',
    alignItems: 'center',
    justifyContent: 'center',
  },
  micIconWrapper: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pauseBarsWrapper: {
    position: 'absolute',
    width: 60,
    height: 60,
    flexDirection: 'row',
    gap: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pauseBar: {
    width: 5,
    height: 22,
    borderRadius: 2.5,
    backgroundColor: '#FFFFFF',
  },
  playIconWrapper: {
    position: 'absolute',
    width: 60,
    height: 60,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stopOuterBtn: {
    width: 76,
    height: 76,
    borderRadius: 38,
    borderWidth: 1.5,
    borderColor: '#18181B',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#111113',
  },
  stopInnerSquare: {
    width: 22,
    height: 22,
    borderRadius: 4,
    backgroundColor: '#FAFAFA',
  },
});
