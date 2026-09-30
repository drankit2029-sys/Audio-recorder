package expo.modules.audiohardwarerouter;

import android.app.Activity;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothHeadset;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.InputMethodManager;
import android.widget.EditText;

import androidx.annotation.NonNull;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableArray;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

public class AudioHardwareRouterModule extends ReactContextBaseJavaModule {
    private static final String TAG = "AudioHardwareRouter";
    private final ReactApplicationContext reactContext;
    private final AudioManager audioManager;
    private final Handler mainHandler;
    private AudioDeviceCallback deviceCallback;
    private BroadcastReceiver bluetoothReceiver;
    private boolean isListenerRegistered = false;

    private final Runnable dispatchDebounceRunnable = this::doDispatchUpdate;

    public AudioHardwareRouterModule(ReactApplicationContext reactContext) {
        super(reactContext);
        this.reactContext = reactContext;
        this.audioManager = (AudioManager) reactContext.getSystemService(Context.AUDIO_SERVICE);
        this.mainHandler = new Handler(Looper.getMainLooper());
    }

    @NonNull
    @Override
    public String getName() {
        return "AudioHardwareRouter";
    }

    @Override
    public void initialize() {
        super.initialize();
        registerListeners();
    }

    @Override
    public void invalidate() {
        unregisterListeners();
        super.invalidate();
    }

    private synchronized void registerListeners() {
        if (!isListenerRegistered && audioManager != null) {
            deviceCallback = new AudioDeviceCallback() {
                @Override
                public void onAudioDevicesAdded(AudioDeviceInfo[] addedDevices) {
                    scheduleDebouncedUpdate();
                }

                @Override
                public void onAudioDevicesRemoved(AudioDeviceInfo[] removedDevices) {
                    scheduleDebouncedUpdate();
                }
            };
            audioManager.registerAudioDeviceCallback(deviceCallback, mainHandler);

            bluetoothReceiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context context, Intent intent) {
                    scheduleDebouncedUpdate();
                }
            };

