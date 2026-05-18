import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  TIMEZONE: 'America/Los_Angeles',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

const rt = vi.hoisted(() => ({
  containerExists: vi.fn(() => false),
  isContainerRunning: vi.fn(() => false),
  containerImageLabel: vi.fn(() => 'sha256:current'),
  imageId: vi.fn(() => 'sha256:current'),
  startContainerCmd: (n: string) => `docker start ${n}`,
  removeContainerCmd: (n: string) => `docker rm -f ${n}`,
  stopContainer: (n: string) => `docker stop ${n}`,
  readonlyMountArgs: (h: string, c: string) => ['-v', `${h}:${c}:ro`],
  CONTAINER_RUNTIME_BIN: 'docker',
}));
vi.mock('./container-runtime.js', () => rt);

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
    execSync: vi.fn(() => ''),
  };
});

import { spawn, exec } from 'child_process';

import { runContainerAgent, ContainerOutput } from './container-runner.js';
import type { RegisteredGroup } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });
});

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
    const p = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      vi.fn(async () => {}),
    );
    await vi.advanceTimersByTimeAsync(10);
    emitOutputMarker(fakeProc, { status: 'success', result: null });
    fakeProc.emit('close', 0);
    await p;

    const spawnCalls = (spawn as unknown as ReturnType<typeof vi.fn>).mock
      .calls;
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

    const p = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      vi.fn(async () => {}),
    );
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

    const p = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      vi.fn(async () => {}),
    );
    await vi.advanceTimersByTimeAsync(10);
    emitOutputMarker(fakeProc, { status: 'success', result: null });
    fakeProc.emit('close', 0);
    await p;

    const cmds = execSyncMock.mock.calls.map((c) => String(c[0]));
    expect(cmds).toContain('docker rm -f nanoclaw-grp-test-group');
    expect(
      cmds.some(
        (s) =>
          s.includes(' create ') &&
          s.includes('--name nanoclaw-grp-test-group'),
      ),
    ).toBe(true);
  });

  it('stops (never removes) the container after a successful run', async () => {
    rt.containerExists.mockReturnValue(true);
    rt.isContainerRunning.mockReturnValue(true);
    const { execSync } = await import('child_process');
    const execMock = exec as unknown as ReturnType<typeof vi.fn>;
    const execSyncMock = execSync as unknown as ReturnType<typeof vi.fn>;
    execMock.mockClear();
    execSyncMock.mockClear();

    const p = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      vi.fn(async () => {}),
    );
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
