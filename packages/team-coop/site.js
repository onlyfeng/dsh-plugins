import { createHash } from 'node:crypto'
import { contractText } from './contract-text.js'
import { verifyAcknowledgement } from './orca-peer.js'
import { normalizeBackends } from './backends.js'
import { constants } from 'node:fs'
import { lstat, open, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

const identifier = /^[a-z][a-z0-9-]{0,47}$/
const digest = /^[0-9a-f]{64}$/
const maximumSiteBytes = 128 * 1024
export const generalPack = Object.freeze({
  id: 'general',
  label: 'General',
  root: null,
  brief: 'Choose a coordinator, bounded implementation owners and independent reviewers to suit the request.',
  roles: ['Lead', 'Implementer', 'Independent reviewer', 'Operations observer', 'Improvement adviser'],
  gates: ['Identify the owner and the acceptance evidence for each slice.'],
})

function invalid(message) {
  throw new Error(`Team cooperation: ${message}`)
}
function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function text(value, max = 192) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/u.test(value))
    invalid('expected bounded single-line text')
  return value.trim()
}
function id(value) {
  if (typeof value !== 'string' || !identifier.test(value)) invalid('expected a lowercase registry ID')
  return value
}
function lines(value) {
  if (!Array.isArray(value) || value.length > 16) invalid('expected a list of at most 16 entries')
  return value.map((item) => text(item, 320))
}
function path(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || /[\x00-\x1f]/u.test(value))
    invalid('configure an absolute local path')
  return resolve(value)
}
async function directory(value) {
  const root = await realpath(path(value))
  if (!(await stat(root)).isDirectory()) invalid('configured directory is unavailable')
  return root
}

async function readBounded(file, limit, label) {
  const info = await lstat(file)
  if (
    !info.isFile() ||
    info.nlink !== 1 ||
    info.size === 0 ||
    info.size > limit ||
    relative(file, await realpath(file)) !== ''
  )
    invalid(`invalid ${label} file`)
  const fd = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0))
  try {
    const pinned = await fd.stat()
    if (
      !pinned.isFile() ||
      pinned.dev !== info.dev ||
      pinned.ino !== info.ino ||
      pinned.size !== info.size ||
      pinned.mtimeMs !== info.mtimeMs
    )
      invalid(`${label} changed while opening`)
    const bytes = Buffer.alloc(pinned.size)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await fd.read(bytes, offset, bytes.length - offset, offset)
      if (!bytesRead) invalid(`${label} was truncated`)
      offset += bytesRead
    }
    const end = await fd.stat()
    if (end.size !== pinned.size || end.ctimeMs !== pinned.ctimeMs) invalid(`${label} changed while reading`)
    return bytes
  } finally {
    await fd.close()
  }
}

