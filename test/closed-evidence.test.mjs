import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture,host,policy } from './helpers.mjs';
import { encodeWorkspaceEvidence, openWorkspaceEvidence, readClosedEvidence } from '../governance/closed-evidence.mjs';
import { commitWorkspaceState, encodeLockedWorkspaceState, STATE_LIMIT, withWorkspaceLock } from '../governance/transactions.mjs';
import { digest } from '../governance/policy.mjs';
import { workspaceStateFile } from '../governance/session-mode.mjs';

const closed = (size, label) => ({owner:'root', phase:'closed', receiptHash:label,
  proof:{reviewerCoverage:{records:[{basis:label.repeat(size)}]},auditorCoverage:{records:[{basis:'independent'}]}}});
const encode=(home,file,state)=>encodeWorkspaceEvidence(home,file,state,STATE_LIMIT);
const open=(home,file,bytes)=>openWorkspaceEvidence(home,file,JSON.parse(bytes),STATE_LIMIT);

function commitIndex(home,file,state){
  return withWorkspaceLock(home,file,()=>{
    const target=path.join(home,file),old=fs.existsSync(target)?fs.readFileSync(target):null;
    const next=encodeLockedWorkspaceState(home,file,state);
    commitWorkspaceState(home,{file,old},next);return JSON.parse(next);
  });
}

test('reclose and reopen retain exactly the archives reachable from current state and its rolling backup',()=>fixture(root=>{
  const home=process.env.DSH_HOME,file=workspaceStateFile(root),dir=path.join(home,file+'.evidence');
  const target=path.join(home,file),state={spec:'building-loop-state/1',units:{A:closed(77000,'a'),fixed:closed(77000,'x')}};
  commitIndex(home,file,state);
  const foreignText=Buffer.from(JSON.stringify({spec:'another-format',workspace:file}));
  const foreign=digest(foreignText)+'.json';fs.writeFileSync(path.join(dir,foreign),foreignText);
  fs.writeFileSync(path.join(dir,'notes.txt'),'keep');
  // A valid-looking schema/name is not permission to remove a different
  // workspace's bytes, or a hard link to an otherwise genuine archive.
  const archiveText=workspace=>Buffer.from(JSON.stringify({spec:'building-loop-closed-evidence/1',workspace,unit:'A',evidence:{proof:'outside'}}));
  const alien=archiveText('other-workspace.json'),alienName=digest(alien)+'.json';fs.writeFileSync(path.join(dir,alienName),alien);
  const hard=archiveText(file),hardName=digest(hard)+'.json';fs.writeFileSync(path.join(dir,hardName),hard);
  fs.linkSync(path.join(dir,hardName),path.join(home,'hard-link-control'));
  const otherDir=path.join(home,'other-workspace.evidence');fs.mkdirSync(otherDir);fs.writeFileSync(path.join(otherDir,'notes.txt'),'other');
  const retainedPerStep=[];
  const check=()=>{
    const roots=[target,target+'.bak'].filter(name=>fs.existsSync(name)).map(name=>JSON.parse(fs.readFileSync(name)));
    const retained=new Set(roots.flatMap(index=>Object.values(index.units).filter(unit=>unit.closedEvidence).map(unit=>unit.closedEvidence.sha256+'.json')));
    assert.deepEqual(fs.readdirSync(dir).sort(),[...retained,foreign,alienName,hardName,'notes.txt'].sort());
    retainedPerStep.push(retained.size);
    for(const index of roots)for(const [id,unit] of Object.entries(index.units))if(unit.closedEvidence)
      assert.equal(readClosedEvidence(home,file,id,unit.closedEvidence,STATE_LIMIT).proof.reviewerCoverage.records[0].basis.length,77000);
  };
  for(const label of 'bcdef') {
    state.units.A=closed(77000,label);commitIndex(home,file,state);check();
    state.units.A.phase='ledger-review';commitIndex(home,file,state);check();
    state.units.A.phase='closed';commitIndex(home,file,state);check();
  }
  assert.equal(fs.readFileSync(path.join(otherDir,'notes.txt'),'utf8'),'other');
  assert.equal(fs.readFileSync(path.join(home,'hard-link-control'),'utf8'),hard.toString());
  console.log(JSON.stringify({archiveRetention:'reopen',revisions:5,verifiedCommits:retainedPerStep.length,retainedPerStep,unrelatedControlsPreserved:5}));
}));

