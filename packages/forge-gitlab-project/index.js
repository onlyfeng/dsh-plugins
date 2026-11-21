import { createGitLabGet } from './glab-read.js'
import { createProjectCommand } from './host.js'

export const name = 'forge-gitlab-project'
export const inject = ['commands', 'forgePanel', 'forge', 'workingDirectory', 'agents']

export function apply(ctx) {
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort())
  const getForHost = host => createGitLabGet({ hosts: [host], glabCommand: 'glab', timeoutMs: 15000, maxOutputBytes: 4194304 })
  ctx.commands.register(createProjectCommand(ctx, getForHost, lifetime.signal))
}
