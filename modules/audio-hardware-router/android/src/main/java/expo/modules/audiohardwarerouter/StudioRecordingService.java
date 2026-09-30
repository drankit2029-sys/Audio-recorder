package expo.modules.audiohardwarerouter;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.graphics.drawable.Icon;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import java.util.Locale;

/**
 * Foreground service that keeps a studio session alive in the background and
 * owns its notification. The notification is rebuilt natively once a second,
 * so the timecode keeps running even while the JS thread is throttled, and it
 * looks the same for every output format because capture is always PCM.
 */
public class StudioRecordingService extends Service {

    private static final String TAG = "StudioRecordingService";

    static final String ACTION_START = "expo.modules.audiohardwarerouter.studio.START";
    static final String ACTION_PAUSE = "expo.modules.audiohardwarerouter.studio.PAUSE";
    static final String ACTION_RESUME = "expo.modules.audiohardwarerouter.studio.RESUME";
    static final String ACTION_STOP = "expo.modules.audiohardwarerouter.studio.STOP";

    static final String CHANNEL_ID = "studio_session";
    /** Channel used by the Notifee-based service in earlier builds. */
    private static final String LEGACY_CHANNEL_ID = "studio_recording_channel";
    static final int NOTIFICATION_ID = 0x5D10;

    /** Matches the app chrome (#121215 cards on a black canvas). */
    private static final int COLOR_SURFACE = 0xFF121215;
    private static final int COLOR_CHIP = 0xFF1E1E24;
    private static final int COLOR_RED = 0xFFEF4444;
    private static final int COLOR_WHITE = 0xFFFAFAFA;
    private static final int COLOR_MUTED = 0xFF8E8E93;

    private static volatile StudioRecordingService current;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable ticker = new Runnable() {
        @Override
        public void run() {
            refreshNow();
            handler.postDelayed(this, 1000L);
        }
    };
    private final Runnable refreshOnce = new Runnable() {
        @Override
        public void run() {
            refreshNow();
        }
    };

    private boolean inForeground = false;
    private int lastIconKey = -1;
    private Bitmap lastIcon;

    /** Asks the live service (if any) to redraw the notification right away. */
    static void requestRefresh() {
        StudioRecordingService s = current;
        if (s != null) {
            s.handler.removeCallbacks(s.refreshOnce);
            s.handler.post(s.refreshOnce);
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        current = this;
        ensureChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // The startForeground() contract must be honoured before anything else.
        if (!inForeground) {
            goForeground();
        }
        StudioEngine engine = StudioEngine.peek();
        if (engine == null || !engine.hasSession()) {
            shutdown();
            return START_NOT_STICKY;
        }
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_PAUSE.equals(action)) {
            engine.onNotificationAction("pause");
        } else if (ACTION_RESUME.equals(action)) {
            engine.onNotificationAction("resume");
        } else if (ACTION_STOP.equals(action)) {
            engine.onNotificationAction("stop");
        }
        handler.removeCallbacks(ticker);
        handler.post(ticker);
        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (current == this) {
            current = null;
        }
        StudioEngine engine = StudioEngine.peek();
        if (engine != null) {
            engine.onServiceDestroyed();
        }
        stopForegroundCompat();
        super.onDestroy();
    }

    private void goForeground() {
        try {
            Notification n = build();
            if (Build.VERSION.SDK_INT >= 30) {
                startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
            } else {
                startForeground(NOTIFICATION_ID, n);
            }
            inForeground = true;
        } catch (Throwable t) {
            Log.w(TAG, "startForeground failed", t);
        }
    }

    private void shutdown() {
        handler.removeCallbacksAndMessages(null);
        stopForegroundCompat();
        stopSelf();
    }

    @SuppressWarnings("deprecation")
    private void stopForegroundCompat() {
        if (!inForeground) {
            return;
        }
        try {
            if (Build.VERSION.SDK_INT >= 24) {
                stopForeground(Service.STOP_FOREGROUND_REMOVE);
            } else {
                stopForeground(true);
            }
        } catch (Throwable ignored) {
        }
        inForeground = false;
    }

