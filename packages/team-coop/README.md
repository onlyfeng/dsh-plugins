# Team cooperation

Open a new DSH root session with **通用协作团队** (`federated-team`) and enable Agent Teams. The Lead owns capacity, the task board, external agreements and final acceptance. Workers implement a bounded slice. Validators run specified checks. Independent reviewers examine a pinned candidate. An observer can inspect a named member's evidence at a checkpoint. A one-shot external agent receives a self-contained assignment and returns evidence to its Lead.

## Scale the team

Create ready tasks with inputs, write scopes, dependencies and acceptance criteria. A `[worker]`, `[reviewer]`, `[validator]`, `[observer]` or `[assistant]` title selects a role explicitly. The Lead can use the same operations from a conversation.

```text
/team-hosts
/team-staff status
/team-staff plan {"mode":"add","role":"reviewer","count":1}
/team-allocate add {"role":"reviewer","count":1,"host":"claude-code"}
/team-allocate auto
/team-allocate add {"role":"observer","target":"worker-name","checkpoint":"candidate-a"}
/team-allocate shrink {"target":"worker-name"}
```

`plan` previews a round. `team-allocate` executes a bounded round. Keep ready slices disjoint, then use completion or a new user request to trigger the next round. `shrink` requests a checkpoint from a continuable member. `stop` pauses automatic starts for the tree. `add` resumes them. The Lead accepts one-shot results and updates their tasks. A queued task retains its slot and scopes until the board records completion or withdrawal. For an uncertain delivery, inspect the child and its evidence before completing or withdrawing the task. An external one-shot session finishes its current assignment. The Host's depth, capacity, tool admissions and native account permissions also apply.

An observer attached to a member can inspect successive checkpoints. Use a stable `checkpoint` label when repeating a request, including after a restart. Change the label for a fresh inspection. An unlabelled direct request uses the current Lead turn, or a single per-member receipt for manual calls outside a turn. A board task keeps its task-and-revision receipt.

## Choose projects and hosts

`general` works without site configuration. For persistent contracts and project-specific routes set the plugin's `siteFile` to an absolute path outside the public package. The private UTF-8 JSON registry has `schema: 1`, `stateFile` (an absolute `.sqlite`, `.sqlite3` or `.db` filename in an existing directory), `packs`, `peers`, and optional `staffing`. Each project requires `id`, `label`, `root`, `brief`, `roles` and `gates`. `/team-coop packs` lists the choices. `/team-coop use <pack-id>` selects a pack for the tree. Scoped writing agreements bind to the selected checkout. `/team-coop leave` returns to general mode after every open agreement closes or is cancelled.

This sample `staffing` object enables the two official external hosts and a custom DSH subagent provider. The custom provider and its native delegation tool must already be installed. Each named tier refers to a separately configured instance.

```json
{
  "maxActive": 4,
  "maxAddPerTurn": 2,
  "backends": {
    "codex": {"tiers": {"deep": {"provider": "codex-deep", "tool": "subagent_codex_deep"}}},
    "claude-code": true,
    "example": {"provider": "example", "tool": "subagent_example"}
  },
  "roleHosts": {"worker": "codex", "reviewer": "dsh"},
  "tiers": {"deep": {"provider": "example-llm", "model": "example-model", "reasoning_effort": "high"}}
}
```

`/team-hosts` reports the registered providers and tools in the current preset. DSH `spawn` supports follow-up messages and permitted call-time model choices. Use `list_subagent_models` and the session's model permissions to choose supported combinations. The two official external hosts use native settings and authentication. Their DSH adapters accept one self-contained task. Select an external model by mapping a tier to a configured native instance, for example `/team-allocate add {"role":"worker","host":"codex","tier":"deep","count":1}`. Custom hosts can use call-time options when both the provider and its admitted tool implement them. Use native authentication through the product's account interface. Keep credentials outside the team package.

For one DSH assignment using a permitted model and reasoning level, supply them directly in `llm`.

```text
/team-allocate add {"role":"reviewer","host":"dsh","count":1,"llm":{"provider":"example-llm","model":"example-model","reasoning_effort":"high"}}
```

## Grant and return a write scope

Each peer has an `id`, `label` and `role` (`observer` or `controller`). Give each controller its own private `receiptDir`. For live Orca verification configure its `route` with the pinned `tabId`, `leafId`, `session`, `workspace` and `agent`. Teams sharing the same database detect overlapping reservations, including nested checkout roots. A contract records authority. Actual filesystem permissions, worktree isolation, native host permission modes and the external team's ledger remain authoritative for their own operations. Read-only DSH observers have a tool guard. Configure any external reviewer's native permissions to suit its role.

1. **Offer a slice.** Supply a peer, scope, pinned inputs, goal, completion criteria, ledger reference and a future UTC deadline. A `collaborate` offer with `scopes:[]` opens a read-only consultation. Scoped `collaborate` and `takeover` offers reserve their paths with `canWrite:false`.

   ```text
   /team-coop offer {"id":"slice-a","mode":"takeover","peer":"controller-a","scopes":["src/parser"],"goal":"Fix parser behavior","inputs":"Pinned failing fixture","done":"Regression test passes","ledger":"Peer task reference","until":"2031-06-01T12:00:00Z"}
   ```

2. **Obtain the grant.** Read `digest` and `rev` in `/team-coop status`. After the original writer reaches a safe checkpoint, prepare a UTF-8 JSON packet with `kind:"grant"`, controller ID in `actor`, offer ID in `lane`, digest in `contract`, numeric `rev`, `checkpoint` and `evidence`. Run `node receipt.js SITE PEER PACKET` from the package directory with the registry filename, peer ID and packet filename. It stages the exact bytes and prints `ref` and `acknowledgement`. For a live route, the controller verifies the packet and posts `TEAM-COOP GRANT <hash>` as its entire assistant message in its pinned session. Mailbox delivery is a separate event. The Lead then runs `/team-coop accept {"id":"slice-a","rev":1,"receipt":"<hash>"}`.

3. **Release.** Stop writing at the deadline or agreed checkpoint. Run `/team-coop release {"id":"slice-a","rev":2,"checkpoint":"<final checkpoint>"}`. The `returning` contract keeps the paths reserved. Release remains available after expiry.

4. **Confirm the return.** The controller checks the evidence, prepares a fresh packet with `kind:"returned"`, the current revision and the exact released checkpoint, and stages it through the same CLI. Checkpoints may contain multiple lines and must fit in 2048 UTF-8 bytes. Preserve their whitespace when preparing the return receipt. For a live route the controller posts `TEAM-COOP RETURNED <hash>` as its entire assistant message. The Lead runs `/team-coop returned {"id":"slice-a","rev":3,"receipt":"<hash>"}`. An unaccepted offer or consultation can be closed with `/team-coop cancel {"id":"slice-a","rev":1}`.

Use `node orca-peer.js check ROUTES PEER` to resolve a pinned route and `draft ROUTES PEER MESSAGE_JSON` to preview a message. `send` explicitly sends the prepared text. A receipt without a live route trusts the operator and the private inbox ACL. A digest binds the bytes. Keep the SQLite state and inboxes in a private directory. After a restart or revision conflict, reconcile `/team-coop status` with the peer ledger before making the next change.
