// App.tsx
import 'react-native-gesture-handler';
import { useEffect, useState, useRef } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, Alert, Platform, PermissionsAndroid } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { AudioModule } from 'expo-audio';
import * as FileSystem from 'expo-file-system/legacy';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
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

export default function App() {
  const [isReady, setIsReady] = useState(false);
  const [libraryVisible, setLibraryVisible] = useState(false);
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [deviceModalVisible, setDeviceModalVisible] = useState(false);
  const [recordings, setRecordings] = useState<SavedRecording[]>([]);

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

      // Release communication mode to unblock media playback on the headset
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

  // App.tsx (inside the bootstrap useEffect)
useEffect(() => {
  async function bootstrap() {
    try {
      if (Platform.OS === 'android') {
        await ForegroundServiceManager.initialize();

        if (Platform.Version >= 31) {
          await PermissionsAndroid.requestMultiple([
            PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          ]);
        }
      } else {
        const permissionStatus = await AudioModule.requestRecordingPermissionsAsync();
        if (!permissionStatus.granted) {
          Alert.alert(
            'Microphone Required',
            'Permission to access the microphone is required to record audio.'
          );
        }
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

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <SafeAreaView style={styles.container}>
          {/* Header */}
          <View style={styles.header}>
            <View>
              <Text style={styles.title}>Audio Recorder</Text>
              <Text style={styles.statusText}>
                State: <Text style={{ color: getStatusColor(engineState) }}>{engineState}</Text>
              </Text>
            </View>

            <View style={styles.headerButtons}>
              <TouchableOpacity
                style={styles.headerBtn}
                onPress={() => setSettingsVisible(true)}
              >
                <Text style={styles.headerBtnText}>FORMAT</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.headerBtn, styles.takesBtn]}
                onPress={() => setLibraryVisible(true)}
              >
                <Text style={styles.takesBtnText}>TAKES ({recordings.length})</Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* Console Deck */}
          <View style={styles.deck}>
            <TeleprompterDeck engineState={engineState} />

            {/* Badges: Format & Active Input Mic */}
            <View style={styles.badgesRow}>
              <TouchableOpacity
                style={styles.presetBadgeContainer}
                onPress={() => setSettingsVisible(true)}
                disabled={engineState === 'RECORDING' || engineState === 'PAUSED'}
              >
                <View style={styles.presetBadgeDot} />
                <Text style={styles.presetBadgeText}>{activePreset.badge}</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.inputBadgeContainer}
                onPress={() => {
                  refreshDevices();
                  setDeviceModalVisible(true);
                }}
                disabled={engineState === 'RECORDING' || engineState === 'PAUSED'}
              >
                <Text style={styles.inputBadgeIcon}>🎙️</Text>
                <Text style={styles.inputBadgeText} numberOfLines={1}>
                  {selectedDevice ? selectedDevice.name : 'Built-in Microphone'}
                </Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.timer}>{formatTimer(durationMs)}</Text>

            <AudioMeter
              meteringDb={meteringDb}
              isRecording={engineState === 'RECORDING'}
            />

            <View style={styles.controlsRow}>
              <TouchableOpacity
                style={[styles.button, engineState === 'RECORDING' ? styles.pauseBtn : styles.recordBtn]}
                onPress={handleRecordPress}
              >
                <Text style={styles.buttonText}>
                  {engineState === 'RECORDING' ? 'PAUSE' : engineState === 'PAUSED' ? 'RESUME' : 'RECORD'}
                </Text>
              </TouchableOpacity>

              {(engineState === 'RECORDING' || engineState === 'PAUSED') && (
                <TouchableOpacity style={[styles.button, styles.stopBtn]} onPress={handleStopPress}>
                  <Text style={styles.buttonText}>STOP</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>

          {/* Hardware Input Device Modal */}
          <InputDeviceModal
            visible={deviceModalVisible}
            onClose={() => setDeviceModalVisible(false)}
            devices={devices}
            selectedDeviceId={selectedDeviceId}
            onSelectDevice={selectDevice}
            engineState={engineState}
          />

          {/* Settings Modal */}
          <AudioSettingsModal
            visible={settingsVisible}
            onClose={() => setSettingsVisible(false)}
            activePresetKey={activePreset.key}
            onSelectPreset={setPresetKey}
            engineState={engineState}
          />

          {/* Library Modal */}
          <RecordingLibraryModal
            visible={libraryVisible}
            onClose={() => setLibraryVisible(false)}
            recordings={recordings}
            onLibraryUpdate={setRecordings}
          />
        </SafeAreaView>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function getStatusColor(state: EngineState) {
  switch (state) {
    case 'RECORDING':
      return '#FF5252';
    case 'PAUSED':
      return '#FFD600';
    case 'STOPPED':
      return '#00E676';
    default:
      return '#9E9E9E';
  }
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#121212',
  },
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  header: {
    position: 'absolute',
    top: 48,
    width: '92%',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  statusText: {
    fontSize: 13,
    color: '#9E9E9E',
    marginTop: 2,
  },
  headerButtons: {
    flexDirection: 'row',
    gap: 8,
  },
  headerBtn: {
    backgroundColor: '#262626',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#3A3A3A',
  },
  headerBtnText: {
    color: '#B0BEC5',
    fontWeight: '700',
    fontSize: 11,
    letterSpacing: 0.5,
  },
  takesBtn: {
    borderColor: '#2E4C38',
  },
  takesBtnText: {
    color: '#00E676',
    fontWeight: '700',
    fontSize: 11,
    letterSpacing: 0.5,
  },
  deck: {
    width: '92%',
    padding: 16,
    paddingBottom: 24,
    backgroundColor: '#1E1E1E',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#333333',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 50,
  },
  badgesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 4,
    maxWidth: '96%',
  },
  presetBadgeContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#252525',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#383838',
  },
  presetBadgeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#00E676',
  },
  presetBadgeText: {
    color: '#E0E0E0',
    fontSize: 11,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  inputBadgeContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#1C2620',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2E4C38',
    maxWidth: 160,
  },
  inputBadgeIcon: {
    fontSize: 11,
  },
  inputBadgeText: {
    color: '#00E676',
    fontSize: 11,
    fontWeight: '600',
  },
  timer: {
    fontSize: 44,
    fontWeight: '300',
    color: '#FFFFFF',
    fontVariant: ['tabular-nums'],
    marginVertical: 4,
  },
  controlsRow: {
    flexDirection: 'row',
    gap: 16,
    marginTop: 14,
  },
  button: {
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: 30,
  },
  recordBtn: {
    backgroundColor: '#D50000',
  },
  pauseBtn: {
    backgroundColor: '#FF6D00',
  },
  stopBtn: {
    backgroundColor: '#424242',
  },
  buttonText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 14,
    letterSpacing: 1,
  },
});