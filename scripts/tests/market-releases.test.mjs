import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildMarket, preserveReleases, releaseFile, repositoryReader } from '../market-release-index.mjs'

const name = '@onlyfeng/example'
const path = 'packages/example'
const stable = { name, version: '1.2.0', path, commit: 'a'.repeat(40) }
const candidate = { ...stable, version: '1.10.0-rc.1', commit: 'b'.repeat(40) }
const archived = { name: 'old-example', version: '0.1.0', path, commit: 'c'.repeat(40) }
const listing = { title: { en: 'Example', zh: '示例' }, 'dist-tags': { latest: stable.version, next: candidate.version } }
const ledger = { listings: { [name]: listing }, releases: [stable, candidate, archived] }

function manifest(pin) {
  return {
    name: pin.name,
    version: pin.version,
    description: `Published ${pin.version}`,
    author: 'onlyfeng',
    repository: { directory: pin.path },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    engines: { dsh: '>=0.2.0 <0.3.0' },
  }
}
const reader = { source: (pin) => ({ manifest: manifest(pin), timestamp: 1 }) }

test('channels select displayed release metadata while SemVer orders all installable versions', () => {
  const index = buildMarket(ledger, reader)
  assert.equal(index.plugins.length, 1)
  const [plugin] = index.plugins
  assert.deepEqual(plugin.versions.map((entry) => entry.version), [candidate.version, stable.version])
  assert.equal(plugin.description, 'Published 1.2.0')
  assert.equal(plugin.author, 'onlyfeng')
  assert.deepEqual(plugin.title, listing.title)
  assert.deepEqual(plugin['dist-tags'], listing['dist-tags'])
  assert.deepEqual(plugin.versions.map((entry) => entry.source.commit), [candidate.commit, stable.commit])
})

test('archive records are immutable after their card leaves the catalog', () => {
  const previous = [stable, archived]
  preserveReleases(previous, ledger.releases)
  for (const changed of [[], [{ ...archived, commit: candidate.commit }], [{ ...archived, path: 'packages/moved' }]]) {
    assert.throws(() => preserveReleases(previous, [stable, candidate, ...changed]), /old-example@0.1.0/)
  }
})

test('pinned manifest identity and channels are verified for active and archived packages', () => {
  for (const changes of [{ name: 'different-name' }, { version: '1.9.0' }, { repository: { directory: 'packages/other' } }, { engines: {} }, { dsh: {} }]) {
    const source = (pin) => ({ ...reader.source(pin), manifest: { ...manifest(pin), ...(pin === archived ? changes : {}) } })
    assert.throws(() => buildMarket(ledger, { source }), /old-example@0.1.0/)
  }
  assert.throws(() => buildMarket({ ...ledger, releases: [...ledger.releases, archived] }, reader), /duplicates/)
  assert.throws(() => buildMarket({ ...ledger, releases: [...ledger.releases, { ...archived, version: 'next' }] }, reader), /SemVer/)
  const channel = (tags) => buildMarket({ ...ledger, listings: { [name]: { ...listing, 'dist-tags': tags } } }, reader)
  assert.throws(() => channel({ latest: '1.2.1' }), /Unknown/)
  assert.throws(() => channel({ latest: candidate.version }), /stable/)
})

test('event bases support legacy and ledger history; later docs and tests preserve the source', (t) => {
  const root = mkdtempSync(fileURLToPath(new URL('./.market-fixture-', import.meta.url)))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', [
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=disabled-hooks', ...args,
  ], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const save = (file, contents) => writeFileSync(join(root, file), contents)
  const commit = (message) => {
    git('add', '.')
    git('commit', '-qm', message)
    return git('rev-parse', 'HEAD')
  }
  git('init', '-q')
  for (const dir of [path, 'docs', 'scripts']) mkdirSync(join(root, dir), { recursive: true })
  save(`${path}/package.json`, JSON.stringify(manifest(stable)))
  save(`${path}/cordis.patch.yml`, '[]\n')
  const source = { ...stable, commit: commit('versioned source') }
  const recorded = { listings: { [name]: { ...listing, 'dist-tags': { latest: stable.version } } }, releases: [source] }
  const repo = repositoryReader(root)
  const index = buildMarket(recorded, repo)
  save('docs/market.json', JSON.stringify(index))
  const legacy = commit('publish legacy catalog')
  save(releaseFile, JSON.stringify(recorded))
  const baseline = commit('record release for the first time')
  save(`${path}/README.md`, 'Updated guide\n')
  save(`${path}/regression.test.mjs`, 'export {}\n')
  commit('test and documentation changes')
  for (const base of [legacy, baseline]) {
    assert.deepEqual(repo.previous(base), [source])
    assert.throws(() => preserveReleases(repo.previous(base), [{ ...source, commit: baseline }]), /Cannot remove or change/)
  }
  assert.deepEqual(buildMarket(recorded, repo), index)
})
