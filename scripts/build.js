#!/usr/bin/env node
/**
 * Build driver for qnode.
 *
 * Everything is compiled and linked by the JavaScript C compiler in
 * `scripts/cc.js`. There is no CMake, make, zig or system C compiler in the
 * build path, and no external assembler or linker either.
 *
 * Usage:
 *   node scripts/build.js [target] [options]
 *
 * Targets:
 *   build (default)  build build/qnode
 *   qjsc             build the QuickJS compiler
 *   codegen          regenerate the builtin-*.h bytecode headers with qjsc
 *   clean            remove the build directory
 *   qnode-test       run the qnode test suites
 *   net-test         run the net_shards suite
 *   net-bench        run the net-shards benchmark
 *   netstack-tun-test / netstack-tap-test
 *                    run the netstack tun/tap tests
 *
 * Options:
 *   --build-dir=<dir>   build directory (default: $BUILD_DIR or "build")
 *   -j, --jobs=<n>      parallel jobs for the test suites (default: every CPU)
 *   --verbose           echo every command before running it
 *   -h, --help          show this help
 *
 * Environment variables with the same names as the options are honoured, so
 * `BUILD_DIR=out node scripts/build.js` works.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ccScript = path.join(root, 'scripts', 'cc.js');

const TARGETS = new Set([
  'build',
  'qjsc',
  'codegen',
  'clean',
  'qnode-test',
  'net-test',
  'net-bench',
  'netstack-tun-test',
  'netstack-tap-test',
]);

/**
 * Parse argv into a target plus options.
 * @param {string[]} argv
 * @returns {{target: string, buildDir: string, jobs: number, verbose: boolean}}
 */
function parseArgs(argv) {
  let target = 'build';
  let buildDir = process.env.BUILD_DIR || 'build';
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
    } else if (arg.startsWith('-')) {
      fail(`unknown option '${arg}' (try --help)`);
    } else if (TARGETS.has(arg)) {
      target = arg;
    } else {
      fail(`unknown target '${arg}' (try --help)`);
    }
  }

  if (!Number.isInteger(jobs) || jobs < 1) fail(`--jobs must be a positive integer, got '${jobs}'`);
  if (!buildDir) fail('--build-dir must not be empty');
  return { target, buildDir, jobs, verbose };
}

/**
 * Number of parallel jobs for the test suites.
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
 * Compile and link with the JavaScript C compiler.
 * @param {string[]} args
 * @param {{verbose: boolean}} options
 */
function cc(args, { verbose }) {
  run(process.execPath, [ccScript, ...args], { verbose });
}

/**
 * Absolute build directory.
 * @param {string} buildDir
 * @returns {string}
 */
function buildPath(buildDir) {
  return path.resolve(root, buildDir);
}

/**
 * The prebuilt archive directory for this host.
 * @returns {string}
 */
function prebuiltDir() {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    fail('the JavaScript C compiler only targets linux-x86_64');
  }
  const dir = path.join(root, 'vendor', 'prebuilt', 'linux-x86_64');
  if (!fs.existsSync(dir)) fail(`missing prebuilt archives in ${path.relative(root, dir)}`);
  return dir;
}

/**
 * Concatenate the bootstrap parts and embed the result as a C header.
 *
 * The parts share one top-level scope and filename order is execution order.
 * The result is embedded as a C array, so no external `xxd` is needed.
 * @param {string} buildDir absolute build directory
 * @returns {string} path to the generated header
 */
function generateBootstrap(buildDir) {
  const partsDir = path.join(root, 'bootstrap');
  const parts = fs
    .readdirSync(partsDir)
    .filter((name) => name.endsWith('.js'))
    .sort();
  if (parts.length === 0) fail('bootstrap/ has no .js parts');

  const source = parts.map((name) => fs.readFileSync(path.join(partsDir, name), 'utf8')).join('');
  const jsFile = path.join(buildDir, 'node_bootstrap.js');
  fs.writeFileSync(jsFile, source);

  const bytes = Buffer.from(source, 'utf8');
  const lines = ['unsigned char node_bootstrap_js[] = {'];
  for (let i = 0; i < bytes.length; i += 12) {
    const chunk = bytes.subarray(i, i + 12);
    lines.push(`  ${Array.from(chunk, (byte) => `0x${byte.toString(16).padStart(2, '0')}`).join(', ')},`);
  }
  lines.push('};');
  lines.push(`unsigned int node_bootstrap_js_len = ${bytes.length};`);

  const header = path.join(buildDir, 'node_bootstrap.h');
  fs.writeFileSync(header, `${lines.join('\n')}\n`);
  return header;
}

/**
 * Compiler flags shared by qnode and qjsc.
 * @param {string} buildDir absolute build directory
 * @param {string[]} extraIncludes
 * @returns {string[]}
 */
function commonFlags(buildDir, extraIncludes = []) {
  return [
    '-I', path.join(root, 'scripts', 'cc', 'include'),
    '-I', '/usr/include',
    '-I', root,
    '-I', buildDir,
    ...extraIncludes.flatMap((dir) => ['-I', dir]),
    '-D', 'EV_STANDALONE',
    '-D', 'EV_USE_EPOLL=1',
    '-D', 'QJS_HAVE_LIBEV',
    '-D', '_GNU_SOURCE',
    '-funsigned-char',
  ];
}

