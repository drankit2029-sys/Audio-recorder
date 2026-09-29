const fs = require('fs');
const path = require('path');
const { withAndroidManifest, withDangerousMod } = require('expo/config-plugins');

/**
 * H1 — Android 16 (API 36) IGNORES screen-orientation, resizability and
 * aspect-ratio requests on displays whose smallest width is >= 600dp. That is
 * every tablet, every unfolded Pixel Fold / Galaxy Fold and most landscape
 * windows, so `orientation: "portrait"` silently stops working there and the
 * studio layout has to survive being laid out wide.
 *
 * Until the app is genuinely adaptive, opt out with the temporary compatibility
 * properties Google ships for target SDK 36. NOTE: Google documents these as
 * temporary — they are removed at target SDK 37 — so delete this plugin once
 * the layouts are responsive (src/hooks/useResponsive.ts now reports real size
 * classes and the studio already handles wide windows).
 */
const OPT_OUT_PROPERTIES = [
  { name: 'android.window.PROPERTY_COMPAT_ALLOW_ORIENTATION_OVERRIDE', value: 'true' },
  { name: 'android.window.PROPERTY_COMPAT_ALLOW_RESTRICTED_RESIZABILITY', value: 'true' },
];

/**
 * `android.supportsTablet` was silently dropped from the app-config schema and
 * never did anything on Android (it is an iOS-only field today), so the
 * large-screen declaration is written into the manifest directly instead. This
 * is what tells the platform — and the Play Store — that the app runs on
 * phones, tablets and foldables of every density.
 */
const SUPPORTS_SCREENS = {
  'android:anyDensity': 'true',
  'android:smallScreens': 'true',
  'android:normalScreens': 'true',
  'android:largeScreens': 'true',
  'android:xlargeScreens': 'true',
  'android:resizeable': 'true',
};

function withLargeScreenSupport(config) {
  return withAndroidManifest(config, (config) => {
    const application = config.modResults?.manifest?.application?.[0];
    if (!application) return config;
    const manifest = config.modResults.manifest;
    manifest['supports-screens'] = [{ $: { ...SUPPORTS_SCREENS } }];
    return config;
  });
}

const NAV_BAR_COLOR = '#0B0B0F';
const STATUS_BAR_COLOR = '#0B0B0F';

function withLargeScreenProperties(config) {
  return withAndroidManifest(config, (config) => {
    const application = config.modResults?.manifest?.application?.[0];
    if (!application) {
      return config;
    }
    // The manifest serializer turns a `$` key into XML attributes and every
    // other key into child elements, so the name/value must live under `$`.
    application.property = Array.isArray(application.property) ? application.property : [];
    for (const { name, value } of OPT_OUT_PROPERTIES) {
      const existing = application.property.find((p) => p?.$?.['android:name'] === name);
      if (existing) {
        existing.$['android:value'] = value;
      } else {
        application.property.push({ $: { 'android:name': name, 'android:value': value } });
      }
    }
    return config;
  });
}

/**
 * Belt and braces for Android 15 and below (API 24-35): pin the Activity itself
 * as well as requesting `orientation: "portrait"` in app.json.
 *
 * Note: `android:configChanges` is deliberately left to the Expo/RN template,
 * which already lists orientation, screenSize, smallestScreenSize and uiMode.
 * That last one matters here — it is what lets a foldable unfold without
 * destroying the Activity mid-take. This mod runs before the template's own,
 * so setting it here would only be overwritten.
 */
function withPortraitActivity(config) {
  return withAndroidManifest(config, (config) => {
    const activities = config.modResults?.manifest?.application?.[0]?.activity ?? [];
    const activity = activities.find((a) => (a?.['android:name'] ?? '') === '.MainActivity');
    if (activity) {
      activity['android:screenOrientation'] = 'portrait';
    }
    return config;
  });
}

