import { authoredDependency, effectivePreset, ownsTask } from './identity.js'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { resolveBackend } from './backends.js'
import { allocationHolds } from './holds.js'
import { routeFor } from './staffing.js'

const delegates = {
  worker: 'delegate_work',
  reviewer: 'delegate_review',
  validator: 'delegate_validate',
  observer: 'delegate_observe',
  assistant: 'delegate_assist',
}
const modes = ['auto', 'add', 'shrink', 'stop']
const usage = '/team-allocate auto|add|shrink|stop [JSON object with role, count, target, tier or host]'
const queues = new Map()
const hash = (parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex')
const observationKey = (step, checkpoint, turn) => {
  const identity = ['observation', step.role, step.attachedTo]
  if (checkpoint !== undefined) return [...identity, 'checkpoint', checkpoint]
  if (turn !== null) return [...identity, 'turn', turn]
  return identity
}
const limit = (n, fallback) => (Number.isSafeInteger(n) && n >= 0 ? Math.min(n, 32) : fallback)
const readOnly = (role) => role === 'reviewer' || role === 'observer'
const memberName = (m) => m.path ?? m.id
const ready = (task) =>
  task?.ready === true && task.status === 'pending' && task.ownerId == null && task.ownerName == null
const overlaps = (xs, ys) =>
  xs.some((x) =>
    ys.some((y) => {
      const a = x.replaceAll('\\', '/').toLowerCase(),
        b = y.replaceAll('\\', '/').toLowerCase()
      return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
    }),
  )
async function serialize(id, work) {
  const next = (queues.get(id) ?? Promise.resolve()).then(work)
  const tail = next.catch(() => {})
  queues.set(id, tail)
  try {
    return await next
  } finally {
    if (queues.get(id) === tail) queues.delete(id)
  }
}
function journal(filename) {
  const db = new DatabaseSync(filename)
  try {
    db.exec(`PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS coop_alloc_rounds(root TEXT PRIMARY KEY, paused INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS coop_alloc_budget(root TEXT NOT NULL, turn TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY(root,turn,key)) STRICT;
      CREATE TABLE IF NOT EXISTS coop_alloc_receipts(root TEXT NOT NULL, key TEXT NOT NULL, tool TEXT NOT NULL,
        target TEXT NOT NULL, task TEXT, revision INTEGER, state TEXT NOT NULL, PRIMARY KEY(root,key)) STRICT;
      CREATE TABLE IF NOT EXISTS coop_alloc_assignments(root TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY(root,key)) STRICT;`)
  } catch (error) {
    db.close()
    throw error
  }
  const holds = allocationHolds(db)
  const get = db.prepare('SELECT * FROM coop_alloc_receipts WHERE root=? AND key=?')
  const set = db.prepare('UPDATE coop_alloc_receipts SET state=? WHERE root=? AND key=?')
  const take = db.prepare("INSERT OR IGNORE INTO coop_alloc_receipts VALUES(?,?,?,?,?,?,'intent')")
  const forget = db.prepare("DELETE FROM coop_alloc_receipts WHERE root=? AND key=? AND state='intent'")
  const pause = db.prepare(
    'INSERT INTO coop_alloc_rounds VALUES(?,?) ON CONFLICT(root) DO UPDATE SET paused=excluded.paused',
  )
  const debit = db.prepare('INSERT INTO coop_alloc_budget VALUES(?,?,?)')
  const spent = db.prepare('SELECT count(*) AS n FROM coop_alloc_budget WHERE root=? AND turn=?')
  const refund = db.prepare('DELETE FROM coop_alloc_budget WHERE root=? AND key=?')
  const tagAssignment = db.prepare('INSERT INTO coop_alloc_assignments(root,key) VALUES(?,?)')
  const removeAssignment = db.prepare('DELETE FROM coop_alloc_assignments WHERE root=? AND key=?')
  const latestAssignment = db.prepare(`SELECT r.key FROM coop_alloc_receipts r
    JOIN coop_alloc_assignments a ON r.root=a.root AND r.key=a.key
    WHERE r.root=? AND r.target=? ORDER BY r.rowid DESC LIMIT 1`)
  const reserve = (root, key, tool, target, task, rev, turn, max, scopes, drain) => {
    db.exec('BEGIN IMMEDIATE')
    try {
      let result = 'duplicate'
      const held = scopes ? db.prepare('SELECT task,scopes FROM coop_alloc_holds WHERE root=?').all(root) : []
      if (held.some((row) => row.task === task || overlaps(JSON.parse(row.scopes), scopes)))
        result = 'scope-busy'
      else if (turn !== null && spent.get(root, turn).n >= max) result = 'turn-budget'
      else if (take.run(root, key, tool, target, task, rev).changes) {
        if (!drain) tagAssignment.run(root, key)
        if (scopes) holds.insert.run(root, task, rev, key, target, JSON.stringify(scopes))
        if (turn !== null) debit.run(root, turn, key)
        result = 'reserved'
      }
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  const reject = (root, key) => {
    db.exec('BEGIN IMMEDIATE')
    try {
      if (forget.run(root, key).changes) {
        refund.run(root, key)
        removeAssignment.run(root, key)
        holds.remove.run(root, key)
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  function drainKey(root, target, task, revision) {
    const identity = ['drain', target, task, revision]
    // A continuation can give a member fresh work without a board task.
    const assignment = !task && latestAssignment.get(root, target)
    if (assignment) identity.push(assignment.key)
    return hash(identity)
  }
  return { db, get, set, reserve, reject, pause, holds, drainKey }
}
function nativeArgs(step, target, key, drain, revision) {
  if (drain)
    return {
      agent: target,
      message:
        'At your next safe checkpoint, report the owned tasks, evidence and remaining work to the Lead. Finish or hand back your current assignment before accepting more.',
    }
  const purpose = step.taskId
    ? `Read ${step.taskId} at revision ${revision}. If its revision or scope has changed, report that change to the Lead.`
    : 'Observe the requested member at the next checkpoint.'
  const assignment = readOnly(step.role)
    ? 'Return a read-only report to the Lead. The Lead owns the board updates and records the verdict.'
    : 'Claim the task only if it is ready and unowned. Work within its declared scopes and deliver evidence to the Lead.'
  const prompt = [
    purpose,
    step.attachedTo && `Coordinate with ${step.attachedTo}.`,
    step.checkpoint && `Inspect checkpoint ${step.checkpoint}.`,
    assignment,
  ]
    .filter(Boolean)
    .join(' ')
  if (step.tool === 'send_message') return { agent: target, message: prompt }
  return {
    name: target,
    description: `[${step.role}] ${step.taskId ?? 'observation'} ${key.slice(0, 8)}`,
    prompt,
  }
}
function standalonePrompt(step, task, revision) {
  const scopes = task?.writeScopes ?? []
  const brief = {
    taskId: task?.id ?? null,
    revision,
    role: step.role,
    attachedTo: step.attachedTo ?? null,
    ...(step.checkpoint && { checkpoint: step.checkpoint }),
    subject: task?.subject ?? 'Observe the requested member at their next checkpoint.',
    description: task?.description ?? '',
    workspaceRelativeWriteScopes: scopes,
    dependencies: task?.blockedBy ?? [],
  }
  if (JSON.stringify(brief).length > 32_768)
    throw new Error('Task brief exceeds the external handoff limit. Split the task first.')
  return [
    'Complete this self-contained assignment using the workspace and task data below.',
    readOnly(step.role)
      ? 'Work read-only. Give an independent verdict on the pinned candidate with evidence.'
      : scopes.length
        ? 'Keep edits within the listed workspace-relative write scopes. Return changed paths and validation results.'
        : 'Use the listed inputs to validate the candidate. Keep the workspace read-only.',
    'Return a final report with the task ID, input version, checked scope, test commands/results, evidence references, and remaining limits. The Lead manages the Team board and accepts the deliverable.',
    JSON.stringify(brief),
  ].join('\n')
}
function validate(options) {
  if (options?.checkpoint !== undefined) {
    const label = options.checkpoint
    if (
      options.mode !== 'add' || options.role !== 'observer' || !options.target ||
      typeof label !== 'string' || !label.trim() || label.length > 160 || /[\x00-\x1f\x7f]/u.test(label)
    ) throw new Error('Supply a short checkpoint label when attaching an observer to a member.')
  }
  if (options?.llm !== undefined) {
    const requested = options.llm
    if (
      !requested ||
      typeof requested !== 'object' ||
      Array.isArray(requested) ||
      !['provider', 'model'].every(
        (field) => typeof requested[field] === 'string' && requested[field].trim().length > 0,
      ) ||
      Object.entries(requested).some(
        ([key, value]) =>
          !['provider', 'model', 'reasoning_effort'].includes(key) ||
          typeof value !== 'string' ||
          !value.trim() ||
          value.length > 160,
      )
    ) {
      throw new Error('Supply a provider and model, with an optional reasoning_effort, in llm.')
    }
  }
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    !modes.includes(options.mode) ||
    (options.host !== undefined &&
      (typeof options.host !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(options.host))) ||
    Object.keys(options).some((k) => !['mode', 'role', 'count', 'target', 'tier', 'host', 'llm', 'checkpoint'].includes(k))
  )
    throw new Error(usage)
}

export function createAllocator(ctx, { staffing, getPolicy = () => ({}), stateFile = ':memory:' }) {
  const receipts = journal(stateFile)
  function allowed(agent) {
    if (effectivePreset(ctx, agent) !== 'federated-team') return false
    try {
      return ctx.subagents.rootOf(agent) === agent
    } catch {
      return false
    }
  }
  function guard(agent, signal) {
    signal.throwIfAborted()
    if (!allowed(agent) || !ctx.agentTeams.isEnabled(agent))
      throw new Error('Allocation requires a federation Lead with Agent Teams enabled.')
  }
  async function execute(options, exec) {
    validate(options)
    const { agent, signal, toolSet } = exec
    guard(agent, signal)
    return serialize(agent.id, async () => {
      guard(agent, signal)
      const root = agent.id,
        drain = ['shrink', 'stop'].includes(options.mode)
      const paused = !!receipts.db.prepare('SELECT paused FROM coop_alloc_rounds WHERE root=?').get(root)
        ?.paused
      if (options.mode === 'auto' && paused) {
        return JSON.stringify({
          mode: 'auto',
          paused: true,
          results: [],
          reason: 'Allocation paused. Run team-allocate add to resume.',
        })
      }
      const { host: requestedHost, llm: requestedModel, checkpoint, ...planOptions } = options
      const list = () => ctx.agentTeams.listTasks(agent)
      const before = new Map(list().map((t) => [t.id, t.revision]))
      const plan = JSON.parse(
        await staffing.execute({ ...planOptions, action: 'plan' }, exec, receipts.holds.pending),
      )
      const policy = (await getPolicy(agent)) ?? {}
      guard(agent, signal)
      if (options.mode === 'stop') receipts.pause.run(root, 1)
      if (options.mode === 'add') receipts.pause.run(root, 0)
      const turn =
        !drain &&
        (Number.isSafeInteger(policy.turnId) ||
          (typeof policy.turnId === 'string' && policy.turnId.length > 0))
          ? String(policy.turnId)
          : null
      const maxSteps = drain
        ? Math.min(32, options.count ?? 32)
        : Math.min(
            plan.capacity.slots,
            limit(options.count, 32),
            limit(policy.maxAddPerTurn, 2),
            limit(policy.remainingStarts, 32),
            Math.max(0, limit(policy.maxAddPerTurn, 2) - limit(policy.spentThisTurn, 0)),
          )
      const results = []
      if (!drain && plan.steps.length === 0) {
        const roster = await ctx.subagents.listDescendants(root, signal)
        for (const hold of receipts.holds.pending(root, list())) {
          const seen =
            hold.tool !== 'send_message' &&
            roster.some((m) => m.parentId === root && m.kind === 'child' && memberName(m) === hold.target)
          if (seen && hold.state === 'intent') receipts.set.run('confirmed', root, hold.receipt)
          results.push({
            taskId: hold.task,
            revision: hold.revision,
            target: hold.target,
            tool: hold.tool,
            status: seen || hold.state === 'confirmed' ? 'already-queued' : 'reconcile-required',
          })
        }
      }
      for (const step of plan.steps.slice(0, maxSteps)) {
        if (!step.tool) {
          results.push({ status: step.action, target: step.target })
          continue
        }
        const send = step.tool === 'send_message'
        if (
          drain
            ? !(send && step.action === 'drain-at-checkpoint')
            : !(
                (send && step.action === 'resume') ||
                (step.tool === delegates[step.role] && step.action === 'delegate')
              )
        ) {
          throw new Error('The staffing plan contains an unsupported operation.')
        }
        const roster = await ctx.subagents.listDescendants(root, signal)
        guard(agent, signal)
        const rev = before.get(step.taskId) ?? null
        const key = drain
          ? receipts.drainKey(root, step.target, step.taskId, rev)
          : hash(
              step.taskId
                ? ['assignment', step.taskId, rev]
                : observationKey(step, checkpoint?.trim(), turn),
            )
        const target = send ? step.target : `${step.role}-${key.slice(0, 16)}`
        const detail = { taskId: step.taskId, revision: rev, target, tool: step.tool }
        const prior = receipts.get.get(root, key)
        if (prior) {
          const visible =
            prior.tool !== 'send_message' &&
            roster.some((m) => m.kind === 'child' && m.parentId === root && memberName(m) === prior.target)
          if (visible && prior.state === 'intent') receipts.set.run('confirmed', root, key)
          results.push({
            ...detail,
            tool: prior.tool,
            target: prior.target,
            status: prior.state === 'confirmed' || visible ? 'already-queued' : 'reconcile-required',
          })
          continue
        }
        const choice = requestedHost ?? policy.roleHosts?.[step.role] ?? 'dsh'
        let route
        if (!drain)
          route = await resolveBackend(
            ctx,
            agent,
            policy.backends,
            choice,
            step.role,
            options.tier,
            toolSet,
            requestedModel,
          )
        guard(agent, signal)
        const sameBinding =
          send &&
          !drain &&
          receipts.db
            .prepare(
              "SELECT 1 FROM coop_alloc_receipts WHERE root=? AND target=? AND tool=? AND state='confirmed' LIMIT 1",
            )
            .get(root, step.target, route.tool)
        const actualSend =
          drain ||
          (send &&
            requestedModel === undefined &&
            options.tier === undefined &&
            !route.oneShot &&
            choice === 'dsh' &&
            !!sameBinding)
        if (send && !actualSend && options.target && !step.attachedTo) {
          results.push({ ...detail, status: 'target-backend-mismatch' })
          continue
        }
        const toolName = actualSend ? 'send_message' : route.tool
        const recipient = actualSend ? target : `${step.role}-${key.slice(0, 16)}`
        Object.assign(detail, { target: recipient, tool: toolName, host: drain ? 'dsh' : choice })
        const currentTasks = list()
        const latest = currentTasks.find((t) => t.id === step.taskId)
        if (
          !drain &&
          (step.taskId
            ? !ready(latest) || latest.revision !== rev
            : !(step.role === 'observer' && step.attachedTo))
        ) {
          results.push({ ...detail, status: 'task-changed' })
          continue
        }
        if (
          !drain &&
          latest &&
          currentTasks.some((t) => t.status === 'in_progress' && overlaps(t.writeScopes, latest.writeScopes))
        ) {
          results.push({ ...detail, status: 'scope-busy' })
          continue
        }
        const existing = roster.find((m) => memberName(m) === recipient || m.id === recipient)
        if (
          actualSend &&
          (existing?.mode !== 'continuable' ||
            (!drain &&
              (existing.activity !== 'inactive' ||
                currentTasks.some((t) => t.status === 'in_progress' && ownsTask(existing, t)) ||
                (step.role === 'reviewer' && authoredDependency(existing, latest, currentTasks)))))
        ) {
          results.push({ ...detail, status: 'target-changed' })
          continue
        }
        if (!actualSend && existing) {
          results.push({ ...detail, status: 'name-in-use' })
          continue
        }
        if (
          !drain &&
          (roster.some((m) => m.kind !== 'child') ||
            roster.filter((m) => m.activity !== 'inactive').length >= limit(policy.maxActive, 4))
        ) {
          results.push({ ...detail, status: 'capacity-changed' })
          break
        }
        if (step.attachedTo && !roster.some((m) => m.kind === 'child' && memberName(m) === step.attachedTo)) {
          results.push({ ...detail, status: 'target-changed' })
          continue
        }
        const dispatch = { ...step, tool: toolName, checkpoint: checkpoint?.trim() }
        const args = nativeArgs(dispatch, recipient, key, drain, rev)
        if (
          route &&
          choice === 'dsh' &&
          ['light', 'deep'].includes(options.tier) &&
          !policy.tiers?.[options.tier] &&
          !requestedModel
        ) {
          throw new Error('Configure this DSH tier or supply an allowed provider and model in llm.')
        }
        if (!actualSend && route.modelControl === 'call-time') {
          Object.assign(args, requestedModel ?? routeFor(step.role, options.tier, policy).args)
          if (!route.supportsEffort) delete args.reasoning_effort
        }
        if (route?.oneShot) args.prompt = standalonePrompt(dispatch, latest, rev)
        const reservation = receipts.reserve(
          root,
          key,
          toolName,
          recipient,
          step.taskId ?? null,
          rev,
          turn,
          limit(policy.maxAddPerTurn, 2),
          !drain && latest ? latest.writeScopes : null,
          drain,
        )
        if (reservation !== 'reserved') {
          results.push({
            ...detail,
            status: reservation === 'duplicate' ? 'reconcile-required' : reservation,
          })
          continue
        }
        const callId = randomUUID()
        async function uncertain() {
          signal.throwIfAborted()
          if (!actualSend) {
            try {
              const children = await ctx.subagents.listDescendants(root, signal)
              const seen = children.some(
                (m) => m.parentId === root && m.kind === 'child' && memberName(m) === recipient,
              )
              if (seen) {
                receipts.set.run('confirmed', root, key)
                results.push({ ...detail, status: 'reconciled' })
                return
              }
            } catch {
              signal.throwIfAborted()
            }
          }
          results.push({ ...detail, status: 'reconcile-required' })
        }
        let batch
        try {
          batch = await ctx.tools.execute({
            agent,
            signal,
            toolSet,
            calls: [{ type: 'tool-call', id: callId, name: toolName, arguments: JSON.stringify(args) }],
          })
        } catch {
          await uncertain()
          break
        }
        for (const context of batch.additionalContexts ?? []) exec.deferContext?.(context)
        if (batch.concluded) exec.concludeTurn?.()
        const reply =
          batch.results?.length === 1 && batch.results[0].callId === callId ? batch.results[0].result : null
        if (
          reply?.isError === false &&
          (actualSend
            ? typeof reply.value?.messageId === 'string' && reply.value.messageId.length > 0
            : reply.value?.kind === 'activation' && reply.value.name === recipient)
        ) {
          receipts.set.run('confirmed', root, key)
          results.push({ ...detail, status: 'queued' })
        } else {
          const code = reply?.error?.info?.code
          if (
            [
              'APPROVAL_REJECTED',
              'APPROVAL_CANCELLED',
              'APPROVAL_UNAVAILABLE',
              'ABORTED_BEFORE_DISPATCH',
              'UNKNOWN_TOOL',
            ].includes(code)
          ) {
            receipts.reject(root, key)
            results.push({ ...detail, status: 'not-dispatched', code })
          } else await uncertain()
          signal.throwIfAborted()
          break
        }
        signal.throwIfAborted()
        if (batch.concluded) break
      }
      return JSON.stringify({
        mode: options.mode,
        paused: !!receipts.db.prepare('SELECT paused FROM coop_alloc_rounds WHERE root=?').get(root)?.paused,
        results,
        ...(plan.reason ? { reason: plan.reason } : {}),
      })
    })
  }
  const { action: _unused, ...properties } = staffing.tool.parameters.properties
  const tool = {
    name: 'team_allocate',
    description:
      'Apply one bounded staffing plan through native delegation. Stop or shrink asks members for a safe handoff.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['mode'],
      properties: {
        ...properties,
        checkpoint: {
          type: 'string',
          description: 'Stable label for a direct observation of a member. Reuse it when retrying.',
        },
        host: { type: 'string', description: 'Configured delegation host ID.' },
        llm: {
          type: 'object',
          additionalProperties: false,
          required: ['provider', 'model'],
          properties: {
            provider: { type: 'string' },
            model: { type: 'string' },
            reasoning_effort: { type: 'string' },
          },
        },
      },
    },
    output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
    execute,
  }
  const command = {
    name: 'team-allocate',
    description: 'Apply one federation staffing round.',
    recordInput: false,
    async handler({ agent, signal, rawInput }) {
      try {
        const match = /^(auto|add|shrink|stop)(?:\s+(\{[\s\S]*\}))?$/.exec(rawInput.trim())
        if (!match) throw new Error(usage)
        const args = match[2] ? JSON.parse(match[2]) : {}
        if (Object.hasOwn(args, 'mode')) throw new Error(usage)
        return { kind: 'success', text: await execute({ ...args, mode: match[1] }, { agent, signal }) }
      } catch (error) {
        signal.throwIfAborted()
        return { kind: 'error', text: error.message }
      }
    },
  }
  return {
    tool,
    command,
    when: ({ agent }) => allowed(agent),
    holds: receipts.holds.pending,
    close: () => receipts.db.close(),
  }
}
