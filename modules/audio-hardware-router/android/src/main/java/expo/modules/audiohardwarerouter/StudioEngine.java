package expo.modules.audiohardwarerouter;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.AudioAttributes;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioFocusRequest;
import android.media.AudioFormat;
import android.media.AudioRecordingConfiguration;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.AudioTrack;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import android.os.SystemClock;
import android.util.Log;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Process-wide studio session: one working WAV file that is recorded into,
 * overwritten ("Replace"), previewed and finally encoded into the take.
 *
 * It is a singleton on purpose. The React module is only an event sink, so a
 * JS reload (or a destroyed activity) never stops a recording: the new JS
 * context asks {@link #getStatus()} and re-attaches to the running session.
 *
 * Threading: public mutators are synchronized on this object. The capture and
 * playback threads never take that lock (they are joined while it is held);
 * they only touch the file under {@link #ioLock}, the peak table under
 * {@link #peaksLock}, and volatile position fields. Anything they need to
 * change in the state machine is posted to {@link #control}.
 */
final class StudioEngine {

    static final String TAG = "StudioEngine";

    static final String EVENT_STATE = "studioState";
    static final String EVENT_METER = "studioMeter";
    static final String EVENT_PROGRESS = "studioProgress";
    static final String EVENT_ERROR = "studioError";
    static final String EVENT_NOTIFICATION = "studioNotificationAction";
    /** A call, another capture client, headphones being ripped out, screen off... */
    static final String EVENT_INTERRUPTION = "studioInterruption";

    static final int MODE_IDLE = 0;
    static final int MODE_PAUSED = 1;
    static final int MODE_RECORDING = 2;
    static final int MODE_PREVIEWING = 3;

    /** Resolution of the waveform peak table. */
    static final int PEAK_BUCKET_MS = 20;

    /** Signed-int safe RIFF ceiling (see WavRecorderModule for the reasoning). */
    static final long MAX_DATA_BYTES = 0x7FFFFFF0L;

    private static final long METER_INTERVAL_MS = 16L;
    private static final long HEADER_PATCH_INTERVAL_MS = 2000L;

    interface Sink {
        void emit(String event, Map<String, Object> payload);
    }

    private static StudioEngine instance;

    static synchronized StudioEngine get(Context context) {
        if (instance == null) {
            instance = new StudioEngine(context.getApplicationContext());
        }
        return instance;
    }

    static synchronized StudioEngine peek() {
        return instance;
    }

    private final Context app;
    private final AudioManager audioManager;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService control = Executors.newSingleThreadExecutor();
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    private volatile Sink sink;

    // ---- session ---------------------------------------------------------
    private volatile boolean hasSession = false;
    private volatile int mode = MODE_IDLE;
    private volatile boolean exporting = false;
    private volatile boolean opening = false;
    private volatile String badge = "";
    private volatile boolean hasEdits = false;
    private String sessionId;
    private File sessionFile;
    private volatile int sampleRate = 48000;
    private volatile int channels = 1;
    private volatile boolean floatPcm = false;
    private volatile int frameBytes = 2;
    private volatile int framesPerBucket = 960;

    private final Object ioLock = new Object();
    /** Guarded by {@link #ioLock}. */
    private RandomAccessFile raf;
    private volatile long dataBytes = 0L;
    private volatile long positionFrames = 0L;
    private volatile long writeFrame = 0L;
    private volatile long playFrame = 0L;
    private volatile boolean overwriting = false;
    private volatile long overwriteEndFrame = 0L;

    // ---- waveform peaks ----------------------------------------------------
    private final Object peaksLock = new Object();
    private byte[] peaks = new byte[4096];
    private int peakCount = 0;
    private int dirtyStart = Integer.MAX_VALUE;
    private int dirtyEnd = -1;

    /** Bucket tracker for the capture thread (handed over via start/join). */
    private long trkFrame = 0L;
    private int trkBucket = 0;
    private float trkPeak = 0f;

    // ---- capture / playback --------------------------------------------------
    private AudioRecord recorder;
    private Thread captureThread;
    private volatile boolean captureRun = false;
    private AudioTrack track;
    private Thread playThread;
    private volatile boolean playRun = false;
    /** Set by the playback thread once AudioTrack.play() returned cleanly. */
    private volatile boolean playStartedOk = false;
    private long playStartFrame = 0L;
    private int generation = 0;

    /**
     * Microphone that has been opened but is stopped, kept across
     * pause/resume and between takes. Reopening an AudioRecord takes
     * 200-500 ms on many devices, and that cost used to be paid on every
     * start/resume: the first ~0.3 s of the segment had no audio while the
     * UI was already running. A stopped AudioRecord captures nothing and
     * idles at ~zero power, so holding it is cheap.
     */
    private AudioRecord warmRecorder;
    private CaptureConfig warmConfig;
    private int warmDeviceId = Integer.MIN_VALUE;
    private int activeDeviceId = Integer.MIN_VALUE;
    private CaptureConfig activeConfig;

    /**
     * Same idea as {@link #warmRecorder}, for the other side of the studio: an
     * AudioTrack is kept open (paused and flushed) between preview passes, so
     * switching to preview costs a flush+play instead of the 50-200 ms it takes
     * to build an AudioTrack and negotiate a mix with the audio service. The
     * track is only reused while the session format still matches.
     */
    private AudioTrack warmTrack;
    private int warmTrackRate = 0;
    private int warmTrackChannels = 0;
    private boolean warmTrackFloat = false;
    /** True once a warmed track has actually been started: it can be reused. */
    private boolean warmTrackPrimed = false;

    private boolean focusHeld = false;
    private Object focusRequest;
    private boolean serviceRequested = false;

    // ---- interference watchers ---------------------------------------------
    /**
     * A pause requested because something else took the audio path (a call,
     * an alarm, another capture app). Very short losses are ignored: many
     * devices drop focus for a few tens of ms when routing changes, and
     * pausing there would be more annoying than helpful.
     */
    private static final long FOCUS_PAUSE_AFTER_MS = 900L;
    private long focusLostAt = 0L;
    private boolean interruptionWatchersOn = false;
    private Object recordingCallback;
    private AudioDeviceCallback studioDeviceCallback;
    private BroadcastReceiver interruptionReceiver;

    private final Runnable deferredFocusPause = new Runnable() {
        @Override
        public void run() {
            long elapsed = SystemClock.elapsedRealtime() - focusLostAt;
            if (focusLostAt == 0L || elapsed < FOCUS_PAUSE_AFTER_MS) {
                return;
            }
            control.execute(new Runnable() {
                @Override
                public void run() {
                    synchronized (StudioEngine.this) {
                        int m = mode;
                        if (focusLostAt == 0L || (m != MODE_RECORDING && m != MODE_PREVIEWING)) {
                            return;
                        }
                        boolean wasRecording = m == MODE_RECORDING;
                        pause("focus_loss");
                        if (wasRecording) {
                            emitInterruption("focus_loss", true);
                        }
                    }
                }
            });
        }
    };

    private final AudioManager.OnAudioFocusChangeListener focusListener =
            new AudioManager.OnAudioFocusChangeListener() {
                @Override
                public void onAudioFocusChange(int change) {
                    if (change == AudioManager.AUDIOFOCUS_GAIN) {
                        focusLostAt = 0L;
                        main.removeCallbacks(deferredFocusPause);
                        return;
                    }
                    boolean permanent = change == AudioManager.AUDIOFOCUS_LOSS;
                    boolean transientLoss = change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT
                            || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK;
                    if (!permanent && !transientLoss) {
                        return;
                    }
                    if (transientLoss && !permanent) {
                        focusLostAt = SystemClock.elapsedRealtime();
                        main.removeCallbacks(deferredFocusPause);
                        main.postDelayed(deferredFocusPause, FOCUS_PAUSE_AFTER_MS);
                        return;
                    }
                    focusLostAt = 0L;
                    main.removeCallbacks(deferredFocusPause);
                    if (mode == MODE_PREVIEWING || mode == MODE_RECORDING) {
                        control.execute(new Runnable() {
                            @Override
                            public void run() {
                                boolean wasRecording = mode == MODE_RECORDING;
                                pause("focus_loss");
                                if (wasRecording) {
                                    emitInterruption("focus_loss", true);
                                }
                            }
                        });
                    }
                }
            };

    private StudioEngine(Context app) {
        this.app = app;
        this.audioManager = (AudioManager) app.getSystemService(Context.AUDIO_SERVICE);
    }

    // =======================================================================
    // Sink
    // =======================================================================

    void attachSink(Sink s) {
        sink = s;
        synchronized (peaksLock) {
            dirtyStart = Integer.MAX_VALUE;
            dirtyEnd = -1;
        }
    }

    void detachSink(Sink s) {
        if (sink == s) {
            sink = null;
        }
    }

    boolean hasSink() {
        return sink != null;
    }

    void runIo(Runnable r) {
        io.execute(r);
    }

    // =======================================================================
    // Session lifecycle
    // =======================================================================

    synchronized Map<String, Object> createSession(int rate, int ch, boolean wantFloat,
                                                   String badgeText) throws IOException {
        if (hasSession || opening) {
            throw new IllegalStateException("A studio session is already open.");
        }
        if (rate < 4000 || rate > 192000) {
            throw new IllegalArgumentException("Unsupported sample rate " + rate);
        }
        int channelCount = ch == 2 ? 2 : 1;
        File dir = sessionsDir();
        dir.mkdirs();
        String id = "take_" + System.currentTimeMillis();
        File file = new File(dir, id + ".wav");
        RandomAccessFile r = new RandomAccessFile(file, "rw");
        try {
            r.setLength(0L);
            r.write(StudioCodec.buildHeader(rate, channelCount, wantFloat, 0L));
        } catch (IOException e) {
            try {
                r.close();
            } catch (IOException ignored) {
            }
            file.delete();
            throw e;
        }
        synchronized (ioLock) {
            raf = r;
        }
        applyFormat(rate, channelCount, wantFloat);
        sessionId = id;
        sessionFile = file;
        dataBytes = 0L;
        positionFrames = 0L;
        writeFrame = 0L;
        playFrame = 0L;
        overwriting = false;
        hasEdits = false;
        resetPeaks();
        badge = badgeText != null ? badgeText : "";
        hasSession = true;
        mode = MODE_PAUSED;
        startInterruptionWatchers();
        return sessionInfoLocked();
    }

    Map<String, Object> openSession(String sourcePath, boolean recover, String badgeText,
                                    final StudioCodec.Progress progress) throws Exception {
        synchronized (this) {
            if (hasSession || opening) {
                throw new IllegalStateException("A studio session is already open.");
            }
            opening = true;
        }
        File target = null;
        RandomAccessFile r = null;
        boolean createdTarget = false;
        try {
            File src = new File(normalizePath(sourcePath));
            if (!src.exists()) {
                throw new IOException("The recording file no longer exists.");
            }
            int rate;
            int ch;
            boolean flt;
            long bytes;
            String sourceMime;
            int sourceBitRate;
            StudioCodec.WavInfo info = null;
            if (recover) {
                try {
                    info = StudioCodec.parseWav(src);
                } catch (IOException notWav) {
                    info = null;
                }
            }
            if (recover && info != null && info.isWorkingLayout()) {
                target = src;
                rate = info.sampleRate;
                ch = info.channels;
                flt = info.formatTag == 3;
                int fb = ch * (flt ? 4 : 2);
                long pcm = Math.max(0L, src.length() - StudioCodec.HEADER_BYTES);
                bytes = pcm - (pcm % fb);
                File volume = src.getParentFile();
                if (volume != null && volume.getUsableSpace() <= 0L) {
                    throw new IOException("Storage is full - this take cannot be opened for editing.");
                }
                r = new RandomAccessFile(src, "rw");
                if (pcm - bytes > 4L * fb) {
                    r.setLength(StudioCodec.HEADER_BYTES + bytes);
                }
                StudioCodec.patchSizes(r, bytes);
                sourceMime = "audio/wav";
                sourceBitRate = rate * ch * (flt ? 32 : 16);
                if (progress != null) {
                    progress.onProgress(0.1f);
                }
            } else {
                File dir = sessionsDir();
                dir.mkdirs();
                target = new File(dir, "edit_" + System.currentTimeMillis() + ".wav");
                createdTarget = true;
                StudioCodec.ImportResult ir = StudioCodec.importToWorkingFile(src, target,
                        new StudioCodec.Progress() {
                            @Override
                            public void onProgress(float fraction) {
                                if (progress != null) {
                                    progress.onProgress(0.8f * fraction);
                                }
                            }
                        });
                rate = ir.sampleRate;
                ch = ir.channels;
                flt = ir.floatPcm;
                bytes = ir.dataBytes;
                sourceMime = ir.sourceMime;
                sourceBitRate = ir.sourceBitRate;
                r = new RandomAccessFile(target, "rw");
            }

            final int fpb = Math.max(1, rate * PEAK_BUCKET_MS / 1000);
            final float base = createdTarget ? 0.8f : 0.1f;
            synchronized (peaksLock) {
                peaks = new byte[4096];
                peakCount = 0;
                dirtyStart = Integer.MAX_VALUE;
                dirtyEnd = -1;
            }
            StudioCodec.scanBucketPeaks(target, ch, flt, bytes, fpb,
                    new StudioCodec.BucketConsumer() {
                        @Override
                        public void onBucket(int bucketIndex, float peak) {
                            storePeak(bucketIndex, peak, false);
                        }
                    },
                    new StudioCodec.Progress() {
                        @Override
                        public void onProgress(float fraction) {
                            if (progress != null) {
                                progress.onProgress(base + (1f - base) * fraction);
                            }
                        }
                    });

            synchronized (this) {
                synchronized (ioLock) {
                    raf = r;
                }
                applyFormat(rate, ch, flt);
                String name = target.getName();
                int dot = name.lastIndexOf('.');
                sessionId = dot > 0 ? name.substring(0, dot) : name;
                sessionFile = target;
                dataBytes = bytes;
                long total = bytes / frameBytes;
                positionFrames = recover ? total : 0L;
                writeFrame = positionFrames;
                playFrame = positionFrames;
                overwriting = false;
                hasEdits = recover;
                badge = badgeText != null ? badgeText : "";
                hasSession = true;
                mode = MODE_PAUSED;
                opening = false;
                startInterruptionWatchers();
                Map<String, Object> result = sessionInfoLocked();
                result.put("sourceMime", sourceMime);
                result.put("sourceBitRate", sourceBitRate);
                return result;
            }
        } catch (Throwable t) {
            synchronized (this) {
                opening = false;
            }
            if (r != null) {
                try {
                    r.close();
                } catch (IOException ignored) {
                }
            }
            if (createdTarget && target != null) {
                target.delete();
            }
            resetPeaks();
            if (t instanceof Exception) {
                throw (Exception) t;
            }
            if (t instanceof OutOfMemoryError) {
                throw new IOException("Not enough memory to open this take.");
            }
            throw (Error) t;
        }
    }

    Map<String, Object> finalizeSession(String targetPath, String format, int bitRate,
                                        int wantRate, int wantCh,
                                        StudioCodec.Progress progress) throws Exception {
        File file;
        int rate;
        int ch;
        boolean flt;
        long bytes;
        synchronized (this) {
            requireUsableSession();
            stopActivityLocked();
            if (dataBytes <= 0L) {
                throw new IllegalStateException("Nothing has been recorded yet.");
            }
            exporting = true;
            synchronized (ioLock) {
                patchHeaderLocked();
                if (raf != null) {
                    try {
                        raf.getFD().sync();
                    } catch (IOException ignored) {
                    }
                }
            }
            file = sessionFile;
            rate = sampleRate;
            ch = channels;
            flt = floatPcm;
            bytes = dataBytes;
        }
        refreshService();

        File target = new File(normalizePath(targetPath));
        File parent = target.getParentFile();
        if (parent != null && !parent.exists()) {
            parent.mkdirs();
        }
        File part = new File(target.getAbsolutePath() + ".part");
        part.delete();
        String fmt = format != null ? format : "wav";
        boolean movedWorkingFile = false;
        try {
            if (!StudioCodec.isLossy(fmt)) {
                synchronized (ioLock) {
                    closeRafLocked();
                }
                if (file.renameTo(part)) {
                    movedWorkingFile = true;
                } else {
                    copyFile(file, part);
                }
                if (progress != null) {
                    progress.onProgress(0.9f);
                }
            } else {
                StudioCodec.encode(file, rate, ch, flt, bytes, part, fmt, bitRate, wantRate,
                        wantCh, progress);
            }
            if (!part.renameTo(target)) {
                File backup = new File(target.getAbsolutePath() + ".bak");
                backup.delete();
                boolean hadTarget = target.exists() && target.renameTo(backup);
                if (!part.renameTo(target)) {
                    if (hadTarget) {
                        backup.renameTo(target);
                    }
                    throw new IOException("Could not move the finished take into place.");
                }
                if (hadTarget) {
                    backup.delete();
                }
            }
        } catch (Exception e) {
            if (movedWorkingFile && part.exists() && !file.exists()) {
                part.renameTo(file);
            } else {
                part.delete();
            }
            synchronized (this) {
                exporting = false;
                reopenRafLocked();
            }
            refreshService();
            throw e;
        }

        long size = target.length();
        long durationMs = framesToMs(bytes / (ch * (flt ? 4 : 2)), rate);
        synchronized (this) {
            exporting = false;
            closeSessionLocked(true);
        }
        Map<String, Object> result = new HashMap<>();
        result.put("path", target.getAbsolutePath());
        result.put("sizeBytes", (double) size);
        result.put("durationMs", (double) durationMs);
        return result;
    }

    synchronized void discardSession() {
        if (exporting) {
            throw new IllegalStateException("The take is being saved.");
        }
        if (!hasSession) {
            return;
        }
        closeSessionLocked(true);
    }

    synchronized void setBadge(String text) {
        badge = text != null ? text : "";
        refreshService();
    }

    // =======================================================================
    // Transport
    // =======================================================================

    private static final long MIN_FREE_CAPTURE_BYTES = 2L * 1024 * 1024;
    private static final long DISK_POLL_INTERVAL_MS = 5000L;

    synchronized Map<String, Object> record(double positionMs, int inputDeviceId) throws Exception {
        requireUsableSession();
        stopActivityLocked();
        long total = dataBytes / frameBytes;
        long start = positionMs < 0 ? total : Math.max(0L, Math.min(total, msToFrames(positionMs)));
        if (start >= total && dataBytes >= MAX_DATA_BYTES) {
            throw new IOException("This take reached the maximum WAV size.");
        }
        File volume = sessionFile;
        if (start >= total && volume != null && volume.getUsableSpace() < MIN_FREE_CAPTURE_BYTES) {
            throw new IOException("Storage is full - free up some space before recording.");
        }

        CaptureConfig cc = null;
        AudioRecord rec = null;
        boolean fromWarm = false;
        AudioRecord warm = warmRecorder;
        if (warm != null && warm.getState() != AudioRecord.STATE_INITIALIZED) {
            releaseQuietly(warm);
            warmRecorder = null;
            warmConfig = null;
            warmDeviceId = Integer.MIN_VALUE;
            warm = null;
        }
        if (warm != null && warmDeviceId == inputDeviceId) {
            rec = warm;
            cc = warmConfig;
            fromWarm = true;
            warmRecorder = null;
            warmConfig = null;
            warmDeviceId = Integer.MIN_VALUE;
        }
        if (rec == null) {
            if (warm != null) {
                releaseQuietly(warm);
                warmRecorder = null;
                warmConfig = null;
                warmDeviceId = Integer.MIN_VALUE;
            }
            cc = openRecorder(inputDeviceId);
            rec = cc.record;
        }
        try {
            rec.startRecording();
        } catch (Throwable t) {
            if (fromWarm) {
                releaseQuietly(rec);
                try {
                    cc = openRecorder(inputDeviceId);
                    rec = cc.record;
                    rec.startRecording();
                    fromWarm = false;
                } catch (Throwable t2) {
                    releaseQuietly(rec);
                    throw new IOException("The microphone could not start: " + t2.getMessage());
                }
            } else {
                releaseQuietly(rec);
                throw new IOException("The microphone could not start: " + t.getMessage());
            }
        }
        if (rec.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) {
            releaseQuietly(rec);
            throw new IOException("The microphone is being used by another app.");
        }

        recorder = rec;
        activeConfig = cc;
        activeDeviceId = inputDeviceId;
        writeFrame = start;
        overwriteEndFrame = total;
        overwriting = start < total;
        initTracker(start);
        captureRun = true;
        final int gen = ++generation;
        captureThread = new Thread(new CaptureWorker(cc, gen, start), "StudioCapture");
        captureThread.start();
        mode = MODE_RECORDING;
        hasEdits = true;
        requestFocus();
        ensureService();
        emitState(overwriting ? "replace" : "record");
        return snapshotLocked();
    }

    synchronized void play(double positionMs) throws Exception {
        requireUsableSession();
        stopActivityLocked();
        long total = dataBytes / frameBytes;
        long start = Math.max(0L, Math.min(total, msToFrames(positionMs)));
        if (total - start <= 0L) {
            throw new IllegalStateException("There is nothing to play after this position.");
        }
        AudioTrack t = takeWarmTrack();
        if (t == null) {
            t = buildTrack();
        }
        if (t.getState() != AudioTrack.STATE_INITIALIZED) {
            try {
                t.release();
            } catch (Throwable ignored) {
            }
            throw new IOException("The audio output could not be opened.");
        }
        track = t;
        playStartedOk = false;
        playStartFrame = start;
        playFrame = start;
        positionFrames = start;
        playRun = true;
        final int gen = ++generation;
        requestFocus();
        playThread = new Thread(new PlaybackWorker(t, start, total, gen), "StudioPlayback");
        playThread.start();
        mode = MODE_PREVIEWING;
        emitState("play");
        refreshService();
    }

    synchronized Map<String, Object> pause(String reason) {
        if (hasSession && (mode == MODE_RECORDING || mode == MODE_PREVIEWING)) {
            stopActivityLocked();
            emitState(reason != null ? reason : "pause");
            refreshService();
        }
        return snapshotLocked();
    }

    synchronized void seek(double positionMs) {
        if (!hasSession || mode != MODE_PAUSED) {
            return;
        }
        long total = dataBytes / frameBytes;
        positionFrames = Math.max(0L, Math.min(total, msToFrames(positionMs)));
        refreshService();
    }

    public synchronized void prepareRecorder(int deviceId) {
        if (mode == MODE_RECORDING) {
            return;
        }
        if (warmRecorder != null && warmDeviceId == deviceId
                && warmRecorder.getState() == AudioRecord.STATE_INITIALIZED) {
            return;
        }
        AudioRecord warm = warmRecorder;
        if (warm != null) {
            releaseQuietly(warm);
            warmRecorder = null;
            warmConfig = null;
            warmDeviceId = Integer.MIN_VALUE;
        }
        try {
            CaptureConfig cc = openRecorder(deviceId);
            warmRecorder = cc.record;
            warmConfig = cc;
            warmDeviceId = deviceId;
        } catch (Throwable t) {
            Log.w(TAG, "Warm recorder open failed", t);
        }
    }

    public synchronized void dropWarmRecorder() {
        if (mode == MODE_RECORDING) {
            return;
        }
        AudioRecord warm = warmRecorder;
        if (warm != null) {
            releaseQuietly(warm);
            warmRecorder = null;
            warmConfig = null;
            warmDeviceId = Integer.MIN_VALUE;
        }
    }

    public synchronized void preparePlayer() {
        if (mode == MODE_PREVIEWING || !hasSession || exporting) {
            return;
        }
        if (warmTrack != null && formatMatchesWarmTrack()) {
            return;
        }
        dropWarmPlayerLocked();
        try {
            AudioTrack t = buildTrack();
            if (t.getState() != AudioTrack.STATE_INITIALIZED) {
                releaseQuietly(t);
                return;
            }
            warmTrack = t;
            warmTrackRate = sampleRate;
            warmTrackChannels = channels;
            warmTrackFloat = floatPcm;
            warmTrackPrimed = false;
        } catch (Throwable e) {
            Log.w(TAG, "Warm player open failed", e);
        }
    }

    public synchronized void dropWarmPlayer() {
        if (mode == MODE_PREVIEWING) {
            return;
        }
        dropWarmPlayerLocked();
    }

    private boolean formatMatchesWarmTrack() {
        return warmTrack != null && warmTrackRate == sampleRate
                && warmTrackChannels == channels && warmTrackFloat == floatPcm;
    }

    private AudioTrack takeWarmTrack() {
        AudioTrack t = warmTrack;
        if (t == null) {
            return null;
        }
        warmTrack = null;
        warmTrackPrimed = false;
        if (!formatMatchesWarmTrack(t) || !warmTrackPrimedBefore()) {
            releaseQuietly(t);
            return null;
        }
        try {
            t.pause();
            t.flush();
            return t;
        } catch (Throwable e) {
            try {
                t.release();
            } catch (Throwable ignored) {
            }
            return null;
        }
    }

    private boolean formatMatchesWarmTrack(AudioTrack t) {
        return warmTrackRate == sampleRate && warmTrackChannels == channels
                && warmTrackFloat == floatPcm;
    }

    private boolean warmTrackPrimedBefore() {
        return warmTrackPrimed;
    }

    private void releaseQuietly(AudioTrack t) {
        if (t == null) {
            return;
        }
        try {
            t.pause();
        } catch (Throwable ignored) {
        }
        try {
            t.release();
        } catch (Throwable ignored) {
        }
    }

    private void dropWarmPlayerLocked() {
        AudioTrack t = warmTrack;
        warmTrack = null;
        warmTrackPrimed = false;
        if (t != null) {
            releaseQuietly(t);
        }
    }

    // =======================================================================
    // Internals: interference
    // =======================================================================

    private void startInterruptionWatchers() {
        if (interruptionWatchersOn || audioManager == null) {
            return;
        }
        interruptionWatchersOn = true;
        try {
            if (Build.VERSION.SDK_INT >= 24) {
                recordingCallback = new AudioManager.AudioRecordingCallback() {
                    @Override
                    public void onRecordingConfigChanged(
                            java.util.List<AudioRecordingConfiguration> configs) {
                        int active = configs == null ? -1 : configs.size();
                        if (active == 0 && mode == MODE_RECORDING) {
                            control.execute(new Runnable() {
                                @Override
                                public void run() {
                                    synchronized (StudioEngine.this) {
                                        if (mode != MODE_RECORDING) {
                                            return;
                                        }
                                        boolean wasOverwriting = overwriting;
                                        pause("mic_taken");
                                        emitInterruption("mic_taken", wasOverwriting);
                                    }
                                }
                            });
                        }
                    }
                };
                audioManager.registerAudioRecordingCallback(
                        (AudioManager.AudioRecordingCallback) recordingCallback, main);
            }
        } catch (Throwable t) {
            Log.w(TAG, "Could not watch the recording config", t);
        }
        try {
            if (Build.VERSION.SDK_INT >= 24) {
                studioDeviceCallback = new AudioDeviceCallback() {
                    @Override
                    public void onAudioDevicesAdded(AudioDeviceInfo[] added) {
                        noteRouteChange("device_added");
                    }

                    @Override
                    public void onAudioDevicesRemoved(AudioDeviceInfo[] removed) {
                        noteRouteChange("device_removed");
                    }
                };
                audioManager.registerAudioDeviceCallback(studioDeviceCallback, main);
            }
        } catch (Throwable t) {
            Log.w(TAG, "Could not watch audio devices", t);
        }
        try {
            IntentFilter filter = new IntentFilter();
            filter.addAction(Intent.ACTION_SCREEN_OFF);
            filter.addAction(Intent.ACTION_USER_PRESENT);
            interruptionReceiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context context, Intent intent) {
                    String action = intent == null ? null : intent.getAction();
                    if (Intent.ACTION_SCREEN_OFF.equals(action)) {
                        control.execute(new Runnable() {
                            @Override
                            public void run() {
                                synchronized (StudioEngine.this) {
                                    if (mode == MODE_PREVIEWING) {
                                        pause("screen_off");
                                    }
                                }
                            }
                        });
                    } else if (Intent.ACTION_USER_PRESENT.equals(action)) {
                        if (mode != MODE_RECORDING) {
                            prepareRecorder(activeDeviceId);
                        }
                        preparePlayer();
                    }
                }
            };
            IntentFilter receiverFilter = filter;
            if (Build.VERSION.SDK_INT >= 33) {
                app.registerReceiver(interruptionReceiver, receiverFilter, Context.RECEIVER_NOT_EXPORTED);
            } else {
                app.registerReceiver(interruptionReceiver, receiverFilter);
            }
        } catch (Throwable t) {
            Log.w(TAG, "Could not watch the screen state", t);
        }
    }

    private void stopInterruptionWatchers() {
        if (!interruptionWatchersOn) {
            return;
        }
        interruptionWatchersOn = false;
        try {
            if (Build.VERSION.SDK_INT >= 24 && recordingCallback != null) {
                audioManager.unregisterAudioRecordingCallback(
                        (AudioManager.AudioRecordingCallback) recordingCallback);
            }
        } catch (Throwable ignored) {
        }
        recordingCallback = null;
        try {
            if (studioDeviceCallback != null) {
                audioManager.unregisterAudioDeviceCallback(studioDeviceCallback);
            }
        } catch (Throwable ignored) {
        }
        studioDeviceCallback = null;
        try {
            if (interruptionReceiver != null) {
                app.unregisterReceiver(interruptionReceiver);
            }
        } catch (Throwable ignored) {
        }
        interruptionReceiver = null;
        main.removeCallbacks(deferredFocusPause);
        focusLostAt = 0L;
    }

    private void noteRouteChange(String what) {
        if (mode == MODE_PREVIEWING) {
            Log.i(TAG, "Audio route changed while previewing (" + what + ")");
        }
    }

    private void emitInterruption(String reason, boolean pausedRecording) {
        long position = currentPositionMs();
        Sink s = sink;
        if (s != null) {
            Map<String, Object> m = new HashMap<>();
            m.put("reason", reason);
            m.put("paused", pausedRecording);
            m.put("recording", pausedRecording);
            m.put("positionMs", (double) position);
            m.put("durationMs", (double) framesToMs(dataBytes / Math.max(1, frameBytes), sampleRate));
            m.put("overwriting", overwriting);
            s.emit(EVENT_INTERRUPTION, m);
        }
    }

    synchronized Map<String, Object> reinitializeCapture(int inputDeviceId, boolean appendAtEnd)
            throws Exception {
        requireUsableSession();
        if (mode == MODE_RECORDING) {
            return snapshotLocked();
        }
        AudioRecord warm = warmRecorder;
        if (warm != null) {
            releaseQuietly(warm);
            warmRecorder = null;
            warmConfig = null;
            warmDeviceId = Integer.MIN_VALUE;
        }
        return record(appendAtEnd ? -1d : (double) currentPositionMs(), inputDeviceId);
    }

    // =======================================================================
    // Queries
    // =======================================================================

    synchronized Map<String, Object> getStatus() {
        Map<String, Object> m = snapshotLocked();
        if (hasSession) {
            m.putAll(sessionInfoLocked());
        }
        m.put("exporting", exporting);
        m.put("opening", opening);
        m.put("foregroundService", serviceRequested);
        m.put("hasEdits", hasEdits);
        m.put("badge", badge);
        return m;
    }

    byte[] getPeaks(int start, int count) {
        synchronized (peaksLock) {
            int from = Math.max(0, Math.min(start, peakCount));
            int to = count < 0 ? peakCount : Math.max(from, Math.min(peakCount, from + count));
            return Arrays.copyOfRange(peaks, from, to);
        }
    }

    boolean hasSession() {
        return hasSession;
    }

    int currentMode() {
        return mode;
    }

    boolean isOverwriting() {
        return mode == MODE_RECORDING && overwriting;
    }

    boolean isExporting() {
        return exporting;
    }

    String currentBadge() {
        return badge;
    }

    long notificationPositionMs() {
        int m = mode;
        long frames;
        if (m == MODE_RECORDING) {
            frames = writeFrame;
        } else if (m == MODE_PREVIEWING) {
            frames = playFrame;
        } else {
            frames = positionFrames;
        }
        return framesToMs(frames, sampleRate);
    }

    // =======================================================================
    // Notification actions
    // =======================================================================

    void onNotificationAction(final String action) {
        if ("pause".equals(action)) {
            control.execute(new Runnable() {
                @Override
                public void run() {
                    pause("notification");
                }
            });
            return;
        }
        final Sink s = sink;
        if (s != null) {
            Map<String, Object> payload = new HashMap<>();
            payload.put("action", action);
            s.emit(EVENT_NOTIFICATION, payload);
            return;
        }
        control.execute(new Runnable() {
            @Override
            public void run() {
                if ("resume".equals(action)) {
                    try {
                        record(-1, -1);
                    } catch (Exception e) {
                        Log.w(TAG, "Resume from notification failed", e);
                    }
                } else if ("stop".equals(action)) {
                    synchronized (StudioEngine.this) {
                        if (hasSession && !exporting) {
                            stopActivityLocked();
                            synchronized (ioLock) {
                                patchHeaderLocked();
                            }
                            emitState("notification");
                        }
                        stopService();
                    }
                }
            }
        });
    }

    // =======================================================================
    // Internals: state
    // =======================================================================

    private void requireUsableSession() {
        if (!hasSession) {
            throw new IllegalStateException("No studio session is open.");
        }
        if (exporting) {
            throw new IllegalStateException("The take is being saved.");
        }
        if (opening) {
            throw new IllegalStateException("The take is still opening.");
        }
    }

    private void applyFormat(int rate, int ch, boolean flt) {
        sampleRate = rate;
        channels = ch;
        floatPcm = flt;
        frameBytes = ch * (flt ? 4 : 2);
        framesPerBucket = Math.max(1, rate * PEAK_BUCKET_MS / 1000);
    }

    private void stopActivityLocked() {
        if (mode == MODE_RECORDING) {
            captureRun = false;
            AudioRecord rec = recorder;
            if (rec != null) {
                try {
                    rec.stop();
                } catch (Throwable ignored) {
                }
            }
            joinQuietly(captureThread, 2500L);
            captureThread = null;
            if (rec != null) {
                warmRecorder = rec;
                warmConfig = activeConfig;
                warmDeviceId = activeDeviceId;
            }
            recorder = null;
            finishTracker();
            synchronized (ioLock) {
                patchHeaderLocked();
            }
            positionFrames = writeFrame;
            overwriting = false;
            mode = MODE_PAUSED;
            abandonFocus();
            flushPeaksToJs();
        } else if (mode == MODE_PREVIEWING) {
            playRun = false;
            AudioTrack t = track;
            long head = playFrame - playStartFrame;
            if (t != null) {
                try {
                    head = t.getPlaybackHeadPosition() & 0xFFFFFFFFL;
                } catch (Throwable ignored) {
                }
                try {
                    t.pause();
                    t.flush();
                } catch (Throwable ignored) {
                }
            }
            joinQuietly(playThread, 1000L);
            if (t != null) {
                boolean keep = playStartedOk;
                playStartedOk = false;
                try {
                    t.release();
                } catch (Throwable ignored) {
                }
                if (keep) {
                    warmTrack = t;
                    warmTrackRate = sampleRate;
                    warmTrackChannels = channels;
                    warmTrackFloat = floatPcm;
                    warmTrackPrimed = true;
                }
            }
            playThread = null;
            track = null;
            long total = dataBytes / frameBytes;
            positionFrames = Math.max(0L, Math.min(total, playStartFrame + head));
            playFrame = positionFrames;
            mode = MODE_PAUSED;
            abandonFocus();
        }
    }

    private void closeSessionLocked(boolean deleteFile) {
        stopActivityLocked();
        AudioRecord warm = warmRecorder;
        if (warm != null) {
            releaseQuietly(warm);
            warmRecorder = null;
            warmConfig = null;
            warmDeviceId = Integer.MIN_VALUE;
        }
        dropWarmPlayerLocked();
        stopInterruptionWatchers();
        synchronized (ioLock) {
            closeRafLocked();
        }
        if (deleteFile && sessionFile != null && sessionFile.exists()) {
            sessionFile.delete();
        }
        hasSession = false;
        mode = MODE_IDLE;
        sessionId = null;
        sessionFile = null;
        dataBytes = 0L;
        positionFrames = 0L;
        writeFrame = 0L;
        playFrame = 0L;
        overwriting = false;
        hasEdits = false;
        resetPeaks();
        stopService();
        emitState("closed");
    }

    private void reopenRafLocked() {
        synchronized (ioLock) {
            if (raf == null && sessionFile != null && sessionFile.exists()) {
                try {
                    raf = new RandomAccessFile(sessionFile, "rw");
                } catch (IOException e) {
                    Log.e(TAG, "Could not reopen the working file", e);
                }
            }
        }
    }

    private void closeRafLocked() {
        if (raf != null) {
            try {
                StudioCodec.patchSizes(raf, dataBytes);
            } catch (IOException ignored) {
            }
            try {
                raf.close();
            } catch (IOException ignored) {
            }
            raf = null;
        }
    }

    private void patchHeaderLocked() {
        if (raf != null) {
            try {
                StudioCodec.patchSizes(raf, dataBytes);
            } catch (IOException e) {
                Log.w(TAG, "Header patch failed", e);
            }
        }
    }

    private Map<String, Object> snapshotLocked() {
        Map<String, Object> m = new HashMap<>();
        m.put("hasSession", hasSession);
        m.put("mode", modeName(mode));
        m.put("positionMs", (double) currentPositionMs());
        m.put("durationMs", (double) framesToMs(dataBytes / Math.max(1, frameBytes), sampleRate));
        m.put("overwriting", mode == MODE_RECORDING && overwriting);
        return m;
    }

    private Map<String, Object> sessionInfoLocked() {
        Map<String, Object> m = new HashMap<>();
        m.put("sessionId", sessionId);
        m.put("sessionPath", sessionFile != null ? sessionFile.getAbsolutePath() : null);
        m.put("sampleRate", sampleRate);
        m.put("channels", channels);
        m.put("floatPcm", floatPcm);
        m.put("durationMs", (double) framesToMs(dataBytes / Math.max(1, frameBytes), sampleRate));
        m.put("dataBytes", (double) dataBytes);
        synchronized (peaksLock) {
            m.put("peakCount", peakCount);
        }
        m.put("peakBucketMs", PEAK_BUCKET_MS);
        return m;
    }

    private long currentPositionMs() {
        int m = mode;
        long frames = m == MODE_RECORDING ? writeFrame
                : m == MODE_PREVIEWING ? playFrame : positionFrames;
        return framesToMs(frames, sampleRate);
    }

    private static String modeName(int m) {
        switch (m) {
            case MODE_PAUSED:
                return "paused";
            case MODE_RECORDING:
                return "recording";
            case MODE_PREVIEWING:
                return "previewing";
            default:
                return "idle";
        }
    }

    private void emitState(String reason) {
        Sink s = sink;
        if (s == null) {
            return;
        }
        Map<String, Object> m = new HashMap<>();
        m.put("hasSession", hasSession);
        m.put("mode", modeName(mode));
        m.put("positionMs", (double) currentPositionMs());
        m.put("durationMs", (double) framesToMs(dataBytes / Math.max(1, frameBytes), sampleRate));
        m.put("overwriting", mode == MODE_RECORDING && overwriting);
        m.put("reason", reason);
        s.emit(EVENT_STATE, m);
    }

    void emitProgress(String phase, float fraction) {
        Sink s = sink;
        if (s == null) {
            return;
        }
        Map<String, Object> m = new HashMap<>();
        m.put("phase", phase);
        m.put("progress", (double) Math.max(0f, Math.min(1f, fraction)));
        s.emit(EVENT_PROGRESS, m);
    }

    private void emitError(String code, String message) {
        Sink s = sink;
        if (s == null) {
            return;
        }
        Map<String, Object> m = new HashMap<>();
        m.put("code", code);
        m.put("message", message);
        s.emit(EVENT_ERROR, m);
    }

    private void emitMeter(float peakLinear, long positionFrame) {
        Sink s = sink;
        if (s == null) {
            return;
        }
        int start = 0;
        byte[] slice = null;
        synchronized (peaksLock) {
            if (dirtyEnd > dirtyStart) {
                start = dirtyStart;
                slice = Arrays.copyOfRange(peaks, dirtyStart, Math.min(dirtyEnd, peaks.length));
                dirtyStart = Integer.MAX_VALUE;
                dirtyEnd = -1;
            }
        }
        int[] values;
        if (slice == null) {
            values = new int[0];
        } else {
            values = new int[slice.length];
            for (int i = 0; i < slice.length; i++) {
                values[i] = slice[i] & 0xFF;
            }
        }
        Map<String, Object> m = new HashMap<>();
        m.put("db", peakLinear > 1e-7f ? 20.0 * Math.log10(peakLinear) : -160.0);
        m.put("positionMs", (double) framesToMs(positionFrame, sampleRate));
        m.put("durationMs", (double) framesToMs(dataBytes / Math.max(1, frameBytes), sampleRate));
        m.put("overwriting", mode == MODE_RECORDING && overwriting);
        m.put("recording", mode == MODE_RECORDING);
        m.put("peakStart", start);
        m.put("peaks", values);
        s.emit(EVENT_METER, m);
    }

    private void flushPeaksToJs() {
        boolean dirty;
        synchronized (peaksLock) {
            dirty = dirtyEnd > dirtyStart;
        }
        if (dirty) {
            emitMeter(0f, positionFrames);
        }
    }

    // =======================================================================
    // Internals: peaks
    // =======================================================================

    private void resetPeaks() {
        synchronized (peaksLock) {
            peaks = new byte[4096];
            peakCount = 0;
            dirtyStart = Integer.MAX_VALUE;
            dirtyEnd = -1;
        }
    }

    static int peakToByte(float peak) {
        if (peak <= 1e-6f) {
            return 0;
        }
        double db = 20.0 * Math.log10(Math.min(1.0, peak));
        double norm = (db + 45.0) / 45.0;
        if (norm <= 0.0) {
            return 0;
        }
        if (norm > 1.0) {
            norm = 1.0;
        }
        return (int) Math.round(Math.pow(norm, 1.5) * 255.0);
    }

    private void storePeak(int bucket, float peak, boolean markDirty) {
        if (bucket < 0) {
            return;
        }
        int v = peakToByte(peak);
        synchronized (peaksLock) {
            if (bucket >= peaks.length) {
                int cap = peaks.length;
                while (cap <= bucket) {
                    cap *= 2;
                }
                peaks = Arrays.copyOf(peaks, cap);
            }
            peaks[bucket] = (byte) v;
            if (bucket + 1 > peakCount) {
                peakCount = bucket + 1;
            }
            if (markDirty) {
                if (bucket < dirtyStart) {
                    dirtyStart = bucket;
                }
                if (bucket + 1 > dirtyEnd) {
                    dirtyEnd = bucket + 1;
                }
            }
        }
    }

    private void initTracker(long startFrame) {
        int fpb = framesPerBucket;
        trkFrame = startFrame;
        trkBucket = (int) (startFrame / fpb);
        long bucketStart = (long) trkBucket * fpb;
        trkPeak = startFrame > bucketStart ? readPeak(bucketStart, startFrame) : 0f;
    }

    private void finishTracker() {
        long wf = writeFrame;
        long total = dataBytes / frameBytes;
        if (wf < total) {
            long bucketEnd = Math.min(total, ((long) trkBucket + 1L) * framesPerBucket);
            if (bucketEnd > wf) {
                trkPeak = Math.max(trkPeak, readPeak(wf, bucketEnd));
            }
        }
        storePeak(trkBucket, trkPeak, true);
    }

    private float readPeak(long fromFrame, long toFrame) {
        if (toFrame <= fromFrame) {
            return 0f;
        }
        int fb = frameBytes;
        int frames = (int) Math.min(toFrame - fromFrame, 1L << 16);
        byte[] buf = new byte[frames * fb];
        synchronized (ioLock) {
            if (raf == null) {
                return 0f;
            }
            try {
                raf.seek(StudioCodec.HEADER_BYTES + fromFrame * fb);
                raf.readFully(buf);
            } catch (IOException e) {
                return 0f;
            }
        }
        return peakOf(ByteBuffer.wrap(buf).order(ByteOrder.LITTLE_ENDIAN), frames);
    }

    private float peakOf(ByteBuffer bb, int frames) {
        int samples = frames * channels;
        float peak = 0f;
        if (floatPcm) {
            for (int i = 0; i < samples; i++) {
                float a = Math.abs(bb.getFloat(i * 4));
                if (a > peak) {
                    peak = a;
                }
            }
        } else {
            for (int i = 0; i < samples; i++) {
                float a = Math.abs(bb.getShort(i * 2) / 32768f);
                if (a > peak) {
                    peak = a;
                }
            }
        }
        return Math.min(1f, peak);
    }

    // =======================================================================
    // Internals: capture
    // =======================================================================

    private static final class CaptureConfig {
        AudioRecord record;
        int rate;
        int channels;
        boolean isFloat;
    }

    private CaptureConfig openRecorder(int deviceId) throws IOException {
        int[] sources = resolveSources();
        List<int[]> attempts = new ArrayList<>();
        attempts.add(new int[]{sampleRate, channels, floatPcm ? 1 : 0});
        if (floatPcm) {
            attempts.add(new int[]{sampleRate, channels, 0});
        }
        if (channels == 2) {
            attempts.add(new int[]{sampleRate, 1, 0});
        }
        for (int r : new int[]{48000, 44100, 32000, 16000, 8000}) {
            if (r != sampleRate) {
                attempts.add(new int[]{r, 1, 0});
            }
        }
        String lastMessage = null;
        for (int[] a : attempts) {
            for (int source : sources) {
                AudioRecord rec = null;
                try {
                    rec = buildRecord(source, a[0], a[1], a[2] == 1);
                    if (rec != null && rec.getState() == AudioRecord.STATE_INITIALIZED) {
                        if (deviceId >= 0) {
                            applyPreferredDevice(rec, deviceId);
                        }
                        CaptureConfig cc = new CaptureConfig();
                        cc.record = rec;
                        cc.rate = rec.getSampleRate();
                        cc.channels = a[1];
                        cc.isFloat = a[2] == 1;
                        return cc;
                    }
                } catch (Throwable t) {
                    lastMessage = t.getMessage();
                }
                releaseQuietly(rec);
            }
        }
        throw new IOException("The microphone could not be opened"
                + (lastMessage != null ? ": " + lastMessage : ". Check the microphone permission."));
    }

    private AudioRecord buildRecord(int source, int rate, int ch, boolean isFloat) {
        int cfg = ch == 2 ? AudioFormat.CHANNEL_IN_STEREO : AudioFormat.CHANNEL_IN_MONO;
        int enc = isFloat ? AudioFormat.ENCODING_PCM_FLOAT : AudioFormat.ENCODING_PCM_16BIT;
        int min = AudioRecord.getMinBufferSize(rate, cfg, enc);
        if (min <= 0) {
            return null;
        }
        int fb = ch * (isFloat ? 4 : 2);
        int size = Math.max(min * 2, (rate / 4) * fb);
        return new AudioRecord(source, rate, cfg, enc, size);
    }

    private int[] resolveSources() {
        boolean unprocessed = false;
        try {
            unprocessed = audioManager != null && "true".equalsIgnoreCase(
                    audioManager.getProperty(AudioManager.PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED));
        } catch (Throwable ignored) {
        }
        if (unprocessed) {
            return new int[]{
                    MediaRecorder.AudioSource.UNPROCESSED,
                    MediaRecorder.AudioSource.MIC,
                    MediaRecorder.AudioSource.DEFAULT
            };
        }
        return new int[]{MediaRecorder.AudioSource.MIC, MediaRecorder.AudioSource.DEFAULT};
    }

    private void applyPreferredDevice(AudioRecord rec, int deviceId) {
        if (audioManager == null) {
            return;
        }
        try {
            AudioDeviceInfo[] all = audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS);
            if (all == null) {
                return;
            }
            for (AudioDeviceInfo info : all) {
                if (info != null && info.getId() == deviceId) {
                    rec.setPreferredDevice(info);
                    return;
                }
            }
        } catch (Throwable ignored) {
        }
    }

    private final class CaptureWorker implements Runnable {
        private final AudioRecord rec;
        private final int capRate;
        private final int capCh;
        private final boolean capFloat;
        private final int gen;
        private final long startFrames;

        CaptureWorker(CaptureConfig cc, int gen, long startFrames) {
            this.rec = cc.record;
            this.capRate = cc.rate;
            this.capCh = cc.channels;
            this.capFloat = cc.isFloat;
            this.gen = gen;
            this.startFrames = startFrames;
        }

        @Override
        public void run() {
            Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO);
            final int fileCh = channels;
            final boolean fileFloat = floatPcm;
            final int fb = frameBytes;
            final int fpb = framesPerBucket;
            // Sample audio in ~10 ms chunks rather than 20-33 ms chunks to minimize input latency.
            final int framesPerRead = Math.max(128, capRate / 100);
            final short[] s16 = capFloat ? null : new short[framesPerRead * capCh];
            final float[] f32 = capFloat ? new float[framesPerRead * capCh] : null;
            final float[] mixed = new float[framesPerRead * fileCh];
            final StudioCodec.PushResampler rs = capRate != sampleRate
                    ? new StudioCodec.PushResampler(fileCh, (double) capRate / (double) sampleRate)
                    : null;
            final int maxOut = rs != null ? rs.maxOutputFrames(framesPerRead) : framesPerRead;
            final float[] resampled = rs != null ? new float[maxOut * fileCh] : null;
            final byte[] out = new byte[maxOut * fb];
            final ByteBuffer ob = ByteBuffer.wrap(out).order(ByteOrder.LITTLE_ENDIAN);

            long lastMeter = 0L;
            long lastPatch = SystemClock.elapsedRealtime();
            long lastSpaceCheck = SystemClock.elapsedRealtime();
            long usableAtLastCheck = Long.MAX_VALUE;
            float meterPeak = 0f;
            int zeroReads = 0;
            long totalFrames = 0L;
            long lastProgressAt = SystemClock.elapsedRealtime();
            int zeroMeterWindows = 0;

            while (true) {
                int n;
                try {
                    n = capFloat
                            ? rec.read(f32, 0, f32.length, AudioRecord.READ_BLOCKING)
                            : rec.read(s16, 0, s16.length);
                } catch (Throwable t) {
                    if (captureRun) {
                        postCaptureFailure(gen, "Audio capture failed: " + t.getMessage());
                    }
                    return;
                }
                if (n < 0) {
                    if (captureRun) {
                        postCaptureFailure(gen, n == AudioRecord.ERROR_DEAD_OBJECT
                                ? "The microphone was disconnected."
                                : "The microphone stopped delivering audio (error " + n + ").");
                    }
                    return;
                }
                if (n == 0) {
                    if (!captureRun) {
                        return;
                    }
                    if (++zeroReads > 300) {
                        postCaptureFailure(gen, "The microphone stopped delivering audio.");
                        return;
                    }
                    continue;
                }
                zeroReads = 0;

                totalFrames += n / capCh;
                long progressAt = SystemClock.elapsedRealtime();
                if (progressAt - lastProgressAt > 1500L) {
                    if (rec.getState() != AudioRecord.STATE_INITIALIZED
                            || rec.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) {
                        postCaptureFailure(gen, "The microphone was taken by another app"
                                + " (an incoming call or an assistant). The take was paused"
                                + " so nothing was lost.");
                        return;
                    }
                    lastProgressAt = progressAt;
                }

                int frames = n / capCh;
                for (int i = 0; i < frames; i++) {
                    float l;
                    float r;
                    if (capFloat) {
                        l = f32[i * capCh];
                        r = capCh > 1 ? f32[i * capCh + 1] : l;
                    } else {
                        l = s16[i * capCh] / 32768f;
                        r = capCh > 1 ? s16[i * capCh + 1] / 32768f : l;
                    }
                    if (fileCh == 1) {
                        mixed[i] = capCh > 1 ? (l + r) * 0.5f : l;
                    } else {
                        mixed[i * 2] = l;
                        mixed[i * 2 + 1] = r;
                    }
                }
                float[] src = mixed;
                int outFrames = frames;
                if (rs != null) {
                    outFrames = rs.process(mixed, frames, resampled);
                    src = resampled;
                }
                if (outFrames <= 0) {
                    continue;
                }

                ob.clear();
                long f = trkFrame;
                int bucket = trkBucket;
                float bucketPeak = trkPeak;
                for (int i = 0; i < outFrames; i++) {
                    float framePeak = 0f;
                    for (int c = 0; c < fileCh; c++) {
                        float v = src[i * fileCh + c];
                        if (v > 1f) {
                            v = 1f;
                        } else if (v < -1f) {
                            v = -1f;
                        }
                        float a = v < 0f ? -v : v;
                        if (a > framePeak) {
                            framePeak = a;
                        }
                        if (fileFloat) {
                            ob.putFloat(v);
                        } else {
                            ob.putShort(StudioCodec.toPcm16(v));
                        }
                    }
                    int b = (int) (f / fpb);
                    if (b != bucket) {
                        storePeak(bucket, bucketPeak, true);
                        bucket = b;
                        bucketPeak = 0f;
                    }
                    if (framePeak > bucketPeak) {
                        bucketPeak = framePeak;
                    }
                    if (framePeak > meterPeak) {
                        meterPeak = framePeak;
                    }
                    f++;
                }
                trkFrame = f;
                trkBucket = bucket;
                trkPeak = bucketPeak;

                int bytes = outFrames * fb;
                boolean sizeLimit;
                boolean lowSpace = false;
                try {
                    synchronized (ioLock) {
                        RandomAccessFile file = raf;
                        if (file == null) {
                            return;
                        }
                        file.seek(StudioCodec.HEADER_BYTES + writeFrame * fb);
                        file.write(out, 0, bytes);
                        long next = writeFrame + outFrames;
                        long end = next * fb;
                        if (end > dataBytes) {
                            dataBytes = end;
                        }
                        writeFrame = next;
                        long now = SystemClock.elapsedRealtime();
                        if (now - lastPatch >= HEADER_PATCH_INTERVAL_MS) {
                            StudioCodec.patchSizes(file, dataBytes);
                            lastPatch = now;
                        }
                        sizeLimit = dataBytes >= MAX_DATA_BYTES;
                        if (!sizeLimit && now - lastSpaceCheck >= DISK_POLL_INTERVAL_MS) {
                            lastSpaceCheck = now;
                            File f2 = sessionFile;
                            if (f2 != null) {
                                usableAtLastCheck = f2.getUsableSpace();
                            }
                            lowSpace = usableAtLastCheck < MIN_FREE_CAPTURE_BYTES;
                        }
                    }
                } catch (IOException e) {
                    if (captureRun) {
                        postCaptureFailure(gen, "Could not write audio to storage: " + e.getMessage());
                    }
                    return;
                }
                storePeak(bucket, bucketPeak, true);

                if (overwriting && writeFrame >= overwriteEndFrame) {
                    overwriting = false;
                    emitState("caught_up");
                    refreshService();
                }
                long now = SystemClock.elapsedRealtime();
                if (now - lastMeter >= METER_INTERVAL_MS) {
                    lastMeter = now;
                    zeroMeterWindows = meterPeak > 1e-5f ? 0 : zeroMeterWindows + 1;
                    emitMeter(meterPeak, writeFrame);
                    meterPeak = 0f;
                    if (zeroMeterWindows > 500) {
                        postCaptureFailure(gen, "The microphone went silent — it was taken"
                                + " over by another app. The take was paused and saved up to"
                                + " this point.");
                        return;
                    }
                }
                if (sizeLimit) {
                    postSizeLimit(gen);
                    return;
                }
                if (lowSpace) {
                    postStopWithError(gen, "size_limit", "storage_low",
                            "Storage is almost full, so the take was paused at "
                                    + (usableAtLastCheck / (1024 * 1024L)) + " MB free.");
                    return;
                }
                if (!captureRun) {
                    return;
                }
            }
        }
    }

    private void postCaptureFailure(final int gen, final String message) {
        postStopWithError(gen, "capture_failed", "error", message);
    }

    private void postStopWithError(
            final int gen, final String errorCode, final String state, final String message) {
        Log.e(TAG, message);
        control.execute(new Runnable() {
            @Override
            public void run() {
                synchronized (StudioEngine.this) {
                    if (gen != generation || mode != MODE_RECORDING) {
                        return;
                    }
                    stopActivityLocked();
                    emitError(errorCode, message);
                    emitState(state);
                    refreshService();
                }
            }
        });
    }

    private void postSizeLimit(final int gen) {
        control.execute(new Runnable() {
            @Override
            public void run() {
                synchronized (StudioEngine.this) {
                    if (gen != generation || mode != MODE_RECORDING) {
                        return;
                    }
                    stopActivityLocked();
                    emitError("size_limit",
                            "The take reached the 2 GB WAV limit, so recording was paused.");
                    emitState("size_limit");
                    refreshService();
                }
            }
        });
    }

    // =======================================================================
    // Internals: playback
    // =======================================================================

    private AudioTrack buildTrack() throws IOException {
        int mask = channels == 2 ? AudioFormat.CHANNEL_OUT_STEREO : AudioFormat.CHANNEL_OUT_MONO;
        int enc = floatPcm ? AudioFormat.ENCODING_PCM_FLOAT : AudioFormat.ENCODING_PCM_16BIT;
        int min = AudioTrack.getMinBufferSize(sampleRate, mask, enc);
        if (min <= 0) {
            throw new IOException("This device cannot play " + sampleRate + " Hz audio.");
        }
        int chunk = Math.max(128, sampleRate / 100) * frameBytes;
        try {
            AudioTrack t = new AudioTrack.Builder()
                    .setAudioAttributes(new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_MEDIA)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                            .build())
                    .setAudioFormat(new AudioFormat.Builder()
                            .setSampleRate(sampleRate)
                            .setChannelMask(mask)
                            .setEncoding(enc)
                            .build())
                    .setBufferSizeInBytes(Math.max(min * 2, chunk * 4))
                    .setTransferMode(AudioTrack.MODE_STREAM)
                    .build();
            if (t.getState() != AudioTrack.STATE_INITIALIZED) {
                t.release();
                throw new IOException("The audio output could not be opened.");
            }
            return t;
        } catch (IllegalArgumentException | UnsupportedOperationException e) {
            throw new IOException("The audio output could not be opened: " + e.getMessage());
        }
    }

    private final class PlaybackWorker implements Runnable {
        private final AudioTrack t;
        private final long startFrame;
        private final long endFrame;
        private final int gen;

        PlaybackWorker(AudioTrack t, long startFrame, long endFrame, int gen) {
            this.t = t;
            this.startFrame = startFrame;
            this.endFrame = endFrame;
            this.gen = gen;
        }

        private long head(long fallback) {
            try {
                return t.getPlaybackHeadPosition() & 0xFFFFFFFFL;
            } catch (Throwable e) {
                return fallback;
            }
        }

        @Override
        public void run() {
            Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO);
            final int fb = frameBytes;
            final int chunkFrames = Math.max(128, sampleRate / 100);
            final byte[] buf = new byte[chunkFrames * fb];
            final ByteBuffer direct = ByteBuffer.allocateDirect(buf.length).order(ByteOrder.nativeOrder());
            final ByteBuffer view = ByteBuffer.wrap(buf).order(ByteOrder.LITTLE_ENDIAN);
            long f = startFrame;
            long written = 0L;
            long lastMeter = 0L;
            long lastHead = 0L;
            try {
                t.play();
                playStartedOk = true;
            } catch (Throwable e) {
                postPlaybackFailure(gen, "Playback could not start: " + e.getMessage());
                return;
            }
            while (playRun && f < endFrame) {
                int n = (int) Math.min(chunkFrames, endFrame - f);
                int bytes = n * fb;
                try {
                    synchronized (ioLock) {
                        RandomAccessFile file = raf;
                        if (file == null) {
                            return;
                        }
                        file.seek(StudioCodec.HEADER_BYTES + f * fb);
                        file.readFully(buf, 0, bytes);
                    }
                } catch (IOException e) {
                    if (playRun) {
                        postPlaybackFailure(gen, "The take could not be read: " + e.getMessage());
                    }
                    return;
                }
                direct.clear();
                direct.put(buf, 0, bytes);
                direct.flip();
                while (playRun && direct.hasRemaining()) {
                    int w = t.write(direct, direct.remaining(), AudioTrack.WRITE_BLOCKING);
                    if (w < 0) {
                        if (playRun) {
                            postPlaybackFailure(gen, "Playback failed (error " + w + ").");
                        }
                        return;
                    }
                }
                if (!playRun) {
                    return;
                }
                f += n;
                written += n;
                lastHead = head(lastHead);
                playFrame = startFrame + lastHead;
                long now = SystemClock.elapsedRealtime();
                if (now - lastMeter >= METER_INTERVAL_MS) {
                    lastMeter = now;
                    emitMeter(peakOf(view, n), playFrame);
                }
            }
            long lastAdvance = SystemClock.elapsedRealtime();
            while (playRun) {
                long h = head(lastHead);
                long now = SystemClock.elapsedRealtime();
                if (h != lastHead) {
                    lastHead = h;
                    lastAdvance = now;
                }
                playFrame = startFrame + h;
                if (h >= written || now - lastAdvance > 300L) {
                    break;
                }
                if (now - lastMeter >= METER_INTERVAL_MS) {
                    lastMeter = now;
                    emitMeter(0f, playFrame);
                }
                try {
                    Thread.sleep(10L);
                } catch (InterruptedException e) {
                    return;
                }
            }
            if (playRun) {
                postPlaybackEnded(gen);
            }
        }
    }

    private void postPlaybackEnded(final int gen) {
        control.execute(new Runnable() {
            @Override
            public void run() {
                synchronized (StudioEngine.this) {
                    if (gen != generation || mode != MODE_PREVIEWING) {
                        return;
                    }
                    playRun = false;
                    joinQuietly(playThread, 1000L);
                    playThread = null;
                    AudioTrack t = track;
                    track = null;
                    if (t != null) {
                        try {
                            t.pause();
                            t.flush();
                        } catch (Throwable ignored) {
                        }
                        warmTrack = t;
                        warmTrackRate = sampleRate;
                        warmTrackChannels = channels;
                        warmTrackFloat = floatPcm;
                        warmTrackPrimed = true;
                    }
                    positionFrames = dataBytes / frameBytes;
                    playFrame = positionFrames;
                    mode = MODE_PAUSED;
                    abandonFocus();
                    emitState("ended");
                    refreshService();
                }
            }
        });
    }

    private void postPlaybackFailure(final int gen, final String message) {
        Log.e(TAG, message);
        control.execute(new Runnable() {
            @Override
            public void run() {
                synchronized (StudioEngine.this) {
                    if (gen != generation || mode != MODE_PREVIEWING) {
                        return;
                    }
                    stopActivityLocked();
                    dropWarmPlayerLocked();
                    emitError("playback_failed", message);
                    emitState("error");
                    refreshService();
                }
            }
        });
    }

    // =======================================================================
    // Internals: audio focus
    // =======================================================================

    @SuppressWarnings("deprecation")
    private void requestFocus() {
        if (focusHeld || audioManager == null) {
            return;
        }
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                AudioFocusRequest req = new AudioFocusRequest.Builder(
                        AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                        .setAudioAttributes(new AudioAttributes.Builder()
                                .setUsage(AudioAttributes.USAGE_MEDIA)
                                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                                .build())
                        .setOnAudioFocusChangeListener(focusListener, main)
                        .build();
                audioManager.requestAudioFocus(req);
                focusRequest = req;
            } else {
                audioManager.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC,
                        AudioManager.AUDIOFOCUS_GAIN_TRANSIENT);
            }
            focusHeld = true;
        } catch (Throwable t) {
            Log.w(TAG, "Audio focus request failed", t);
        }
    }

    @SuppressWarnings("deprecation")
    private void abandonFocus() {
        if (!focusHeld || audioManager == null) {
            return;
        }
        try {
            if (Build.VERSION.SDK_INT >= 26 && focusRequest instanceof AudioFocusRequest) {
                audioManager.abandonAudioFocusRequest((AudioFocusRequest) focusRequest);
            } else {
                audioManager.abandonAudioFocus(focusListener);
            }
        } catch (Throwable ignored) {
        }
        focusRequest = null;
        focusHeld = false;
    }

    // =======================================================================
    // Internals: foreground service
    // =======================================================================

    private void ensureService() {
        if (serviceRequested) {
            refreshService();
            return;
        }
        Intent intent = new Intent(app, StudioRecordingService.class)
                .setAction(StudioRecordingService.ACTION_START);
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                app.startForegroundService(intent);
            } else {
                app.startService(intent);
            }
            serviceRequested = true;
        } catch (Throwable t) {
            Log.w(TAG, "Could not start the recording service", t);
        }
    }

    private void refreshService() {
        if (serviceRequested) {
            StudioRecordingService.requestRefresh();
        }
    }

    private void stopService() {
        if (!serviceRequested) {
            return;
        }
        serviceRequested = false;
        try {
            app.stopService(new Intent(app, StudioRecordingService.class));
        } catch (Throwable t) {
            Log.w(TAG, "Could not stop the recording service", t);
        }
    }

    synchronized void stopForegroundService() {
        stopService();
    }

    void onServiceDestroyed() {
        if (!hasSession) {
            serviceRequested = false;
        }
    }

    // =======================================================================
    // Helpers
    // =======================================================================

    File sessionsDir() {
        return new File(app.getFilesDir(), "StudioSessions");
    }

    long freeBytes() {
        File dir = sessionsDir();
        File probe = dir.exists() ? dir : app.getFilesDir();
        long free = probe.getUsableSpace();
        return free < 0L ? Long.MAX_VALUE : free;
    }

    private long msToFrames(double ms) {
        return (long) Math.floor(ms * sampleRate / 1000.0);
    }

    private static long framesToMs(long frames, int rate) {
        if (rate <= 0) {
            return 0L;
        }
        return frames * 1000L / rate;
    }

    private static void joinQuietly(Thread t, long timeoutMs) {
        if (t == null || t == Thread.currentThread()) {
            return;
        }
        try {
            t.join(timeoutMs);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private static void releaseQuietly(AudioRecord rec) {
        if (rec == null) {
            return;
        }
        try {
            rec.release();
        } catch (Throwable ignored) {
        }
    }

    private static void copyFile(File from, File to) throws IOException {
        InputStream in = new BufferedInputStream(new FileInputStream(from), 1 << 16);
        OutputStream out = new BufferedOutputStream(new FileOutputStream(to, false), 1 << 16);
        try {
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
            }
        } finally {
            try {
                in.close();
            } catch (IOException ignored) {
            }
            out.close();
        }
    }

    static String normalizePath(String raw) {
        String p = raw == null ? "" : raw.trim();
        if (p.startsWith("file://")) {
            p = p.substring("file://".length());
            p = android.net.Uri.decode(p);
        }
        if (!p.isEmpty() && !p.startsWith("/")) {
            p = "/" + p;
        }
        return p;
    }
}
