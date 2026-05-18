# Persistent Per-Group Containers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reuse one long-lived Docker container per group (created once, started/exec'd/stopped per task, never auto-removed) so software the agent installs persists across tasks.

**Architecture:** Replace the per-task `docker run -i --rm --name nanoclaw-<group>-<ts>` with a deterministic `nanoclaw-grp-<safeName>` container. `runContainerAgent` ensures the container exists (creating it with `sleep infinity` as PID 1 if missing, recreating it if the base image changed), starts it, runs the agent via `docker exec -i`, then `docker stop`s it. The container is only removed on image change or explicit `make reset-container`. Cross-group isolation (separate container + mounts per group) is unchanged.

**Tech Stack:** TypeScript (Node 22), Docker via Colima, Vitest, Bash entrypoint in `container/Dockerfile`, GNU Make.

---

## Spec

Design: `docs/superpowers/specs/2026-05-18-persistent-per-group-containers-design.md`

## File Structure

- `src/container-runtime.ts` — add container lifecycle helpers (`containerExists`, `isContainerRunning`, `containerImageLabel`, `imageId`, `startContainerCmd`, `removeContainerCmd`); rewrite `cleanupOrphans` to preserve `nanoclaw-grp-*` and remove only legacy timestamped containers. Runtime-command layer.
- `src/container-runner.ts` — deterministic container name; split arg building into shared `buildCommonArgs` + new `buildCreateArgs`; add `ensureGroupContainer`; switch the spawn from `docker run …` to `docker exec -i …`; `docker stop` (never `rm`) after each run. Orchestration layer.
- `container/Dockerfile` — make the entrypoint idempotent across repeated `exec`s in a persisted container (clean `/tmp/dist` and `/tmp/input.json` first).
- `Makefile` — `reset-container` / `reset-all-containers` targets.
- `docs/SECURITY.md` — rewrite isolation boundary #1 (no longer ephemeral).
- `docs/superpowers/specs/2026-05-16-container-root-installs-design.md` — superseding note.
- `src/container-runtime.test.ts` / `src/container-runner.test.ts` — tests for all of the above.

---

## Task 1: Container lifecycle helpers in container-runtime.ts

**Files:**
- Modify: `src/container-runtime.ts`
- Test: `src/container-runtime.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `src/container-runtime.test.ts` (extend the import from `./container-runtime.js` to include the new symbols, and append these `describe` blocks at end of file):

```ts
import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  stopContainer,
  ensureContainerRuntimeRunning,
  cleanupOrphans,
  containerExists,
  isContainerRunning,
  containerImageLabel,
  imageId,
  startContainerCmd,
  removeContainerCmd,
} from './container-runtime.js';

describe('startContainerCmd / removeContainerCmd', () => {
  it('build start and rm commands', () => {
    expect(startContainerCmd('nanoclaw-grp-x')).toBe(
      `${CONTAINER_RUNTIME_BIN} start nanoclaw-grp-x`,
    );
    expect(removeContainerCmd('nanoclaw-grp-x')).toBe(
      `${CONTAINER_RUNTIME_BIN} rm -f nanoclaw-grp-x`,
    );
  });
});

