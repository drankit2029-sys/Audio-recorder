package expo.modules.audiohardwarerouter;

import android.media.AudioFormat;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.media.MediaMuxer;
import android.os.Build;
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

/**
 * File plumbing for the studio engine: the 44-byte RIFF header of the working
 * file, importing any take (WAV copy or MediaCodec decode) into a working
 * file, scanning waveform peaks, and encoding the working file into the
 * delivery format (WAV, AAC/M4A, AAC-ADTS, AMR-NB, AMR-WB).
 *
 * Everything here runs on a background executor, never on the UI thread.
 */
final class StudioCodec {

    private static final String TAG = "StudioCodec";

    static final int HEADER_BYTES = 44;

    interface Progress {
        void onProgress(float fraction);
    }

    interface BucketConsumer {
        void onBucket(int bucketIndex, float peak);
    }

    private StudioCodec() {
    }

    // -----------------------------------------------------------------------
    // Working-file header
    // -----------------------------------------------------------------------

    static byte[] buildHeader(int sampleRate, int channels, boolean floatPcm, long dataBytes) {
        int bps = floatPcm ? 4 : 2;
        long clampedData = Math.max(0L, Math.min(0xFFFFFFFFL - 36L, dataBytes));
        ByteBuffer bb = ByteBuffer.allocate(HEADER_BYTES).order(ByteOrder.LITTLE_ENDIAN);
        bb.put((byte) 'R').put((byte) 'I').put((byte) 'F').put((byte) 'F');
        bb.putInt((int) (36L + clampedData));
        bb.put((byte) 'W').put((byte) 'A').put((byte) 'V').put((byte) 'E');
        bb.put((byte) 'f').put((byte) 'm').put((byte) 't').put((byte) ' ');
        bb.putInt(16);
        bb.putShort((short) (floatPcm ? 3 : 1));
        bb.putShort((short) channels);
        bb.putInt(sampleRate);
        bb.putInt(sampleRate * channels * bps);
        bb.putShort((short) (channels * bps));
        bb.putShort((short) (bps * 8));
        bb.put((byte) 'd').put((byte) 'a').put((byte) 't').put((byte) 'a');
        bb.putInt((int) clampedData);
        return bb.array();
    }

    /** Rewrites the two size fields. Caller owns synchronisation of {@code raf}. */
    static void patchSizes(RandomAccessFile raf, long dataBytes) throws IOException {
        long clampedData = Math.max(0L, Math.min(0xFFFFFFFFL - 36L, dataBytes));
        byte[] four = new byte[4];
        putLe32(four, 0, 36L + clampedData);
        raf.seek(4);
        raf.write(four);
        putLe32(four, 0, clampedData);
        raf.seek(40);
        raf.write(four);
    }

    // -----------------------------------------------------------------------
    // WAV parsing
    // -----------------------------------------------------------------------

    static final class WavInfo {
        int formatTag;
        int channels;
        int sampleRate;
        int bitsPerSample;
        long dataOffset;
        long dataBytes;

        int bytesPerSample() {
            return (bitsPerSample + 7) / 8;
        }

        int frameBytes() {
            return bytesPerSample() * channels;
        }

        boolean isSupportedPcm() {
            if (channels <= 0 || sampleRate <= 0) {
                return false;
            }
            if (formatTag == 1) {
                return bitsPerSample == 8 || bitsPerSample == 16
                        || bitsPerSample == 24 || bitsPerSample == 32;
            }
            if (formatTag == 3) {
                return bitsPerSample == 32 || bitsPerSample == 64;
            }
            return false;
        }

        /** True when the file is byte-for-byte the working-file layout. */
        boolean isWorkingLayout() {
            return dataOffset == HEADER_BYTES && channels >= 1 && channels <= 2
                    && ((formatTag == 1 && bitsPerSample == 16)
                    || (formatTag == 3 && bitsPerSample == 32));
        }
    }

    static WavInfo parseWav(File file) throws IOException {
        RandomAccessFile f = new RandomAccessFile(file, "r");
        try {
            long len = f.length();
            if (len < 12) {
                throw new IOException("Not a WAV file");
            }
            byte[] head = new byte[12];
            f.readFully(head);
            if (!fourcc(head, 0, "RIFF") || !fourcc(head, 8, "WAVE")) {
                throw new IOException("Not a RIFF/WAVE file");
            }
            WavInfo info = new WavInfo();
            boolean haveFmt = false;
            boolean haveData = false;
            long pos = 12;
            byte[] chunk = new byte[8];
            while (pos + 8 <= len) {
                f.seek(pos);
                f.readFully(chunk);
                long size = le32(chunk, 4);
                long body = pos + 8;
                if (fourcc(chunk, 0, "fmt ")) {
                    int want = (int) Math.max(16L, Math.min(40L, size));
                    int have = (int) Math.min(want, Math.max(0L, len - body));
                    byte[] fmt = new byte[want];
                    f.readFully(fmt, 0, have);
                    info.formatTag = le16(fmt, 0);
                    info.channels = le16(fmt, 2);
                    info.sampleRate = (int) le32(fmt, 4);
                    info.bitsPerSample = le16(fmt, 14);
                    if (info.formatTag == 0xFFFE && have >= 26) {
                        // WAVE_FORMAT_EXTENSIBLE: the real tag opens the SubFormat GUID.
                        info.formatTag = le16(fmt, 24);
                    }
                    haveFmt = true;
                } else if (fourcc(chunk, 0, "data")) {
                    info.dataOffset = body;
                    long avail = Math.max(0L, len - body);
                    // A header that was never patched (process death) says 0 or
                    // garbage; the bytes on disk are the truth then.
                    info.dataBytes = (size == 0L || size == 0xFFFFFFFFL || size > avail) ? avail : size;
                    haveData = true;
                    break;
                }
                pos = body + size + (size & 1L);
            }
            if (!haveFmt || !haveData) {
                throw new IOException("The WAV file has no fmt or data chunk");
            }
            int frame = info.frameBytes();
            if (frame > 0) {
                info.dataBytes -= info.dataBytes % frame;
            }
            return info;
        } finally {
            f.close();
        }
    }

