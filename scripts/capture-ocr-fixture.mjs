// Replay a public native coverage projection through the OCR producer's real receipt writers.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRange, newPath, oldPath } from './ocr-fixture-range.mjs'

const [producerDirectory, outputDirectory, ...extra] = process.argv.slice(2)
if (!producerDirectory || !outputDirectory || extra.length) {
  throw new Error('Usage: node scripts/capture-ocr-fixture.mjs OCR_INTEGRATION_ROOT NEW_DIRECTORY')
}
const inputs = fileURLToPath(new URL('../packages/ocr-team/tests/fixtures/producer-rename-delete/inputs/', import.meta.url))
const producer = source => import(pathToFileURL(resolve(producerDirectory, source)).href)
const { createManifest } = await producer('src/core/runner.mjs')
const { normalizeResult } = await producer('src/core/result.mjs')
const { publishReview } = await producer('src/adapters/gitlab/publish.mjs')
const { runDirectory } = await producer('src/core/util.mjs')
const sampleDigest = label => createHash('sha256').update(`public-span-capture/v1/${label}`).digest('hex')
const findingThread = sampleDigest('discussion').slice(0, 40)
const fixtureDate = '2001-02-03T04:05:06.000Z'

function publicationTransport(headSha, expectedLine) {
  const notes = []
  return {
    notes,
    assertCurrent: async snapshot => snapshot.headSha === headSha,
    getCurrentUser: async () => ({ id: 3 }),
    listNotes: async () => structuredClone(notes),
    async createDiscussion(projectId, iid, body, position) {
      assert.deepEqual([projectId, iid, position.old_path, position.new_path, position.head_sha, position.new_line],
        [11, 2, oldPath, newPath, headSha, expectedLine])
      const note = { id: 21, author: { id: 3 }, body }
      notes.push(note)
      return { id: findingThread, notes: [note] }
    },
    async createNote(projectId, iid, body) {
      assert.deepEqual([projectId, iid], [11, 2])
      const note = { id: 22, author: { id: 3 }, body }
      notes.push(note)
      return note
    },
  }
}

const temporary = await mkdtemp(join(tmpdir(), 'public-span-'))
const destination = resolve(outputDirectory)
let ownsDestination = false
try {
  const snapshot = await createRange(join(temporary, 'source'))
  const projection = JSON.parse(await readFile(join(inputs, 'native-projection.json'), 'utf8'))
  assert.deepEqual([projection.manifest.input.resolved_base, projection.manifest.input.resolved_head], [snapshot.baseSha, snapshot.headSha])
  const config = { runtimeRoot: join(temporary, 'run'), execution: { timeoutSeconds: 480 },
    provider: { name: 'sample', model: 'sample', protocol: 'openai', baseUrl: 'https://model.example.test/v1', timeoutSeconds: 60 } }
  const project = { key: 'span', cloneUrl: snapshot.cloneUrl, checkout: { sparsePatterns: ['/src/'] },
    review: { ruleFile: join(inputs, 'rule.json'), backgroundFile: join(inputs, 'background.md'),
      effort: 'low', concurrency: 1, maxTokensBudget: 140000, taskTimeoutMinutes: 12 },
    publish: { mode: 'automatic', transport: 'direct', inline: true, stickySummary: false, requireComplete: true } }
  // These dependency values identify this test profile across runs on different installations.
  const manifest = await createManifest(config, project, snapshot, {
    inspectProvider: async () => ({ nativeConfigHash: sampleDigest('provider') }),
    inspectInstallation: async () => ({ version: '0.0.0-public-fixture', artifactSha256: sampleDigest('binary') }),
    implementationHash: async () => sampleDigest('implementation'),
  })
  const result = normalizeResult(projection, manifest)
  assert.deepEqual([result.status, result.warnings, result.findings.length], ['complete', [], 1])
  const client = publicationTransport(snapshot.headSha, result.findings[0].endLine)
  const receiptFile = join(runDirectory(config, manifest.runId), 'publication-receipt.json')
  await publishReview({ manifest, result, project, client, receiptFile })
  const receipt = JSON.parse(await readFile(receiptFile, 'utf8'))
  assert.deepEqual([receipt.status, client.notes.map(n => n.id)], ['published', [21, 22]])

  // The export uses a public fixture clock for the two wall-clock audit fields.
  const documents = { 'manifest.json': { ...manifest, createdAt: fixtureDate }, 'result.json': result,
    'publication-receipt.json': { ...receipt, updatedAt: fixtureDate } }
  await mkdir(destination)
  ownsDestination = true
  for (const [name, document] of Object.entries(documents)) {
    await writeFile(join(destination, name), JSON.stringify(document, null, 2) + '\n', { flag: 'wx' })
  }
  console.log(`Captured public range ${snapshot.headSha} as ${manifest.runId}`)
} catch (error) {
  if (ownsDestination) await rm(destination, { recursive: true, force: true })
  throw error
} finally {
  await rm(temporary, { recursive: true, force: true })
}