describe('containerExists', () => {
  it('true when inspect succeeds', () => {
    mockExecSync.mockReturnValueOnce('');
    expect(containerExists('nanoclaw-grp-x')).toBe(true);
    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} inspect nanoclaw-grp-x`,
      { stdio: 'pipe' },
    );
  });
  it('false when inspect throws', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('No such object');
    });
    expect(containerExists('nanoclaw-grp-x')).toBe(false);
  });
});

describe('isContainerRunning', () => {
  it('true when state is running', () => {
    mockExecSync.mockReturnValueOnce('true\n');
    expect(isContainerRunning('nanoclaw-grp-x')).toBe(true);
  });
  it('false when state is not running', () => {
    mockExecSync.mockReturnValueOnce('false\n');
    expect(isContainerRunning('nanoclaw-grp-x')).toBe(false);
  });
  it('false when inspect throws', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('No such object');
    });
    expect(isContainerRunning('nanoclaw-grp-x')).toBe(false);
  });
});

describe('containerImageLabel / imageId', () => {
  it('reads the nanoclaw.image label', () => {
    mockExecSync.mockReturnValueOnce('sha256:abc\n');
    expect(containerImageLabel('nanoclaw-grp-x')).toBe('sha256:abc');
    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} inspect -f '{{ index .Config.Labels "nanoclaw.image" }}' nanoclaw-grp-x`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
  });
  it('returns null when label missing/throws', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('no such container');
    });
    expect(containerImageLabel('nanoclaw-grp-x')).toBeNull();
  });
  it('resolves an image id', () => {
    mockExecSync.mockReturnValueOnce('sha256:def\n');
    expect(imageId('nanoclaw-agent:latest')).toBe('sha256:def');
    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} inspect -f '{{.Id}}' nanoclaw-agent:latest`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/nicco/Documents/projects/nanoclaw && npx vitest run src/container-runtime.test.ts`
Expected: FAIL — `containerExists`/`isContainerRunning`/`containerImageLabel`/`imageId`/`startContainerCmd`/`removeContainerCmd` not exported.

- [ ] **Step 3: Implement the helpers**

Append to `src/container-runtime.ts` (after `stopContainer`, before `ensureContainerRuntimeRunning`):

```ts
/** Returns the shell command to start a stopped container by name. */
export function startContainerCmd(name: string): string {
  return `${CONTAINER_RUNTIME_BIN} start ${name}`;
}

/** Returns the shell command to force-remove a container by name. */
export function removeContainerCmd(name: string): string {
  return `${CONTAINER_RUNTIME_BIN} rm -f ${name}`;
}

/** True if a container with this name exists (any state). */
export function containerExists(name: string): boolean {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} inspect ${name}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** True if the named container exists and is currently running. */
export function isContainerRunning(name: string): boolean {
  try {
    const out = execSync(
      `${CONTAINER_RUNTIME_BIN} inspect -f '{{.State.Running}}' ${name}`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

/** The `nanoclaw.image` label stamped on the container at create, or null. */
export function containerImageLabel(name: string): string | null {
  try {
    const out = execSync(
      `${CONTAINER_RUNTIME_BIN} inspect -f '{{ index .Config.Labels "nanoclaw.image" }}' ${name}`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const v = out.trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/** Resolve an image reference to its content id (sha256:…). */
export function imageId(image: string): string {
  return execSync(
    `${CONTAINER_RUNTIME_BIN} inspect -f '{{.Id}}' ${image}`,
    { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
  )
    .toString()
    .trim();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/nicco/Documents/projects/nanoclaw && npx vitest run src/container-runtime.test.ts`
Expected: PASS (existing `cleanupOrphans` tests still pass — unchanged in this task).

- [ ] **Step 5: Commit**

```bash
cd /Users/nicco/Documents/projects/nanoclaw
git add src/container-runtime.ts src/container-runtime.test.ts
git commit -m "feat(container): add container lifecycle helpers"
```

---

## Task 2: Rewrite cleanupOrphans to preserve persistent containers

**Files:**
- Modify: `src/container-runtime.ts` (`cleanupOrphans`)
- Test: `src/container-runtime.test.ts` (`describe('cleanupOrphans')`)

`nanoclaw-grp-*` = persistent (stop, never remove). `nanoclaw-<group>-<digits>` = legacy transient leftovers (remove).

- [ ] **Step 1: Replace the cleanupOrphans tests**

In `src/container-runtime.test.ts`, replace the entire `describe('cleanupOrphans', …)` block with:

```ts
describe('cleanupOrphans', () => {
  const PERSIST = /^nanoclaw-grp-/;

  it('stops (never removes) persistent grp containers and removes legacy ones', () => {
    // docker ps -a returns all nanoclaw containers
    mockExecSync.mockReturnValueOnce(
      'nanoclaw-grp-group1\nnanoclaw-group2-222\n',
    );
    mockExecSync.mockReturnValue('');

    cleanupOrphans();

    // ps + stop(grp) + rm -f(legacy)
    expect(mockExecSync).toHaveBeenNthCalledWith(
      1,
      `${CONTAINER_RUNTIME_BIN} ps -a --filter name=nanoclaw- --format '{{.Names}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} stop nanoclaw-grp-group1`,
      { stdio: 'pipe' },
    );
    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} rm -f nanoclaw-group2-222`,
      { stdio: 'pipe' },
    );
    // grp container is NEVER rm'd
    const calls = mockExecSync.mock.calls.map((c) => c[0]);
    expect(calls).not.toContain(
      `${CONTAINER_RUNTIME_BIN} rm -f nanoclaw-grp-group1`,
    );
    expect(logger.info).toHaveBeenCalled();
  });

  it('does nothing when no containers exist', () => {
    mockExecSync.mockReturnValueOnce('');
    cleanupOrphans();
    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('warns and continues when ps fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('docker not available');
    });
    cleanupOrphans();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to clean up orphaned containers',
    );
  });

  it('continues when one operation fails', () => {
    mockExecSync.mockReturnValueOnce('nanoclaw-grp-a\nnanoclaw-b-2\n');
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('already stopped');
    });
    mockExecSync.mockReturnValue('');
    cleanupOrphans(); // must not throw
    expect(logger.info).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/nicco/Documents/projects/nanoclaw && npx vitest run src/container-runtime.test.ts -t cleanupOrphans`
