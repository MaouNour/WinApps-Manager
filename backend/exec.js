'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const { LOG_FILE } = require('./paths');

function log(line) {
  try {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`);
  } catch (_) { /* best effort */ }
}

/**
 * Run a command, optionally streaming stdout/stderr lines to onLine.
 * Resolves with { code, stdout, stderr }. Rejects on non-zero exit unless
 * opts.allowFail is true.
 */
function run(cmd, args = [], opts = {}) {
  const { onLine, allowFail = false, sudo = false, cwd } = opts;
  const realCmd = sudo ? 'pkexec' : cmd;
  const realArgs = sudo ? [cmd, ...args] : args;
  log(`RUN ${realCmd} ${realArgs.join(' ')}`);

  return new Promise((resolve, reject) => {
    const child = spawn(realCmd, realArgs, { cwd });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      chunk.toString().split('\n').filter(Boolean).forEach((l) => {
        log(`OUT ${l}`);
        if (onLine) onLine(l, 'stdout');
      });
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      chunk.toString().split('\n').filter(Boolean).forEach((l) => {
        log(`ERR ${l}`);
        if (onLine) onLine(l, 'stderr');
      });
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code !== 0 && !allowFail) {
        reject(new Error(`${cmd} exited with code ${code}: ${stderr || stdout}`));
      } else {
        resolve({ code, stdout, stderr });
      }
    });
  });
}

/** Check whether a binary exists on PATH. */
async function which(bin) {
  try {
    const { stdout } = await run('which', [bin]);
    return stdout.trim() || null;
  } catch (_) {
    return null;
  }
}

module.exports = { run, which, log };
