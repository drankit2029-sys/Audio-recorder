import 'react-native-gesture-handler';
import { useEffect, useState, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  Pressable,
  Alert,
  Platform,
  PermissionsAndroid,
  AppState,
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
  Easing,
} from 'react-native-reanimated';
import * as FileSystem from 'expo-file-system/legacy';
import { StatusBar } from 'expo-status-bar';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import {
  Sliders,
  Mic,
  ChevronLeft,
  Radio,
  AlignLeft,
  Usb,
  Bluetooth,
  Headphones,
} from 'lucide-react-native';

import { SessionJournal, ActiveSessionRecord } from './src/services/storage/sessionJournal';
import { AUDIO_PRESETS } from './src/services/audio/types';
import { ResumePoint, stripToFileUri } from './src/services/audio/recordingEngine';
import { RecordingLibrary, SavedRecording } from './src/services/storage/recordingLibrary';
import { useAudioRecording, generateResumedWaveform } from './src/services/audio/useAudioRecording';
import { StudioTimer } from './src/components/studio/StudioTimer';
import { AudioMeter } from './src/components/meter/AudioMeter';
import { LiveWaveform } from './src/components/studio/LiveWaveform';
import { TeleprompterDeck } from './src/components/prompter/TeleprompterDeck';
import { AudioSettingsModal } from './src/components/settings/AudioSettingsModal';
import { SaveRecordingModal } from './src/components/audio/SaveRecordingModal';
import { ActiveRecordingWarningModal } from './src/components/audio/ActiveRecordingWarningModal';
import { InterruptedTakeModal } from './src/components/audio/InterruptedTakeModal';
import { ForegroundServiceManager } from './src/services/audio/ForegroundServiceManager';
import { useAudioInputDevices } from './src/services/audio/useAudioInputDevices';
import { InputDeviceModal } from './src/components/audio/InputDeviceModal';
import { useResponsive } from './src/hooks/useResponsive';
import { LibraryScreen } from './src/screens/LibraryScreen';
import { setAudioModeAsync } from 'expo-audio';
import { WavRecorder } from './modules/audio-hardware-router/src';
import {
  ensureCapturePermissions,
  describeMissingPermissions,
} from './src/services/audio/permissions';
import { ensureTakesFolder, renameTakeFile } from './src/services/storage/recordingPaths';
import {
  AppToast,
  AppToastData,
  ToastVariant,
  getToastTop,
} from './src/components/common/AppToast';

type AppScreen = 'library' | 'studio';

interface PendingTake {
  uri: string;
  sizeBytes: number;
  durationMs: number;
  defaultName: string;
  formatBadge: string;
  warning?: string;
}

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