Expected: FAIL — current `cleanupOrphans` uses `docker ps` (not `ps -a`) and `stop` for everything.

- [ ] **Step 3: Rewrite cleanupOrphans**

Replace the entire `cleanupOrphans` function body in `src/container-runtime.ts` with:

```ts
/**
 * On startup: stop (never remove) persistent per-group containers so they
 * resume clean, and force-remove legacy transient `nanoclaw-<group>-<ts>`
 * leftovers from the pre-persistence model.
 */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps -a --filter name=nanoclaw- --format '{{.Names}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const names = output.trim().split('\n').filter(Boolean);
    if (names.length === 0) return;

    const stopped: string[] = [];
    const removed: string[] = [];
    for (const name of names) {
      try {
        if (/^nanoclaw-grp-/.test(name)) {
          execSync(stopContainer(name), { stdio: 'pipe' });
          stopped.push(name);
        } else {
          execSync(removeContainerCmd(name), { stdio: 'pipe' });
          removed.push(name);
        }
      } catch {
        /* already stopped / already gone */
      }
    }
    logger.info(
      { stopped, removed },
      'Cleaned up containers (persistent stopped, legacy removed)',
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/nicco/Documents/projects/nanoclaw && npx vitest run src/container-runtime.test.ts`
Expected: PASS (all describes).

- [ ] **Step 5: Commit**

```bash
cd /Users/nicco/Documents/projects/nanoclaw
git add src/container-runtime.ts src/container-runtime.test.ts
git commit -m "feat(container): cleanupOrphans preserves persistent containers"
```

---

## Task 3: Make the container entrypoint idempotent for repeated execs

**Files:**
- Modify: `container/Dockerfile` (the `printf … > /app/entrypoint.sh` line)

The current entrypoint runs `npx tsc --outDir /tmp/dist`, `ln -s … /tmp/dist/node_modules`, `chmod -R a-w /tmp/dist`. In a persistent container these paths survive between `exec`s, so the second task fails ("file exists" / read-only). Clean them first.

- [ ] **Step 1: Replace the entrypoint heredoc**

