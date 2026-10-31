#!/usr/bin/env node
/**
 * Install (or remove) the `act` pre-commit hook.
 *
 * Usage:
 *   node scripts/install-pre-commit.js
 *   node scripts/install-pre-commit.js --uninstall
 *
 * The hook is a symlink from `<git hooks dir>/pre-commit` to
 * `scripts/pre-commit-act.js`, so edits take effect without reinstalling.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

/** @param {string[]} args @returns {string} */
function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

/**
 * Seed act's config so it never prompts for a runner image on first use.
 * @returns {string}
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
    return file;
  } catch (error) {
    if (error && error.code === 'EEXIST') return file;
    throw error;
  }
}

/** @param {string} command @param {string[]} args @returns {boolean} */
function works(command, args) {
  try {
    return spawnSync(command, args, { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

function main() {
  const uninstall = process.argv.includes('--uninstall');
  const repoRoot = git(['rev-parse', '--show-toplevel']);
  const script = path.join(repoRoot, 'scripts', 'pre-commit-act.js');
  const hooksDir = path.resolve(repoRoot, git(['rev-parse', '--git-path', 'hooks']));
  const hookPath = path.join(hooksDir, 'pre-commit');

  if (uninstall) {
    try {
      const stat = fs.lstatSync(hookPath);
      if (!stat.isSymbolicLink()) {
        console.error(`refusing to delete ${hookPath}: it is not a symlink managed by this installer`);
        process.exitCode = 1;
        return;
      }
      fs.unlinkSync(hookPath);
      console.log(`removed ${hookPath}`);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        console.log(`nothing to remove at ${hookPath}`);
        return;
      }
      throw error;
    }
    return;
  }

  if (!fs.existsSync(script)) {
    console.error(`missing hook script: ${script}`);
    process.exitCode = 1;
    return;
  }

  fs.chmodSync(script, 0o755);
  fs.mkdirSync(hooksDir, { recursive: true });

  let existing = null;
  try {
    existing = fs.lstatSync(hookPath);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }

  if (existing) {
    const target = existing.isSymbolicLink() ? fs.readlinkSync(hookPath) : null;
    const resolved = target ? path.resolve(hooksDir, target) : null;
    if (resolved === script) {
      console.log(`already installed: ${hookPath} -> ${script}`);
      return;
    }
    const backup = `${hookPath}.backup-${Date.now()}`;
    fs.renameSync(hookPath, backup);
    console.log(`backed up existing hook to ${backup}`);
  }

  fs.symlinkSync(script, hookPath);
  console.log(`installed: ${hookPath} -> ${script}`);

  const actrc = ensureActConfig();
  console.log(`act config: ${actrc}`);

  if (!works('act', ['--version'])) {
    console.warn('WARNING: `act` is not installed or not on PATH; the hook will fail until it is available');
  }
  if (!works('podman', ['--version']) && !works('docker', ['--version'])) {
    console.warn('WARNING: neither podman nor docker was found; the hook will fail without a container runtime');
  }

  console.log('the hook runs `act` with a 30s deadline; set ACT_PRECOMMIT_SKIP=1 to bypass once');
  console.log('remove it with: node scripts/install-pre-commit.js --uninstall');
}

main();
