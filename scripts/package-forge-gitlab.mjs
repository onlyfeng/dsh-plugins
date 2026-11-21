// Generates a relocatable package directory for Desktop users. Run after pnpm install.
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../packages/forge-gitlab/', import.meta.url))
const manifestOf = dir => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
const manifest = manifestOf(source)
const output = resolve(process.argv[2] ?? `dist/forge-gitlab-${manifest.version}`)
if (existsSync(output)) throw new Error('Choose a new output directory for each package build')
mkdirSync(dirname(output), { recursive: true })
// Reserve an empty directory and write its install manifest last. This also
// works on Windows when a scanner holds a handle on a newly copied file.
mkdirSync(output)

// Materialize package-manager links as ordinary files. Redistribute the installed,
// locked JS packages together with their own licenses. Each dependency resolves
// its transitive imports relative to its own package, as in the maintainer tree.
function copyDependency(name, from, to) {
  const require = createRequire(join(from, 'package.json'))
  let dir = dirname(require.resolve(name))
  while (!existsSync(join(dir, 'package.json')) || manifestOf(dir).name !== name) {
    if (dir === dirname(dir)) throw new Error(`Missing installed manifest for ${name}`)
    dir = dirname(dir)
  }
  const target = join(to, 'node_modules', name)
  mkdirSync(target, { recursive: true })
  if (!existsSync(join(dir, 'LICENSE'))) throw new Error(`Verify redistribution notices for ${name}`)
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    if (lstatSync(join(dir, entry)).isSymbolicLink()) throw new Error(`Unexpected link in ${name}`)
    cpSync(join(dir, entry), join(target, entry), { recursive: true, dereference: true })
  }
  for (const dep of Object.keys(manifestOf(dir).dependencies ?? {})) copyDependency(dep, dir, target)
}

try {
  for (const entry of manifest.files) {
    const names = entry === '*.js' ? readdirSync(source).filter(name => name.endsWith('.js')) : [entry]
    for (const name of names) cpSync(join(source, name), join(output, name), { recursive: true })
  }
  for (const dep of Object.keys(manifest.dependencies)) copyDependency(dep, source, join(output, 'runtime'))
  const { dependencies, ...portable } = manifest
  writeFileSync(join(output, 'package.json'), JSON.stringify(portable, null, 2) + '\n')
} catch (error) {
  rmSync(output, { recursive: true, force: true })
  throw error
}
console.log(`${basename(output)} — portable package ${manifest.version}`)
