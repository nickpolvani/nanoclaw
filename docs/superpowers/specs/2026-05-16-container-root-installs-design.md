# Container: allow arbitrary CLI tools + runtime software installs

**Date:** 2026-05-16
**Status:** Approved

> **Superseded (2026-05-18):** The "installs are ephemeral — wiped when
> the container exits (`--rm`)" property no longer holds. Containers are
> now persistent per group; see
> `2026-05-18-persistent-per-group-containers-design.md`. Root-install
> mechanism (sudo/PAM/passwd) is unchanged.

## Goal

Let the NanoClaw agent container run any CLI tool and install software
(e.g. `apt-get`, system packages) on demand during a task. Installs are
**ephemeral** — wiped when the container exits (`--rm` is retained).

## Context / current state

- Image: `node:22-slim` (`container/Dockerfile`). Full Debian userland with
  bash, git, gh, curl, chromium. **Outbound network is unrestricted.**
- The container runs as the host UID (`--user 501:20` on this host) — a UID
  not present in the image's `/etc/passwd`. It is intentionally non-root.
- Non-root is **required**: the agent runs the Claude Agent SDK with
  `permissionMode: 'bypassPermissions'` + `allowDangerouslySkipPermissions:
  true` (`container/agent-runner/src/index.ts:441`). claude-code refuses
  `--dangerously-skip-permissions` as root, so the container must stay
  non-root.

**Conclusion:** "run any CLI tool" already works. The only real gap is
operations needing root (`apt-get install`, writing to `/usr`, etc.).

## Approach (chosen: A — passwordless sudo)

Keep the container non-root (SDK stays functional); grant passwordless
`sudo` so the agent can perform privileged operations explicitly.

Rejected alternative B (run as root + `IS_SANDBOX=1`): relies on
undocumented/version-dependent SDK behavior, contradicts the Dockerfile's
explicit non-root design, and broadens the escape surface more.

## Changes

### `container/Dockerfile`

1. Add `sudo` to the `apt-get install` package list.
2. Add sudoers drop-in `/etc/sudoers.d/nanoclaw`:
   - `Defaults !requiretty`
   - `ALL ALL=(ALL) NOPASSWD: ALL`
   - `chmod 0440` the file.
   - Replace `/etc/pam.d/sudo` with a permissive stack
     (`pam_permit.so` for auth/account/session). The runtime-added passwd
     entry has no `/etc/shadow` match, so the default PAM unix stack rejects
     it ("account validation failure"). Since sudoers already grants
     unconditional NOPASSWD-ALL root, a permissive PAM stack is consistent
     and removes the shadow dependency.
3. `chmod 0666 /etc/passwd /etc/group` — the container runs with an
   arbitrary host UID:GID (gid 20, not group 0), so group-writable is
   insufficient; world-writable lets the entrypoint append a passwd entry
   at runtime. Acceptable since sudo is already NOPASSWD-ALL in this
   throwaway sandbox container.

### Entrypoint (the `printf` heredoc at `Dockerfile:61`)

Before launching node: if the current UID has no `/etc/passwd` entry,
append `nanoclaw:x:$(id -u):$(id -g):NanoClaw:/home/node:/bin/bash`.
`sudo` requires the invoking UID to resolve to a username, otherwise it
errors `unknown uid NNNN`.

### No changes

`src/container-runner.ts`, `src/container-runtime.ts` — `--user`, mounts,
`--rm`, network all unchanged.

## Result

The agent can run any CLI tool (already could) and
`sudo apt-get install <anything>` / write anywhere mid-task. Installs are
discarded on container exit. Applied via `./container/build.sh`.

## Security note

Every group's agent already gets the host `$HOME` mounted read-only plus
open internet. Adding root-in-container means a prompt-injected or
misbehaving agent can install/run arbitrary system software during a task
and has a larger container-escape surface. Accepted for this personal,
single-user setup.

## Verification

1. `./container/build.sh` succeeds.
2. `docker run --rm --user 501:20 <image> bash -lc 'whoami; id; sudo apt-get
   update >/dev/null 2>&1 && echo APT_OK; sudo whoami'` →
   non-root user resolves, `sudo whoami` prints `root`, `APT_OK` printed.
