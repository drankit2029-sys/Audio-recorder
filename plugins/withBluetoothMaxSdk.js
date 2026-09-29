const { withAndroidManifest } = require('@expo/config-plugins');

module.exports = function withBluetoothMaxSdk(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    const permissions = manifest['uses-permission'] || [];

    // Declaring BLUETOOTH_CONNECT without this flag makes the platform treat it
    // as location-adjacent, which triggers extra Play scrutiny and, on some
    // OEM builds, a needless location prompt. The app only needs the device
    // names, never the location.
    const bluetoothConnect = permissions.find(
      (p) => p.$['android:name'] === 'android.permission.BLUETOOTH_CONNECT'
    );
    if (bluetoothConnect) {
      bluetoothConnect.$['android:usesPermissionFlags'] = 'neverForLocation';
    }

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