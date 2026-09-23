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
  ScrollView,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
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
import { Sliders, Mic, ChevronLeft, Check } from 'lucide-react-native';

import { SessionJournal } from './src/services/storage/sessionJournal';
import { RecordingLibrary, SavedRecording } from './src/services/storage/recordingLibrary';
import { useAudioRecording, EngineState } from './src/services/audio/useAudioRecording';
import { AudioMeter } from './src/components/meter/AudioMeter';
import { TeleprompterDeck } from './src/components/prompter/TeleprompterDeck';
import { AudioSettingsModal } from './src/components/settings/AudioSettingsModal';
import { SaveRecordingModal } from './src/components/audio/SaveRecordingModal';
import { ActiveRecordingWarningModal } from './src/components/audio/ActiveRecordingWarningModal';
import { ForegroundServiceManager } from './src/services/audio/ForegroundServiceManager';
import { useAudioInputDevices } from './src/services/audio/useAudioInputDevices';
import { InputDeviceModal } from './src/components/audio/InputDeviceModal';
import { useResponsive } from './src/hooks/useResponsive';
import { LibraryScreen } from './src/screens/LibraryScreen';

type AppScreen = 'library' | 'studio';

interface PendingTake {
  uri: string;
  sizeBytes: number;
  durationMs: number;
  defaultName: string;
  formatBadge: string;
}

interface ToastData {
  title: string;
  subtitle: string;
}

