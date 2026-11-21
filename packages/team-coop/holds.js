// A pending task may stay on the board until the Lead records a one-shot child's deliverable.
// Remember the offered scopes even if the board metadata changes while it is running.
export function allocationHolds(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS coop_alloc_holds(
    root TEXT NOT NULL, task TEXT NOT NULL, revision INTEGER NOT NULL,
    receipt TEXT NOT NULL, target TEXT NOT NULL, scopes TEXT NOT NULL,
    PRIMARY KEY(root,task)) STRICT`)
  const forRoot = db.prepare(`SELECT h.task, h.revision, h.scopes, h.target, h.receipt, r.state, r.tool
    FROM coop_alloc_holds h JOIN coop_alloc_receipts r ON r.root=h.root AND r.key=h.receipt WHERE h.root=?`)
  const insert = db.prepare('INSERT INTO coop_alloc_holds VALUES(?,?,?,?,?,?)')
  const remove = db.prepare('DELETE FROM coop_alloc_holds WHERE root=? AND receipt=?')
  const removeTask = db.prepare('DELETE FROM coop_alloc_holds WHERE root=? AND task=? AND receipt=?')
  function pending(root, tasks) {
    const byId = new Map(tasks.map((task) => [task.id, task]))
    const pending = []
    for (const row of forRoot.all(root)) {
      const task = byId.get(row.task)
      if (!task || ['completed', 'deleted'].includes(task.status)) {
        removeTask.run(root, row.task, row.receipt)
        continue
      }
      pending.push({ ...row, scopes: JSON.parse(row.scopes) })
    }
    return pending
  }
  return { pending, remove, insert }
}
