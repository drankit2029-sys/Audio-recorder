/**
 * Ensures MainActivity uses adjustResize so the keyboard pushes content
 * instead of covering it. Required for in-window dialogs (Save/Rename) to
 * reliably receive focus and show the IME on edge-to-edge Android 15+.
 */
const { withAndroidManifest } = require('@expo/config-plugins');

module.exports = function withSoftInputMode(config) {
  return withAndroidManifest(config, async (cfg) => {
    const manifest = cfg.modResults;
    const app = manifest.manifest.application?.[0];
    if (!app) return cfg;
    const activities = app.activity || [];
    for (const activity of activities) {
      const name = activity.$?.['android:name'];
      if (!name) continue;
      if (name === '.MainActivity' || name.endsWith('MainActivity')) {
        activity.$['android:windowSoftInputMode'] = 'adjustResize';
      }
    }
    return cfg;
  });
};
