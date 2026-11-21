// Run with the installed Desktop Electron runtime and ELECTRON_RUN_AS_NODE=1.
// External HTTP is mocked; execution uses the installed WebRuntime and web_search tool.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(join(process.env.DSH_INSTALL_DIR, 'package.json'))
async function installed(name) {
  const manifest = require.resolve(`${name}/package.json`)
  const pkg = require(manifest)
  return import(pathToFileURL(join(dirname(manifest), pkg.main ?? 'lib/index.js')).href)
}
const { Context } = await installed('@deepseek-ai/cordis')
const { WebRuntime } = await installed('@deepseek-ai/dsh-web')
const { applyWebSearchTool } = await installed('@deepseek-ai/dsh-tool-web')
const plugin = await import(pathToFileURL(resolve(process.argv[2] ?? 'packages/web-search-gateway/index.js')).href)
const ctx = new Context()
const selection = { value: 'gateway-messages' }
let web
const disposeWeb = ctx.effect(() => {
  web = new WebRuntime(ctx, { searchProvider: { get: () => selection.value }, fetchProvider: { get: () => undefined } })
})
const disposers = []
plugin.apply({
  get: () => ({ resolve: async () => ({ value: 'dummy' }) }),
  effect: fn => disposers.push(fn()), web,
}, plugin.Config({ baseURL: 'https://gateway.example.test/api/v1' }))
let tool
applyWebSearchTool({
  web,
  systemPrompt: { section() {}, getSectionOrder() { return 0 } },
  tools: { register(value) { tool = value } },
}, 10, 10, 800, 30000, true)
const originalFetch = globalThis.fetch
try {
  globalThis.fetch = async url => new Response(JSON.stringify(url.endsWith('/messages')
    ? { content: [{ type: 'web_search_tool_result' }, { type: 'text', text: 'Retrieved answer.' }] }
    : { output: [{ type: 'web_search_call', status: 'completed' }, { type: 'message', content: [
      { type: 'output_text', text: 'Retrieved answer.', annotations: [{ type: 'url_citation', url: 'https://example.test/page' }] },
    ] }] }))
  for (const provider of ['gateway-messages', 'gateway-responses']) {
    selection.value = provider
    for (const queries of [['one query'], ['one query', 'another query']]) {
      const output = await tool.execute({ queries }, { signal: new AbortController().signal })
      assert.equal(typeof output.truncated, 'boolean')
      assert.deepStrictEqual(JSON.parse(JSON.stringify(output)), output)
      console.log(`${provider}: ${queries.length} query/queries passed installed tool output checks`)
    }
  }
} finally {
  globalThis.fetch = originalFetch
  for (const dispose of disposers) dispose()
  assert.equal(web.listProviders().search.length, 0)
  await disposeWeb()
}