test('repeated interrupted publications keep both authoritative roots, defer a live journal and refuse rival collection',()=>fixture(root=>{
  const home=process.env.DSH_HOME,file=workspaceStateFile(root),target=path.join(home,file),dir=target+'.evidence';
  const state={spec:'building-loop-state/1',units:{A:closed(70000,'a')}};
  const first=commitIndex(home,file,state).units.A.closedEvidence.sha256;
  state.units.A=closed(70000,'b');const second=commitIndex(home,file,state).units.A.closedEvidence.sha256;
  const before=fs.readFileSync(target),backup=fs.readFileSync(target+'.bak');
  const transactions=JSON.stringify(new URL('../governance/transactions.mjs',import.meta.url));
  const child=(body,...args)=>spawnSync(process.execPath,['--input-type=module','-e',[
    "import fs from 'node:fs'; import path from 'node:path';",
    "import {commitWorkspaceState,encodeLockedWorkspaceState,withWorkspaceLock} from "+transactions+";",
    "const [home,file,label]=process.argv.slice(1), target=path.join(home,file);",body
  ].join('\n'),home,file,...args],{encoding:'utf8',windowsHide:true});
  const crashBlobCounts=[];
  for(const label of 'cde'){
    const crash=child("withWorkspaceLock(home,file,()=>{const old=fs.readFileSync(target), state={spec:'building-loop-state/1',units:{A:{phase:'closed',proof:{value:label.repeat(70000)}}}};const next=encodeLockedWorkspaceState(home,file,state);process.exit(83);});",label);
    assert.equal(crash.status,83,crash.stderr);
    assert.deepEqual(fs.readFileSync(target),before);
    assert.deepEqual(fs.readFileSync(target+'.bak'),backup);
    const pinned=[target,target+'.bak'].map(f=>JSON.parse(fs.readFileSync(f)).units.A.closedEvidence.sha256);
    for(const sha of pinned)assert.ok(fs.existsSync(path.join(dir,sha+'.json')));
    assert.ok(fs.readdirSync(dir).length<=3);
    crashBlobCounts.push(fs.readdirSync(dir).length);
  }
  const evidenceFiles=()=>fs.readdirSync(dir).sort();
  const list=evidenceFiles();assert.ok(list.some(name=>name!==second+'.json'));
  fs.writeFileSync(target+'.ledger-txn','unsettled');
  const recovery="withWorkspaceLock(home,file,()=>{const data=JSON.parse(fs.readFileSync(target));encodeLockedWorkspaceState(home,file,data);});";
  assert.equal(child(recovery).status,0);assert.deepEqual(evidenceFiles(),list);
  fs.unlinkSync(target+'.ledger-txn');
  withWorkspaceLock(home,file,()=>{
    const busy=child("try{withWorkspaceLock(home,file,()=>process.exit(2));}catch(e){if(e.code==='BUILDING_LOOP_LOCK_BUSY')process.exit(17);throw e}");
    assert.equal(busy.status,17,busy.stderr);assert.deepEqual(evidenceFiles(),list);
  });
  const recovered=child(recovery);assert.equal(recovered.status,0,recovered.stderr);
  assert.deepEqual(evidenceFiles(),[first+'.json',second+'.json'].sort());
  assert.ok(JSON.parse(backup).units.A.closedEvidence.sha256===first);
  console.log(JSON.stringify({archiveRetention:'hard-exit',childExitCode:83,crashBlobCounts,
    recoveredReferencedBlobs:evidenceFiles().length,currentAndBackupUnchanged:true,unsettledJournalDeferred:true,liveWriterContenderExitCode:17}));
}));

