import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, writeFile, rm, link, symlink, truncate } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createProjectRuntime } from '../runtime.js'
import { ocrHash, matchesSnapshot } from '../receipts.js'

const base = 'b'.repeat(40), head = 'a'.repeat(40), start = 'c'.repeat(40), targetTip = 'd'.repeat(40)
const project = {projectKey:'sample',instanceId:'fixture',gitlab:{host:'fixture.example.test',projectId:7,projectPath:'group/sample'}}
const cloneUrl='https://fixture.example.test/group/sample.git', webUrl='https://fixture.example.test/group/sample/-/merge_requests/8'
const snapshot={instanceId:'fixture',projectId:7,targetProjectId:7,sourceProjectId:11,iid:8,state:'opened',draft:false,sourceBranch:'topic',targetBranch:'release/demo',baseSha:base,startSha:start,headSha:head,targetTip,diffVersionId:12,cloneUrl,webUrl}
const plan={projectKey:'sample',snapshot}
const openMr={project_id:7,target_project_id:7,source_project_id:11,iid:8,web_url:webUrl,state:'opened',draft:false,target_branch:'release/demo',source_branch:'topic',sha:head,diff_refs:{base_sha:base,head_sha:head,start_sha:start},head_pipeline:{sha:head,status:'success'},author:{id:20},detailed_merge_status:'mergeable',blocking_discussions_resolved:true}
const version={id:12,head_commit_sha:head,base_commit_sha:base,start_commit_sha:start}
function api(modify=()=>{}) {
  const seen=[]
  const byPath={ 'projects/7':{id:7,path_with_namespace:'group/sample',http_url_to_repo:cloneUrl},'projects/7/merge_requests/8':openMr,'projects/7/merge_requests/8/versions?per_page=1':[version],'projects/7/repository/branches/release%2Fdemo':{name:'release/demo',commit:{id:targetTip}} }
  const get=async(host,path)=>{
    assert.equal(host,project.gitlab.host)
    assert.ok(Object.hasOwn(byPath,path))
    const value=structuredClone(byPath[path]);seen.push(path)
    modify(value,path,seen.filter(p=>p===path).length)
    return value
  }
  return {...createProjectRuntime(project,{get}),seen}
}
async function files(t){
  const parent=await realpath(await mkdtemp(join(tmpdir(),'ocr-runtime-')))
  t.after(()=>rm(parent,{recursive:true,force:true}))
  const reportsRoot=join(parent,'reports');await mkdir(reportsRoot)
  const path='src/demo.js', files=[{oldPath:path,newPath:path,newFile:false,renamedFile:false,deletedFile:false,tooLarge:false,collapsed:false,diff:'@@ -1 +1 @@\n-old\n+new'}]
  const {webUrl:unused,...identityFields}=snapshot
  const identity={projectKey:'sample',cloneUrl,snapshot:{...identityFields,diffComplete:true,filesHash:ocrHash(files)}}
  const runId=ocrHash(identity)
  const row={path,item_id:ocrHash(['review','range',path,path].join('\0')),fingerprint:ocrHash('synthetic file')}
  const manifest={schemaVersion:1,projectKey:'sample',runId,taskKey:runId,identity,snapshot:{...snapshot,diffComplete:true,files}}
  const result={schemaVersion:1,runId,taskKey:runId,status:'complete',warnings:[],findings:[],coverage:{reviewed:[row],selected:[row],failed:[],excluded:[],waived:[],unverified:[]}}
  const receipt={schemaVersion:1,taskKey:runId,status:'published',items:[{status:'confirmed',key:'summary',noteId:3}]}
  const run=join(reportsRoot,runId);await mkdir(run)
  for(const [file,value] of [['manifest.json',manifest],['result.json',result],['publication-receipt.json',receipt]]) await writeFile(join(run,file),JSON.stringify(value))
  return {...createProjectRuntime({...project,reportsRoot},{get:assert.fail}),parent,run,reportsRoot,runId}
}
test('loads a bounded local report set and validates project ownership',async t=>{
  const f=await files(t);assert.equal((await f.loadPlan(f.runId)).runId,f.runId)
  for(const value of ['../reports',null,'a'.repeat(63)])await assert.rejects(f.loadPlan(value))
  const other=createProjectRuntime({...project,projectKey:'other',reportsRoot:f.reportsRoot},{get:assert.fail});await assert.rejects(other.loadPlan(f.runId))
})
test('rejects linked report paths and oversized inputs',async t=>{
  const f=await files(t), foreign=join(f.parent,'foreign');await mkdir(foreign)
  const badId='2'.repeat(64);await symlink(foreign,join(f.reportsRoot,badId),process.platform==='win32'?'junction':'dir');await assert.rejects(f.loadPlan(badId))
  const inside=join(f.run,'result.json'), outside=join(foreign,'data');await writeFile(outside,'{}');await rm(inside);await link(outside,inside);await assert.rejects(f.loadPlan(f.runId))
  await rm(inside);await writeFile(inside,'');await truncate(inside,16*1024*1024+1);await assert.rejects(f.loadPlan(f.runId))
})
test('invalid plan identity prevents any request',async()=>{
  const r=api()
  for(const bad of [{...plan,projectKey:'other'}, ...[{iid:0},{targetProjectId:42},{projectId:42},{instanceId:'other'},{webUrl:webUrl+'?x'},{cloneUrl:cloneUrl.replace('sample','other')}].map(change=>({...plan,snapshot:{...snapshot,...change}}))]){
    assert.equal(r.belongs(bad),false);await assert.rejects(r.readCurrent(bad))
  }
  assert.equal(r.seen.length,0)
})
test('reads two matching versions of the MR and target branch',async()=>{
  const r=api(), current=await r.readCurrent(plan);assert.ok(matchesSnapshot(plan,current));assert.deepEqual(current.pipeline,{sha:head,status:'success'});assert.equal(current.authorId,20);assert.equal(current.discussionsResolved,true);assert.equal(current.mergeStatus,'mergeable');assert.equal(r.seen.length,7)
})
test('rejects a changed SHA, diff version, target tip or different project',async()=>{
  for(const modify of [(v,p)=>{if(p==='projects/7')v.id=20},(v,p)=>{if(p.endsWith('per_page=1'))v[0].base_commit_sha=head},(v,p,n)=>{if(p.endsWith('/8')&&n===2)v.sha=start},(v,p,n)=>{if(p.endsWith('per_page=1')&&n===2)v[0].id++},(v,p,n)=>{if(p.includes('/branches/')&&n===2)v.commit.id=start}])await assert.rejects(api(modify).readCurrent(plan))
})
test('cancelled operations preserve the caller reason',async()=>{
  const signal=AbortSignal.abort(new Error('fixture cancelled')),r=api();await assert.rejects(r.readCurrent(plan,signal),e=>e===signal.reason);await assert.rejects(r.loadPlan('a'.repeat(64),signal),e=>e===signal.reason);assert.equal(r.seen.length,0)
})
