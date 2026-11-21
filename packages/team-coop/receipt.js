import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { hashPacket, loadSite, readPacketFile, parsePacket } from './site.js'

/** Store proposed bytes exactly as supplied. A routed controller must acknowledge the hash separately. */
export async function stageReceipt(siteFile, peerId, packetFile) {
  const { peers } = await loadSite(resolve(siteFile))
  const peer = peers.get(peerId)
  if (peer?.role !== 'controller') throw new Error('Select a configured controller.')
  const bytes = await readPacketFile(resolve(packetFile))
  const packet = parsePacket(bytes, peerId)
  const ref = hashPacket(bytes)
  const destination = join(peer.receiptDir, `${ref}.json`)
  try {
    await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (error.code !== 'EEXIST' || !(await readFile(destination)).equals(bytes)) throw error
  }
  return { ref, phase: 'staged', acknowledgement: `TEAM-COOP ${packet.kind.toUpperCase()} ${ref}` }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2)
  if (args.length !== 3) {
    console.error('Usage: node receipt.js SITE PEER PACKET')
    process.exitCode = 1
  } else
    stageReceipt(...args)
      .then((value) => console.log(JSON.stringify(value)))
      .catch(() => {
        console.error('Could not stage this receipt. Check the controller, packet and private inbox.')
        process.exitCode = 1
      })
}