    // -----------------------------------------------------------------------
    // Import
    // -----------------------------------------------------------------------

    static final class ImportResult {
        int sampleRate;
        int channels;
        boolean floatPcm;
        long dataBytes;
        String sourceMime;
        int sourceBitRate;
    }

    /**
     * Copies or decodes {@code src} into {@code out} as a working file
     * (44-byte header, PCM16 or float32, mono or stereo).
     */
    static ImportResult importToWorkingFile(File src, File out, Progress progress) throws IOException {
        if (!src.exists() || src.length() <= 0) {
            throw new IOException("The recording file is missing or empty.");
        }
        WavInfo wav = null;
        try {
            wav = parseWav(src);
        } catch (IOException notWav) {
            wav = null;
        }
        if (wav != null && wav.isSupportedPcm()) {
            return importWav(src, wav, out, progress);
        }
        return importCompressed(src, out, progress);
    }

    private static ImportResult importWav(File src, WavInfo info, File out, Progress progress)
            throws IOException {
        final int inCh = info.channels;
        final int outCh = Math.min(2, inCh);
        final boolean outFloat = info.formatTag == 3 || info.bitsPerSample > 16;
        final int inBps = info.bytesPerSample();
        final int inFrame = inBps * inCh;
        final int outFrame = (outFloat ? 4 : 2) * outCh;
        final boolean direct = inCh == outCh
                && ((info.formatTag == 1 && info.bitsPerSample == 16 && !outFloat)
                || (info.formatTag == 3 && info.bitsPerSample == 32));

        InputStream in = new BufferedInputStream(new FileInputStream(src), 1 << 16);
        OutputStream os = new BufferedOutputStream(new FileOutputStream(out, false), 1 << 16);
        long written = 0L;
        try {
            os.write(buildHeader(info.sampleRate, outCh, outFloat, 0L));
            skipFully(in, info.dataOffset);

            final int framesPerBlock = 4096;
            byte[] inBuf = new byte[framesPerBlock * inFrame];
            byte[] outBuf = direct ? inBuf : new byte[framesPerBlock * outFrame];
            ByteBuffer ob = ByteBuffer.wrap(outBuf).order(ByteOrder.LITTLE_ENDIAN);
            long remaining = info.dataBytes;
            long total = Math.max(1L, info.dataBytes);
            float lastReported = -1f;

            while (remaining > 0L) {
                int want = (int) Math.min(inBuf.length, remaining);
                int n = readFully(in, inBuf, want);
                if (n <= 0) {
                    break;
                }
                n -= n % inFrame;
                if (n <= 0) {
                    break;
                }
                if (direct) {
                    os.write(inBuf, 0, n);
                    written += n;
                } else {
                    int frames = n / inFrame;
                    ob.clear();
                    for (int fr = 0; fr < frames; fr++) {
                        int base = fr * inFrame;
                        for (int c = 0; c < outCh; c++) {
                            double v = readSample(inBuf, base + c * inBps, info.formatTag, info.bitsPerSample);
                            if (outFloat) {
                                ob.putFloat((float) v);
                            } else {
                                ob.putShort(toPcm16((float) v));
                            }
                        }
                    }
                    int bytes = frames * outFrame;
                    os.write(outBuf, 0, bytes);
                    written += bytes;
                }
                remaining -= n;
                float frac = 1f - (float) remaining / (float) total;
                if (progress != null && frac - lastReported >= 0.01f) {
                    lastReported = frac;
                    progress.onProgress(frac);
                }
            }
        } finally {
            try {
                in.close();
            } catch (IOException ignored) {
            }
            os.close();
        }

        RandomAccessFile raf = new RandomAccessFile(out, "rw");
        try {
            raf.seek(0);
            raf.write(buildHeader(info.sampleRate, outCh, outFloat, written));
        } finally {
            raf.close();
        }

        ImportResult r = new ImportResult();
        r.sampleRate = info.sampleRate;
        r.channels = outCh;
        r.floatPcm = outFloat;
        r.dataBytes = written;
        r.sourceMime = "audio/wav";
        r.sourceBitRate = info.sampleRate * inCh * info.bitsPerSample;
        return r;
    }

