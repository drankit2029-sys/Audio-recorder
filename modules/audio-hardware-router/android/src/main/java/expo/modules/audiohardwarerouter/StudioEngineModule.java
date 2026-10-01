package expo.modules.audiohardwarerouter;

import android.util.Base64;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.bridge.WritableArray;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

import java.util.Map;

/**
 * JS bridge for {@link StudioEngine}. The engine is a process singleton; this
 * module only forwards calls and acts as its event sink, so reloading JS (or
 * losing the activity) never interrupts a take.
 */
public class StudioEngineModule extends ReactContextBaseJavaModule implements StudioEngine.Sink {

    private final StudioEngine engine;

    public StudioEngineModule(ReactApplicationContext reactContext) {
        super(reactContext);
        this.engine = StudioEngine.get(reactContext);
        this.engine.attachSink(this);
    }

    @Override
    public String getName() {
        return "StudioEngine";
    }

    @Override
    public void invalidate() {
        engine.detachSink(this);
        super.invalidate();
    }

    // -----------------------------------------------------------------------
    // Session
    // -----------------------------------------------------------------------

    @ReactMethod
    public void createSession(ReadableMap options, Promise promise) {
        try {
            int rate = getInt(options, "sampleRate", 48000);
            int ch = getInt(options, "channels", 1);
            boolean flt = getInt(options, "bitDepth", 16) == 32;
            String badge = getString(options, "badge", "");
            promise.resolve(toWritable(engine.createSession(rate, ch, flt, badge)));
        } catch (Throwable t) {
            promise.reject("E_STUDIO_CREATE", message(t), t);
        }
    }

    @ReactMethod
    public void openSession(final ReadableMap options, final Promise promise) {
        final String source = getString(options, "sourcePath", "");
        final boolean recover = "recover".equals(getString(options, "mode", "edit"));
        final String badge = getString(options, "badge", "");
        engine.runIo(new Runnable() {
            @Override
            public void run() {
                try {
                    Map<String, Object> info = engine.openSession(source, recover, badge,
                            new StudioCodec.Progress() {
                                @Override
                                public void onProgress(float fraction) {
                                    engine.emitProgress("open", fraction);
                                }
                            });
                    promise.resolve(toWritable(info));
                } catch (Throwable t) {
                    promise.reject("E_STUDIO_OPEN", message(t), t);
                }
            }
        });
    }

    @ReactMethod
    public void finalizeSession(final ReadableMap options, final Promise promise) {
        final String target = getString(options, "targetPath", "");
        final String format = getString(options, "format", "wav");
        final int bitRate = getInt(options, "bitRate", 0);
        final int rate = getInt(options, "sampleRate", 0);
        final int ch = getInt(options, "channels", 0);
        if (target.isEmpty()) {
            promise.reject("E_STUDIO_FINALIZE", "targetPath is required");
            return;
        }
        engine.runIo(new Runnable() {
            @Override
            public void run() {
                try {
                    Map<String, Object> result = engine.finalizeSession(target, format, bitRate, rate, ch,
                            new StudioCodec.Progress() {
                                @Override
                                public void onProgress(float fraction) {
                                    engine.emitProgress("save", fraction);
                                }
                            });
                    promise.resolve(toWritable(result));
                } catch (Throwable t) {
                    promise.reject("E_STUDIO_FINALIZE", message(t), t);
                }
            }
        });
    }

    @ReactMethod
    public void discardSession(Promise promise) {
        try {
            engine.discardSession();
            promise.resolve(null);
        } catch (Throwable t) {
            promise.reject("E_STUDIO_DISCARD", message(t), t);
        }
    }

    @ReactMethod
    public void setBadge(String badge) {
        engine.setBadge(badge);
    }

    @ReactMethod
    public void stopForegroundService(Promise promise) {
        try {
            engine.stopForegroundService();
            promise.resolve(true);
        } catch (Throwable t) {
            promise.reject("E_STUDIO_STOP_FG", message(t), t);
        }
    }

    // -----------------------------------------------------------------------
    // Transport
    // -----------------------------------------------------------------------

    @ReactMethod
    public void record(ReadableMap options, Promise promise) {
        try {
            double position = getDouble(options, "positionMs", -1);
            int device = getInt(options, "inputDeviceId", -1);
            promise.resolve(toWritable(engine.record(position, device)));
        } catch (Throwable t) {
            promise.reject("E_STUDIO_RECORD", message(t), t);
        }
    }

    @ReactMethod
    public void play(ReadableMap options, Promise promise) {
        try {
            engine.play(getDouble(options, "positionMs", 0));
            promise.resolve(null);
        } catch (Throwable t) {
            promise.reject("E_STUDIO_PLAY", message(t), t);
        }
    }

    @ReactMethod
    public void pause(Promise promise) {
        try {
            promise.resolve(toWritable(engine.pause("user")));
        } catch (Throwable t) {
            promise.reject("E_STUDIO_PAUSE", message(t), t);
        }
    }

    @ReactMethod
    public void seek(ReadableMap options, Promise promise) {
        try {
            engine.seek(getDouble(options, "positionMs", 0));
            promise.resolve(null);
        } catch (Throwable t) {
            promise.reject("E_STUDIO_SEEK", message(t), t);
        }
    }

    @ReactMethod
    public void prepareRecorder(int deviceId, Promise promise) {
        try {
            engine.prepareRecorder(deviceId);
            promise.resolve(true);
        } catch (Throwable t) {
            promise.reject("E_STUDIO_PREPARE", message(t), t);
        }
    }

