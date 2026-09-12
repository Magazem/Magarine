#!/usr/bin/env node
'use strict';
// Throwaway spike script. Not production code. See docs/spikes/claude-cli-adapter.md.
//
// Runs `claude -p` in a disposable temp workspace (never this repo), captures
// stdout/stderr/exit-code/duration, and writes raw output under runs/<ts>-<mode>/
// so results are reproducible without spending more API usage.
//
// Usage: node run-worker.js <mode> [--timeout-ms N] [--workspace DIR]
//   modes: happy | restrict-write | cancel | stream

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const MODES = ['happy', 'restrict-write', 'disallow-write', 'cancel', 'stream'];

function usage() {
  console.error(
    `Usage: node run-worker.js <mode> [--timeout-ms N] [--workspace DIR]\nmodes: ${MODES.join(' | ')}\n\nAlways runs claude with cwd set to a disposable temp workspace (default: a\nfresh dir under the OS temp dir; pass --workspace to reuse one). Never point\n--workspace at this repository.`
  );
  process.exit(1);
}

const args = process.argv.slice(2);
const mode = args[0];
if (!MODES.includes(mode)) usage();

let timeoutMs = 90000;
let workspace = null;
let permissionMode = 'bypassPermissions';
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--timeout-ms') timeoutMs = Number(args[++i]);
  if (args[i] === '--workspace') workspace = args[++i];
  if (args[i] === '--permission-mode') permissionMode = args[++i];
}

const repoRoot = path.resolve(__dirname, '..', '..');
if (workspace && path.resolve(workspace).startsWith(repoRoot)) {
  console.error('Refusing to use a workspace inside the Magarine repository.');
  process.exit(1);
}

const schema = fs.readFileSync(path.join(__dirname, 'result-schema.json'), 'utf8');

const PROMPTS = {
  happy:
    'Create a file named hello.txt in the current directory containing the text ' +
    '"hello from magarine worker". Then create a directory named .orchestrator and ' +
    'write a file .orchestrator/result.json that matches the JSON schema you were given, ' +
    'describing what you did. Use status "ready_for_review", one artifact entry for ' +
    'hello.txt (kind "file"), an empty checks array, and empty blockers/questions arrays. ' +
    'Do not ask any questions. Do not do anything else.',
  'restrict-write':
    'Create a file named hello.txt in the current directory containing the text ' +
    '"hello from magarine worker". Then create a directory named .orchestrator and ' +
    'write a file .orchestrator/result.json describing what you did, matching the schema ' +
    'you were given.',
  'disallow-write':
    'Create a file named hello.txt in the current directory containing the text ' +
    '"hello from magarine worker". Then create a directory named .orchestrator and ' +
    'write a file .orchestrator/result.json describing what you did, matching the schema ' +
    'you were given.',
  cancel: 'Run a shell command that sleeps for 120 seconds, then create a file named done.txt.',
  stream:
    'Create a file named hello.txt in the current directory containing the text ' +
    '"hello from magarine worker". Then create a directory named .orchestrator and ' +
    'write a file .orchestrator/result.json that matches the JSON schema you were given. ' +
    'Use status "ready_for_review", one artifact entry for hello.txt, empty checks/blockers/questions.',
};

function makeWorkspace() {
  if (workspace) {
    fs.mkdirSync(workspace, { recursive: true });
    return workspace;
  }
  return fs.mkdtempSync(path.join(os.tmpdir(), 'magarine-spike-'));
}

function runDir() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(__dirname, 'runs', `${stamp}-${mode}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Node's child_process on Windows cannot spawn `claude.cmd` directly with
// shell:false (EINVAL: CreateProcess can't exec a batch file), and shell:true
// with an args array silently corrupts any argument containing quotes/braces
// (Node just space-joins the array with no per-arg escaping — this is exactly
// what DEP0190 warns about). It repeatably truncated our --json-schema JSON.
// Passing cmd.exe /c the same array reproduces the same corruption, because
// cmd.exe re-tokenizes its /c payload with its own quoting rules, not the
// target process's argv rules.
// Fix, verified empirically (zero-cost runs against a faked empty HOME so the
// CLI fails at the "not logged in" step instead of an API call): build the
// command as a single POSIX-quoted string and run it through Git Bash
// (already present on this machine at the path below), the same way this
// tool's own Bash tool executes commands. Git Bash's argv handling passed the
// JSON schema through intact; cmd.exe's did not.
function shQuote(s) {
  return `'${String(s).replace(/'/g, `'"'"'`)}'`;
}

