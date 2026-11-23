import { openPrivateDatabase } from './private-database.js'
import { contractText as text } from './contract-text.js'
import { createHash } from 'node:crypto'
import { isAbsolute, resolve, sep } from 'node:path'

const OPEN = "phase IN ('offered','active','returning')"
const keys = [
  'id',
  'workspace',
  'pack',
  'mode',
  'peer',
  'scopes',
  'goal',
  'inputs',
  'done',
  'ledger',
  'until',
]
const hash = (value) => createHash('sha256').update(value).digest('hex')
function check(ok, code) {
  if (!ok) throw Object.assign(new Error(code), { code })
}
function key(value) {
  check(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(value), 'INVALID_ID')
  return value
}
function scope(value) {
  text(value, 1024)
  const parts = value.split('/')
  check(
    value === value.normalize('NFKC') &&
      !/[\\:*?"<>|~\x00-\x1f\x7f]/u.test(value) &&
      parts.every(
        (p) =>
          p &&
          p !== '.' &&
          p !== '..' &&
          !/[. ]$/u.test(p) &&
          !/^(?:con|nul|aux|prn|com[1-9]|lpt[1-9]|conin\$|conout\$)(?:\.|$)/iu.test(p),
      ),
    'INVALID_SCOPE',
  )
  return value
}
const pathKey = (value) => value.replaceAll(sep, '/').normalize('NFKC').toUpperCase()
const contains = (a, b) => a === b || b.startsWith(a + '/')
const overlap = (a, b) => contains(a, b) || contains(b, a)
const scopeKeys = (lane) => lane.scopes.map((s) => pathKey(resolve(lane.workspace, s)))
function contract(root, input, now) {
  check(
    input &&
      typeof input === 'object' &&
      !Array.isArray(input) &&
      Object.keys(input).length === keys.length &&
      keys.every((k) => Object.hasOwn(input, k)),
    'INVALID_CONTRACT',
  )
  const value = Object.fromEntries(keys.map((k) => [k, input[k]]))
  for (const k of ['id', 'pack', 'peer']) key(value[k])
  for (const k of ['goal', 'inputs', 'done', 'ledger']) text(value[k])
  text(value.workspace, 4096)
  check(isAbsolute(value.workspace), 'INVALID_WORKSPACE')
  check(
    ['collaborate', 'takeover'].includes(value.mode) &&
      Array.isArray(value.scopes) &&
      value.scopes.length <= 32 &&
      (value.mode === 'collaborate' || value.scopes.length > 0),
    'INVALID_SCOPES',
  )
  value.scopes = Array.from(value.scopes, scope).sort()
  const paths = scopeKeys(value)
  check(!paths.some((a, i) => paths.slice(i + 1).some((b) => overlap(a, b))), 'INVALID_SCOPES')
  check(
    typeof value.until === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/u.test(value.until),
    'INVALID_EXPIRY',
  )
  const expiry = Date.parse(value.until)
  const expected = value.until.includes('.') ? value.until : value.until.replace('Z', '.000Z')
  check(
    Number.isFinite(expiry) && new Date(expiry).toISOString() === expected && expiry > now,
    'INVALID_EXPIRY',
  )
  return {
    ...value,
    root,
    digest: hash(JSON.stringify(['team-coop/v1', root, value])),
    phase: 'offered',
    rev: 1,
  }
}
function effective(lane) {
  return {
    ...lane,
    canWrite: lane.phase === 'active' && lane.scopes.length > 0 && Date.now() < Date.parse(lane.until),
  }
}
function checkReceipt(value, lane, kind) {
  check(
    value &&
      value.kind === kind &&
      value.actor === lane.peer &&
      value.lane === lane.id &&
      value.contract === lane.digest &&
      value.rev === lane.rev,
    'RECEIPT_MISMATCH',
  )
  return {
    kind,
    actor: value.actor,
    lane: lane.id,
    contract: lane.digest,
    rev: lane.rev,
    checkpoint: text(value.checkpoint),
    ...(value.evidence === undefined ? {} : { evidence: text(value.evidence, 1024) }),
  }
}
export function openStore(filename) {
  const db = openPrivateDatabase(filename)
  try {
    db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS coop_packs(root TEXT PRIMARY KEY,pack TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS coop_lanes(root TEXT NOT NULL,id TEXT NOT NULL,rev INTEGER NOT NULL,phase TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(root,id)) STRICT;
      CREATE TABLE IF NOT EXISTS coop_events(root TEXT NOT NULL,id TEXT NOT NULL,rev INTEGER NOT NULL,action TEXT NOT NULL,at TEXT NOT NULL,details TEXT NOT NULL,PRIMARY KEY(root,id,rev)) STRICT;
      CREATE INDEX IF NOT EXISTS coop_open_lanes ON coop_lanes(phase,root);`)
  } catch (error) {
    db.close()
    throw error
  }
  function txn(operation, mode = 'IMMEDIATE') {
    db.exec(`BEGIN ${mode}`)
    try {
      const result = operation()
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  function getPack(root) {
    return db.prepare('SELECT pack FROM coop_packs WHERE root=?').get(key(root))?.pack ?? 'general'
  }
  function use(root, pack) {
    key(root)
    key(pack)
    return txn(() => {
      if (getPack(root) === pack) return pack
      check(!db.prepare(`SELECT 1 FROM coop_lanes WHERE root=? AND ${OPEN} LIMIT 1`).get(root), 'OPEN_LANES')
      db.prepare('INSERT INTO coop_packs VALUES(?,?) ON CONFLICT(root) DO UPDATE SET pack=excluded.pack').run(
        root,
        pack,
      )
      return pack
    })
  }
  function clashes(lane) {
    const own = scopeKeys(lane)
    if (!own.length) return false
    return db
      .prepare(`SELECT data FROM coop_lanes WHERE ${OPEN} AND NOT (root=? AND id=?)`)
      .all(lane.root, lane.id)
      .some((row) =>
        scopeKeys(JSON.parse(row.data)).some((path) => own.some((other) => overlap(path, other))),
      )
  }
  function record(lane, action, details) {
    db.prepare('INSERT INTO coop_events VALUES(?,?,?,?,?,?)').run(
      lane.root,
      lane.id,
      lane.rev,
      action,
      new Date().toISOString(),
      JSON.stringify(details),
    )
  }
  function offer(root, input) {
    key(root)
    return txn(() => {
      const lane = contract(root, input, Date.now())
      check(lane.pack === getPack(root), 'PACK_MISMATCH')
      check(!db.prepare('SELECT 1 FROM coop_lanes WHERE root=? AND id=?').get(root, lane.id), 'LANE_EXISTS')
      check(
        db.prepare(`SELECT count(*) AS n FROM coop_lanes WHERE ${OPEN}`).get().n < 256 &&
          db.prepare(`SELECT count(*) AS n FROM coop_lanes WHERE root=? AND ${OPEN}`).get(root).n < 32,
        'LANE_LIMIT',
      )
      check(!clashes(lane), 'SCOPE_CONFLICT')
      db.prepare('INSERT INTO coop_lanes VALUES(?,?,?,?,?)').run(
        root,
        lane.id,
        lane.rev,
        lane.phase,
        JSON.stringify(lane),
      )
      record(lane, 'offer', lane)
      return effective(lane)
    })
  }
  function advance(root, id, revision, action, payload = {}) {
    key(root)
    key(id)
    check(Number.isSafeInteger(revision) && revision > 0, 'INVALID_REVISION')
    return txn(() => {
      const row = db.prepare('SELECT data FROM coop_lanes WHERE root=? AND id=?').get(root, id)
      check(row, 'MISSING_LANE')
      const lane = JSON.parse(row.data)
      check(lane.rev === revision, 'STALE_REVISION')
      let details = {}
      switch (action) {
        case 'accept': {
          check(lane.phase === 'offered' && lane.scopes.length > 0, 'INVALID_TRANSITION')
          check(Date.now() < Date.parse(lane.until), 'EXPIRED')
          const grant = checkReceipt(payload?.receipt, lane, 'grant')
          check(!clashes(lane), 'SCOPE_CONFLICT')
          lane.grantCheckpoint = grant.checkpoint
          lane.phase = 'active'
          details = grant
          break
        }
        case 'release': {
          check(lane.phase === 'active', 'INVALID_TRANSITION')
          lane.checkpoint = text(payload?.checkpoint)
          lane.checkpointDigest = hash(lane.checkpoint)
          lane.phase = 'returning'
          details = { checkpoint: lane.checkpoint, checkpointDigest: lane.checkpointDigest }
          break
        }
        case 'returned': {
          check(lane.phase === 'returning', 'INVALID_TRANSITION')
          details = checkReceipt(payload?.receipt, lane, 'returned')
          check(details.checkpoint === lane.checkpoint, 'CHECKPOINT_MISMATCH')
          lane.phase = 'closed'
          break
        }
        case 'cancel':
          check(lane.phase === 'offered', 'INVALID_TRANSITION')
          lane.phase = 'cancelled'
          break
        default:
          check(false, 'INVALID_TRANSITION')
      }
      lane.rev++
      const updated = db
        .prepare('UPDATE coop_lanes SET rev=?,phase=?,data=? WHERE root=? AND id=? AND rev=?')
        .run(lane.rev, lane.phase, JSON.stringify(lane), root, id, revision)
      check(updated.changes === 1, 'STALE_REVISION')
      record(lane, action, details)
      return effective(lane)
    })
  }
  function status(root) {
    key(root)
    return txn(
      () => ({
        pack: getPack(root),
        lanes: db
          .prepare(`SELECT data FROM coop_lanes WHERE root=? AND ${OPEN} ORDER BY id`)
          .all(root)
          .map((r) => effective(JSON.parse(r.data))),
      }),
      'DEFERRED',
    )
  }
  function leave(root) {
    key(root)
    return txn(() => {
      check(!db.prepare(`SELECT 1 FROM coop_lanes WHERE root=? AND ${OPEN} LIMIT 1`).get(root), 'OPEN_LANES')
      db.prepare('DELETE FROM coop_packs WHERE root=?').run(root)
      return 'general'
    })
  }
  return { getPack, use, status, offer, advance, leave, close: () => db.close() }
}
