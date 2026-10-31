#!/usr/bin/env node
/**
 * Git pre-commit hook that runs `act` with a hard wall-clock deadline.
 *
 * Defaults target the `qnode` job of `.github/workflows/ci.yml`, run the
 * `push` event through rootless Podman, and fail the commit when the act run
 * takes longer than 30 seconds (even if act itself would have succeeded).
 *
 * Environment:
 *   ACT_PRECOMMIT_SKIP=1              Skip the hook entirely.
 *   ACT_PRECOMMIT_TIMEOUT_MS=30000    Hard deadline for the act process.
 *   ACT_PRECOMMIT_JOB=qnode           Job id to run.
 *   ACT_PRECOMMIT_WORKFLOW=<path>     Workflow file (default ci.yml).
 *   ACT_PRECOMMIT_EVENT=push          GitHub event name.
 *   ACT_PRECOMMIT_RUNTIME=auto        auto | podman | docker.
 *   ACT_PRECOMMIT_ARGS=<args>         Full argument override (after `act`).
 *   ACT_PRECOMMIT_IMAGE=<image>       Runner image (default qnode-act-runner:latest).
 *   ACT_PRECOMMIT_IMAGE_BUILD=0|1     Build the runner image when missing
 *                                     (default: on for the default image).
 *   ACT_PRECOMMIT_BASE_IMAGE=<image>  Base image for the runner image build.
 *   ACT_PRECOMMIT_BUILD_TIMEOUT_MS=600000
 *                                     Image build deadline.
 *   ACT_PRECOMMIT_PULL=0|1            Pull the runner image before running.
 *   ACT_PRECOMMIT_SOCKET=<path>       Podman API socket path override.
 *   ACT_PRECOMMIT_DOCKER_USER=<u:g>   --user for Docker fallback (default uid:gid).
 *   ACT_BIN=act                       act executable to use.
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_JOB = 'qnode';
const DEFAULT_WORKFLOW = '.github/workflows/ci.yml';
const DEFAULT_EVENT = 'push';
const DEFAULT_IMAGE = 'qnode-act-runner:latest';
const DEFAULT_BASE_IMAGE = 'catthehacker/ubuntu:act-latest';
const RUNNER_DOCKERFILE = 'scripts/act-runner.Dockerfile';
const DEFAULT_BUILD_TIMEOUT_MS = 600_000;
const SERVICE_IDLE_SECONDS = '600';

/** @param {string} name @returns {string | null} */
function which(name) {
  const executable = (candidate) => {
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile()) return false;
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };

  if (name.includes('/') || name.includes('\\')) {
    return executable(name) ? name : null;
  }

  const isWindows = process.platform === 'win32';
  const exts = isWindows ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (executable(candidate)) return candidate;
    }
  }
  return null;
}

/** @param {number} ms */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {string} socketPath
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
function canConnect(socketPath, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ path: socketPath });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

/**
 * Split a command line into arguments, honouring single/double quotes.
 * @param {string} input
 * @returns {string[]}
 */
function splitArgs(input) {
  const out = [];
  let current = '';
  let quote = null;
  let started = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && quote === '"' && i + 1 < input.length) {
        i += 1;
        current += input[i];
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started || current) {
        out.push(current);
        current = '';
        started = false;
      }
    } else {
      current += ch;
      started = true;
    }
  }
  if (started || current) out.push(current);
  return out;
}

/** @returns {number} */
function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : 0;
}

/** @returns {number} */
function currentGid() {
  return typeof process.getgid === 'function' ? process.getgid() : 0;
}

/**
 * act asks which default runner image to use on first run and then blocks on
 * stdin, which a hook does not provide. Seed its config with the medium image
 * mapping so the hook never prompts.
 * @returns {string} path to the actrc that will be used
 */