/**
 * Build build/qnode with the JavaScript C compiler.
 * @param {{buildDir: string, verbose: boolean}} options
 * @returns {string} absolute path to the binary
 */
function buildQnode({ buildDir, verbose }) {
  const outDir = buildPath(buildDir);
  const prebuilt = prebuiltDir();
  fs.mkdirSync(outDir, { recursive: true });

  const includes = [
    path.join(root, 'vendor', 'libev'),
    path.join(root, 'vendor', 'wasm3', 'source'),
    path.join(root, 'vendor', 'zlib'),
    path.join(root, 'vendor', 'mbedtls', 'include'),
    path.join(root, 'vendor', 'libsodium', 'src', 'libsodium', 'include'),
    path.join(root, 'vendor', 'libsodium', 'src', 'libsodium', 'include', 'sodium'),
  ];
  const sources = [
    'node.c',
    'netstack.c',
    'netstack_l2.c',
    'netstack_link.c',
    'node_netstack.c',
    'quickjs-libc.c',
    'qnode.c',
    'wayland.c',
  ].map((name) => path.join(root, name));
  const archives = [
    'libqjs.a',
    'libqnode_wasm3.a',
    'libqnode_libev.a',
    'libqnode_zlib.a',
    'libqnode_mbedtls.a',
    'libqnode_sodium.a',
  ].map((name) => path.join(prebuilt, name));

  const out = path.join(outDir, 'qnode');
  generateBootstrap(outDir);
  cc(
    [
      ...commonFlags(outDir, includes),
      '-D', 'QNODE_FREESTANDING',
      '-D', '_LARGEFILE64_SOURCE=1',
      ...sources,
      ...archives,
      '-o', out,
    ],
    { verbose },
  );
  return out;
}

/**
 * Build build/qjsc with the JavaScript C compiler.
 * @param {{buildDir: string, verbose: boolean}} options
 * @returns {string} absolute path to the binary
 */
function buildQjsc({ buildDir, verbose }) {
  const outDir = buildPath(buildDir);
  const prebuilt = prebuiltDir();
  fs.mkdirSync(outDir, { recursive: true });

  const includes = [
    path.join(root, 'vendor', 'libev'),
    path.join(root, 'vendor', 'wasm3', 'source'),
  ];
  const sources = [path.join(root, 'qjsc.c'), path.join(root, 'quickjs-libc.c')];
  const archives = ['libqjs.a', 'libqnode_wasm3.a', 'libqnode_libev.a'].map((name) =>
    path.join(prebuilt, name),
  );

  const out = path.join(outDir, 'qjsc');
  cc([...commonFlags(outDir, includes), ...sources, ...archives, '-o', out], { verbose });
  return out;
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
  const { target, buildDir, jobs, verbose } = options;
  const qnodeBinary = path.join(buildDir, 'qnode');
  const qjscBinary = path.join(buildDir, 'qjsc');

  switch (target) {
    case 'build':
      buildQnode(options);
      return;

    case 'qjsc':
      buildQjsc(options);
      return;

    case 'codegen': {
      buildQjsc(options);
      const qjsc = path.resolve(root, qjscBinary);
      for (const name of ['array-fromasync', 'iterator-zip', 'iterator-zip-keyed']) {
        run(qjsc, ['-C', '-ss', '-o', `builtin-${name}.h`, `builtin-${name}.js`], { verbose });
      }
      return;
    }

    case 'clean':
      fs.rmSync(buildPath(buildDir), { recursive: true, force: true });
      return;

    case 'qnode-test': {
      buildQnode(options);
      const status = await runQnodeTests({ qnodeBinary, jobs, verbose });
      if (status !== 0) process.exit(status);
      return;
    }

    case 'net-test':
      buildQnode(options);
      run(path.join(root, 'tests', 'qnode', 'net_shards.sh'), [], {
        env: { ...process.env, QNODE: path.resolve(root, qnodeBinary) },
        verbose,
      });
      return;

    case 'net-bench':
      buildQnode(options);
      run(path.join(root, 'benchmarks', 'net-shards', 'bench.sh'), [], {
        env: { ...process.env, QNODE: path.resolve(root, qnodeBinary) },
        verbose,
      });
      return;

    case 'netstack-tun-test':
      buildQnode(options);
      run('sh', [path.join(root, 'tests', 'qnode', 'netstack_tun.sh')], {
        env: { ...process.env, QNODE: path.resolve(root, qnodeBinary) },
        verbose,
      });
      return;

    case 'netstack-tap-test':
      buildQnode(options);
      run('sh', [path.join(root, 'tests', 'qnode', 'netstack_tap.sh')], {
        env: { ...process.env, QNODE: path.resolve(root, qnodeBinary) },
        verbose,
      });
      return;

    default:
      fail(`unhandled target '${target}'`);
  }
}

await main();
