// src/services/audio/ForegroundServiceManager.ts
import { Platform, PermissionsAndroid } from 'react-native';
import notifee, {
  AndroidImportance,
  AndroidColor,
  EventType,
  Event,
  AndroidForegroundServiceType,
} from '@notifee/react-native';

type ActionHandler = () => Promise<void> | void;

interface ServiceHandlers {
  onPause?: ActionHandler;
  onResume?: ActionHandler;
  onStop?: ActionHandler;
}

class ForegroundServiceManagerImpl {
  private channelId = 'recording_service_channel';
  private isInitialized = false;
  private isRunning = false;
  private lastStartTime = 0;
  private handlers: ServiceHandlers = {};
  private actionQueue: Promise<void> = Promise.resolve();

  constructor() {
    // Keep headless task runner open for the lifetime of the recording
    notifee.registerForegroundService(() => {
      return new Promise(() => {});
    });

    notifee.onBackgroundEvent(async ({ type, detail }: Event) => {
      await this.handleNotificationAction(type, detail);
    });

    notifee.onForegroundEvent(async ({ type, detail }: Event) => {
      await this.handleNotificationAction(type, detail);
    });
  }

  private async handleNotificationAction(type: EventType, detail: any) {
    if (type === EventType.ACTION_PRESS && detail.pressAction) {
      const actionId = detail.pressAction.id;
      if (actionId === 'pause' && this.handlers.onPause) {
        await this.handlers.onPause();
      } else if (actionId === 'resume' && this.handlers.onResume) {
        await this.handlers.onResume();
      } else if (actionId === 'stop' && this.handlers.onStop) {
        await this.handlers.onStop();
      }
    }
  }

  public async initialize(): Promise<void> {
    if (this.isInitialized) return;
    try {
      await notifee.createChannel({
        id: this.channelId,
        name: 'Audio Recording Service',
        lights: false,
        vibration: false,
        importance: AndroidImportance.LOW,
      });
      this.isInitialized = true;
    } catch (e) {
      console.warn('[ForegroundServiceManager] Channel creation error:', e);
    }
  }

  public registerHandlers(handlers: ServiceHandlers) {
    this.handlers = { ...this.handlers, ...handlers };
  }

  public startService(presetBadge: string): Promise<void> {
    this.actionQueue = this.actionQueue.then(async () => {
      if (this.isRunning) return;

      // Android 14 guard: Never invoke microphone FGS without granted audio permission
      if (Platform.OS === 'android') {
        const hasMicPermission = await PermissionsAndroid.check(
          PermissionsAndroid.PERMISSIONS.RECORD_AUDIO
        );
        if (!hasMicPermission) {
          console.warn('[ForegroundServiceManager] RECORD_AUDIO permission missing; aborting FGS start.');
          return;
        }
      }

      await this.initialize();

      await notifee.displayNotification({
        id: 'recording_ongoing',
        title: 'Recording Active',
        body: `00:00 • ${presetBadge}`,
        android: {
          channelId: this.channelId,
          asForegroundService: true,
          foregroundServiceTypes: [
            AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_MICROPHONE,
          ],
          color: AndroidColor.RED,
          ongoing: true,
          pressAction: { id: 'default' },
          actions: [
            { title: 'Pause', pressAction: { id: 'pause' } },
            { title: 'Stop', pressAction: { id: 'stop' } },
          ],
        },
      });

      this.isRunning = true;
      this.lastStartTime = Date.now();
    }).catch((err) => {
      console.error('[ForegroundServiceManager] startService failed:', err);
      this.isRunning = false;
    });

    return this.actionQueue;
  }

  public async updateProgress(timerText: string, presetBadge: string, isPaused: boolean): Promise<void> {
    // Only update if service is actively established
    if (!this.isRunning) return;

    try {
      // NOTE: asForegroundService is intentionally omitted here to prevent re-calling Context.startForegroundService()
      await notifee.displayNotification({
        id: 'recording_ongoing',
        title: isPaused ? 'Recording Paused' : 'Recording Active',
        body: `${timerText} • ${presetBadge}`,
        android: {
          channelId: this.channelId,
          color: isPaused ? AndroidColor.ORANGE : AndroidColor.RED,
          ongoing: true,
          pressAction: { id: 'default' },
          actions: isPaused
            ? [
                { title: 'Resume', pressAction: { id: 'resume' } },
                { title: 'Stop', pressAction: { id: 'stop' } },
              ]
            : [
                { title: 'Pause', pressAction: { id: 'pause' } },
                { title: 'Stop', pressAction: { id: 'stop' } },
              ],
        },
      });
    } catch {
      // Suppress transient background UI update drops
    }
  }

  public stopService(): Promise<void> {
    this.actionQueue = this.actionQueue.then(async () => {
      if (!this.isRunning) return;

      // Allow Android OS at least 500ms to complete its native onStartCommand/startForeground handshake
      const elapsed = Date.now() - this.lastStartTime;
      if (elapsed < 500) {
        await new Promise((res) => setTimeout(res, 500 - elapsed));
      }

      try {
        await notifee.stopForegroundService();
        await notifee.cancelNotification('recording_ongoing');
      } catch (error) {
        console.warn('[ForegroundServiceManager] stopService error:', error);
      } finally {
        this.isRunning = false;
      }
    });

    return this.actionQueue;
  }
}

export const ForegroundServiceManager = new ForegroundServiceManagerImpl();