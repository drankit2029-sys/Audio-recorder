import { useEffect, useState } from 'react';
import { StyleSheet, Text, View, Alert } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { AudioModule } from 'expo-audio';
import { SessionJournal, ActiveSessionRecord } from './src/services/storage/sessionJournal';

export default function App() {
  const [isReady, setIsReady] = useState(false);
  const [orphanedSession, setOrphanedSession] = useState<ActiveSessionRecord | null>(null);

  useEffect(() => {
    async function bootstrapAudioEnvironment() {
      try {
        const status = await AudioModule.requestRecordingPermissionsAsync();
        if (!status.granted) {
          Alert.alert("Permission Required", "Microphone access is required to record master audio.");
          return;
        }

        await AudioModule.setAudioModeAsync({
          allowsRecording: true,
          playsInSilentMode: true,
          interruptionMode: 'doNotMix',
          shouldRouteThroughEarpiece: false,
        });

        const crashedSession = SessionJournal.checkOrphanedSession();
        if (crashedSession) {
          setOrphanedSession(crashedSession);
          Alert.alert(
            "Interrupted Recording Found",
            "An unfinalized recording was found from a previous session.",
            [
              { text: "Discard", style: "destructive", onPress: () => SessionJournal.clearSession() },
              { text: "Recover", onPress: () => console.log("Recovering session:", crashedSession.sessionId) }
            ]
          );
        }
      } catch (error) {
        console.error("Audio bootstrap error:", error);
      } finally {
        setIsReady(true);
      }
    }

    bootstrapAudioEnvironment();
  }, []);

  if (!isReady) {
    return (
      <SafeAreaProvider>
        <View style={styles.container}>
          <Text style={styles.statusText}>Initializing Audio Engine...</Text>
        </View>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>Audio Recorder</Text>
          <Text style={styles.statusText}>
            System Status: <Text style={{ color: '#00E676' }}>Ready</Text>
          </Text>
        </View>

        <View style={styles.deck}>
          <Text style={styles.placeholderText}>Audio Engine Scaffold Ready</Text>
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#121212',
    alignItems: 'center',
    justifyContent: 'center',
  },
  header: {
    position: 'absolute',
    top: 60,
    alignItems: 'center',
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: '#FFFFFF',
    marginBottom: 8,
  },
  statusText: {
    fontSize: 14,
    color: '#9E9E9E',
  },
  deck: {
    width: '90%',
    height: 200,
    backgroundColor: '#1E1E1E',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#333333',
    alignItems: 'center',
    justifyContent: 'center',
  },
  placeholderText: {
    color: '#757575',
    fontSize: 16,
    fontWeight: '500',
  }
});