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

    private void registerListeners() {
        if (!isListenerRegistered && audioManager != null) {
            // 1. Android Audio Device Callback
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

            // 2. Bluetooth State BroadcastReceiver for instant earpod hotplug detection
            bluetoothReceiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context context, Intent intent) {
                    dispatchDevicesUpdate();
                }
            };

            IntentFilter filter = new IntentFilter();
            filter.addAction(BluetoothDevice.ACTION_ACL_CONNECTED);
            filter.addAction(BluetoothDevice.ACTION_ACL_DISCONNECTED);
            filter.addAction(BluetoothHeadset.ACTION_CONNECTION_STATE_CHANGED);
            filter.addAction(AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED);
            filter.addAction(AudioManager.ACTION_HEADSET_PLUG);

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                reactContext.registerReceiver(bluetoothReceiver, filter, Context.RECEIVER_EXPORTED);
            } else {
                reactContext.registerReceiver(bluetoothReceiver, filter);
            }

            isListenerRegistered = true;
        }
    }

    private void unregisterListeners() {
        if (isListenerRegistered) {
            if (audioManager != null && deviceCallback != null) {
                audioManager.unregisterAudioDeviceCallback(deviceCallback);
            }
            if (bluetoothReceiver != null) {
                try {
                    reactContext.unregisterReceiver(bluetoothReceiver);
                } catch (Exception ignored) {}
            }
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
            || type == 26 // AudioDeviceInfo.TYPE_BLE_HEADSET
            || type == 27 // AudioDeviceInfo.TYPE_BLE_SPEAKER
            || type == 23; // AudioDeviceInfo.TYPE_HEARING_AID
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
            case AudioDeviceInfo.TYPE_BLUETOOTH_A2DP:
                typeString = "bluetooth_sco";
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
            Log.w(TAG, "BLUETOOTH_CONNECT not granted when querying product name", se);
        }

        if (displayName.isEmpty()) {
            if (typeCode == AudioDeviceInfo.TYPE_BUILTIN_MIC) {
                displayName = "Built-in Microphone";
            } else if (typeCode == AudioDeviceInfo.TYPE_WIRED_HEADSET) {
                displayName = "Wired Headset Mic";
            } else if (typeCode == AudioDeviceInfo.TYPE_USB_DEVICE || typeCode == AudioDeviceInfo.TYPE_USB_HEADSET) {
                displayName = "USB Audio Interface";
            } else if (isBluetoothDevice(typeCode)) {
                displayName = "Bluetooth Earpods";
            } else {
                displayName = "Audio Input #" + info.getId();
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
        if (audioManager == null) return array;

        List<AudioDeviceInfo> candidates = new ArrayList<>();
        Set<Integer> seenIds = new HashSet<>();
        Set<String> seenBluetoothNames = new HashSet<>();

        // 1. Standard Input Microphones (Built-in mic, USB mic)
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
            Log.w(TAG, "Error querying standard inputs", e);
        }

        // 2. Communication Devices on Android 12+ (discovers Bluetooth SCO / BLE endpoints)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            try {
                List<AudioDeviceInfo> commDevices = audioManager.getAvailableCommunicationDevices();
                if (commDevices != null) {
                    for (AudioDeviceInfo d : commDevices) {
                        if (d != null && isBluetoothDevice(d.getType()) && seenIds.add(d.getId())) {
                            candidates.add(d);
                        }
                    }
                }
            } catch (Exception e) {
                Log.w(TAG, "Error querying communication devices", e);
            }
        }

        // 3. Inspect ALL connected devices to discover Bluetooth Earpods connected as A2DP/Headsets
        try {
            AudioDeviceInfo[] allDevices = audioManager.getDevices(AudioManager.GET_DEVICES_ALL);
            if (allDevices != null) {
                for (AudioDeviceInfo d : allDevices) {
                    if (d != null && isBluetoothDevice(d.getType())) {
                        String name = "";
                        try {
                            CharSequence prod = d.getProductName();
                            if (prod != null) name = prod.toString().trim();
                        } catch (Exception ignored) {}

                        // Deduplicate Bluetooth earpods that register both A2DP and SCO entries
                        if (!name.isEmpty() && seenBluetoothNames.add(name)) {
                            if (seenIds.add(d.getId())) {
                                candidates.add(d);
                            }
                        } else if (name.isEmpty() && seenIds.add(d.getId())) {
                            candidates.add(d);
                        }
                    }
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "Error querying all devices", e);
        }

        for (AudioDeviceInfo d : candidates) {
            try {
                array.pushMap(mapDeviceInfo(d));
            } catch (Exception e) {
                Log.w(TAG, "Error mapping device", e);
            }
        }

        return array;
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    public boolean setPreferredInputDevice(int deviceId) {
        if (audioManager == null) return false;

        try {
            AudioDeviceInfo targetDevice = null;
            AudioDeviceInfo[] all = audioManager.getDevices(AudioManager.GET_DEVICES_ALL);
            if (all != null) {
                for (AudioDeviceInfo d : all) {
                    if (d.getId() == deviceId) {
                        targetDevice = d;
                        break;
                    }
                }
            }

            boolean isBluetooth = targetDevice != null && isBluetoothDevice(targetDevice.getType());

            if (isBluetooth) {
                // Activate communication audio mode to open the Bluetooth microphone link
                audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);

                // Android 12+ communication routing
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    List<AudioDeviceInfo> commDevices = audioManager.getAvailableCommunicationDevices();
                    if (commDevices != null) {
                        for (AudioDeviceInfo d : commDevices) {
                            if (isBluetoothDevice(d.getType())) {
                                return audioManager.setCommunicationDevice(d);
                            }
                        }
                    }
                }

                // SCO fallback for wide compatibility across OEM chipsets
                audioManager.startBluetoothSco();
                audioManager.setBluetoothScoOn(true);
                return true;
            } else {
                // Switching back to Built-in or USB microphone
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    audioManager.clearCommunicationDevice();
                }
                audioManager.stopBluetoothSco();
                audioManager.setBluetoothScoOn(false);
                audioManager.setMode(AudioManager.MODE_NORMAL);
                return true;
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