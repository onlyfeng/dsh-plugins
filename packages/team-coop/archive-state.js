import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { backup } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { openPrivateDatabase } from './private-database.js'

async function checksum(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/** Take a consistent SQLite snapshot into a new private directory. The manifest marks completion. */
export async function archiveState(filename, directory) {
  const source = openPrivateDatabase(filename, { readOnly: true })
  try {
    if (!source.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='coop_events'").get()) {
      throw new Error('Expected a persistent Team Coop database')
    }
    await mkdir(directory, { mode: 0o700 })
    const target = join(directory, 'state.sqlite')
    // Precreate the target privately before SQLite begins copying live pages, including committed WAL data.
    openPrivateDatabase(target).close()
    await backup(source, target)
    const copy = openPrivateDatabase(target)
    try {
      copy.exec('PRAGMA journal_mode=DELETE')
      const rows = copy.prepare('PRAGMA integrity_check').all()
      if (rows.length !== 1 || rows[0].integrity_check !== 'ok') throw new Error('Archive integrity check failed')
    } finally {
      copy.close()
    }
    const digest = await checksum(target)
    await writeFile(join(directory, 'SHA256SUMS'), `${digest}  state.sqlite\n`, { flag: 'wx', mode: 0o600 })
    return digest
  } finally {
    source.close()
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [, , filename, directory, ...extra] = process.argv
  if (!filename || !directory || extra.length) {
    console.error('Usage: node archive-state.js STATE_FILE NEW_PRIVATE_ARCHIVE_DIRECTORY')
    process.exitCode = 1
  } else {
    try {
      console.log(await archiveState(resolve(filename), resolve(directory)))
    } catch (error) {
      console.error(`Archive failed: ${error.message}`)
      process.exitCode = 1
    }
  }
}
