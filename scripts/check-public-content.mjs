#!/usr/bin/env node
/**
 * Reject deployment-specific identifiers in the public repository.
 *
 * The check reports the file, line and rule id only. Matched text is never
 * printed, because this runs in a public pull request and Actions log.
 * It scans tracked files of the checked-out commit; the release fixtures use
 * reserved example hosts and synthetic identifiers, so they pass unchanged.
 * @module check-public-content
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

/** @type {[string, RegExp][]} */
const rules = [
  ['internal-host', /git\.gz4399\.(?:com|cn)/i],
  ['internal-host', /\bgz4399\.(?:com|cn)/i],
  ['internal-name', /\bai3a\b/i],
  ['internal-name', /\bLokiClient\b/i],
  ['operator-path', /[A-Za-z]:[\\/](?:Users|AI3A|qf|dev)[\\/]/],
  ['operator-path', /\bDSH-TeamCooperation\b/],
  ['terminal-handle', /\bterm_[0-9a-f]{8,}/i],
  ['message-handle', /\bmsg_[0-9a-f]{10,}/i],
  ['gitlab-token', /\bglpat-[A-Za-z0-9_-]{10,}/],
  ['github-token', /\bgithub_pat_[A-Za-z0-9_]{20,}/],
  ['github-token', /\bghp_[A-Za-z0-9]{20,}/],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['private-ip', /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/],
]

const binary = value => value.includes('\u0000')
const skip = new Set(['scripts/check-public-content.mjs'])
const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\u0000')
  .filter(Boolean)
  .filter(file => !skip.has(file))
const findings = []
for (const file of files) {
  let text
  try {
    text = readFileSync(join(root, file), 'utf8')
  } catch {
    continue
  }
  if (binary(text)) continue
  const lines = text.split(/\r?\n/)
  for (const [id, pattern] of rules) {
    for (let index = 0; index < lines.length; index++) {
      if (pattern.test(lines[index])) findings.push({ file, line: index + 1, id })
    }
  }
}

for (const finding of findings) process.stderr.write(`${finding.file}:${finding.line} [${finding.id}] matched text withheld\n`)
if (findings.length > 0) {
  process.stderr.write(`Found ${findings.length} deployment-specific identifier(s); replace them with synthetic example values.\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`Scanned ${files.length} tracked files; no deployment-specific identifiers found.\n`)
}
