/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';

import { logger } from './logger.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Returns the shell command to stop a container by name. */
export function stopContainer(name: string): string {
  return `${CONTAINER_RUNTIME_BIN} stop ${name}`;
}

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

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    logger.debug('Container runtime already running');
  } catch (err) {
    logger.error({ err }, 'Failed to reach container runtime');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Container runtime failed to start                      ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without a container runtime. To fix:        ║',
    );
    console.error(
      '║  1. Ensure Docker is installed and running                     ║',
    );
    console.error(
      '║  2. Run: docker info                                           ║',
    );
    console.error(
      '║  3. Restart NanoClaw                                           ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Container runtime is required but failed to start');
  }
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter name=nanoclaw- --format '{{.Names}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        execSync(stopContainer(name), { stdio: 'pipe' });
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