const GIT_BASH = 'C:/Program Files/Git/usr/bin/bash.exe';

async function main() {
  const ws = makeWorkspace();
  const out = runDir();
  const prompt = PROMPTS[mode];
  const outputFormat = mode === 'stream' ? 'stream-json' : 'json';
  const allowedTools = mode === 'restrict-write' ? 'Read' : 'Write,Bash';

  const cliArgs = [
    '-p',
    prompt,
    '--output-format',
    outputFormat,
    '--json-schema',
    schema,
    '--permission-mode',
    permissionMode,
    '--allowedTools',
    allowedTools,
  ];
  if (mode === 'disallow-write') {
    cliArgs.push('--disallowedTools', 'Write,Edit,Bash');
  }
  if (mode === 'stream') {
    // stream-json requires --verbose in this CLI build (2.1.261): "When using
    // --print, --output-format=stream-json requires --verbose" (observed, exit 1).
    cliArgs.push('--verbose');
  }

  fs.writeFileSync(path.join(out, 'workspace.txt'), ws);

  const startedAt = Date.now();
  let child;
  if (process.platform === 'win32') {
    const cmdString = `claude ${cliArgs.map(shQuote).join(' ')}`;
    fs.writeFileSync(path.join(out, 'command.txt'), `cwd=${ws}\n${cmdString}`);
    child = spawn(GIT_BASH, ['-c', cmdString], { cwd: ws, shell: false });
  } else {
    fs.writeFileSync(
      path.join(out, 'command.txt'),
      `cwd=${ws}\nclaude ${cliArgs.map((a) => JSON.stringify(a)).join(' ')}`
    );
    child = spawn('claude', cliArgs, { cwd: ws, shell: false });
  }

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));

  let killedByTimeout = false;
  const timer = setTimeout(() => {
    killedByTimeout = true;
    // Deliberately a bare, single-process kill (no /T tree-kill, no process
    // group) — this is what a naive daemon implementation would do, and it is
    // exactly the question item 2 of the spec asks: does this leave orphans?
    child.kill('SIGTERM');
  }, timeoutMs);

  const exitCode = await new Promise((resolve) => {
    child.on('close', (code) => resolve(code));
    child.on('error', (err) => {
      stderr += `\n[spawn error] ${err.message}`;
      resolve(null);
    });
  });
  clearTimeout(timer);
  const durationMs = Date.now() - startedAt;

  let orphanCheck = null;
  if (mode === 'cancel' && process.platform === 'win32') {
    // Give any descendant processes a moment to either exit on their own or
    // reveal themselves as orphans, then snapshot the process table for
    // anything still holding a handle to the workspace or matching the tools
    // this run was allowed to use (node/bash/claude-related).
    await new Promise((r) => setTimeout(r, 3000));
    const ps = spawn('powershell.exe', [
      '-NoProfile',
      '-Command',
      "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'node|bash|claude|cmd|conhost|sleep' } | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json",
    ]);
    let psOut = '';
    await new Promise((resolve) => {
      ps.stdout.on('data', (d) => (psOut += d));
      ps.on('close', resolve);
    });
    orphanCheck = psOut;
  }

  fs.writeFileSync(path.join(out, 'stdout.txt'), stdout);
  fs.writeFileSync(path.join(out, 'stderr.txt'), stderr);

  let workspaceListing = [];
  try {
    workspaceListing = fs.readdirSync(ws);
  } catch {}
  let resultJson = null;
  try {
    resultJson = fs.readFileSync(path.join(ws, '.orchestrator', 'result.json'), 'utf8');
  } catch {}

  const summary = {
    mode,
    workspace: ws,
    pid: child.pid,
    exitCode,
    killedByTimeout,
    durationMs,
    workspaceListing,
    resultJsonPresent: !!resultJson,
  };
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  if (resultJson) fs.writeFileSync(path.join(out, 'result.json'), resultJson);
  if (orphanCheck !== null) fs.writeFileSync(path.join(out, 'orphan-check.json'), orphanCheck);

  console.log(JSON.stringify(summary, null, 2));
}

main();
