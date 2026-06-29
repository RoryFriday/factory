# AI Software Factory

## What this is

An automated "assembly line" for AI-assisted software development, built
around the [ASDLC](https://asdlc.io) methodology. The core idea: instead of
an AI coding agent improvising against vague instructions, every unit of
work is a small, atomic **PBI (Product Backlog Item)** that points at a
permanent **Spec** (the contract for a feature) and is constrained by an
**AGENTS.md** constitution (architectural rules the agent must follow,
checked by deterministic gates rather than trusted on faith).

The goal is a repeatable pipeline: write a spec once, decompose it into
PBIs, let an AI agent implement each PBI in an isolated sandbox, verify the
result with deterministic gates (build, test, container checks), and keep
an audit trail of what happened — all running locally via Docker Compose
today, with a path to AWS (ECS, SQS, RDS) without a rewrite.

## Two separate things in this repo family

This project spans **two distinct codebases that must not be confused**:

1. **The factory itself** (`factory/`) — the orchestration system: a
   worker that launches AI agent sandboxes and runs verification gates, an
   API that manages the queue of work, a database that tracks state. This
   is infrastructure. You build it once and point it at different
   projects.
2. **The target repo** — whatever application the factory is actually
   building (e.g. a rate-limiting demo API). This repo contains
   `AGENTS.md`, `specs/`, `tasks/`, and the actual generated application
   code under `src/`. The factory treats this repo as data — it reads
   PBIs from it and writes code into it, but the factory's own code never
   lives inside it.

Keeping these separate (different folders, different git histories) is
deliberate: it's what lets the factory orchestrate many different target
repos over time without becoming entangled with any one of them.

## The contract layer: AGENTS.md, specs, and PBIs

Every target repo follows a standard template, established before any
application code exists:

```
target-repo/
├── AGENTS.md                 # root constitution — repo-wide, stack-agnostic
├── specs/
│   └── <feature>/spec.md     # permanent contract for one feature
├── tasks/
│   ├── _scaffolding/
│   │   └── PBI-000.md        # bootstraps the application itself
│   └── <feature>/
│       └── PBI-NNN.md        # atomic deltas against that feature's spec
└── src/
    ├── backend/
    │   └── AGENTS.md         # .NET-specific conventions
    └── frontend/
        └── AGENTS.md         # React/TypeScript conventions (template only
                               #   until a PBI actually needs a frontend)
```

**Key conventions this template encodes** (each one earned through actual
trial runs, not decided up front):

- **Nested AGENTS.md files.** The root file is stack-agnostic and covers
  cross-cutting rules (layout, containerization, Definition of Done,
  commit discipline). Stack-specific detail lives in `src/backend/` and
  `src/frontend/`'s own files. An agent reads whichever nested file
  applies to the part of the repo it's touching.
- **Flat backend layout.** `backend/` itself *is* the application — no
  nested `backend/<ApplicationName>/` folder. The `.sln` and the
  application's `.csproj` sit directly in `backend/`. Features get their
  own folder pair directly under `backend/`: `<FeatureName>/` for
  implementation, `<FeatureName>.Tests/` for tests — no shared test
  project spanning multiple features.
- **Names are derived, not asserted.** `<ApplicationName>` comes from the
  git repository's root folder name (PascalCased), not chosen by a PBI.
  `<FeatureName>` comes from the spec's own container folder name (e.g.
  `specs/rate-limiting/` → `RateLimiting`). PBIs never restate or
  re-invent these — they're computed facts, not decisions.
- **Containerization is a standing default, created once, then extended.**
  The first PBI that produces a runnable backend creates two Dockerfiles
  (`Dockerfile.<ApplicationName>` for the app, `Dockerfile.<ApplicationName>.tests`
  for tests — never one Dockerfile per feature) and a `docker-compose.yml`
  with `app`/`test` profiles so either can run independently. Every later
  PBI edits these files if it needs new container wiring; none of them
  recreate them from scratch.