    private static ImportResult importCompressed(File src, File out, Progress progress)
            throws IOException {
        MediaExtractor extractor = new MediaExtractor();
        MediaCodec decoder = null;
        OutputStream os = null;
        long written = 0L;
        int outRate;
        int decCh;
        boolean decFloat = false;
        String mime;
        int bitRate = 0;
        try {
            extractor.setDataSource(src.getAbsolutePath());
            int track = -1;
            MediaFormat inFormat = null;
            for (int i = 0; i < extractor.getTrackCount(); i++) {
                MediaFormat f = extractor.getTrackFormat(i);
                String m = f.getString(MediaFormat.KEY_MIME);
                if (m != null && m.startsWith("audio/")) {
                    track = i;
                    inFormat = f;
                    break;
                }
            }
            if (track < 0 || inFormat == null) {
                throw new IOException("No playable audio track was found in this file.");
            }
            extractor.selectTrack(track);
            mime = inFormat.getString(MediaFormat.KEY_MIME);
            outRate = inFormat.containsKey(MediaFormat.KEY_SAMPLE_RATE)
                    ? inFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE) : 44100;
            decCh = inFormat.containsKey(MediaFormat.KEY_CHANNEL_COUNT)
                    ? inFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT) : 1;
            if (inFormat.containsKey(MediaFormat.KEY_BIT_RATE)) {
                bitRate = inFormat.getInteger(MediaFormat.KEY_BIT_RATE);
            }
            long durationUs = inFormat.containsKey(MediaFormat.KEY_DURATION)
                    ? inFormat.getLong(MediaFormat.KEY_DURATION) : 0L;
            if (bitRate <= 0 && durationUs > 0L) {
                bitRate = (int) Math.min(Integer.MAX_VALUE,
                        (src.length() * 8L * 1000000L) / durationUs);
            }

            decoder = MediaCodec.createDecoderByType(mime);
            decoder.configure(inFormat, null, null, 0);
            decoder.start();

            os = new BufferedOutputStream(new FileOutputStream(out, false), 1 << 16);
            os.write(buildHeader(outRate, Math.min(2, Math.max(1, decCh)), false, 0L));

            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            boolean inputDone = false;
            boolean outputDone = false;
            byte[] pcm = new byte[0];
            float lastReported = -1f;
            int idleSpins = 0;

