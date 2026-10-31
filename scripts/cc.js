#!/usr/bin/env node
/**
 * C compiler driver for the JavaScript C compiler.
 *
 * Usage:
 *   node scripts/cc.js [options] <file.c>
 *   node scripts/cc.js [options] <file.s>
 *
 * Options:
 *   -o <file>     Output file (default: a.out)
 *   -S            Stop after compilation, emit assembly
 *   -c            Compile and assemble, but do not link
 *   -E            Stop after preprocessing
 *   -I <dir>      Add include directory
 *   -D <name[=val]>  Define macro
 *   -U <name>     Undefine macro
 *   -nostdlib     Do not append the host libc/libgcc archives
 *   -v, --verbose Print commands before running
 *   -h, --help    Show this help
 *
 * Inputs may be C sources, assembly sources, relocatable objects or static
 * archives. Linking is performed by the JavaScript linker (`cc/link.js`), so
 * no external `as`, `ld` or `cc` is required.
 *
 * @module cc
 */
import fs from 'node:fs';
import path from 'node:path';
import { preprocessFile, CcError } from './cc/tokenize.js';
import { parse } from './cc/parse.js';
import { codegen } from './cc/codegen.js';
import { assembleObject } from './cc/object.js';
import { link, LinkError } from './cc/link.js';


function fail(message) {
  process.stderr.write(`cc: ${message}\n`);
  process.exit(1);
}

function printHelp() {
  const help = `Usage: node scripts/cc.js [options] <file.c|file.s|file.o|file.a> ...

Options:
  -o <file>     Output file (default: a.out)
  -S            Stop after compilation, emit assembly
  -c            Compile and assemble, but do not link
  -E            Stop after preprocessing
  -I <dir>      Add include directory
  -D <name[=val]>  Define macro
  -U <name>     Undefine macro
  -nostdlib     Do not append the host libc/libgcc archives
  -v, --verbose Print commands before running
  -h, --help    Show this help
`;
  process.stdout.write(help);
}

