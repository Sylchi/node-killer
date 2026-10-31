#!/usr/bin/env node
/**
 * C compiler driver for the JavaScript C compiler.
 *
 * Usage:
 *   node scripts/cc.js [options] <file.c>
 *
 * Options:
 *   -o <file>     Output file (default: a.out)
 *   -S            Stop after compilation, emit assembly
 *   -c            Compile and assemble, but do not link
 *   -E            Stop after preprocessing
 *   -I <dir>      Add include directory
 *   -D <name[=val]>  Define macro
 *   -U <name>     Undefine macro
 *   -v, --verbose Print commands before running
 *   -h, --help    Show this help
 *
 * @module cc
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { preprocessFile, CcError } from './cc/tokenize.js';
import { parse } from './cc/parse.js';
import { codegen } from './cc/codegen.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(message) {
  process.stderr.write(`cc: ${message}\n`);
  process.exit(1);
}

function printHelp() {
  const help = `Usage: node scripts/cc.js [options] <file.c>

Options:
  -o <file>     Output file (default: a.out)
  -S            Stop after compilation, emit assembly
  -c            Compile and assemble, but do not link
  -E            Stop after preprocessing
  -I <dir>      Add include directory
  -D <name[=val]>  Define macro
  -U <name>     Undefine macro
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
    } else if (arg === '-v' || arg === '--verbose') {
      options.verbose = true;
    } else if (arg.startsWith('-')) {
      fail(`unknown option '${arg}'`);
    } else {
      options.inputFiles.push(arg);
    }
  }

  if (options.inputFiles.length === 0) {
    fail('no input files');
  }
  if (options.inputFiles.length > 1) {
    fail('only one input file is supported');
  }
  return options;
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{verbose?: boolean}} options
 */
function run(command, args, options = {}) {
  if (options.verbose) {
    process.stderr.write(`+ ${command} ${args.join(' ')}\n`);
  }
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) {
    fail(`${command} failed with status ${result.status}`);
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const inputFile = path.resolve(options.inputFiles[0]);

  try {
    const tokens = preprocessFile(inputFile, {
      includeDirs: options.includeDirs,
      defines: options.defines,
      undefs: options.undefs,
    });

    if (options.preprocessOnly) {
      for (const tok of tokens) {
        if (tok.kind === 'eof') continue;
        process.stdout.write(tok.space ? ' ' : '');
        process.stdout.write(tok.text);
      }
      process.stdout.write('\n');
      return;
    }

    const { globals, functions } = parse(tokens);
    const asm = codegen(globals, functions);

    if (options.emitAsm) {
      fs.writeFileSync(options.output, asm);
      return;
    }

    // Write assembly to a temporary file
    const asmFile = path.join(path.dirname(inputFile), `${path.basename(inputFile, '.c')}.s`);
    fs.writeFileSync(asmFile, asm);

    if (options.compileOnly) {
      // Assemble to object file
      const objFile = options.output.endsWith('.o') ? options.output : `${path.basename(inputFile, '.c')}.o`;
      run('cc', ['-c', asmFile, '-o', objFile], { verbose: options.verbose });
      fs.unlinkSync(asmFile);
      return;
    }

    // Link
    run('cc', [asmFile, '-o', options.output], { verbose: options.verbose });
    fs.unlinkSync(asmFile);
  } catch (error) {
    if (error instanceof CcError) {
      fail(error.message);
    }
    throw error;
  }
}

main();
