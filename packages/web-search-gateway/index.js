/**
 * Web search providers for `ctx.web` over an LLM gateway that exposes the
 * providers' own server-side search tools. Two independent providers are
 * registered so a profile can pin whichever protocol its gateway serves:
 *
 * - `<idPrefix>-responses` posts to an OpenAI **Responses** endpoint with the
 *   `web_search` server tool and reads `url_citation` annotations.
 * - `<idPrefix>-messages` posts to an **Anthropic Messages** endpoint with the
 *   `web_search_20250305` server tool and reads `web_search_tool_result` blocks.
 *
 * Both send exactly one auxiliary model request per search, so a search costs a
 * model turn's latency and tokens. Answer text and structured source URLs
 * remain separate in the result.
 */
import z from '@deepseek-ai/schemastery'

/** Stable Loader identity. */
export const name = 'web-search-gateway'

/** The web seam both providers register into. */
export const inject = ['web']

/** Search request guidance; the server tool, not this text, produces the sources. */
const RESPONSES_PROMPT = query => `Search the web and answer concisely with citations. Query: ${query}`

/** Anthropic's documented auxiliary instruction for native search. */
const MESSAGES_PROMPT = query => `Perform a web search for the query: ${query}`

/**
 * Deployment settings shared by both providers. Every endpoint, model, and
 * protocol detail is a Config field so a different gateway needs no code change.
 * There is no default `baseURL`: this plugin targets whatever OpenAI- or
 * Anthropic-compatible gateway the deployment already has, and a gateway
 * address is deployment-specific, never a safe default to ship.
 */
export const Config = z.object({
  /**
   * Gateway base including the version path; the operation name is appended.
   * Mutually exclusive with `baseURLEnv`; exactly one of the two is required,
   * checked at load.
   */
  baseURL: z.string().default(''),
  /**
   * Name of an environment variable holding the gateway base, read at search
   * time so a profile can share one base across multiple plugins without
   * repeating it, or vary it per launch without editing `cordis.patch.yml`.
   * Mutually exclusive with `baseURL`; exactly one of the two is required,
   * checked at load.
   */
  baseURLEnv: z.string().default(''),
  /** Path appended to either base source, for example `/v1` when the environment ends at `/api`. */
  baseURLPath: z.string().default(''),
  /** Credential reference holding the gateway key. */
  apiKeyEnv: z.string().default('DEEPSEEK_API_KEY'),
  /** Model asked to run the search on the OpenAI Responses route. */
  responsesModel: z.string().default('gpt-4.1'),
  /** Model asked to run the search on the Anthropic Messages route. */
  messagesModel: z.string().default('claude-3-5-sonnet-latest'),
  /** Provider ids registered by this plugin; a profile pins one of them. */
  idPrefix: z.string().default('gateway'),
  /** Responses server-tool type: `web_search` (current) or `web_search_preview` (older gateways). */
  responsesToolType: z.string().default('web_search'),
  /** Responses `tool_choice`; some gateways reject `required`, so it is configurable. */
  responsesToolChoice: z.string().default('required'),
  /**
   * Anthropic `thinking` mode for the search request. The choice is per model, not
   * per chat route: `omit` sends no `thinking` field, `enabled` sends
   * `{type:'enabled', budget_tokens}` (for models that refuse to run without
   * thinking), `disabled` sends `{type:'disabled'}`, and any other value is sent
   * verbatim as `{type:<value>}` (gateway extensions such as `between_tools`).
   * Which value a given model and gateway accept is not standardized; test and
   * record the working value for your deployment.
   */
  messagesThinking: z.string().default('omit'),
  /** `budget_tokens` used when `messagesThinking` is `enabled`. */
  messagesThinkingBudgetTokens: z.number().step(1).min(1).default(4096),
  /** Upper bound on generated tokens for the Anthropic Messages request. */
  messagesMaxTokens: z.number().step(1).min(1).default(4096),
  /** Most server-side searches per Anthropic Messages request. */
  messagesMaxUses: z.number().step(1).min(1).default(5),
  /** Maximum decoded HTTP body in bytes, before JSON parsing. */
  maxResponseBytes: z.number().step(1).min(1024).max(32 * 1024 * 1024).default(2 * 1024 * 1024),
  /** Maximum search result URLs and summary characters exposed to the caller. */
  maxSources: z.number().step(1).min(1).max(1000).default(100),
  maxSummaryChars: z.number().step(1).min(128).max(1000000).default(32768),
  /** Per-search deadline in milliseconds. */
  timeoutMs: z.number().step(1).min(1000).default(120000),
})

