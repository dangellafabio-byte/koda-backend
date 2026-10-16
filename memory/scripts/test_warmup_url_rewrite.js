#!/usr/bin/env node
/**
 * Test URL rewrite di `warmup HTTP` in voiceClientStt.ts.
 * Verifica che la nuova logica gestisca:
 *   - wss:// + /api/voice/stream → https:// + /api/voice/warmup
 *   - query ?token=... → strippata (fix 404)
 *   - fallback regex-based identico se URL() non è disponibile
 */
const assert = require("assert");

function buildHttpUrlPrimary(url) {
  const u = new URL(url);
  u.protocol = u.protocol === "wss:" ? "https:" : "http:";
  u.pathname = u.pathname.replace(/\/api\/voice\/stream$/, "/api/voice/warmup");
  u.search = "";
  return u.toString();
}

function buildHttpUrlFallback(url) {
  return url
    .replace(/^ws/, "http")
    .replace(/\?[^#]*$/, "")
    .replace(/\/api\/voice\/stream$/, "/api/voice/warmup");
}

const cases = [
  {
    name: "wss + path + token query → https warmup senza query",
    input: "wss://koda-backend.up.railway.app/api/voice/stream?token=abc123",
    expected: "https://koda-backend.up.railway.app/api/voice/warmup",
  },
  {
    name: "wss + path senza query",
    input: "wss://koda-backend.up.railway.app/api/voice/stream",
    expected: "https://koda-backend.up.railway.app/api/voice/warmup",
  },
  {
    name: "ws (preview) + path + token",
    input: "ws://localhost:8001/api/voice/stream?token=xyz",
    expected: "http://localhost:8001/api/voice/warmup",
  },
];

let fails = 0;
console.log("=== warmup URL rewrite ===");
for (const c of cases) {
  const primary = buildHttpUrlPrimary(c.input);
  const fallback = buildHttpUrlFallback(c.input);
  const okPrimary = primary === c.expected;
  const okFallback = fallback === c.expected;
  console.log(
    `  ${okPrimary && okFallback ? "✅" : "❌"} ${c.name}` +
    (okPrimary && okFallback
      ? ""
      : `\n     primary=${primary}\n     fallback=${fallback}\n     expected=${c.expected}`)
  );
  if (!okPrimary || !okFallback) fails++;
}

// Verifica anti-regression: che il vecchio bug sarebbe fallito
console.log("\n=== anti-regression: vecchia logica rotta ===");
function oldBuggyBuild(url) {
  return url
    .replace(/^ws/, "http")
    .replace(/\/api\/voice\/stream$/, "/api/voice/warmup");
}
const buggy = oldBuggyBuild("wss://host/api/voice/stream?token=abc");
const anti = buggy === "https://host/api/voice/stream?token=abc";
console.log(
  `  ${anti ? "✅" : "❌"} vecchia logica NON matcha → genera 404 (${buggy})`
);
if (!anti) fails++;

console.log("");
console.log(`RESULT: ${cases.length + 1 - fails}/${cases.length + 1} passed`);
process.exit(fails === 0 ? 0 : 1);
