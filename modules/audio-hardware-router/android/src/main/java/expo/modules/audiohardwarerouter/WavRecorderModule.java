package expo.modules.audiohardwarerouter;

import android.content.Context;
import android.media.AudioDeviceInfo;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Process;
import android.util.Log;
import android.os.SystemClock;

import androidx.annotation.NonNull;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/**
 * Uncompressed RIFF/WAVE recorder built on AudioRecord.
 *
 * Android's MediaRecorder has no PCM encoder, so genuine .wav output is only
 * possible by capturing raw PCM and writing the RIFF container by hand.
 */
public class WavRecorderModule extends ReactContextBaseJavaModule {

    private static final String EVENT_METERING = "wavRecorderMetering";
    private static final String EVENT_ERROR = "wavRecorderError";

    private static final int READ_FRAMES = 2048;
    private static final long METER_INTERVAL_MS = 33L;

    /**
     * M8: capped just below 2 GiB. The RIFF size fields are unsigned 32-bit, but
     * a great many decoders (including Android's own MediaPlayer and several
     * desktop DAWs) read them as signed ints, so anything above 2^31-1 is read
     * as a negative length and the file is rejected or plays as silence.
     */
    private static final long MAX_DATA_BYTES = 0x7FFFFFF0L;

    private final ReactApplicationContext reactContext;
    private final AudioManager audioManager;

    private AudioRecord audioRecord;
    private File outputFile;
    private BufferedOutputStream stream;
    private Thread worker;

    private volatile boolean running = false;
    private volatile boolean capturing = false;
    private volatile boolean sizeLimitHit = false;

    private int sampleRate = 48000;
    private int channelCount = 1;
    private boolean floatPcm = false;
    private int bytesPerSample = 2;

    private long dataBytes = 0L;
    private long capturedMs = 0L;
    private long segmentStartMs = 0L;
    /** True while a pause-able segment is open, so time is never double counted. */
    private boolean segmentOpen = false;
    private volatile String lastError = null;

    private double lastMeterDb = -160.0;
    private long lastMeterEmitMs = 0L;

    private boolean prepared = false;

    public WavRecorderModule(ReactApplicationContext reactContext) {
        super(reactContext);
        this.reactContext = reactContext;
        this.audioManager =
            (AudioManager) reactContext.getSystemService(Context.AUDIO_SERVICE);
    }