            while (!outputDone) {
                if (!inputDone) {
                    int inIndex = decoder.dequeueInputBuffer(10000);
                    if (inIndex >= 0) {
                        ByteBuffer ib = decoder.getInputBuffer(inIndex);
                        int n = ib == null ? -1 : extractor.readSampleData(ib, 0);
                        if (n < 0) {
                            decoder.queueInputBuffer(inIndex, 0, 0, 0L,
                                    MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                            inputDone = true;
                        } else {
                            long t = extractor.getSampleTime();
                            decoder.queueInputBuffer(inIndex, 0, n, Math.max(0L, t), 0);
                            extractor.advance();
                            if (progress != null && durationUs > 0L) {
                                float frac = Math.min(1f, (float) t / (float) durationUs);
                                if (frac - lastReported >= 0.01f) {
                                    lastReported = frac;
                                    progress.onProgress(frac);
                                }
                            }
                        }
                    }
                }

                int outIndex = decoder.dequeueOutputBuffer(info, 10000);
                if (outIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    MediaFormat of = decoder.getOutputFormat();
                    if (of.containsKey(MediaFormat.KEY_SAMPLE_RATE)) {
                        outRate = of.getInteger(MediaFormat.KEY_SAMPLE_RATE);
                    }
                    if (of.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) {
                        decCh = of.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
                    }
                    if (Build.VERSION.SDK_INT >= 24 && of.containsKey(MediaFormat.KEY_PCM_ENCODING)) {
                        decFloat = of.getInteger(MediaFormat.KEY_PCM_ENCODING)
                                == AudioFormat.ENCODING_PCM_FLOAT;
                    }
                    idleSpins = 0;
                } else if (outIndex >= 0) {
                    idleSpins = 0;
                    if (info.size > 0) {
                        ByteBuffer ob = decoder.getOutputBuffer(outIndex);
                        if (ob != null) {
                            ob.position(info.offset);
                            ob.limit(info.offset + info.size);
                            ob.order(ByteOrder.LITTLE_ENDIAN);
                            int ch = Math.max(1, decCh);
                            int outCh = Math.min(2, ch);
                            int inBps = decFloat ? 4 : 2;
                            int frames = info.size / (inBps * ch);
                            int bytes = frames * outCh * 2;
                            if (pcm.length < bytes) {
                                pcm = new byte[bytes];
                            }
                            ByteBuffer pb = ByteBuffer.wrap(pcm).order(ByteOrder.LITTLE_ENDIAN);
                            for (int fr = 0; fr < frames; fr++) {
                                int base = info.offset + fr * inBps * ch;
                                for (int c = 0; c < outCh; c++) {
                                    int at = base + c * inBps;
                                    if (decFloat) {
                                        pb.putShort(toPcm16(ob.getFloat(at)));
                                    } else {
                                        pb.putShort(ob.getShort(at));
                                    }
                                }
                            }
                            os.write(pcm, 0, bytes);
                            written += bytes;
                        }
                    }
                    decoder.releaseOutputBuffer(outIndex, false);
                    if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
                        outputDone = true;
                    }
                } else if (inputDone) {
                    // Some decoders never flag EOS on the output side.
                    if (++idleSpins > 300) {
                        outputDone = true;
                    }
                }
            }
        } finally {
            if (decoder != null) {
                try {
                    decoder.stop();
                } catch (Throwable ignored) {
                }
                try {
                    decoder.release();
                } catch (Throwable ignored) {
                }
            }
            try {
                extractor.release();
            } catch (Throwable ignored) {
            }
            if (os != null) {
                os.close();
            }
        }

        int outCh = Math.min(2, Math.max(1, decCh));
        if (written <= 0L) {
            throw new IOException("The file could not be decoded (no audio frames).");
        }
        RandomAccessFile raf = new RandomAccessFile(out, "rw");
        try {
            raf.seek(0);
            raf.write(buildHeader(outRate, outCh, false, written));
        } finally {
            raf.close();
        }

        ImportResult r = new ImportResult();
        r.sampleRate = outRate;
        r.channels = outCh;
        r.floatPcm = false;
        r.dataBytes = written;
        r.sourceMime = mime;
        r.sourceBitRate = bitRate;
        return r;
    }

    // -----------------------------------------------------------------------
    // Peak scanning
    // -----------------------------------------------------------------------

    /**
     * Streams the working file once and reports the absolute peak of every
     * {@code framesPerBucket} frames.
     */
    static void scanBucketPeaks(File wav, int channels, boolean floatPcm, long dataBytes,
                                int framesPerBucket, BucketConsumer consumer, Progress progress)
            throws IOException {
        int bps = floatPcm ? 4 : 2;
        int frameBytes = bps * channels;
        long totalFrames = dataBytes / frameBytes;
        if (totalFrames <= 0L || framesPerBucket <= 0) {
            return;
        }
        InputStream in = new BufferedInputStream(new FileInputStream(wav), 1 << 16);
        try {
            skipFully(in, HEADER_BYTES);
            byte[] buf = new byte[Math.max(frameBytes, (1 << 16) - ((1 << 16) % frameBytes))];
            ByteBuffer bb = ByteBuffer.wrap(buf).order(ByteOrder.LITTLE_ENDIAN);
            long frame = 0L;
            int bucket = 0;
            int inBucket = 0;
            float peak = 0f;
            float lastReported = -1f;
            while (frame < totalFrames) {
                int want = (int) Math.min(buf.length, (totalFrames - frame) * frameBytes);
                int n = readFully(in, buf, want);
                if (n <= 0) {
                    break;
                }
                int frames = n / frameBytes;
                for (int fr = 0; fr < frames; fr++) {
                    int base = fr * frameBytes;
                    for (int c = 0; c < channels; c++) {
                        float a;
                        if (floatPcm) {
                            a = Math.abs(bb.getFloat(base + c * 4));
                        } else {
                            a = Math.abs(bb.getShort(base + c * 2) / 32768f);
                        }
                        if (a > peak) {
                            peak = a;
                        }
                    }
                    if (++inBucket >= framesPerBucket) {
                        consumer.onBucket(bucket, peak);
                        bucket++;
                        inBucket = 0;
                        peak = 0f;
                    }
                }
                frame += frames;
                if (progress != null) {
                    float frac = (float) frame / (float) totalFrames;
                    if (frac - lastReported >= 0.02f) {
                        lastReported = frac;
                        progress.onProgress(frac);
                    }
                }
            }
            if (inBucket > 0) {
                consumer.onBucket(bucket, peak);
            }
        } finally {
            in.close();
        }
    }

    // -----------------------------------------------------------------------
    // Export
    // -----------------------------------------------------------------------

    /** Formats understood by {@link #encode}. */
    static boolean isLossy(String format) {
        return !"wav".equals(format);
    }

    /**
     * Encodes the working file into {@code out}. Returns the number of PCM
     * frames that were encoded (at the output sample rate).
     */
    static long encode(File wav, int srcRate, int srcCh, boolean srcFloat, long dataBytes,
                       File out, String format, int bitRate, int wantRate, int wantCh,
                       Progress progress) throws IOException {
        if ("amr_nb".equals(format) || "amr_wb".equals(format)) {
            boolean wb = "amr_wb".equals(format);
            return encodeAmr(wav, srcRate, srcCh, srcFloat, dataBytes, out, wb, progress);
        }
        int profile = MediaCodecInfo.CodecProfileLevel.AACObjectLC;
        if ("he_aac".equals(format)) {
            profile = MediaCodecInfo.CodecProfileLevel.AACObjectHE;
        } else if ("aac_eld".equals(format)) {
            profile = MediaCodecInfo.CodecProfileLevel.AACObjectELD;
        }
        boolean adts = "aac_adts".equals(format);
        if (adts) {
            profile = MediaCodecInfo.CodecProfileLevel.AACObjectLC;
        }
        return encodeAac(wav, srcRate, srcCh, srcFloat, dataBytes, out, profile,
                bitRate, wantRate, wantCh, adts, progress);
    }

    private interface EncodedSink {
        void onFormat(MediaFormat format) throws IOException;

        void onSample(ByteBuffer data, MediaCodec.BufferInfo info) throws IOException;

        void finish() throws IOException;

        void abort();
    }

    private static final int[] ADTS_RATES = {
            96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050,
            16000, 12000, 11025, 8000, 7350
    };

    private static long encodeAac(File wav, int srcRate, int srcCh, boolean srcFloat, long dataBytes,
                                  File out, int profile, int bitRate, int wantRate, int wantCh,
                                  boolean adts, Progress progress) throws IOException {
        final String mime = MediaFormat.MIMETYPE_AUDIO_AAC;
        int outCh = Math.max(1, Math.min(2, wantCh > 0 ? Math.min(wantCh, Math.max(srcCh, 1)) : srcCh));
        int rate = pickEncoderRate(mime, wantRate > 0 ? wantRate : srcRate,
                new int[]{48000, 44100, 32000, 24000, 22050, 16000});
        if (adts && indexOf(ADTS_RATES, rate) < 0) {
            rate = 44100;
        }
        int br = bitRate > 0 ? bitRate : 128000;

        MediaCodec codec = null;
        Exception lastError = null;
        int[] profiles = profile == MediaCodecInfo.CodecProfileLevel.AACObjectLC
                ? new int[]{profile}
                : new int[]{profile, MediaCodecInfo.CodecProfileLevel.AACObjectLC};
        for (int p : profiles) {
            try {
                MediaFormat fmt = MediaFormat.createAudioFormat(mime, rate, outCh);
                fmt.setInteger(MediaFormat.KEY_AAC_PROFILE, p);
                fmt.setInteger(MediaFormat.KEY_BIT_RATE, br);
                fmt.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16384 * outCh);
                codec = MediaCodec.createEncoderByType(mime);
                codec.configure(fmt, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
                profile = p;
                break;
            } catch (Exception e) {
                lastError = e;
                if (codec != null) {
                    try {
                        codec.release();
                    } catch (Throwable ignored) {
                    }
                    codec = null;
                }
            }
        }
        if (codec == null) {
            throw new IOException("This device has no usable AAC encoder: "
                    + (lastError != null ? lastError.getMessage() : "unknown error"));
        }

        EncodedSink sink;
        if (adts) {
            sink = new AdtsSink(out, rate, outCh);
        } else {
            sink = new MuxerSink(out, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
        }
        PcmSource source = new PcmSource(wav, srcRate, srcCh, srcFloat, dataBytes, rate, outCh);
        return runEncoder(codec, sink, source, rate, outCh, 1024, progress);
    }

    private static long encodeAmr(File wav, int srcRate, int srcCh, boolean srcFloat, long dataBytes,
                                  File out, boolean wb, Progress progress) throws IOException {
        final String mime = wb ? MediaFormat.MIMETYPE_AUDIO_AMR_WB : MediaFormat.MIMETYPE_AUDIO_AMR_NB;
        final int rate = wb ? 16000 : 8000;
        MediaCodec codec;
        try {
            MediaFormat fmt = MediaFormat.createAudioFormat(mime, rate, 1);
            fmt.setInteger(MediaFormat.KEY_BIT_RATE, wb ? 23850 : 12200);
            fmt.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 8192);
            codec = MediaCodec.createEncoderByType(mime);
            codec.configure(fmt, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
        } catch (Exception e) {
            throw new IOException("This device has no usable " + (wb ? "AMR-WB" : "AMR-NB")
                    + " encoder: " + e.getMessage(), e);
        }
        EncodedSink sink;
        if (Build.VERSION.SDK_INT >= 26) {
            sink = new MuxerSink(out, MediaMuxer.OutputFormat.MUXER_OUTPUT_3GPP);
        } else {
            sink = new RawAmrSink(out, wb);
        }
        PcmSource source = new PcmSource(wav, srcRate, srcCh, srcFloat, dataBytes, rate, 1);
        return runEncoder(codec, sink, source, rate, 1, wb ? 320 : 160, progress);
    }

    private static long runEncoder(MediaCodec codec, EncodedSink sink, PcmSource source,
                                   int rate, int ch, int frameQuantum, Progress progress)
            throws IOException {
        boolean ok = false;
        long framesQueued = 0L;
        try {
            codec.start();
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            boolean inputDone = false;
            boolean outputDone = false;
            short[] pcm = new short[4096 * ch];
            float lastReported = -1f;
            int idleSpins = 0;

            while (!outputDone) {
                if (!inputDone) {
                    int inIndex = codec.dequeueInputBuffer(10000);
                    if (inIndex >= 0) {
                        ByteBuffer ib = codec.getInputBuffer(inIndex);
                        if (ib == null) {
                            throw new IOException("Encoder returned no input buffer");
                        }
                        ib.clear();
                        int capacityFrames = ib.remaining() / (2 * ch);
                        int maxFrames = Math.min(capacityFrames, 4096);
                        if (frameQuantum > 1 && maxFrames > frameQuantum) {
                            maxFrames -= maxFrames % frameQuantum;
                        }
                        int frames = maxFrames > 0 ? source.read(pcm, maxFrames) : 0;
                        long pts = framesQueued * 1000000L / rate;
                        if (frames <= 0) {
                            codec.queueInputBuffer(inIndex, 0, 0, pts,
                                    MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                            inputDone = true;
                        } else {
                            ib.order(ByteOrder.LITTLE_ENDIAN);
                            ib.asShortBuffer().put(pcm, 0, frames * ch);
                            codec.queueInputBuffer(inIndex, 0, frames * ch * 2, pts, 0);
                            framesQueued += frames;
                        }
                        if (progress != null) {
                            float frac = source.progress();
                            if (frac - lastReported >= 0.01f) {
                                lastReported = frac;
                                progress.onProgress(frac);
                            }
                        }
                    }
                }

                int outIndex = codec.dequeueOutputBuffer(info, 10000);
                if (outIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    sink.onFormat(codec.getOutputFormat());
                    idleSpins = 0;
                } else if (outIndex >= 0) {
                    idleSpins = 0;
                    ByteBuffer ob = codec.getOutputBuffer(outIndex);
                    boolean config = (info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0;
                    if (ob != null && info.size > 0 && !config) {
                        ob.position(info.offset);
                        ob.limit(info.offset + info.size);
                        sink.onSample(ob, info);
                    }
                    codec.releaseOutputBuffer(outIndex, false);
                    if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
                        outputDone = true;
                    }
                } else if (inputDone) {
                    if (++idleSpins > 500) {
                        Log.w(TAG, "Encoder never signalled end of stream; closing the file anyway.");
                        outputDone = true;
                    }
                }
            }
            sink.finish();
            ok = true;
            return framesQueued;
        } finally {
            source.close();
            try {
                codec.stop();
            } catch (Throwable ignored) {
            }
            try {
                codec.release();
            } catch (Throwable ignored) {
            }
            if (!ok) {
                sink.abort();
            }
        }
    }

    private static int pickEncoderRate(String mime, int want, int[] fallbacks) {
        try {
            MediaCodec probe = MediaCodec.createEncoderByType(mime);
            try {
                MediaCodecInfo.CodecCapabilities caps =
                        probe.getCodecInfo().getCapabilitiesForType(mime);
                MediaCodecInfo.AudioCapabilities audio = caps.getAudioCapabilities();
                if (audio == null || audio.isSampleRateSupported(want)) {
                    return want;
                }
                for (int r : fallbacks) {
                    if (audio.isSampleRateSupported(r)) {
                        return r;
                    }
                }
            } finally {
                probe.release();
            }
        } catch (Throwable t) {
            Log.w(TAG, "Could not probe encoder sample rates: " + t.getMessage());
        }
        return want;
    }

    private static final class MuxerSink implements EncodedSink {
        private final File out;
        private final MediaMuxer muxer;
        private int track = -1;
        private boolean started = false;
        private boolean wroteSample = false;

        MuxerSink(File out, int outputFormat) throws IOException {
            this.out = out;
            this.muxer = new MediaMuxer(out.getAbsolutePath(), outputFormat);
        }

        @Override
        public void onFormat(MediaFormat format) {
            if (!started) {
                track = muxer.addTrack(format);
                muxer.start();
                started = true;
            }
        }

        @Override
        public void onSample(ByteBuffer data, MediaCodec.BufferInfo info) throws IOException {
            if (!started) {
                throw new IOException("Encoder produced audio before its output format");
            }
            muxer.writeSampleData(track, data, info);
            wroteSample = true;
        }

        @Override
        public void finish() throws IOException {
            if (!started || !wroteSample) {
                abort();
                throw new IOException("The encoder produced no audio.");
            }
            try {
                muxer.stop();
            } finally {
                muxer.release();
            }
        }

        @Override
        public void abort() {
            try {
                if (started) {
                    muxer.stop();
                }
            } catch (Throwable ignored) {
            }
            try {
                muxer.release();
            } catch (Throwable ignored) {
            }
            //noinspection ResultOfMethodCallIgnored
            out.delete();
        }
    }

    private static final class AdtsSink implements EncodedSink {
        private final File out;
        private final OutputStream os;
        private final int freqIndex;
        private final int channels;
        private final byte[] header = new byte[7];
        private byte[] scratch = new byte[4096];
        private boolean wrote = false;

        AdtsSink(File out, int rate, int channels) throws IOException {
            this.out = out;
            this.os = new BufferedOutputStream(new FileOutputStream(out, false), 1 << 16);
            int idx = indexOf(ADTS_RATES, rate);
            this.freqIndex = idx >= 0 ? idx : 4;
            this.channels = channels;
        }

        @Override
        public void onFormat(MediaFormat format) {
        }

        @Override
        public void onSample(ByteBuffer data, MediaCodec.BufferInfo info) throws IOException {
            int len = info.size;
            int frameLen = len + 7;
            header[0] = (byte) 0xFF;
            header[1] = (byte) 0xF1;
            // Profile field is (audio object type - 1): AAC-LC = 1.
            header[2] = (byte) ((1 << 6) | (freqIndex << 2) | (channels >> 2));
            header[3] = (byte) (((channels & 3) << 6) | (frameLen >> 11));
            header[4] = (byte) ((frameLen & 0x7FF) >> 3);
            header[5] = (byte) (((frameLen & 7) << 5) | 0x1F);
            header[6] = (byte) 0xFC;
            if (scratch.length < len) {
                scratch = new byte[len];
            }
            data.get(scratch, 0, len);
            os.write(header);
            os.write(scratch, 0, len);
            wrote = true;
        }

        @Override
        public void finish() throws IOException {
            os.close();
            if (!wrote) {
                //noinspection ResultOfMethodCallIgnored
                out.delete();
                throw new IOException("The encoder produced no audio.");
            }
        }

        @Override
        public void abort() {
            try {
                os.close();
            } catch (Throwable ignored) {
            }
            //noinspection ResultOfMethodCallIgnored
            out.delete();
        }
    }

    /** Raw AMR storage format for API < 26, where MediaMuxer cannot write 3GPP. */
    private static final class RawAmrSink implements EncodedSink {
        private final File out;
        private final OutputStream os;
        private byte[] scratch = new byte[512];
        private boolean wrote = false;

        RawAmrSink(File out, boolean wb) throws IOException {
            this.out = out;
            this.os = new BufferedOutputStream(new FileOutputStream(out, false), 1 << 14);
            byte[] magic = (wb ? "#!AMR-WB\n" : "#!AMR\n").getBytes("US-ASCII");
            os.write(magic);
        }

        @Override
        public void onFormat(MediaFormat format) {
        }

        @Override
        public void onSample(ByteBuffer data, MediaCodec.BufferInfo info) throws IOException {
            int len = info.size;
            if (scratch.length < len) {
                scratch = new byte[len];
            }
            data.get(scratch, 0, len);
            os.write(scratch, 0, len);
            wrote = true;
        }

        @Override
        public void finish() throws IOException {
            os.close();
            if (!wrote) {
                //noinspection ResultOfMethodCallIgnored
                out.delete();
                throw new IOException("The encoder produced no audio.");
            }
        }

        @Override
        public void abort() {
            try {
                os.close();
            } catch (Throwable ignored) {
            }
            //noinspection ResultOfMethodCallIgnored
            out.delete();
        }
    }

    /**
     * Sequential reader over the working file that hands out interleaved PCM16
     * at the encoder's rate and channel layout.
     */
    static final class PcmSource {
        private final InputStream in;
        private final int srcCh;
        private final boolean srcFloat;
        private final int dstCh;
        private final int srcFrameBytes;
        private final long totalFrames;
        private long framesRead = 0L;
        private final byte[] raw;
        private final ByteBuffer rawBuf;
        private final float[] mixed;
        private final PushResampler resampler;
        private float[] pending;
        private int pendingFrames = 0;
        private int pendingPos = 0;
        private boolean eof = false;

        PcmSource(File wav, int srcRate, int srcCh, boolean srcFloat, long dataBytes,
                  int dstRate, int dstCh) throws IOException {
            this.srcCh = Math.max(1, srcCh);
            this.srcFloat = srcFloat;
            this.dstCh = Math.max(1, dstCh);
            this.srcFrameBytes = (srcFloat ? 4 : 2) * this.srcCh;
            this.totalFrames = Math.max(0L, dataBytes / srcFrameBytes);
            this.in = new BufferedInputStream(new FileInputStream(wav), 1 << 16);
            skipFully(in, HEADER_BYTES);
            final int block = 4096;
            this.raw = new byte[block * srcFrameBytes];
            this.rawBuf = ByteBuffer.wrap(raw).order(ByteOrder.LITTLE_ENDIAN);
            this.mixed = new float[block * this.dstCh];
            this.resampler = srcRate != dstRate
                    ? new PushResampler(this.dstCh, (double) srcRate / (double) dstRate)
                    : null;
            int pendingCap = resampler != null
                    ? resampler.maxOutputFrames(block) : block;
            this.pending = new float[pendingCap * this.dstCh];
        }

        float progress() {
            return totalFrames <= 0L ? 1f : Math.min(1f, (float) framesRead / (float) totalFrames);
        }

        /** Fills {@code dst} with up to {@code maxFrames} frames; returns 0 at the end. */
        int read(short[] dst, int maxFrames) throws IOException {
            int produced = 0;
            while (produced < maxFrames) {
                if (pendingPos >= pendingFrames) {
                    if (!refill()) {
                        break;
                    }
                    continue;
                }
                int take = Math.min(maxFrames - produced, pendingFrames - pendingPos);
                int srcIdx = pendingPos * dstCh;
                int dstIdx = produced * dstCh;
                int count = take * dstCh;
                for (int i = 0; i < count; i++) {
                    dst[dstIdx + i] = toPcm16(pending[srcIdx + i]);
                }
                pendingPos += take;
                produced += take;
            }
            return produced;
        }

        private boolean refill() throws IOException {
            if (eof) {
                return false;
            }
            long left = totalFrames - framesRead;
            if (left <= 0L) {
                eof = true;
                return false;
            }
            int want = (int) Math.min(raw.length / srcFrameBytes, left);
            int n = readFully(in, raw, want * srcFrameBytes);
            int frames = n / srcFrameBytes;
            if (frames <= 0) {
                eof = true;
                return false;
            }
            framesRead += frames;
            for (int fr = 0; fr < frames; fr++) {
                int base = fr * srcFrameBytes;
                float l;
                float r;
                if (srcFloat) {
                    l = rawBuf.getFloat(base);
                    r = srcCh > 1 ? rawBuf.getFloat(base + 4) : l;
                } else {
                    l = rawBuf.getShort(base) / 32768f;
                    r = srcCh > 1 ? rawBuf.getShort(base + 2) / 32768f : l;
                }
                if (dstCh == 1) {
                    mixed[fr] = srcCh > 1 ? (l + r) * 0.5f : l;
                } else {
                    mixed[fr * 2] = l;
                    mixed[fr * 2 + 1] = r;
                }
            }
            if (resampler != null) {
                pendingFrames = resampler.process(mixed, frames, pending);
            } else {
                System.arraycopy(mixed, 0, pending, 0, frames * dstCh);
                pendingFrames = frames;
            }
            pendingPos = 0;
            return true;
        }

        void close() {
            try {
                in.close();
            } catch (IOException ignored) {
            }
        }
    }

    // -----------------------------------------------------------------------
    // Resampling
    // -----------------------------------------------------------------------

    /**
     * Streaming linear-interpolation resampler. When it decimates, a moving
     * average over roughly one output period is applied first as a cheap
     * anti-alias filter.
     */
    static final class PushResampler {
        private final int ch;
        private final double step;
        private double t = 0.0;
        private final float[] last;
        private boolean hasLast = false;
        private final int taps;
        private final float[] hist;
        private final float[] sums;
        private int histPos = 0;
        private int histFill = 0;

        PushResampler(int channels, double srcPerDst) {
            this.ch = Math.max(1, channels);
            this.step = srcPerDst;
            this.last = new float[this.ch];
            this.taps = srcPerDst > 1.5 ? (int) Math.round(srcPerDst) : 1;
            this.hist = new float[taps * this.ch];
            this.sums = new float[this.ch];
        }

        int maxOutputFrames(int inFrames) {
            return (int) Math.ceil((inFrames + 1) / step) + 2;
        }

        /** Resamples {@code inFrames} interleaved frames of {@code in} into {@code out}. */
        int process(float[] in, int inFrames, float[] out) {
            if (inFrames <= 0) {
                return 0;
            }
            if (taps > 1) {
                for (int f = 0; f < inFrames; f++) {
                    int slot = histPos * ch;
                    for (int c = 0; c < ch; c++) {
                        float v = in[f * ch + c];
                        sums[c] += v - hist[slot + c];
                        hist[slot + c] = v;
                        in[f * ch + c] = sums[c] / (histFill < taps ? histFill + 1 : taps);
                    }
                    histPos = (histPos + 1) % taps;
                    if (histFill < taps) {
                        histFill++;
                    }
                }
            }
            int start = 0;
            if (!hasLast) {
                System.arraycopy(in, 0, last, 0, ch);
                hasLast = true;
                start = 1;
            }
            int avail = inFrames - start;
            int o = 0;
            int cap = out.length / ch;
            while (t < avail && o < cap) {
                int i0 = (int) t;
                float frac = (float) (t - i0);
                for (int c = 0; c < ch; c++) {
                    float a = i0 == 0 ? last[c] : in[(start + i0 - 1) * ch + c];
                    float b = in[(start + i0) * ch + c];
                    out[o * ch + c] = a + (b - a) * frac;
                }
                o++;
                t += step;
            }
            if (avail > 0) {
                t -= avail;
                if (t < 0.0) {
                    t = 0.0;
                }
                System.arraycopy(in, (inFrames - 1) * ch, last, 0, ch);
            }
            return o;
        }
    }

    // -----------------------------------------------------------------------
    // Small helpers
    // -----------------------------------------------------------------------

    static short toPcm16(float v) {
        float s = v * 32768f;
        if (s >= 32767f) {
            return 32767;
        }
        if (s <= -32768f) {
            return -32768;
        }
        return (short) Math.round(s);
    }

    private static double readSample(byte[] b, int at, int formatTag, int bits) {
        if (formatTag == 3) {
            if (bits == 64) {
                long l = 0L;
                for (int i = 7; i >= 0; i--) {
                    l = (l << 8) | (b[at + i] & 0xFFL);
                }
                return Double.longBitsToDouble(l);
            }
            int i = (b[at] & 0xFF) | ((b[at + 1] & 0xFF) << 8) | ((b[at + 2] & 0xFF) << 16)
                    | ((b[at + 3] & 0xFF) << 24);
            return Float.intBitsToFloat(i);
        }
        switch (bits) {
            case 8:
                return ((b[at] & 0xFF) - 128) / 128.0;
            case 16:
                return (short) ((b[at] & 0xFF) | (b[at + 1] << 8)) / 32768.0;
            case 24: {
                int v = (b[at] & 0xFF) | ((b[at + 1] & 0xFF) << 8) | (b[at + 2] << 16);
                return v / 8388608.0;
            }
            case 32: {
                int v = (b[at] & 0xFF) | ((b[at + 1] & 0xFF) << 8) | ((b[at + 2] & 0xFF) << 16)
                        | (b[at + 3] << 24);
                return v / 2147483648.0;
            }
            default:
                return 0.0;
        }
    }

    static boolean fourcc(byte[] b, int at, String id) {
        return b[at] == id.charAt(0) && b[at + 1] == id.charAt(1)
                && b[at + 2] == id.charAt(2) && b[at + 3] == id.charAt(3);
    }

    static int le16(byte[] b, int at) {
        return (b[at] & 0xFF) | ((b[at + 1] & 0xFF) << 8);
    }

    static long le32(byte[] b, int at) {
        return (b[at] & 0xFFL) | ((b[at + 1] & 0xFFL) << 8) | ((b[at + 2] & 0xFFL) << 16)
                | ((b[at + 3] & 0xFFL) << 24);
    }

    static void putLe32(byte[] b, int at, long v) {
        b[at] = (byte) (v & 0xFF);
        b[at + 1] = (byte) ((v >> 8) & 0xFF);
        b[at + 2] = (byte) ((v >> 16) & 0xFF);
        b[at + 3] = (byte) ((v >> 24) & 0xFF);
    }

    static int readFully(InputStream in, byte[] buf, int len) throws IOException {
        int total = 0;
        while (total < len) {
            int n = in.read(buf, total, len - total);
            if (n < 0) {
                break;
            }
            total += n;
        }
        return total;
    }

    static void skipFully(InputStream in, long bytes) throws IOException {
        long left = bytes;
        byte[] scratch = null;
        while (left > 0L) {
            long skipped = in.skip(left);
            if (skipped > 0L) {
                left -= skipped;
                continue;
            }
            if (scratch == null) {
                scratch = new byte[8192];
            }
            int n = in.read(scratch, 0, (int) Math.min(scratch.length, left));
            if (n < 0) {
                throw new IOException("Unexpected end of file");
            }
            left -= n;
        }
    }

    private static int indexOf(int[] values, int v) {
        for (int i = 0; i < values.length; i++) {
            if (values[i] == v) {
                return i;
            }
        }
        return -1;
    }
}
