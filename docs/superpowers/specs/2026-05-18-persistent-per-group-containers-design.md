# Persistent per-group containers

**Date:** 2026-05-18
**Status:** Approved

## Goal

Make software the agent installs during a task (e.g. speech-transcription
and audio-message tooling: `apt-get` system packages, `pip`/`npm -g`
packages, downloaded binaries) **persist across tasks**, instead of being
wiped when the container exits.

A "task" = one agent invocation. Today every task does
`docker run -i --rm --name nanoclaw-<group>-<timestamp>`: a fresh
throwaway container per invocation, removed on exit, so nothing the agent
installs survives.

## Decision summary

- **Approach A — persistent per-group container.** Stop discarding the
  container; reuse one long-lived container per group. Chosen over
  committing-to-an-image (B, image bloat + per-run latency) and a
  persistent install prefix (C, cannot persist `apt-get` system packages,
  so it fails the explicit "anything the agent installs" requirement).
- **Lifecycle: stop between tasks.** `docker stop` after each run,
  `docker start` + `docker exec` on the next. The filesystem (installed
  software) persists across stop/start — only an explicit `docker rm`
  wipes it. No idle RAM; `docker start` latency (~0.5–2s on Colima) is
  marginal and dwarfed by the unavoidable Node + Claude Agent SDK init
  every task pays regardless.
- **Applies uniformly to all groups.** No per-group opt-in.

## Context / current state

- Runtime is Docker via `src/container-runtime.ts`
  (`CONTAINER_RUNTIME_BIN = 'docker'`). The host now runs Colima, which
  provides the Docker daemon; the `docker` CLI is unchanged, so
  `start`/`exec`/`stop` behave identically. Bind-mount host paths must be
  visible inside Colima's VM — this already holds for the current `--rm`
  runs and is unchanged here.
- `src/container-runner.ts`: `buildContainerArgs` →
  `run -i --rm --name nanoclaw-<safeName>-<Date.now()>` + mounts +
  `-e TZ`, optional `-e CLAUDE_MODEL`, optional `--user <uid>:<gid>`
  + `-e HOME=/home/node`. Spawned via `spawn`, input (incl. secrets) sent
  on stdin as JSON, stdout parsed for `OUTPUT_START/END` markers, hard/idle
  timeout → `docker stop`.
- `runContainerAgent(group, input, …)` is the single entry point, called
  from `src/index.ts` (message-driven) and `src/task-scheduler.ts`
  (scheduled). `input.isMain` only changes mounts/visibility and is
  constant per group (a group is always main or not).
- `src/group-queue.ts` serializes tasks **per group** (`state.active`
  gates one task per group at a time; `MAX_CONCURRENT_CONTAINERS` is a
  global cap). No intra-group container concurrency. `isTaskContainer` is
  queue bookkeeping (scheduled vs message run) — both go through
  `runContainerAgent` for the same group and the same per-group container.
- `cleanupOrphans()` (`src/container-runtime.ts`) `docker stop`s every
  `nanoclaw-*` container on startup.
- Container entrypoint (`container/Dockerfile`) appends a `/etc/passwd`
  entry for the host UID (sudo needs the UID to resolve), then runs the
  agent-runner once and exits.
- `docs/SECURITY.md` boundary #1: "Ephemeral containers — fresh
  environment per invocation (`--rm`)".
- `docs/superpowers/specs/2026-05-16-container-root-installs-design.md`
  states installs are wiped on exit (`--rm` retained). Superseded here.

## Design

### 1. Container identity & lifecycle

- Deterministic, persistent per-group name: **`nanoclaw-grp-<safeName>`**,
  where `safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-')` (same
  sanitization as today). No timestamp. One container per group folder.
- States: not-created → created (stopped) → running → stopped (loop).
  The container is **never `docker rm`'d automatically** except on
  image-id change (§4) or explicit reset (§4).
- Per-task flow in `runContainerAgent`:
  1. **Ensure exists:** look up the container by name. If missing →
     create (§2).
  2. **Image-id check:** if the container's `nanoclaw.image` label ≠ the
     resolved image id of `CONTAINER_IMAGE` (the constant in
     `container-runner.ts`, currently `nanoclaw-agent:latest`) →
     `docker rm -f` + recreate (§2, §4).
  3. **Ensure started:** if not running → `docker start <name>`.
  4. **Run agent:** `docker exec -i <name> <agent cmd>` (§2, §3).
  5. **On completion or timeout:** `docker stop <name>` (graceful, then
     SIGKILL fallback as today). Never `docker rm`.

### 2. Container creation

- The container's main process must be long-lived (today's image CMD runs
  the agent once and exits — unusable as a persistent container's PID 1).
  Create with:

  ```
  docker create -i --name nanoclaw-grp-<safeName> \
    --label nanoclaw.image=<current image id> \
    [same mounts as today] \
    -e TZ=<tz> [-e CLAUDE_MODEL=…] [--user <uid>:<gid> -e HOME=/home/node] \
    <CONTAINER_IMAGE> sleep infinity
  ```

  followed by `docker start`.