- **PBIs are diffs against a known baseline, not re-explanations of it.**
  A PBI states what's specific to *this* task (which spec, what's
  explicitly out of scope, any judgment calls to flag) and trusts
  `AGENTS.md` for everything that's already a standing rule. If a PBI
  finds itself restating a layout convention AGENTS.md already covers,
  that's duplicated, driftable information and should be deleted.
- **One PBI, one Spec.** A PBI that touches two features should be split
  into two PBIs, even if they land in the same work session — this keeps
  each PBI atomic and its commits genuinely reviewable in isolation.

## Architecture: the factory

```
docker-compose.yml (factory/)
│
├── postgres            state: pbi, run, gate_result, commit_log tables
├── elasticmq            SQS-compatible local queue (swap for real SQS in AWS,
│                        no code changes needed elsewhere)
├── pi-sandbox            build-only service — produces the agent sandbox
│                        image, never runs as a long-lived container
├── orchestrator (Node/TS, Express)
│   - scans target-repo's tasks/ for PBI files, registers new ones
│   - enqueues a PBI, but only if its declared dependency has already
│     passed (otherwise marks it `blocked`)
│   - exposes status: GET /pbis, GET /pbis/:id, GET /runs/:id
│   - read-only mount of the target repo — it never writes code
│
└── worker (Node/TS)
    - polls the queue
    - launches a `pi-sandbox` container as a SIBLING (via host docker.sock,
      not docker-in-docker) with the target repo mounted read-write
    - runs `pi --mode rpc --no-session`, feeds it the PBI, captures the
      structured JSON event stream
    - on completion, runs deterministic gates against the target repo's
      OWN docker-compose.yml (`--profile app build`, `--profile test up`)
    - writes run + gate results back to Postgres
```

**Why it's shaped this way:**

- **The orchestrator is dumb on purpose.** All ASDLC-specific logic (PBI
  parsing, dependency resolution) lives here, not inside agent prompts —
  so the underlying coding agent (`pi`, today) is replaceable without
  rearchitecting anything.
- **Gates are fully deterministic, no LLM involved.** They're just
  `docker compose build`/`up` against the files the agent produced. This
  is what makes a PBI's pass/fail status trustworthy rather than another
  layer of AI judgment.
- **Local-to-cloud parity comes from one principle: don't nest
  containers.** Locally, the worker shells out to `docker run` via a
  mounted host socket. In AWS, the equivalent step becomes one `ecs:RunTask`
  call per PBI — each ECS task *is* the sandbox, no Docker-in-Docker
  required. ElasticMQ → real SQS is a pure config change (same API).
  Postgres → RDS likewise. The worker's core logic (launch sandbox, wait
  for completion, run gates, report result) doesn't change shape — only
  the "how do I start a sandboxed run" function does.
- **Stack: Node/TypeScript for the factory, deliberately.** Chosen after
  comparing against Python and C#: Node's event-driven `child_process`
  model fits "stream JSON lines from a long-running subprocess" better
  than the alternatives, and it keeps the whole non-application codebase
  to two languages (the factory in TS, target applications in .NET +
  TypeScript) rather than three.

## What's been built and proven so far

- The full AGENTS.md / specs / tasks template, refined over many rounds of
  real trial runs (see "Hard-won lessons" below).
- The complete `factory/` stack: schema, compose file, orchestrator,
  worker — running locally.
- **Two PBIs run successfully end-to-end**, in dependency order, against a
  real target repo:
  - `PBI-000` (scaffolding) — created a .NET 8 Minimal API project from
    nothing, containerized it, committed in atomic steps. ~5 minutes.
  - `PBI-001` (a rate-limiting feature, spec-driven) — implemented the
    feature behind an interface, with tests covering every scenario in
    the spec's Gherkin block, registered the middleware, committed
    separately from scaffolding. ~5.5 minutes.
  - Both PBIs passed their deterministic gates (`docker compose build` +
    `docker compose test up`) on the agent's *actual* output, not a dry
    run.
  - The dependency-blocking logic was confirmed working both directions:
    PBI-001 correctly returned `blocked` when tried before PBI-000 had
    passed, and correctly queued once PBI-000 genuinely passed.