function ensureActConfig() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const file = path.join(base, 'act', 'actrc');
  if (fs.existsSync(file)) return file;

  const mappings = [
    '-P ubuntu-latest=catthehacker/ubuntu:act-latest',
    '-P ubuntu-24.04=catthehacker/ubuntu:act-latest',
    '-P ubuntu-22.04=catthehacker/ubuntu:act-22.04',
    '-P ubuntu-20.04=catthehacker/ubuntu:act-20.04',
    '-P ubuntu-18.04=catthehacker/ubuntu:act-18.04',
  ];

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${mappings.join('\n')}\n`, { mode: 0o644, flag: 'wx' });
    process.stderr.write(`[act-precommit] created ${file} with default runner image mappings\n`);
  } catch (error) {
    if (!error || error.code !== 'EEXIST') {
      process.stderr.write(
        `[act-precommit] WARNING: could not create ${file}: ${error && error.message ? error.message : error}\n`,
      );
    }
  }
  return file;
}

/** @returns {string} */
function repoRoot() {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (result.status === 0) {
    const root = result.stdout.trim();
    if (root) return root;
  }
  return process.cwd();
}

/**
 * Resolve the rootless Podman API socket, starting the service when needed.
 * @returns {Promise<string | null>}
 */
async function ensurePodmanSocket() {
  if (!which('podman')) return null;

  const uid = currentUid();
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  const candidates = [
    process.env.ACT_PRECOMMIT_SOCKET,
    runtimeDir ? path.join(runtimeDir, 'podman', 'podman.sock') : null,
    `/run/user/${uid}/podman/podman.sock`,
    '/mnt/wslg/runtime-dir/podman/podman.sock',
  ].filter(Boolean);

  const writable = (dir) => {
    try {
      fs.accessSync(dir, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  };

  let socketPath =
    candidates.find((candidate) => fs.existsSync(candidate)) ||
    candidates.find((candidate) => writable(path.dirname(candidate))) ||
    candidates[candidates.length - 1];

  if (await canConnect(socketPath)) return socketPath;

  // A stale socket file after a WSL reboot blocks bind(); remove it.
  if (fs.existsSync(socketPath)) {
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // the service may simply be starting; retry the connection below
    }
  }

  fs.mkdirSync(path.dirname(socketPath), { recursive: true });

  const service = spawn(
    'podman',
    ['system', 'service', '--time', SERVICE_IDLE_SECONDS, `unix://${socketPath}`],
    { detached: true, stdio: 'ignore' },
  );
  service.unref();

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await canConnect(socketPath, 200)) return socketPath;
    await delay(100);
  }
  return null;
}

/** @returns {string} */
function defaultDockerSocket() {
  const host = process.env.DOCKER_HOST;
  if (host && host.startsWith('unix://')) return host.slice('unix://'.length);
  return '/var/run/docker.sock';
}

/**
 * @param {'auto' | 'podman' | 'docker'} mode
 * @returns {Promise<{kind: 'podman' | 'docker', socket: string | null} | null>}
 */
async function pickRuntime(mode) {
  if (mode === 'podman' || mode === 'auto') {
    const socket = await ensurePodmanSocket();
    if (socket) return { kind: 'podman', socket };
    if (mode === 'podman') {
      throw new Error('ACT_PRECOMMIT_RUNTIME=podman but the rootless Podman API socket is unavailable');
    }
  }
  if (mode === 'docker' || mode === 'auto') {
    const socket = defaultDockerSocket();
    if (await canConnect(socket)) return { kind: 'docker', socket };
  }
  return null;
}

/**
 * @param {{kind: 'podman' | 'docker'}} runtime
 * @returns {string}
 */
function containerCli(runtime) {
  if (runtime.kind === 'podman') return which('podman') || 'podman';
  return which('docker') || 'docker';
}

/**
 * @param {{kind: 'podman' | 'docker', socket: string | null}} runtime
 * @returns {NodeJS.ProcessEnv}
 */
function runtimeEnv(runtime) {
  const env = { ...process.env };
  if (runtime.kind === 'podman' && runtime.socket) {
    env.DOCKER_HOST = `unix://${runtime.socket}`;
  }
  return env;
}

/**
 * Run a command and collect its output, with a bounded wait.
 * @param {string} command
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @param {number} [timeoutMs]
 * @returns {Promise<{code: number | null, stdout: string, stderr: string}>}
 */
function runCapture(command, args, env, timeoutMs = 15_000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
      finish(null);
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', () => finish(null));
    child.once('close', (code) => finish(code));
  });
}

/**
 * Snapshot container and network ids so a killed act can be cleaned up.
 * @param {{kind: 'podman' | 'docker'}} runtime
 * @returns {Promise<{containers: Set<string>, networks: Set<string>}>}
 */
async function snapshotRuntime(runtime) {
  const cli = containerCli(runtime);
  const env = runtimeEnv(runtime);
  const containers = await runCapture(cli, ['ps', '-aq'], env, 10_000);
  const networks = await runCapture(cli, ['network', 'ls', '-q'], env, 10_000);
  const toSet = (text) =>
    new Set(
      text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    );
  return {
    containers: toSet(containers.stdout),
    networks: toSet(networks.stdout),
  };
}

/**
 * Remove containers and networks created after the snapshot. Best effort.
 * @param {{kind: 'podman' | 'docker'}} runtime
 * @param {{containers: Set<string>, networks: Set<string>}} before
 */
