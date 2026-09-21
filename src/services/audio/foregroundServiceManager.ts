// src/services/audio/ForegroundServiceManager.ts
import notifee, {
  AndroidImportance,
  AndroidColor,
  AndroidForegroundServiceType,
} from '@notifee/react-native';

const CHANNEL_ID = 'audio_recording_service';
const NOTIFICATION_ID = 'active_recording_notification';

export const ForegroundServiceManager = {
  async initialize(): Promise<void> {
    try {
      await notifee.requestPermission();

      await notifee.createChannel({
        id: CHANNEL_ID,
        name: 'Audio Recording Service',
        lights: false,
        vibration: false,
        importance: AndroidImportance.LOW, // Low importance prevents audible pinging every second
      });
    } catch (error) {
      console.warn('[ForegroundServiceManager] Failed to init notification channel:', error);
    }
  },

  async startService(presetLabel: string): Promise<void> {
    try {
      await notifee.displayNotification({
        id: NOTIFICATION_ID,
        title: 'Recording Active',
        body: `Format: ${presetLabel} • 00:00`,
        android: {
          channelId: CHANNEL_ID,
          asForegroundService: true,
          ongoing: true,
          color: AndroidColor.RED,
          foregroundServiceTypes: [AndroidForegroundServiceType.MICROPHONE],
          pressAction: {
            id: 'default',
          },
        },
      });
    } catch (error) {
      console.warn('[ForegroundServiceManager] Failed to start foreground service:', error);
    }
  },

  async updateProgress(durationStr: string, presetLabel: string): Promise<void> {
    try {
      await notifee.displayNotification({
        id: NOTIFICATION_ID,
        title: 'Recording in Progress...',
        body: `${durationStr} • ${presetLabel}`,
        android: {
          channelId: CHANNEL_ID,
          asForegroundService: true,
          ongoing: true,
          color: AndroidColor.RED,
          pressAction: {
            id: 'default',
          },
        },
      });
    } catch {}
  },

  async stopService(): Promise<void> {
    try {
      await notifee.stopForegroundService();
      await notifee.cancelNotification(NOTIFICATION_ID);
    } catch (error) {
      console.warn('[ForegroundServiceManager] Failed to stop foreground service:', error);
    }
  },
};