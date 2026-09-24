// plugins/withNotifeeForegroundService.js
const { withAndroidManifest } = require('@expo/config-plugins');

module.exports = function withNotifeeForegroundService(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    const app = manifest.application[0];

    if (!manifest.$['xmlns:tools']) {
      manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';
    }

    if (!app.service) {
      app.service = [];
    }

    let service = app.service.find(
      (s) => s.$ && s.$['android:name'] === 'app.notifee.core.ForegroundService'
    );

    if (!service) {
      service = {
        $: {
          'android:name': 'app.notifee.core.ForegroundService',
          'android:exported': 'false',
        },
      };
      app.service.push(service);
    } else {
      service.$['android:exported'] = 'false';
    }

    service.$['android:foregroundServiceType'] = 'microphone';
    service.$['tools:replace'] = 'android:foregroundServiceType';

    return config;
  });
};