async function cleanupRuntime(runtime, before) {
  const cli = containerCli(runtime);
  const env = runtimeEnv(runtime);

  const containers = await runCapture(cli, ['ps', '-aq'], env, 10_000);
  const leftovers = containers.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((id) => id && !before.containers.has(id));
  if (leftovers.length > 0) {
    await runCapture(cli, ['rm', '-f', ...leftovers], env, 30_000);
  }

  const networks = await runCapture(cli, ['network', 'ls', '-q'], env, 10_000);
  const leftoverNetworks = networks.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((id) => id && !before.networks.has(id));
  for (const id of leftoverNetworks) {
    await runCapture(cli, ['network', 'rm', id], env, 10_000);
  }
}

/**
 * Run a command attached to the terminal, with a hard deadline.
 * @param {string} command
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @param {number} timeoutMs
 * @param {string} timeoutMessage
 * @returns {Promise<boolean>}
 */
function runStreaming(command, args, env, timeoutMs, timeoutMessage) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: 'inherit' });
    let settled = false;
    let killTimer = null;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      process.stderr.write(`[act-precommit] ERROR: ${timeoutMessage}\n`);
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
    }, timeoutMs);
    child.once('error', () => finish(false));
    child.once('close', (code) => finish(code === 0));
  });
}

/**
 * Build the hook's runner image from the checked-in Dockerfile.
 * @param {{kind: 'podman' | 'docker'}} runtime
 * @param {string} image
 * @returns {Promise<boolean>}
 */