function parseArgs(argv) {
  const options = {
    output: 'a.out',
    emitAsm: false,
    compileOnly: false,
    preprocessOnly: false,
    includeDirs: [],
    defines: {},
    undefs: [],
    nostdlib: false,
    verbose: false,
    inputFiles: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    } else if (arg === '-o') {
      options.output = argv[++i];
    } else if (arg === '-S') {
      options.emitAsm = true;
    } else if (arg === '-c') {
      options.compileOnly = true;
    } else if (arg === '-E') {
      options.preprocessOnly = true;
    } else if (arg === '-I') {
      options.includeDirs.push(argv[++i]);
    } else if (arg.startsWith('-I')) {
      options.includeDirs.push(arg.slice(2));
    } else if (arg === '-D') {
      const spec = argv[++i];
      const eq = spec.indexOf('=');
      if (eq < 0) options.defines[spec] = '1';
      else options.defines[spec.slice(0, eq)] = spec.slice(eq + 1);
    } else if (arg.startsWith('-D')) {
      const spec = arg.slice(2);
      const eq = spec.indexOf('=');
      if (eq < 0) options.defines[spec] = '1';
      else options.defines[spec.slice(0, eq)] = spec.slice(eq + 1);
    } else if (arg === '-U') {
      options.undefs.push(argv[++i]);
    } else if (arg.startsWith('-U')) {
      options.undefs.push(arg.slice(2));
    } else if (arg === '-nostdlib' || arg === '-nodefaultlibs') {
      options.nostdlib = true;
    } else if (arg === '-v' || arg === '--verbose') {
      options.verbose = true;
    } else if (arg === '-x') {
      // Language specification, skip argument
      i += 1;
    } else if (arg.startsWith('-x')) {
      // -x c etc, skip
    } else if (arg === '-shared' || arg === '-fPIC' || arg === '-fpic' || arg === '-fPIE' || arg === '-fpie' || arg === '-rdynamic') {
      // Ignore common flags not supported
    } else if (arg === '-O' || arg === '-O0' || arg === '-O1' || arg === '-O2' || arg === '-O3' || arg === '-Os' || arg === '-Oz' || arg === '-Og' || arg === '-Ofast') {
      // Ignore optimization flags
    } else if (arg.startsWith('-O')) {
      // Ignore other optimization flags
    } else if (arg === '-g' || arg === '-g0' || arg === '-g1' || arg === '-g2' || arg === '-g3') {
      // Ignore debug flags
    } else if (arg.startsWith('-g')) {
      // Ignore other debug flags
    } else if (arg === '-Wall' || arg === '-Wextra' || arg === '-Werror' || arg === '-Wno-error' || arg.startsWith('-W')) {
      // Ignore warning flags
    } else if (arg === '-std=c99' || arg === '-std=c11' || arg === '-std=c17' || arg === '-std=gnu99' || arg === '-std=gnu11' || arg === '-std=gnu17' || arg.startsWith('-std=')) {
      // Ignore std flags
    } else if (arg === '-pthread') {
      options.defines._REENTRANT = options.defines._REENTRANT || '1';
    } else if (arg === '-static' || arg === '-static-libgcc') {
      // Our linker is static anyway
    } else if (arg === '-fno-omit-frame-pointer' || arg === '-fomit-frame-pointer' || arg === '-funwind-tables' || arg === '-ffunction-sections' || arg === '-fdata-sections') {
      // Ignore optimization flags
    } else if (arg.startsWith('-m')) {
      // Ignore machine specific flags
    } else if (arg.startsWith('-target')) {
      // Skip next arg if separate
      if (arg === '-target') i += 1;
    } else if (arg === '-pipe') {
      // Ignore
    } else if (arg.startsWith('-f')) {
      // Ignore other f flags
    } else if (arg === '-ldl' || arg === '-lm' || arg === '-lpthread' || arg === '-lrt' || arg === '-lutil') {
      // These are provided by libc/a on Linux typically, our linker will find them
    } else if (arg === '-l' || arg.startsWith('-l')) {
      // Library flags - store for later? For now ignore if just flags
      if (arg === '-l') {
        i += 1; // skip library name
      }
      // -lfoo passed as single arg is handled by our cc? Let us check
      // Our cc doesn't have -l support, skip
    } else if (arg.startsWith('-L')) {
      if (arg === '-L') {
        i += 1;
      }
    } else if (arg.startsWith('-')) {
      if (options.verbose) {
        // warn but continue
      } else {
        fail(`unknown option '${arg}'`);
      }
    } else {
      options.inputFiles.push(arg);
    }
  }

  if (options.inputFiles.length === 0) {
    fail('no input files');
  }
  return options;
}

/**
 * Compile one C source file into GNU `as` syntax.
 * @param {string} inputFile
 * @param {object} options
 * @returns {string}
 */
function compileToAsm(inputFile, options) {
  const tokens = preprocessFile(inputFile, {
    includeDirs: options.includeDirs,
    defines: options.defines,
    undefs: options.undefs,
  });
  const { globals, functions } = parse(tokens);
  return codegen(globals, functions);
}

/**
 * Compile or assemble one source file into an ET_REL object.
 * @param {string} inputFile
 * @param {object} options
 * @returns {Buffer}
 */
function compileToObject(inputFile, options) {
  const ext = path.extname(inputFile);
  if (ext === '.s' || ext === '.S') {
    const asm = fs.readFileSync(inputFile, 'utf8');
    return assembleObject(asm);
  }
  const asm = compileToAsm(inputFile, options);
  return assembleObject(asm);
}

/**
 * GCC target triples that ship a libgcc for the running host. A machine can
 * have several cross compilers installed (MinGW, bare-metal ELF, ...), so the
 * host triple has to be chosen explicitly instead of picking the first
 * libgcc.a found under /usr/lib/gcc.
 * @type {Record<string, string[]>}
 */
