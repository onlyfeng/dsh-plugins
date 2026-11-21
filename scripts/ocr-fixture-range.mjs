import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const oldPath = 'src/extent.js'
export const newPath = 'src/span.js'
export const removedPath = 'src/retired-unit.js'

const source = `// The span of a finite sample is its maximum minus its minimum.
export function span(samples) {
  if (samples.length === 0) return 0
  let low = samples[0]
  let high = samples[0]
  for (const sample of samples) {
    low = Math.min(low, sample)
    high = Math.max(high, sample)
  }
  return high - low
}
`

/** Materialize the two public sample commits in a newly created directory. */
export async function createRange(directory) {
  await mkdir(directory)
  const emptyConfig = resolve(directory, '.git', 'fixture-empty-config')
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)))
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig, GIT_ATTR_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture Writer', GIT_COMMITTER_NAME: 'Fixture Writer',
    GIT_AUTHOR_EMAIL: 'writer@example.test', GIT_COMMITTER_EMAIL: 'writer@example.test',
    GIT_AUTHOR_DATE: '2001-02-03T04:05:06+00:00', GIT_COMMITTER_DATE: '2001-02-03T04:05:06+00:00',
    LC_ALL: 'C',
  })
  const git = (...args) => execFileSync('git', [
    '-c', 'core.autocrlf=false', '-c', `core.attributesFile=${emptyConfig}`, '-c', `core.hooksPath=${emptyConfig}`, ...args,
  ], { cwd: directory, env, encoding: 'utf8', windowsHide: true }).replace(/\r\n/g, '\n')

  git('init', '--quiet', '--template=', '--object-format=sha1', '-b', 'main')
  await mkdir(join(directory, 'src'))
  await writeFile(join(directory, oldPath), source)
  await writeFile(join(directory, removedPath), 'export const retiredUnit = "ticks"\n')
  git('add', '--', oldPath, removedPath)
  git('commit', '--quiet', '-m', 'Add the public span sample')
  const baseSha = git('rev-parse', 'HEAD').trim()

  git('switch', '--quiet', '-c', 'test/span')
  git('mv', '--', oldPath, newPath)
  git('rm', '--quiet', '--', removedPath)
  await writeFile(join(directory, newPath), source.replace('return high - low', 'return low - high'))
  git('add', '--', newPath)
  git('commit', '--quiet', '-m', 'Move the span calculation and remove the old unit')
  const headSha = git('rev-parse', 'HEAD').trim()
  const changes = git('diff', '--name-status', '--find-renames', baseSha, headSha).trim().split('\n')
  assert.equal(changes.length, 2)
  assert.ok(changes.some(row => row === `D\t${removedPath}`))
  assert.ok(changes.some(row => /^R\d+\t/.test(row) && row.endsWith(`\t${oldPath}\t${newPath}`)))

  function file(from, to, removed) {
    const diff = git('diff', '--no-color', '--no-ext-diff', '--no-textconv', '--full-index', '--find-renames',
      '--src-prefix=a/', '--dst-prefix=b/', '--unified=3', baseSha, headSha, '--', ...new Set([from, to]))
    return { oldPath: from, newPath: to, newFile: false, deletedFile: removed, renamedFile: from !== to,
      collapsed: false, tooLarge: false, diff }
  }
  return {
    instanceId: 'public-sample', projectId: 11, sourceProjectId: 11, targetProjectId: 11, iid: 2,
    sourceBranch: 'test/span', targetBranch: 'main', state: 'opened', draft: false,
    baseSha, startSha: baseSha, headSha, targetTip: baseSha, diffVersionId: 3,
    diffComplete: true, diffFileListComplete: true,
    cloneUrl: 'https://forge.example.test/demo/span.git', webUrl: 'https://forge.example.test/demo/span/-/merge_requests/2',
    files: [file(oldPath, newPath, false), file(removedPath, removedPath, true)],
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [directory, ...extra] = process.argv.slice(2)
  if (!directory || extra.length) throw new Error('Usage: node scripts/ocr-fixture-range.mjs NEW_DIRECTORY')
  const { baseSha, headSha } = await createRange(resolve(directory))
  console.log(JSON.stringify({ baseSha, headSha }))
}