/** Strip trailing slashes so a path always appends to the configured base. */
function trimBase(baseURL) {
  return baseURL.replace(/\/+$/u, '')
}

/**
 * Resolve the configured gateway base: a literal `baseURL`, or the current
 * value of the environment variable named by `baseURLEnv`, read fresh on
 * every call so a launcher-set variable changed between launches takes
 * effect without editing configuration.
 * @param config - validated deployment settings.
 * @returns the trimmed, resolved gateway base.
 */
function resolveBase(config) {
  const value = config.baseURLEnv.length > 0 ? process.env[config.baseURLEnv] : config.baseURL
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('web search: the configured gateway base is unset or empty')
  }
  const trimmed = value.trim()
  if (!URL.canParse(trimmed)) {
    const source = config.baseURLEnv.length > 0 ? `baseURLEnv (${config.baseURLEnv})` : 'baseURL'
    throw new Error(`web search: ${source} is not a valid absolute URL`)
  }
  const url = new URL(trimmed)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('web search: gateway base must be an HTTP(S) URL without credentials, query, or fragment')
  }
  if (url.protocol === 'http:' && !(url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/u.test(url.hostname))) {
    throw new Error('web search: use HTTPS for a gateway outside loopback before sending credentials')
  }
  if (config.baseURLPath !== '' && !/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\/?$/u.test(config.baseURLPath)) {
    throw new Error('web search: baseURLPath must be an absolute path such as /v1, without query or fragment')
  }
  return trimBase(url.href) + trimBase(config.baseURLPath)
}

/**
 * Build the Anthropic `thinking` field for one search request. Acceptance of
 * each mode is gateway- and model-specific; there is no universal default.
 * @param config - validated deployment settings.
 * @returns an object spread into the request body (empty when thinking is omitted).
 */
function thinkingOf(config) {
  const mode = config.messagesThinking
  if (mode === 'omit') return {}
  if (mode === 'enabled') {
    return { thinking: { type: 'enabled', budget_tokens: config.messagesThinkingBudgetTokens } }
  }
  return { thinking: { type: mode } }
}

/**
 * Resolve the gateway key through the credential seam, then the process
 * environment. The reference stays a plain string; the seam brands it itself.
 * @param ctx - plugin context, which may carry a `credentials` service.
 * @param reference - name of the credential or environment variable.
 * @returns the usable key.
 */
async function resolveApiKey(ctx, reference) {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    let hit
    try { hit = await credentials.resolve(reference) } catch {
      throw new Error('web search: the configured gateway credential could not be resolved')
    }
    if (hit !== undefined && hit.value.length > 0) return hit.value
  }
  const ambient = process.env[reference]
  if (typeof ambient === 'string' && ambient.length > 0) return ambient
  throw new Error(
    `web search: no gateway key for ${reference}; store it through the credentials service or export it in the launching environment`,
  )
}

/** Whether a key exists, without reading its value or contacting the endpoint. */
async function hasApiKey(ctx, reference) {
  try {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const described = await credentials.describe(reference)
      if (described !== undefined && described.configured === true) return true
    }
  } catch {
    return false
  }
  const ambient = process.env[reference]
  return typeof ambient === 'string' && ambient.length > 0
}