/** Receipt references are hashes of the exact UTF-8 packet saved in the peer's trusted inbox. */
export function hashPacket(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export const readPacketFile = (file) => readBounded(file, 16 * 1024, 'receipt')
export function parsePacket(bytes, peerId) {
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  if (
    !object(value) ||
    value.actor !== peerId ||
    !['grant', 'returned'].includes(value.kind) ||
    typeof value.contract !== 'string' ||
    !digest.test(value.contract) ||
    !Number.isSafeInteger(value.rev) ||
    value.rev < 1
  )
    invalid('invalid controller receipt')
  text(value.lane)
  contractText(value.checkpoint)
  text(value.evidence, 1024)
  return value
}

export function staffingPolicy(settings = {}) {
  if (!object(settings)) invalid('invalid staffing policy')
  const int = (key, fallback) => {
    const value = settings[key] ?? fallback
    if (!Number.isSafeInteger(value) || value < 0 || value > 32)
      invalid('staffing limits must be integers in 0..32')
    return value
  }
  const tiers = {}
  if (settings.tiers !== undefined && !object(settings.tiers)) invalid('invalid route tiers')
  for (const [key, route] of Object.entries(settings.tiers ?? {})) {
    if (!['default', 'light', 'deep'].includes(key) || !object(route)) invalid('invalid route tier')
    tiers[key] = { provider: text(route.provider, 128), model: text(route.model, 160) }
    if (route.reasoning_effort !== undefined) tiers[key].reasoning_effort = text(route.reasoning_effort, 48)
  }
  const backends = normalizeBackends(settings.backends)
  const roleHosts = {}
  if (settings.roleHosts !== undefined && !object(settings.roleHosts)) invalid('invalid role host settings')
  for (const [role, host] of Object.entries(settings.roleHosts ?? {})) {
    if (
      !['worker', 'reviewer', 'validator', 'observer', 'assistant'].includes(role) ||
      !Object.hasOwn(backends, host)
    )
      invalid('role refers to an unknown host')
    roleHosts[role] = host
  }
  return {
    maxActive: int('maxActive', 4),
    maxAddPerTurn: int('maxAddPerTurn', 2),
    tiers,
    backends,
    roleHosts,
  }
}

export async function loadSite(siteFile, { verify = verifyAcknowledgement } = {}) {
  const settings = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(
      await readBounded(path(siteFile), maximumSiteBytes, 'site'),
    ),
  )
  if (
    !object(settings) ||
    settings.schema !== 1 ||
    !Array.isArray(settings.packs) ||
    !Array.isArray(settings.peers) ||
    settings.packs.length > 32 ||
    settings.peers.length > 64
  )
    invalid('invalid site registry')
  const statePath = path(settings.stateFile)
  if (
    !/^[\w.-]+\.(?:sqlite|sqlite3|db)$/iu.test(basename(settings.stateFile)) ||
    relative(statePath, path(siteFile)) === ''
  )
    invalid('choose a distinct local SQLite file')
  const stateFile = join(await directory(dirname(statePath)), basename(statePath))
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const candidate = stateFile + suffix
    const info = await lstat(candidate).catch((error) => {
      if (error.code !== 'ENOENT') throw error
    })
    if (info && (!info.isFile() || info.nlink !== 1 || relative(candidate, await realpath(candidate)) !== ''))
      invalid('invalid state file')
  }
  const staffing = staffingPolicy(settings.staffing)
  const packs = new Map([[generalPack.id, generalPack]])
  for (const input of settings.packs) {
    const key = id(input.id)
    if (packs.has(key)) invalid('duplicate project pack')
    packs.set(key, {
      id: key,
      label: text(input.label),
      root: await directory(input.root),
      brief: text(input.brief, 1200),
      roles: lines(input.roles),
      gates: lines(input.gates),
      ...(input.staffing
        ? {
            staffing: staffingPolicy({
              ...settings.staffing,
              ...input.staffing,
              roleHosts: { ...settings.staffing?.roleHosts, ...input.staffing.roleHosts },
              tiers: { ...settings.staffing?.tiers, ...input.staffing.tiers },
              backends: { ...settings.staffing?.backends, ...input.staffing.backends },
            }),
          }
        : {}),
    })
  }
  const peers = new Map()
  const inboxes = new Set()
  for (const input of settings.peers) {
    const key = id(input.id)
    if (peers.has(key) || !['controller', 'observer'].includes(input.role))
      invalid('duplicate peer or unknown role')
    const peer = { id: key, role: input.role, label: text(input.label) }
    if (input.route !== undefined) {
      if (!object(input.route)) invalid('invalid Orca route')
      peer.route = Object.fromEntries(
        ['tabId', 'leafId', 'session', 'workspace', 'agent'].map((field) => [
          field,
          text(input.route[field], 512),
        ]),
      )
    }
    if (input.role === 'controller') {
      peer.receiptDir = await directory(input.receiptDir)
      const canonical = process.platform === 'win32' ? peer.receiptDir.toLowerCase() : peer.receiptDir
      if (inboxes.has(canonical)) invalid('controllers must have separate receipt directories')
      inboxes.add(canonical)
    } else if (input.receiptDir !== undefined) invalid('only controllers have receipt directories')
    peers.set(key, peer)
  }
  async function receipt(peerId, ref) {
    const peer = peers.get(peerId)
    if (peer?.role !== 'controller' || typeof ref !== 'string' || !digest.test(ref))
      invalid('expected a controller and a SHA-256 receipt reference')
    if (relative(peer.receiptDir, await realpath(peer.receiptDir)) !== '') invalid('controller inbox moved')
    const bytes = await readPacketFile(join(peer.receiptDir, `${ref}.json`))
    if (hashPacket(bytes) !== ref) invalid('receipt bytes do not match the supplied reference')
    const value = parsePacket(bytes, peerId)
    if (peer.route) await verify(peer.route, value.kind, ref)
    return value
  }
  return { stateFile, packs, peers, receipt, staffing }
}
