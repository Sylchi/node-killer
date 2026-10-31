#!/usr/bin/env node
/**
 * Build driver for qnode. Replaces the small Makefile that used to wrap cmake.
 *
 * Usage:
 *   node scripts/build.js [target] [options]
 *
 * Targets:
 *   build (default)  configure if needed, then build qnode (or qjsc when the
 *                    host cannot link the checked-in archives)
 *   configure        configure only
 *   qnode            build the qnode executable
 *   qjsc             build the QuickJS compiler
 *   codegen          regenerate the builtin-*.h bytecode headers with qjsc
 *   debug            configure and build with CMAKE_BUILD_TYPE=Debug
 *   clean            remove compiled objects, keep the configuration
 *   distclean        remove the whole build directory
 *   qnode-test       run the qnode test suites
 *   net-test         run the net_shards suite
 *   net-bench        run the net-shards benchmark
 *   netstack-tun-test / netstack-tap-test
 *                    run the netstack tun/tap tests
 *
 * Options:
 *   --build-dir=<dir>   build directory (default: $BUILD_DIR or "build")
 *   --build-type=<t>    CMAKE_BUILD_TYPE (default: $BUILD_TYPE or "Release")
 *   -j, --jobs=<n>      parallel jobs (default: every online CPU)
 *   --verbose           echo every command before running it
 *   -h, --help          show this help
 *
 * Environment variables with the same names as the options are honoured, so
 * `BUILD_TYPE=Debug node scripts/build.js` works like the old
 * `make BUILD_TYPE=Debug` did.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TARGETS = new Set([
  'build',
  'all',
  'configure',
  'qnode',
  'qjsc',
  'codegen',
  'debug',
  'clean',
  'distclean',
  'qnode-test',
  'net-test',
  'net-bench',
  'netstack-tun-test',
  'netstack-tap-test',
]);

/**
 * Parse argv into a target plus options.
 * @param {string[]} argv
 * @returns {{target: string, buildDir: string, buildType: string, jobs: number, verbose: boolean}}
 */
function parseArgs(argv) {
  let target = 'build';
  let buildDir = process.env.BUILD_DIR || 'build';
  let buildType = process.env.BUILD_TYPE || 'Release';
  let jobs = Number(process.env.JOBS) || availableJobs();
  let verbose = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    } else if (arg === '--verbose') {
      verbose = true;
    } else if (arg === '-j') {
      jobs = Number(argv[++i]);
    } else if (arg.startsWith('-j') && arg.length > 2) {
      jobs = Number(arg.slice(2));
    } else if (arg === '--jobs') {
      jobs = Number(argv[++i]);
    } else if (arg.startsWith('--jobs=')) {
      jobs = Number(arg.slice('--jobs='.length));
    } else if (arg === '--build-dir') {
      buildDir = argv[++i];
    } else if (arg.startsWith('--build-dir=')) {
      buildDir = arg.slice('--build-dir='.length);
    } else if (arg === '--build-type') {
      buildType = argv[++i];
    } else if (arg.startsWith('--build-type=')) {
      buildType = arg.slice('--build-type='.length);
    } else if (arg.startsWith('-')) {
      fail(`unknown option '${arg}' (try --help)`);
    } else if (TARGETS.has(arg)) {
      target = arg;
    } else {
      fail(`unknown target '${arg}' (try --help)`);
    }
  }

  if (!Number.isInteger(jobs) || jobs < 1) fail(`--jobs must be a positive integer, got '${jobs}'`);
  if (!buildType) fail('--build-type must not be empty');
  if (!buildDir) fail('--build-dir must not be empty');
  return { target, buildDir, buildType, jobs, verbose };
}

/**
 * Number of parallel jobs, matching the Makefile's getconf/nproc fallback.
 * @returns {number}
 */
function availableJobs() {
  try {
    return availableParallelism();
  } catch {
    return 4;
  }
}

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  process.stderr.write(`build: ${message}\n`);
  process.exit(1);
}

function printHelp() {
  const text = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const start = text.indexOf('/**');
  const end = text.indexOf('*/', start);
  process.stdout.write(`${text.slice(start + 3, end).replace(/^ \* ?/gm, '')}\n`);
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, verbose?: boolean, allowFailure?: boolean}} [options]
 * @returns {number}
 */