## What's explicitly deferred (not forgotten, not yet needed)

- **Review Gate / Critic Agent** — a second `pi` invocation that reviews a
  diff against the spec for compliance, separate from the deterministic
  Quality Gate. Quality Gate alone has been sufficient so far.
- **Ralph Loop / autonomous retry** — currently single-shot: PBI → gates →
  pass/fail, no automatic re-attempt on failure. Worth adding once the
  single-shot path is trusted.
- **Concurrency** — PBIs run strictly one at a time today. Running several
  in parallel against the same repo reopens the merge-conflict and
  isolation questions ASDLC's PBI pattern is designed to manage, and
  hasn't been tackled yet.
- **Source control checkout/checkin as a factory concern** — today, the
  factory assumes the target repo already exists, cloned, on disk. Have
  the factory `git clone`/`git push` on the target repo's behalf is a
  known, deliberately deferred next layer.
- **Registry-hosted `pi-sandbox` image** — currently built locally via
  `docker compose --profile build-only build pi-sandbox`. Pointing
  `PI_SANDBOX_IMAGE` at a registry path (e.g. ECR) requires zero code
  changes; only the ECS `RunTask` migration (above) is a real rewrite.

## Hard-won lessons (read before changing the worker)

A few things that cost real debugging time and are easy to silently
regress if `agentRunner.ts` is rewritten without this context:

1. **`docker run -i` alone is not enough for Node's `spawn` to receive
   stdout reliably.** Explicit `-a stdin -a stdout -a stderr` attach flags
   are required — without them, the underlying agent runs and produces
   real output, but Node's piped stdio never sees it. This was the single
   biggest blocker in getting the worker working at all.
2. **`pi --mode rpc --no-session` does not exit on its own after one
   turn.** RPC mode is a persistent session protocol; it waits for further
   prompts indefinitely. The worker must watch for the `agent_end` event
   and explicitly close stdin (with a SIGTERM fallback a few seconds
   later) once it arrives — otherwise every run hangs until the hard
   timeout.
3. **Don't close stdin immediately after writing the initial prompt.**
   Doing so risks the pipe being torn down before `pi` has started inside
   the container and attached its own stdin reader. Write, then leave
   stdin open until `agent_end` says otherwise (point 2).
4. **Gate-running code and agent-running code need opposite path
   conventions.** `agentRunner.ts` launches a *sibling* container via the
   host's `docker.sock`, so it needs the **host** filesystem path
   (`HOST_TARGET_REPO_PATH`). `gateRunner.ts` runs `docker compose`
   *in-process* inside the worker container, so it needs the worker's own
   **container-internal** mount point (`/target-repo`). Mixing these up
   produces a confusing `ENOENT` on the `docker` binary itself, not an
   obviously-path-related error.
5. **Never pass secrets via `-e KEY=value` on a logged command line.**
   `--env-file` pointed at a short-lived temp file (0600 perms, deleted
   after the container starts) keeps secrets out of process listings and
   logs. This was fixed after a real key leaked into terminal scrollback
   during debugging — rotate immediately if this ever happens again.

## Running it

```bash
cd factory/
cp .env.example .env   # fill in TARGET_REPO_PATH, HOST_TARGET_REPO_PATH
                       # (same absolute path, both needed — see point 4
                       # above), ANTHROPIC_API_KEY, a real POSTGRES_PASSWORD

docker compose --profile build-only build pi-sandbox   # once, or after
                                                         # changing pi-sandbox/Dockerfile
docker compose up --build

curl -X POST http://localhost:8000/sync          # registers PBIs found in
                                                   # the target repo's tasks/
curl -X POST http://localhost:8000/pbis/<id>/enqueue
docker compose logs -f worker                     # watch it run
curl http://localhost:8000/pbis/<id>              # check status + run history
```