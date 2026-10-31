#!/usr/bin/env node
/**
 * Test runner for the JavaScript C compiler.
 *
 * Compiles each test program in tests/cc/ and runs it, checking for expected
 * exit codes and output.
 *
 * @module cc/test
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');
const testDir = path.join(root, 'tests', 'cc');
const buildDir = path.join(root, 'build', 'cc-tests');
const ccScript = path.join(root, 'scripts', 'cc.js');

function fail(message) {
  process.stderr.write(`cc-test: ${message}\n`);
  process.exit(1);
}

/**
 * @param {string[]} argv
 * @returns {string|null} compiler executable, or null to run scripts/cc.js
 */
function parseArgs(argv) {
  let compiler = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--compiler') {
      compiler = argv[++i];
      if (!compiler) fail('--compiler requires a path');
    } else if (arg.startsWith('--compiler=')) {
      compiler = arg.slice('--compiler='.length);
      if (!compiler) fail('--compiler requires a path');
    } else if (arg === '-h' || arg === '--help') {
      process.stdout.write(
        'Usage: node scripts/cc/test.js [--compiler <path>]\n\n' +
          '  --compiler <path>  compile tests with this executable instead of scripts/cc.js\n',
      );
      process.exit(0);
    } else {
      fail(`unknown option '${arg}' (try --help)`);
    }
  }
  return compiler;
}

const compiler = parseArgs(process.argv.slice(2));
const compileCommand = compiler ? [compiler] : ['node', ccScript];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: options.capture ? 'pipe' : 'inherit',
    cwd: options.cwd,
  });
  if (result.status !== 0 && !options.allowFail) {
    fail(`${command} failed with status ${result.status}`);
  }
  return result;
}

function runTest(testFile) {
  const baseName = path.basename(testFile, '.c');
  const expectedFile = path.join(testDir, `${baseName}.expected`);
  const outputFile = path.join(buildDir, baseName);

  // Compile
  const compileResult = run(compileCommand[0], [...compileCommand.slice(1), testFile, '-o', outputFile], {
    capture: true,
    allowFail: true,
  });
  if (compileResult.status !== 0) {
    process.stderr.write(compileResult.stderr.toString());
    return { name: baseName, status: 'COMPILE_FAIL' };
  }

  // Run
  const runResult = spawnSync(outputFile, [], {
    stdio: 'pipe',
    encoding: 'utf8',
  });

  // Check expected
  if (!fs.existsSync(expectedFile)) {
    return { name: baseName, status: 'NO_EXPECTED', exitCode: runResult.status };
  }

  const expected = fs.readFileSync(expectedFile, 'utf8');
  const expectedMatch = expected.match(/exit:\s*(\d+)/);
  const expectedExit = expectedMatch ? parseInt(expectedMatch[1], 10) : 0;

  if (runResult.status !== expectedExit) {
    return {
      name: baseName,
      status: 'EXIT_MISMATCH',
      expected: expectedExit,
      actual: runResult.status,
      stdout: runResult.stdout,
    };
  }

  return { name: baseName, status: 'PASS' };
}

function main() {
  if (!fs.existsSync(testDir)) {
    process.stdout.write('No tests found.\n');
    return;
  }

  // Create build directory
  fs.mkdirSync(buildDir, { recursive: true });

  const tests = fs
    .readdirSync(testDir)
    .filter((name) => name.endsWith('.c'))
    .map((name) => path.join(testDir, name));

  if (tests.length === 0) {
    process.stdout.write('No tests found.\n');
    return;
  }

  process.stdout.write(`Running ${tests.length} test(s)...\n\n`);

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    const result = runTest(test);
    switch (result.status) {
      case 'PASS':
        process.stdout.write(`✓ ${result.name}\n`);
        passed += 1;
        break;
      case 'COMPILE_FAIL':
        process.stdout.write(`✗ ${result.name} (compile failed)\n`);
        failed += 1;
        break;
      case 'NO_EXPECTED':
        process.stdout.write(`? ${result.name} (no .expected file, exit=${result.exitCode})\n`);
        break;
      case 'EXIT_MISMATCH':
        process.stdout.write(`✗ ${result.name} (exit ${result.actual}, expected ${result.expected})\n`);
        if (result.stdout) process.stdout.write(`  stdout: ${result.stdout.slice(0, 100)}\n`);
        failed += 1;
        break;
      default:
        process.stdout.write(`? ${result.name} (unknown status)\n`);
    }
  }

  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
