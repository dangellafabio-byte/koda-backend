const assert = require('node:assert/strict');
const { ConversationMemory } = require('./build/memoryConversation');
const { localItalianEngine } = require('./build/memoryLocalItalian');

async function main() {
  const facts = [
    {key: 'home.city', value: 'Milano', revision: 2, deleted: false},
    {key: 'pet.nina', value: 'Nina è una gatta', revision: 1, deleted: false},
    {key: 'friend.teo', value: 'Teo è un amico', revision: 1, deleted: false},
    {key: 'friend.luca', value: 'Luca collega di Roma', revision: 1, deleted: false},
    {key: 'family.luca', value: 'Luca cugino di Firenze', revision: 1, deleted: false},
  ];
  let reads = 0;
  const memory = new ConversationMemory({account: 'a', list: async () => { reads++; return facts; }}, localItalianEngine);
  const turn = {account: 'a', id: '1', mode: 'text', ephemeral: false, text: 'Ora abito a Torino.'};
  for (const mode of ['text', 'ptt', 'hands-free']) {
    assert.deepEqual(await memory.proposals({...turn, mode}), [
      {key: 'home.city', value: 'Torino', expectedRevision: 2, kind: 'set', confirmed: false},
    ]);
  }
  for (const text of ['Abito a Torino?', 'Forse vivo a Torino.', 'Non vivo a Torino.', 'Abito a Milano con Luca.', 'Abito a Torino per prova.']) {
    assert.deepEqual(await memory.proposals({...turn, text}), []);
  }
  for (const [text, key] of [['Dove abito?', 'home.city'], ['Come si chiama la mia micia?', 'pet.nina'], ['Ti ricordi Luca, il cugino?', 'family.luca']]) {
    assert.deepEqual(JSON.parse(await memory.context({...turn, text})).map(fact => fact.key), [key]);
  }
  assert.equal(await memory.context({...turn, text: 'Non parliamo di Teo oggi.'}), '[]');
  const before = reads;
  for (const scope of [{ephemeral: true}, {mode: 'vent'}, {account: 'b'}]) {
    assert.deepEqual(await memory.proposals({...turn, ...scope}), []);
    assert.equal(await memory.context({...turn, ...scope}), '[]');
  }
  assert.equal(reads, before);
  console.log('Motore italiano comune: estrazione, astensione, richiamo, omonimi e isolamento verificati.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