const STYLE_ITEMS = [
  { name: 'android:statusBarColor', value: STATUS_BAR_COLOR, targetApi: null },
  { name: 'android:windowLightStatusBar', value: 'false', targetApi: null },
  // Tinting the navigation bar only exists from API 27; the tools:targetApi
  // marker keeps older platforms from choking on the attribute.
  { name: 'android:navigationBarColor', value: NAV_BAR_COLOR, targetApi: '27' },
  { name: 'android:windowLightNavigationBar', value: 'false', targetApi: '27' },
  // H5: with edge-to-edge forced, let content fill to the short edges so a
  // punch-hole camera does not letterbox the layout on tablets that are
  // forced into landscape.
  { name: 'android:windowLayoutInDisplayCutoutMode', value: 'shortEdges', targetApi: '27' },
];

const FALLBACK_STYLES = `<?xml version="1.0" encoding="utf-8"?>
<resources xmlns:tools="http://schemas.android.com/tools">
  <style name="AppTheme" parent="Theme.AppCompat.DayNight.NoActionBar">
  </style>
</resources>
`;

/**
 * Idempotent, dependency-free edit of `res/values/styles.xml`: adds the system
 * bar items to the AppTheme style if they are not there yet.
 */
function applyStyleItems(contents) {
  let out = contents;

  if (!/xmlns:tools=/.test(out)) {
    out = out.replace(/<resources([^>]*)>/, '<resources$1 xmlns:tools="http://schemas.android.com/tools">');
  }

  const styleMatch = out.match(/<style\s+name="AppTheme"[^>]*>([\s\S]*?)<\/style>/);
  if (!styleMatch) {
    // No AppTheme (custom template): create one so the items have a home.
    const items = STYLE_ITEMS.map(
      (i) =>
        `    <item name="${i.name}"${i.targetApi ? ` tools:targetApi="${i.targetApi}"` : ''}>${i.value}</item>`
    ).join('\n');
    return out.replace(
      /(<\/resources>)/,
      `  <style name="AppTheme" parent="Theme.AppCompat.DayNight.NoActionBar">\n${items}\n  </style>\n$1`
    );
  }

  let block = styleMatch[1];
  for (const item of STYLE_ITEMS) {
    if (block.includes(`name="${item.name}"`)) {
      continue;
    }
    const line = `    <item name="${item.name}"${
      item.targetApi ? ` tools:targetApi="${item.targetApi}"` : ''
    }>${item.value}</item>`;
    block = `${block.replace(/\s*$/, '\n')}${line}\n`;
  }
  return out.replace(styleMatch[0], styleMatch[0].replace(styleMatch[1], block));
}

function withSystemBarStyles(config) {
  return withDangerousMod(config, [
    'android',
    async (config) => {
      const resPath = path.join(
        config.modRequest.projectRoot,
        'android',
        'app',
        'src',
        'main',
        'res',
        'values',
        'styles.xml'
      );
      let contents;
      try {
        contents = await fs.promises.readFile(resPath, 'utf8');
      } catch {
        contents = FALLBACK_STYLES;
      }
      const next = applyStyleItems(contents);
      if (next !== contents) {
        await fs.promises.mkdir(path.dirname(resPath), { recursive: true });
        await fs.promises.writeFile(resPath, next, 'utf8');
      }
      return config;
    },
  ]);
}

/**
 * Config plugins referenced from app.json must export a function as the module
 * itself (see the sibling plugins in this folder), so the named export is
 * attached to the function for reuse/tests.
 */
function withAndroidLargeScreenOptOut(config) {
  return [
    withLargeScreenSupport,
    withLargeScreenProperties,
    withPortraitActivity,
    withSystemBarStyles,
  ].reduce(
    (acc, mod) => mod(acc),
    config
  );
}

module.exports = withAndroidLargeScreenOptOut;
module.exports.withAndroidLargeScreenOptOut = withAndroidLargeScreenOptOut;