In `container/Dockerfile`, replace the line that begins `RUN printf '#!/bin/bash\nset -e\ngrep -q ":$(id -u):"` with exactly:

```dockerfile
RUN printf '#!/bin/bash\nset -e\nchmod -R u+w /tmp/dist 2>/dev/null || true\nrm -rf /tmp/dist /tmp/input.json\ngrep -q ":$(id -u):" /etc/passwd || echo "nanoclaw:x:$(id -u):$(id -g):NanoClaw:/home/node:/bin/bash" >> /etc/passwd\ncd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\nln -s /app/node_modules /tmp/dist/node_modules\nchmod -R a-w /tmp/dist\ncat > /tmp/input.json\nnode /tmp/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh
```

(Only change vs. current: the two new lines `chmod -R u+w /tmp/dist 2>/dev/null || true` and `rm -rf /tmp/dist /tmp/input.json` inserted right after `set -e`. The `grep -q … || …` passwd line is already idempotent and is retained.)

- [ ] **Step 2: Rebuild the image**

Run: `cd /Users/nicco/Documents/projects/nanoclaw && make build`
Expected: image `nanoclaw-agent:latest` rebuilds without error.

- [ ] **Step 3: Verify the entrypoint is repeat-safe**

Run:
```bash
docker rm -f nanoclaw-plan-t3 2>/dev/null; \
docker create -i --name nanoclaw-plan-t3 nanoclaw-agent:latest sleep infinity >/dev/null && \
docker start nanoclaw-plan-t3 >/dev/null && \
docker exec nanoclaw-plan-t3 bash -lc 'chmod -R u+w /tmp/dist 2>/dev/null || true; rm -rf /tmp/dist /tmp/input.json; cd /app && npx tsc --outDir /tmp/dist >/dev/null 2>&1; echo run1=$?' && \
docker exec nanoclaw-plan-t3 bash -lc 'chmod -R u+w /tmp/dist 2>/dev/null || true; rm -rf /tmp/dist /tmp/input.json; cd /app && npx tsc --outDir /tmp/dist >/dev/null 2>&1; echo run2=$?'; \
docker rm -f nanoclaw-plan-t3 >/dev/null
```
Expected: `run1=0` and `run2=0` (second compile in the same container succeeds).

- [ ] **Step 4: Commit**

```bash
cd /Users/nicco/Documents/projects/nanoclaw
git add container/Dockerfile
git commit -m "fix(container): make entrypoint idempotent across repeated execs"
```

---

## Task 4: Persistent container in container-runner.ts

**Files:**
- Modify: `src/container-runner.ts` (`buildContainerArgs`, `runContainerAgent`)
- Test: `src/container-runner.test.ts`

- [ ] **Step 1: Write failing tests**

In `src/container-runner.test.ts`, add a mock for the runtime module (place it next to the other `vi.mock` calls, before the `import { runContainerAgent }` line):

```ts
const rt = {
  containerExists: vi.fn(() => false),
  isContainerRunning: vi.fn(() => false),
  containerImageLabel: vi.fn(() => 'sha256:current'),
  imageId: vi.fn(() => 'sha256:current'),
  startContainerCmd: (n: string) => `docker start ${n}`,
  removeContainerCmd: (n: string) => `docker rm -f ${n}`,
  stopContainer: (n: string) => `docker stop ${n}`,
  readonlyMountArgs: (h: string, c: string) => ['-v', `${h}:${c}:ro`],
  CONTAINER_RUNTIME_BIN: 'docker',
};
vi.mock('./container-runtime.js', () => rt);
```

`ensureGroupContainer` issues create/start/rm synchronously via `execSync`, so add `execSync` to the existing `vi.mock('child_process', …)` factory (it currently returns only `spawn` and `exec`). Add this line inside that factory's returned object:

```ts
    execSync: vi.fn(() => ''),
```

so the factory returns `{ ...actual, spawn: vi.fn(() => fakeProc), exec: vi.fn(...), execSync: vi.fn(() => '') }`.

