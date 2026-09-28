const { withAndroidManifest } = require('@expo/config-plugins');

module.exports = function withBluetoothMaxSdk(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    const permissions = manifest['uses-permission'] || [];

    ['android.permission.BLUETOOTH', 'android.permission.BLUETOOTH_ADMIN'].forEach((permName) => {
      const existing = permissions.find((p) => p.$['android:name'] === permName);
      if (existing) {
        existing.$['android:maxSdkVersion'] = '30';
      } else {
        permissions.push({
          $: {
            'android:name': permName,
            'android:maxSdkVersion': '30',
          },
        });
      }
    });

    manifest['uses-permission'] = permissions;
    return config;
  });
};