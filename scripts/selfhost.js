#!/usr/bin/env node
/**
 * Build the JavaScript C compiler as a self-hosted native binary.
 *
 * The build works in three stages:
 *   1. copy the compiler sources and Node shims into a staging directory;
 *   2. run qjsc over `scripts/cc.js`, which recursively compiles every imported
 *      module to QuickJS bytecode and emits one C file;
 *   3. compile the bytecode, a small bootstrap module and a native host with
 *      `scripts/cc.js`, linking the prebuilt QuickJS archives.
 *
 * The result is a native executable that runs the compiler from embedded
 * bytecode and does not need Node.js at runtime. qjsc itself must already be
 * built (the `qjsc` target is built automatically when it is missing).
 *
 * Usage:
 *   node scripts/selfhost.js [options]
 *
 * Options:
 *   --build-dir=<dir>  build directory (default: $BUILD_DIR or "build")
 *   --out=<file>       output binary (default: <build-dir>/cc-native)
 *   --qjsc=<file>      qjsc executable (default: <build-dir>/qjsc)
 *   --test             run tests/cc with the new binary afterwards
 *   --self-qjsc        rebuild qjsc with the self-hosted compiler as well
 *   --verbose          print commands before running them
 *   -h, --help         show this help
 *
 * @module selfhost
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const selfhostDir = path.join(root, 'scripts', 'cc', 'selfhost');
const ccScript = path.join(root, 'scripts', 'cc.js');
const buildScript = path.join(root, 'scripts', 'build.js');
const testScript = path.join(root, 'scripts', 'cc', 'test.js');

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  process.stderr.write(`selfhost: ${message}\n`);
  process.exit(1);
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string, verbose?: boolean}} [options]
 * @returns {number}
 */
