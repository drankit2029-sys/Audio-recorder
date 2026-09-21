// plugins/withNotifeeForegroundService.js
const { withAndroidManifest } = require('@expo/config-plugins');

module.exports = function withNotifeeForegroundService(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    const app = manifest.application[0];

    // Ensure tools namespace is declared on the <manifest> root
    if (!manifest.$['xmlns:tools']) {
      manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';
    }

    if (!app.service) {
      app.service = [];
    }

    // Locate Notifee's ForegroundService or declare it
    let service = app.service.find(
      (s) => s.$ && s.$['android:name'] === 'app.notifee.core.ForegroundService'
    );

    if (!service) {
      service = {
        $: {
          'android:name': 'app.notifee.core.ForegroundService',
        },
      };
      app.service.push(service);
    }

    // Override the default shortService (0x800) with microphone (0x80)
    service.$['android:foregroundServiceType'] = 'microphone';
    service.$['tools:replace'] = 'android:foregroundServiceType';

    return config;
  });
};