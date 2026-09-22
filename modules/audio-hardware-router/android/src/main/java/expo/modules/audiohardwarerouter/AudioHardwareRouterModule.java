package expo.modules.audiohardwarerouter;

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

import androidx.annotation.NonNull;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableArray;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

public class AudioHardwareRouterModule extends ReactContextBaseJavaModule {
    private static final String TAG = "AudioHardwareRouter";
    private final ReactApplicationContext reactContext;
    private final AudioManager audioManager;
    private final Handler mainHandler;
    private AudioDeviceCallback deviceCallback;
    private BroadcastReceiver bluetoothReceiver;
    private boolean isListenerRegistered = false;

    // Sticky device tracking to prevent mid-handshake snap-backs
    private int currentSelectedDeviceId = -1;

    // Debounce runnable to collapse rapid Bluetooth handshake events
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
                    reactContext.registerReceiver(bluetoothReceiver, filter, Context.RECEIVER_EXPORTED);
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

    public void unregisterCallback() {
        unregisterListeners();
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
            || typeCode == 26 // TYPE_BLE_HEADSET
            || typeCode == 27 // TYPE_BLE_SPEAKER
            || typeCode == 23; // TYPE_HEARING_AID
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
        if (sampleRates != null && sampleRates.length > 0) {
            for (int r : sampleRates) { rates.pushInt(r); }
        } else {
            rates.pushInt(44100);
            rates.pushInt(48000);
        }
        map.putArray("sampleRates", rates);

        WritableArray channels = Arguments.createArray();
        int[] channelCounts = info.getChannelCounts();
        if (channelCounts != null && channelCounts.length > 0) {
            for (int c : channelCounts) { channels.pushInt(c); }
        } else {
            channels.pushInt(1);
        }
        map.putArray("channelCounts", channels);

        return map;
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    public WritableArray getAvailableInputs() {
        WritableArray array = Arguments.createArray();
        if (audioManager == null) return array;

        List<AudioDeviceInfo> candidates = new ArrayList<>();
        Set<Integer> seenIds = new HashSet<>();
        Set<String> seenBluetoothNames = new HashSet<>();

        // 1. Android 12+ Communication Endpoints (Primary targets that bind both capture AND playback)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            try {
                List<AudioDeviceInfo> comms = audioManager.getAvailableCommunicationDevices();
                if (comms != null) {
                    for (AudioDeviceInfo d : comms) {
                        if (d != null && isBluetoothDevice(d.getType()) && seenIds.add(d.getId())) {
                            candidates.add(d);
                            try {
                                CharSequence name = d.getProductName();
                                if (name != null) seenBluetoothNames.add(name.toString().trim());
                            } catch (Exception ignored) {}
                        }
                    }
                }
            } catch (Exception ignored) {}
        }

        // 2. Physical input microphones (Built-in mic capsules, USB mics)
        try {
            AudioDeviceInfo[] inputs = audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS);
            if (inputs != null) {
                for (AudioDeviceInfo d : inputs) {
                    if (d != null && d.isSource() && seenIds.add(d.getId())) {
                        candidates.add(d);
                    }
                }
            }
        } catch (Exception ignored) {}

        // 3. Fallback: Add Bluetooth devices connected as output sink if not already in communication devices
        try {
            AudioDeviceInfo[] outputs = audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS);
            if (outputs != null) {
                for (AudioDeviceInfo d : outputs) {
                    if (d != null && isBluetoothDevice(d.getType())) {
                        String name = "";
                        try {
                            CharSequence prod = d.getProductName();
                            if (prod != null) name = prod.toString().trim();
                        } catch (Exception ignored) {}

                        if (!name.isEmpty() && seenBluetoothNames.contains(name)) {
                            continue; // Skip duplicate output entry for known communication device
                        }

                        if (seenIds.add(d.getId())) {
                            candidates.add(d);
                        }
                    }
                }
            }
        } catch (Exception ignored) {}

        for (AudioDeviceInfo d : candidates) {
            try {
                array.pushMap(mapDeviceInfo(d));
            } catch (Exception ignored) {}
        }

        return array;
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    public boolean setPreferredInputDevice(int deviceId) {
        if (audioManager == null) return false;

        try {
            AudioDeviceInfo target = null;
            AudioDeviceInfo[] all = audioManager.getDevices(AudioManager.GET_DEVICES_ALL);
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
                currentSelectedDeviceId = deviceId;

                // Android 12+ (API 31+): Use setCommunicationDevice exclusively.
                // Do NOT call startBluetoothSco(), which breaks media playback.
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);
                    List<AudioDeviceInfo> comms = audioManager.getAvailableCommunicationDevices();
                    if (comms != null) {
                        for (AudioDeviceInfo comm : comms) {
                            if (comm != null && (comm.getId() == deviceId || isBluetoothDevice(comm.getType()))) {
                                boolean success = audioManager.setCommunicationDevice(comm);
                                if (success) {
                                    currentSelectedDeviceId = comm.getId();
                                    return true;
                                }
                            }
                        }
                    }
                } else {
                    // Android 11 and below legacy fallback
                    audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);
                    audioManager.startBluetoothSco();
                    audioManager.setBluetoothScoOn(true);
                    return true;
                }
            } else {
                // Switching back to Built-in or USB microphone
                currentSelectedDeviceId = deviceId;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    audioManager.clearCommunicationDevice();
                } else {
                    audioManager.stopBluetoothSco();
                    audioManager.setBluetoothScoOn(false);
                }
                audioManager.setMode(AudioManager.MODE_NORMAL);
                return true;
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to set input device: " + deviceId, e);
        }
        return false;
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    public boolean clearPreferredInputDevice() {
        if (audioManager == null) return false;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                audioManager.clearCommunicationDevice();
            } else {
                audioManager.stopBluetoothSco();
                audioManager.setBluetoothScoOn(false);
            }
            audioManager.setMode(AudioManager.MODE_NORMAL);
            currentSelectedDeviceId = -1;
            return true;
        } catch (Exception ignored) {}
        return false;
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    public WritableMap getActiveInputDevice() {
        if (audioManager == null) return null;
        try {
            // 1. Android 12+ active communication device
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                AudioDeviceInfo active = audioManager.getCommunicationDevice();
                if (active != null && isBluetoothDevice(active.getType())) {
                    return mapDeviceInfo(active);
                }
            }

            // 2. Return sticky selected device if it still physically exists
            if (currentSelectedDeviceId != -1) {
                AudioDeviceInfo[] all = audioManager.getDevices(AudioManager.GET_DEVICES_ALL);
                if (all != null) {
                    for (AudioDeviceInfo d : all) {
                        if (d != null && d.getId() == currentSelectedDeviceId) {
                            return mapDeviceInfo(d);
                        }
                    }
                }
            }

            // 3. Fallback to built-in mic
            AudioDeviceInfo[] inputs = audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS);
            if (inputs != null) {
                for (AudioDeviceInfo d : inputs) {
                    if (d != null && d.getType() == AudioDeviceInfo.TYPE_BUILTIN_MIC) {
                        return mapDeviceInfo(d);
                    }
                }
                if (inputs.length > 0 && inputs[0] != null) {
                    return mapDeviceInfo(inputs[0]);
                }
            }
        } catch (Exception ignored) {}
        return null;
    }

    @ReactMethod
    public void addListener(String eventName) {}

    @ReactMethod
    public void removeListeners(double count) {}
}