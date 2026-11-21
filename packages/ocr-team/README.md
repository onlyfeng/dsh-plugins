# OCR review tasks for DeepSeek Harness

This Host plugin adds `/ocr-team` to DSH. It imports findings from published Open Code Review runs into the current checkout’s Team board. Each task carries the reviewed file, commit, finding fingerprint, GitLab note and discussion IDs. A repeated import into the same Team board reuses the original task IDs, including tasks edited, completed or deleted since the first import.

## Set up

Install this bundle on DSH `0.2.2-rc.5`, enable Agent Teams for the receiving root session, and sign in to the configured GitLab instance with `glab`. The machine needs access to the report producer’s trusted output directory. The supported format is the GitLab integration’s schema-version-1 `manifest.json`, `result.json` and `publication-receipt.json` in a directory named for the full run ID.

The bundle starts with `projects: []`. Configure the `ocr-team` row in your local profile or a private bundle layer. This example uses fictional values. Supply existing absolute directories on the host running DSH.

```yaml
- id: ocr-team
  name: '@onlyfeng/dsh-ocr-team'
  config:
    projects:
      - projectKey: sample-app
        instanceId: example
        gitlab:
          host: gitlab.example.test
          projectId: 9001
          projectPath: demo/sample-app
        checkoutRoot: /work/sample-app
        reportsRoot: /var/lib/review/sample-app/reports
```

`instanceId` and `projectKey` match the OCR producer’s identifiers. Add an entry for each project, with a unique key and checkout root. The command uses the session’s exact canonical working directory to choose an entry. Launch the Team lead at the registered checkout root. Use an operator-controlled reports directory outside repositories whose contents can be changed by a merge request. Authentication uses the signed-in CLI. Keep deployment configuration and report contents in the private environment.

## Use

```text
/ocr-team preview <64-character-run-id>
/ocr-team import <64-character-run-id>
```

Preview lists proposed tasks and any previously assigned IDs. Import requires a complete reviewed diff and confirmed publication for each finding. It checks the open MR, target project, branches, base/start/head SHAs, diff version and target tip before each creation. GitLab access is read-only. Task content and command results are recorded in the receiving DSH session, so choose a session suitable for the report’s visibility.

The same project may produce several runs as its source or target changes. Use a fresh report for an updated MR. If a write was interrupted, replay the same run in the same root session to reconcile it with the Team journal.

## Migrate an existing installation

Prepare the project settings above. Disable the previous `/ocr-team` command owner, then enable the configured public bundle. Its first-line task marker is `[ocr-team:v1:<runId>:<findingFingerprint>]`. Keep the same Team root session and OCR report store during migration. Previewing a previously imported current run should return the existing task IDs. To roll back, disable this command owner and re-enable the previous one.