            IntentFilter filter = new IntentFilter();
            filter.addAction(BluetoothDevice.ACTION_ACL_CONNECTED);
            filter.addAction(BluetoothDevice.ACTION_ACL_DISCONNECTED);
            filter.addAction(BluetoothHeadset.ACTION_CONNECTION_STATE_CHANGED);
            filter.addAction(AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED);
            filter.addAction(AudioManager.ACTION_HEADSET_PLUG);

            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    // RECEIVER_NOT_EXPORTED: this receiver is internal, so it must
                    // not be reachable by other apps. RECEIVER_EXPORTED only exists
                    // to support the legacy behaviour on older platforms.
                    reactContext.registerReceiver(bluetoothReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
                } else {
                    reactContext.registerReceiver(bluetoothReceiver, filter);
                }
            } catch (Exception e) {
                Log.w(TAG, "Failed to register broadcast receiver", e);
            }

            isListenerRegistered = true;
        }
    }

    private synchronized void unregisterListeners() {
        if (isListenerRegistered) {
            mainHandler.removeCallbacks(dispatchDebounceRunnable);
            if (audioManager != null && deviceCallback != null) {
                try {
                    audioManager.unregisterAudioDeviceCallback(deviceCallback);
                } catch (Exception ignored) {}
            }
            if (bluetoothReceiver != null) {
                try {
                    reactContext.unregisterReceiver(bluetoothReceiver);
                } catch (Exception ignored) {}
            }
            isListenerRegistered = false;
        }
    }

    private void scheduleDebouncedUpdate() {
        mainHandler.removeCallbacks(dispatchDebounceRunnable);
        mainHandler.postDelayed(dispatchDebounceRunnable, 350);
    }

    private void doDispatchUpdate() {
        if (reactContext.hasActiveReactInstance()) {
            WritableMap params = Arguments.createMap();
            params.putBoolean("hasUpdate", true);
            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                .emit("onAudioDevicesUpdated", params);
        }
    }

    private boolean isBluetoothDevice(int typeCode) {
        return typeCode == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
            || typeCode == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP
            || typeCode == 26 // AudioDeviceInfo.TYPE_BLE_HEADSET
            || typeCode == 27 // AudioDeviceInfo.TYPE_BLE_SPEAKER
            || typeCode == 23; // AudioDeviceInfo.TYPE_HEARING_AID
    }

    private WritableMap mapDeviceInfo(AudioDeviceInfo info) {
        WritableMap map = Arguments.createMap();
        int typeCode = info.getType();
        String typeString;

        switch (typeCode) {
            case AudioDeviceInfo.TYPE_BUILTIN_MIC:
                typeString = "builtin_mic";
                break;
            case AudioDeviceInfo.TYPE_WIRED_HEADSET:
                typeString = "wired_headset";
                break;
            case AudioDeviceInfo.TYPE_USB_DEVICE:
            case AudioDeviceInfo.TYPE_USB_HEADSET:
            case AudioDeviceInfo.TYPE_USB_ACCESSORY:
                typeString = "usb_device";
                break;
            case AudioDeviceInfo.TYPE_BLUETOOTH_SCO:
            case AudioDeviceInfo.TYPE_BLUETOOTH_A2DP:
            case 26:
            case 27:
            case 23:
                typeString = "bluetooth_sco";
                break;
            default:
                typeString = "external_input";
                break;
        }

        String displayName = "";
        try {
            CharSequence productName = info.getProductName();
            if (productName != null) {
                displayName = productName.toString().trim();
            }
        } catch (SecurityException ignored) {}

        if (displayName.isEmpty()) {
            if (typeCode == AudioDeviceInfo.TYPE_BUILTIN_MIC) {
                displayName = "Built-in Microphone";
            } else if (typeCode == AudioDeviceInfo.TYPE_WIRED_HEADSET) {
                displayName = "Wired Headset Mic";
            } else if (typeCode == AudioDeviceInfo.TYPE_USB_DEVICE || typeCode == AudioDeviceInfo.TYPE_USB_HEADSET) {
                displayName = "USB Audio Interface";
            } else if ("bluetooth_sco".equals(typeString)) {
                displayName = "Bluetooth Earpods";
            } else {
                displayName = "Audio Capsule #" + info.getId();
            }
        }

        map.putInt("id", info.getId());
        map.putString("name", displayName);
        map.putString("type", typeString);
        map.putInt("typeCode", typeCode);

        WritableArray rates = Arguments.createArray();
        int[] sampleRates = info.getSampleRates();
        // M12: most devices report an empty list, which does NOT mean "only these
        // rates work". The guesses below are only used for display, so the list is
        // flagged as unknown and the compatibility check probes for real instead.
        boolean sampleRatesKnown = sampleRates != null && sampleRates.length > 0;
        if (sampleRatesKnown) {
            for (int r : sampleRates) {
                rates.pushInt(r);
            }
        } else {
            rates.pushInt(44100);
            rates.pushInt(48000);
        }
        map.putArray("sampleRates", rates);
        map.putBoolean("sampleRatesKnown", sampleRatesKnown);

        WritableArray channels = Arguments.createArray();
        int[] channelCounts = info.getChannelCounts();
        boolean channelCountsKnown = channelCounts != null && channelCounts.length > 0;
        if (channelCountsKnown) {
            for (int c : channelCounts) {
                channels.pushInt(c);
            }
        } else {
            channels.pushInt(1);
            channels.pushInt(2);
        }
        map.putArray("channelCounts", channels);
        map.putBoolean("channelCountsKnown", channelCountsKnown);
        // True when the device can only play audio (e.g. an A2DP speaker).
        map.putBoolean("isSink", !info.isSource());

        return map;
    }

    /**
     * H3: synchronous @ReactMethod calls are unsupported under the New
     * Architecture, so every probe is Promise-based now.
     */
    @ReactMethod
    public void getAvailableInputs(Promise promise) {
        WritableArray array = Arguments.createArray();
        if (audioManager == null) {
            promise.resolve(array);
            return;
        }

        List<AudioDeviceInfo> rawList = new ArrayList<>();
        boolean foundBluetoothEndpoint = false;

        // 1. Android 12+ Communication Endpoints (Primary targets for voice recording and playback)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            try {
                List<AudioDeviceInfo> comms = audioManager.getAvailableCommunicationDevices();
                if (comms != null) {
                    for (AudioDeviceInfo d : comms) {
                        if (d != null && d.getType() != AudioDeviceInfo.TYPE_BUILTIN_SPEAKER && d.getType() != AudioDeviceInfo.TYPE_BUILTIN_EARPIECE) {
                            rawList.add(d);
                            if (isBluetoothDevice(d.getType())) {
                                foundBluetoothEndpoint = true;
                            }
                        }
                    }
                }
            } catch (Exception ignored) {}
        }

        // 2. Physical internal microphones
        try {
            AudioDeviceInfo[] inputs = audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS);
            if (inputs != null) {
                for (AudioDeviceInfo d : inputs) {
                    if (d != null && d.isSource()) {
                        rawList.add(d);
                        if (isBluetoothDevice(d.getType())) {
                            foundBluetoothEndpoint = true;
                        }
                    }
                }
            }
        } catch (Exception ignored) {}

        // 3. Output sinks fallback: only inspect if no communication/input profile was detected
        if (!foundBluetoothEndpoint) {
            try {
                AudioDeviceInfo[] outputs = audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS);
                if (outputs != null) {
                    for (AudioDeviceInfo d : outputs) {
                        if (d != null && isBluetoothDevice(d.getType())) {
                            rawList.add(d);
                        }
                    }
                }
            } catch (Exception ignored) {}
        }

        // 4. Deduplicate. M7: the old code de-duplicated by *display name*, which
        // hid a second USB interface or a second Bluetooth mic that happened to
        // report the same name (very common: "" or "Built-in Microphone").
        // Devices are now keyed by their unique id, and repeated names are only
        // disambiguated for the user's benefit.
        Set<Integer> seenIds = new HashSet<>();
        Map<String, Integer> nameUse = new HashMap<>();
        for (AudioDeviceInfo d : rawList) {
            try {
                if (!seenIds.add(d.getId())) {
                    continue;
                }
                WritableMap map = mapDeviceInfo(d);
                String name = map.getString("name");
                if (name != null) {
                    Integer used = nameUse.get(name);
                    if (used == null) {
                        nameUse.put(name, 1);
                    } else {
                        nameUse.put(name, used + 1);
                        map.putString("name", name + " (" + (used + 1) + ")");
                    }
                }
                array.pushMap(map);
            } catch (Exception ignored) {}
        }

        promise.resolve(array);
    }

    /**
     * H3: async. M7: the old Bluetooth branch matched *any* Bluetooth device, so
     * picking "Earpods" could silently route through a car kit that was also
     * connected. It now prefers the exact device, then the exact same type, and
     * gives up otherwise.
     */
    @ReactMethod
    public void setPreferredInputDevice(int deviceId, Promise promise) {
        if (audioManager == null) {
            promise.resolve(false);
            return;
        }

        try {
            AudioDeviceInfo target = null;
            AudioDeviceInfo[] all = audioManager.getDevices(
                    AudioManager.GET_DEVICES_INPUTS | AudioManager.GET_DEVICES_OUTPUTS);
            if (all != null) {
                for (AudioDeviceInfo d : all) {
                    if (d != null && d.getId() == deviceId) {
                        target = d;
                        break;
                    }
                }
            }

            boolean isBluetooth = (target != null && isBluetoothDevice(target.getType()));

            if (isBluetooth) {
                audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    List<AudioDeviceInfo> comms = audioManager.getAvailableCommunicationDevices();
                    if (comms != null && comms.size() > 0) {
                        // 1) the exact device the user picked
                        AudioDeviceInfo exact = null;
                        AudioDeviceInfo sameType = null;
                        AudioDeviceInfo anyBluetooth = null;
                        for (AudioDeviceInfo comm : comms) {
                            if (comm == null) {
                                continue;
                            }
                            if (comm.getId() == deviceId) {
                                exact = comm;
                                break;
                            }
                            if (sameType == null && comm.getType() == target.getType()) {
                                sameType = comm;
                            }
                            if (anyBluetooth == null && isBluetoothDevice(comm.getType())) {
                                anyBluetooth = comm;
                            }
                        }
                        AudioDeviceInfo chosen = exact != null ? exact
                                : (sameType != null ? sameType : anyBluetooth);
                        if (chosen != null) {
                            promise.resolve(audioManager.setCommunicationDevice(chosen));
                            return;
                        }
                        Log.w(TAG, "No Bluetooth communication device available for id " + deviceId);
                        promise.resolve(false);
                        return;
                    }
                } else {
                    // Pre-Android 12: startBluetoothSco() is asynchronous and the
                    // routing only takes effect once the SCO link is up, so this
                    // reports success optimistically and the UI warns about it.
                    audioManager.startBluetoothSco();
                    audioManager.setBluetoothScoOn(true);
                    promise.resolve(true);
                    return;
                }
            } else {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    audioManager.clearCommunicationDevice();
                }
                audioManager.stopBluetoothSco();
                audioManager.setBluetoothScoOn(false);
                audioManager.setMode(AudioManager.MODE_NORMAL);
                promise.resolve(true);
                return;
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to set input device: " + deviceId, e);
        }
        promise.resolve(false);
    }

    @ReactMethod
    public void clearPreferredInputDevice(Promise promise) {
        if (audioManager == null) {
            promise.resolve(false);
            return;
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                audioManager.clearCommunicationDevice();
            }
            audioManager.stopBluetoothSco();
            audioManager.setBluetoothScoOn(false);
            audioManager.setMode(AudioManager.MODE_NORMAL);
            promise.resolve(true);
        } catch (Exception ignored) {
            promise.resolve(false);
        }
    }

    /**
     * H4: this used to be `return null`, so the UI never knew what was actually
     * capturing. On Android 12+ the communication device is authoritative; below
     * that we can only report the SCO state and fall back to the built-in mic.
     */
    @ReactMethod
    public void getActiveInputDevice(Promise promise) {
        if (audioManager == null) {
            promise.resolve(null);
            return;
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                AudioDeviceInfo comm = audioManager.getCommunicationDevice();
                if (comm != null) {
                    WritableMap map = mapDeviceInfo(comm);
                    map.putBoolean("found", true);
                    promise.resolve(map);
                    return;
                }
            }
            WritableMap map = Arguments.createMap();
            map.putBoolean("found", false);
            map.putInt("id", -1);
            if (audioManager.isBluetoothScoOn()) {
                map.putString("name", "Bluetooth headset");
                map.putString("type", "bluetooth_sco");
                map.putInt("typeCode", AudioDeviceInfo.TYPE_BLUETOOTH_SCO);
            } else {
                map.putString("name", "Built-in Microphone");
                map.putString("type", "builtin_mic");
                map.putInt("typeCode", AudioDeviceInfo.TYPE_BUILTIN_MIC);
            }
            promise.resolve(map);
        } catch (Exception e) {
            Log.w(TAG, "getActiveInputDevice failed", e);
            promise.resolve(null);
        }
    }

    /** Deepest-first search for an EditText that currently has focus. */
    private View findFocusedEditText(View root) {
        if (root == null) return null;
        try {
            if (root instanceof EditText && root.isFocused()) return root;
        } catch (Throwable ignored) {
        }
        if (root instanceof ViewGroup) {
            ViewGroup vg = (ViewGroup) root;
            for (int i = 0; i < vg.getChildCount(); i++) {
                View found = findFocusedEditText(vg.getChildAt(i));
                if (found != null) return found;
            }
        }
        return null;
    }

    /** First EditText in the hierarchy (input fields inside RN overlays). */
    private View findFirstEditText(View root) {
        if (root == null) return null;
        if (root instanceof EditText) return root;
        if (root instanceof ViewGroup) {
            ViewGroup vg = (ViewGroup) root;
            for (int i = 0; i < vg.getChildCount(); i++) {
                View found = findFirstEditText(vg.getChildAt(i));
                if (found != null) return found;
            }
        }
        return null;
    }

    @ReactMethod
    public void showSoftKeyboard(final Promise promise) {
        try {
            final Activity activity = getCurrentActivity();
            if (activity == null) {
                promise.resolve(false);
                return;
            }
            activity.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        InputMethodManager imm =
                                (InputMethodManager) activity.getSystemService(Context.INPUT_METHOD_SERVICE);
                        if (imm == null) {
                            promise.resolve(false);
                            return;
                        }
                        // getCurrentFocus() is frequently null or a non-editing
                        // view under edge-to-edge Android 15+, so fall back to
                        // walking the hierarchy for the real input field and
                        // give it focus before asking the IME to show.
                        View focused = activity.getCurrentFocus();
                        View target = (focused instanceof EditText) ? focused : null;
                        if (target == null) {
                            target = findFocusedEditText(activity.getWindow().getDecorView());
                        }
                        if (target == null) {
                            target = findFirstEditText(activity.getWindow().getDecorView());
                        }
                        if (target == null) {
                            target = activity.getWindow().getDecorView();
                        }
                        if (target instanceof EditText) {
                            try {
                                target.requestFocus();
                            } catch (Throwable ignored) {
                            }
                        }
                        boolean result = false;
                        try {
                            result = imm.showSoftInput(target, InputMethodManager.SHOW_IMPLICIT);
                        } catch (Throwable ignored) {
                        }
                        if (!result) {
                            try {
                                result = imm.showSoftInput(target, 0);
                            } catch (Throwable ignored) {
                            }
                        }
                        if (!result) {
                            try {
                                imm.toggleSoftInput(InputMethodManager.SHOW_FORCED, 0);
                                result = true;
                            } catch (Throwable ignored) {
                            }
                        }
                        promise.resolve(result);
                    } catch (Throwable t) {
                        promise.resolve(false);
                    }
                }
            });
        } catch (Throwable t) {
            promise.resolve(false);
        }
    }

    @ReactMethod
    public void hideSoftKeyboard(final Promise promise) {
        try {
            final Activity activity = getCurrentActivity();
            if (activity == null) {
                promise.resolve(false);
                return;
            }
            activity.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        View view = activity.getCurrentFocus();
                        if (view == null) {
                            view = activity.getWindow().getDecorView();
                        }
                        InputMethodManager imm = (InputMethodManager) activity.getSystemService(Context.INPUT_METHOD_SERVICE);
                        if (imm == null) {
                            promise.resolve(false);
                            return;
                        }
                        boolean result = imm.hideSoftInputFromWindow(view.getWindowToken(), 0);
                        promise.resolve(result);
                    } catch (Throwable t) {
                        promise.resolve(false);
                    }
                }
            });
        } catch (Throwable t) {
            promise.resolve(false);
        }
    }

    @ReactMethod
    public void addListener(String eventName) {}

    @ReactMethod
    public void removeListeners(double count) {}
}