import z from '@deepseek-ai/schemastery'
import { createCooperation } from './host.js'
import { loadSite, staffingPolicy } from './site.js'
import { openStore } from './store.js'
import { createStaffing } from './staffing.js'
import { createAllocator } from './allocator.js'

import { effectivePreset } from './identity.js'
import { resolveBackend } from './backends.js'

export const name = 'team-coop'
export const inject = [
  'commands',
  'tools',
  'systemPrompt',
  'subagents',
  'workingDirectory',
  'agentTeams',
  'agents',
]
export const Config = z.object({ siteFile: z.string().default('') })

export async function apply(ctx, { siteFile = '' } = {}) {
  const site = siteFile ? await loadSite(siteFile) : undefined
  const store = site ? openStore(site.stateFile) : undefined
  if (store) ctx.effect(() => () => store.close(), 'team-coop: close store')
  const defaults = site?.staffing ?? staffingPolicy()
  function getPolicy(agent) {
    const pack = store?.getPack(agent.id) ?? 'general'
    return {
      ...(site?.packs.get(pack)?.staffing ?? defaults),
      turnId: ctx.agents.turnBoundaryOf(agent.session).openTurnStartSeq,
    }
  }
  const cooperation = createCooperation(ctx, { site, store })
  const staffing = createStaffing(ctx, {
    getPolicy,
    policyHolds: (root, tasks) => allocation.holds(root, tasks),
  })
  const allocation = createAllocator(ctx, { staffing, getPolicy, stateFile: site?.stateFile ?? ':memory:' })
  ctx.effect(() => () => allocation.close(), 'team-coop: close allocation journal')
  for (const feature of [cooperation, staffing, allocation]) {
    ctx.commands.register(feature.command)
    ctx.tools.register(feature.tool, { when: feature.when })
    if (feature.prompt) ctx.systemPrompt.context(feature.prompt)
  }
  ctx.commands.register({
    name: 'team-hosts',
    description: 'Show the current registered delegation hosts and model profiles.',
    recordInput: false,
    async handler({ agent }) {
      if (effectivePreset(ctx, agent) !== 'federated-team' || ctx.subagents.rootOf(agent) !== agent)
        return { kind: 'error', text: 'Open the federation Lead session.' }
      const { backends, roleHosts } = getPolicy(agent)
      const hosts = Object.keys(backends).map((host) => {
        try {
          const { oneShot, modelControl, tool, provider } = resolveBackend(
            ctx,
            agent,
            backends,
            host,
            'worker',
          )
          return {
            host,
            registered: true,
            provider,
            tool,
            oneShot,
            modelControl,
            tiers: Object.keys(backends[host].tiers),
          }
        } catch (error) {
          return { host, registered: false, reason: error.message }
        }
      })
      return { kind: 'success', text: JSON.stringify({ hosts, roleHosts }) }
    },
  })
}
