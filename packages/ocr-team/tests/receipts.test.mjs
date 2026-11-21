import test from 'node:test'
import assert from 'node:assert/strict'
import { ocrHash, buildPlan, matchesSnapshot, assess } from '../receipts.js'

function fixture({path='src/demo.js', excluded=false}={}) {
  const makeFile = path => ({oldPath:path,newPath:path,newFile:false,deletedFile:false,renamedFile:false,diff:'@@ -1 +1 @@\n-old\n+new',tooLarge:false,collapsed:false})
  const files = [makeFile(path)]
  if(excluded) files.push({...makeFile('assets/icon.bin'),diff:''})
  const cloneUrl='https://forge.example.test/group/demo.git', webUrl='https://forge.example.test/group/demo/-/merge_requests/3'
  const refs={instanceId:'fixture',projectId:9,sourceProjectId:10,targetProjectId:9,iid:3,sourceBranch:'feature',targetBranch:'main',headSha:'a'.repeat(40),baseSha:'b'.repeat(40),startSha:'c'.repeat(40),targetTip:'d'.repeat(40),diffVersionId:4,cloneUrl,state:'opened',draft:false,diffComplete:true}
  const snapshot={...refs,files,webUrl},identity={projectKey:'fixture',cloneUrl,snapshot:{...refs,filesHash:ocrHash(files)}}
  const key=ocrHash(identity), itemId=f=>ocrHash(['review','range',f.oldPath,f.newPath].join('\0'))
  const row={item_id:itemId(files[0]),path,fingerprint:ocrHash('selected-file')}
  const finding={path,oldPath:path,side:'new',startLine:1,endLine:1,severity:'medium',body:'Synthetic finding'},fingerprint=ocrHash(finding)
  return {manifest:{schemaVersion:1,taskKey:key,runId:key,projectKey:'fixture',identity,snapshot},
    result:{schemaVersion:1,taskKey:key,runId:key,status:'complete',coverage:{selected:[{...row}],reviewed:[{...row}],excluded:excluded?[{item_id:itemId(files[1]),path:files[1].newPath,exclude_reason:'binary'}]:[],failed:[],waived:[],unverified:[]},warnings:[],findings:[{...finding,fingerprint}]},
    receipt:{schemaVersion:1,taskKey:key,status:'published',items:[{key:'summary',status:'confirmed',noteId:1},{key:ocrHash(`${ocrHash(key)}:${fingerprint}`),noteId:2,discussionId:'e'.repeat(40),status:'confirmed'}]}}
}
function approved(plan) {
  const {headSha}=plan.snapshot
  return {current:{...plan.snapshot,authorId:100,mergeStatus:'mergeable',discussionsResolved:true,pipeline:{sha:headSha,status:'success'}},evidence:{runId:plan.runId,snapshot:{...plan.snapshot},humanReview:{reviewer:'reviewer',reviewerId:200,headSha,decision:'approved'},validations:[{name:'fixture suite',headSha,status:'passed'}],findings:plan.findings.map(f=>({fingerprint:f.fingerprint,discussionId:f.discussionId,noteId:f.noteId,headSha,reviewer:'reviewer',reason:'Reviewed current implementation',disposition:'accepted'})),exclusions:plan.excluded.map(f=>({path:f.path,reviewed:true,headSha,reviewer:'reviewer',reason:'Reviewed asset'}))}}
}
test('joins each confirmed finding to its discussion',()=>{
  const docs=fixture(),p=buildPlan(docs);assert.equal(p.runId,docs.manifest.taskKey);assert.equal(p.findings[0].noteId,2);assert.equal(p.findings[0].fingerprint,docs.result.findings[0].fingerprint);assert.equal(p.findings[0].discussionId,'e'.repeat(40));assert.equal(p.summaryNoteId,1)
})
test('rejects mismatched identities, snapshot changes and finding edits',()=>{
  for(const change of [d=>{d.runId='0'.repeat(64)},d=>{d.result.runId='0'.repeat(64)},d=>{d.receipt.taskKey='0'.repeat(64)},d=>{d.receipt.runId='0'.repeat(64)},d=>{d.manifest.projectKey='different'},d=>{d.manifest.snapshot.startSha='0'.repeat(40)},d=>{d.manifest.snapshot.files[0].diff='changed'},d=>{d.manifest.snapshot.webUrl='https://other.example.test/x'},d=>{d.result.findings[0].body+=' changed'}]){const d=fixture();change(d);assert.throws(()=>buildPlan(d))}
})
test('rejects unsafe paths and incomplete coverage',()=>{
  for(const path of ['../other','/outside','x/../other','c:foo','a\\b','a//b','temp/CON.txt'])assert.throws(()=>buildPlan(fixture({path})))
  for(const change of [d=>{d.result.status='partial'},d=>{d.result.coverage.reviewed=[]},d=>{d.result.coverage.reviewed[0].fingerprint='0'.repeat(64)},d=>{d.result.coverage.selected[0].item_id='0'.repeat(64)},d=>{d.result.coverage.unverified=[{}]},d=>{d.result.coverage.waived=[{}]},d=>{d.result.coverage.failed=[{}]},d=>{d.result.coverage.excluded.push({...d.result.coverage.selected[0],exclude_reason:'binary'})}]){const d=fixture();change(d);assert.throws(()=>buildPlan(d))}
})
test('requires one confirmed publication per finding and a confirmed summary',()=>{
  for(const change of [d=>{d.receipt.status='unknown'},d=>{d.receipt.items.pop()},d=>{d.receipt.items.shift()},d=>{d.receipt.items[1].status='writing'},d=>{delete d.receipt.items[1].discussionId},d=>{d.receipt.items[1].key='1'.repeat(64)},d=>{d.receipt.items[1].noteId=1},d=>{d.receipt.items.push({...d.receipt.items[0]})},d=>{d.result.findings.push({...d.result.findings[0]})}]){const d=fixture();change(d);assert.throws(()=>buildPlan(d))}
  const d=fixture();d.result.findings=[];d.receipt.items.pop();assert.deepEqual(buildPlan(d).findings,[])
})
test('checks the current MR identity and requires an open non-draft',()=>{
  const p=buildPlan(fixture()),{current}=approved(p);assert.ok(matchesSnapshot(p,current))
  for(const k of ['instanceId','iid','projectId','sourceProjectId','targetProjectId','sourceBranch','targetBranch','baseSha','startSha','headSha','targetTip','diffVersionId'])assert.equal(matchesSnapshot(p,{...current,[k]:undefined}),false,k)
  assert.equal(matchesSnapshot(p,{...current,state:'merged'}),false);assert.equal(matchesSnapshot(p,{...current,draft:true}),false)
})
test('assessment requires version-matched independent evidence',()=>{
  const p=buildPlan(fixture());assert.equal(assess(p,null,null).readyForHumanMerge,false)
  for(const change of [(c,e)=>{e.runId='0'.repeat(64)},(c,e)=>{delete e.snapshot.sourceProjectId},(c,e)=>{e.humanReview.headSha='1'.repeat(40)},(c,e)=>{e.humanReview.reviewerId=c.authorId},(c,e)=>{e.validations=[]},(c,e)=>{e.validations[0].status='failed'},(c,e)=>{e.findings[0].noteId++},(c,e)=>{e.findings[0].reason=' '},c=>{c.pipeline.sha='1'.repeat(40)},c=>{c.discussionsResolved=false},c=>{c.mergeStatus='checking'}]){const {current,evidence}=approved(p);change(current,evidence);assert.equal(assess(p,current,evidence).readyForHumanMerge,false)}
  const {current,evidence}=approved(p);assert.deepEqual(assess(p,current,evidence),{status:'ready-for-human-merge',readyForHumanMerge:true,blockers:[]})
})
test('excluded paths need an explicit current review',()=>{
  const p=buildPlan(fixture({excluded:true})),{current,evidence}=approved(p);assert.ok(assess(p,current,evidence).readyForHumanMerge);evidence.exclusions[0].headSha='1'.repeat(40);assert.ok(assess(p,current,evidence).blockers.includes('excluded-file-review-required'))
})
