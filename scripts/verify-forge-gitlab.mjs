// Use the Desktop Electron runtime with ELECTRON_RUN_AS_NODE=1.
// Default mode only exercises local registry calls. --live reads one chosen MR.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(join(process.env.DSH_INSTALL_DIR, 'package.json'))
async function installed(name) {
  const manifest = require.resolve(`${name}/package.json`)
  return import(pathToFileURL(join(dirname(manifest), require(manifest).main)).href)
}

const { Context } = await installed('@deepseek-ai/cordis')
const { ForgeService, changeRequestKey } = await installed('@deepseek-ai/dsh-experimental-forge')
const entry = resolve(process.env.FORGE_SMOKE_PACKAGE ?? 'packages/forge-gitlab', 'index.js')
const plugin = await import(pathToFileURL(entry).href)
const live = process.argv.includes('--live')
const target = live ? process.env.FORGE_SMOKE_MR_URL : 'https://forge.example.test/group/sub/project/-/merge_requests/7'
if (!target) throw new Error('Set FORGE_SMOKE_MR_URL to the MR you may read')
const host = new URL(target).host
const ctx = new Context()
try {
  await ctx.plugin(ForgeService)
  const fiber = ctx.plugin(plugin, { hosts: [host] })
  await fiber
  const ref = ctx.forge.changeRequestFromUrl(target)
  assert.ok(ref, 'configured host must recognize the MR')
  assert.equal(ctx.forge.changeRequestUrl(ref), target)
  assert.equal(plugin.changeRequestKey(ref), changeRequestKey(ref))
  const signal = AbortSignal.timeout(60000)
  if (live) {
    const state = await ctx.forge.readiness(ref.repository, signal)
    assert.equal(state.state, 'ready')
    const snapshot = await new Promise((resolve, reject) => {
      const stop = ctx.forge.watch(ref, update => {
        cleanup()
        if ('snapshot' in update) resolve(update.snapshot)
        else reject(new Error(`snapshot: ${update.failure?.code ?? 'unavailable'}`))
      })
      function cleanup() { signal.removeEventListener('abort', abort); stop() }
      function abort() { cleanup(); reject(signal.reason) }
      signal.addEventListener('abort', abort, { once: true })
    })
    assert.match(snapshot.headSha, /^[a-f0-9]{40,64}$/i)
    assert.equal(snapshot.mergeMethods.length, 0)
    const complete = await ctx.forge.fetchChecks(ref, signal)
    if ('code' in complete) throw new Error(`checks: ${complete.code}`)
    assert.equal(complete.headSha, snapshot.headSha)
    assert.equal(complete.checksTruncated, false)
    console.log(`Overview: +${snapshot.additions}/-${snapshot.deletions}; complete checks: ${complete.checks.length}`)
    const review = await ctx.forge.readReview(ref, snapshot.headSha, signal)
    if ('code' in review) throw new Error(`review: ${review.code}`)
    assert.equal(review.headSha, snapshot.headSha)
    assert.equal(review.viewerCanReview, false)
    const patch = await ctx.forge.diff(ref, snapshot.headSha, signal)
    if (typeof patch !== 'string') throw new Error(`diff: ${patch.code}`)
    const stale = await ctx.forge.readReview(ref, '0'.repeat(snapshot.headSha.length), signal)
    assert.equal(stale.code, 'stale')
    const currentFile = review.threads.find(thread => thread.current && thread.side === 'R')
    if (currentFile) {
      const file = await ctx.forge.fileText(ref, snapshot.headSha, currentFile.path, signal)
      if (typeof file !== 'string') throw new Error(`file text: ${file.code}`)
      console.log('Read text for one reviewed file at the selected head')
    }
    // Report aggregates only; the MR and its contents stay on this machine.
    console.log('Live GitLab GET passed: readiness, watched snapshot, head-checked reviews, stale detection and diff')
    console.log(`Inline threads: ${review.threads.length}; partial: ${review.truncated}; diff bytes: ${Buffer.byteLength(patch)}`)
  } else {
    const unsupported = await ctx.forge.writeReview(ref, { kind: 'reply', headSha: 'a'.repeat(40), thread: 'example', pending: false, body: 'fixture' }, signal)
    assert.equal(unsupported.code, 'unsupported')
  }
  await fiber.dispose()
  assert.equal(ctx.forge.changeRequestFromUrl(target), undefined)
  console.log('Desktop forge registry: package mount, key, URL recognition and unload passed')
} finally {
  await ctx.fiber.dispose()
}