Then append this `describe` block at the end of the file:

```ts
import { spawn, exec } from 'child_process';

describe('persistent per-group container', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    rt.containerExists.mockReturnValue(false);
    rt.isContainerRunning.mockReturnValue(false);
    rt.containerImageLabel.mockReturnValue('sha256:current');
    rt.imageId.mockReturnValue('sha256:current');
  });
  afterEach(() => vi.useRealTimers());

  it('uses a deterministic per-group container name and execs into it', async () => {
    const p = runContainerAgent(testGroup, testInput, () => {}, vi.fn(async () => {}));
    await vi.advanceTimersByTimeAsync(10);
    emitOutputMarker(fakeProc, { status: 'success', result: null });
    fakeProc.emit('close', 0);
    await p;

    const spawnCalls = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const last = spawnCalls[spawnCalls.length - 1];
    expect(last[0]).toBe('docker');
    expect(last[1]).toEqual([
      'exec',
      '-i',
      'nanoclaw-grp-test-group',
      '/app/entrypoint.sh',
    ]);
  });

  it('creates the container (sleep infinity + image label) when missing', async () => {
    rt.containerExists.mockReturnValue(false);
    const { execSync } = await import('child_process');
    const execSyncMock = execSync as unknown as ReturnType<typeof vi.fn>;
    execSyncMock.mockClear();

    const p = runContainerAgent(testGroup, testInput, () => {}, vi.fn(async () => {}));
    await vi.advanceTimersByTimeAsync(10);
    emitOutputMarker(fakeProc, { status: 'success', result: null });
    fakeProc.emit('close', 0);
    await p;

    const createCmd = execSyncMock.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes(' create '));
    expect(createCmd).toBeTruthy();
    expect(createCmd).toContain('--name nanoclaw-grp-test-group');
    expect(createCmd).toContain('--label nanoclaw.image=sha256:current');
    expect(createCmd).toMatch(/sleep infinity$/);
  });

  it('recreates the container when the image id changed', async () => {
    rt.containerExists.mockReturnValue(true);
    rt.containerImageLabel.mockReturnValue('sha256:OLD');
    rt.imageId.mockReturnValue('sha256:current');
    const { execSync } = await import('child_process');
    const execSyncMock = execSync as unknown as ReturnType<typeof vi.fn>;
    execSyncMock.mockClear();

    const p = runContainerAgent(testGroup, testInput, () => {}, vi.fn(async () => {}));
    await vi.advanceTimersByTimeAsync(10);
    emitOutputMarker(fakeProc, { status: 'success', result: null });
    fakeProc.emit('close', 0);
    await p;

    const cmds = execSyncMock.mock.calls.map((c) => String(c[0]));
    expect(cmds).toContain('docker rm -f nanoclaw-grp-test-group');
  });

  it('stops (never removes) the container after a successful run', async () => {
    rt.containerExists.mockReturnValue(true);
    rt.isContainerRunning.mockReturnValue(true);
    const { execSync } = await import('child_process');
    const execMock = exec as unknown as ReturnType<typeof vi.fn>;
    const execSyncMock = execSync as unknown as ReturnType<typeof vi.fn>;
    execMock.mockClear();
    execSyncMock.mockClear();

    const p = runContainerAgent(testGroup, testInput, () => {}, vi.fn(async () => {}));
    await vi.advanceTimersByTimeAsync(10);
    emitOutputMarker(fakeProc, { status: 'success', result: null });
    fakeProc.emit('close', 0);
    await p;

    const execCmds = execMock.mock.calls.map((c) => String(c[0]));
    const execSyncCmds = execSyncMock.mock.calls.map((c) => String(c[0]));
    expect(execCmds).toContain('docker stop nanoclaw-grp-test-group');
    expect([...execCmds, ...execSyncCmds]).not.toContain(
      'docker rm -f nanoclaw-grp-test-group',
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/nicco/Documents/projects/nanoclaw && npx vitest run src/container-runner.test.ts -t "persistent per-group container"`
Expected: FAIL — name still has a timestamp, spawn still uses `run`, no `create`/`stop`-after-run.

