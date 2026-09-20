const { withAndroidManifest } = require('@expo/config-plugins');

module.exports = function withAndroidAudioForegroundService(config) {
  return withAndroidManifest(config, (config) => {
    const mainApplication = config.modResults.manifest.application[0];

    // Ensure the service definition contains the microphone foregroundServiceType
    if (!mainApplication.service) {
      mainApplication.service = [];
    }

    const existingService = mainApplication.service.find(
      (s) => s.$['android:name'] === 'expo.modules.audio.AudioRecordingService'
    );

    if (!existingService) {
      mainApplication.service.push({
        $: {
          'android:name': 'expo.modules.audio.AudioRecordingService',
          'android:enabled': 'true',
          'android:exported': 'false',
          'android:foregroundServiceType': 'microphone'
        }
      });
    } else {
      existingService.$['android:foregroundServiceType'] = 'microphone';
    }

    return config;
  });
};