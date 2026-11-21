import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { buildPlan } from './receipts.js'

const fileLimit = 16 * 1024 * 1024
const runLimit = 32 * 1024 * 1024
const fullSha = s => typeof s === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(s)
const positive = n => Number.isSafeInteger(n) && n > 0
const invalidReport = 'The report set is invalid, incomplete or outside the configured directory.'
const invalidSnapshot = 'GitLab returned an inconsistent project or merge request snapshot.'
function check(ok, message) { if (!ok) throw new Error(message) }
const sameFile = (a,b) => a.dev === b.dev && a.ino === b.ino

async function pinDirectory(dir) {
  const info = await lstat(dir, { bigint:true })
  check(info.isDirectory() && relative(dir, await realpath(dir)) === '', invalidReport)
  return info
}
async function readReport(path, remaining, signal, checkDirs) {
  signal?.throwIfAborted()
  await checkDirs()
  const before = await lstat(path, { bigint:true })
  check(before.isFile() && before.nlink === 1n && before.size > 0n && before.size <= BigInt(Math.min(fileLimit,remaining)), invalidReport)
  check(relative(path, await realpath(path)) === '', invalidReport)
  const fd = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0))
  try {
    const opened = await fd.stat({ bigint:true })
    check(sameFile(before,opened) && before.size === opened.size && before.ctimeNs === opened.ctimeNs, invalidReport)
    await checkDirs()
    check(sameFile(await lstat(path, { bigint:true }), opened) && relative(path, await realpath(path)) === '', invalidReport)
    const bytes = Buffer.alloc(Number(opened.size))
    let offset = 0
    while (offset < bytes.length) {
      signal?.throwIfAborted()
      const { bytesRead } = await fd.read(bytes, offset, Math.min(65536,bytes.length-offset), offset)
      check(bytesRead > 0, invalidReport)
      offset += bytesRead
    }
    const end = await fd.stat({ bigint:true })
    check(end.size === opened.size && end.ctimeNs === opened.ctimeNs && end.nlink === 1n, invalidReport)
    return { value:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)), size:bytes.length }
  } finally { await fd.close() }
}
const envKeys = /^(?:PATH|PATHEXT|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|HOMEDRIVE|HOMEPATH|XDG_CONFIG_HOME|XDG_DATA_HOME|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|GLAB_CONFIG_DIR|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|LANG|LC_ALL)$/i
function readGitLab(host,endpoint,signal) {
  signal?.throwIfAborted()
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => envKeys.test(key)))
  Object.assign(env, { GLAB_PROMPT_DISABLED:'1', GIT_TERMINAL_PROMPT:'0', NO_COLOR:'1', GITLAB_API_HOST:host, GLAB_API_PROTOCOL:'https', GLAB_SKIP_TLS_VERIFY:'false' })
  const options = { shell:false, windowsHide:true, cwd:tmpdir(), env, signal, timeout:15000, killSignal:'SIGKILL', maxBuffer:4*1024*1024, encoding:'buffer' }
  return new Promise((resolve,reject) => {
    const child = execFile('glab',['api','--hostname',host,'--method','GET',endpoint],options,(error,output) => {
      if (signal?.aborted) return reject(signal.reason)
      if (error) return reject(new Error('GitLab CLI could not complete the read.'))
      try { resolve(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(output))) }
      catch { reject(new Error('GitLab returned unreadable JSON.')) }
    })
    child.stdin?.end()
  })
}
export function createProjectRuntime(project, { get=readGitLab }={}) {
  const { projectKey, instanceId, reportsRoot, gitlab:{host,projectId,projectPath} } = project
  const repoUrl = `https://${host}/${projectPath}`, cloneUrl = `${repoUrl}.git`, prefix = `projects/${projectId}`
  function belongs(plan) {
    const s = plan?.snapshot
    return !!s && plan.projectKey === projectKey && s.instanceId === instanceId && s.projectId === projectId && s.targetProjectId === projectId && positive(s.iid) && s.cloneUrl === cloneUrl && s.webUrl === `${repoUrl}/-/merge_requests/${s.iid}`
  }
  async function loadPlan(runId, signal) {
    signal?.throwIfAborted()
    check(typeof runId === 'string' && /^[a-f0-9]{64}$/.test(runId), invalidReport)
    const dir = join(reportsRoot,runId)
    try {
      const root = await pinDirectory(reportsRoot), folder = await pinDirectory(dir)
      const checkDirs = async () => check(sameFile(root,await pinDirectory(reportsRoot)) && sameFile(folder,await pinDirectory(dir)), invalidReport)
      const docs = {runId}
      let remaining = runLimit
      for (const [key,name] of [['manifest','manifest.json'],['result','result.json'],['receipt','publication-receipt.json']]) {
        const report = await readReport(join(dir,name),remaining,signal,checkDirs)
        docs[key] = report.value
        remaining -= report.size
        if (key === 'manifest') check(belongs(report.value), invalidReport)
      }
      await checkDirs()
      signal?.throwIfAborted()
      const plan = buildPlan(docs)
      check(belongs(plan), invalidReport)
      return plan
    } catch { signal?.throwIfAborted(); throw new Error(invalidReport) }
  }
  async function readCurrent(plan,signal) {
    signal?.throwIfAborted()
    check(belongs(plan),invalidSnapshot)
    const {iid,webUrl} = plan.snapshot, mrPath = `${prefix}/merge_requests/${iid}`
    async function read(endpoint) {
      signal?.throwIfAborted()
      const value = await get(host,endpoint,signal)
      signal?.throwIfAborted()
      return value
    }
    async function observe() {
      const mr = await read(mrPath), refs = mr?.diff_refs
      check(mr?.iid === iid && mr.project_id === projectId && mr.target_project_id === projectId && mr.web_url === webUrl && positive(mr.source_project_id),invalidSnapshot)
      check(fullSha(refs?.head_sha) && refs.head_sha === mr.sha && fullSha(refs.base_sha) && fullSha(refs.start_sha),invalidSnapshot)
      const branch = mr.target_branch
      check(typeof branch === 'string' && branch.length && !/[\x00-\x1f\x7f\\]/.test(branch) && branch.split('/').every(s=>s && s!=='.' && s!=='..'), invalidSnapshot)
      check(typeof mr.source_branch === 'string' && mr.source_branch && typeof (mr.draft??mr.work_in_progress) === 'boolean' && typeof mr.state === 'string', invalidSnapshot)
      const versions = await read(`${mrPath}/versions?per_page=1`)
      const v = Array.isArray(versions) && versions.length === 1 && versions[0]
      check(positive(v?.id) && v.head_commit_sha === refs.head_sha && v.base_commit_sha === refs.base_sha && v.start_commit_sha === refs.start_sha,invalidSnapshot)
      const target = await read(`${prefix}/repository/branches/${encodeURIComponent(branch)}`)
      check(target?.name === branch && fullSha(target.commit?.id),invalidSnapshot)
      return { instanceId, projectId, iid, sourceProjectId:mr.source_project_id, targetProjectId:mr.target_project_id,
        sourceBranch:mr.source_branch, targetBranch:branch, state:mr.state, draft:mr.draft??mr.work_in_progress, cloneUrl, webUrl,
        baseSha:refs.base_sha, startSha:refs.start_sha, headSha:refs.head_sha, diffVersionId:v.id, targetTip:target.commit.id,
        authorId:mr.author?.id??null, mergeStatus:mr.detailed_merge_status??null, discussionsResolved:mr.blocking_discussions_resolved??null,
        pipeline:mr.head_pipeline?{sha:mr.head_pipeline.sha??null,status:mr.head_pipeline.status??null}:null }
    }
    const actual = await read(prefix)
    check(actual?.id === projectId && actual.path_with_namespace === projectPath && actual.http_url_to_repo === cloneUrl,invalidSnapshot)
    const before = await observe(), after = await observe()
    check(JSON.stringify(before) === JSON.stringify(after), invalidSnapshot)
    return after
  }
  return Object.freeze({loadPlan,readCurrent,belongs})
}