/** Join the caller's signal with this provider's own deadline. */
function deadlineOf(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

/** Read at most the configured bytes after content decoding, including chunked responses. */
async function gatewayJson(url, options, what, limit) {
  const signal = options.signal
  const checkSignal = () => {
    if (signal.aborted) throw new DOMException(`${what}: request cancelled or timed out`, 'AbortError')
  }
  checkSignal()
  let response
  try { response = await fetch(url, options) } catch {
    checkSignal()
    throw new Error(`${what}: fetch failed. Check the gateway connection and TLS settings.`)
  }
  const reader = response.body?.getReader()
  const cancel = () => { if (reader) void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    checkSignal()
    if (!response.ok) throw new Error(`${what} failed: HTTP ${response.status}`)
    const overLimit = () => new Error(`${what}: gateway response exceeds maxResponseBytes`)
    if (Number(response.headers.get('content-length')) > limit) throw overLimit()
    if (!reader) throw new Error(`${what}: empty gateway response`)
    let buffer = new Uint8Array(Math.min(8192, limit))
    let bytes = 0
    for (;;) {
      let chunk
      try { chunk = await reader.read() } catch {
        checkSignal()
        throw new Error(`${what}: gateway response was interrupted`)
      }
      checkSignal()
      if (chunk.done) break
      const next = bytes + chunk.value.byteLength
      if (next > limit) throw overLimit()
      if (next > buffer.length) {
        const larger = new Uint8Array(Math.min(limit, Math.max(next, buffer.length * 2)))
        larger.set(buffer); buffer = larger
      }
      buffer.set(chunk.value, bytes); bytes = next
    }
    const decoder = new TextDecoder('utf-8', { fatal: true })
    try { return JSON.parse(decoder.decode(buffer.subarray(0, bytes))) } catch {
      throw new Error(`${what}: gateway returned invalid JSON`)
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    cancel()
    reader?.releaseLock()
  }
}

function searchResult(parsed, config) {
  const { searched, content, sources } = parsed
  const truncated = sources.length > config.maxSources || (content?.length ?? 0) > config.maxSummaryChars
  return { searched, ...(content ? { content: content.slice(0, config.maxSummaryChars) } : {}),
    sources: sources.slice(0, config.maxSources), truncated }
}

function isWebSourceURL(value) {
  return typeof value === 'string' && /^https?:\/\//iu.test(value) && URL.canParse(value)
}

/**
 * Read an OpenAI Responses payload. Sources come from `url_citation`
 * annotations and from any URLs a `web_search_call` reports; a
 * completed call can return an empty source list. Gateways may omit the call
 * item and retain only the structured URL citations.
 * @param data - the parsed Responses body.
 * @returns whether the server tool ran, the source list, and the answer text.
 */
function readResponses(data) {
  if (data?.error || (data?.status != null && data.status !== 'completed')) {
    throw new Error('Responses web search: the gateway did not complete the response')
  }
  const sources = new Map()
  const add = (url, title) => {
    if (!isWebSourceURL(url) || sources.has(url)) return
    sources.set(url, typeof title === 'string' && title ? { url, title } : { url })
  }
  const texts = []
  let completed = false
  let unsuccessful = false
  const output = Array.isArray(data?.output) ? data.output : []
  for (const item of output) {
    if (item?.type === 'web_search_call') {
      if (item.status != null && item.status !== 'completed') { unsuccessful = true; continue }
      if (item.status === 'completed') completed = true
      const action = item.action
      for (const found of Array.isArray(action?.sources) ? action.sources : []) add(found?.url, found?.title)
      continue
    }
    if (item?.type !== 'message') continue
    for (const part of Array.isArray(item.content) ? item.content : []) {
      if (part?.type !== 'output_text') continue
      if (typeof part.text === 'string' && part.text.length > 0) texts.push(part.text)
      for (const annotation of Array.isArray(part.annotations) ? part.annotations : []) {
        if (annotation?.type === 'url_citation') add(annotation.url, annotation.title)
      }
    }
  }
  if (!completed && unsuccessful) throw new Error('Responses web search: server-side search did not complete')
  const content = texts.join('\n').trim()
  return { searched: completed || sources.size > 0, ...(content.length > 0 ? { content } : {}), sources: [...sources.values()], truncated: false }
}

/**
 * Read an Anthropic Messages payload: sources come only from
 * `web_search_tool_result` blocks, never from model prose. A gateway may return
 * the result block with its `content` stripped, so the block itself is the
 * evidence that the server tool ran; the answer text is then the only output.
 * @param data - the parsed Messages body.
 * @returns whether the server tool ran, the source list, and the answer text.
 */
function readMessages(data) {
  const sources = new Map()
  const texts = []
  let searched = false
  let toolError
  for (const block of Array.isArray(data?.content) ? data.content : []) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0) texts.push(block.text)
    if (block?.type !== 'web_search_tool_result') continue
    if (block.content?.type === 'web_search_tool_result_error') {
      toolError = block.content.error_code ?? 'unknown'
      continue
    }
    if (block.content !== undefined && !Array.isArray(block.content)) continue
    searched = true
    for (const item of block.content ?? []) {
      if (item?.type !== 'web_search_result') continue
      const url = item.url
      if (!isWebSourceURL(url) || sources.has(url)) continue
      const title = typeof item.title === 'string' && item.title.length > 0 ? item.title : undefined
      const publishedAt = typeof item.page_age === 'string' ? item.page_age : undefined
      sources.set(url, {
        url,
        ...(title === undefined ? {} : { title }),
        ...(publishedAt === undefined ? {} : { publishedAt }),
      })
    }
  }
  if (!searched && toolError !== undefined) {
    const code = ['too_many_requests', 'invalid_input', 'max_uses_exceeded', 'unavailable', 'query_too_long'].includes(toolError) ? toolError : 'unknown'
    throw new Error(`Messages web search: server-side search failed (${code})`)
  }
  const content = texts.join('\n').trim()
  return { searched, ...(content.length > 0 ? { content } : {}), sources: [...sources.values()], truncated: false }
}

