import { matchesSnapshot } from './receipts.js'

const tails = new Map()
const hex = /^[a-f0-9]{64}$/
const taskId = /^task-[1-9]\d*$/
const marker = /^\[ocr-team:v1:([a-f0-9]{64}):([a-f0-9]{64})\]$/
class Refusal extends Error {}
const refuse = message => { throw new Refusal(message) }

async function onBoard(id, work) {
  const run = (tails.get(id) ?? Promise.resolve()).then(work)
  const tail = run.catch(() => {})
  tails.set(id, tail)
  try { return await run } finally { if (tails.get(id) === tail) tails.delete(id) }
}

// Revision one preserves the original marker across task edits and deletion. A fork's
// inherited prefix belongs to its parent, even when both sessions use the same project.
async function originalTasks(ctx, agent, runId, signal) {
  const { session, events, inheritedEventCount: start } = await ctx.sessionQuery.readSession(agent.id, signal)
  if (session?.id !== agent.id || !Array.isArray(events) || !Number.isSafeInteger(start) || start < 0 || start > events.length) {
    refuse('Could not verify the task history of this session.')
  }
  const found = new Map()
  for (let i = start; i < events.length; i++) {
    const { type, data } = events[i]
    if (type !== 'team/task' || data?.version !== 2 || data.teamId !== agent.id || data.task?.revision !== 1) continue
    const task = data.task
    const match = marker.exec(task.description?.split('\n', 1)[0])
    if (match?.[1] !== runId) continue
    if (!taskId.test(task.id) || found.has(match[2])) refuse('Conflicting import markers. Check this task board.')
    found.set(match[2], task.id)
  }
  return found
}

function requestsFor(plan, runId) {
  if (plan?.runId !== runId || !Array.isArray(plan.findings)) refuse('Invalid review receipt.')
  const seen = new Set()
  return plan.findings.map(({ fingerprint, path, endLine, body, discussionId, noteId }) => {
    if (!hex.test(fingerprint) || seen.has(fingerprint) || typeof body !== 'string' || !body.trim()) refuse('Invalid review finding.')
    seen.add(fingerprint)
    if (typeof path !== 'string' || /[\x00-\x1f\x7f\\:"<>|?*]/u.test(path)
        || path.split('/').some(s => !s || s === '.' || s === '..' || /[. ]$/.test(s) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s))) {
      refuse('The finding has an invalid workspace-relative path.')
    }
    const location = `${path}:${endLine}`
    const subject = `OCR !${plan.snapshot.iid} · ${location}`.slice(0, 200)
    const description = [`[ocr-team:v1:${runId}:${fingerprint}]`,
      `Verify the finding on MR !${plan.snapshot.iid} at ${plan.snapshot.headSha}.`,
      `${location} · discussion ${discussionId} · note ${noteId}`, '',
      ...body.split(/\r\n|[\r\n]/).map(line => `> ${line}`)].join('\n')
    if (description.length > 16384) refuse('The finding exceeds the Team task description limit.')
    return { fingerprint, request: { subject, description, writeScopes: [path] } }
  })
}

async function confirmSave(ctx, agent) {
  try { if (await ctx.sessions.flush(agent.session) === true) return } catch { /* A positive flush confirms durability. */ }
  refuse('Task save unconfirmed. Restore session persistence and retry the same run.')
}

/** Create the command definition for ctx.commands.register. selectProject returns stable adapter identities. */
export function createImportCommand(ctx, selectProject) {
  return {
    name: 'ocr-team', description: 'Preview or import review findings into this session’s Team task board.', recordInput: false,
    async handler({ agent, rawInput, signal }) {
      const args = /^(preview|import)\s+([a-f0-9]{64})$/.exec(rawInput.trim())
      if (!args) return { kind: 'error', text: 'Use /ocr-team preview <runId> or /ocr-team import <runId>.' }
      const [, action, runId] = args
      function checkTeam() {
        signal.throwIfAborted()
        if (ctx.subagents.rootOf(agent) !== agent || ctx.agentTeams.isEnabled(agent) !== true) refuse('Open a root session with Agent Teams enabled.')
      }
      async function selected() {
        checkTeam()
        const project = await selectProject(agent, signal)
        checkTeam()
        if (!project) refuse('Open a configured project checkout.')
        return project
      }
      try {
        const project = await selected()
        async function guard(plan) {
          if (await selected() !== project || (plan !== undefined && project.belongs(plan) !== true)) {
            refuse('The checkout or receipt does not match the selected project.')
          }
        }
        async function verify(plan) {
          await guard(plan)
          const current = await project.readCurrent(plan, signal)
          await guard(plan)
          if (!matchesSnapshot(plan, current)) refuse('The merge request changed. Use a current review receipt.')
        }
        return await onBoard(agent.id, async () => {
          await guard()
          const plan = await project.loadPlan(runId, signal)
          await guard(plan)
          const tasks = requestsFor(plan, runId)
          await verify(plan)
          const existing = await originalTasks(ctx, agent, runId, signal)
          await guard(plan)
          const report = { action, runId, total: tasks.length, created: 0, reused: 0, tasks: [] }
          for (const { fingerprint, request } of tasks) {
            let id = existing.get(fingerprint)
            if (id) {
              report.reused++
            } else if (action === 'import') {
              await verify(plan)
              try {
                id = (await ctx.agentTeams.createTask(agent, request, signal)).id
              } catch (error) {
                if (error?.code !== 'TEAM_TASK_PERSISTENCE_UNCONFIRMED') throw error
                await guard(plan)
                id = (await originalTasks(ctx, agent, runId, signal)).get(fingerprint)
                await guard(plan)
                if (!id) refuse('Could not reconcile the task append. Check the board and retry the same run.')
                await confirmSave(ctx, agent)
              }
              await guard(plan)
              if (!taskId.test(id)) refuse('Could not confirm the created task. Retry the same run.')
              report.created++
            }
            report.tasks.push({ fingerprint, taskId: id ?? null, subject: request.subject })
          }
          if (action === 'import' && report.reused) await confirmSave(ctx, agent)
          await guard(plan)
          return { kind: 'success', text: JSON.stringify(report) }
        })
      } catch (error) {
        signal.throwIfAborted()
        return { kind: 'error', text: error instanceof Refusal ? error.message : error?.code === 'TEAM_TASK_LIMIT'
          ? 'The Team task board is full. Restore capacity and retry the same run.'
          : 'Could not complete the command. Check the project, receipt and task board before retrying.' }
      }
    },
  }
}
