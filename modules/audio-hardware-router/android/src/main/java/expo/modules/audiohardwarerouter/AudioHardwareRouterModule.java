package expo.modules.audiohardwarerouter;

import android.content.Context;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;

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

        CharSequence productName = info.getProductName();
        String rawName = productName != null ? productName.toString().trim() : "";
        String displayName;

        if (!rawName.isEmpty()) {
            displayName = rawName;
        } else if (typeCode == AudioDeviceInfo.TYPE_BUILTIN_MIC) {
            displayName = "Built-in Microphone";
        } else if (typeCode == AudioDeviceInfo.TYPE_WIRED_HEADSET) {
            displayName = "Wired Headset";
        } else if (typeCode == AudioDeviceInfo.TYPE_USB_DEVICE || typeCode == AudioDeviceInfo.TYPE_USB_HEADSET) {
            displayName = "USB Audio Device";
        } else if (isBluetoothDevice(typeCode)) {
            displayName = "Bluetooth Earpods / Headset";
        } else {
            displayName = "Audio Device #" + info.getId();
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
        if (audioManager == null) return array;

        List<AudioDeviceInfo> candidates = new ArrayList<>();
        Set<Integer> seenIds = new HashSet<>();

        // 1. Android 12+ Communication Devices (discovers Bluetooth earpods & wired headsets)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            List<AudioDeviceInfo> commDevices = audioManager.getAvailableCommunicationDevices();
            for (AudioDeviceInfo d : commDevices) {
                if (d.getType() != AudioDeviceInfo.TYPE_BUILTIN_SPEAKER && seenIds.add(d.getId())) {
                    candidates.add(d);
                }
            }
        }

        // 2. Query standard inputs to catch any remaining hardware capsules
        AudioDeviceInfo[] inputDevices = audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS);
        for (AudioDeviceInfo d : inputDevices) {
            if (seenIds.add(d.getId())) {
                candidates.add(d);
            }
        }

        for (AudioDeviceInfo d : candidates) {
            array.pushMap(mapDeviceInfo(d));
        }

        return array;
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    public boolean setPreferredInputDevice(int deviceId) {
        if (audioManager != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            for (AudioDeviceInfo d : audioManager.getAvailableCommunicationDevices()) {
                if (d.getId() == deviceId) {
                    return audioManager.setCommunicationDevice(d);
                }
            }
        }
        return false;
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    public boolean clearPreferredInputDevice() {
        if (audioManager != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            audioManager.clearCommunicationDevice();
            return true;
        }
        return false;
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    public WritableMap getActiveInputDevice() {
        if (audioManager != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            AudioDeviceInfo active = audioManager.getCommunicationDevice();
            if (active != null) {
                return mapDeviceInfo(active);
            }
        }
        return null;
    }

    @ReactMethod
    public void addListener(String eventName) {}

    @ReactMethod
    public void removeListeners(double count) {}
}