test('an in-flight evidence reader finishes with its original exact bytes while two commits retire that revision',()=>fixture(async root=>{
  const home=process.env.DSH_HOME,file=workspaceStateFile(root),release=path.join(home,'continue-reader');
  const state={spec:'building-loop-state/1',units:{A:closed(75000,'a')}};
  const ref=commitIndex(home,file,state).units.A.closedEvidence;
  const script=[
    "import fs from 'node:fs';import path from 'node:path';",
    "import {readClosedEvidence} from "+JSON.stringify(new URL('../governance/closed-evidence.mjs',import.meta.url))+";",
    "const [home,file,release,raw]=process.argv.slice(1),ref=JSON.parse(raw),target=path.join(home,file+'.evidence',ref.sha256+'.json');",
    "let fd;const open=fs.openSync,read=fs.readSync;fs.openSync=(p,...args)=>{const h=open(p,...args);if(path.resolve(p)===target)fd=h;return h};",
    "fs.readSync=(h,...args)=>{if(h===fd){fd=undefined;fs.writeSync(1,'ready');const wait=new Int32Array(new SharedArrayBuffer(4));while(!fs.existsSync(release))Atomics.wait(wait,0,0,10)}return read(h,...args)};",
    "const value=readClosedEvidence(home,file,'A',ref,8388608);process.exit(value.proof.reviewerCoverage.records[0].basis==='a'.repeat(75000)?0:2);"
  ].join('\n');
  const reader=spawn(process.execPath,['--input-type=module','-e',script,home,file,release,JSON.stringify(ref)],
    {stdio:['ignore','pipe','pipe'],windowsHide:true,timeout:20000});
  const ended=once(reader,'exit');
  try{
    const [ready]=await once(reader.stdout,'data',{signal:AbortSignal.timeout(15000)});assert.equal(ready.toString(),'ready');
    for(const label of ['b','c']){state.units.A=closed(75000,label);commitIndex(home,file,state);}
  }finally{fs.writeFileSync(release,'ready');}
  const [code]=await ended;assert.equal(code,0);
  // Windows may defer unlink while a handle is open; the next publication
  // collects it after release without ever replacing the reader's bytes.
  state.units.A=closed(75000,'d');commitIndex(home,file,state);
  assert.equal(fs.readdirSync(path.join(home,file+'.evidence')).length,2);
  console.log(JSON.stringify({archiveRetention:'in-flight-reader',concurrentCommits:2,exactReadBytes:75000,readerExitCode:code,retainedAfterRelease:2}));
}));

test('three closed proofs over the combined hot limit remain addressable with exact contents',()=>fixture(root=>{
  const home=process.env.DSH_HOME,file=workspaceStateFile(root);
  const state={spec:'building-loop-state/1',units:{A:closed(3000000,'a'),B:closed(3000000,'b'),C:closed(3000000,'c'),
    running:{...closed(80000,'d'),phase:'first-review'}}};
  assert.ok(Buffer.byteLength(JSON.stringify(state))>STATE_LIMIT);
  const index=encode(home,file,state),raw=JSON.parse(index),loaded=open(home,file,index);
  assert.ok(index.length<100000);
  assert.deepEqual(raw.units.running,state.units.running);
  for(const k of ['A','B','C']){
    assert.equal(raw.units[k].proof,undefined);
    assert.deepEqual(readClosedEvidence(home,file,k,raw.units[k].closedEvidence,STATE_LIMIT).proof,state.units[k].proof);
    assert.deepEqual({...loaded.units[k]},state.units[k]);
  }
  assert.throws(()=>readClosedEvidence(home,file,'B',raw.units.A.closedEvidence,STATE_LIMIT),/归属/);
  assert.throws(()=>open(home,file,JSON.stringify({...raw,units:{A:{...raw.units.A,closedEvidence:{...raw.units.A.closedEvidence,sha256:'../oops'}}}})),/路径/);
  assert.equal(encode(home,file,loaded).compare(index),0);
  assert.equal(fs.readdirSync(path.join(home,file+'.evidence')).length,3);
  const reopen=open(home,file,index); reopen.units.A.phase='ledger-review';
  assert.deepEqual(JSON.parse(encode(home,file,reopen)).units.A.proof,state.units.A.proof);
  const changed=open(home,file,index);changed.units.B.proof.auditorCoverage.records[0].basis='new evidence';
  const edited=JSON.parse(encode(home,file,changed));
  assert.notEqual(edited.units.B.closedEvidence.sha256,raw.units.B.closedEvidence.sha256);
  const bad=path.join(home,file+'.evidence',raw.units.C.closedEvidence.sha256+'.json');
  fs.writeFileSync(bad,'corrupt');
  assert.throws(()=>open(home,file,index).units.C.proof,/摘要不符/);
  fs.unlinkSync(bad);
  assert.throws(()=>open(home,file,index).units.C.proof,/归档缺失/);
  assert.throws(()=>encode(home,file,{units:{running:{...closed(STATE_LIMIT,'x'),phase:'intake'}}}),/上限/);
}));

