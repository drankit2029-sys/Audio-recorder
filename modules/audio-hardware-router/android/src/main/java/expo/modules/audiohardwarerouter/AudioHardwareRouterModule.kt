package expo.modules.audiohardwarerouter

import android.content.Context
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class AudioHardwareRouterModule : Module() {
    private val context: Context
        get() = appContext.androidContext ?: appContext.reactContext
        ?: throw IllegalStateException("Android Context is not available")

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
            return@Function getInputsList()
        }

        Function("setPreferredInputDevice") { deviceId: Int ->
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val availableDevices = audioManager.availableCommunicationDevices
                val target = availableDevices.find { it.id == deviceId }
                if (target != null) {
                    return@Function audioManager.setCommunicationDevice(target)
                }
            }
            return@Function false
        }

        Function("clearPreferredInputDevice") {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                audioManager.clearCommunicationDevice()
                return@Function true
            }
            return@Function false
        }

        Function("getActiveInputDevice") {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val active = audioManager.communicationDevice
                if (active != null) {
                    return@Function mapDeviceInfo(active)
                }
            }
            return@Function null
        }
    }

    private fun dispatchDevicesUpdate() {
        sendEvent("onAudioDevicesUpdated", mapOf("devices" to getInputsList()))
    }

    private fun getInputsList(): List<Map<String, Any>> {
        val devices = audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS)
        val inputs = devices.filter { it.isSource }
        
        val listToMap = if (inputs.isNotEmpty()) inputs else devices.toList()
        return listToMap.map { mapDeviceInfo(it) }
    }

    private fun mapDeviceInfo(info: AudioDeviceInfo): Map<String, Any> {
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

        return mapOf(
            "id" to info.id,
            "name" to displayName,
            "type" to typeString,
            "typeCode" to typeCode,
            "sampleRates" to (info.sampleRates?.toList() ?: emptyList<Int>()),
            "channelCounts" to (info.channelCounts?.toList() ?: emptyList<Int>())
        )
    }
}