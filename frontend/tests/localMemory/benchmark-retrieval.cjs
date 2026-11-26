const { performance } = require('node:perf_hooks');
const { recall } = require('./build/memoryRetrieval');

const facts = [
  { key: 'friend.teo', value: 'Teo è il mio amico dai tempi del liceo.', revision: 2, deleted: false },
  { key: 'friend.ufficiale', value: '', revision: 3, deleted: true },
  { key: 'home.city', value: 'Ora vivo a Torino, dopo il trasloco.', revision: 2, deleted: false },
  { key: 'pet.nina', value: 'Nina è una gatta.', revision: 1, deleted: false },
  { key: 'hobby.music', value: 'Suono la chitarra classica.', revision: 1, deleted: false },
  { key: 'friend.luca', value: 'Luca, il collega di Roma.', revision: 1, deleted: false },
  { key: 'family.luca', value: 'Luca, il cugino di Firenze.', revision: 1, deleted: false },
];
const cases = [
  ['Ti ricordi di Teo?', ['friend.teo']],
  ['L’amico che conosco dalle superiori', ['friend.teo']],
  ['Sai chi è Ufficiale?', []],
  ['Dove abito adesso?', ['home.city']],
  ['Parliamo di Torino', ['home.city']],
  ['Come si chiama la mia micia?', ['pet.nina']],
  ['Hai presente Nina?', ['pet.nina']],
  ['Che strumento suono?', ['hobby.music']],
  ['Come riprendo la chitarra?', ['hobby.music']],
  ['Come si chiama il collega di Roma?', ['friend.luca']],
  ['Ti ricordi Luca, il cugino?', ['family.luca']],
  ['Sono a pezzi, vorrei soltanto essere ascoltato.', []],
  ['Non parliamo di Teo oggi.', []],
  ['Oggi mi sento più tranquillo.', []],
  ['Sono fidanzato?', []],
];
let tp = 0, fp = 0, fn = 0;
const misses = [];
for (const [query, expected] of cases) {
  const actual = JSON.parse(recall(facts, query, {ephemeral: false})).map(item => item.key);
  const correct = actual.filter(key => expected.includes(key)).length;
  tp += correct;
  fp += actual.length - correct;
  fn += expected.length - correct;
  if (correct !== expected.length || correct !== actual.length) misses.push({query, expected, actual});
}
const timings = [];
const iterations = 5000;
for (let i = 0; i < iterations + 500; i++) {
  const [query] = cases[i % cases.length];
  const start = performance.now();
  recall(facts, query, {ephemeral: false});
  if (i >= 500) timings.push(performance.now() - start);
}
timings.sort((a, b) => a - b);
const percentile = q => Number(timings[Math.ceil(q * timings.length) - 1].toFixed(4));
console.log(JSON.stringify({
  engine: 'richiamo italiano con intenti e lessico; Node locale, nessun modello generativo',
  cases: cases.length, tp, fp, fn, precision: tp / (tp + fp), recall: tp / (tp + fn),
  iterations, p50Ms: percentile(0.5), p95Ms: percentile(0.95), misses,
}, null, 2));
