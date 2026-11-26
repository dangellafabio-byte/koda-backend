const assert = require('node:assert/strict');
const {conversationEngine} = require(process.argv[2]);
const {localItalianEngine} = require('./build/memoryLocalItalian');

async function test() {
  const input = {utterance: 'Vivo a Milano.', context: []};
  const expected = await localItalianEngine.propose(input);
  assert.ok(expected.length);
  assert.deepEqual(await conversationEngine(localItalianEngine, null).propose(input), expected);
  let calls = 0;
  const capability = {available:true, italian:true, onDevice:true, ready:true};
  const bridge = {
    capabilities: async () => capability,
    propose: async utterance => {
      calls++;
      return JSON.stringify([{key:'hobby.canto', value:'canto', evidence:utterance}]);
    },
  };
  const engine = conversationEngine(localItalianEngine, bridge);
  assert.deepEqual(await engine.propose(input), expected);
  const other = {utterance:'Mi piace cantare nel coro.', context:[]};
  capability.available = false;
  assert.deepEqual(await engine.propose(other), []);
  assert.equal(calls, 0);
  capability.available = true;
  assert.equal((await engine.propose(other))[0].key, 'hobby.canto');
  assert.equal(calls, 1);
}
test().catch(error => {console.error(error); process.exitCode = 1;});
