// Disposable native test build. The normal Expo configuration comes from app.json.
module.exports = ({config}) => {
  const smoke = process.env.OLLENYA_NATIVE_CANDIDATE === '1';
  const review = process.env.OLLENYA_LOCAL_MEMORY_APP_CANDIDATE === '1';
  const isolated = process.env.OLLENYA_ISOLATED_BUILD === '1' ||
    process.env.EAS_BUILD_PROFILE === 'memoria-device-ios';
  if (isolated && !review) throw Error('Isolated build requires the full review app');
  if (!smoke && !review) return config;
  if (smoke && review) throw Error('Select one memory candidate');
  const entry = require('./package.json').main;
  if (review && entry !== 'expo-router/entry') throw Error('The review candidate requires the main app entry point');
  if (smoke && entry !== './native-memory-smoke.tsx') {
    throw Error('Select the dedicated offline entry point in a disposable copy');
  }
  const extra = {...config.extra};
  if (review) {
    const backend = new URL(process.env.OLLENYA_MEMORY_REVIEW_BACKEND_URL || 'http://localhost:8001');
    if (!['http:', 'https:'].includes(backend.protocol) || backend.username || backend.password ||
        backend.pathname !== '/' || backend.search || backend.hash ||
        backend.hostname === 'koda-backend-production-4a34.up.railway.app') {
      throw Error('Use a separate test backend origin for the memory review candidate');
    }
    if (isolated) {
      if (!process.env.OLLENYA_MEMORY_REVIEW_BACKEND_URL || backend.protocol !== 'https:' ||
          ['localhost','127.0.0.1','[::1]'].includes(backend.hostname) ||
          backend.hostname.replace(/\.+$/, '') === 'koda-backend-production-4a34.up.railway.app') {
        throw Error('Configure a separate HTTPS test backend');
      }
      const id = process.env.OLLENYA_TEST_EAS_PROJECT_ID;
      if (!id || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id) ||
          id.toLowerCase() === config.extra?.eas?.projectId?.toLowerCase()) {
        throw Error('Configure a separate EAS test project');
      }
      extra.EXPO_BACKEND_URL = backend.origin;
    }
    extra.ollenyaMemoryReviewBackend = backend.origin;
    extra.ollenyaDeviceText = process.env.OLLENYA_DEVICE_TEXT_CANDIDATE === '1';
    extra.ollenyaDeviceVoice = extra.ollenyaDeviceText && process.env.OLLENYA_DEVICE_VOICE_CANDIDATE === '1';
    if (extra.ollenyaDeviceText && backend.protocol !== 'https:' && !['localhost','127.0.0.1','[::1]'].includes(backend.hostname)) {
      throw Error('Device text requires HTTPS or loopback');
    }
  }
  if (isolated) extra.eas = {projectId: process.env.OLLENYA_TEST_EAS_PROJECT_ID};
  else delete extra.eas;
  const plugins = (config.plugins || []).filter(plugin => !smoke || plugin !== 'expo-apple-authentication');
  const bundle = review ? 'com.dangella.ollenya.memoryreview' : 'com.dangella.ollenya.memorytest';
  const slug = review ? 'ollenya-memory-review' : 'ollenya-memory-test';
  return {
    ...config,
    name: review ? 'Ollenya Memory Review' : 'Ollenya Memory Test',
    slug,
    owner: undefined,
    scheme: slug,
    runtimeVersion: review ? '1.0.152-memory-review.1' : '1.0.152-memory-test.2',
    updates: {enabled: false},
    ios: {...config.ios, bundleIdentifier: bundle, usesAppleSignIn: review && config.ios?.usesAppleSignIn},
    android: {...config.android, package: bundle},
    plugins: [...plugins, ['expo-sqlite', {useSQLCipher: true}]],
    extra: {...extra, ollenyaNativeCandidate: true, ollenyaLocalMemoryReview: review},
  };
};
