#!/usr/bin/env node
/** Scan the staged tree or a fixed Git revision without printing matched values or paths. */
import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const genericRules = [
  ['operator-path', /(?:\b[A-Za-z]:[\\/](?:Users|Documents and Settings|dev)[\\/]|\/(?:home|Users)\/[^\s/]+\/)/i],
  ['terminal-handle', /\bterm_[0-9a-f]{8,}/i],
  ['message-handle', /\bmsg_[0-9a-f]{10,}/i],
  ['gitlab-token', /\bglpat-[A-Za-z0-9_-]{10,}/],
  ['github-token', /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})/],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['private-ip', /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/],
]
const emptyPolicy = { forbiddenTerms: [], allowedEmails: null }
const sha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u
// Scan the complete dot-atom local part. Comparing a suffix would allow a different mailbox.
const atomChars = "\\p{L}\\p{N}!#$%&'*+/=?^_`{|}~-"
const emailPattern = new RegExp(`(?:"(?:[^"\\\\\\r\\n]|\\\\.)+"|[${atomChars}]+(?:\\.[${atomChars}]+)*)@(?:\\[[^\\]\\r\\n]+\\]|(?:[\\p{L}\\p{N}-]+\\.)+[\\p{L}][\\p{L}\\p{N}-]*)`, 'gu')
const exampleDomain = /(?:^|\.)(?:example\.(?:com|org|net)|example|test|invalid)$/i
const fold = text => text.normalize('NFKC').toLowerCase().replaceAll('\\', '/')
const emailKey = value => { const at = value.lastIndexOf('@'); return value.slice(0, at + 1) + value.slice(at + 1).toLowerCase() }
const fixedText = raw => typeof raw === 'string' && raw.length > 0 && raw.length <= 512 && raw === raw.trim() && !/[\x00-\x1f\x7f]/u.test(raw)

function inside(root, path) {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}

function loadPolicy(path, root) {
  if (path === undefined) return emptyPolicy
  if (!path) throw Error('missing policy')
  const external = realpathSync(path)
  if (inside(root, external) || inside(root, resolve(path)) || !lstatSync(external).isFile() || lstatSync(external).size > 256 * 1024) throw Error('invalid policy location')
  const policy = JSON.parse(readFileSync(external, 'utf8'))
  if (!policy || typeof policy !== 'object' || Object.keys(policy).some(key => !['forbiddenTerms', 'allowedEmails'].includes(key))) throw Error('invalid policy')
  if (!Array.isArray(policy.forbiddenTerms) || !policy.forbiddenTerms.length || policy.forbiddenTerms.length > 4096 || !policy.forbiddenTerms.every(fixedText)) throw Error('invalid private terms')
  if (!Array.isArray(policy.allowedEmails) || policy.allowedEmails.length > 256 || !policy.allowedEmails.every(value => fixedText(value) && [...value.matchAll(emailPattern)][0]?.[0] === value)) throw Error('invalid email policy')
  return { forbiddenTerms: [...new Set(policy.forbiddenTerms.map(fold))], allowedEmails: new Set(policy.allowedEmails.map(emailKey)) }
}

function checkLine(text, policy) {
  const match = genericRules.find(([, regex]) => regex.test(text))
  if (match) return match[0]
  if (policy.forbiddenTerms.length) {
    const folded = fold(text)
    if (policy.forbiddenTerms.some(term => folded.includes(term))) return 'private-term'
  }
  if (policy.allowedEmails && text.includes('@')) {
    for (const match of text.matchAll(emailPattern)) {
      let address = match[0]
      const delimiter = address[0]
      if ((delimiter === "'" || delimiter === '`') && text[match.index + address.length] === delimiter) address = address.slice(1)
      const key = emailKey(address)
      if (!exampleDomain.test(key.slice(key.lastIndexOf('@') + 1)) && !policy.allowedEmails.has(key)) return 'email'
    }
  }
}