    private void refreshNow() {
        StudioEngine engine = StudioEngine.peek();
        if (engine == null || !engine.hasSession()) {
            shutdown();
            return;
        }
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) {
                nm.notify(NOTIFICATION_ID, build());
            }
        } catch (Throwable t) {
            Log.w(TAG, "Notification update failed", t);
        }
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < 26) {
            return;
        }
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) {
            return;
        }
        try {
            if (nm.getNotificationChannel(LEGACY_CHANNEL_ID) != null) {
                nm.deleteNotificationChannel(LEGACY_CHANNEL_ID);
            }
        } catch (Throwable ignored) {
        }
        if (nm.getNotificationChannel(CHANNEL_ID) == null) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID, "Recording studio", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Shows the running take with its timer and transport controls.");
            channel.setShowBadge(false);
            channel.setSound(null, null);
            channel.enableVibration(false);
            channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            nm.createNotificationChannel(channel);
        }
    }

    @SuppressWarnings("deprecation")
    private Notification build() {
        StudioEngine engine = StudioEngine.peek();
        int mode = engine != null ? engine.currentMode() : StudioEngine.MODE_PAUSED;
        boolean replacing = engine != null && engine.isOverwriting();
        boolean saving = engine != null && engine.isExporting();
        boolean alive = engine != null && engine.hasSession();
        long positionMs = engine != null ? engine.notificationPositionMs() : 0L;
        String badge = engine != null ? engine.currentBadge() : "";

        String state;
        if (saving) {
            state = "Saving take";
        } else if (mode == StudioEngine.MODE_RECORDING) {
            state = replacing ? "Replacing" : "Recording";
        } else if (mode == StudioEngine.MODE_PREVIEWING) {
            state = "Previewing";
        } else {
            state = "Paused";
        }

        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        b.setSmallIcon(R.drawable.ic_studio_notification)
                .setContentTitle(state + "  \u00B7  " + formatTime(positionMs))
                .setContentText(badge != null && !badge.isEmpty() ? badge : "AudioRecorder studio")
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setCategory(Notification.CATEGORY_SERVICE)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setColor(COLOR_SURFACE)
                .setLargeIcon(largeIcon(saving ? 4 : mode == StudioEngine.MODE_RECORDING
                        ? (replacing ? 1 : 0)
                        : mode == StudioEngine.MODE_PREVIEWING ? 3 : 2));
        PendingIntent content = contentIntent();
        if (content != null) {
            b.setContentIntent(content);
        }
        if (Build.VERSION.SDK_INT >= 26) {
            b.setColorized(true);
        } else {
            b.setPriority(Notification.PRIORITY_LOW);
        }
        if (Build.VERSION.SDK_INT >= 31) {
            b.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        }
        if (alive && !saving) {
            boolean running = mode == StudioEngine.MODE_RECORDING
                    || mode == StudioEngine.MODE_PREVIEWING;
            if (running) {
                b.addAction(action(android.R.drawable.ic_media_pause, "Pause", ACTION_PAUSE, 1));
            } else {
                b.addAction(action(android.R.drawable.ic_media_play, "Resume", ACTION_RESUME, 2));
            }
            b.addAction(action(android.R.drawable.ic_menu_save, "Stop & save", ACTION_STOP, 3));
        }
        return b.build();
    }

    private Notification.Action action(int icon, String title, String intentAction, int requestCode) {
        Intent intent = new Intent(this, StudioRecordingService.class).setAction(intentAction);
        PendingIntent pi = PendingIntent.getService(this, requestCode, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Action.Builder(Icon.createWithResource(this, icon), title, pi).build();
    }

    private PendingIntent contentIntent() {
        try {
            Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
            if (launch == null) {
                return null;
            }
            launch.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
            return PendingIntent.getActivity(this, 0, launch,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        } catch (Throwable t) {
            return null;
        }
    }

    /**
     * Draws the transport glyph the studio uses: red dot while recording (with
     * a white ring while replacing), pause bars, a play triangle, or a muted
     * dot while saving.
     */
    private Bitmap largeIcon(int key) {
        if (key == lastIconKey && lastIcon != null) {
            return lastIcon;
        }
        int size = 128;
        Bitmap bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(bmp);
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        float cx = size / 2f;
        float cy = size / 2f;

        p.setColor(COLOR_CHIP);
        c.drawCircle(cx, cy, size / 2f, p);
        p.setStyle(Paint.Style.STROKE);
        p.setStrokeWidth(3f);
        p.setColor(0xFF2A2A30);
        c.drawCircle(cx, cy, size / 2f - 2f, p);
        p.setStyle(Paint.Style.FILL);

        switch (key) {
            case 0:
            case 1: {
                p.setColor(COLOR_RED);
                c.drawCircle(cx, cy, size * 0.21f, p);
                if (key == 1) {
                    p.setStyle(Paint.Style.STROKE);
                    p.setStrokeWidth(5f);
                    p.setColor(COLOR_WHITE);
                    c.drawCircle(cx, cy, size * 0.31f, p);
                    p.setStyle(Paint.Style.FILL);
                }
                break;
            }
            case 2: {
                p.setColor(COLOR_WHITE);
                float barW = size * 0.085f;
                float barH = size * 0.34f;
                float gap = size * 0.07f;
                RectF left = new RectF(cx - gap / 2f - barW, cy - barH / 2f, cx - gap / 2f, cy + barH / 2f);
                RectF right = new RectF(cx + gap / 2f, cy - barH / 2f, cx + gap / 2f + barW, cy + barH / 2f);
                c.drawRoundRect(left, barW / 2f, barW / 2f, p);
                c.drawRoundRect(right, barW / 2f, barW / 2f, p);
                break;
            }
            case 3: {
                p.setColor(COLOR_WHITE);
                float h = size * 0.34f;
                Path tri = new Path();
                tri.moveTo(cx - h * 0.36f, cy - h / 2f);
                tri.lineTo(cx + h * 0.56f, cy);
                tri.lineTo(cx - h * 0.36f, cy + h / 2f);
                tri.close();
                c.drawPath(tri, p);
                break;
            }
            default: {
                p.setColor(COLOR_MUTED);
                c.drawCircle(cx, cy, size * 0.16f, p);
                break;
            }
        }
        lastIconKey = key;
        lastIcon = bmp;
        return bmp;
    }

    private static String formatTime(long ms) {
        long total = Math.max(0L, ms) / 1000L;
        long h = total / 3600L;
        long m = (total % 3600L) / 60L;
        long s = total % 60L;
        if (h > 0) {
            return String.format(Locale.US, "%d:%02d:%02d", h, m, s);
        }
        return String.format(Locale.US, "%02d:%02d", m, s);
    }
}
