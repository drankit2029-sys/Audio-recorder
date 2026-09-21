const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Limit workers to 1 to prevent worker process crashes in PRoot/Alpine
config.maxWorkers = 1;

// Ensure Skia and native assets resolve correctly
config.resolver.sourceExts = [...config.resolver.sourceExts, 'mjs', 'cjs'];

module.exports = config;