function textOf(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le', { fatal: true }).decode(bytes)
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be', { fatal: true }).decode(bytes)
  if (bytes.includes(0)) return null
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

function main() {
  const { values } = parseArgs({ options: { repo: { type: 'string' }, ref: { type: 'string' }, base: { type: 'string' }, policy: { type: 'string' } } })
  const root = realpathSync(values.repo ?? dirname(dirname(fileURLToPath(import.meta.url))))
  const git = (...args) => execFileSync('git', ['-c', 'core.quotePath=false', '-C', root, ...args], { maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  if (realpathSync(git('rev-parse', '--show-toplevel').toString().trim()) !== root) throw Error('expected a repository root')
  if ((values.ref !== undefined && !sha.test(values.ref)) || (values.base !== undefined && (!values.ref || !sha.test(values.base)))) throw Error('expected full commit id')
  const policy = loadPolicy(values.policy, root)
  const listing = values.ref ? git('ls-tree', '-rz', '--full-tree', values.ref) : git('ls-files', '--stage', '-z')
  const entries = listing.toString('utf8').split('\0').filter(Boolean)
  const visited = new Set()
  let count = 0
  function scan(label, text) {
    if (text === null) return
    for (const [i, line] of text.split(/\r?\n/).entries()) {
      const id = checkLine(line, policy)
      if (id && ++count <= 30) process.stderr.write(`${label}:${i + 1} [${id}] (value withheld)\n`)
    }
  }
  function scanBlob(id, label) {
    if (visited.has(id)) return
    visited.add(id)
    scan(label, textOf(git('cat-file', 'blob', id)))
  }
  for (const [i, record] of entries.entries()) {
    const tab = record.indexOf('\t')
    const [mode, second, third] = record.slice(0, tab).split(' ')
    const id = values.ref ? third : second
    if (tab < 0 || !['100644', '100755', '120000'].includes(mode) || !sha.test(id) || (values.ref ? second !== 'blob' : third !== '0')) throw Error('unscannable entry')
    const label = `entry ${i + 1}`
    scan(label + ' name', record.slice(tab + 1))
    scanBlob(id, label)
  }
  if (values.base) {
    git('merge-base', '--is-ancestor', values.base, values.ref)
    const ids = git('rev-list', '--reverse', `${values.base}..${values.ref}`).toString().trim().split(/\s+/).filter(Boolean)
    for (const [i, id] of ids.entries()) {
      scan(`commit ${i + 1}`, git('show', '-s', '--format=%an <%ae>%n%cn <%ce>%n%B', id).toString('utf8'))
      // Git renders UTF-16 changes as binary in a textual patch. Inspect both blob IDs,
      // including the predecessor of a deletion, as well as the visible diff itself.
      const raw = git('diff-tree', '--root', '-m', '-r', '--raw', '-z', '--no-renames', '--no-abbrev', '--no-commit-id', id).toString('utf8').split('\0')
      for (let j = 0; j < raw.length - 1; j += 2) {
        const [oldMode, newMode, oldId, newId] = raw[j].slice(1).split(' ')
        scan(`patch ${i + 1} path`, raw[j + 1])
        for (const [mode, blob] of [[oldMode, oldId], [newMode, newId]]) {
          if (mode === '000000') continue
          if (!['100644', '100755', '120000'].includes(mode) || !sha.test(blob)) throw Error('unscannable historical entry')
          scanBlob(blob, `patch ${i + 1} blob`)
        }
      }
      const patch = git('show', '--root', '--diff-merges=first-parent', '--format=', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=3', id)
      scan(`patch ${i + 1}`, patch.toString('utf8').replace(/^[+\- ]/gm, ''))
    }
  }
  if (count) { process.stderr.write(`Publication check found ${count} matching lines.\n`); process.exitCode = 1 }
  else process.stdout.write(`Checked ${entries.length} tracked entries${values.base ? ' and outgoing commits' : ''} (${values.policy ? 'site' : 'generic'} policy).\n`)
}
try { main() } catch {
  // Paths, Git diagnostics, parser exceptions and CLI values can contain private content.
  process.stderr.write('Publication check could not inspect the requested Git objects or external policy.\n')
  process.exitCode = 2
}