    @NonNull
    @Override
    public String getName() {
        return "WavRecorder";
    }

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    @ReactMethod
    public void prepare(ReadableMap options, Promise promise) {
        try {
            teardown();

            int sr = options.hasKey("sampleRate") ? options.getInt("sampleRate") : 48000;
            int ch = options.hasKey("numberOfChannels") ? options.getInt("numberOfChannels") : 1;
            boolean wantFloat = options.hasKey("bitDepth")
                    && options.getInt("bitDepth") == 32;
            String path = options.hasKey("filePath") ? options.getString("filePath") : null;
            path = normalizeToFilesystemPath(path);
            if (path.isEmpty()) {
                throw new IllegalArgumentException("filePath is required");
            }


            if (sr <= 0) {
                throw new IllegalArgumentException("sampleRate must be greater than 0");
            }
            if (ch != 1 && ch != 2) {
                throw new IllegalArgumentException(
                        "Android WAV capture supports 1 (Mono) or 2 (Stereo) channels only");
            }
            if (path == null || path.isEmpty()) {
                throw new IllegalArgumentException("filePath is required");
            }

            int channelConfig = ch == 1
                    ? AudioFormat.CHANNEL_IN_MONO
                    : AudioFormat.CHANNEL_IN_STEREO;

            // Try the requested PCM encoding, then degrade rather than fail.
            int encoding = wantFloat
                    ? AudioFormat.ENCODING_PCM_FLOAT
                    : AudioFormat.ENCODING_PCM_16BIT;
            floatPcm = wantFloat;

            AudioRecord record = null;
            IllegalArgumentException lastError = null;

            int[] sources = resolveAudioSources();
            for (int source : sources) {
                try {
                    record = buildRecord(source, sr, channelConfig, encoding);
                    if (record != null
                            && record.getState() == AudioRecord.STATE_INITIALIZED) {
                        floatPcm = (encoding == AudioFormat.ENCODING_PCM_FLOAT);
                        break;
                    }
                    if (record != null) {
                        record.release();
                        record = null;
                    }
                } catch (IllegalArgumentException e) {
                    lastError = e;
                    if (record != null) {
                        record.release();
                        record = null;
                    }
                }
            }

            if (record == null) {
                // Last resort: force 16-bit mono, the most portable combination.
                floatPcm = false;
                encoding = AudioFormat.ENCODING_PCM_16BIT;
                ch = 1;
                channelConfig = AudioFormat.CHANNEL_IN_MONO;
                for (int source : sources) {
                    try {
                        record = buildRecord(source, sr, channelConfig, encoding);
                        if (record != null
                                && record.getState() == AudioRecord.STATE_INITIALIZED) {
                            break;
                        }
                        if (record != null) {
                            record.release();
                            record = null;
                        }
                    } catch (IllegalArgumentException ignored) {
                    }
                }
            }

            if (record == null) {
                throw new IllegalArgumentException(
                        "This device could not open an AudioRecord stream at "
                                + (sr / 1000.0) + " kHz. "
                                + (lastError != null ? lastError.getMessage() : ""),
                        lastError);
            }

            this.audioRecord = record;
            this.sampleRate = record.getSampleRate();
            this.channelCount = ch;
            this.bytesPerSample = floatPcm ? 4 : 2;

            if (options.hasKey("inputDeviceId")) {
                int deviceId = options.getInt("inputDeviceId");
                if (deviceId >= 0) {
                    applyPreferredDevice(deviceId);
                }
            }

            File file = new File(path);
            File parent = file.getParentFile();
            if (parent != null && !parent.exists()) {
                //noinspection ResultOfMethodCallIgnored
                parent.mkdirs();
            }

            this.outputFile = file;

            // M9: resuming a take that survived a process death means appending
            // to the PCM that is already on disk. The RIFF header is rewritten
            // from `dataBytes` on stop(), so it is simply left alone here.
            boolean append = options.hasKey("append") && options.getBoolean("append");
            long existingBytes = append && options.hasKey("existingDataBytes")
                    ? (long) options.getDouble("existingDataBytes")
                    : 0L;
            boolean resuming = append && file.exists() && existingBytes > 0L;

            this.stream = new BufferedOutputStream(
                    new FileOutputStream(file, resuming), 1 << 16);

            if (resuming) {
                this.dataBytes = existingBytes;
                this.capturedMs = options.hasKey("initialDurationMs")
                        ? (long) options.getDouble("initialDurationMs")
                        : 0L;
            } else {
                writePlaceholderHeader();
                this.dataBytes = 0L;
                this.capturedMs = 0L;
            }
            this.segmentOpen = false;
            this.lastError = null;
            this.lastMeterDb = -160.0;
            this.sizeLimitHit = false;
            this.prepared = true;

            WritableMap result = Arguments.createMap();
            result.putString("filePath", file.getAbsolutePath());
            result.putInt("sampleRate", this.sampleRate);
            result.putInt("numberOfChannels", this.channelCount);
            result.putInt("bitDepth", this.bytesPerSample * 8);
            result.putBoolean("floatPcm", this.floatPcm);
            promise.resolve(result);
        } catch (Throwable t) {
            teardown();
            promise.reject("E_WAV_PREPARE", t.getMessage(), t);
        }
    }

