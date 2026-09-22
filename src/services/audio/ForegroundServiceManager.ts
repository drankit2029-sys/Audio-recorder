// src/services/audio/ForegroundServiceManager.ts
import { Platform } from 'react-native';
import notifee, {
  AndroidImportance,
  AndroidColor,
  AndroidForegroundServiceType,
  EventType,
  NotificationAndroidAction,
} from '@notifee/react-native';

const CHANNEL_ID = 'audio_recording_service';
const NOTIFICATION_ID = 'active_recording_notification';

type ActionCallback = () => void | Promise<void>;

let onPauseCallback: ActionCallback | null = null;
let onResumeCallback: ActionCallback | null = null;
let onStopCallback: ActionCallback | null = null;

async function handleActionPress(actionId?: string) {
  if (!actionId) return;

  if (actionId === 'action_pause') {
    if (onPauseCallback) await onPauseCallback();
  } else if (actionId === 'action_start' || actionId === 'action_resume') {
    if (onResumeCallback) await onResumeCallback();
  } else if (actionId === 'action_stop') {
    if (onStopCallback) await onStopCallback();
  }
}

if (Platform.OS === 'android') {
  // 1. Keep background task worker alive while recording (Android only)
  notifee.registerForegroundService(() => {
    return new Promise(() => {});
  });

  // 2. Handle notification interactions when app is minimized or screen is locked
  notifee.onBackgroundEvent(async ({ type, detail }) => {
    if (type === EventType.ACTION_PRESS) {
      await handleActionPress(detail.pressAction?.id);
    }
  });

  // 3. Handle notification interactions when app is visible
  notifee.onForegroundEvent(async ({ type, detail }) => {
    if (type === EventType.ACTION_PRESS) {
      await handleActionPress(detail.pressAction?.id);
    }
  });
}

function createNotificationPayload(durationStr: string, presetLabel: string, isPaused: boolean) {
  const actions: NotificationAndroidAction[] = [
    {
      title: isPaused ? 'Start' : 'Pause',
      pressAction: {
        id: isPaused ? 'action_start' : 'action_pause',
      },
    },
    {
      title: 'Stop',
      pressAction: {
        id: 'action_stop',
      },
    },
  ];

  return {
    id: NOTIFICATION_ID,
    title: isPaused ? 'Recording Paused' : 'Recording in Progress...',
    body: `${durationStr} • ${presetLabel}`,
    android: {
      channelId: CHANNEL_ID,
      asForegroundService: true,
      ongoing: true,
      color: isPaused ? AndroidColor.YELLOW : AndroidColor.RED,
      foregroundServiceTypes: [
        AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_MICROPHONE,
      ],
      pressAction: {
        id: 'default',
      },
      actions,
    },
  };
}

export const ForegroundServiceManager = {
  registerHandlers(handlers: {
    onPause: ActionCallback;
    onResume: ActionCallback;
    onStop: ActionCallback;
  }) {
    onPauseCallback = handlers.onPause;
    onResumeCallback = handlers.onResume;
    onStopCallback = handlers.onStop;
  },

  async initialize(): Promise<void> {
    if (Platform.OS !== 'android') return;
    try {
      await notifee.requestPermission();

      await notifee.createChannel({
        id: CHANNEL_ID,
        name: 'Audio Recording Service',
        lights: false,
        vibration: false,
        importance: AndroidImportance.LOW,
      });
    } catch (error) {
      console.warn('[ForegroundServiceManager] Failed to init notification channel:', error);
    }
  },

  async startService(presetLabel: string): Promise<void> {
    if (Platform.OS !== 'android') return;
    try {
      await notifee.displayNotification(
        createNotificationPayload('00:00', presetLabel, false)
      );
    } catch (error) {
      console.warn('[ForegroundServiceManager] Failed to start foreground service:', error);
    }
  },

  async updateProgress(durationStr: string, presetLabel: string, isPaused: boolean = false): Promise<void> {
    if (Platform.OS !== 'android') return;
    try {
      await notifee.displayNotification(
        createNotificationPayload(durationStr, presetLabel, isPaused)
      );
    } catch {}
  },

  async stopService(): Promise<void> {
    if (Platform.OS !== 'android') return;
    try {
      await notifee.stopForegroundService();
      await notifee.cancelNotification(NOTIFICATION_ID);
    } catch (error) {
      console.warn('[ForegroundServiceManager] Failed to stop foreground service:', error);
    }
  },
};