// src/services/audio/ForegroundServiceManager.ts
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
  private isStarting = false;
  private lastStartTime = 0;
  private handlers: ServiceHandlers = {};

  constructor() {
    // Keep the task runner open for the lifetime of the recording
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

  public async startService(presetBadge: string): Promise<void> {
    if (this.isRunning || this.isStarting) return;
    this.isStarting = true;

    try {
      await this.initialize();

      // Explicitly pass FOREGROUND_SERVICE_TYPE_MICROPHONE (128 / 0x80)
      // to match android:foregroundServiceType="microphone" in the manifest
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
          pressAction: {
            id: 'default',
          },
          actions: [
            {
              title: 'Pause',
              pressAction: { id: 'pause' },
            },
            {
              title: 'Stop',
              pressAction: { id: 'stop' },
            },
          ],
        },
      });

      this.isRunning = true;
      this.lastStartTime = Date.now();
    } catch (error) {
      console.error('[ForegroundServiceManager] startService failed:', error);
      this.isRunning = false;
      throw error;
    } finally {
      this.isStarting = false;
    }
  }

  public async updateProgress(timerText: string, presetBadge: string, isPaused: boolean): Promise<void> {
    if (!this.isRunning || this.isStarting) return;

    try {
      await notifee.displayNotification({
        id: 'recording_ongoing',
        title: isPaused ? 'Recording Paused' : 'Recording Active',
        body: `${timerText} • ${presetBadge}`,
        android: {
          channelId: this.channelId,
          asForegroundService: true,
          foregroundServiceTypes: [
            AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_MICROPHONE,
          ],
          color: isPaused ? AndroidColor.ORANGE : AndroidColor.RED,
          ongoing: true,
          pressAction: {
            id: 'default',
          },
          actions: isPaused
            ? [
                {
                  title: 'Resume',
                  pressAction: { id: 'resume' },
                },
                {
                  title: 'Stop',
                  pressAction: { id: 'stop' },
                },
              ]
            : [
                {
                  title: 'Pause',
                  pressAction: { id: 'pause' },
                },
                {
                  title: 'Stop',
                  pressAction: { id: 'stop' },
                },
              ],
        },
      });
    } catch (e) {
      // Ignore background UI update drops
    }
  }

  public async stopService(): Promise<void> {
    // 1. Wait if startService is currently in flight
    if (this.isStarting) {
      let attempts = 0;
      while (this.isStarting && attempts < 20) {
        await new Promise((res) => setTimeout(res, 50));
        attempts++;
      }
    }

    // 2. Ensure Android had at least 250ms to call Service.startForeground()
    const elapsedSinceStart = Date.now() - this.lastStartTime;
    if (elapsedSinceStart < 250) {
      await new Promise((res) => setTimeout(res, 250 - elapsedSinceStart));
    }

    if (!this.isRunning) return;

    try {
      this.isRunning = false;
      await notifee.stopForegroundService();
      await notifee.cancelNotification('recording_ongoing');
    } catch (error) {
      console.warn('[ForegroundServiceManager] stopService error:', error);
    }
  }
}

export const ForegroundServiceManager = new ForegroundServiceManagerImpl();