    @ReactMethod
    public void start(Promise promise) {
        if (!prepared || audioRecord == null) {
            promise.reject("E_WAV_NOT_PREPARED", "Recorder has not been prepared.");
            return;
        }
        if (running) {
            promise.resolve(null);
            return;
        }
        try {
            audioRecord.startRecording();
            running = true;
            capturing = true;
            segmentStartMs = SystemClock.elapsedRealtime();
            segmentOpen = true;

            worker = new Thread(this::captureLoop, "AudioRecorder-WAV");
            worker.setPriority(Thread.MAX_PRIORITY);
            worker.start();

            promise.resolve(null);
        } catch (Throwable t) {
            running = false;
            capturing = false;
            promise.reject("E_WAV_START", t.getMessage(), t);
        }
    }

    @ReactMethod
    public void pause(Promise promise) {
        if (!capturing) {
            promise.resolve(null);
            return;
        }
        capturing = false;
        closeSegment();
        try {
            if (audioRecord != null) {
                audioRecord.stop();
            }
        } catch (Throwable ignored) {
        }
        promise.resolve(null);
    }

    /**
     * C2: the old guard was `!prepared || running || ...`, but pause() leaves
     * `running` true (only `capturing` goes false), so resume() always bailed
     * out and the take never restarted. Gate on `capturing` instead.
     */
    @ReactMethod
    public void resume(Promise promise) {
        if (!prepared || capturing || audioRecord == null) {
            promise.resolve(null);
            return;
        }
        try {
            audioRecord.startRecording();
            segmentStartMs = SystemClock.elapsedRealtime();
            segmentOpen = true;
            capturing = true;
            running = true;
            promise.resolve(null);
        } catch (Throwable t) {
            promise.reject("E_WAV_RESUME", t.getMessage(), t);
        }
    }

    @ReactMethod
    public void stop(Promise promise) {
        closeSegment();
        capturing = false;
        running = false;

        Thread thread = worker;
        worker = null;
        if (thread != null) {
            try {
                thread.join(1500);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
        }

        long durationMs = capturedMs;
        long bytes = dataBytes;

        try {
            finalizeHeader();
        } catch (IOException e) {
            teardown();
            promise.reject("E_WAV_FINALIZE", e.getMessage(), e);
            return;
        }

        String path = outputFile != null ? outputFile.getAbsolutePath() : null;
        boolean truncated = sizeLimitHit;
        teardown();

        WritableMap result = Arguments.createMap();
        result.putString("filePath", path);
        result.putDouble("durationMs", (double) durationMs);
        result.putDouble("sizeBytes", (double) bytes);
        result.putBoolean("truncated", truncated);
        promise.resolve(result);
    }

    /**
     * H3: synchronous @ReactMethod calls are not supported under the New
     * Architecture (bridgeless/TurboModules), so this is Promise-based now.
     * JS keeps a live cache fed by the metering event for per-frame reads.
     */
    @ReactMethod
    public void getStatus(Promise promise) {
        WritableMap status = Arguments.createMap();
        boolean isRecording = capturing && running;
        status.putBoolean("isRecording", isRecording);
        status.putBoolean("isPaused", prepared && !capturing);
        status.putBoolean("canRecord", prepared);
        status.putDouble("durationMs", (double) currentDurationMs());
        status.putDouble("metering", lastMeterDb);
        status.putDouble("sizeBytes", (double) dataBytes);
        status.putString("lastError", lastError);
        status.putString(
                "filePath",
                outputFile != null ? outputFile.getAbsolutePath() : null
        );
        promise.resolve(status);
    }

    @ReactMethod
    public void release() {
        teardown();
    }

    @ReactMethod
    public void addListener(String eventName) {
    }

    @ReactMethod
    public void removeListeners(double count) {
    }

    // -----------------------------------------------------------------------
    // Capture loop
    // -----------------------------------------------------------------------

    private void captureLoop() {
        Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO);

        final int bytesPerFrame = channelCount * bytesPerSample;
        final int readBytes = Math.max(READ_FRAMES * bytesPerFrame, bytesPerFrame * 4);
        final byte[] raw = new byte[readBytes];

        while (running) {
            if (!capturing) {
                try {
                    Thread.sleep(15);
                } catch (InterruptedException ignored) {
                    Thread.currentThread().interrupt();
                    return;
                }
                continue;
            }

            AudioRecord record = audioRecord;
            BufferedOutputStream out = stream;
            if (record == null || out == null) {
                return;
            }

            int read;
            try {
                read = record.read(raw, 0, readBytes);
            } catch (Throwable t) {
                if (!capturing) {
                    continue;
                }
                abortCapture("Audio capture failed: " + t.getMessage());
                return;
            }

            if (read <= 0) {
                if (!capturing) {
                    continue;
                }
                // C3: every non-positive result used to `continue` (spinning a core
                // at 100% and never telling JS) or `return` while still reporting
                // isRecording=true. Any of them now aborts cleanly.
                abortCapture(read == AudioRecord.ERROR_DEAD_OBJECT
                        ? "The audio input device disconnected during capture."
                        : "AudioRecord stopped delivering data (error code " + read + ").");
                return;
            }

            try {
                out.write(raw, 0, read);
                dataBytes += read;

                long now = SystemClock.elapsedRealtime();
                if (now - lastMeterEmitMs >= METER_INTERVAL_MS) {
                    lastMeterEmitMs = now;
                    lastMeterDb = computeMeterDbfs(raw, read);
                    emitMetering(lastMeterDb, (double) dataBytes);
                }
            } catch (IOException e) {
                // Disk full / unwritable: the header never gets patched, so the
                // take is unplayable. Tell JS instead of dying quietly. (C3)
                abortCapture("Could not write audio to storage: " + e.getMessage());
                return;
            }

            if (dataBytes >= MAX_DATA_BYTES) {
                sizeLimitHit = true;
                abortCapture("The WAV container reached its size limit; the take was truncated.");
            }
        }
    }

