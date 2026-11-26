const assert=require('node:assert/strict');const {planImport}=require(process.argv[2]);
const c={key:'friend.teo',value:'amico',approved:true};
assert.equal(planImport([], [c]).length,1);
assert.equal(planImport([], [c,c]).length,1);
assert.equal(planImport([], [c,{...c,value:'fratello'}]).length,0);
assert.equal(planImport([], [{...c,approved:false}]).length,0);
assert.equal(planImport([{key:c.key,value:'collega',revision:2,deleted:false}],[c]).length,0);
assert.equal(planImport([{key:c.key,value:'',revision:2,deleted:true}],[c]).length,0);
assert.equal(planImport([], [c],true).length,0);
assert.equal(planImport([], [{...c,key:'INVALID'}]).length,0);
assert.equal(planImport([], [{...c,value:' '}]).length,0);
console.log('9 migration assertions passed');

(async () => {
  const { createHash } = require('node:crypto');
  const { prepareImportPreview } = require(process.argv[2]);
  const digest = async value => createHash('sha256').update(value).digest('hex');
  const initial = await prepareImportPreview([' Vivo a Milano ', 'vivo a  milano', 'x'.repeat(1001), {}], [], digest);
  assert.equal(initial.length, 1);
  assert.match(initial[0].key, /^legacy\.note\.[a-f0-9]{64}$/);
  assert.deepEqual(planImport([], initial), []);
  const [approved] = planImport([], [{...initial[0], approved: true}]);
  assert.equal(approved.value, 'Vivo a Milano');
  assert.deepEqual(await prepareImportPreview(['Vivo a Milano'], [
    {key: initial[0].key, value: '', deleted: true, revision: 2},
  ], digest), []);
  assert.deepEqual(await prepareImportPreview(['Milano'], [
    {key: 'home.city', value: 'Milano', deleted: false, revision: 1},
  ], digest), []);
  await assert.rejects(prepareImportPreview(['Milano'], [], async () => 'bad'));
  console.log('Anteprima locale: validazione, deduplicazione e rispetto dei ricordi cancellati verificati.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
