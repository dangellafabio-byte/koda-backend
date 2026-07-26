/**
 * withDisableSentryXcode.js
 *
 * === CONFIG PLUGIN — 26 luglio 2026 (v3 — approccio in-memory) ===
 *
 * ARCHITETTURA EXPO CONFIG-PLUGINS (scoperto in test end-to-end):
 *   1. Expo raccoglie tutte le modifiche in memoria via `withXcodeProject`
 *   2. Serializza il pbxproj sul disco (versione intermedia)
 *   3. Applica tutti i `withDangerousMod`
 *   4. RI-SERIALIZZA il pbxproj DA MEMORIA — sovrascrive edit del passo 3
 *
 * Conseguenza: modifiche al pbxproj DEVONO passare da `withXcodeProject`
 * per non essere perse. `withDangerousMod` è utile solo per file non-pbxproj
 * (esempio: ios/sentry.properties).
 *
 * ORDINE ESECUZIONE:
 *   In `app.json` questo plugin DEVE essere dichiarato PRIMA di eventuali
 *   plugin sentry per garantire che le sue modifiche in-memory al
 *   xcodeProject vengano applicate DOPO. (Config-plugins accoda le mod
 *   in ordine, ma i mod dello stesso tipo girano in FIFO — non LIFO come
 *   pensavo inizialmente. Il primo plugin gira per primo, l'ultimo per
 *   ultimo. Se dichiarato ultimo, il mio xcodeProject-mod gira DOPO sentry
 *   e vede le sue modifiche.)
 *
 * TEST END-TO-END LOCALE (26 lug 2026 v3):
 *   Vedere l'output di `npx expo prebuild --platform ios --clean` sotto.
 */

const { withXcodeProject, withDangerousMod } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

// Script "Bundle React Native code and images" vanilla (Expo SDK 54).
const VANILLA_BUNDLE_SCRIPT = [
  'if [[ -f "$PODS_ROOT/../.xcode.env" ]]; then',
  '  source "$PODS_ROOT/../.xcode.env"',
  "fi",
  'if [[ -f "$PODS_ROOT/../.xcode.env.local" ]]; then',
  '  source "$PODS_ROOT/../.xcode.env.local"',
  "fi",
  "",
  'export PROJECT_ROOT="$PROJECT_DIR"/..',
  "",
  'if [[ "$CONFIGURATION" = *Debug* ]]; then',
  "  export SKIP_BUNDLING=1",
  "fi",
  'if [[ -z "$ENTRY_FILE" ]]; then',
  '  export ENTRY_FILE="$("$NODE_BINARY" -e "require(\'expo/scripts/resolveAppEntry\')" "$PROJECT_ROOT" ios absolute | tail -n 1)"',
  "fi",
  "",
  'if [[ -z "$CLI_PATH" ]]; then',
  '  export CLI_PATH="$("$NODE_BINARY" --print "require.resolve(\'@expo/cli\', { paths: [require.resolve(\'expo/package.json\')] })")"',
  "fi",
  'if [[ -z "$BUNDLE_COMMAND" ]]; then',
  '  export BUNDLE_COMMAND="export:embed"',
  "fi",
  "",
  '`"$NODE_BINARY" --print "require(\'path\').dirname(require.resolve(\'react-native/package.json\')) + \'/scripts/react-native-xcode.sh\'"`',
].join("\n");

/**
 * Modifica il progetto Xcode in memoria — rimuove entries Sentry.
 */