    private long currentDurationMs() {
        return capturedMs + (segmentOpen ? SystemClock.elapsedRealtime() - segmentStartMs : 0L);
    }

    private void closeSegment() {
        if (segmentOpen) {
            capturedMs += SystemClock.elapsedRealtime() - segmentStartMs;
            segmentOpen = false;
        }
    }

    /**
     * Stops capture after an unrecoverable error, keeps the accumulated time and
     * tells JS so the UI can finalise instead of showing a frozen "recording".
     */
    private void abortCapture(String message) {
        closeSegment();
        capturing = false;
        running = false;
        lastError = message;
        Log.e(TAG, message);
        if (reactContext != null && reactContext.hasActiveReactInstance()) {
            WritableMap payload = Arguments.createMap();
            payload.putString("message", message);
            reactContext
                    .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                    .emit(EVENT_ERROR, payload);
        }
    }

    private double computeMeterDbfs(byte[] buffer, int length) {
        if (floatPcm) {
            ByteBuffer bb = ByteBuffer.wrap(buffer, 0, length)
                    .order(ByteOrder.LITTLE_ENDIAN);
            float peak = 0f;
            for (int i = 0; i + 4 <= length; i += 4) {
                float v = Math.abs(bb.getFloat(i));
                if (v > peak) {
                    peak = v;
                    if (peak >= 1f) {
                        return 0.0;
                    }
                }
            }
            if (peak <= 1e-7) {
                return -160.0;
            }
            return 20.0 * Math.log10(peak);
        }

        int peak = 0;
        for (int i = 0; i + 2 <= length; i += 2) {
            int s = (short) ((buffer[i] & 0xFF) | (buffer[i + 1] << 8));
            int a = s < 0 ? -s : s;
            if (a > peak) {
                peak = a;
                if (peak >= 32767) {
                    return 0.0;
                }
            }
        }
        if (peak == 0) {
            return -160.0;
        }
        return 20.0 * Math.log10((double) peak / 32767.0);
    }

