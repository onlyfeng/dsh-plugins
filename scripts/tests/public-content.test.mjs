import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const scanner = fileURLToPath(new URL('../check-public-content.mjs', import.meta.url))
function fixture(t) {
  const owned = mkdtempSync(join(tmpdir(), 'publish-check-'))
  t.after(() => rmSync(owned, { recursive: true, force: true }))
  const root = join(owned, 'repo'), policy = join(owned, 'policy.json')
  mkdirSync(root)
  const git = (...args) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=builder@example.invalid', '-c', 'commit.gpgSign=false', ...args], { encoding: 'utf8' }).trim()
  git('init', '-q')
  const term = ['Site', 'Marker'].join('-')
  const allow = ['owner', 'public.sample'].join('@')
  writeFileSync(policy, JSON.stringify({ forbiddenTerms: [term], allowedEmails: [allow] }))
  const put = (path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), value); git('add', '--', path) }
  const commit = message => { git('commit', '-qm', message); return git('rev-parse', 'HEAD') }
  const scan = (...args) => {
    const result = spawnSync(process.execPath, [scanner, '--repo', root, ...args], { encoding: 'utf8' })
    assert.equal(result.error, undefined)
    return { code: result.status, output: result.stdout + result.stderr }
  }
  return { root, policy, git, term, allow, put, commit, scan }
}

test('includes the checker itself, staged content and path names without printing them', t => {
  const f = fixture(t)
  f.put('scripts/check-public-content.mjs', f.term.toUpperCase())
  f.put(`${f.term}.md`, 'sample')
  writeFileSync(join(f.root, 'scripts/check-public-content.mjs'), 'working copy differs from staged text')
  const result = f.scan('--policy', f.policy)
  assert.equal(result.code, 1); assert.match(result.output, /private-term/); assert.match(result.output, /name:1/)
  assert.ok(!result.output.toLowerCase().includes(f.term.toLowerCase()))
  assert.equal(f.scan().code, 0)
})

test('outgoing commit and patch checks include removed lines and intermediate revisions', t => {
  const f = fixture(t)
  f.put('README.md', f.term); const base = f.commit('baseline')
  f.put('README.md', 'safe text'); const fixed = f.commit('replace text')
  assert.equal(f.scan('--policy', f.policy, '--ref', fixed).code, 0)
  const compare = f.scan('--policy', f.policy, '--ref', fixed, '--base', base)
  assert.equal(compare.code, 1); assert.match(compare.output, /patch 1/); assert.ok(!compare.output.includes(f.term))
  f.put('README.md', 'revision'); const one = f.commit('review ' + f.term)
  f.put('README.md', 'end'); const last = f.commit('finish')
  assert.notEqual(one, last)
  assert.match(f.scan('--policy', f.policy, '--base', fixed, '--ref', last).output, /commit 1/)
})

test('external policy is required to parse and stays outside the source tree', t => {
  const f = fixture(t)
  f.put('public.txt', 'safe')
  for (const p of [join(f.root, 'public.txt'), join(f.root, 'absent.json')]) {
    const r = f.scan('--policy', p); assert.equal(r.code, 2); assert.ok(!r.output.includes(p))
  }
  writeFileSync(f.policy, '{bad'); assert.equal(f.scan('--policy', f.policy).code, 2)
  assert.equal(f.scan('--ref', '-h').code, 2)
})

test('filters ordinary mail with an exact allow list, preserves synthetic fixture mail', t => {
  const f = fixture(t)
  f.put('contact.txt', `${f.allow}\nemail: '${f.allow}'\nemail: "${f.allow}"\nsample@example.test`)
  assert.equal(f.scan('--policy', f.policy).code, 0)
  const other = ['contributor', 'public.sample'].join('@')
  f.put('contact.txt', `email: '${other}'`); const r = f.scan('--policy', f.policy)
  assert.equal(r.code, 1); assert.match(r.output, /email/); assert.ok(!r.output.includes(other))
  for (const prefix of ['path/', 'team!', 'alias+', 'tag=']) {
    f.put('contact.txt', prefix + f.allow)
    assert.equal(f.scan('--policy', f.policy).code, 1)
  }
})

test('generic rules catch credential shapes in UTF-16 text without disclosing the example', t => {
  const f = fixture(t), marker = ['gh', 'p_', 'a'.repeat(24)].join('')
  f.put('sample.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(marker, 'utf16le')]))
  const r = f.scan(); assert.equal(r.code, 1); assert.match(r.output, /github-token/); assert.ok(!r.output.includes(marker))
})

test('scans outgoing UTF-16 blobs even when the final tree and Git patch contain no text evidence', t => {
  const f = fixture(t)
  f.put('baseline', 'ok'); const start = f.commit('base')
  const file = 'temporary.txt', value = ['gh', 'p_', 'b'.repeat(25)].join('')
  f.put(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(value, 'utf16le')]))
  const intermediate = f.commit('intermediate')
  f.git('rm', '-q', file); const final = f.commit('removed')
  assert.equal(f.scan('--ref', final).code, 0)
  for (const base of [start, intermediate]) {
    const checked = f.scan('--ref', final, '--base', base)
    assert.equal(checked.code, 1); assert.match(checked.output, /github-token/); assert.ok(!checked.output.includes(value))
  }
})

test('the complete scanner source passes a maintainer policy without adding a self exemption', t => {
  const f = fixture(t)
  f.put('scripts/check-public-content.mjs', readFileSync(scanner))
  assert.equal(f.scan('--policy', f.policy).code, 0)
})
