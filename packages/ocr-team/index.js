import z from '@deepseek-ai/schemastery'
import { makeSelector } from './config.js'
import { createImportCommand } from './host.js'
import { createProjectRuntime } from './runtime.js'

export const name = 'ocr-team'
export const inject = ['commands', 'workingDirectory', 'subagents', 'sessions', 'sessionQuery', 'agentTeams']
export const Config = z.object({
  projects: z.array(z.object({
    projectKey: z.string().required(),
    instanceId: z.string().required(),
    gitlab: z.object({ host: z.string().required(), projectId: z.number().step(1).min(1).required(), projectPath: z.string().required() }).required(),
    checkoutRoot: z.string().required(),
    reportsRoot: z.string().required(),
  })).default([]),
})

export async function apply(ctx, config) {
  if (!config.projects.length) return
  const selectProject = await makeSelector(config.projects, agent => ctx.workingDirectory.get(agent.session), createProjectRuntime)
  ctx.commands.register(createImportCommand(ctx, selectProject))
}