- [ ] **Step 3: Refactor arg building (DRY: shared common args)**

In `src/container-runner.ts`, replace the whole `buildContainerArgs` function with the two functions below. `buildCommonArgs` holds the shared `-e`/`--user`/`-v` logic; `buildCreateArgs` produces the persistent-container create command.

```ts
function buildCommonArgs(mounts: VolumeMount[]): string[] {
  const args: string[] = [];

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);

  // Pass model selection if configured
  const claudeModel =
    process.env.CLAUDE_MODEL || readEnvFile(['CLAUDE_MODEL']).CLAUDE_MODEL;
  if (claudeModel) {
    args.push('-e', `CLAUDE_MODEL=${claudeModel}`);
  }

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  return args;
}

function buildCreateArgs(
  mounts: VolumeMount[],
  containerName: string,
  currentImageId: string,
): string[] {
  return [
    'create',
    '-i',
    '--name',
    containerName,
    '--label',
    `nanoclaw.image=${currentImageId}`,
    ...buildCommonArgs(mounts),
    CONTAINER_IMAGE,
    'sleep',
    'infinity',
  ];
}
```

- [ ] **Step 4: Add the lifecycle helper and switch to exec**

In `src/container-runner.ts`, change the `child_process` import (currently `import { ChildProcess, exec, spawn } from 'child_process';`) to also import `execSync`:

```ts
import { ChildProcess, exec, execSync, spawn } from 'child_process';
```

Extend the runtime import:

```ts
import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  stopContainer,
  containerExists,
  isContainerRunning,
  containerImageLabel,
  imageId,
  startContainerCmd,
  removeContainerCmd,
} from './container-runtime.js';
```

Add this synchronous helper just above `export async function runContainerAgent`:

```ts
/**
 * Ensure the group's persistent container exists, is on the current image,
 * and is running. Recreates it if the base image changed. Returns nothing;
 * throws only if create/start cannot be issued.
 */
function ensureGroupContainer(
  mounts: VolumeMount[],
  containerName: string,
): void {
  const currentImage = imageId(CONTAINER_IMAGE);

  if (containerExists(containerName)) {
    if (containerImageLabel(containerName) !== currentImage) {
      logger.info(
        { containerName },
        'Base image changed — recreating persistent container',
      );
      execSync(removeContainerCmd(containerName), { stdio: 'pipe' });
    }
  }

  if (!containerExists(containerName)) {
    const createArgs = buildCreateArgs(mounts, containerName, currentImage);
    logger.info({ containerName }, 'Creating persistent group container');
    execSync(`${CONTAINER_RUNTIME_BIN} ${createArgs.join(' ')}`, {
      stdio: 'pipe',
    });
  }

  if (!isContainerRunning(containerName)) {
    execSync(startContainerCmd(containerName), { stdio: 'pipe' });
  }
}
```

In `runContainerAgent`, replace these lines:

```ts
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-${safeName}-${Date.now()}`;
  const containerArgs = buildContainerArgs(mounts, containerName);
```

with:

```ts
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-grp-${safeName}`;
  ensureGroupContainer(mounts, containerName);
  const containerArgs = ['exec', '-i', containerName, '/app/entrypoint.sh'];
```

- [ ] **Step 5: Stop (never remove) the container after the run**

In `runContainerAgent`, the `container.on('close', (code) => { … })` handler resolves the promise in several branches. Add a single stop call at the **top** of the `'close'` handler so it runs on every completion path. Replace:

```ts
    container.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;
```

with:

```ts
    container.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      // Persistent container: the exec'd agent exited but `sleep infinity`
      // keeps the container alive. Stop it (filesystem persists; never rm).
      exec(stopContainer(containerName), { timeout: 15000 }, () => {});
```