/**
 * Register both gateway search providers.
 * @param ctx - plugin context providing the `web` seam and optional services.
 * @param config - validated deployment settings.
 */
export function apply(ctx, config) {
  const hasLiteral = config.baseURL.length > 0
  const hasEnvRef = config.baseURLEnv.length > 0
  if (hasLiteral === hasEnvRef) {
    throw new Error(
      hasLiteral
        ? 'web search: set only one of baseURL or baseURLEnv, not both'
        : 'web search: set baseURL or baseURLEnv; this plugin ships no default gateway address',
    )
  }
  // Validate the address before registering either provider; readiness and
  // requests resolve it again from the same configuration.
  resolveBase(config)
  const describe = (what) => ({
    en: `Searches through ${what}, which runs the gateway's own server-side search tool; one search costs a model turn.`,
  })

  /** Shared plumbing both providers register with: usability and readiness. */
  const common = {
    available: () => {
      try {
        resolveBase(config)
      } catch {
        return false
      }
      return config.apiKeyEnv.length > 0
    },
    ready: async () => await hasApiKey(ctx, config.apiKeyEnv),
  }

  const responses = {
    ...common,
    id: `${config.idPrefix}-responses`,
    title: 'Gateway web search (Responses)',
    description: describe('an OpenAI Responses route'),
    async search(request, signal) {
      const base = resolveBase(config)
      const key = await resolveApiKey(ctx, config.apiKeyEnv)
      const data = await gatewayJson(`${base}/responses`, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: config.responsesModel,
          input: RESPONSES_PROMPT(request.query),
          tools: [{ type: config.responsesToolType }],
          tool_choice: config.responsesToolChoice,
          stream: false,
        }),
        signal: deadlineOf(signal, config.timeoutMs),
      }, 'Responses web search', config.maxResponseBytes)
      const { searched, ...result } = searchResult(readResponses(data), config)
      if (!searched) {
        throw new Error(
          `Responses web search ran no server-side search. Model ${config.responsesModel} may not support the ${config.responsesToolType} server tool on this gateway.`,
        )
      }
      return result
    },
  }

  const messages = {
    ...common,
    id: `${config.idPrefix}-messages`,
    title: 'Gateway web search (Messages)',
    description: describe('an Anthropic Messages route'),
    async search(request, signal) {
      const base = resolveBase(config)
      const key = await resolveApiKey(ctx, config.apiKeyEnv)
      const body = {
        model: config.messagesModel,
        max_tokens: config.messagesMaxTokens,
        messages: [{ role: 'user', content: MESSAGES_PROMPT(request.query) }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: config.messagesMaxUses }],
        ...thinkingOf(config),
      }
      const data = await gatewayJson(`${base}/messages`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          authorization: `Bearer ${key}`,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: deadlineOf(signal, config.timeoutMs),
      }, 'Messages web search', config.maxResponseBytes)
      const { searched, ...result } = searchResult(readMessages(data), config)
      if (!searched) {
        throw new Error(
          `Messages web search ran no server-side search. Model ${config.messagesModel} may not support the web_search server tool on this gateway.`,
        )
      }
      return result
    },
  }

  ctx.effect(() => ctx.web.registerSearchProvider(responses))
  ctx.effect(() => ctx.web.registerSearchProvider(messages))
}
