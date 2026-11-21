import z from './runtime/schema.js'
import { createGitLabGet, normalizeHosts } from './glab.js'
import { createGitLabProvider } from './provider.js'
import { createReadReview } from './reviews.js'

export const name = 'forge-gitlab-reader'
export const inject = ['forge']
export const Config = z.object({
  hosts: z.array(z.string()).default(['gitlab.com']),
  glabCommand: z.string().default('glab'),
  timeoutMs: z.number().step(1).min(1).max(300000).default(15000),
  maxOutputBytes: z.number().step(1).min(1024).max(33554432).default(4194304),
  maxThreads: z.number().step(1).min(1).max(1000).default(100),
})

/** rc.3 forge lookup key. The integration smoke checks this against the installed registry. */
export function changeRequestKey({ repository: { forge, host, owner, name }, number }) {
  return `${forge}:${host}/${owner}/${name}#${number}`.toLowerCase()
}

export function apply(ctx, config) {
  const hosts = normalizeHosts(config.hosts)
  if (!config.glabCommand.trim()) throw new Error('glabCommand must identify the GitLab CLI')
  const get = createGitLabGet({ ...config, hosts })
  const readReview = createReadReview({ get, maxThreads: config.maxThreads })
  // ForgeService.register owns cancellation, cleanup and in-flight reads on the calling fiber.
  ctx.forge.register(createGitLabProvider({ hosts, get, changeRequestKey, readReview }))
}
