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
            
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                reactContext.registerReceiver(bluetoothReceiver, filter, Context.RECEIVER_EXPORTED);
            } else {
                reactContext.registerReceiver(bluetoothReceiver, filter);
            }
            isListenerRegistered = true;
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
                typeString = "usb_device";
                break;
            case AudioDeviceInfo.TYPE_BLUETOOTH_SCO:
            case 26: 
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
        } catch (SecurityException ignored) {}

        if (displayName.isEmpty()) {
            if (typeCode == AudioDeviceInfo.TYPE_BUILTIN_MIC) {
                displayName = "Built-in Microphone";
            } else if (typeString.equals("bluetooth_sco")) {
                displayName = "Bluetooth Earpods";
            } else {
                displayName = "Hardware Input #" + info.getId();
            }
        }

        map.putInt("id", info.getId());
        map.putString("name", displayName);
        map.putString("type", typeString);
        map.putInt("typeCode", typeCode);

        WritableArray rates = Arguments.createArray();
        int[] sampleRates = info.getSampleRates();
        if (sampleRates != null) {
            for (int r : sampleRates) { rates.pushInt(r); }
        }
        map.putArray("sampleRates", rates);
        return map;
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    public WritableArray getAvailableInputs() {
        WritableArray array = Arguments.createArray();
        if (audioManager == null) return array;

        List<AudioDeviceInfo> candidates = new ArrayList<>();
        Set<Integer> seenIds = new HashSet<>();
        boolean foundBluetooth = false;

        // 1. Android 12+ Communication Endpoints (Finds Wireless Earpods)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            try {
                for (AudioDeviceInfo d : audioManager.getAvailableCommunicationDevices()) {
                    if (d.getType() != AudioDeviceInfo.TYPE_BUILTIN_SPEAKER && seenIds.add(d.getId())) {
                        candidates.add(d);
                        if (isBluetoothDevice(d.getType())) foundBluetooth = true;
                    }
                }
            } catch (Exception ignored) {}
        }

        // 2. Standard Mic Capsules
        try {
            for (AudioDeviceInfo d : audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS)) {
                if (d.isSource() && seenIds.add(d.getId())) {
                    candidates.add(d);
                    if (isBluetoothDevice(d.getType())) foundBluetooth = true;
                }
            }
        } catch (Exception ignored) {}

        // 3. Force catch connected Bluetooth headsets hiding as A2DP
        if (!foundBluetooth) {
            try {
                for (AudioDeviceInfo d : audioManager.getDevices(AudioManager.GET_DEVICES_ALL)) {
                    if (isBluetoothDevice(d.getType()) && seenIds.add(d.getId())) {
                        candidates.add(d);
                    }
                }
            } catch (Exception ignored) {}
        }

        for (AudioDeviceInfo d : candidates) {
            array.pushMap(mapDeviceInfo(d));
        }
        return array;
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    public boolean setPreferredInputDevice(int deviceId) {
        if (audioManager == null) return false;
        try {
            AudioDeviceInfo target = null;
            for (AudioDeviceInfo d : audioManager.getDevices(AudioManager.GET_DEVICES_ALL)) {
                if (d.getId() == deviceId) { target = d; break; }
            }

            if (target != null && isBluetoothDevice(target.getType())) {
                audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);
                audioManager.startBluetoothSco();
                audioManager.setBluetoothScoOn(true);
                
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    for (AudioDeviceInfo comm : audioManager.getAvailableCommunicationDevices()) {
                        if (comm.getId() == deviceId || isBluetoothDevice(comm.getType())) {
                            return audioManager.setCommunicationDevice(comm);
                        }
                    }
                }
                return true;
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
        } catch (Exception ignored) {}
        return false;
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    public WritableMap getActiveInputDevice() {
        if (audioManager == null) return null;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            AudioDeviceInfo active = audioManager.getCommunicationDevice();
            if (active != null && active.getType() != AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) {
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