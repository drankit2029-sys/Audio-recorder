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
        get() = appContext.reactContext ?: throw IllegalStateException("React Context not initialized")

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
                audioManager.registerAudioDeviceCallback(deviceCallback, mainHandler)
                isListenerRegistered = true
            }
        }

        OnStopObserving {
            if (isListenerRegistered) {
                audioManager.unregisterAudioDeviceCallback(deviceCallback)
                isListenerRegistered = false
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
                    val success = audioManager.setCommunicationDevice(target)
                    return@Function success
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
        return devices.filter { it.isSource }.map { mapDeviceInfo(it) }
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

        val name = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val address = info.address
            if (!address.isNullOrEmpty()) "${info.productName} ($address)" else info.productName.toString()
        } else {
            info.productName.toString()
        }

        return mapOf(
            "id" to info.id,
            "name" to (if (name.isBlank()) "Microphone ${info.id}" else name),
            "type" to typeString,
            "typeCode" to typeCode,
            "sampleRates" to info.sampleRates.toList(),
            "channelCounts" to info.channelCounts.toList()
        )
    }
}