function run(command, args, options = {}) {
  const { cwd = root, verbose = false } = options;
  if (verbose) process.stderr.write(`selfhost: ${command} ${args.join(' ')}\n`);
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) fail(`cannot run ${command}: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result.status ?? 1;
}

/**
 * @param {string} message
 */
function step(message) {
  process.stderr.write(`selfhost: ${message}\n`);
}

function printHelp() {
  const text = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const start = text.indexOf('/**');
  const end = text.indexOf('*/', start);
  process.stdout.write(`${text.slice(start + 3, end).replace(/^ \* ?/gm, '')}\n`);
}

/**
 * Parse command-line arguments.
 * @param {string[]} argv
 * @returns {{buildDir: string, out: string, qjsc: string, test: boolean, selfQjsc: boolean, verbose: boolean}}
 */
function parseArgs(argv) {
  let buildDir = process.env.BUILD_DIR || 'build';
  let out = '';
  let qjsc = '';
  let test = false;
  let selfQjsc = false;
  let verbose = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    } else if (arg === '--verbose') {
      verbose = true;
    } else if (arg === '--test') {
      test = true;
    } else if (arg === '--self-qjsc') {
      selfQjsc = true;
    } else if (arg === '--build-dir') {
      buildDir = argv[++i];
    } else if (arg.startsWith('--build-dir=')) {
      buildDir = arg.slice('--build-dir='.length);
    } else if (arg === '--out') {
      out = argv[++i];
    } else if (arg.startsWith('--out=')) {
      out = arg.slice('--out='.length);
    } else if (arg === '--qjsc') {
      qjsc = argv[++i];
    } else if (arg.startsWith('--qjsc=')) {
      qjsc = arg.slice('--qjsc='.length);
    } else {
      fail(`unknown option '${arg}' (try --help)`);
    }
  }

  if (!buildDir) fail('--build-dir must not be empty');
  if (out === '') out = path.join(buildDir, 'cc-native');
  if (qjsc === '') qjsc = path.join(buildDir, 'qjsc');

  return {
    buildDir: path.resolve(root, buildDir),
    out: path.resolve(root, out),
    qjsc: path.resolve(root, qjsc),
    test,
    selfQjsc,
    verbose,
  };
}

/**
 * Match qjsc's generated C symbol for an imported module.
 * @param {string} moduleName
 * @returns {string}
 */
function symbolFor(moduleName) {
  const base = moduleName.slice(moduleName.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  const stem = dot >= 0 ? base.slice(0, dot) : base;
  return `qjsc_${stem.replace(/[^0-9A-Za-z]/g, '_')}`;
}

/**
 * Copy a file, creating its parent directory.
 * @param {string} from
 * @param {string} to
 */
function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

/**
 * Stage the compiler, shims and bootstrap where qjsc can resolve them.
 * @param {string} stageDir
 * @returns {{name: string, symbol: string}[]} modules in the bundle
 */
function stageSources(stageDir) {
  fs.rmSync(stageDir, { recursive: true, force: true });
  const srcDir = path.join(stageDir, 'src');
  fs.mkdirSync(path.join(srcDir, 'scripts', 'cc'), { recursive: true });

  copy(ccScript, path.join(srcDir, 'scripts', 'cc.js'));

  const modules = [{ name: 'scripts/cc.js', symbol: 'cc' }];
  const ccDir = path.join(root, 'scripts', 'cc');
  for (const entry of fs.readdirSync(ccDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js') || entry.name === 'test.js') continue;
    const name = `scripts/cc/${entry.name}`;
    copy(path.join(ccDir, entry.name), path.join(srcDir, name));
    modules.push({ name, symbol: symbolFor(name) });
  }

  // qjsc uses the filename as the module specifier, so the shims must be
  // literally named `node:fs` and `node:path` in the staging directory.
  for (const [from, name] of [
    ['node-fs.js', 'node:fs'],
    ['node-path.js', 'node:path'],
  ]) {
    copy(path.join(selfhostDir, from), path.join(srcDir, name));
    modules.push({ name, symbol: symbolFor(name) });
  }

  copy(path.join(selfhostDir, 'bootstrap.js'), path.join(srcDir, 'cc-bootstrap.js'));
  return modules;
}

/**
 * Extract the `const uint8_t NAME[]` arrays from generated C.
 * @param {string} text
 * @returns {string[]}
 */
function generatedSymbols(text) {
  const symbols = [];
  const re = /const\s+uint8_t\s+([A-Za-z_][A-Za-z0-9_]*)\s*\[/g;
  let match;
  while ((match = re.exec(text)) !== null) symbols.push(match[1]);
  return symbols;
}

/**
 * Emit the runtime module table. qjsc sizes are `const` variables rather than
 * C integer constants, so the fields are assigned at runtime. (A real C
 * compiler rejects the equivalent static initializer.)
 * @param {string} file
 * @param {{symbol: string, name: string}[]} modules
 */
function writeModuleTable(file, modules) {
  const lines = [
    '/* Generated by scripts/selfhost.js. Do not edit. */',
    '#include "cc-selfhost.h"',
    '',
  ];
  for (const mod of modules) {
    lines.push(`extern const uint8_t ${mod.symbol}[];`);
    lines.push(`extern const uint32_t ${mod.symbol}_size;`);
  }
  lines.push('');
  lines.push(`EmbeddedModule cc_modules[${modules.length}];`);
  lines.push(`const size_t cc_module_count = ${modules.length};`);
  lines.push('');
  lines.push('void cc_init_modules(void)');
  lines.push('{');
  modules.forEach((mod, index) => {
    lines.push(`    cc_modules[${index}].name = "${mod.name}";`);
    lines.push(`    cc_modules[${index}].data = ${mod.symbol};`);
    lines.push(`    cc_modules[${index}].size = ${mod.symbol}_size;`);
  });
  lines.push('}');
  lines.push('');
  fs.writeFileSync(file, lines.join('\n'));
}

/**
 * @param {string} qjsc
 * @param {boolean} verbose
 */
function ensureQjsc(qjsc, verbose) {
  if (fs.existsSync(qjsc)) return;
  step(`qjsc not found at ${qjsc}; building it`);
  run(process.execPath, [buildScript, '--build-dir', path.dirname(qjsc), 'qjsc'], { verbose });
  if (!fs.existsSync(qjsc)) fail(`qjsc still missing at ${qjsc}`);
}

/**
 * @param {{buildDir: string, out: string, qjsc: string, test: boolean, verbose: boolean}} options
 */
function main(options) {
  const stageDir = path.join(options.buildDir, 'selfhost');
  const genDir = path.join(stageDir, 'gen');
  const srcDir = path.join(stageDir, 'src');

  ensureQjsc(options.qjsc, options.verbose);

  step('staging compiler sources');
  const modules = stageSources(stageDir);
  fs.mkdirSync(genDir, { recursive: true });

  const bundleC = path.join(genDir, 'cc_bundle.c');
  const bootstrapC = path.join(genDir, 'cc_bootstrap.c');

  step('compiling the compiler with qjsc');
  run(
    options.qjsc,
    ['-m', '-N', 'cc', '-n', 'scripts/cc.js', '-o', bundleC, 'scripts/cc.js'],
    { cwd: srcDir, verbose: options.verbose },
  );
  run(
    options.qjsc,
    ['-m', '-N', 'cc_bootstrap', '-n', 'cc-bootstrap.js', '-o', bootstrapC, 'cc-bootstrap.js'],
    { cwd: srcDir, verbose: options.verbose },
  );

  const bundleText = fs.readFileSync(bundleC, 'utf8');
  const symbols = generatedSymbols(bundleText);
  const bySymbol = new Map(modules.map((mod) => [mod.symbol, mod]));
  const embedded = [];
  for (const symbol of symbols) {
    const mod = bySymbol.get(symbol);
    if (!mod) {
      fail(`qjsc emitted unknown module symbol '${symbol}' (add it to selfhost.js)`);
    }
    embedded.push({ symbol, name: mod.name });
  }
  if (!bySymbol.has('cc')) fail('qjsc did not emit the top-level compiler bundle');
  for (const required of modules) {
    if (required.name !== 'scripts/cc.js' && !embedded.some((mod) => mod.symbol === required.symbol)) {
      step(`warning: ${required.name} was not imported by scripts/cc.js`);
    }
  }

  const moduleTable = path.join(genDir, 'modules.c');
  writeModuleTable(moduleTable, embedded);

  step('compiling the native host with scripts/cc.js');
  const archiveDir = path.join(root, 'vendor', 'prebuilt', 'linux-x86_64');
  const flags = [
    '-I', path.join(root, 'scripts', 'cc', 'include'),
    '-I', '/usr/include',
    '-I', root,
    '-I', selfhostDir,
    '-I', path.join(root, 'vendor', 'libev'),
    '-I', path.join(root, 'vendor', 'wasm3', 'source'),
    '-D_GNU_SOURCE',
    '-DEV_STANDALONE',
    '-DEV_USE_EPOLL=1',
    '-DQJS_HAVE_LIBEV',
    '-funsigned-char',
  ];
  const archives = [
    path.join(archiveDir, 'libqjs.a'),
    path.join(archiveDir, 'libqnode_wasm3.a'),
    path.join(archiveDir, 'libqnode_libev.a'),
  ];
  const hostSources = [
    path.join(selfhostDir, 'host.c'),
    path.join(root, 'quickjs-libc.c'),
    bundleC,
    bootstrapC,
    moduleTable,
  ];

  fs.mkdirSync(path.dirname(options.out), { recursive: true });
  run(process.execPath, [ccScript, ...flags, ...hostSources, ...archives, '-o', options.out], {
    verbose: options.verbose,
  });

  const size = fs.statSync(options.out).size;
  step(`built ${path.relative(root, options.out)} (${(size / 1024 / 1024).toFixed(1)} MB)`);

  if (options.selfQjsc) {
    const qjscNative = path.join(options.buildDir, 'qjsc-native');
    step('rebuilding qjsc with the self-hosted compiler');
    const qjscSources = [
      path.join(root, 'qjsc.c'),
      path.join(root, 'quickjs-libc.c'),
      path.join(root, 'gen', 'repl.c'),
      path.join(root, 'gen', 'standalone.c'),
    ];
    run(process.execPath, [ccScript, ...flags, ...qjscSources, ...archives, '-o', qjscNative], {
      verbose: options.verbose,
    });
    const qjscSize = fs.statSync(qjscNative).size;
    step(
      `built ${path.relative(root, qjscNative)} (${(qjscSize / 1024 / 1024).toFixed(1)} MB)`,
    );
  }

  if (options.test) {
    step('running tests/cc with the self-hosted compiler');
    run(process.execPath, [testScript, '--compiler', options.out], { verbose: options.verbose });
  }
}

main(parseArgs(process.argv.slice(2)));