    @ReactMethod
    public void dropWarmRecorder(Promise promise) {
        try {
            engine.dropWarmRecorder();
            promise.resolve(true);
        } catch (Throwable t) {
            promise.reject("E_STUDIO_PREPARE", message(t), t);
        }
    }

    @ReactMethod
    public void preparePlayer(Promise promise) {
        try {
            engine.preparePlayer();
            promise.resolve(true);
        } catch (Throwable t) {
            promise.reject("E_STUDIO_PREPARE_PLAY", message(t), t);
        }
    }

    @ReactMethod
    public void dropWarmPlayer(Promise promise) {
        try {
            engine.dropWarmPlayer();
            promise.resolve(true);
        } catch (Throwable t) {
            promise.reject("E_STUDIO_DROP_PLAY", message(t), t);
        }
    }

    @ReactMethod
    public void reinitializeCapture(ReadableMap options, Promise promise) {
        try {
            int device = getInt(options, "inputDeviceId", -1);
            boolean append = getBoolean(options, "appendAtEnd", true);
            promise.resolve(toWritable(engine.reinitializeCapture(device, append)));
        } catch (Throwable t) {
            promise.reject("E_STUDIO_REINIT", message(t), t);
        }
    }

    // -----------------------------------------------------------------------
    // Queries
    // -----------------------------------------------------------------------

    /** Free bytes on the volume takes are written to (Long.MAX_VALUE = unknown). */
    @ReactMethod
    public void getFreeBytes(Promise promise) {
        try {
            promise.resolve((double) engine.freeBytes());
        } catch (Throwable t) {
            promise.reject("E_STUDIO_STORAGE", message(t), t);
        }
    }

    @ReactMethod
    public void getStatus(Promise promise) {
        try {
            promise.resolve(toWritable(engine.getStatus()));
        } catch (Throwable t) {
            promise.reject("E_STUDIO_STATUS", message(t), t);
        }
    }

    /** Peak table slice as base64 (one byte per 20 ms bucket). */
    @ReactMethod
    public void getPeaks(ReadableMap options, Promise promise) {
        try {
            int start = getInt(options, "start", 0);
            int count = getInt(options, "count", -1);
            byte[] bytes = engine.getPeaks(start, count);
            promise.resolve(Base64.encodeToString(bytes, Base64.NO_WRAP));
        } catch (Throwable t) {
            promise.reject("E_STUDIO_PEAKS", message(t), t);
        }
    }

    @ReactMethod
    public void addListener(String eventName) {
    }

    @ReactMethod
    public void removeListeners(double count) {
    }

    // -----------------------------------------------------------------------
    // Sink
    // -----------------------------------------------------------------------

    @Override
    public void emit(String event, Map<String, Object> payload) {
        ReactApplicationContext ctx = getReactApplicationContext();
        if (ctx == null || !ctx.hasActiveReactInstance()) {
            return;
        }
        try {
            ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                    .emit(event, toWritable(payload));
        } catch (Throwable ignored) {
            // The JS context is being torn down.
        }
    }

    // -----------------------------------------------------------------------
    // Conversion helpers
    // -----------------------------------------------------------------------

    @SuppressWarnings("unchecked")
    private static WritableMap toWritable(Map<String, Object> map) {
        WritableMap out = Arguments.createMap();
        if (map == null) {
            return out;
        }
        for (Map.Entry<String, Object> e : map.entrySet()) {
            String k = e.getKey();
            Object v = e.getValue();
            if (v == null) {
                out.putNull(k);
            } else if (v instanceof Boolean) {
                out.putBoolean(k, (Boolean) v);
            } else if (v instanceof Integer) {
                out.putInt(k, (Integer) v);
            } else if (v instanceof Long) {
                out.putDouble(k, ((Long) v).doubleValue());
            } else if (v instanceof Number) {
                out.putDouble(k, ((Number) v).doubleValue());
            } else if (v instanceof String) {
                out.putString(k, (String) v);
            } else if (v instanceof int[]) {
                WritableArray arr = Arguments.createArray();
                for (int x : (int[]) v) {
                    arr.pushInt(x);
                }
                out.putArray(k, arr);
            } else if (v instanceof Map) {
                out.putMap(k, toWritable((Map<String, Object>) v));
            } else {
                out.putString(k, String.valueOf(v));
            }
        }
        return out;
    }

    private static boolean getBoolean(ReadableMap m, String key, boolean fallback) {
        try {
            return m != null && m.hasKey(key) && !m.isNull(key) ? m.getBoolean(key) : fallback;
        } catch (Throwable t) {
            return fallback;
        }
    }

    private static String message(Throwable t) {
        String m = t.getMessage();
        return m != null && !m.isEmpty() ? m : t.getClass().getSimpleName();
    }

    private static int getInt(ReadableMap m, String key, int fallback) {
        try {
            return m != null && m.hasKey(key) && !m.isNull(key) ? (int) Math.round(m.getDouble(key)) : fallback;
        } catch (Throwable t) {
            return fallback;
        }
    }

    private static double getDouble(ReadableMap m, String key, double fallback) {
        try {
            return m != null && m.hasKey(key) && !m.isNull(key) ? m.getDouble(key) : fallback;
        } catch (Throwable t) {
            return fallback;
        }
    }

    private static String getString(ReadableMap m, String key, String fallback) {
        try {
            if (m != null && m.hasKey(key) && !m.isNull(key)) {
                String s = m.getString(key);
                return s != null ? s : fallback;
            }
        } catch (Throwable ignored) {
        }
        return fallback;
    }
}
