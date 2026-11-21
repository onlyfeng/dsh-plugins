import { execFileSync } from 'node:child_process'
import { parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index'

const repository = 'https://github.com/onlyfeng/dsh-plugins'
const indexUrl = 'https://onlyfeng.github.io/dsh-plugins/market.json'
export const releaseFile = 'scripts/market-releases.json'
const indexFile = 'docs/market.json'
const sha = /^[0-9a-f]{40}$/u
const packagePath = /^packages\/[a-z0-9][a-z0-9-]*$/u
const releaseId = (pin) => `${pin.name}@${pin.version}`

export function repositoryReader(cwd) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trimEnd()
  const jsonAt = (commit, file) => JSON.parse(git('show', `${commit}:${file}`))
  return {
    source(pin) {
      const { commit, path } = pin
      if (git('cat-file', '-t', commit) !== 'commit') throw new Error(`Expected a commit for ${releaseId(pin)}`)
      // The object must survive a fresh checkout of the published branch.
      git('merge-base', '--is-ancestor', commit, 'HEAD')
      return { manifest: jsonAt(commit, `${path}/package.json`), timestamp: Number(git('show', '-s', '--format=%ct', commit)) }
    },
    previous(base) {
      if (!sha.test(base)) throw new Error('--base expects a full commit SHA')
      if (/^0{40}$/u.test(base)) return [] // A branch creation event has no previous commit.
      if (git('ls-tree', '--name-only', base, '--', releaseFile)) return jsonAt(base, releaseFile).releases
      // On the migration PR the event base still uses the old market format.
      return jsonAt(base, indexFile).plugins.flatMap(({ name, versions }) => versions.map(({ version, source }) => {
        if (source.type !== 'git' || source.url !== repository) throw new Error(`Unexpected legacy source for ${name}`)
        return { name, version, path: source.path, commit: source.commit }
      }))
    },
  }
}

/** Every identity published at the event base must survive with the same directory and commit. */
export function preserveReleases(previous, current) {
  const proposed = new Map(current.map((pin) => [releaseId(pin), pin]))
  for (const before of previous) {
    const after = proposed.get(releaseId(before))
    if (!after || before.path !== after.path || before.commit !== after.commit) {
      throw new Error(`Cannot remove or change the source of published ${releaseId(before)}`)
    }
  }
}

export function buildMarket({ listings, releases }, reader) {
  const groups = new Map()
  const manifests = new Map()
  for (const pin of releases) {
    if (!packagePath.test(pin.path) || !sha.test(pin.commit)) throw new Error(`Invalid source pin for ${releaseId(pin)}`)
    const { manifest, timestamp } = reader.source(pin)
    if (manifest.name !== pin.name || manifest.version !== pin.version || manifest.repository?.directory !== pin.path) {
      throw new Error(`Name, version or directory differs from the pinned manifest for ${releaseId(pin)}`)
    }
    if (!manifest.dsh?.bundle?.patch || !manifest.engines?.dsh?.trim()) {
      throw new Error(`Missing DSH bundle patch or engines.dsh for ${releaseId(pin)}`)
    }
    const versions = groups.get(pin.name) ?? []
    versions.push({
      version: pin.version,
      publishTimestamp: timestamp,
      source: { type: 'git', url: repository, commit: pin.commit, path: pin.path },
      engines: { dsh: manifest.engines.dsh },
    })
    groups.set(pin.name, versions)
    manifests.set(releaseId(pin), manifest)
  }

  // Validate names, exact SemVer, duplicate versions and runtime ranges even for archived packages.
  // The DSH reader also sorts the versions by descending SemVer precedence.
  const format = {
    format: 1,
    title: { en: 'onlyfeng/dsh-plugins', zh: 'onlyfeng 的 DSH 插件集' },
    description: { en: 'Community DeepSeek Harness bundles by onlyfeng.', zh: 'onlyfeng 维护的 DeepSeek Harness 社区插件。' },
  }
  const history = parseMarketIndex({ ...format, plugins: Array.from(groups, ([name, versions]) => ({ name, versions })) }, indexUrl)
  const sorted = new Map(history.plugins.map((plugin) => [plugin.name, plugin.versions]))
  const plugins = Object.entries(listings).map(([name, listing]) => {
    const { title, 'dist-tags': tags } = listing
    if (!name.startsWith('@onlyfeng/') || !title?.en?.trim() || !title?.zh?.trim()) {
      throw new Error(`Expected a scoped package and English/Chinese titles for ${name}`)
    }
    if (!tags || !(tags.latest || tags.next)) throw new Error(`Select a latest or next version for ${name}`)
    for (const [channel, version] of Object.entries(tags)) {
      if (!['latest', 'next'].includes(channel) || !manifests.has(releaseId({ name, version }))) {
        throw new Error(`Unknown ${name} ${channel} release ${version}`)
      }
    }
    if (tags.latest?.split('+')[0].includes('-')) throw new Error(`The latest release of ${name} must be stable`)
    const manifest = manifests.get(releaseId({ name, version: tags.latest ?? tags.next }))
    const author = typeof manifest.author === 'string' ? manifest.author : manifest.author?.name
    if (author !== 'onlyfeng') throw new Error(`Expected the published author for ${name}`)
    return {
      name,
      title,
      description: manifest.description,
      author,
      ...(manifest.homepage !== undefined && { homepage: manifest.homepage }),
      repository: { url: repository, directory: manifest.repository.directory },
      metadata: { keywords: manifest.keywords ?? [] },
      'dist-tags': tags,
      versions: sorted.get(name),
    }
  })
  const index = { ...format, plugins }
  parseMarketIndex(index, indexUrl)
  return index
}
