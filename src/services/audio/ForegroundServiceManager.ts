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

const NOTIFICATION_ID = 'recording_ongoing';

/** Neutral accent: white-on-white and black-on-black accents are both invisible. */
const ACCENT = '#A1A1AA';

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
    notifee.registerForegroundService(() => new Promise(() => {}));

    notifee.onBackgroundEvent(async ({ type, detail }: Event) => {
      await this.handleNotificationAction(type, detail);
    });

    notifee.onForegroundEvent(async ({ type, detail }: Event) => {
      await this.handleNotificationAction(type, detail);
    });
  }

  private buildActions() {
    return this.isPaused
      ? [
          { title: 'Resume', pressAction: { id: 'resume' } },
          { title: 'Stop & save', pressAction: { id: 'stop' } },
        ]
      : [
          { title: 'Pause', pressAction: { id: 'pause' } },
          { title: 'Stop & save', pressAction: { id: 'stop' } },
        ];
  }

  private async renderNotification(): Promise<void> {
    if (!this.isRunning) return;

    const timecode = this.lastTimerText;
    // Notifee 9 dropped `subText`, so the format badge is folded into the body
    // rather than being silently discarded.
    const body = `${timecode}  ·  ${this.currentPresetBadge}  ·  ${
      this.isPaused ? 'paused, tap to return to the studio' : 'recording, tap to return to the studio'
    }`;

    try {
      await notifee.displayNotification({
        id: NOTIFICATION_ID,
        title: this.isPaused ? 'Capture Paused' : 'Capturing Audio',
        body,
        android: {
          channelId: this.channelId,
          asForegroundService: true,
          foregroundServiceTypes: [
            AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_MICROPHONE,
          ],
          color: ACCENT,
          colorized: false,
          ongoing: true,
          autoCancel: false,
          onlyAlertOnce: true,
          showTimestamp: true,
          timestamp: this.lastStartTime,
          ticker: this.isPaused ? 'Recording paused' : 'Recording started',
          pressAction: { id: 'default', launchActivity: 'default' },
          actions: this.buildActions(),
        },
      });
    } catch (err) {
      console.warn('[ForegroundServiceManager] renderNotification failed:', err);
    }
  }

  private async handleNotificationAction(type: EventType, detail: any) {
    if (type !== EventType.ACTION_PRESS || !detail?.pressAction) return;

    const actionId = detail.pressAction.id;

    if (actionId === 'pause') {
      this.isPaused = true;
      if (this.handlers.onPause) await this.handlers.onPause();
      await this.renderNotification();
    } else if (actionId === 'resume') {
      this.isPaused = false;
      if (this.handlers.onResume) await this.handlers.onResume();
      await this.renderNotification();
    } else if (actionId === 'stop') {
      if (this.handlers.onStop) await this.handlers.onStop();
      await this.stopService();
    }
  }

  public async initialize(): Promise<void> {
    if (this.isInitialized) return;
    try {
      await notifee.createChannel({
        id: this.channelId,
        name: 'Studio Recording',
        description: 'Shows an ongoing notification while audio is being captured.',
        lights: false,
        vibration: false,
        badge: false,
        sound: undefined,
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
    this.actionQueue = this.actionQueue
      .then(async () => {
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
        this.lastStartTime = Date.now();
        this.isRunning = true;

        await this.renderNotification();
      })
      .catch((err) => {
        console.error('[ForegroundServiceManager] startService failed:', err);
        this.isRunning = false;
      });

    return this.actionQueue;
  }

  public async updateProgress(
    timerText: string,
    presetBadge: string,
    isPaused: boolean
  ): Promise<void> {
    if (!this.isRunning) return;

    const changed = isPaused !== this.isPaused || presetBadge !== this.currentPresetBadge;
    this.lastTimerText = timerText;
    this.currentPresetBadge = presetBadge;
    this.isPaused = isPaused;

    if (changed || timerText.endsWith('0')) {
      await this.renderNotification();
    }
  }

  public stopService(): Promise<void> {
    this.actionQueue = this.actionQueue.then(async () => {
      if (!this.isRunning) return;

      // A service that is torn down immediately after being started can trip
      // Android's "foreground service did not start in time" check, so a very
      // short take still waits a moment. 300 ms is enough and, unlike the
      // previous 500 ms blanket sleep, is not felt on a normal stop.
      const MIN_VISIBLE_MS = 300;
      const elapsed = Date.now() - this.lastStartTime;
      if (elapsed < MIN_VISIBLE_MS) {
        await new Promise((res) => setTimeout(res, MIN_VISIBLE_MS - elapsed));
      }

      try {
        await notifee.stopForegroundService();
        await notifee.cancelNotification(NOTIFICATION_ID);
      } catch (error) {
        console.warn('[ForegroundServiceManager] stopService error:', error);
      } finally {
        this.isRunning = false;
        this.isPaused = false;
        this.lastTimerText = '00:00';
      }
    });

    return this.actionQueue;
  }
}

export const ForegroundServiceManager = new ForegroundServiceManagerImpl();
