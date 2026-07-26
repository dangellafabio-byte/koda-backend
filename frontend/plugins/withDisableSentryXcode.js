/**
 * withDisableSentryXcode.js
 *
 * === CONFIG PLUGIN — 26 luglio 2026 ===
 *
 * PROBLEMA:
 *   Il pacchetto `@sentry/react-native` è rimosso da package.json, ma il mac
 *   runner EAS di Emergent mantiene una cache persistente di `node_modules`
 *   tra build (GCS-backed). `yarn install` con lockfile invariato stampa
 *   "Already up-to-date" e SALTA gli script postinstall — quindi ogni
 *   tentativo di ripulire node_modules/@sentry via script fallisce.
 *
 *   Conseguenze:
 *     - RN autolinking trova @sentry/react-native in node_modules
 *     - Il suo config plugin genera `ios/sentry.properties`
 *     - Aggiunge la build phase "Upload Debug Symbols to Sentry"
 *     - Modifica "Bundle React Native code and images" per invocare
 *       sentry-cli invece di react-native-xcode.sh puro
 *     - sentry-cli richiede SENTRY_AUTH_TOKEN → non disponibile → EXIT 1
 *     - ARCHIVE FAILED
 *
 * SOLUZIONE (questo plugin):
 *   Girando DOPO gli altri plugin (incluso quello di sentry) durante
 *   `expo prebuild`, neutralizziamo ogni riferimento a sentry-cli:
 *
 *     1. Cancella `ios/sentry.properties` (senza il file, sentry-xcode.sh
 *        non trova config → esce con exit 0 come no-op)
 *     2. Rimuove COMPLETAMENTE la build phase "Upload Debug Symbols to
 *        Sentry" dal target Koda (era ridondante)
 *     3. Riscrive lo script "Bundle React Native code and images" per
 *        usare il react-native-xcode.sh VANILLA (senza wrapper Sentry)
 *     4. Aggiunge env vars di safety (SENTRY_ALLOW_FAILURE=true,
 *        SENTRY_DISABLE_AUTO_UPLOAD=true) come cintura di sicurezza
 *
 * REVERSIBILE:
 *   Quando l'utente fornirà il SENTRY_AUTH_TOKEN e vorrà riattivare Sentry:
 *     - Rimuovere questo plugin da app.json
 *     - Aggiungere SENTRY_AUTH_TOKEN come EAS Secret via https://expo.dev
 *     - Reinstallare @sentry/react-native + config
 *
 * TESTATO SU: Expo SDK 54, react-native 0.81.5, EAS Build (macrunner)
 */

const { withXcodeProject, withDangerousMod } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

const VANILLA_BUNDLE_SCRIPT = `"set -e\\n\\nWITH_ENVIRONMENT=\\"$REACT_NATIVE_PATH/scripts/xcode/with-environment.sh\\"\\nREACT_NATIVE_XCODE=\\"$REACT_NATIVE_PATH/scripts/react-native-xcode.sh\\"\\n\\n/bin/sh -c \\"$WITH_ENVIRONMENT $REACT_NATIVE_XCODE\\"\\n"`;

/**
 * Step 1 — cancella `ios/sentry.properties`
 * (via withDangerousMod perché operiamo sul filesystem generato).
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
            "[withDisableSentryXcode] ⚠️  Impossibile rimuovere sentry.properties:",
            e.message
          );
        }
      }
      // Nota: anche node_modules/@sentry/react-native/scripts/sentry.properties
      // potrebbe essere referenziato, ma il file principale è quello sopra.
      return config;
    },
  ]);
}

/**
 * Step 2 + 3 + 4 — modifica il progetto Xcode.
 */
function withPatchXcode(config) {
  return withXcodeProject(config, (config) => {
    const xcodeProject = config.modResults;
    const buildPhases = xcodeProject.hash.project.objects.PBXShellScriptBuildPhase || {};

    let removedUpload = 0;
    let patchedBundle = 0;
    let envAdded = 0;

    for (const uuid of Object.keys(buildPhases)) {
      // Skip commenti (chiavi tipo "AAAA_comment")
      if (uuid.endsWith("_comment")) continue;
      const phase = buildPhases[uuid];
      if (!phase || typeof phase !== "object") continue;

      const name = (phase.name || "").replace(/^"|"$/g, "");
      const shellScript = phase.shellScript || "";

      // === STEP 2: rimuovi completamente "Upload Debug Symbols to Sentry" ===
      if (name === "Upload Debug Symbols to Sentry") {
        // Rimuovi dalla sezione PBXShellScriptBuildPhase
        delete buildPhases[uuid];
        delete buildPhases[`${uuid}_comment`];

        // Rimuovi anche il riferimento dentro tutti i PBXNativeTarget buildPhases
        const nativeTargets = xcodeProject.hash.project.objects.PBXNativeTarget || {};
        for (const targetUuid of Object.keys(nativeTargets)) {
          if (targetUuid.endsWith("_comment")) continue;
          const target = nativeTargets[targetUuid];
          if (!target || !Array.isArray(target.buildPhases)) continue;
          target.buildPhases = target.buildPhases.filter(
            (bp) => bp && bp.value !== uuid
          );
        }
        removedUpload++;
        console.log(
          `[withDisableSentryXcode] ✅ Rimossa build phase "Upload Debug Symbols to Sentry" (uuid: ${uuid})`
        );
        continue;
      }

      // === STEP 3: riscrivi "Bundle React Native code and images" ===
      // Se lo script contiene riferimenti a sentry-xcode.sh o SENTRY_RN_PACKAGE_PATH,
      // ripristina il react-native-xcode.sh vanilla.
      if (
        name === "Bundle React Native code and images" &&
        (shellScript.includes("sentry-xcode.sh") ||
          shellScript.includes("SENTRY_RN_PACKAGE_PATH") ||
          shellScript.includes("@sentry/react-native"))
      ) {
        phase.shellScript = VANILLA_BUNDLE_SCRIPT;
        patchedBundle++;
        console.log(
          `[withDisableSentryXcode] ✅ Ripristinato script "Bundle React Native code and images" a versione vanilla`
        );
        continue;
      }

      // === STEP 4: cintura di sicurezza — aggiungi SENTRY_ALLOW_FAILURE=true
      // a QUALSIASI script che referenzia sentry, se non già presente ===
      if (
        (shellScript.includes("sentry-cli") ||
          shellScript.includes("SENTRY_")) &&
        !shellScript.includes("SENTRY_ALLOW_FAILURE")
      ) {
        const safetyPrefix =
          'export SENTRY_ALLOW_FAILURE=true\\nexport SENTRY_DISABLE_AUTO_UPLOAD=true\\n';
        // Rimuovi le virgolette esterne, prepend, ri-quota
        const stripped = shellScript.replace(/^"|"$/g, "");
        phase.shellScript = `"${safetyPrefix}${stripped}"`;
        envAdded++;
        console.log(
          `[withDisableSentryXcode] ✅ Aggiunta safety env "SENTRY_ALLOW_FAILURE=true" allo script "${name}"`
        );
      }
    }

    console.log(
      `[withDisableSentryXcode] Sommario: -${removedUpload} phase upload rimossa, ` +
        `${patchedBundle} bundle-script patchato, ${envAdded} env safety aggiunta`
    );

    return config;
  });
}

/**
 * Plugin composto.
 */
module.exports = function withDisableSentryXcode(config) {
  config = withDeleteSentryProperties(config);
  config = withPatchXcode(config);
  return config;
};