async function buildRunnerImage(runtime, image) {
  const dockerfile = path.join(repoRoot(), RUNNER_DOCKERFILE);
  if (!fs.existsSync(dockerfile)) {
    process.stderr.write(`[act-precommit] ERROR: runner Dockerfile is missing: ${dockerfile}\n`);
    return false;
  }

  const base = process.env.ACT_PRECOMMIT_BASE_IMAGE || DEFAULT_BASE_IMAGE;
  const rawTimeout = Number(process.env.ACT_PRECOMMIT_BUILD_TIMEOUT_MS || DEFAULT_BUILD_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : DEFAULT_BUILD_TIMEOUT_MS;

  process.stderr.write(
    `[act-precommit] building runner image ${image} from ${RUNNER_DOCKERFILE} ` +
      `(base ${base}); this happens once\n`,
  );

  // The Dockerfile has no COPY/ADD, so use its own directory as the build
  // context instead of uploading the whole checkout.
  return runStreaming(
    containerCli(runtime),
    [
      'build',
      '--build-arg',
      `ACT_BASE_IMAGE=${base}`,
      '-f',
      dockerfile,
      '-t',
      image,
      path.dirname(dockerfile),
    ],
    runtimeEnv(runtime),
    timeoutMs,
    `building ${image} exceeded ${(timeoutMs / 1000).toFixed(0)}s; aborting ` +
      '(set ACT_PRECOMMIT_BUILD_TIMEOUT_MS to raise the limit)',
  );
}

/**
 * Make sure the image act will use is present. Locally built images are built
 * on first use; everything else is pulled, or left to act when it is told to
 * pull.
 * @param {{kind: 'podman' | 'docker'}} runtime
 * @param {string} image
 * @param {boolean} pull
 * @param {boolean} build
 * @returns {Promise<boolean>}
 */
async function ensureImage(runtime, image, pull, build) {
  if (pull && !build) return true;

  const cli = containerCli(runtime);
  const env = runtimeEnv(runtime);
  const inspect = await runCapture(cli, ['image', 'inspect', image], env, 20_000);
  if (inspect.code === 0) return true;

  if (build) return buildRunnerImage(runtime, image);

  process.stderr.write(
    `[act-precommit] runner image ${image} is missing; pulling it once (this can take a while)...\n`,
  );

  const rawPullTimeout = Number(process.env.ACT_PRECOMMIT_PULL_TIMEOUT_MS || 600_000);
  const pullTimeoutMs = Number.isFinite(rawPullTimeout) && rawPullTimeout > 0 ? rawPullTimeout : 600_000;

  return runStreaming(
    cli,
    ['pull', image],
    env,
    pullTimeoutMs,
    `pulling ${image} exceeded ${(pullTimeoutMs / 1000).toFixed(0)}s; aborting\n` +
      `[act-precommit] pull it manually with 'podman pull ${image}' (or set ACT_PRECOMMIT_PULL_TIMEOUT_MS)`,
  );
}

/**
 * @param {number} ms
 * @param {number} limit
 * @returns {string}
 */
function describeElapsed(ms, limit) {
  const seconds = (ms / 1000).toFixed(2);
  const limitSeconds = (limit / 1000).toFixed(2);
  return `${seconds}s of ${limitSeconds}s`;
}

/**
 * Print a failure summary plus the documented escape hatch.
 * @param {string} message
 * @returns {1}
 */
function fail(message) {
  process.stderr.write(`[act-precommit] FAIL: ${message}\n`);
  process.stderr.write('[act-precommit] bypass once with: ACT_PRECOMMIT_SKIP=1 git commit ...\n');
  return 1;
}

async function main() {
  if (process.env.ACT_PRECOMMIT_SKIP === '1') {
    process.stderr.write('[act-precommit] skipped (ACT_PRECOMMIT_SKIP=1)\n');
    return 0;
  }

  const requestedAct = process.env.ACT_BIN || 'act';
  let actPath = which(requestedAct);
  if (!actPath && !process.env.ACT_BIN) {
    for (const candidate of [
      '/usr/bin/act',
      '/usr/local/bin/act',
      '/opt/homebrew/bin/act',
      path.join(os.homedir(), '.local', 'bin', 'act'),
    ]) {
      if (which(candidate)) {
        actPath = candidate;
        break;
      }
    }
  }
  if (!actPath) {
    process.stderr.write(
      `[act-precommit] ERROR: '${requestedAct}' is not installed or not on PATH (install act or set ACT_BIN)\n`,
    );
    return 1;
  }

  ensureActConfig();

  const rawTimeout = process.env.ACT_PRECOMMIT_TIMEOUT_MS;
  const timeoutMs = rawTimeout === undefined ? DEFAULT_TIMEOUT_MS : Number(rawTimeout);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    process.stderr.write(
      `[act-precommit] ERROR: ACT_PRECOMMIT_TIMEOUT_MS must be a positive number, got '${rawTimeout}'\n`,
    );
    return 1;
  }

  const runtimeMode = (process.env.ACT_PRECOMMIT_RUNTIME || 'auto').toLowerCase();
  if (!['auto', 'podman', 'docker'].includes(runtimeMode)) {
    process.stderr.write(
      `[act-precommit] ERROR: ACT_PRECOMMIT_RUNTIME must be auto, podman or docker, got '${runtimeMode}'\n`,
    );
    return 1;
  }

  /** @type {{kind: 'podman' | 'docker', socket: string | null} | null} */
  let runtime;
  try {
    runtime = await pickRuntime(runtimeMode);
  } catch (error) {
    process.stderr.write(`[act-precommit] ERROR: ${error.message}\n`);
    return 1;
  }
  if (!runtime) {
    process.stderr.write(
      '[act-precommit] ERROR: no usable container runtime found (Podman rootless service or Docker daemon)\n',
    );
    return 1;
  }

  const job = process.env.ACT_PRECOMMIT_JOB || DEFAULT_JOB;
  const workflow = process.env.ACT_PRECOMMIT_WORKFLOW || DEFAULT_WORKFLOW;
  const event = process.env.ACT_PRECOMMIT_EVENT || DEFAULT_EVENT;
  const image = process.env.ACT_PRECOMMIT_IMAGE || DEFAULT_IMAGE;
  const pull = process.env.ACT_PRECOMMIT_PULL === '1';
  const buildSetting = process.env.ACT_PRECOMMIT_IMAGE_BUILD;
  if (buildSetting !== undefined && buildSetting !== '0' && buildSetting !== '1') {
    process.stderr.write(
      `[act-precommit] ERROR: ACT_PRECOMMIT_IMAGE_BUILD must be 0 or 1, got '${buildSetting}'\n`,
    );
    return 1;
  }
  // The default image is built locally from scripts/act-runner.Dockerfile so
  // the hook does not depend on a registry image being present. A custom image
  // is only built when explicitly requested.
  const buildImage =
    buildSetting === '1' || (buildSetting === undefined && image === DEFAULT_IMAGE);
  const actPull = pull && !buildImage;

  if (!(await ensureImage(runtime, image, pull, buildImage))) {
    process.stderr.write(`[act-precommit] ERROR: unable to obtain runner image ${image}\n`);
    return 1;
  }

  let actArgs;
  const override = process.env.ACT_PRECOMMIT_ARGS;
  if (override && override.trim()) {
    actArgs = splitArgs(override);
  } else {
    // Bind the checkout instead of copying ~550 MB into the container, and
    // keep the container alive between runs. Both remove the dominant setup
    // and teardown costs from the 30 second budget.
    actArgs = [
      event,
      '-j',
      job,
      '-W',
      workflow,
      actPull ? '--pull=true' : '--pull=false',
      '--bind',
      '--reuse',
    ];
  }

  // act resolves `runs-on` through its platform mappings; point ubuntu-latest
  // at the image ensured above instead of relying on ~/.config/act/actrc.
  const hasPlatform = actArgs.some(
    (arg) => arg === '-P' || arg === '--platform' || arg.startsWith('--platform='),
  );
  if (!hasPlatform) actArgs.push('-P', `ubuntu-latest=${image}`);

  let containerOptions =
    process.env.ACT_PRECOMMIT_CONTAINER_OPTIONS ||
    (runtime.kind === 'docker' ? `--user=${currentUid()}:${currentGid()}` : '');
  // The bound working tree already contains the host's `build/` directory.
  // Keep the container's build tree separate so act never reuses it.
  containerOptions = containerOptions
    ? `${containerOptions} -e BUILD_DIR=build-act`
    : '-e BUILD_DIR=build-act';
  if (containerOptions && !actArgs.includes('--container-options')) {
    actArgs.push('--container-options', containerOptions);
  }
  if (runtime.kind === 'podman' && runtime.socket && !actArgs.includes('--container-daemon-socket')) {
    actArgs.push('--container-daemon-socket', `unix://${runtime.socket}`);
  }

  const before = await snapshotRuntime(runtime);
  const env = runtimeEnv(runtime);
  const root = repoRoot();
  const started = Date.now();

  process.stderr.write(
    `[act-precommit] ${runtime.kind} | ${event} ${job} (${workflow}) | limit ${(timeoutMs / 1000).toFixed(2)}s\n`,
  );
  process.stderr.write(`[act-precommit] ${actPath} ${actArgs.join(' ')}\n`);

  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null;
  let timedOut = false;
  let interrupted = null;
  let killed = false;
  let killTimer = null;

  const killGroup = (signal) => {
    if (!child || child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
      killed = true;
      return;
    } catch {
      // fall back to the direct child (e.g. if the group already vanished)
    }
    try {
      child.kill(signal);
      killed = true;
    } catch {
      // already gone
    }
  };

  const exitCode = await new Promise((resolve) => {
    child = spawn(actPath, actArgs, {
      cwd: root,
      env,
      stdio: ['ignore', 'inherit', 'inherit'],
      detached: true,
    });

    const deadline = setTimeout(() => {
      timedOut = true;
      process.stderr.write(
        `\n[act-precommit] TIMEOUT: act exceeded ${(timeoutMs / 1000).toFixed(2)}s; terminating\n`,
      );
      killGroup('SIGTERM');
      killTimer = setTimeout(() => {
        process.stderr.write('[act-precommit] act ignored SIGTERM; sending SIGKILL\n');
        killGroup('SIGKILL');
      }, 1500);
    }, timeoutMs);

    const forwardSignal = (signal) => {
      interrupted = signal;
      process.stderr.write(`\n[act-precommit] received ${signal}; terminating act\n`);
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 1000).unref();
    };
    process.once('SIGINT', () => forwardSignal('SIGINT'));
    process.once('SIGTERM', () => forwardSignal('SIGTERM'));

    child.once('error', (error) => {
      clearTimeout(deadline);
      process.stderr.write(`[act-precommit] ERROR: failed to start act: ${error.message}\n`);
      resolve(null);
    });

    child.once('close', (code, signal) => {
      clearTimeout(deadline);
      if (killTimer) clearTimeout(killTimer);
      if (signal) {
        process.stderr.write(`[act-precommit] act terminated by ${signal}\n`);
      }
      resolve(code);
    });
  });

  const elapsed = Date.now() - started;

  if (interrupted) {
    process.stderr.write('[act-precommit] cleaning up containers left by the interrupted run...\n');
    await delay(300);
    await cleanupRuntime(runtime, before);
    return interrupted === 'SIGINT' ? 130 : 143;
  }

  if (timedOut || killed) {
    process.stderr.write('[act-precommit] cleaning up containers left by the killed run...\n');
    await delay(300);
    await cleanupRuntime(runtime, before);
    return fail(
      `act did not finish within ${(timeoutMs / 1000).toFixed(2)}s (ran ${describeElapsed(elapsed, timeoutMs)})`,
    );
  }

  if (elapsed > timeoutMs) {
    return fail(
      `act took ${describeElapsed(elapsed, timeoutMs)} — over the limit even though it exited`,
    );
  }

  if (exitCode !== 0) {
    return fail(`act exited with status ${exitCode} after ${describeElapsed(elapsed, timeoutMs)}`);
  }

  process.stderr.write(`[act-precommit] OK: act passed in ${describeElapsed(elapsed, timeoutMs)}\n`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`[act-precommit] ERROR: ${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 1;
  });
