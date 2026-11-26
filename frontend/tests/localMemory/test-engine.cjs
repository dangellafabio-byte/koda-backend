const a=require('node:assert/strict'); const {chooseEngine,validateProposals}=require(process.argv[2]);
const yes={available:true,italian:true,onDevice:true,ready:true}; const no={...yes,ready:false};
a.equal(chooseEngine(yes,yes),'native'); a.equal(chooseEngine(no,yes),'downloaded'); a.equal(chooseEngine(no,no),'manual'); a.equal(chooseEngine({...yes,onDevice:false},no),'manual'); a.equal(chooseEngine({...yes,italian:false},no),'manual');
const p={key:'friend.teo',value:'amico',evidence:'Teo è un amico'}; a.deepEqual(validateProposals([p],p.evidence),[p]); a.deepEqual(validateProposals([p],'altro'),[]); a.deepEqual(validateProposals([p,p],p.evidence),[]); a.deepEqual(validateProposals([{...p,key:'bad key'}],p.evidence),[]); console.log('9 assertions passed');