function AudioRecorderApp() {
  const [, setIsReady] = useState(false);
  const [currentScreen, setCurrentScreen] = useState<AppScreen>('library');
  const [showPrompter, setShowPrompter] = useState(true);

  const [settingsVisible, setSettingsVisible] = useState(false);
  const [deviceModalVisible, setDeviceModalVisible] = useState(false);
  const [recordings, setRecordings] = useState<SavedRecording[]>([]);
  const [isLibraryEditMode, setIsLibraryEditMode] = useState(false);

  const [pendingTake, setPendingTake] = useState<PendingTake | null>(null);
  const [nameModalVisible, setNameModalVisible] = useState(false);
  const [warningModalVisible, setWarningModalVisible] = useState(false);
  const [toastData, setToastData] = useState<AppToastData | null>(null);

  const [orphanedSession, setOrphanedSession] = useState<ActiveSessionRecord | null>(null);
  const [orphanedTakeSize, setOrphanedTakeSize] = useState(0);
  const [interruptedModalVisible, setInterruptedModalVisible] = useState(false);
  const [resumedDurationMs, setResumedDurationMs] = useState(0);

  const toastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTransportBusyRef = useRef(false);
  const isAppForegroundRef = useRef(true);

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

  const showToast = (
    title: string,
    subtitle?: string,
    opts: { variant?: ToastVariant; detail?: string } = {}
  ) => {
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    setToastData({ title, subtitle, ...opts });
    toastTimeoutRef.current = setTimeout(() => setToastData(null), 3600);
  };

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

  /**
   * C3 / watchdog: the capture pipeline can die without warning (mic unplugged,
   * a phone call stealing the input, disk full). Finalise the take instead of
   * sitting on a frozen "RECORDING" and losing everything.
   */
  const captureLostHandlerRef = useRef<(reason: string) => void>(() => {});

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

  const {
    engineState,
    engineStateRef,
    telemetry,
    getExactDurationMs,
    activePreset,
    setPresetKey,
    startRecording,
    pauseRecording,
    resumeRecording,
    stopRecording,
    resetEngine,
  } = useAudioRecording({
    // Routed through a ref: the real handler needs handleStopPress, which is
    // defined below. The hook reads the latest options on every render.
    onCaptureLost: (reason) => captureLostHandlerRef.current(reason),
  });

  const isSessionActive = engineState === 'RECORDING' || engineState === 'PAUSED';

  const slideProgress = useSharedValue(0);
  const redCircleOpacity = useSharedValue(1);
  const redCircleScale = useSharedValue(1);
  const micOpacity = useSharedValue(1);
  const pauseOpacity = useSharedValue(0);
  const pauseScale = useSharedValue(0.7);

  useEffect(() => {
    slideProgress.value = withSpring(isSessionActive ? 1 : 0, {
      damping: 24,
      stiffness: 220,
      mass: 0.8,
    });

    const cubicEase = Easing.out(Easing.cubic);
    if (engineState === 'RECORDING') {
      redCircleOpacity.value = withTiming(0, { duration: 160, easing: cubicEase });
      redCircleScale.value = withTiming(0.8, { duration: 160, easing: cubicEase });
      micOpacity.value = withTiming(0, { duration: 120, easing: cubicEase });
      pauseOpacity.value = withTiming(1, { duration: 200, easing: cubicEase });
      pauseScale.value = withTiming(1, { duration: 200, easing: cubicEase });
    } else if (engineState === 'PAUSED') {
      redCircleOpacity.value = withTiming(1, { duration: 180, easing: cubicEase });
      redCircleScale.value = withTiming(1, { duration: 180, easing: cubicEase });
      micOpacity.value = withTiming(0, { duration: 120, easing: cubicEase });
      pauseOpacity.value = withTiming(0, { duration: 140, easing: cubicEase });
      pauseScale.value = withTiming(0.7, { duration: 140, easing: cubicEase });
    } else {
      redCircleOpacity.value = withTiming(1, { duration: 180, easing: cubicEase });
      redCircleScale.value = withTiming(1, { duration: 180, easing: cubicEase });
      micOpacity.value = withTiming(1, { duration: 160, easing: cubicEase });
      pauseOpacity.value = withTiming(0, { duration: 140, easing: cubicEase });
      pauseScale.value = withTiming(0.7, { duration: 140, easing: cubicEase });
    }
  }, [isSessionActive, engineState, slideProgress, redCircleOpacity, redCircleScale, micOpacity, pauseOpacity, pauseScale]);

  const mainBtnAnimatedStyle = useAnimatedStyle(() => ({ transform: [{ translateX: -46 * slideProgress.value }] }));
  const stopBtnAnimatedStyle = useAnimatedStyle(() => ({
    opacity: slideProgress.value,
    transform: [{ translateX: 46 * slideProgress.value }, { scale: 0.5 + 0.5 * slideProgress.value }],
  }));
  const redCircleAnimStyle = useAnimatedStyle(() => ({ opacity: redCircleOpacity.value, transform: [{ scale: redCircleScale.value }] }));
  const micIconAnimStyle = useAnimatedStyle(() => ({ opacity: micOpacity.value }));
  const pauseBarsAnimStyle = useAnimatedStyle(() => ({ opacity: pauseOpacity.value, transform: [{ scale: pauseScale.value }] }));

  const pauseRecordingRef = useRef(pauseRecording);
  pauseRecordingRef.current = pauseRecording;
  const resumeRecordingRef = useRef(resumeRecording);
  resumeRecordingRef.current = resumeRecording;
  const activateHardwareRoutingRef = useRef(activateHardwareRouting);
  activateHardwareRoutingRef.current = activateHardwareRouting;
  const releaseHardwareRoutingRef = useRef(releaseHardwareRouting);
  releaseHardwareRoutingRef.current = releaseHardwareRouting;

  const togglePrompter = () => {
    setShowPrompter((prev) => !prev);
  };

  const commitTakeToLibrary = (
    uri: string,
    sizeBytes: number,
    durationMs: number,
    name: string,
    warning?: string
  ) => {
    const record: SavedRecording = {
      id: `take_${Date.now()}`,
      name,
      uri,
      sizeBytes,
      durationMs,
      createdAt: Date.now(),
    };

    setRecordings(RecordingLibrary.save(record));
    showToast('Take Saved', `${record.name} • ${formatBytes(sizeBytes)}`, {
      variant: warning ? 'warning' : 'success',
      detail: warning,
    });

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

  const handleStopPress = async (autoSave = false) => {
    if (isTransportBusyRef.current) return;
    isTransportBusyRef.current = true;

    try {
      const finalDuration = getExactDurationMs();
      await deactivateKeepAwake();

      const result = await stopRecording();
      releaseHardwareRoutingRef.current();
      await resetEngine();
      setResumedDurationMs(0);

      await ForegroundServiceManager.stopService();

      if (!result.uri) {
        showToast(
          'Nothing Captured',
          result.degradationNote ?? 'The engine produced no output file.',
          { variant: 'warning', detail: result.degradationNote }
        );
        return;
      }

      const outputUri = result.uri;

      let sizeBytes = result.sizeBytes;
      if (!sizeBytes || sizeBytes <= 0) {
        try {
          const info = await FileSystem.getInfoAsync(outputUri);
          if (info.exists && !info.isDirectory) sizeBytes = info.size ?? 0;
        } catch {}
      }

      const now = new Date();
      const defaultName = `Take ${now.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })}`;
      const durationMs = result.durationMs > 0 ? result.durationMs : finalDuration;

      const shouldPrompt = !autoSave || isAppForegroundRef.current;

      if (shouldPrompt) {
        setPendingTake({
          uri: outputUri,
          sizeBytes,
          durationMs,
          defaultName,
          formatBadge: activePreset.badge,
          warning: result.degradationNote,
        });
        setNameModalVisible(true);
      } else {
        commitTakeToLibrary(
          outputUri,
          sizeBytes,
          durationMs,
          defaultName,
          result.degradationNote
        );
      }
    } catch (e: any) {
      await deactivateKeepAwake();
      await ForegroundServiceManager.stopService();
      releaseHardwareRoutingRef.current();
      await resetEngine();
      setResumedDurationMs(0);
      Alert.alert('Stop Error', e?.message ?? 'Unknown error');
    } finally {
      isTransportBusyRef.current = false;
    }
  };

  const handleStopPressRef = useRef(handleStopPress);
  handleStopPressRef.current = handleStopPress;

  captureLostHandlerRef.current = (reason: string) => {
    showToast('Capture Stopped', reason, { variant: 'warning', detail: reason });
    if (engineStateRef.current === 'RECORDING' || engineStateRef.current === 'PAUSED') {
      void handleStopPressRef.current(true);
    }
  };

  const handleFinalizeTake = (chosenName: string) => {
    if (!pendingTake) return;
    const take = pendingTake;
    const finalName =
      chosenName.trim().length > 0 ? chosenName.trim() : take.defaultName;

    setNameModalVisible(false);
    setPendingTake(null);

    commitTakeToLibrary(
      take.uri,
      take.sizeBytes,
      take.durationMs,
      finalName,
      take.warning
    );
  };

  const handleDiscardTake = async () => {
    const uri = pendingTake?.uri;
    if (uri) {
      try {
        await FileSystem.deleteAsync(uri, { idempotent: true });
      } catch (err) {
        console.warn('[App] Failed to discard take:', err);
      }
    }
    setNameModalVisible(false);
    setPendingTake(null);
    showToast('Take Discarded', 'Audio file deleted from this device', {
      variant: 'delete',
    });
  };

  const handleDiscardInterruptedTake = async () => {
    if (orphanedSession?.fileUri) {
      try {
        await FileSystem.deleteAsync(orphanedSession.fileUri, { idempotent: true });
      } catch (err) {
        console.warn('[InterruptedTake] Failed to delete orphaned file:', err);
      }
    }

    SessionJournal.clearSession();
    setInterruptedModalVisible(false);
    setOrphanedSession(null);
    setResumedDurationMs(0);
    showToast('Take Discarded', 'Interrupted recording removed', {
      variant: 'delete',
    });
  };

  const handleResumeInterruptedTake = async () => {
    if (!orphanedSession) return;

    // M9: `byteOffsetEstimate` actually held a duration. The field is now
    // called `durationMs`, and the journal carries the real byte count that
    // the recovery path needs to rebuild the RIFF header.
    const durationMs =
      orphanedSession.durationMs > 0
        ? orphanedSession.durationMs
        : Math.max(1000, orphanedSession.lastHeartbeatTimestamp - orphanedSession.startedAt);

    const oldFileUri = orphanedSession.fileUri;
    const targetPresetKey = orphanedSession.formatPreset;
    const targetPreset = AUDIO_PRESETS[targetPresetKey] ?? activePreset;
    const frameSize =
      targetPreset.sampleRate > 0
        ? targetPreset.channels * (targetPreset.bitDepth === 32 ? 4 : 2)
        : 2;

    const restoredWaveform =
      orphanedSession.waveformSnapshot && orphanedSession.waveformSnapshot.length > 0
        ? orphanedSession.waveformSnapshot
        : generateResumedWaveform();

    setResumedDurationMs(durationMs);
    setInterruptedModalVisible(false);
    setOrphanedSession(null);
    setCurrentScreen('studio');

    if (targetPresetKey && targetPresetKey !== activePreset.key) {
      try {
        setPresetKey(targetPresetKey);
      } catch {}
    }

    try {
      isTransportBusyRef.current = true;

      const gate = await ensureCapturePermissions({
        blockOnNotifications: activePreset.engine === 'mediarecorder',
      });
      if (!gate.granted) {
        Alert.alert('Permission needed', describeMissingPermissions(gate.missing, gate.canAskAgain));
        return;
      }

      activateHardwareRoutingRef.current();
      await activateKeepAwakeAsync();

      // Only the WAV engine keeps its own foreground service; expo-audio
      // starts one itself, and two services meant two notifications. (H2)
      if (activePreset.engine === 'audiorecord') {
        await ForegroundServiceManager.startService(activePreset.badge);
      }

      // Continue the recovered take instead of throwing its audio away.
      // Only safe when the preset the engine will actually run matches the one
      // the orphan was recorded with: `setPresetKey` above only takes effect on
      // the next render, so appending with a different sample rate or bit depth
      // would splice incompatible PCM onto the end of the old file.
      let resumePoint: ResumePoint | undefined;
      const presetMatchesOrphan = !targetPresetKey || targetPresetKey === activePreset.key;
      if (activePreset.engine === 'audiorecord' && presetMatchesOrphan && oldFileUri) {
        const path = stripToFileUri(oldFileUri);
        if (path) {
          const repaired = await WavRecorder.repair(
            path,
            orphanedSession.dataBytes > 0
              ? orphanedSession.dataBytes
              : // No byte count in the journal (older build): derive it from the
                // duration the journal did record.
                Math.max(
                  0,
                  Math.floor((durationMs / 1000) * targetPreset.sampleRate) * frameSize
                ),
            frameSize
          );
          if (repaired.ok && repaired.dataBytes > 0) {
            resumePoint = { dataBytes: repaired.dataBytes, durationMs };
          }
        }
      }

      await startRecording(
        durationMs,
        restoredWaveform,
        `Take Resumed`,
        selectedDeviceId ?? -1,
        resumePoint
      );

      // The old file only disappears once it has really been continued. If the
      // append could not be honoured, the engine started a fresh take, so the
      // orphan is deleted to avoid leaving a stray silent file behind.
      if (oldFileUri && !resumePoint) {
        try {
          await FileSystem.deleteAsync(oldFileUri, { idempotent: true });
        } catch {}
      }

      const mins = Math.floor(durationMs / 60000);
      const secs = Math.floor((durationMs % 60000) / 1000);
      const timeFormatted = `${mins.toString().padStart(2, '0')}:${secs
        .toString()
        .padStart(2, '0')}`;

      showToast('Take Resumed', `Continuing from ${timeFormatted}`, {
        variant: resumePoint ? 'success' : 'warning',
        detail: resumePoint
          ? undefined
          : 'The recovered audio could not be appended, so this take starts a new file (the clock still resumes at the recorded time).',
      });
    } catch (e: any) {
      await deactivateKeepAwake();
      await ForegroundServiceManager.stopService();
      releaseHardwareRoutingRef.current();
      setResumedDurationMs(0);
      Alert.alert('Capture Fault', `Could not resume take: ${e.message}`, [
        {
          text: 'OK',
          onPress: async () => {
            await resetEngine();
            setCurrentScreen('studio');
          },
        },
      ]);
    } finally {
      isTransportBusyRef.current = false;
    }
  };

  useEffect(() => {
    return () => {
      if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    ForegroundServiceManager.registerHandlers({
      onPause: async () => { try { await pauseRecordingRef.current(); } catch {} },
      onResume: async () => { try { await resumeRecordingRef.current(); } catch {} },
      onStop: async () => { try { await handleStopPressRef.current(true); } catch {} },
    });
  }, []);

  useEffect(() => {
    async function bootstrap() {
      try {
        await ForegroundServiceManager.initialize();

        // M10: nothing is requested here any more. The old bootstrap fired the
        // microphone, notification and Bluetooth dialogs back to back on the
        // very first launch, before the user had asked for anything, and a
        // denial was never explained or re-requested. Permissions are now
        // requested by ensureCapturePermissions() the moment they are needed.
        await setAudioModeAsync({
          playsInSilentMode: true,
          interruptionMode: 'doNotMix',
          allowsBackgroundRecording: true,
          shouldPlayInBackground: false,
        });

        await ensureTakesFolder();

        refreshDevices();
        setRecordings(RecordingLibrary.getAll());

        const orphaned = SessionJournal.checkOrphanedSession();
        if (orphaned) {
          try {
            const fileInfo = await FileSystem.getInfoAsync(orphaned.fileUri);
            if (fileInfo.exists && !fileInfo.isDirectory && (fileInfo.size ?? 0) > 0) {
              setOrphanedSession(orphaned);
              setOrphanedTakeSize(fileInfo.size ?? 0);
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
      } finally {
        setIsReady(true);
      }
    }
    bootstrap();
  }, [refreshDevices]);

  const handleMainButtonPress = async () => {
    if (currentScreen === 'library') {
      setCurrentScreen('studio');
      return;
    }

    if (isTransportBusyRef.current) return;
    const currentState = engineStateRef.current;

    try {
      if (currentState === 'RECORDING') {
        pauseRecording();
      } else if (currentState === 'PAUSED') {
        resumeRecording();
      } else {
        isTransportBusyRef.current = true;

        // M10: ask right before the first capture, and explain a denial.
        const gate = await ensureCapturePermissions({
          blockOnNotifications: activePreset.engine === 'mediarecorder',
        });
        if (!gate.granted) {
          Alert.alert(
            'Permission needed',
            describeMissingPermissions(gate.missing, gate.canAskAgain)
          );
          return;
        }

        setResumedDurationMs(0);
        activateHardwareRoutingRef.current();
        activateKeepAwakeAsync();

        // H2: expo-audio starts its own foreground service as soon as a
        // MediaRecorder recorder is prepared (allowsBackgroundRecording: true),
        // so running Notifee's service as well produced two permanent
        // notifications. Each engine now owns exactly one.
        if (activePreset.engine === 'audiorecord') {
          await ForegroundServiceManager.startService(activePreset.badge);
        }
        const stamp = new Date().toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        });
        // The engine only logs prepare-time substitutions (the format selector
        // already blocks those presets), so there is no note to surface here.
        await startRecording(0, undefined, `Take ${stamp}`, selectedDeviceId ?? -1);
      }
    } catch (e: any) {
      deactivateKeepAwake();
      await ForegroundServiceManager.stopService();
      releaseHardwareRoutingRef.current();
      setResumedDurationMs(0);
      Alert.alert('Capture Fault', e.message, [
        {
          text: 'OK',
          onPress: async () => {
            await resetEngine();
            setCurrentScreen('studio');
          },
        },
      ]);
    } finally {
      isTransportBusyRef.current = false;
    }
  };

  const handleBackToLibrary = () => {
    if (isSessionActive) {
      setWarningModalVisible(true);
      return;
    }
    setCurrentScreen('library');
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

  const formatLabel = activePreset
    ? activePreset.key === 'share_aac_48k'
      ? 'AAC'
      : activePreset.key === 'podcast_wav_44k'
      ? '44.1k'
      : activePreset.key === 'broadcast_wav_48k'
      ? '48k'
      : activePreset.badge.split(' ')[0] || 'FORMAT'
    : 'WAV';

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
                      initialDurationMs={resumedDurationMs}
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

                  <View style={styles.cockpitCenter}>
                    <LiveWaveform telemetry={telemetry} engineState={engineState} height={waveformHeight} />
                    <StudioTimer
                      telemetry={telemetry}
                      engineState={engineState}
                      isTablet={isTablet}
                      compact={isCompactHeight}
                    />

                    <View style={styles.optionsHorizontalRow}>
                      <TouchableOpacity
                        style={[styles.cleanOptionBtn, isSessionActive ? styles.cleanOptionBtnDisabled : null]}
                        onPress={handleOpenDeviceModal}
                        disabled={isSessionActive}
                        activeOpacity={0.6}
                        hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
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
                        hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
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
                        onPress={togglePrompter}
                        activeOpacity={0.6}
                        hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
                      >
                        <AlignLeft size={11} color={prompterVisible ? '#FFFFFF' : '#8E8E93'} />
                        <Text
                          style={[
                            styles.cleanOptionText,
                            prompterVisible ? styles.cleanOptionTextActive : null,
                          ]}
                          maxFontSizeMultiplier={1.3}
                        >
                          {prompterVisible ? 'Hide' : 'Script'}
                        </Text>
                      </TouchableOpacity>
                    </View>
                  </View>

                  <View style={styles.cockpitRight} pointerEvents="none" />
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

      {!isLibraryEditMode ? (
        <View style={[styles.transportChassis, { bottom: transportBottom }]} pointerEvents="box-none">
          <View style={styles.transportBezel} pointerEvents="box-none">
            <Animated.View
              style={[styles.stopBtnWrapper, stopBtnAnimatedStyle]}
              pointerEvents={isSessionActive ? 'auto' : 'none'}
            >
              <Pressable
                // Wrapped on purpose: passing the handler directly fed the
                // press event in as the `autoSave` flag, which is always truthy.
                onPress={() => handleStopPress()}
                disabled={!isSessionActive}
                style={({ pressed }) => [styles.stopOuterBtn, pressed && { opacity: 0.82, transform: [{ scale: 0.94 }] }]}
                hitSlop={10}
              >
                <View style={styles.stopInnerSquare} />
              </Pressable>
            </Animated.View>

            <Animated.View style={[styles.mainBtnWrapper, mainBtnAnimatedStyle]} pointerEvents="box-none">
              <Pressable
                onPress={handleMainButtonPress}
                style={({ pressed }) => [styles.mainOuterRing, pressed && { opacity: 0.88, transform: [{ scale: 0.95 }] }]}
                hitSlop={10}
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
              </Pressable>
            </Animated.View>
          </View>
        </View>
      ) : null}

      <ActiveRecordingWarningModal
        visible={warningModalVisible}
        onClose={() => setWarningModalVisible(false)}
        onStopAndExit={() => {
          void handleStopPress();
        }}
      />

      <InterruptedTakeModal
        visible={interruptedModalVisible}
        session={orphanedSession}
        sizeBytes={orphanedTakeSize}
        onDiscard={handleDiscardInterruptedTake}
        onResume={handleResumeInterruptedTake}
      />

      {pendingTake ? (
        <SaveRecordingModal
          visible={nameModalVisible}
          defaultName={pendingTake.defaultName}
          durationMs={pendingTake.durationMs}
          sizeBytes={pendingTake.sizeBytes}
          formatBadge={pendingTake.formatBadge}
          warning={pendingTake.warning}
          onSubmit={handleFinalizeTake}
          onDiscard={handleDiscardTake}
        />
      ) : null}

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

  optionsHorizontalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: 12,
    maxWidth: 200,
    width: '100%',
  },
  cleanOptionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 5,
    paddingHorizontal: 7,
    borderRadius: 14,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
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
    maxWidth: 56,
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
  mainBtnWrapper: {
    position: 'absolute',
    width: 76,
    height: 76,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2,
  },
  stopBtnWrapper: {
    position: 'absolute',
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