    private void emitMetering(double db, double bytes) {
        if (!reactContext.hasActiveReactInstance()) {
            return;
        }
        WritableMap payload = Arguments.createMap();
        payload.putDouble("metering", db);
        payload.putDouble("sizeBytes", bytes);
        payload.putDouble("durationMs", (double) currentDurationMs());
        reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                .emit(EVENT_METERING, payload);
    }

    // -----------------------------------------------------------------------
    // Device negotiation
    // -----------------------------------------------------------------------

    private AudioRecord buildRecord(
            int source, int sr, int channelConfig, int encoding) {
        int minBuffer = AudioRecord.getMinBufferSize(sr, channelConfig, encoding);
        if (minBuffer <= 0) {
            throw new IllegalArgumentException(
                    "Unsupported capture format: " + (sr / 1000.0) + " kHz / "
                            + (channelConfig == AudioFormat.CHANNEL_IN_MONO ? "Mono" : "Stereo")
            );
        }
        int framesPerSample = encoding == AudioFormat.ENCODING_PCM_FLOAT ? 4 : 2;
        int want = Math.max(minBuffer, READ_FRAMES * 2 * framesPerSample);
        int bufferBytes = want * 2;
        return new AudioRecord(source, sr, channelConfig, encoding, bufferBytes);
    }

    private int[] resolveAudioSources() {
        boolean unprocessed = false;
        try {
            unprocessed = "true".equalsIgnoreCase(
                    audioManager.getProperty(
                            AudioManager.PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED
                    )
            );
        } catch (Throwable ignored) {
        }

        if (unprocessed) {
            return new int[]{
                    MediaRecorder.AudioSource.UNPROCESSED,
                    MediaRecorder.AudioSource.MIC,
                    MediaRecorder.AudioSource.DEFAULT
            };
        }
        return new int[]{
                MediaRecorder.AudioSource.MIC,
                MediaRecorder.AudioSource.DEFAULT
        };
    }

    private void applyPreferredDevice(int deviceId) {
        if (audioManager == null || audioRecord == null) {
            return;
        }
        try {
            AudioDeviceInfo[] all = audioManager.getDevices(
                    AudioManager.GET_DEVICES_INPUTS);
            if (all == null) {
                return;
            }
            for (AudioDeviceInfo info : all) {
                if (info != null && info.getId() == deviceId) {
                    audioRecord.setPreferredDevice(info);
                    return;
                }
            }
        } catch (Throwable ignored) {
        }
    }

    // -----------------------------------------------------------------------
    // RIFF container
    // -----------------------------------------------------------------------

    private void writePlaceholderHeader() throws IOException {
        short audioFormat = (short) (floatPcm ? 3 : 1); // 1 = PCM, 3 = IEEE float
        short channels = (short) channelCount;
        int byteRate = sampleRate * channelCount * bytesPerSample;
        short blockAlign = (short) (channelCount * bytesPerSample);
        short bitsPerSample = (short) (bytesPerSample * 8);

        ByteBuffer bb = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN);
        bb.put("RIFF".getBytes());
        bb.putInt(0);                 // patched: 36 + dataBytes
        bb.put("WAVE".getBytes());
        bb.put("fmt ".getBytes());
        bb.putInt(16);
        bb.putShort(audioFormat);
        bb.putShort(channels);
        bb.putInt(sampleRate);
        bb.putInt(byteRate);
        bb.putShort(blockAlign);
        bb.putShort(bitsPerSample);
        bb.put("data".getBytes());
        bb.putInt(0);                 // patched: dataBytes

