// App.tsx
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
  LayoutAnimation,
  AppState,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { GestureHandlerRootView, ScrollView } from 'react-native-gesture-handler';
import Animated, {
  FadeIn,
  FadeOut,
  FadeInDown,
  FadeOutUp,
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withSpring,
  Easing,
} from 'react-native-reanimated';
import { AudioModule } from 'expo-audio';
import * as FileSystem from 'expo-file-system/legacy';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import {
  Sliders,
  Mic,
  ChevronLeft,
  Check,
  Radio,
  AlignLeft,
  Usb,
  Bluetooth,
  Headphones,
} from 'lucide-react-native';

import { SessionJournal, ActiveSessionRecord } from './src/services/storage/sessionJournal';
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
import { requestRecordingPermissionsAsync, setAudioModeAsync } from 'expo-audio';
import { ensureTakesFolder, renameTakeFile } from './src/services/storage/recordingPaths';

type AppScreen = 'library' | 'studio';

interface PendingTake {
  uri: string;
  sizeBytes: number;
  durationMs: number;
  defaultName: string;
  formatBadge: string;
  warning?: string;
}

interface ToastData {
  title: string;
  subtitle: string;
}

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
  const [toastData, setToastData] = useState<ToastData | null>(null);

  const [orphanedSession, setOrphanedSession] = useState<ActiveSessionRecord | null>(null);
  const [orphanedTakeSize, setOrphanedTakeSize] = useState(0);
  const [interruptedModalVisible, setInterruptedModalVisible] = useState(false);
  const [resumedDurationMs, setResumedDurationMs] = useState(0);

  const toastTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isTransportBusyRef = useRef(false);

  const { isTablet, maxContentWidth, prompterHeight, insets } = useResponsive();
  const showToast = (
      title: string,
      subtitle: string,
      opts: { warning?: string; isDelete?: boolean } = {}
    ) => {
      if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
      setToastData({ title, subtitle, ...opts });
      toastTimeoutRef.current = setTimeout(() => setToastData(null), 3200);
    };
  const formatBytes = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(1)} KB`
    : `${(bytes / (1024 * 1024)).toFixed(2)} MB`;



const transportBottom = insets.bottom + 24;
  const {
    devices,
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
  } = useAudioRecording();

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
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setShowPrompter((prev) => !prev);
  };

  // In App.tsx

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

    if (result.uri) {
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
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      })}`;

      const durationMs = result.durationMs > 0 ? result.durationMs : finalDuration;
      const shouldPrompt = !autoSave || AppState.currentState === 'active';

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
        const record: SavedRecording = {
          id: `take_${Date.now()}`,
          name: defaultName,
          uri: outputUri,
          sizeBytes,
          durationMs,
          createdAt: Date.now(),
        };
        setRecordings(RecordingLibrary.save(record));
        showToast('Take Saved', `${record.name} • ${formatBytes(sizeBytes)}`, {
          warning: result.degradationNote,
        });
      }
    } else if (result.degradationNote) {
      showToast('Take Ended', result.degradationNote, { warning: result.degradationNote });
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

  const handleFinalizeTake = (chosenName: string) => {
  if (!pendingTake) return;
  const take = pendingTake;
  const finalName = chosenName.trim().length > 0 ? chosenName.trim() : take.defaultName;

  setNameModalVisible(false);
  setPendingTake(null);

  const record: SavedRecording = {
    id: `take_${Date.now()}`,
    name: finalName,
    uri: take.uri,
    sizeBytes: take.sizeBytes,
    durationMs: take.durationMs,
    createdAt: Date.now(),
  };

  setRecordings(RecordingLibrary.save(record));
  showToast('Take Saved', `${record.name} • ${formatBytes(take.sizeBytes)}`, {
    warning: take.warning,
  });

  void (async () => {
    try {
      const renamed = await renameTakeFile(take.uri, finalName);
      if (renamed && renamed !== take.uri) {
        setRecordings(RecordingLibrary.updateUri(record.id, renamed));
      }
    } catch (err) {
      console.warn('[App] Could not rename take on disk:', err);
    }
  })();
};

  const handleDiscardTake = async () => {
    if (pendingTake?.uri) {
      try { await FileSystem.deleteAsync(pendingTake.uri, { idempotent: true }); } catch {}
    }
    setNameModalVisible(false);
    setPendingTake(null);
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

    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    setToastData({ title: 'Take Discarded', subtitle: 'Interrupted recording removed' });
    toastTimeoutRef.current = setTimeout(() => setToastData(null), 3000);
  };

  const handleResumeInterruptedTake = async () => {
    if (!orphanedSession) return;

    const durationMs =
      orphanedSession.byteOffsetEstimate > 0
        ? orphanedSession.byteOffsetEstimate
        : Math.max(1000, orphanedSession.lastHeartbeatTimestamp - orphanedSession.startedAt);

    const oldFileUri = orphanedSession.fileUri;
    const targetPresetKey = orphanedSession.formatPreset;

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
      activateHardwareRoutingRef.current();
      await activateKeepAwakeAsync();

      await ForegroundServiceManager.startService(activePreset.badge);
      await startRecording(durationMs, restoredWaveform, `Take Resumed`, selectedDeviceId ?? -1);
      if (oldFileUri) {
        try {
          await FileSystem.deleteAsync(oldFileUri, { idempotent: true });
        } catch {}
      }

      if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
      const mins = Math.floor(durationMs / 60000);
      const secs = Math.floor((durationMs % 60000) / 1000);
      const timeFormatted = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;

      setToastData({
        title: 'Take Resumed',
        subtitle: `Resumed take from ${timeFormatted}`,
      });
      toastTimeoutRef.current = setTimeout(() => setToastData(null), 3500);
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
    return () => { if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current); };
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

        const { granted } = await requestRecordingPermissionsAsync();
        if (!granted) {
          console.warn('[bootstrap] Microphone permission was denied.');
        }

        if (Platform.Version >= 31) {
          await PermissionsAndroid.request(
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT
          );
        }
        if (Platform.Version >= 33) {
          await PermissionsAndroid.request(
            PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS
          );
        }

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
        setResumedDurationMs(0);
        activateHardwareRoutingRef.current();
        activateKeepAwakeAsync();

        await ForegroundServiceManager.startService(activePreset.badge);
        const stamp = new Date().toLocaleTimeString([], {
            hour: '2-digit', minute: '2-digit', second: '2-digit',
          });
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
      <View style={styles.screensContainer}>
        {currentScreen === 'library' ? (
          <Animated.View key="screen-lib" entering={FadeIn.duration(240)} exiting={FadeOut.duration(180)} style={StyleSheet.absoluteFill}>
            <LibraryScreen recordings={recordings} onLibraryUpdate={setRecordings} onEditModeChange={setIsLibraryEditMode} />
          </Animated.View>
        ) : (
          <Animated.View key="screen-std" entering={FadeIn.duration(240)} exiting={FadeOut.duration(180)} style={StyleSheet.absoluteFill}>
            <View style={[styles.contentConstraint, { maxWidth: maxContentWidth }]}>
              <View style={styles.header}>
                <TouchableOpacity style={styles.headerBtn} onPress={handleBackToLibrary} activeOpacity={0.7} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                  <ChevronLeft size={24} color="#FFFFFF" strokeWidth={2} />
                </TouchableOpacity>

                <TouchableOpacity style={styles.headerBtn} onPress={() => setSettingsVisible(true)} activeOpacity={0.7} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                  <Sliders size={19} color="#8E8E93" />
                </TouchableOpacity>
              </View>

              <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false} bounces={false}>
                {showPrompter ? (
                  <View style={styles.prompterWrapper}>
                    <TeleprompterDeck
                      engineState={engineState}
                      customHeight={prompterHeight}
                      initialDurationMs={resumedDurationMs}
                    />
                  </View>
                ) : null}

                <View style={styles.cockpitRow}>
                  <View style={styles.cockpitLeft}>
                    <AudioMeter telemetry={telemetry} engineState={engineState} />
                  </View>

                  <View style={styles.cockpitCenter}>
                    <LiveWaveform telemetry={telemetry} engineState={engineState} height={54} />
                    <StudioTimer telemetry={telemetry} engineState={engineState} isTablet={isTablet} />

                    <View style={styles.optionsHorizontalRow}>
                      <TouchableOpacity
                        style={[styles.cleanOptionBtn, isSessionActive ? styles.cleanOptionBtnDisabled : null]}
                        onPress={handleOpenDeviceModal}
                        disabled={isSessionActive}
                        activeOpacity={0.6}
                      >
                        <DeviceIcon size={11} color={selectedDevice && selectedDevice.type !== 'builtin_mic' ? '#60A5FA' : '#8E8E93'} />
                        <Text style={styles.cleanOptionText} numberOfLines={1}>{micLabel}</Text>
                      </TouchableOpacity>

                      <TouchableOpacity
                        style={[styles.cleanOptionBtn, isSessionActive ? styles.cleanOptionBtnDisabled : null]}
                        onPress={() => setSettingsVisible(true)}
                        disabled={isSessionActive}
                        activeOpacity={0.6}
                      >
                        <Radio size={11} color="#34D399" />
                        <Text style={styles.cleanOptionText} numberOfLines={1}>{formatLabel}</Text>
                      </TouchableOpacity>

                      <TouchableOpacity
                        style={[styles.cleanOptionBtn, showPrompter ? styles.cleanOptionBtnActive : null]}
                        onPress={togglePrompter}
                        activeOpacity={0.6}
                      >
                        <AlignLeft size={11} color={showPrompter ? '#FFFFFF' : '#8E8E93'} />
                        <Text style={[styles.cleanOptionText, showPrompter ? styles.cleanOptionTextActive : null]}>{showPrompter ? 'Hide' : 'Script'}</Text>
                      </TouchableOpacity>
                    </View>
                  </View>

                  <View style={styles.cockpitRight} pointerEvents="none" />
                </View>
              </ScrollView>
            </View>
          </Animated.View>
        )}
      </View>

      {toastData ? (
        <View style={[styles.toastOverlay, { top: Math.max(insets.top + 10, 26) }]} pointerEvents="box-none">
          <Animated.View entering={FadeInDown.duration(240).easing(Easing.out(Easing.cubic))} exiting={FadeOutUp.duration(180).easing(Easing.in(Easing.cubic))} style={styles.toastCard}>
            <View style={styles.toastIconCircle}><Check size={14} color="#000000" strokeWidth={3} /></View>
            <View style={styles.toastTextCol}>
              <Text style={styles.toastTitle}>{toastData.title}</Text>
              <Text style={styles.toastSubtitle} numberOfLines={1}>{toastData.subtitle}</Text>
            </View>
          </Animated.View>
        </View>
      ) : null}

      {!isLibraryEditMode ? (
        <View style={[styles.transportChassis, { bottom: transportBottom }]} pointerEvents="box-none">
          <View style={styles.transportBezel} pointerEvents="box-none">
            <Animated.View style={[styles.stopBtnWrapper, stopBtnAnimatedStyle]} pointerEvents={isSessionActive ? 'auto' : 'none'}>
              <Pressable onPress={handleStopPress} disabled={!isSessionActive} style={({ pressed }) => [styles.stopOuterBtn, pressed && { opacity: 0.82, transform: [{ scale: 0.94 }] }]} hitSlop={10}>
                <View style={styles.stopInnerSquare} />
              </Pressable>
            </Animated.View>

            <Animated.View style={[styles.mainBtnWrapper, mainBtnAnimatedStyle]} pointerEvents="box-none">
              <Pressable onPress={handleMainButtonPress} style={({ pressed }) => [styles.mainOuterRing, pressed && { opacity: 0.88, transform: [{ scale: 0.95 }] }]} hitSlop={10}>
                <Animated.View style={[styles.redCircle, redCircleAnimStyle]} pointerEvents="none">
                  <Animated.View style={[styles.micIconWrapper, micIconAnimStyle]}><Mic size={24} color="#FFFFFF" strokeWidth={2.4} /></Animated.View>
                </Animated.View>
                <Animated.View style={[styles.pauseBarsWrapper, pauseBarsAnimStyle]} pointerEvents="none">
                  <View style={styles.pauseBar} /><View style={styles.pauseBar} />
                </Animated.View>
              </Pressable>
            </Animated.View>
          </View>
        </View>
      ) : null}

      <ActiveRecordingWarningModal visible={warningModalVisible} onClose={() => setWarningModalVisible(false)} onStopAndExit={handleStopPress} />

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

  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: 8,
    paddingTop: 8,
    paddingBottom: 170,
  },

  prompterWrapper: {
    width: '100%',
    marginBottom: 16,
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

  toastOverlay: {
    position: 'absolute',
    top: 20,
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