The existing `killOnTimeout` already calls `exec(stopContainer(containerName), …)` — that remains correct (stop, not rm) and needs no change.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd /Users/nicco/Documents/projects/nanoclaw && npx vitest run src/container-runner.test.ts`
Expected: PASS — including the existing timeout/streaming tests (spawn is still mocked to `fakeProc`; only argv changed) and the new `persistent per-group container` describe.

- [ ] **Step 7: Typecheck**

Run: `cd /Users/nicco/Documents/projects/nanoclaw && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
cd /Users/nicco/Documents/projects/nanoclaw
git add src/container-runner.ts src/container-runner.test.ts
git commit -m "feat(container): persistent per-group container via create/start/exec/stop"
```

---

## Task 5: Make targets to reset containers

**Files:**
- Modify: `Makefile`

- [ ] **Step 1: Add the targets**

Append to `Makefile` (use a real TAB for recipe indentation, matching existing recipes):

```makefile
reset-container: ## Wipe one group's persistent container (GROUP=<folder>)
	@test -n "$(GROUP)" || (echo "Usage: make reset-container GROUP=<folder>" && exit 1)
	@name="nanoclaw-grp-$$(echo '$(GROUP)' | tr -c 'a-zA-Z0-9-' '-' | sed 's/-*$$//')"; \
		echo "Removing $$name"; docker rm -f "$$name" 2>/dev/null || true

reset-all-containers: ## Wipe ALL persistent per-group containers
	@names="$$(docker ps -a --filter name=nanoclaw-grp- --format '{{.Names}}')"; \
		if [ -n "$$names" ]; then echo "$$names" | xargs -r docker rm -f; \
		else echo "No persistent containers"; fi
```

Note: `tr -c 'a-zA-Z0-9-' '-'` mirrors the JS `replace(/[^a-zA-Z0-9-]/g, '-')`; the `sed` trims a trailing dash `tr` adds for the final newline so the name matches `containerName` exactly.

- [ ] **Step 2: Verify targets exist and validate input**

Run: `cd /Users/nicco/Documents/projects/nanoclaw && make reset-container 2>&1 | head -1`
Expected: `Usage: make reset-container GROUP=<folder>`

Run: `cd /Users/nicco/Documents/projects/nanoclaw && make help | grep reset`
Expected: both `reset-container` and `reset-all-containers` listed.

- [ ] **Step 3: Commit**

```bash
cd /Users/nicco/Documents/projects/nanoclaw
git add Makefile
git commit -m "feat(container): make reset-container / reset-all-containers"
```

---

## Task 6: Update security docs

**Files:**
- Modify: `docs/SECURITY.md`
- Modify: `docs/superpowers/specs/2026-05-16-container-root-installs-design.md`

- [ ] **Step 1: Rewrite isolation boundary #1 in SECURITY.md**

In `docs/SECURITY.md`, under `### 1. Container Isolation (Primary Boundary)`, replace the bullet line:

```
- **Ephemeral containers** - Fresh environment per invocation (`--rm`)
```

with:

```
- **Persistent per-group containers** - Each group reuses one long-lived
  container (`nanoclaw-grp-<group>`), stopped between tasks and never
  auto-removed, so agent-installed software persists. **Trade-off:**
  filesystem changes and any side effects of a prompt-injected or
  misbehaving agent persist and compound across that group's future tasks
  (previously each task started clean). **Cross-group isolation is
  unchanged** — separate container and mounts per group; a group cannot
  see another group's container or files. Recovery: `make reset-container
  GROUP=<folder>` wipes a group's container; the base image changing
  auto-recreates it.
```

- [ ] **Step 2: Add a superseding note to the 2026-05-16 design**

At the top of `docs/superpowers/specs/2026-05-16-container-root-installs-design.md`, immediately after the `**Status:** Approved` line, insert:

