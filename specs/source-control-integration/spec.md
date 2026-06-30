# Spec: Source Control Integration

## Blueprint

### Architecture
The factory currently assumes the target repo already exists as a local
directory pointed to by `TARGET_REPO_PATH`. This spec adds explicit git
lifecycle management: the orchestrator clones the repo before a PBI is
enqueued, and the worker pushes (or opens a PR) after a PBI's gates pass.

- **Clone**: the orchestrator, on receiving an enqueue request, checks
  whether the target repo is already cloned. If not, it clones it into a
  known local path. If yes, it pulls latest on the default branch before
  enqueuing, so every PBI run starts from the current HEAD.
- **Push**: the worker, after all gates pass, pushes the agent's commits
  to a branch on the remote. Branch naming convention:
  `factory/<pbi-number>` (e.g. `factory/PBI-001`). The worker does NOT
  merge to the default branch — that remains a human-gated step (or a
  future Acceptance Gate).
- **No credentials baked in**: git credentials are provided via
  environment variables (`GIT_REPO_URL`, `GIT_TOKEN`) injected at runtime,
  not hardcoded in any image or config file.
- **Idempotency**: if the branch `factory/<pbi-number>` already exists on
  the remote (e.g. from a previous failed run), the push force-updates it.

  Missing git config prerequisite. The agent commits code, but
git commit requires user.name and user.email to be configured.
In a fresh Docker sandbox these are unset, which causes git commit to
fail with an unhelpful error. The pi-sandbox Dockerfile should set
these as environment variables or a baked-in .gitconfig.

### Anti-Patterns
- Do not bake git credentials into any Dockerfile, image layer, or
  committed config file.
- Do not merge to the default branch automatically — leave that for a
  human or a future Acceptance Gate to decide.
- Do not clone on every poll cycle — clone once per repo, pull on each
  new PBI enqueue.

## Contract

### Definition of Done
- [ ] `GIT_REPO_URL` and `GIT_TOKEN` environment variables are read by
      the orchestrator and worker at startup; the system fails with a
      clear error if either is missing when source control is enabled.
- [ ] A new `source_control_enabled` boolean flag in the orchestrator's
      config (env var) gates this feature — when false, behaviour is
      identical to today (local directory, no clone/push).
- [ ] On enqueue (when enabled), the orchestrator clones the repo if it
      doesn't exist locally, or runs `git pull` on the default branch if
      it does.
- [ ] On gate pass, the worker pushes the PBI's commits to
      `factory/<pbi-number>` on the remote, force-updating if the branch
      already exists.
- [ ] On gate fail, no push occurs. The Postgres `run` record retains the
      local commits for inspection.
- [ ] `GET /pbis/:id` includes the remote branch name and push status
      (e.g. `pushed`, `not_pushed`, `push_failed`) once available.
      
- [ ] factory/pi-sandbox/Dockerfile sets GIT_AUTHOR_NAME,
GIT_AUTHOR_EMAIL, GIT_COMMITTER_NAME, GIT_COMMITTER_EMAIL as
ENV variables so git commit works in a fresh sandbox without
explicit config.

### Regression Guardrails
- When `source_control_enabled=false`, every existing behaviour (local
  directory, sync, enqueue, gate execution, status reporting) must remain
  exactly as it is today. This flag must be false by default.
- Existing `.env.example` must be updated with the new variables and
  clear comments; no existing variable should change name or default
  behaviour.

### Scenarios

```gherkin
Scenario: First enqueue clones the repo
  Given source_control_enabled is true
  And the target repo directory does not exist locally
  When a PBI is enqueued
  Then the orchestrator clones GIT_REPO_URL into TARGET_REPO_PATH
  And the enqueue proceeds normally

Scenario: Subsequent enqueue pulls latest
  Given source_control_enabled is true
  And the target repo directory already exists
  When a PBI is enqueued
  Then the orchestrator runs git pull on the default branch
  And the enqueue proceeds normally

Scenario: Gate pass triggers push
  Given a PBI run has completed with all gates passing
  And source_control_enabled is true
  When the worker finalises the run
  Then the agent's commits are pushed to factory/<pbi-number> on the remote
  And the run record is updated with branch name and status pushed

Scenario: Gate fail suppresses push
  Given a PBI run has completed with at least one gate failing
  When the worker finalises the run
  Then no push occurs regardless of source_control_enabled

Scenario: Feature is off by default
  Given source_control_enabled is false or unset
  When any part of the factory runs
  Then no git clone, pull, or push is attempted
```