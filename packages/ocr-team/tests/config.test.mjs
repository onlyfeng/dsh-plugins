import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { makeSelector } from '../config.js'

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ocr-team-config-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const project = async key => {
    const checkoutRoot = join(dir, key), reportsRoot = join(dir, key + '-reports')
    await Promise.all([mkdir(checkoutRoot), mkdir(reportsRoot)])
    return { projectKey: key, instanceId: 'fixture', checkoutRoot, reportsRoot,
      gitlab: { host: 'forge.example.test', projectId: 9001, projectPath: `group/${key}` } }
  }
  return { dir, a: await project('alpha'), b: await project('beta') }
}
const identity = value => value

test('each exact registered checkout gets its own stable adapter and report store', async t => {
  const { dir, a, b } = await fixture(t)
  b.gitlab.projectId = 9002
  const select = await makeSelector([a,b], identity, project => ({ project }))
  const [first, second] = await Promise.all([select(a.checkoutRoot), select(b.checkoutRoot)])
  assert.strictEqual(await select(a.checkoutRoot), first)
  assert.notEqual(first, second)
  assert.equal(first.project.projectKey, a.projectKey)
  assert.equal(second.project.gitlab.projectId, 9002)
  assert.equal(second.project.reportsRoot, b.reportsRoot)
  assert.equal(await select(dir), undefined)
  const subtree = join(a.checkoutRoot, 'subdir')
  await mkdir(subtree)
  assert.equal(await select(subtree), undefined)
  await assert.rejects(select(a.checkoutRoot, AbortSignal.abort()))
})

test('rejects ambiguous canonical roots and project keys', async t => {
  const { a, b, dir } = await fixture(t)
  await assert.rejects(makeSelector([a, {...b, projectKey:a.projectKey}], identity, identity), /unique/)
  const link = join(dir, 'linked-checkout')
  await symlink(a.checkoutRoot, link, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(makeSelector([a, {...b, checkoutRoot:link}], identity, identity), /unique/)
})

test('requires explicit usable roots and a GitLab repository identity', async t => {
  const { a, dir } = await fixture(t)
  for (const patch of [{checkoutRoot: 'relative'}, {reportsRoot: join(dir, 'missing')}, {projectKey:''}, {instanceId:' '},
    ...[{host:'https://forge.example.test/path'}, {host:'a@b.example.test'}, {host:'localhost:90000'}, {projectId:0}, {projectPath:'a/../b'}].map(gitlab => ({gitlab:{...a.gitlab,...gitlab}}))]) {
    await assert.rejects(makeSelector([{...a,...patch}], identity, identity))
  }
  const select = await makeSelector([], identity, identity)
  assert.equal(await select(a.checkoutRoot), undefined)
})
