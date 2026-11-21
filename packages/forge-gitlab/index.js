import z from './runtime/schema.js'
import { createDiscussionTransport, createGitLabGet, normalizeHosts } from './glab.js'
import { createThreadPermissions } from './permissions.js'
import { createWriteReview } from './thread-action.js'
import { createGitLabProvider } from './provider.js'
import { createReadReview } from './reviews.js'

export const name = 'forge-gitlab-reader'
export const inject = ['forge']
export const Config = z.object({
  hosts: z.array(z.string()).default(['gitlab.com']),
  discussionWriteHosts: z.array(z.string()).default([]),
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
  const writeHosts = config.discussionWriteHosts.length ? normalizeHosts(config.discussionWriteHosts) : []
  if (writeHosts.some(host => !hosts.includes(host))) throw new Error('discussionWriteHosts must be a subset of hosts')
  const get = createGitLabGet({ ...config, hosts })
  let permissions, writeReview
  if (writeHosts.length) {
    const transport = createDiscussionTransport({ ...config, hosts: writeHosts })
    const lookup = createThreadPermissions({ query: transport.query })
    permissions = (ref, threads, signal) => writeHosts.includes(ref.repository.host) ? lookup(ref, threads, signal) : new Map()
    writeReview = createWriteReview({ hosts: writeHosts, get, permissions, mutate: transport.mutate })
  }
  const readReview = createReadReview({ get, maxThreads: config.maxThreads, permissions })
  // ForgeService.register owns cancellation, cleanup and in-flight reads on the calling fiber.
  ctx.forge.register(createGitLabProvider({ hosts, get, changeRequestKey, readReview, writeReview }))
}
