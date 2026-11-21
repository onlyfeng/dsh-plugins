// Only the MR and opening-note permissions are needed for reply and resolution.
// Keep this query static; all host-specific values are GraphQL variables.
const PAGE_SIZE = 20
const MAX_PAGES = 10
export const DISCUSSION_PERMISSIONS_QUERY = `query ForgeDiscussionPermissions($project: ID!, $iid: String!, $after: String) {
  project(fullPath: $project) {
    mergeRequest(iid: $iid) {
      iid
      userPermissions { createNote }
      discussions(first: ${PAGE_SIZE}, after: $after) {
        nodes {
          id
          notes(first: 1) { nodes { id userPermissions { createNote resolveNote } } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`

/** Resolve permissions only for matched REST discussion and opening-note IDs in this MR. */
export function createThreadPermissions({ query }) {
  return async function threadPermissions(ref, threads, signal) {
    signal.throwIfAborted()
    const { host, owner, name } = ref.repository
    const project = `${owner}/${name}`
    const iid = String(ref.number)
    const pending = new Map(threads.map(thread => [`gid://gitlab/Discussion/${thread.id}`, thread]))
    const grants = new Map()
    const cursors = new Set()
    let after
    try {
      for (let page = 0; page < MAX_PAGES && pending.size; page++) {
        const variables = { project, iid, ...(after === undefined ? {} : { after }) }
        const result = await query(host, DISCUSSION_PERMISSIONS_QUERY, variables, signal)
        signal.throwIfAborted()
        if (result?.errors !== undefined && !(Array.isArray(result.errors) && result.errors.length === 0)) break
        const mr = result?.data?.project?.mergeRequest
        const connection = mr?.discussions
        if (mr?.iid !== iid || typeof mr?.userPermissions?.createNote !== 'boolean'
            || !Array.isArray(connection?.nodes) || connection.nodes.length > PAGE_SIZE) return new Map()
        for (const row of connection.nodes) {
          const thread = pending.get(row?.id)
          if (!thread) continue
          pending.delete(row.id)
          const note = row.notes?.nodes?.[0]
          const id = thread.comments[0]?.id
          if (typeof id !== 'string' || !/^[1-9]\d*$/.test(id)) continue
          // Depending on the GitLab release, an inline note uses its STI class in its GID.
          if (note?.id !== `gid://gitlab/Note/${id}` && note?.id !== `gid://gitlab/DiffNote/${id}`) continue
          grants.set(thread.id, {
            reply: mr.userPermissions.createNote && note.userPermissions?.createNote === true,
            resolve: note.userPermissions?.resolveNote === true,
          })
        }
        if (!pending.size || connection.pageInfo?.hasNextPage !== true) break
        after = connection.pageInfo.endCursor
        if (typeof after !== 'string' || !after || cursors.has(after)) break
        cursors.add(after)
      }
    } catch {
      signal.throwIfAborted()
    }
    return grants
  }
}
