import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, link, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { archiveState } from '../archive-state.js'
import { orcaEnvironment } from '../orca-peer.js'
import { openPrivateDatabase } from '../private-database.js'
import { openStore } from '../store.js'

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'coop-private-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('forwards only the platform settings needed by a local Orca process', () => {
  const parent = {
    Path: 'tools', HOME: 'home', TMPDIR: 'tmp', APPDATA: 'profile', ORCA_USER_DATA_PATH: 'orca',
    ORCA_TERMINAL_HANDLE: 'term_fixture', ORCA_ENVIRONMENT: 'remote', ORCA_REMOTE_PAIRING: 'fixture',
    ORCA_CLOUD_AUTH_TOKEN: 'fixture', ORCA_AGENT_TEAMS_TOKEN: 'fixture', NODE_OPTIONS: 'fixture',
    SSH_AUTH_SOCK: 'fixture', HTTPS_PROXY: 'fixture', DEEPSEEK_API_KEY: 'fixture', NEW_SECRET: 'fixture',
  }
  const common = { HOME: 'home', ORCA_USER_DATA_PATH: 'orca', ORCA_TERMINAL_HANDLE: 'term_fixture', ORCA_ENVIRONMENT: 'local' }
  assert.deepEqual({ ...orcaEnvironment(parent, 'win32') }, { ...common, Path: 'tools', APPDATA: 'profile' })
  assert.deepEqual({ ...orcaEnvironment({ ...parent, PATH: 'tools' }, 'linux') }, { ...common, PATH: 'tools', TMPDIR: 'tmp' })
})

test('the Orca check command invokes its two child processes with a private local environment', async (t) => {
  const dir = await fixture(t)
  const route = { id: 'peer', tabId: 'tab', leafId: 'leaf', agent: 'fixture', session: 'session', workspace: 'work' }
  const terminal = { tabId: 'tab', leafId: 'leaf', handle: 'term_fixture', connected: true, agentIdentity: 'fixture', worktreeId: 'work' }
  const worktree = { worktreeId: 'work', address: { worktree: 'work', environment: 'local' },
    agents: [{ paneKey: 'tab:leaf', orcaSessionId: 'session', agentType: 'fixture', hasLivePty: true }] }
  const routePath = join(dir, 'routes.json')
  await writeFile(routePath, JSON.stringify({ schema: 1, peers: [route] }))
  for (const [file, result] of [['terminal', { truncated: false, terminals: [terminal] }], ['worktree', { worktrees: [worktree] }]]) {
    await writeFile(join(dir, file), `if (process.env.NEW_SECRET || process.env.ORCA_ENVIRONMENT !== 'local') process.exit(1);\nconsole.log(${JSON.stringify(JSON.stringify({ result }))})`)
  }
  const entry = fileURLToPath(new URL('../orca-peer.js', import.meta.url))
  const { stdout } = await promisify(execFile)(process.execPath, [entry, 'check', routePath, 'peer'], {
    cwd: dir, env: { ...orcaEnvironment(), ORCA_CLI_COMMAND: process.execPath, NEW_SECRET: 'fixture', ORCA_ENVIRONMENT: 'remote' },
    timeout: 30_000,
  })
  assert.equal(JSON.parse(stdout).handle, 'term_fixture')
})

test('creates private files and tightens existing WAL and SHM before another connection reads', {
  skip: process.platform === 'win32' && 'requires POSIX file modes',
}, async (t) => {
  const dir = await fixture(t), file = join(dir, 'team.db')
  const first = openStore(file)
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      assert.equal((await stat(file + suffix)).mode & 0o777, 0o600)
      await chmod(file + suffix, 0o644)
    }
    openPrivateDatabase(file).close()
    for (const suffix of ['', '-wal', '-shm']) assert.equal((await stat(file + suffix)).mode & 0o777, 0o600)
  } finally {
    first.close()
  }
  await link(file, join(dir, 'alias.db'))
  assert.throws(() => openPrivateDatabase(file), /singly linked/)
})

test('archives all committed tables while the WAL writer is open and preserves the source history', async (t) => {
  const dir = await fixture(t), source = join(dir, 'team.db'), archive = join(dir, 'snapshot')
  const store = openStore(source)
  try {
    const book = openPrivateDatabase(source)
    try {
      book.exec("CREATE TABLE extra_receipts (id TEXT PRIMARY KEY); INSERT INTO extra_receipts VALUES ('uncertain')")
    } finally { book.close() }
    store.offer('root', { id: 'review', workspace: dir, pack: 'general', mode: 'collaborate', peer: 'peer',
      scopes: [], goal: 'Review', inputs: 'Fixture', done: 'Checked', ledger: 'test', until: new Date(Date.now() + 60000).toISOString() })
    store.advance('root', 'review', 1, 'cancel')
    const digest = await archiveState(source, archive)
    const file = join(archive, 'state.sqlite')
    assert.equal(digest, createHash('sha256').update(await readFile(file)).digest('hex'))
    assert.equal(await readFile(join(archive, 'SHA256SUMS'), 'utf8'), `${digest}  state.sqlite\n`)
    if (process.platform !== 'win32') {
      assert.equal((await stat(archive)).mode & 0o777, 0o700)
      assert.equal((await stat(file)).mode & 0o777, 0o600)
      assert.equal((await stat(join(archive, 'SHA256SUMS'))).mode & 0o777, 0o600)
    }
    for (const filename of [source, file]) {
      const read = openPrivateDatabase(filename, { readOnly: true })
      try {
        assert.deepEqual(read.prepare('SELECT action FROM coop_events ORDER BY rev').all().map(r => r.action), ['offer', 'cancel'])
        assert.equal(read.prepare('SELECT phase FROM coop_lanes').get().phase, 'cancelled')
        assert.equal(read.prepare('SELECT id FROM extra_receipts').get().id, 'uncertain')
      } finally { read.close() }
    }
    await assert.rejects(archiveState(source, archive), { code: 'EEXIST' })
    await assert.rejects(archiveState(join(dir, 'missing.db'), join(dir, 'uncreated')), { code: 'ENOENT' })
  } finally { store.close() }
})
