// src/services/audio/ForegroundServiceManager.ts
import { Platform, PermissionsAndroid } from 'react-native';
import notifee, {
  AndroidImportance,
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
  private channelId = 'studio_recording_channel';
  private isInitialized = false;
  private isRunning = false;
  private lastStartTime = 0;
  private isPaused = false;
  private currentPresetBadge = 'WAV';
  private lastTimerText = '00:00';
  private handlers: ServiceHandlers = {};
  private actionQueue: Promise<void> = Promise.resolve();

  constructor() {
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

  private async renderNotification(): Promise<void> {
    if (!this.isRunning) return;

    const actions = this.isPaused
      ? [
          { title: 'Resume', pressAction: { id: 'resume' } },
          { title: 'Stop', pressAction: { id: 'stop' } },
        ]
      : [
          { title: 'Pause', pressAction: { id: 'pause' } },
          { title: 'Stop', pressAction: { id: 'stop' } },
        ];

    try {
      await notifee.displayNotification({
        id: 'recording_ongoing',
        title: this.isPaused ? 'Paused' : 'Recording',
        body: `${this.lastTimerText} • ${this.currentPresetBadge}`,
        android: {
          channelId: this.channelId,
          asForegroundService: true,
          color: '#27272A',
          ongoing: true,
          onlyAlertOnce: true,
          pressAction: { id: 'default' },
          actions,
        },
      });
    } catch {}
  }

  private async handleNotificationAction(type: EventType, detail: any) {
    if (type === EventType.ACTION_PRESS && detail.pressAction) {
      const actionId = detail.pressAction.id;
      if (actionId === 'pause') {
        this.isPaused = true;
        await this.renderNotification();
        if (this.handlers.onPause) await this.handlers.onPause();
      } else if (actionId === 'resume') {
        this.isPaused = false;
        await this.renderNotification();
        if (this.handlers.onResume) await this.handlers.onResume();
      } else if (actionId === 'stop') {
        if (this.handlers.onStop) await this.handlers.onStop();
        await this.stopService();
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

      if (Platform.OS === 'android') {
        const hasMicPermission = await PermissionsAndroid.check(
          PermissionsAndroid.PERMISSIONS.RECORD_AUDIO
        );
        if (!hasMicPermission) return;
      }

      await this.initialize();

      this.currentPresetBadge = presetBadge;
      this.lastTimerText = '00:00';
      this.isPaused = false;

      await notifee.displayNotification({
        id: 'recording_ongoing',
        title: 'Recording',
        body: `00:00 • ${presetBadge}`,
        android: {
          channelId: this.channelId,
          asForegroundService: true,
          foregroundServiceTypes: [
            AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_MICROPHONE,
          ],
          color: '#27272A',
          ongoing: true,
          onlyAlertOnce: true,
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
    if (!this.isRunning) return;
    this.lastTimerText = timerText;
    this.currentPresetBadge = presetBadge;
    this.isPaused = isPaused;
    await this.renderNotification();
  }

  public stopService(): Promise<void> {
    this.actionQueue = this.actionQueue.then(async () => {
      if (!this.isRunning) return;

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
        this.isPaused = false;
      }
    });

    return this.actionQueue;
  }
}

export const ForegroundServiceManager = new ForegroundServiceManagerImpl();