function withPurgeSentryFromXcode(config) {
  return withXcodeProject(config, (config) => {
    const xcodeProject = config.modResults;

    // ============================================================
    // CINTURA DI SICUREZZA (belt-and-suspenders):
    // Aggiungiamo SENTRY_ALLOW_FAILURE=true e SENTRY_DISABLE_AUTO_UPLOAD=true
    // come Xcode Build Settings a livello di ogni configurazione (Debug/Release).
    // Anche se il "rimuovi entries" qui sotto fallisse per un edge-case sul
    // mac runner EAS, questi env vars istruiscono sentry-cli a NON far fallire
    // il build in caso di auth token mancante.
    //
    // I build settings Xcode diventano automaticamente env vars per gli
    // shell script build phases.
    // ============================================================
    try {
      const configurations = xcodeProject.pbxXCBuildConfigurationSection();
      let safetyAdded = 0;
      for (const uuid of Object.keys(configurations)) {
        if (uuid.endsWith("_comment")) continue;
        const conf = configurations[uuid];
        if (!conf || !conf.buildSettings) continue;
        // Aggiungiamo solo se non già presenti (idempotente)
        if (!conf.buildSettings.SENTRY_ALLOW_FAILURE) {
          conf.buildSettings.SENTRY_ALLOW_FAILURE = '"true"';
          safetyAdded++;
        }
        if (!conf.buildSettings.SENTRY_DISABLE_AUTO_UPLOAD) {
          conf.buildSettings.SENTRY_DISABLE_AUTO_UPLOAD = '"true"';
        }
      }
      if (safetyAdded > 0) {
        console.log(
          `[withDisableSentryXcode] 🛡️  Cintura sicurezza: SENTRY_ALLOW_FAILURE=true aggiunto a ${safetyAdded} build config`
        );
      }
    } catch (e) {
      console.warn(
        "[withDisableSentryXcode] ⚠️  Errore cintura sicurezza (non bloccante):",
        e.message
      );
    }

    const buildPhases =
      xcodeProject.hash.project.objects.PBXShellScriptBuildPhase || {};

    let removedUpload = 0;
    let patchedBundle = 0;

    for (const uuid of Object.keys(buildPhases)) {
      if (uuid.endsWith("_comment")) continue;
      const phase = buildPhases[uuid];
      if (!phase || typeof phase !== "object") continue;

      // Nel pbxproj i nomi sono in DOPPIE virgolette (formato Xcode)
      const nameRaw = phase.name || "";
      const name = nameRaw.replace(/^"|"$/g, "");
      const shellScript = phase.shellScript || "";

      // === Rimuovi "Upload Debug Symbols to Sentry" ===
      if (name === "Upload Debug Symbols to Sentry") {
        delete buildPhases[uuid];
        delete buildPhases[`${uuid}_comment`];

        const nativeTargets =
          xcodeProject.hash.project.objects.PBXNativeTarget || {};
        for (const tUuid of Object.keys(nativeTargets)) {
          if (tUuid.endsWith("_comment")) continue;
          const target = nativeTargets[tUuid];
          if (!target || !Array.isArray(target.buildPhases)) continue;
          target.buildPhases = target.buildPhases.filter(
            (bp) => bp && bp.value !== uuid
          );
        }
        removedUpload++;
        console.log(
          `[withDisableSentryXcode] ✅ Rimossa build phase "Upload Debug Symbols to Sentry" (${uuid})`
        );
        continue;
      }

      // === Riscrivi "Bundle React Native code and images" a vanilla ===
      if (
        name === "Bundle React Native code and images" &&
        (shellScript.includes("sentry-xcode.sh") ||
          shellScript.includes("@sentry/react-native"))
      ) {
        phase.shellScript = JSON.stringify(VANILLA_BUNDLE_SCRIPT);
        patchedBundle++;
        console.log(
          `[withDisableSentryXcode] ✅ Ripristinato "Bundle React Native code and images" a vanilla`
        );
      }
    }

    console.log(
      `[withDisableSentryXcode] SOMMARIO xcodeproj: rimossa upload=${removedUpload}, patched bundle=${patchedBundle}`
    );
    return config;
  });
}

/**
 * Cancella ios/sentry.properties dal filesystem (post-prebuild).
 */
function withDeleteSentryProperties(config) {
  return withDangerousMod(config, [
    "ios",
    async (config) => {
      const iosRoot = config.modRequest.platformProjectRoot;
      const sentryProps = path.join(iosRoot, "sentry.properties");
      if (fs.existsSync(sentryProps)) {
        try {
          fs.unlinkSync(sentryProps);
          console.log(
            "[withDisableSentryXcode] ✅ Rimosso ios/sentry.properties"
          );
        } catch (e) {
          console.warn(
            "[withDisableSentryXcode] ⚠️  Errore rimozione sentry.properties:",
            e.message
          );
        }
      }
      return config;
    },
  ]);
}

module.exports = function withDisableSentryXcode(config) {
  config = withPurgeSentryFromXcode(config);
  config = withDeleteSentryProperties(config);
  return config;
};
