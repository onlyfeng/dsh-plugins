import { createHash } from 'node:crypto'

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]))
  return value
}
export function ocrHash(value) { return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(canonical(value))).digest('hex') }
const text = value => typeof value === 'string' && !!value.trim()
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const sha = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)
const pos = n => Number.isSafeInteger(n) && n > 0
const record = x => !!x && typeof x === 'object' && !Array.isArray(x)
function need(ok, code) { if (!ok) throw Object.assign(new Error(code), {code}) }
function safePath(path) {
  return text(path) && !/[\x00-\x1f\x7f\\:"<>|?*]/.test(path) && path.split('/').every(s => s && s !== '.' && s !== '..' && !/[. ]$/.test(s) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s))
}
const snapKeys = ['instanceId','projectId','iid','sourceProjectId','targetProjectId','sourceBranch','targetBranch','baseSha','startSha','headSha','targetTip','diffVersionId']
function identity(s) {
  return record(s) && ['instanceId','sourceBranch','targetBranch'].every(k => text(s[k])) && ['projectId','iid','targetProjectId','sourceProjectId','diffVersionId'].every(k => pos(s[k])) && s.targetProjectId === s.projectId && ['baseSha','startSha','headSha','targetTip'].every(k => sha(s[k]))
}
function safeUrls(s) {
  let repo, mr
  try { repo=new URL(s.cloneUrl); mr=new URL(s.webUrl) } catch { return false }
  if (repo.protocol !== 'https:' || repo.username || repo.password || repo.search || repo.hash || mr.origin !== repo.origin || mr.username || mr.password || mr.search || mr.hash) return false
  const match=/^\/(.+)\.git$/.exec(repo.pathname)
  return match && match[1].split('/').length>=2 && match[1].split('/').every(s=>/^[\w-][\w.-]*$/.test(s)) && mr.pathname===`/${match[1]}/-/merge_requests/${s.iid}`
}
function mapCoverage(s,c) {
  need(s.diffComplete===true && Array.isArray(s.files) && s.files.length>0,'incomplete-diff')
  need(['selected','reviewed','excluded','failed','waived','unverified'].every(k=>Array.isArray(c?.[k])) && ['failed','waived','unverified'].every(k=>!c[k].length),'incomplete-coverage')
  const files=new Map(), selected=new Map(), reviewed=new Set(), excluded=new Map()
  for (const f of s.files) {
    need(safePath(f?.newPath)&&safePath(f.oldPath)&&typeof f.deletedFile==='boolean'&&f.tooLarge===false&&f.collapsed===false,'invalid-file')
    const p=f.deletedFile?f.oldPath:f.newPath
    need(!files.has(p),'duplicate-file'); files.set(p,f)
  }
  function checkRow(r) {
    const f=files.get(r?.path)
    need(f && safePath(r.path) && (r.old_path??'')===(f.oldPath!==f.newPath&&!f.deletedFile?f.oldPath:'') && r.item_id===ocrHash(['review','range',f.oldPath,f.deletedFile?'':f.newPath].join('\0')),'invalid-coverage-item')
    return f
  }
  for(const r of c.selected) {const f=checkRow(r);need(!f.deletedFile&&!selected.has(r.path)&&hex(r.fingerprint),'invalid-selected');selected.set(r.path,r)}
  for(const r of c.reviewed) {checkRow(r);need(selected.has(r.path)&&r.fingerprint===selected.get(r.path).fingerprint&&!reviewed.has(r.path),'invalid-reviewed'); reviewed.add(r.path)}
  const reasons=new Set(['user_exclude','unsupported_ext','default_path','secret_exclude','provider_directory','deleted','binary','too_large'])
  for(const r of c.excluded) {const f=checkRow(r);need(!excluded.has(r.path)&&!selected.has(r.path)&&reasons.has(r.exclude_reason)&&(r.exclude_reason!=='deleted'||f.deletedFile),'invalid-excluded');excluded.set(r.path,r.exclude_reason)}
  need(selected.size>0&&selected.size===reviewed.size&&reviewed.size+excluded.size===files.size,'incomplete-coverage')
  return {files,reviewed,excluded}
}
export function buildPlan({manifest,result,receipt,runId=manifest?.runId}) {
  const key=manifest?.taskKey, id=manifest?.identity, s=manifest?.snapshot
  need(hex(key)&&runId===key&&manifest.runId===key&&result?.taskKey===key&&result.runId===key&&receipt?.taskKey===key&&(receipt.runId===undefined||receipt.runId===key),'run-identity')
  need([manifest,result,receipt].every(v=>v.schemaVersion===1)&&record(id)&&record(s)&&text(manifest.projectKey)&&manifest.projectKey===id.projectKey&&ocrHash(id)===key,'manifest-identity')
  const {files,webUrl,...frozen}=s
  need(Array.isArray(files)&&record(id.snapshot)&&ocrHash({...frozen,filesHash:ocrHash(files)})===ocrHash(id.snapshot)&&id.cloneUrl===s.cloneUrl&&identity(s)&&safeUrls(s),'snapshot-identity')
  need(s.state==='opened'&&s.draft===false&&result.status==='complete'&&!result.availableDiffsReviewed&&Array.isArray(result.warnings)&&!result.warnings.length&&result.usage?.budget_exceeded!==true,'incomplete-result')
  const coverage=mapCoverage(s,result.coverage)
  need(receipt.status==='published'&&Array.isArray(receipt.items)&&Array.isArray(result.findings),'incomplete-publication')
  const entries=new Map(),notes=new Set(),threads=new Set()
  for(const item of receipt.items) {
    need(record(item)&&(item.key==='summary'||hex(item.key))&&!entries.has(item.key)&&item.status==='confirmed'&&pos(item.noteId)&&!notes.has(item.noteId),'invalid-publication-item')
    if(item.key!=='summary'){need(typeof item.discussionId==='string'&&/^[a-f0-9]{40}$/.test(item.discussionId)&&!threads.has(item.discussionId),'unconfirmed-discussion');threads.add(item.discussionId)}
    entries.set(item.key,item);notes.add(item.noteId)
  }
  const summary=entries.get('summary');need(summary,'missing-summary');entries.delete('summary')
  const findings=result.findings.map(f=>{
    need(record(f)&&safePath(f.path)&&coverage.reviewed.has(f.path)&&f.oldPath===coverage.files.get(f.path).oldPath&&['new','old'].includes(f.side)&&pos(f.startLine)&&pos(f.endLine)&&f.endLine>=f.startLine&&text(f.severity)&&text(f.body),'invalid-finding')
    const {path,oldPath,side,startLine,endLine,severity,body}=f
    const finding={path,oldPath,side,startLine,endLine,severity,body}
    need(hex(f.fingerprint)&&ocrHash(finding)===f.fingerprint,'finding-fingerprint')
    const itemKey=ocrHash(`${ocrHash(key)}:${f.fingerprint}`),item=entries.get(itemKey)
    need(item,'missing-finding-publication');entries.delete(itemKey)
    return {...finding,fingerprint:f.fingerprint,noteId:item.noteId,discussionId:item.discussionId}
  })
  need(!entries.size,'unmatched-publication')
  return {runId,taskKey:key,projectKey:manifest.projectKey,snapshot:{...Object.fromEntries(snapKeys.map(k=>[k,s[k]])),state:s.state,draft:s.draft,cloneUrl:s.cloneUrl,webUrl},findings,excluded:[...coverage.excluded].map(([path,reason])=>({path,reason})),summaryNoteId:summary.noteId}
}
export function matchesSnapshot(plan,current) {
  return identity(plan?.snapshot) && identity(current) && current.state==='opened' && current.draft===false && snapKeys.every(k=>plan.snapshot[k]===current[k])
}
/** Report the outstanding evidence for a human merge decision. */
export function assess(plan,current,evidence) {
  const blockers=[], snapshot=plan?.snapshot, head=snapshot?.headSha
  if (!matchesSnapshot(plan,current)) blockers.push('stale-or-missing-snapshot')
  if (!hex(plan?.runId)||!identity(snapshot)||plan?.taskKey!==plan.runId||!Array.isArray(plan?.findings)||!Array.isArray(plan?.excluded)) blockers.push('invalid-plan')
  if (!identity(evidence?.snapshot)||evidence.runId!==plan?.runId||!snapKeys.every(k=>snapshot&&evidence.snapshot[k]===snapshot[k])) blockers.push('evidence-snapshot-mismatch')
  if (!sha(head)||current?.pipeline?.status!=='success'||current.pipeline.sha!==head) blockers.push('head-pipeline-required')
  if (current?.mergeStatus!=='mergeable' || current?.discussionsResolved!==true) blockers.push('mergeability-or-discussions-unconfirmed')
  if(evidence?.humanReview?.decision!=='approved'||!text(evidence?.humanReview?.reviewer)||evidence.humanReview.headSha!==head||!pos(evidence.humanReview.reviewerId)||!pos(current?.authorId)||evidence.humanReview.reviewerId===current.authorId) blockers.push('independent-human-review-required')
  const tests=evidence?.validations
  if(!Array.isArray(tests)||!tests.length||!tests.every(t=>record(t)&&text(t.name)&&t.status==='passed'&&t.headSha===head)) blockers.push('validation-required')
  const resolved=evidence?.findings
  if(!Array.isArray(resolved)||!Array.isArray(plan?.findings)||resolved.length!==plan.findings.length||!plan.findings.every(f=>resolved.some(r=>r?.fingerprint===f.fingerprint&&r.noteId===f.noteId&&r.discussionId===f.discussionId&&r.headSha===head&&text(r.reviewer)&&text(r.reason)&&['fixed','accepted'].includes(r.disposition)))) blockers.push('finding-review-required')
  if(plan?.excluded?.length&&(!Array.isArray(evidence?.exclusions)||!plan.excluded.every(f=>evidence.exclusions.some(r=>r?.path===f.path&&r.headSha===head&&text(r.reviewer)&&text(r.reason)&&r.reviewed===true)))) blockers.push('excluded-file-review-required')
  return {status:blockers.length?'blocked':'ready-for-human-merge',readyForHumanMerge:!blockers.length,blockers}
}