const HOST_LIBGCC_TRIPLES = {
  x64: [
    'x86_64-alpine-linux-musl',
    'x86_64-linux-musl',
    'x86_64-linux-gnu',
    'x86_64-pc-linux-gnu',
    'x86_64-unknown-linux-gnu',
  ],
  arm64: [
    'aarch64-alpine-linux-musl',
    'aarch64-linux-musl',
    'aarch64-linux-gnu',
    'aarch64-unknown-linux-gnu',
  ],
  ia32: [
    'i386-alpine-linux-musl',
    'i386-linux-musl',
    'i686-linux-gnu',
    'i686-pc-linux-gnu',
  ],
};

/** ELF e_machine values for the architectures the linker can emit. */
const ELF_MACHINE = { x64: 62, arm64: 183, ia32: 3 };

/**
 * Check that a static archive actually contains relocatable objects for the
 * host architecture. Cross-compiler libgcc archives (MinGW COFF, bare-metal
 * ELF, ...) otherwise get linked by mistake and fail deep inside the linker.
 * @param {string} file
 * @param {number} machine expected ELF e_machine
 * @returns {boolean}
 */
function isHostObjectArchive(file, machine) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return false;
  }
  if (buf.length < 8 || buf.toString('latin1', 0, 8) !== '!<arch>\n') return false;
  const magic = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
  for (let at = buf.indexOf(magic); at >= 0 && at + 20 <= buf.length; at = buf.indexOf(magic, at + 1)) {
    const isElf64Le = buf[at + 4] === 2 && buf[at + 5] === 1;
    const isRelocatable = buf.readUInt16LE(at + 16) === 1;
    if (isElf64Le && isRelocatable && buf.readUInt16LE(at + 18) === machine) return true;
  }
  return false;
}

/**
 * Locate the newest libgcc.a that belongs to the running host.
 * @param {number} machine expected ELF e_machine
 * @returns {string | null}
 */
function findHostLibgcc(machine) {
  if (fs.existsSync('/usr/lib/libgcc.a') && isHostObjectArchive('/usr/lib/libgcc.a', machine)) {
    return '/usr/lib/libgcc.a';
  }
  const base = '/usr/lib/gcc';
  let triples;
  try {
    triples = fs.readdirSync(base);
  } catch {
    return null;
  }
  // Prefer the known host triples; then accept any other Linux triple for the
  // host architecture (for example a vendor-specific tuple) but still validate
  // its objects, so cross compilers for other targets are never selected.
  const preferred = HOST_LIBGCC_TRIPLES[process.arch] || [];
  const hostPrefix = preferred.length > 0
    ? preferred[0].slice(0, preferred[0].indexOf('-'))
    : process.arch;
  const candidates = [
    ...preferred.filter((triple) => triples.includes(triple)),
    ...triples
      .filter((triple) => triple.startsWith(hostPrefix + '-') && triple.includes('linux'))
      .filter((triple) => !preferred.includes(triple))
      .sort(),
  ];
  for (const triple of candidates) {
    let versions;
    try {
      versions = fs
        .readdirSync(path.join(base, triple))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        .reverse();
    } catch {
      continue;
    }
    for (const version of versions) {
      const candidate = path.join(base, triple, version, 'libgcc.a');
      if (fs.existsSync(candidate) && isHostObjectArchive(candidate, machine)) return candidate;
    }
  }
  return null;
}

/**
 * Candidate static C libraries for the running host, most portable first.
 * Alpine and other musl systems keep `libc.a` at /usr/lib; Debian and Ubuntu
 * put it in the multiarch directory or in the musl package's directory.
 * @type {Record<string, string[]>}
 */
const HOST_LIBC_CANDIDATES = {
  x64: [
    '/usr/lib/libc.a',
    '/usr/lib/x86_64-linux-musl/libc.a',
    '/usr/lib/x86_64-linux-gnu/libc.a',
    '/usr/lib64/libc.a',
    '/lib/libc.a',
  ],
  arm64: [
    '/usr/lib/libc.a',
    '/usr/lib/aarch64-linux-musl/libc.a',
    '/usr/lib/aarch64-linux-gnu/libc.a',
    '/usr/lib64/libc.a',
    '/lib/libc.a',
  ],
  ia32: [
    '/usr/lib/libc.a',
    '/usr/lib/i386-linux-musl/libc.a',
    '/usr/lib/i386-linux-gnu/libc.a',
    '/usr/lib32/libc.a',
    '/lib/libc.a',
  ],
};

