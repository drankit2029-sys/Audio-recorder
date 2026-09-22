package expo.modules.audiohardwarerouter;

import android.content.Context;
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
    private boolean isListenerRegistered = false;

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
        registerCallback();
    }

    @Override
    public void invalidate() {
        unregisterCallback();
        super.invalidate();
    }

    private void registerCallback() {
        if (!isListenerRegistered && audioManager != null) {
            deviceCallback = new AudioDeviceCallback() {
                @Override
                public void onAudioDevicesAdded(AudioDeviceInfo[] addedDevices) {
                    dispatchDevicesUpdate();
                }

                @Override
                public void onAudioDevicesRemoved(AudioDeviceInfo[] removedDevices) {
                    dispatchDevicesUpdate();
                }
            };
            audioManager.registerAudioDeviceCallback(deviceCallback, mainHandler);
            isListenerRegistered = true;
        }
    }

    private void unregisterCallback() {
        if (isListenerRegistered && audioManager != null && deviceCallback != null) {
            audioManager.unregisterAudioDeviceCallback(deviceCallback);
            isListenerRegistered = false;
        }
    }

    private void dispatchDevicesUpdate() {
        if (reactContext.hasActiveReactInstance()) {
            WritableMap params = Arguments.createMap();
            params.putBoolean("hasUpdate", true);
            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                .emit("onAudioDevicesUpdated", params);
        }
    }

    private boolean isBluetoothDevice(int type) {
        return type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
            || type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP
            || type == 26 // TYPE_BLE_HEADSET
            || type == 27 // TYPE_BLE_SPEAKER
            || type == 23; // TYPE_HEARING_AID
    }

    private WritableMap createDefaultBuiltinMic() {
        WritableMap map = Arguments.createMap();
        map.putInt("id", 1);
        map.putString("name", "Built-in Microphone");
        map.putString("type", "builtin_mic");
        map.putInt("typeCode", AudioDeviceInfo.TYPE_BUILTIN_MIC);

        WritableArray rates = Arguments.createArray();
        rates.pushInt(44100);
        rates.pushInt(48000);
        map.putArray("sampleRates", rates);

        WritableArray channels = Arguments.createArray();
        channels.pushInt(1);
        channels.pushInt(2);
        map.putArray("channelCounts", channels);
        return map;
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
                typeString = "usb_device";
                break;
            case AudioDeviceInfo.TYPE_USB_HEADSET:
                typeString = "usb_headset";
                break;
            case AudioDeviceInfo.TYPE_USB_ACCESSORY:
                typeString = "usb_accessory";
                break;
            case AudioDeviceInfo.TYPE_BLUETOOTH_SCO:
            case 26: // TYPE_BLE_HEADSET
                typeString = "bluetooth_sco";
                break;
            case AudioDeviceInfo.TYPE_BLUETOOTH_A2DP:
                typeString = "bluetooth_a2dp";
                break;
            default:
                typeString = isBluetoothDevice(typeCode) ? "bluetooth_sco" : "external_input";
                break;
        }

        String displayName = "";
        try {
            CharSequence productName = info.getProductName();
            if (productName != null) {
                displayName = productName.toString().trim();
            }
        } catch (SecurityException se) {
            displayName = "Bluetooth Headset";
        }

        if (displayName.isEmpty()) {
            if (typeCode == AudioDeviceInfo.TYPE_BUILTIN_MIC) {
                displayName = "Built-in Microphone";
            } else if (typeCode == AudioDeviceInfo.TYPE_WIRED_HEADSET) {
                displayName = "Wired Headset Mic";
            } else if (typeCode == AudioDeviceInfo.TYPE_USB_DEVICE || typeCode == AudioDeviceInfo.TYPE_USB_HEADSET) {
                displayName = "USB Audio Interface";
            } else if (typeString.equals("bluetooth_sco") || typeString.equals("bluetooth_a2dp")) {
                displayName = "Bluetooth Earpods";
            } else {
                displayName = "Input #" + info.getId();
            }
        }

        map.putInt("id", info.getId());
        map.putString("name", displayName);
        map.putString("type", typeString);
        map.putInt("typeCode", typeCode);

        WritableArray rates = Arguments.createArray();
        int[] sampleRates = info.getSampleRates();
        if (sampleRates != null) {
            for (int r : sampleRates) {
                rates.pushInt(r);
            }
        }
        map.putArray("sampleRates", rates);

        WritableArray channels = Arguments.createArray();
        int[] channelCounts = info.getChannelCounts();
        if (channelCounts != null) {
            for (int c : channelCounts) {
                channels.pushInt(c);
            }
        }
        map.putArray("channelCounts", channels);

        return map;
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    public WritableArray getAvailableInputs() {
        WritableArray array = Arguments.createArray();
        if (audioManager == null) {
            array.pushMap(createDefaultBuiltinMic());
            return array;
        }

        List<AudioDeviceInfo> candidates = new ArrayList<>();
        Set<Integer> seenIds = new HashSet<>();

        // 1. Always query standard inputs first (does not require Bluetooth permissions)
        try {
            AudioDeviceInfo[] inputs = audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS);
            if (inputs != null) {
                for (AudioDeviceInfo d : inputs) {
                    if (d != null && d.isSource() && seenIds.add(d.getId())) {
                        candidates.add(d);
                    }
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed reading standard inputs", e);
        }

        // 2. Query communication devices on Android 12+ (discovers Bluetooth earpods & headsets)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            try {
                List<AudioDeviceInfo> commDevices = audioManager.getAvailableCommunicationDevices();
                if (commDevices != null) {
                    for (AudioDeviceInfo d : commDevices) {
                        if (d != null && (d.isSource() || isBluetoothDevice(d.getType())) && seenIds.add(d.getId())) {
                            candidates.add(d);
                        }
                    }
                }
            } catch (SecurityException se) {
                Log.w(TAG, "BLUETOOTH_CONNECT permission not yet granted by user", se);
            } catch (Exception e) {
                Log.w(TAG, "Failed reading communication devices", e);
            }
        }

        for (AudioDeviceInfo d : candidates) {
            try {
                array.pushMap(mapDeviceInfo(d));
            } catch (Exception e) {
                Log.w(TAG, "Failed mapping device", e);
            }
        }

        // Safety fallback: Ensure at least the internal mic is present
        if (array.size() == 0) {
            array.pushMap(createDefaultBuiltinMic());
        }

        return array;
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    public boolean setPreferredInputDevice(int deviceId) {
        if (audioManager == null) return false;

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                List<AudioDeviceInfo> commDevices = audioManager.getAvailableCommunicationDevices();
                for (AudioDeviceInfo d : commDevices) {
                    if (d.getId() == deviceId) {
                        // Switch mode to communication to enable bidirectional Bluetooth SCO audio
                        audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);
                        return audioManager.setCommunicationDevice(d);
                    }
                }
            }

            // Fallback for Bluetooth SCO on devices below Android 12
            AudioDeviceInfo[] devices = audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS);
            for (AudioDeviceInfo d : devices) {
                if (d.getId() == deviceId) {
                    if (isBluetoothDevice(d.getType())) {
                        audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);
                        audioManager.startBluetoothSco();
                        audioManager.setBluetoothScoOn(true);
                    } else {
                        audioManager.stopBluetoothSco();
                        audioManager.setBluetoothScoOn(false);
                        audioManager.setMode(AudioManager.MODE_NORMAL);
                    }
                    return true;
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to set input device", e);
        }
        return false;
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    public boolean clearPreferredInputDevice() {
        if (audioManager == null) return false;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                audioManager.clearCommunicationDevice();
            }
            audioManager.stopBluetoothSco();
            audioManager.setBluetoothScoOn(false);
            audioManager.setMode(AudioManager.MODE_NORMAL);
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Failed to clear preferred device", e);
        }
        return false;
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    public WritableMap getActiveInputDevice() {
        if (audioManager == null) return null;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                AudioDeviceInfo active = audioManager.getCommunicationDevice();
                if (active != null) {
                    return mapDeviceInfo(active);
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to get active device", e);
        }
        return null;
    }

    @ReactMethod
    public void addListener(String eventName) {}

    @ReactMethod
    public void removeListeners(double count) {}
}