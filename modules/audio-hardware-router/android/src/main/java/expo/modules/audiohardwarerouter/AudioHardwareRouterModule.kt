package expo.modules.audiohardwarerouter

import android.content.Context
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

class DeviceInfoRecord : Record {
    @Field var id: Int = 0
    @Field var name: String = ""
    @Field var type: String = "external_input"
    @Field var typeCode: Int = 0
    @Field var sampleRates: List<Int> = emptyList()
    @Field var channelCounts: List<Int> = emptyList()
}

class AudioHardwareRouterModule : Module() {
    private val context: Context
        get() = appContext.reactContext
            ?: throw IllegalStateException("React Context is not available")

    private val audioManager: AudioManager
        get() = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    private val mainHandler = Handler(Looper.getMainLooper())

    private val deviceCallback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>?) {
            dispatchDevicesUpdate()
        }

        override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>?) {
            dispatchDevicesUpdate()
        }
    }

    private var isListenerRegistered = false

    override fun definition() = ModuleDefinition {
        Name("AudioHardwareRouter")

        Events("onAudioDevicesUpdated")

        OnStartObserving {
            if (!isListenerRegistered) {
                try {
                    audioManager.registerAudioDeviceCallback(deviceCallback, mainHandler)
                    isListenerRegistered = true
                } catch (_: Exception) {}
            }
        }

        OnStopObserving {
            if (isListenerRegistered) {
                try {
                    audioManager.unregisterAudioDeviceCallback(deviceCallback)
                    isListenerRegistered = false
                } catch (_: Exception) {}
            }
        }

        Function("getAvailableInputs") {
            getInputsList()
        }

        Function("setPreferredInputDevice") { deviceId: Int ->
            var success = false
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val availableDevices = audioManager.availableCommunicationDevices
                val target = availableDevices.find { it.id == deviceId }
                if (target != null) {
                    success = audioManager.setCommunicationDevice(target)
                }
            }
            success
        }

        Function("clearPreferredInputDevice") {
            var success = false
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                audioManager.clearCommunicationDevice()
                success = true
            }
            success
        }

        Function("getActiveInputDevice") {
            var result: DeviceInfoRecord? = null
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val active = audioManager.communicationDevice
                if (active != null) {
                    result = mapDeviceInfo(active)
                }
            }
            result
        }
    }

    private fun dispatchDevicesUpdate() {
        sendEvent("onAudioDevicesUpdated", Bundle().apply {
            // Send update notification event
            putBoolean("hasUpdate", true)
        })
    }

    private fun getInputsList(): List<DeviceInfoRecord> {
        val devices = audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS)
        val inputs = devices.filter { it.isSource }
        val list = if (inputs.isNotEmpty()) inputs else devices.toList()
        return list.map { mapDeviceInfo(it) }
    }

    private fun mapDeviceInfo(info: AudioDeviceInfo): DeviceInfoRecord {
        val typeCode = info.type
        val typeString = when (typeCode) {
            AudioDeviceInfo.TYPE_BUILTIN_MIC -> "builtin_mic"
            AudioDeviceInfo.TYPE_WIRED_HEADSET -> "wired_headset"
            AudioDeviceInfo.TYPE_USB_DEVICE -> "usb_device"
            AudioDeviceInfo.TYPE_USB_HEADSET -> "usb_headset"
            AudioDeviceInfo.TYPE_USB_ACCESSORY -> "usb_accessory"
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "bluetooth_sco"
            AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "bluetooth_a2dp"
            else -> "external_input"
        }

        val rawName = info.productName?.toString() ?: ""
        val displayName = when {
            rawName.isNotBlank() -> rawName
            typeCode == AudioDeviceInfo.TYPE_BUILTIN_MIC -> "Built-in Microphone"
            typeCode == AudioDeviceInfo.TYPE_WIRED_HEADSET -> "Wired Headset Mic"
            typeCode == AudioDeviceInfo.TYPE_USB_DEVICE || typeCode == AudioDeviceInfo.TYPE_USB_HEADSET -> "USB Audio Interface"
            typeCode == AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "Bluetooth Audio Input"
            else -> "Input #${info.id}"
        }

        return DeviceInfoRecord().apply {
            this.id = info.id
            this.name = displayName
            this.type = typeString
            this.typeCode = typeCode
            this.sampleRates = info.sampleRates?.toList() ?: emptyList()
            this.channelCounts = info.channelCounts?.toList() ?: emptyList()
        }
    }
}