function run(command, args, options = {}) {
  const { cwd = root, env = process.env, verbose = false, allowFailure = false } = options;
  if (verbose) process.stderr.write(`build: ${command} ${args.join(' ')}\n`);
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.error) {
    if (allowFailure) return 1;
    fail(`cannot run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0 && !allowFailure) process.exit(result.status ?? 1);
  return result.status ?? 1;
}

/**
 * @param {string} command
 * @returns {boolean}
 */
function onPath(command) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  return dirs.some((dir) => {
    if (!dir) return false;
    return exts.some((ext) => {
      try {
        fs.accessSync(path.join(dir, command + ext), fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  });
}

/**
 * uname -m style architecture name, matching CMake's QNODE_PREBUILT_ARCH.
 * @returns {string}
 */
function hostArch() {
  switch (process.arch) {
    case 'x64':
      return 'x86_64';
    case 'arm64':
      return 'aarch64';
    case 'ia32':
      return 'i386';
    default:
      return process.arch;
  }
}

/**
 * Mirror CMake's compiler selection: qnode links the checked-in archives, which
 * need zig to supply the libc. Prefer the vendored toolchain on x86-64 and fall
 * back to a zig on PATH elsewhere.
 * @returns {{zig: string | null, prebuiltDir: string | null, qnode: boolean}}
 */
function detectToolchain() {
  const arch = hostArch();
  const vendored = path.join(root, 'vendor', 'zig', 'zig');
  const hasVendored = arch === 'x86_64' && fs.existsSync(vendored);
  const zig = hasVendored ? vendored : onPath('zig') ? 'zig' : null;
  const prebuilt = path.join(root, 'vendor', 'prebuilt', `linux-${arch}`);
  const hasPrebuilt = fs.existsSync(prebuilt);
  const qnode = process.platform === 'linux' && hasPrebuilt && zig !== null;
  return { zig, prebuiltDir: hasPrebuilt ? prebuilt : null, qnode };
}

/**
 * Configure only when the build tree is missing or its generator settings
 * changed, so repeated builds skip the configure step like make did.
 * @param {{buildDir: string, buildType: string, verbose: boolean}} options
 */
function configure({ buildDir, buildType, verbose }) {
  const cache = path.join(root, buildDir, 'CMakeCache.txt');
  if (fs.existsSync(cache)) {
    const cached = fs.readFileSync(cache, 'utf8');
    const match = cached.match(/^CMAKE_BUILD_TYPE:[A-Z]+=(.*)$/m);
    const cachedType = match ? match[1].trim() : '';
    if (cachedType === buildType) return;
  }
  run('cmake', ['-B', buildDir, `-DCMAKE_BUILD_TYPE=${buildType}`], { verbose });
}

/**
 * @param {{buildDir: string, jobs: number, verbose: boolean}} options
 * @param {string} target
 */
function buildTarget({ buildDir, jobs, verbose }, target) {
  run('cmake', ['--build', buildDir, '--target', target, '-j', String(jobs)], { verbose });
}

/**
 * Spawn a process and capture its output.
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function spawnCaptured(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data) => {
      stdout += data;
    });
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    child.on('error', (error) => {
      resolve({
        code: 1,
        stdout,
        stderr: `${stderr}${command}: ${error.message}\n`,
      });
    });
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/**
 * Run every qnode suite, several at a time, and print the buffered output in
 * a stable order. The suites are separate processes with no shared state, so
 * concurrency only cuts wall time; it does not change what they assert.
 * @param {{qnodeBinary: string, jobs: number, verbose: boolean}} options
 * @returns {Promise<number>} exit status (0 when every suite passed)
 */
async function runQnodeTests({ qnodeBinary, jobs, verbose }) {
  const dir = path.join(root, 'tests', 'qnode');
  const binary = path.resolve(root, qnodeBinary);
  const names = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.js') && name !== 'net_shards.js')
    .map((name) => name.slice(0, -'.js'.length))
    .sort();

  const suites = names.map((name) => ({
    name,
    command: binary,
    args: [path.join(dir, `${name}.js`)],
    env: {},
  }));
  // net_shards needs its wrapper to set up an optional private subnet.
  suites.push({
    name: 'net_shards',
    command: 'sh',
    args: [path.join(dir, 'net_shards.sh')],
    env: { QNODE: binary },
  });

  const concurrency = Math.max(1, Math.min(jobs, 8, suites.length));
  const results = new Array(suites.length);
  let next = 0;

  /** @returns {Promise<void>} */
  async function worker() {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= suites.length) return;
      const suite = suites[index];
      if (verbose) process.stderr.write(`build: qnode ${suite.name}\n`);
      const result = await spawnCaptured(suite.command, suite.args, {
        cwd: root,
        env: { ...process.env, ...suite.env },
      });
      results[index] = { ...result, name: suite.name };
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  let status = 0;
  for (const result of results) {
    process.stdout.write(`=== ${result.name}\n`);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.code !== 0) {
      process.stderr.write(`FAILED: ${result.name}\n`);
      status = 1;
    }
  }
  return status;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { target, buildDir, buildType, jobs, verbose } = options;
  const buildTypeForTarget = target === 'debug' ? 'Debug' : buildType;
  const toolchain = detectToolchain();
  const qnodeBinary = path.join(buildDir, 'qnode');
  const qjscBinary = path.join(buildDir, 'qjsc');

  switch (target) {
    case 'configure':
      configure({ buildDir, buildType: buildTypeForTarget, verbose });
      return;

    case 'build':
    case 'all':
    case 'debug': {
      configure({ buildDir, buildType: buildTypeForTarget, verbose });
      if (toolchain.qnode) {
        buildTarget({ buildDir, jobs, verbose }, 'qnode_exe');
      } else {
        process.stderr.write(
          'build: qnode needs zig plus vendor/prebuilt/' +
            `linux-${hostArch()} (archives) so it can link a static musl binary; ` +
            'building qjsc instead\n',
        );
        buildTarget({ buildDir, jobs, verbose }, 'qjsc');
      }
      return;
    }

    case 'qnode':
      configure({ buildDir, buildType, verbose });
      if (!toolchain.qnode) {
        fail(
          `qnode needs zig and vendor/prebuilt/linux-${hostArch()}; ` +
            'install zig or use the "qjsc" target',
        );
      }
      buildTarget({ buildDir, jobs, verbose }, 'qnode_exe');
      return;

    case 'qjsc':
      configure({ buildDir, buildType, verbose });
      buildTarget({ buildDir, jobs, verbose }, 'qjsc');
      return;

    case 'codegen': {
      configure({ buildDir, buildType, verbose });
      buildTarget({ buildDir, jobs, verbose }, 'qjsc');
      const qjsc = path.resolve(root, qjscBinary);
      for (const name of ['array-fromasync', 'iterator-zip', 'iterator-zip-keyed']) {
        run(qjsc, ['-C', '-ss', '-o', `builtin-${name}.h`, `builtin-${name}.js`], { verbose });
      }
      return;
    }

    case 'clean':
      if (!fs.existsSync(path.join(root, buildDir, 'CMakeCache.txt'))) {
        fs.rmSync(path.join(root, buildDir), { recursive: true, force: true });
        return;
      }
      run('cmake', ['--build', buildDir, '--target', 'clean'], { verbose, allowFailure: true });
      return;

    case 'distclean':
      fs.rmSync(path.join(root, buildDir), { recursive: true, force: true });
      return;

    case 'qnode-test': {
      buildQnodeOrExit();
      const status = await runQnodeTests({ qnodeBinary, jobs, verbose });
      if (status !== 0) process.exit(status);
      return;
    }

    case 'net-test':
      buildQnodeOrExit();
      run(path.join(root, 'tests', 'qnode', 'net_shards.sh'), [], {
        env: { ...process.env, QNODE: path.resolve(root, qnodeBinary) },
        verbose,
      });
      return;

    case 'net-bench':
      buildQnodeOrExit();
      run(path.join(root, 'benchmarks', 'net-shards', 'bench.sh'), [], {
        env: { ...process.env, QNODE: path.resolve(root, qnodeBinary) },
        verbose,
      });
      return;

    case 'netstack-tun-test':
      buildQnodeOrExit();
      run('sh', [path.join(root, 'tests', 'qnode', 'netstack_tun.sh')], {
        env: { ...process.env, QNODE: path.resolve(root, qnodeBinary) },
        verbose,
      });
      return;

    case 'netstack-tap-test':
      buildQnodeOrExit();
      run('sh', [path.join(root, 'tests', 'qnode', 'netstack_tap.sh')], {
        env: { ...process.env, QNODE: path.resolve(root, qnodeBinary) },
        verbose,
      });
      return;

    default:
      fail(`unhandled target '${target}'`);
  }

  /** Configure and build qnode, or explain why it is unavailable. */
  function buildQnodeOrExit() {
    if (!toolchain.qnode) {
      fail(`qnode needs zig and vendor/prebuilt/linux-${hostArch()} on Linux`);
    }
    configure({ buildDir, buildType, verbose });
    buildTarget({ buildDir, jobs, verbose }, 'qnode_exe');
  }
}

await main();
