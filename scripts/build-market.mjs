#!/usr/bin/env node
/** Generate the DSH market from the published release ledger. `--check` performs no writes. */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { buildMarket, preserveReleases, releaseFile, repositoryReader } from './market-release-index.mjs'

const { values } = parseArgs({ options: { check: { type: 'boolean' }, base: { type: 'string' } } })
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const ledger = JSON.parse(readFileSync(join(root, releaseFile), 'utf8'))
const reader = repositoryReader(root)
if (values.base !== undefined) preserveReleases(reader.previous(values.base), ledger.releases)
const index = buildMarket(ledger, reader)
const serialized = `${JSON.stringify(index, undefined, 2)}\n`
const path = join(root, 'docs', 'market.json')

if (values.check) {
  if (readFileSync(path, 'utf8') !== serialized) {
    process.stderr.write('docs/market.json is stale. Run pnpm run market:build and commit the result.\n')
    process.exitCode = 1
  } else {
    process.stdout.write(`Verified ${index.plugins.length} market listings and ${ledger.releases.length} release pins.\n`)
  }
} else {
  writeFileSync(path, serialized, 'utf8')
  process.stdout.write(`Wrote ${index.plugins.length} market listings to docs/market.json.\n`)
}
