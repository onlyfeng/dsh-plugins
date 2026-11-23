import { DatabaseSync } from 'node:sqlite'
import { chmodSync, closeSync, lstatSync, openSync } from 'node:fs'
import { dirname } from 'node:path'

/** SQLite derives new journal/WAL/SHM permissions from the main file. Secure it before sqlite3_open. */
export function openPrivateDatabase(filename, { readOnly = false } = {}) {
  if (filename !== ':memory:') {
    const folder = lstatSync(dirname(filename))
    const posix = process.platform !== 'win32'
    if (!folder.isDirectory() || (posix && (folder.uid !== process.getuid() || (folder.mode & 0o022)))) {
      throw new Error('Use an owner-controlled directory for Team Coop state')
    }
    if (!readOnly) {
      try {
        closeSync(openSync(filename, 'wx', 0o600))
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
      }
    }
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const path = filename + suffix
      try {
        const info = lstatSync(path)
        if (!info.isFile() || info.nlink !== 1 || (posix && info.uid !== process.getuid())) {
          throw new Error('Use a regular, singly linked Team Coop state file owned by this account')
        }
        if (posix && (info.mode & 0o7777) !== 0o600) chmodSync(path, 0o600)
      } catch (error) {
        // A connection can remove a journal when it closes.
        if (!suffix || error.code !== 'ENOENT') throw error
      }
    }
  }
  return new DatabaseSync(filename, { readOnly })
}
