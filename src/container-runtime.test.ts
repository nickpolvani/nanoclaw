import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock child_process — store the mock fn so tests can configure it
const mockExecSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

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
import { logger } from './logger.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Pure functions ---

describe('readonlyMountArgs', () => {
  it('returns -v flag with :ro suffix', () => {
    const args = readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual(['-v', '/host/path:/container/path:ro']);
  });
});

describe('stopContainer', () => {
  it('returns stop command using CONTAINER_RUNTIME_BIN', () => {
    expect(stopContainer('nanoclaw-test-123')).toBe(
      `${CONTAINER_RUNTIME_BIN} stop nanoclaw-test-123`,
    );
  });
});

// --- ensureContainerRuntimeRunning ---

describe('ensureContainerRuntimeRunning', () => {
  it('does nothing when runtime is already running', () => {
    mockExecSync.mockReturnValueOnce('');

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    expect(logger.debug).toHaveBeenCalledWith(
      'Container runtime already running',
    );
  });

  it('throws when docker info fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('Cannot connect to the Docker daemon');
    });

    expect(() => ensureContainerRuntimeRunning()).toThrow(
      'Container runtime is required but failed to start',
    );
    expect(logger.error).toHaveBeenCalled();
  });
});

// --- cleanupOrphans ---

describe('cleanupOrphans', () => {
  it('stops orphaned nanoclaw containers', () => {
    // docker ps returns container names, one per line
    mockExecSync.mockReturnValueOnce(
      'nanoclaw-group1-111\nnanoclaw-group2-222\n',
    );
    // stop calls succeed
    mockExecSync.mockReturnValue('');

    cleanupOrphans();

    // ps + 2 stop calls
    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(mockExecSync).toHaveBeenNthCalledWith(
      2,
      `${CONTAINER_RUNTIME_BIN} stop nanoclaw-group1-111`,
      { stdio: 'pipe' },
    );
    expect(mockExecSync).toHaveBeenNthCalledWith(
      3,
      `${CONTAINER_RUNTIME_BIN} stop nanoclaw-group2-222`,
      { stdio: 'pipe' },
    );
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['nanoclaw-group1-111', 'nanoclaw-group2-222'] },
      'Stopped orphaned containers',
    );
  });

  it('does nothing when no orphans exist', () => {
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('warns and continues when ps fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('docker not available');
    });

    cleanupOrphans(); // should not throw

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to clean up orphaned containers',
    );
  });

  it('continues stopping remaining containers when one stop fails', () => {
    mockExecSync.mockReturnValueOnce('nanoclaw-a-1\nnanoclaw-b-2\n');
    // First stop fails
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('already stopped');
    });
    // Second stop succeeds
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans(); // should not throw

    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['nanoclaw-a-1', 'nanoclaw-b-2'] },
      'Stopped orphaned containers',
    );
  });
});

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
    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} inspect -f '{{.State.Running}}' nanoclaw-grp-x`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
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
  it('returns null when the label is blank', () => {
    mockExecSync.mockReturnValueOnce('\n');
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
  it('throws a clear error when the image is missing', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('No such image');
    });
    expect(() => imageId('nanoclaw-agent:latest')).toThrow(
      "Image 'nanoclaw-agent:latest' not found",
    );
  });
});
