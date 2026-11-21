import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const { apply, Config } = await import(process.env.PLUGIN_TEST_ENTRY
  ? pathToFileURL(process.env.PLUGIN_TEST_ENTRY).href
  : '../index.js')

function mount(settings = {}) {
  const providers = new Map()
  const disposers = []
  const credentials = {
    resolve: async () => ({ value: 'test-key' }),
    describe: async () => ({ configured: true }),
  }
  apply({
    get: key => key === 'credentials' ? credentials : undefined,
    effect: fn => disposers.push(fn()),
    web: { registerSearchProvider(provider) {
      providers.set(provider.id, provider)
      return () => providers.delete(provider.id)
    } },
  }, Config(settings))
  return { providers, dispose: () => disposers.forEach(fn => fn()) }
}

const base = 'https://gateway.example.test/api/v1'
const payloads = {
  responses: { output: [
    { type: 'web_search_call', status: 'completed' },
    { type: 'message', content: [{ type: 'output_text', text: 'A summary.', annotations: [
      { type: 'url_citation', url: 'https://example.test/page', title: 'Page' },
    ] }] },
  ] },
  messages: { content: [
    { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://example.test/page', title: 'Page' }] },
    { type: 'text', text: 'A summary.' },
  ] },
  stripped: { content: [{ type: 'web_search_tool_result' }, { type: 'text', text: 'A summary without exposed sources.' }] },
}

for (const [protocol, payload] of [['responses', payloads.responses], ['messages', payloads.messages], ['messages', payloads.stripped]]) {
  test(`complete result for ${protocol} (${payload === payloads.stripped ? 'stripped sources' : 'sources'})`, async t => {
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(payload)))
    const { providers } = mount({ baseURL: base })
    const result = await providers.get(`gateway-${protocol}`).search({ query: 'test' })
    // A single query in dsh-tool-web projects this required field verbatim.
    const projected = { ...result, truncated: result.truncated }
    assert.equal(projected.truncated, false)
    assert.deepStrictEqual(JSON.parse(JSON.stringify(projected)), projected)
  })
}

test('environment base plus explicit version suffix preserves the gateway prefix', async t => {
  const variable = 'PLUGIN_TEST_GATEWAY_BASE'
  const previous = process.env[variable]
  t.after(() => { if (previous === undefined) delete process.env[variable]; else process.env[variable] = previous })
  process.env[variable] = 'https://gateway.example.test/api/'
  const { providers, dispose } = mount({ baseURLEnv: variable, baseURLPath: '/v1' })
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options })
    return new Response(JSON.stringify(url.endsWith('/responses') ? payloads.responses : payloads.messages))
  })
  await providers.get('gateway-responses').search({ query: 'test' })
  await providers.get('gateway-messages').search({ query: 'test' })
  assert.deepEqual(requests.map(x => x.url), [
    'https://gateway.example.test/api/v1/responses', 'https://gateway.example.test/api/v1/messages',
  ])
  assert.ok(requests.every(x => x.options.redirect === 'error'))
  process.env[variable] = 'https://gateway.example.test/other'
  await providers.get('gateway-responses').search({ query: 'test' })
  assert.equal(requests[2].url, 'https://gateway.example.test/other/v1/responses')
  delete process.env[variable]
  assert.equal(providers.get('gateway-responses').available(), false)
  await assert.rejects(providers.get('gateway-responses').search({ query: 'test' }), /unset or empty/)
  dispose()
  assert.equal(providers.size, 0)
})

test('rejects missing, conflicting and malformed base configuration', t => {
  assert.throws(() => mount(), /set baseURL or baseURLEnv/)
  assert.throws(() => mount({ baseURL: base, baseURLEnv: 'EXAMPLE' }), /not both/)
  assert.throws(() => mount({ baseURLEnv: 'PLUGIN_TEST_UNSET_VARIABLE' }), /unset or empty/)
  assert.throws(() => mount({ baseURL: 'file:///etc/test' }), /HTTP\(S\)/)
  assert.throws(() => mount({ baseURL: base + '?key=test' }), /without credentials/)
  assert.throws(() => mount({ baseURL: base, baseURLPath: '/v1?other' }), /absolute path/)
  // A malformed address names the field that carries it, rather than surfacing
  // the URL parser's bare "Invalid URL".
  assert.throws(() => mount({ baseURL: 'gateway.example.test/api' }), /web search: baseURL is not a valid absolute URL/)
  const variable = 'PLUGIN_TEST_BAD_BASE'
  const previous = process.env[variable]
  t.after(() => {
    if (previous === undefined) delete process.env[variable]
    else process.env[variable] = previous
  })
  process.env[variable] = 'gateway.example.test'
  assert.throws(() => mount({ baseURLEnv: variable }), /baseURLEnv \(PLUGIN_TEST_BAD_BASE\) is not a valid absolute URL/)
})

