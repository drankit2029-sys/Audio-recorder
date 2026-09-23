// App.tsx
import 'react-native-gesture-handler';
import { useEffect, useState, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  Alert,
  Platform,
  PermissionsAndroid,
  ScrollView,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { AudioModule } from 'expo-audio';
import * as FileSystem from 'expo-file-system/legacy';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import {
  Radio,
  Sliders,
  FolderClosed,
  Mic,
} from 'lucide-react-native';

import { SessionJournal } from './src/services/storage/sessionJournal';
import { RecordingLibrary, SavedRecording } from './src/services/storage/recordingLibrary';
import { useAudioRecording, EngineState } from './src/services/audio/useAudioRecording';
import { AudioMeter } from './src/components/meter/AudioMeter';
import { RecordingLibraryModal } from './src/components/library/RecordingLibraryModal';
import { TeleprompterDeck } from './src/components/prompter/TeleprompterDeck';
import { AudioSettingsModal } from './src/components/settings/AudioSettingsModal';
import { ForegroundServiceManager } from './src/services/audio/ForegroundServiceManager';
import { useAudioInputDevices } from './src/services/audio/useAudioInputDevices';
import { InputDeviceModal } from './src/components/audio/InputDeviceModal';
import { useResponsive } from './src/hooks/useResponsive';

function AudioRecorderScreen() {
  const [isReady, setIsReady] = useState(false);
  const [libraryVisible, setLibraryVisible] = useState(false);
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [deviceModalVisible, setDeviceModalVisible] = useState(false);
  const [recordings, setRecordings] = useState<SavedRecording[]>([]);

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
  } = useAudioRecording();

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
    try {
      const finalDuration = durationMsRef.current;
      await deactivateKeepAwake();
      await ForegroundServiceManager.stopService();

      const outputUri = await stopRecording();
      releaseHardwareRoutingRef.current();

      if (outputUri) {
        let sizeBytes = 0;
        try {
          const info = await FileSystem.getInfoAsync(outputUri);
          if (info.exists && !info.isDirectory) {
            sizeBytes = info.size;
          }
        } catch {}

        const now = new Date();
        const newRecord: SavedRecording = {
          id: `take_${Date.now()}`,
          name: `Take ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`,
          uri: outputUri,
          sizeBytes,
          durationMs: finalDuration,
          createdAt: Date.now(),
        };

        const updated = RecordingLibrary.save(newRecord);
        setRecordings(updated);

        Alert.alert(
          'Take Finalized',
          `Saved ${newRecord.name} (${(sizeBytes / 1024).toFixed(1)} KB)`,
          [
            { text: 'OK' },
            { text: 'View in Library', onPress: () => setLibraryVisible(true) },
          ]
        );
      }
    } catch (e: any) {
      await deactivateKeepAwake();
      await ForegroundServiceManager.stopService();
      releaseHardwareRoutingRef.current();
      Alert.alert('Stop Error', e.message);
    }
  };

  const handleStopPressRef = useRef(handleStopPress);
  handleStopPressRef.current = handleStopPress;

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

        if (Platform.OS === 'android' && Platform.Version >= 31) {
          await PermissionsAndroid.requestMultiple([
            PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          ]);
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
        ForegroundServiceManager.updateProgress(
          formatTimer(durationMs),
          activePreset.badge,
          false
        );
      }
    } else if (engineState === 'PAUSED') {
      ForegroundServiceManager.updateProgress(
        formatTimer(durationMs),
        activePreset.badge,
        true
      );
    }
  }, [durationMs, engineState, activePreset]);

  const handleRecordPress = async () => {
    try {
      if (engineState === 'IDLE' || engineState === 'STOPPED' || engineState === 'ERROR') {
        activateHardwareRoutingRef.current();
        await activateKeepAwakeAsync();
        await ForegroundServiceManager.startService(activePreset.badge);
        await startRecording();
      } else if (engineState === 'RECORDING') {
        await pauseRecording();
      } else if (engineState === 'PAUSED') {
        await resumeRecording();
      }
    } catch (e: any) {
      await deactivateKeepAwake();
      await ForegroundServiceManager.stopService();
      releaseHardwareRoutingRef.current();
      Alert.alert('Recording Error', e.message);
    }
  };

  const isDualPane = isTablet || isLandscape;
  const statusColor = getStatusColor(engineState);

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right', 'bottom']}>
      <View style={[styles.contentConstraint, { maxWidth: maxContentWidth }]}>
        {/* Professional Minimalist Header */}
        <View style={styles.header}>
          {/* Left: Format Option */}
          <TouchableOpacity
            style={styles.headerActionBtn}
            onPress={() => setSettingsVisible(true)}
            activeOpacity={0.7}
          >
            <Sliders size={14} color="#A1A1A1" />
            <Text style={styles.headerBtnText}>FORMAT</Text>
          </TouchableOpacity>

          {/* Center: [Radio Icon][State] */}
          <View style={styles.stateCenterContainer}>
            <Radio size={15} color={statusColor} />
            <Text style={[styles.stateText, { color: statusColor }]}>
              {engineState}
            </Text>
          </View>

          {/* Right: Library Option */}
          <TouchableOpacity
            style={styles.headerActionBtn}
            onPress={() => setLibraryVisible(true)}
            activeOpacity={0.7}
          >
            <FolderClosed size={14} color="#A1A1A1" />
            <Text style={styles.headerBtnText}>
              LIBRARY ({recordings.length})
            </Text>
          </TouchableOpacity>
        </View>

        {/* Main Console Deck */}
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          bounces={false}
        >
          <View
            style={[
              styles.deck,
              isTablet && styles.deckTablet,
              isDualPane && styles.deckDualPane,
            ]}
          >
            {/* Left/Top: Teleprompter Deck */}
            <View style={[styles.pane, isDualPane && styles.panePrompter]}>
              <TeleprompterDeck engineState={engineState} customHeight={prompterHeight} />
            </View>

            {/* Right/Bottom: Controls, Badges, VU Meter & Transport */}
            <View style={[styles.pane, isDualPane && styles.paneControls]}>
              <View style={styles.badgesRow}>
                <TouchableOpacity
                  style={styles.badgeContainer}
                  onPress={() => setSettingsVisible(true)}
                  disabled={engineState === 'RECORDING' || engineState === 'PAUSED'}
                >
                  <View style={styles.badgeDot} />
                  <Text style={styles.badgeText}>{activePreset.badge}</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.badgeContainer}
                  onPress={() => {
                    refreshDevices();
                    setDeviceModalVisible(true);
                  }}
                  disabled={engineState === 'RECORDING' || engineState === 'PAUSED'}
                >
                  <Mic size={12} color="#FFFFFF" />
                  <Text style={styles.badgeText} numberOfLines={1}>
                    {selectedDevice ? selectedDevice.name : 'Built-in Mic'}
                  </Text>
                </TouchableOpacity>
              </View>

              <Text style={[styles.timer, isTablet && styles.timerTablet]}>
                {formatTimer(durationMs)}
              </Text>

              <AudioMeter
                meteringDb={meteringDb}
                isRecording={engineState === 'RECORDING'}
              />

              {/* Standard Studio Recording Transport */}
              <View style={styles.transportRow}>
                {/* 1. Main Action Button: Record or Pause */}
                {engineState === 'RECORDING' ? (
                  /* Standard Pause Button: Two Vertical Bars */
                  <TouchableOpacity
                    style={styles.pauseOuterBtn}
                    onPress={handleRecordPress}
                    activeOpacity={0.8}
                  >
                    <View style={styles.pauseBarsWrapper}>
                      <View style={styles.pauseBar} />
                      <View style={styles.pauseBar} />
                    </View>
                  </TouchableOpacity>
                ) : (
                  /* Standard Record Button: Red circle with spaced outer outline ring */
                  <TouchableOpacity
                    style={styles.recordOuterRing}
                    onPress={handleRecordPress}
                    activeOpacity={0.8}
                  >
                    <View style={styles.recordInnerCircle} />
                  </TouchableOpacity>
                )}

                {/* 2. Stop Button: Standard Square inside circular boundary */}
                {(engineState === 'RECORDING' || engineState === 'PAUSED') && (
                  <TouchableOpacity
                    style={styles.stopOuterBtn}
                    onPress={handleStopPress}
                    activeOpacity={0.8}
                  >
                    <View style={styles.stopInnerSquare} />
                  </TouchableOpacity>
                )}
              </View>
            </View>
          </View>
        </ScrollView>
      </View>

      {/* Modals */}
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

      <RecordingLibraryModal
        visible={libraryVisible}
        onClose={() => setLibraryVisible(false)}
        recordings={recordings}
        onLibraryUpdate={setRecordings}
      />
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <AudioRecorderScreen />
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
      return '#8E8E93';
  }
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#000000',
  },
  container: {
    flex: 1,
    alignItems: 'center',
    backgroundColor: '#000000',
  },
  contentConstraint: {
    flex: 1,
    width: '100%',
    alignSelf: 'center',
    paddingHorizontal: 16,
  },
  header: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#1F1F1F',
  },
  headerActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#121212',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#262626',
  },
  headerBtnText: {
    color: '#D1D1D6',
    fontWeight: '600',
    fontSize: 11,
    letterSpacing: 0.5,
  },
  stateCenterContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: '#121212',
    borderWidth: 1,
    borderColor: '#222222',
  },
  stateText: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.8,
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingVertical: 16,
    paddingBottom: 28,
  },
  deck: {
    width: '100%',
    paddingHorizontal: 20,
    paddingVertical: 22,
    backgroundColor: '#0F0F0F',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: '#222222',
    alignItems: 'center',
    justifyContent: 'center',
  },
  deckTablet: {
    paddingHorizontal: 30,
    paddingVertical: 28,
    borderRadius: 28,
  },
  deckDualPane: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 20,
  },
  pane: {
    width: '100%',
    alignItems: 'center',
  },
  panePrompter: {
    width: undefined,
    flex: 1.25,
    padding: 4,
  },
  paneControls: {
    width: undefined,
    flex: 1,
    justifyContent: 'center',
    padding: 4,
  },
  badgesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 4,
    maxWidth: '96%',
    flexWrap: 'wrap',
  },
  badgeContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#1A1A1A',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    maxWidth: 180,
  },
  badgeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#FFFFFF',
  },
  badgeText: {
    color: '#E5E5EA',
    fontSize: 11,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  timer: {
    fontSize: 48,
    fontWeight: '200',
    color: '#FFFFFF',
    fontVariant: ['tabular-nums'],
    marginVertical: 10,
  },
  timerTablet: {
    fontSize: 60,
  },
  transportRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 24,
    marginTop: 18,
  },
  /* Record Button: Spaced outline ring + solid inner red circle */
  recordOuterRing: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 2,
    borderColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  recordInnerCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#FF3B30',
  },
  /* Pause Button: Outer ring with standard two vertical dashes */
  pauseOuterBtn: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 2,
    borderColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1C1C1E',
  },
  pauseBarsWrapper: {
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
  /* Stop Button: Standard square inside balanced circular frame */
  stopOuterBtn: {
    width: 72,
    height: 72,
    borderRadius: 36,
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