test('forced exit after sidecar publication preserves old host state and permits idempotent retry',()=>fixture(root=>{
  const home=process.env.DSH_HOME,file=workspaceStateFile(root),target=path.join(home,file);
  const original=Buffer.from(JSON.stringify({spec:'building-loop-state/1',units:{A:{...closed(88000,'p'),phase:'ledger-review'}}}));fs.writeFileSync(target,original);
  const child=spawnSync(process.execPath,['--input-type=module','-e',[
    "import fs from 'node:fs'; import path from 'node:path';",
    "import {encodeWorkspaceEvidence} from "+JSON.stringify(new URL('../governance/closed-evidence.mjs',import.meta.url))+";",
    "import {commitWorkspaceState,STATE_LIMIT} from "+JSON.stringify(new URL('../governance/transactions.mjs',import.meta.url))+";",
    "const [home,file]=process.argv.slice(1), target=path.join(home,file), old=fs.readFileSync(target), state=JSON.parse(old);state.units.A.phase='closed';",
    "const rename=fs.renameSync;fs.renameSync=(a,b)=>{if(path.resolve(b)===target)process.exit(83);rename(a,b)};",
    "commitWorkspaceState(home,{file,old},encodeWorkspaceEvidence(home,file,state,STATE_LIMIT));"
  ].join('\n'),home,file],{encoding:'utf8',windowsHide:true});
  assert.equal(child.status,83,child.stderr);
  assert.deepEqual(fs.readFileSync(target),original);
  const state=JSON.parse(original);state.units.A.phase='closed';
  const next=encode(home,file,state);commitWorkspaceState(home,{file,old:original},next);
  assert.deepEqual(fs.readFileSync(target+'.bak'),original);
  assert.deepEqual(open(home,file,fs.readFileSync(target)).units.A.proof,state.units.A.proof);
  assert.equal(fs.readdirSync(path.join(home,file+'.evidence')).length,1);
}));

test('production ledger closes on both full reviews and after a restart revalidates the archived proof',()=>fixture(async(root,write)=>{
  const config=structuredClone(policy),unit=config.units.K01;
  unit.claims=[];unit.calculations={};unit.phases['first-review'].evidence=[];
  write('BUILDING-LOOP.json',JSON.stringify(config));
  write('candidate.md',Array.from({length:24},(_,i)=>'# 阅读指引 '+(i+1)).join('\n'));
  const h=host(root,{automaticCoverage:false});
  const executor=(await h.flow('root','advance')).childId;
  await h.flow(executor,'prepare');await h.flow(executor,'submit');
  const review=async(actor)=>{
    const page=await h.flow(actor,'prepare');
    assert.equal(page.coverage.pendingCount,24);
    const items=page.coverage.blocks.map(b=>({block:b.id,parts:[{kind:'nonfactual',status:'supported',
      basis:'这一行是具体阅读顺序的标题，未作额外事实主张。'.repeat(18)}]}));
    await h.coverage(actor,'record',{entries:items.slice(0,12)});
    await h.coverage(actor,'record',{entries:items.slice(12)});
  };
  const reviewer=(await h.flow('root','advance')).childId;await review(reviewer);
  await h.assess(reviewer,{...Object.fromEntries(['sources','conclusion','method','alternatives','detail','plain']
    .map(k=>[k,'依据当前授权目标，检查各段内容与阅读顺序。'])),goalFit:{pass:true,basis:'本用例仅登记阅读顺序。'},sourceRefs:[],unverifiedSources:[],unlisted:[],revise:[]});
  await h.flow(reviewer,'review',{checks:[]});
  const auditor=(await h.flow('root','advance')).childId;await review(auditor);
  assert.equal((await h.flow(auditor,'audit')).phase,'ledger-review');
  await h.ledger('root','read');await h.file('root','read','overview.md');await h.file('root','read','first.json');
  const decisions=[{id:'unit-K01',outcome:'completed',basis:'当前阶段已经接受所有阅读指引。',evidence:{file:'first.json',start:1,end:1}}];
  assert.equal((await h.ledger('root','review',{decisions})).phase,'closed');
  const file=workspaceStateFile(root),home=path.join(process.env.DSH_HOME,'building-loop-state');
  const ref=JSON.parse(fs.readFileSync(path.join(home,file))).units.K01.closedEvidence;
  assert.ok(ref.fields.includes('proof'));
  const restarted=host(root,{automaticCoverage:false});
  assert.equal((await restarted.ledger('root','review',{decisions})).replayed,true);
  const data=path.join(home,file+'.evidence',ref.sha256+'.json');
  fs.writeFileSync(data,'corrupt');
  await assert.rejects(restarted.ledger('root','review',{decisions}),/证据归档/);
}));