        stream.write(bb.array());
    }

    private void finalizeHeader() throws IOException {
        if (stream == null || outputFile == null) {
            return;
        }
        stream.flush();

        long riffSize = 36L + dataBytes;
        writeLe32(outputFile, 4, riffSize);
        writeLe32(outputFile, 40, dataBytes);
    }

    /**
     * RIFF sizes are little-endian uint32. RandomAccessFile.write(int) writes a
     * single byte and writeInt() writes big-endian, so the bytes are packed by
     * hand. (C1: previously this wrote one byte and produced invalid files.)
     */
    private static void writeLe32(File file, long offset, long value) throws IOException {
        ByteBuffer b = ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN);
        b.putInt((int) Math.min(Math.max(value, 0L), 0xFFFFFFFFL));
        try (RandomAccessFile raf = new RandomAccessFile(file, "rw")) {
            raf.seek(offset);
            raf.write(b.array());
        }
    }

    /**
     * Patches the RIFF header of a take whose process died before stop() ran.
     * The journal records the byte count, so the file can be made playable.
     */
    @ReactMethod
    public void repair(ReadableMap options, Promise promise) {
        try {
            String path = normalizeToFilesystemPath(
                    options.hasKey("filePath") ? options.getString("filePath") : null);
            long bytes = options.hasKey("dataBytes") ? (long) options.getDouble("dataBytes") : 0L;
            if (path.isEmpty() || bytes <= 0) {
                promise.reject("E_WAV_REPAIR", "filePath and dataBytes are required");
                return;
            }
            File file = new File(path);
            if (!file.exists()) {
                promise.reject("E_WAV_REPAIR", "File does not exist: " + path);
                return;
            }
            long onDisk = file.length() - 44L;
            if (onDisk <= 0L) {
                promise.reject("E_WAV_REPAIR", "File is too short to contain PCM data");
                return;
            }

            // The journal is written every 200 ms and the writer buffers up to
            // 64 KB, so the recorded byte count can sit slightly ahead of what
            // actually reached the disk. Trust the smaller of the two, floored
            // to a whole frame so no partial sample is ever described.
            int frame = options.hasKey("frameSize") ? options.getInt("frameSize") : 1;
            long target = Math.min(bytes, onDisk);
            if (frame > 1) {
                target -= target % frame;
            }
            if (target <= 0L) {
                promise.reject("E_WAV_REPAIR", "No complete audio frames were written");
                return;
            }

            try (java.io.FileChannel channel = new java.io.FileOutputStream(file, true).getChannel()) {
                channel.truncate(44L + target);
            }
            writeLe32(file, 4, 36L + target);
            writeLe32(file, 40, target);
            WritableMap result = Arguments.createMap();
            result.putString("filePath", file.getAbsolutePath());
            result.putDouble("dataBytes", (double) target);
            result.putBoolean("truncatedToFrame", target != bytes);
            promise.resolve(result);
        } catch (Throwable t) {
            promise.reject("E_WAV_REPAIR", t.getMessage(), t);
        }
    }

    private void teardown() {
        capturing = false;
        running = false;

        Thread thread = worker;
        worker = null;
        if (thread != null && thread != Thread.currentThread()) {
            try {
                thread.join(1000);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
        }

        if (audioRecord != null) {
            try {
                audioRecord.stop();
            } catch (Throwable ignored) {
            }
            try {
                audioRecord.release();
            } catch (Throwable ignored) {
            }
            audioRecord = null;
        }

        if (stream != null) {
            try {
                stream.flush();
                stream.close();
            } catch (Throwable ignored) {
            }
            stream = null;
        }

        prepared = false;
    }

    @Override
    public void invalidate() {
        teardown();
        super.invalidate();
    }

        /**
     * Accepts either a bare filesystem path or a file:// URI and always returns
     * an absolute filesystem path. java.io.File resolves relative-looking paths
     * against the process CWD, which turns a file:// URI into
     * "<cwd>/file:/data/..." and fails with ENOENT.
     */
    private static String normalizeToFilesystemPath(String raw) {
        String p = raw == null ? "" : raw.trim();
        if (p.startsWith("file://")) {
            p = p.substring("file://".length());
        }
        if (p.isEmpty()) {
            return "";
        }
        if (!p.startsWith("/")) {
            p = "/" + p;
        }
        try {
            p = java.net.URLDecoder.decode(p, "UTF-8");
        } catch (Exception ignored) {
            // keep the raw form if it isn't valid percent-encoding
        }
        return p;
    }

}