/**
 * Locate the host static C library.
 * @returns {string | null}
 */
function findHostLibc() {
  const candidates = HOST_LIBC_CANDIDATES[process.arch] || ['/usr/lib/libc.a'];
  for (const file of candidates) {
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/**
 * Locate the host static archives the generated startup code relies on.
 * `__libc_start_main` lives in libc.a; libgcc provides compiler helpers such
 * as `__udivti3` that libc itself references.
 * @param {{name: string}[]} existing archives already supplied on the command line
 * @returns {{name: string, data: Buffer}[]}
 */
function defaultLibraries(existing) {
  const names = new Set(existing.map((archive) => archive.name));
  /** @type {{name: string, data: Buffer}[]} */
  const libs = [];
  /** @param {string} file */
  const add = (file) => {
    const name = path.basename(file);
    if (names.has(name) || !fs.existsSync(file)) return;
    names.add(name);
    libs.push({ name, data: fs.readFileSync(file) });
  };

  const libc = findHostLibc();
  if (libc) add(libc);

  const machine = ELF_MACHINE[process.arch];
  const libgcc = machine === undefined ? null : findHostLibgcc(machine);
  if (libgcc) add(libgcc);
  return libs;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const inputs = options.inputFiles.map((file) => path.resolve(file));

  try {
    if (options.preprocessOnly) {
      if (inputs.length !== 1) fail('-E accepts exactly one input file');
      const tokens = preprocessFile(inputs[0], {
        includeDirs: options.includeDirs,
        defines: options.defines,
        undefs: options.undefs,
      });
      for (const tok of tokens) {
        if (tok.kind === 'eof') continue;
        process.stdout.write(tok.space ? ' ' : '');
        process.stdout.write(tok.text);
      }
      process.stdout.write('\n');
      return;
    }

    if (options.emitAsm) {
      if (inputs.length !== 1) fail('-S accepts exactly one input file');
      const ext = path.extname(inputs[0]);
      if (ext === '.o' || ext === '.a') fail('-S does not accept objects or archives');
      const asm = ext === '.s' || ext === '.S'
        ? fs.readFileSync(inputs[0], 'utf8')
        : compileToAsm(inputs[0], options);
      fs.writeFileSync(options.output, asm);
      return;
    }

    if (options.compileOnly) {
      if (inputs.length !== 1) fail('-c accepts exactly one input file');
      const ext = path.extname(inputs[0]);
      if (ext === '.a') fail('-c does not accept archives');
      const bytes = ext === '.o'
        ? fs.readFileSync(inputs[0])
        : compileToObject(inputs[0], options);
      fs.writeFileSync(options.output, bytes);
      return;
    }

    /** @type {{name: string, data: Buffer}[]} */
    const objects = [];
    /** @type {{name: string, data: Buffer}[]} */
    const archives = [];
    for (const inputFile of inputs) {
      const ext = path.extname(inputFile);
      if (ext === '.a') {
        archives.push({ name: path.basename(inputFile), data: fs.readFileSync(inputFile) });
      } else if (ext === '.o') {
        objects.push({ name: path.basename(inputFile), data: fs.readFileSync(inputFile) });
      } else {
        objects.push({ name: path.basename(inputFile), data: compileToObject(inputFile, options) });
      }
    }

    const { bytes } = link({
      objects,
      archives: options.nostdlib ? archives : [...archives, ...defaultLibraries(archives)],
    });
    fs.writeFileSync(options.output, bytes);
    fs.chmodSync(options.output, 0o755);
  } catch (error) {
    if (error instanceof CcError) {
      fail(error.message);
    }
    if (error instanceof LinkError) {
      fail(error.message);
    }
    throw error;
  }
}

main();

// Accept common compiler flags that our minimal cc doesn't explicitly handle
const originalParseArgs = parseArgs;
