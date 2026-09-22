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
        if (sampleRates != null && sampleRates.length > 0) {
            for (int r : sampleRates) {
                rates.pushInt(r);
            }
        } else {
            rates.pushInt(44100);
            rates.pushInt(48000);
        }
        map.putArray("sampleRates", rates);

        WritableArray channels = Arguments.createArray();
        int[] channelCounts = info.getChannelCounts();
        if (channelCounts != null && channelCounts.length > 0) {
            for (int c : channelCounts) {
                channels.pushInt(c);
            }
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

        // 4. Deduplicate by product name so earpods only appear as a single entry
        Set<String> seenNames = new HashSet<>();
        for (AudioDeviceInfo d : rawList) {
            try {
                WritableMap map = mapDeviceInfo(d);
                String name = map.getString("name");

                if (seenNames.add(name)) {
                    array.pushMap(map);
                }
            } catch (Exception ignored) {}
        }

        return array;
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    public boolean setPreferredInputDevice(int deviceId) {
        if (audioManager == null) return false;

        try {
            AudioDeviceInfo target = null;
            // Use bitwise mask to retrieve all devices cleanly
            AudioDeviceInfo[] all = audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS | AudioManager.GET_DEVICES_OUTPUTS);
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
                    if (comms != null) {
                        for (AudioDeviceInfo comm : comms) {
                            if (comm != null && (comm.getId() == deviceId || isBluetoothDevice(comm.getType()))) {
                                return audioManager.setCommunicationDevice(comm);
                            }
                        }
                    }
                } else {
                    audioManager.startBluetoothSco();
                    audioManager.setBluetoothScoOn(true);
                    return true;
                }
            } else {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    audioManager.clearCommunicationDevice();
                }
                audioManager.stopBluetoothSco();
                audioManager.setBluetoothScoOn(false);
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
            }
            audioManager.stopBluetoothSco();
            audioManager.setBluetoothScoOn(false);
            audioManager.setMode(AudioManager.MODE_NORMAL);
            return true;
        } catch (Exception ignored) {}
        return false;
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    public WritableMap getActiveInputDevice() {
        return null;
    }

    @ReactMethod
    public void addListener(String eventName) {}

    @ReactMethod
    public void removeListeners(double count) {}
}