// A search the server tool ran but that matched nothing is a result, not a
// failure: `dsh-tool-web` renders an empty source list as "No results found."
for (const [protocol, payload] of [
  ['responses', { output: [
    { type: 'web_search_call', status: 'completed' },
    { type: 'message', content: [{ type: 'output_text', text: 'No results found.', annotations: [] }] },
  ] }],
  ['messages', { content: [
    { type: 'server_tool_use', name: 'web_search' },
    { type: 'web_search_tool_result', content: [] },
    { type: 'text', text: 'No results found.' },
  ] }],
]) {
  test(`${protocol} reports a zero-hit search as an empty source list`, async t => {
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(payload)))
    const { providers } = mount({ baseURL: base })
    const result = await providers.get(`gateway-${protocol}`).search({ query: 'zzz-no-such-thing' })
    assert.deepEqual(result.sources, [])
    assert.equal(result.truncated, false)
    assert.match(result.content, /No results/)
  })
}

// The protection that must survive the change above: a gateway answer carrying
// no evidence of a server-side search still fails, naming the configured model.
for (const [protocol, payload, model] of [
  ['responses', { output: [{ type: 'message', content: [{ type: 'output_text', text: '<tool_use>web_search</tool_use>' }] }] }, 'gpt-4.1'],
  ['messages', { content: [{ type: 'text', text: '<tool_use>web_search</tool_use>' }] }, 'claude-3-5-sonnet-latest'],
]) {
  test(`${protocol} fails when no server-side search ran`, async t => {
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(payload)))
    const { providers } = mount({ baseURL: base })
    await assert.rejects(
      providers.get(`gateway-${protocol}`).search({ query: 'test' }),
      error => error.message.includes('ran no server-side search') && error.message.includes(model),
    )
  })
}

for (const [label, protocol, payload, failure] of [
  ['tool error inside HTTP 200', 'messages', { content: [
    { type: 'server_tool_use', name: 'web_search' },
    { type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'too_many_requests' } },
  ] }, /too_many_requests/],
  ['tool invocation without result', 'messages', { content: [{ type: 'server_tool_use', name: 'web_search' }] }, /ran no server-side search/],
  ['failed tool call', 'responses', { output: [{ type: 'web_search_call', status: 'failed' }] }, /did not complete/],
  ['unfinished response', 'responses', { status: 'incomplete', output: [{ type: 'web_search_call', status: 'completed' }] }, /did not complete/],
  ['empty URL annotation alone', 'responses', { output: [{ type: 'message', content: [
    { type: 'output_text', annotations: [{ type: 'url_citation', url: '' }] },
  ] }] }, /ran no server-side search/],
]) {
  test(`${protocol} rejects ${label}`, async t => {
    t.mock.method(globalThis, 'fetch', async () => Response.json(payload))
    const { providers } = mount({ baseURL: base })
    await assert.rejects(providers.get(`gateway-${protocol}`).search({ query: 'test' }), failure)
  })
}

test('citation-only Responses gateway returns valid sources with string metadata', async t => {
  const data = { output: [{ type: 'message', content: [{ type: 'output_text', annotations: [
    { type: 'url_citation', url: 'https://example.test/page', title: null },
    { type: 'url_citation', url: 'invalid' },
  ] }] }] }
  t.mock.method(globalThis, 'fetch', async () => Response.json(data))
  const { providers } = mount({ baseURL: base })
  const result = await providers.get('gateway-responses').search({ query: 'test' })
  assert.deepEqual(result, { sources: [{ url: 'https://example.test/page' }], truncated: false })
})

test('credentialed requests never contact a redirect target', async t => {
  let targets = 0
  const server = createServer((req, res) => {
    if (req.url === '/target') { targets++; res.end('{}'); return }
    res.writeHead(307, { location: '/target' })
    res.end()
  })
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { providers } = mount({ baseURL: `http://127.0.0.1:${server.address().port}/api/v1` })
  for (const provider of providers.values()) await assert.rejects(provider.search({ query: 'test' }), /fetch failed/)
  assert.equal(targets, 0)
})