- The host-UID → `/etc/passwd` fixup currently in the one-shot entrypoint
  moves into a small **per-`exec` wrapper**, made idempotent (append the
  `nanoclaw:x:<uid>:<gid>:…:/home/node:/bin/bash` line only if a line for
  that UID is absent), which then `exec`s `node` on the agent-runner.
  Each task runs `docker exec -i <name> <wrapper> …`.
- Mounts are fixed at create time. They are stable per group; changing
  them (project path moves, edited `containerConfig.additionalMounts`)
  requires recreation — covered by reset/image-change (§4) or explicit
  `reset-container`.

### 3. Secrets & I/O — unchanged

`readSecrets()` → input incl. secrets sent as `JSON.stringify(input)` on
`docker exec -i` stdin → deleted from memory after send; never written to
disk or mounted. stdout `OUTPUT_START/END` streaming, stderr → logger,
idle/hard timeout reset: identical to today. The only change is
`docker run` → `docker exec` into an already-started container.

### 4. Startup cleanup, reset & image changes

- **`cleanupOrphans()`** on nanoclaw startup:
  - `nanoclaw-grp-*`: ensure **stopped** (clean baseline), **never
    removed** — filesystem preserved.
  - Legacy `nanoclaw-<group>-<timestamp>` leftovers from the old model:
    `docker rm -f` (genuine orphans).
- **Reset escape hatch** (required — state now accumulates; a broken or
  prompt-injection-poisoned container is sticky):
  - `make reset-container GROUP=<folder>` →
    `docker rm -f nanoclaw-grp-<safeName>`; next task recreates fresh.
  - `make reset-all-containers` → all `nanoclaw-grp-*`.
- **Image-change handling:** persistent containers otherwise keep running
  the stale image after a rebuild. Containers are stamped at create with
  label `nanoclaw.image=<image id>`. Per-task step 2 (§1) compares it to
  the current image id; mismatch → `docker rm -f` + recreate from the new
  image. This is the **only automatic** recreation; installed software is
  lost then (the alternative — silently running a stale base forever — is
  worse). Documented in SECURITY.md and the README/ops docs.

### 5. Security model update

- `docs/SECURITY.md` boundary #1 is rewritten: containers are
  **persistent per group**, not ephemeral. Installed software, filesystem
  changes, and side effects of a prompt-injected or misbehaving agent
  **persist and compound across that group's future tasks** (previously
  each task started clean).
- **Cross-group isolation is unchanged**: one container per group,
  separate mounts; a group still cannot see another group's container or
  files. The weakened property is *temporal* (within a group across time),
  not *cross-group*.
- Recovery contract: `reset-container` is the documented remediation —
  recommended after risky tasks or anomalous behavior.
- Add a superseding note to
  `docs/superpowers/specs/2026-05-16-container-root-installs-design.md`
  ("installs wiped on exit" no longer holds).

### 6. Testing

- **Unit** (`src/container-runner.test.ts`, migrated from run- to
  exec-model with docker mocked):
  - Container name is deterministic per group; differs across groups.
  - exists → skip create; missing → create; not running → start.
  - exec wiring unchanged: stdin/secrets payload, `OUTPUT` marker parsing,
    idle/hard timeout reset.
  - Normal completion → `docker stop`, never auto-`docker rm`.
  - Timeout → graceful `docker stop`, SIGKILL fallback, never auto-`rm`.
  - Container `nanoclaw.image` label ≠ current image id → `rm -f` +
    recreate.
- **Cross-group / reuse:** two groups → two distinct container names; two
  sequential runs for one group reuse the same container (asserted: not
  removed between runs; a file written into the container during run 1 is
  still present in run 2).
- **`cleanupOrphans`:** `nanoclaw-grp-*` preserved (stopped, not removed);
  legacy timestamped containers removed.

## Out of scope (YAGNI)

- Per-group opt-in — applies uniformly to all groups.
- Filesystem size limits / GC of accumulated state — manual
  `reset-container` is the documented control.
- Keep-running-idle mode — decided: stop between tasks.
- Approaches B (commit-to-image) and C (persistent prefix) — rejected
  above.

## Verification

1. Trigger a task for a group; confirm a `nanoclaw-grp-<safe>` container
   is created and, after the run, exists in `docker ps -a` with status
   `Exited` (not removed).
2. In a task, `sudo apt-get install -y <pkg>` (e.g. `sl`); in a *second*
   task for the same group, confirm the binary is still present.
3. Trigger two different groups; confirm two distinct
   `nanoclaw-grp-*` containers and that neither sees the other's installs.
4. `make reset-container GROUP=<folder>`; confirm the container is gone
   and the next task recreates it without the previously installed pkg.
5. Rebuild the image; confirm the next task auto-recreates the container
   (label mismatch) and the previously installed pkg is gone.
6. Restart nanoclaw mid-idle; confirm `cleanupOrphans` leaves
   `nanoclaw-grp-*` present (stopped), not removed.