```
> **Superseded (2026-05-18):** The "installs are ephemeral — wiped when
> the container exits (`--rm`)" property no longer holds. Containers are
> now persistent per group; see
> `2026-05-18-persistent-per-group-containers-design.md`. Root-install
> mechanism (sudo/PAM/passwd) is unchanged.
```

- [ ] **Step 3: Commit**

```bash
cd /Users/nicco/Documents/projects/nanoclaw
git add docs/SECURITY.md docs/superpowers/specs/2026-05-16-container-root-installs-design.md
git commit -m "docs: security model now persistent per-group containers"
```

---

## Task 7: End-to-end verification (manual, against live Colima)

**Files:** none (verification only)

- [ ] **Step 1: Full unit suite green**

Run: `cd /Users/nicco/Documents/projects/nanoclaw && npx vitest run`
Expected: all tests pass.

- [ ] **Step 2: Persistence across two tasks (spec verification 1–2)**

With nanoclaw running (`make status` shows it up), send the test/main group a message that runs: `sudo apt-get update >/dev/null 2>&1 && sudo apt-get install -y sl && echo INSTALLED_SL`. Then, in a **second** message to the same group, run: `which sl && echo SL_STILL_HERE`.
Expected: first task prints `INSTALLED_SL`; `docker ps -a` shows `nanoclaw-grp-<group>` `Exited` (not removed) between tasks; second task prints `SL_STILL_HERE`.

- [ ] **Step 3: Cross-group isolation (spec verification 3)**

Trigger a second, different group. Run `docker ps -a --filter name=nanoclaw-grp-`.
Expected: two distinct `nanoclaw-grp-*` containers; `which sl` in the second group fails (its own container, no `sl`).

- [ ] **Step 4: Reset (spec verification 4)**

Run: `cd /Users/nicco/Documents/projects/nanoclaw && make reset-container GROUP=<first-group-folder>` then `docker ps -a --filter name=nanoclaw-grp-`.
Expected: that container is gone. Re-trigger the group; `which sl` now fails (fresh container).

- [ ] **Step 5: Image-change auto-recreate (spec verification 5)**

Re-trigger the group so `sl` is reinstalled and present. Run `make build` (rebuilds the image → new id). Re-trigger the group; run `which sl`.
Expected: container auto-recreated (logs: "Base image changed — recreating"); `which sl` fails.

- [ ] **Step 6: Orphan cleanup on restart (spec verification 6)**

With a stopped `nanoclaw-grp-*` present, run `make restart`; then `docker ps -a --filter name=nanoclaw-grp-`.
Expected: the `nanoclaw-grp-*` container is still present (stopped), not removed.

- [ ] **Step 7: Final commit (if any docs/notes updated during verification)**

```bash
cd /Users/nicco/Documents/projects/nanoclaw
git status --porcelain
# commit only if verification required a fix; otherwise nothing to do
```

---

## Self-Review Notes

- **Spec coverage:** §1 identity/lifecycle → Task 4; §2 creation/`sleep infinity`/passwd-per-exec idempotency → Tasks 3–4; §3 secrets/IO unchanged → Task 4 keeps stdin/marker logic, only argv changes; §4 cleanupOrphans/reset/image-change → Tasks 2, 4, 5; §5 security docs → Task 6; §6 testing → Tasks 1,2,4 unit + Task 7 e2e. All spec verification items (1–6) map to Task 7 steps 2–6.
- **Placeholder scan:** none — every step has concrete code/commands.
- **Type consistency:** helper names (`containerExists`, `isContainerRunning`, `containerImageLabel`, `imageId`, `startContainerCmd`, `removeContainerCmd`, `buildCommonArgs`, `buildCreateArgs`, `ensureGroupContainer`) and the container name (`nanoclaw-grp-<safeName>`) are used identically across Tasks 1, 4, 5 and tests.
