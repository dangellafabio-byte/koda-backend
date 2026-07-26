#!/usr/bin/env node
/**
 * Purge Sentry from node_modules AFTER install.
 *
 * WHY: The Emergent EAS build runner aggressively caches node_modules across
 * builds. Previous builds installed @sentry/react-native; even after removing
 * it from package.json + yarn.lock, the cached node_modules still contains it,
 * causing:
 *  - @sentry/react-native's Expo config plugin to inject Sentry.init into
 *    the app entry during `expo prebuild`
 *  - CocoaPods autolink to install the Sentry native pod
 *  - Xcode build phase "Upload Debug Symbols to Sentry" to run and fail
 *    because no SENTRY_AUTH_TOKEN is configured
 *
 * This script runs automatically after every `yarn install` (via the
 * "postinstall" script in package.json). It force-removes any Sentry
 * package that snuck in via cache, so subsequent build steps never see it.
 *
 * Safe to run repeatedly. No-op when Sentry isn't present.
 */

const fs = require('fs');
const path = require('path');

const NODE_MODULES = path.join(__dirname, '..', 'node_modules');

// All Sentry-related package paths that must be nuked
const SENTRY_PATHS = [
  '@sentry',
  'sentry-expo',
  'sentry-cli-binary',
  '@sentry/react-native',
  '@sentry/cli',
  '@sentry/cli-darwin',
  '@sentry/cli-linux-x64',
  '@sentry/cli-linux-arm64',
  '@sentry/cli-win32-x64',
  '@sentry/babel-plugin-component-annotate',
];

function rimraf(target) {
  if (!fs.existsSync(target)) return false;
  try {
    fs.rmSync(target, { recursive: true, force: true });
    return true;
  } catch (e) {
    console.warn(`[purge-sentry] Failed to remove ${target}:`, e.message);
    return false;
  }
}

let removedCount = 0;
for (const rel of SENTRY_PATHS) {
  const full = path.join(NODE_MODULES, rel);
  if (rimraf(full)) {
    console.log(`[purge-sentry] Removed ${rel}`);
    removedCount++;
  }
}

// Also drop stray sentry.properties file at project root if regenerated
const sentryProps = path.join(__dirname, '..', 'sentry.properties');
if (fs.existsSync(sentryProps)) {
  try {
    fs.unlinkSync(sentryProps);
    console.log('[purge-sentry] Removed sentry.properties');
    removedCount++;
  } catch (e) {
    // ignore
  }
}

if (removedCount === 0) {
  console.log('[purge-sentry] Clean. No Sentry artifacts found.');
} else {
  console.log(`[purge-sentry] Done. Removed ${removedCount} artifact(s).`);
}