function AudioRecorderApp() {
  const [isReady, setIsReady] = useState(false);
  const [currentScreen, setCurrentScreen] = useState<AppScreen>('library');
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [deviceModalVisible, setDeviceModalVisible] = useState(false);
  const [recordings, setRecordings] = useState<SavedRecording[]>([]);
  const [isLibraryEditMode, setIsLibraryEditMode] = useState(false);

  // Take Naming & Toast State
  const [pendingTake, setPendingTake] = useState<PendingTake | null>(null);
  const [nameModalVisible, setNameModalVisible] = useState(false);
  const [warningModalVisible, setWarningModalVisible] = useState(false);
  const [toastData, setToastData] = useState<ToastData | null>(null);

  const toastTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isActionLockedRef = useRef(false);

  const { isTablet, isLandscape, maxContentWidth, prompterHeight } = useResponsive();

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
    durationMs,
    meteringDb,
    activePreset,
    setPresetKey,
    startRecording,
    pauseRecording,
    resumeRecording,
    stopRecording,
    resetEngine,
  } = useAudioRecording();

  const isStudio = currentScreen === 'studio';
  const isRecording = engineState === 'RECORDING';
  const isSessionActive = engineState === 'RECORDING' || engineState === 'PAUSED';

  const slideProgress = useSharedValue(0);
  const redCircleOpacity = useSharedValue(1);
  const redCircleScale = useSharedValue(1);
  const micOpacity = useSharedValue(1);
  const pauseOpacity = useSharedValue(0);
  const pauseScale = useSharedValue(0.7);

  // Animate transport layout based on active take session
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
      // STOPPED / STANDBY: Red punch-in circle with mic glyph
      redCircleOpacity.value = withTiming(1, { duration: 180, easing: cubicEase });
      redCircleScale.value = withTiming(1, { duration: 180, easing: cubicEase });
      micOpacity.value = withTiming(1, { duration: 160, easing: cubicEase });
      pauseOpacity.value = withTiming(0, { duration: 140, easing: cubicEase });
      pauseScale.value = withTiming(0.7, { duration: 140, easing: cubicEase });
    }
  }, [
    isSessionActive,
    engineState,
    slideProgress,
    redCircleOpacity,
    redCircleScale,
    micOpacity,
    pauseOpacity,
    pauseScale,
  ]);

  const mainBtnAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -44 * slideProgress.value }],
  }));

  const stopBtnAnimatedStyle = useAnimatedStyle(() => ({
    opacity: slideProgress.value,
    transform: [
      { translateX: 44 * slideProgress.value },
      { scale: 0.5 + 0.5 * slideProgress.value },
    ],
  }));

  const redCircleAnimStyle = useAnimatedStyle(() => ({
    opacity: redCircleOpacity.value,
    transform: [{ scale: redCircleScale.value }],
  }));

  const micIconAnimStyle = useAnimatedStyle(() => ({
    opacity: micOpacity.value,
  }));

  const pauseBarsAnimStyle = useAnimatedStyle(() => ({
    opacity: pauseOpacity.value,
    transform: [{ scale: pauseScale.value }],
  }));

  const lastNotificationUpdateRef = useRef<number>(0);
  const durationMsRef = useRef<number>(durationMs);
  durationMsRef.current = durationMs;

  const pauseRecordingRef = useRef(pauseRecording);
  pauseRecordingRef.current = pauseRecording;

  const resumeRecordingRef = useRef(resumeRecording);
  resumeRecordingRef.current = resumeRecording;

  const activateHardwareRoutingRef = useRef(activateHardwareRouting);
  activateHardwareRoutingRef.current = activateHardwareRouting;

  const releaseHardwareRoutingRef = useRef(releaseHardwareRouting);
  releaseHardwareRoutingRef.current = releaseHardwareRouting;

  const formatTimer = (ms: number) => {
    const totalSeconds = Math.floor(ms / 1000);
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const handleStopPress = async () => {
    if (isActionLockedRef.current) return;
    isActionLockedRef.current = true;

    try {
      const finalDuration = durationMsRef.current;
      await deactivateKeepAwake();
      await ForegroundServiceManager.stopService();

      const outputUri = await stopRecording();
      releaseHardwareRoutingRef.current();

      // Zero out the timer and reset metering to standby defaults
      await resetEngine();

      if (outputUri) {
        let sizeBytes = 0;
        try {
          const info = await FileSystem.getInfoAsync(outputUri);
          if (info.exists && !info.isDirectory) {
            sizeBytes = info.size;
          }
        } catch {}

        const now = new Date();
        const defaultName = `Take ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;

        setPendingTake({
          uri: outputUri,
          sizeBytes,
          durationMs: finalDuration,
          defaultName,
          formatBadge: activePreset.badge,
        });

        // Retain studio context in Standby mode and open name modal
        setNameModalVisible(true);
      }
    } catch (e: any) {
      await deactivateKeepAwake();
      await ForegroundServiceManager.stopService();
      releaseHardwareRoutingRef.current();
      await resetEngine();
      Alert.alert('Stop Error', e.message);
    } finally {
      setTimeout(() => {
        isActionLockedRef.current = false;
      }, 400);
    }
  };

  const handleStopPressRef = useRef(handleStopPress);
  handleStopPressRef.current = handleStopPress;

  const handleFinalizeTake = (chosenName: string) => {
    if (!pendingTake) return;

    const finalName = chosenName.trim().length > 0 ? chosenName.trim() : pendingTake.defaultName;

    const newRecord: SavedRecording = {
      id: `take_${Date.now()}`,
      name: finalName,
      uri: pendingTake.uri,
      sizeBytes: pendingTake.sizeBytes,
      durationMs: pendingTake.durationMs,
      createdAt: Date.now(),
    };

    const updated = RecordingLibrary.save(newRecord);
    setRecordings(updated);
    setNameModalVisible(false);

    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    const formattedSize =
      pendingTake.sizeBytes < 1024 * 1024
        ? `${(pendingTake.sizeBytes / 1024).toFixed(1)} KB`
        : `${(pendingTake.sizeBytes / (1024 * 1024)).toFixed(2)} MB`;

    setToastData({
      title: 'Recording saved',
      subtitle: `${newRecord.name} • ${formattedSize}`,
    });

    toastTimeoutRef.current = setTimeout(() => {
      setToastData(null);
    }, 3000);

    setPendingTake(null);
  };

  const handleDiscardTake = async () => {
    if (pendingTake?.uri) {
      try {
        await FileSystem.deleteAsync(pendingTake.uri, { idempotent: true });
      } catch (err) {
        console.warn('[App] Failed to delete discarded take file:', err);
      }
    }
    setNameModalVisible(false);
    setPendingTake(null);
  };

  useEffect(() => {
    return () => {
      if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    ForegroundServiceManager.registerHandlers({
      onPause: async () => {
        try {
          await pauseRecordingRef.current();
        } catch (e) {
          console.warn('[App] Notification onPause failed:', e);
        }
      },
      onResume: async () => {
        try {
          await resumeRecordingRef.current();
        } catch (e) {
          console.warn('[App] Notification onResume failed:', e);
        }
      },
      onStop: async () => {
        try {
          await handleStopPressRef.current();
        } catch (e) {
          console.warn('[App] Notification onStop failed:', e);
        }
      },
    });
  }, []);

  useEffect(() => {
    async function bootstrap() {
      try {
        await ForegroundServiceManager.initialize();

        if (Platform.OS === 'android') {
          const permissionsToRequest: any[] = [PermissionsAndroid.PERMISSIONS.RECORD_AUDIO];

          if (Platform.Version >= 31) {
            permissionsToRequest.push(PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT);
          }

          if (Platform.Version >= 33) {
            permissionsToRequest.push(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
          }

          await PermissionsAndroid.requestMultiple(permissionsToRequest);
        } else {
          await AudioModule.requestRecordingPermissionsAsync();
        }

        await AudioModule.setAudioModeAsync({
          allowsRecording: true,
          playsInSilentMode: true,
          interruptionMode: 'doNotMix',
          shouldRouteThroughEarpiece: false,
        });

        refreshDevices();
        setRecordings(RecordingLibrary.getAll());

        const orphaned = SessionJournal.checkOrphanedSession();
        if (orphaned) {
          Alert.alert(
            'Interrupted Recording Found',
            `Session ${orphaned.sessionId} did not finalize properly.`,
            [
              { text: 'Discard', style: 'destructive', onPress: () => SessionJournal.clearSession() },
              { text: 'Recover', onPress: () => console.log('Recovering:', orphaned.fileUri) },
            ]
          );
        }
      } catch (err) {
        console.error('Bootstrap error:', err);
      } finally {
        setIsReady(true);
      }
    }

    bootstrap();
  }, [refreshDevices]);

  useEffect(() => {
    if (engineState === 'RECORDING') {
      const now = Date.now();
      if (now - lastNotificationUpdateRef.current >= 1000) {
        lastNotificationUpdateRef.current = now;
        ForegroundServiceManager.updateProgress(formatTimer(durationMs), activePreset.badge, false);
      }
    } else if (engineState === 'PAUSED') {
      ForegroundServiceManager.updateProgress(formatTimer(durationMs), activePreset.badge, true);
    }
  }, [durationMs, engineState, activePreset]);

  // Decoupled Main Button: Library -> Studio Standby -> Active Take
  const handleMainButtonPress = async () => {
    if (isActionLockedRef.current) return;
    isActionLockedRef.current = true;

    try {
      // 1. Enter Studio Standby Mode without capturing audio
      if (currentScreen === 'library') {
        setCurrentScreen('studio');
        return;
      }

      // 2. Control active session inside Studio
      if (engineState === 'RECORDING') {
        await pauseRecording();
      } else if (engineState === 'PAUSED') {
        await resumeRecording();
      } else {
        // engineState === 'STOPPED' (Punch-in from Standby)
        activateHardwareRoutingRef.current();
        await activateKeepAwakeAsync();
        await ForegroundServiceManager.startService(activePreset.badge);
        await startRecording();
      }
    } catch (e: any) {
      await deactivateKeepAwake();
      await ForegroundServiceManager.stopService();
      releaseHardwareRoutingRef.current();

      Alert.alert('Recording Error', e.message, [
        {
          text: 'OK',
          onPress: async () => {
            await resetEngine();
            setCurrentScreen('studio');
          },
        },
      ]);
    } finally {
      setTimeout(() => {
        isActionLockedRef.current = false;
      }, 400);
    }
  };

  const handleBackToLibrary = () => {
    if (engineState === 'RECORDING' || engineState === 'PAUSED') {
      setWarningModalVisible(true);
      return;
    }
    setCurrentScreen('library');
  };

  const isDualPane = isTablet || isLandscape;
  const statusColor = getStatusColor(engineState);

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right', 'bottom']}>
      {/* Screen Switcher */}
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
              {/* Minimal Studio Header */}
              <View style={styles.header}>
                <TouchableOpacity
                  style={styles.backTouch}
                  onPress={handleBackToLibrary}
                  activeOpacity={0.7}
                  hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                >
                  <ChevronLeft size={22} color="#FFFFFF" strokeWidth={2.4} />
                </TouchableOpacity>

                {/* Status Indicator */}
                <View style={styles.statusPill}>
                  <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
                  <Text style={[styles.statusLabel, { color: statusColor }]}>
                    {engineState}
                  </Text>
                </View>

                {/* Minimal Settings Trigger */}
                <TouchableOpacity
                  style={styles.settingsTouch}
                  onPress={() => setSettingsVisible(true)}
                  activeOpacity={0.7}
                  hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                >
                  <Sliders size={18} color="#8E8E93" />
                </TouchableOpacity>
              </View>

              {/* Main Studio Workspace */}
              <ScrollView
                contentContainerStyle={styles.scrollContent}
                showsVerticalScrollIndicator={false}
                bounces={false}
              >
                <View
                  style={[
                    styles.studioCanvas,
                    isTablet && styles.studioCanvasTablet,
                    isDualPane && styles.studioCanvasDualPane,
                  ]}
                >
                  {/* Teleprompter Region */}
                  <View style={[styles.prompterSection, isDualPane && styles.prompterDualPane]}>
                    <TeleprompterDeck engineState={engineState} customHeight={prompterHeight} />
                  </View>

                  {/* Metering & Timer Console */}
                  <View style={[styles.meteringSection, isDualPane && styles.meteringDualPane]}>
                    {/* Unified Metadata Capsule */}
                    <View style={styles.metaCapsule}>
                      <TouchableOpacity
                        style={styles.metaSegment}
                        onPress={() => setSettingsVisible(true)}
                        disabled={engineState === 'RECORDING' || engineState === 'PAUSED'}
                        activeOpacity={0.7}
                      >
                        <Text style={styles.metaSegmentText}>{activePreset.badge}</Text>
                      </TouchableOpacity>

                      <View style={styles.metaDivider} />

                      <TouchableOpacity
                        style={styles.metaSegment}
                        onPress={() => {
                          refreshDevices();
                          setDeviceModalVisible(true);
                        }}
                        disabled={engineState === 'RECORDING' || engineState === 'PAUSED'}
                        activeOpacity={0.7}
                      >
                        <Mic size={11} color="#A1A1A6" />
                        <Text style={styles.metaSegmentText} numberOfLines={1}>
                          {selectedDevice ? selectedDevice.name : 'Built-in Mic'}
                        </Text>
                      </TouchableOpacity>
                    </View>

                    {/* Precision Studio Clock */}
                    <Text style={[styles.timer, isTablet && styles.timerTablet]}>
                      {formatTimer(durationMs)}
                    </Text>

                    {/* Sleek VU Meter */}
                    <View style={styles.meterWrapper}>
                      <AudioMeter
                        meteringDb={meteringDb}
                        isRecording={engineState === 'RECORDING'}
                      />
                    </View>
                  </View>
                </View>
              </ScrollView>
            </View>
          </Animated.View>
        )}
      </View>

      {/* Stylized Floating Toast */}
      {toastData && (
        <View style={styles.toastOverlay} pointerEvents="box-none">
          <Animated.View
            entering={FadeInDown.duration(240).easing(Easing.out(Easing.cubic))}
            exiting={FadeOutUp.duration(180).easing(Easing.in(Easing.cubic))}
            style={styles.toastCard}
          >
            <View style={styles.toastIconCircle}>
              <Check size={14} color="#000000" strokeWidth={3} />
            </View>
            <View style={styles.toastTextCol}>
              <Text style={styles.toastTitle}>{toastData.title}</Text>
              <Text style={styles.toastSubtitle} numberOfLines={1}>
                {toastData.subtitle}
              </Text>
            </View>
          </Animated.View>
        </View>
      )}

      {/* Unified Anchored Transport Layer */}
      {!isLibraryEditMode && (
        <View style={styles.transportBar} pointerEvents="box-none">
          <View style={styles.transportCenter} pointerEvents="box-none">
            {/* Sliding Stop Button (Only active during an active take) */}
            <Animated.View
              style={[styles.stopBtnWrapper, stopBtnAnimatedStyle]}
              pointerEvents={isSessionActive ? 'auto' : 'none'}
            >
              <Pressable
                onPress={handleStopPress}
                disabled={!isSessionActive}
                style={({ pressed }) => [
                  styles.stopOuterBtn,
                  pressed && { opacity: 0.82, transform: [{ scale: 0.94 }] },
                ]}
                hitSlop={10}
              >
                <View style={styles.stopInnerSquare} />
              </Pressable>
            </Animated.View>

            {/* Main Action Button */}
            <Animated.View style={[styles.mainBtnWrapper, mainBtnAnimatedStyle]} pointerEvents="box-none">
              <Pressable
                onPress={handleMainButtonPress}
                style={({ pressed }) => [
                  styles.mainOuterRing,
                  pressed && { opacity: 0.88, transform: [{ scale: 0.95 }] },
                ]}
                hitSlop={10}
              >
                <Animated.View style={[styles.redCircle, redCircleAnimStyle]} pointerEvents="none">
                  <Animated.View style={[styles.micIconWrapper, micIconAnimStyle]}>
                    <Mic size={24} color="#FFFFFF" />
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
      )}

      {/* Warning Modal */}
      <ActiveRecordingWarningModal
        visible={warningModalVisible}
        onClose={() => setWarningModalVisible(false)}
        onStopAndExit={handleStopPress}
      />

      {/* Naming Modal */}
      {pendingTake && (
        <SaveRecordingModal
          visible={nameModalVisible}
          defaultName={pendingTake.defaultName}
          durationMs={pendingTake.durationMs}
          sizeBytes={pendingTake.sizeBytes}
          formatBadge={pendingTake.formatBadge}
          onSubmit={handleFinalizeTake}
          onDiscard={handleDiscardTake}
        />
      )}

      {/* Input Devices & Settings Modals */}
      <InputDeviceModal
        visible={deviceModalVisible}
        onClose={() => setDeviceModalVisible(false)}
        devices={devices}
        selectedDeviceId={selectedDeviceId}
        onSelectDevice={selectDevice}
        engineState={engineState}
      />

      <AudioSettingsModal
        visible={settingsVisible}
        onClose={() => setSettingsVisible(false)}
        activePresetKey={activePreset.key}
        onSelectPreset={setPresetKey}
        engineState={engineState}
      />
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <AudioRecorderApp />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function getStatusColor(state: EngineState) {
  switch (state) {
    case 'RECORDING':
      return '#FF3B30';
    case 'PAUSED':
      return '#FF9500';
    case 'STOPPED':
      return '#FFFFFF';
    default:
      return '#636366';
  }
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#000000',
  },
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  screensContainer: {
    flex: 1,
  },
  contentConstraint: {
    flex: 1,
    width: '100%',
    alignSelf: 'center',
  },

  /* Minimal Header */
  header: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#161618',
  },
  backTouch: {
    width: 36,
    height: 36,
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor: '#121214',
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusLabel: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.0,
  },
  settingsTouch: {
    width: 36,
    height: 36,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },

  /* Clean Studio Workspace */
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 130,
  },
  studioCanvas: {
    width: '100%',
    alignItems: 'center',
    gap: 16,
  },
  studioCanvasTablet: {
    paddingHorizontal: 20,
  },
  studioCanvasDualPane: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 24,
  },
  prompterSection: {
    width: '100%',
    alignItems: 'center',
  },
  prompterDualPane: {
    flex: 1.25,
  },
  meteringSection: {
    width: '100%',
    alignItems: 'center',
  },
  meteringDualPane: {
    flex: 1,
    justifyContent: 'center',
  },

  /* Unified Metadata Capsule */
  metaCapsule: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#121214',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#1F1F24',
    paddingHorizontal: 12,
    paddingVertical: 5,
    marginTop: 4,
    maxWidth: '92%',
  },
  metaSegment: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 6,
    paddingVertical: 2,
    maxWidth: 160,
  },
  metaSegmentText: {
    color: '#D1D1D6',
    fontSize: 11,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  metaDivider: {
    width: 1,
    height: 12,
    backgroundColor: '#2C2C30',
    marginHorizontal: 2,
  },

  /* Precision Studio Timer */
  timer: {
    fontSize: 56,
    fontWeight: '200',
    color: '#FFFFFF',
    fontVariant: ['tabular-nums'],
    letterSpacing: -1,
    marginTop: 10,
    marginBottom: 6,
  },
  timerTablet: {
    fontSize: 68,
  },
  meterWrapper: {
    width: '100%',
    alignItems: 'center',
    marginTop: 4,
  },

  /* Floating Toast */
  toastOverlay: {
    position: 'absolute',
    top: 18,
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 10000,
    elevation: 100,
  },
  toastCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1C1C1E',
    borderWidth: 1,
    borderColor: '#2C2C2E',
    borderRadius: 30,
    paddingHorizontal: 16,
    paddingVertical: 10,
    maxWidth: 380,
    gap: 10,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 10,
    elevation: 8,
  },
  toastIconCircle: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#FFFFFF',
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
    letterSpacing: -0.2,
  },
  toastSubtitle: {
    color: '#8E8E93',
    fontSize: 11,
    fontWeight: '500',
    marginTop: 1,
  },

  /* Fixed Bottom Transport Layer */
  transportBar: {
    position: 'absolute',
    bottom: 24,
    left: 0,
    right: 0,
    height: 76,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 9999,
    elevation: 99,
  },
  transportCenter: {
    width: 200,
    height: 76,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mainBtnWrapper: {
    position: 'absolute',
    width: 74,
    height: 74,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2,
  },
  stopBtnWrapper: {
    position: 'absolute',
    width: 74,
    height: 74,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
  },
  mainOuterRing: {
    width: 74,
    height: 74,
    borderRadius: 37,
    borderWidth: 2,
    borderColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#000000',
  },
  redCircle: {
    position: 'absolute',
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: '#FF3B30',
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
    width: 58,
    height: 58,
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
    width: 74,
    height: 74,
    borderRadius: 37,
    borderWidth: 2,
    borderColor: '#3A3A3C',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1C1C1E',
  },
  stopInnerSquare: {
    width: 22,
    height: 22,
    borderRadius: 4,
    backgroundColor: '#FFFFFF',
  },
});