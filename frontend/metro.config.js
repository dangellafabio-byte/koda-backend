// metro.config.js
// === SENTRY 2026-07-26 v65 — getSentryExpoConfig per Debug ID nei source maps ===
// Sostituisce getDefaultConfig di Expo; Sentry aggiunge Debug IDs ai bundle
// così gli stack trace in produzione risalgono ai file sorgente originali.
const { getSentryExpoConfig } = require("@sentry/react-native/metro");
const path = require('path');
const { FileStore } = require('metro-cache');

const config = getSentryExpoConfig(__dirname);

// Use a stable on-disk store (shared across web/android)
const root = process.env.METRO_CACHE_ROOT || path.join(__dirname, '.metro-cache');
config.cacheStores = [
  new FileStore({ root: path.join(root, 'cache') }),
];


// // Exclude unnecessary directories from file watching
// config.watchFolders = [__dirname];
// config.resolver.blacklistRE = /(.*)\/(__tests__|android|ios|build|dist|.git|node_modules\/.*\/android|node_modules\/.*\/ios|node_modules\/.*\/windows|node_modules\/.*\/macos)(\/.*)?$/;

// // Alternative: use a more aggressive exclusion pattern
// config.resolver.blacklistRE = /node_modules\/.*\/(android|ios|windows|macos|__tests__|\.git|.*\.android\.js|.*\.ios\.js)$/;

// Reduce the number of workers to decrease resource usage
config.maxWorkers = 2;

module.exports = config;
