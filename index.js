#!/usr/bin/env node
// git-pr-checklist — zero-dependency pre-PR checklist runner
// Node 18+, pure ES modules, no exec/execSync, all subprocess via spawnSync/execFileSync

import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { createInterface } from 'node:readline';

// ─── ANSI colours ────────────────────────────────────────────────────────────
const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  white:  '\x1b[37m',
  gray:   '\x1b[90m',
};

const icon = { PASS: '✅', FAIL: '❌', WARN: '⚠️ ', SKIP: '⏭️ ' };
const col  = { PASS: c.green, FAIL: c.red, WARN: c.yellow, SKIP: c.gray };

// ─── Helpers ─────────────────────────────────────────────────────────────────
function git(...args) {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  if (r.error) throw new Error(`git ${args[0]}: ${r.error.message}`);
  return { stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim(), status: r.status };
}

function run(cmd, args = []) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: false });
  return { stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim(), status: r.status ?? 1, error: r.error };
}

function findConfigFile() {
  let dir = process.cwd();
  const root = resolve('/');
  while (dir !== root) {
    const p = join(dir, '.pr-checklist.json');
    if (existsSync(p)) return p;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function loadConfig(configPath) {
  const p = configPath || findConfigFile();
  if (!p) {
    console.error(`${c.red}No .pr-checklist.json found. Run: prc init${c.reset}`);
    process.exit(1);
  }
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    console.error(`${c.red}Invalid JSON in ${p}: ${e.message}${c.reset}`);
    process.exit(1);
  }
}

function getChangedFiles(base) {
  const r = git('diff', '--name-only', `${base}...HEAD`);
  if (r.status !== 0) return [];
  return r.stdout.split('\n').filter(Boolean);
}

function getDiff(base) {
  const r = git('diff', `${base}...HEAD`);
  return r.stdout;
}

function getCommitCount(base) {
  const r = git('rev-list', '--count', `${base}...HEAD`);
  return parseInt(r.stdout, 10) || 0;
}

function getCurrentBranch() {
  return git('rev-parse', '--abbrev-ref', 'HEAD').stdout;
}

function fileContainsPattern(filePath, pattern) {
  try {
    const content = readFileSync(filePath, 'utf8');
    return pattern.test(content);
  } catch {
    return false;
  }
}

// ─── Check runners ────────────────────────────────────────────────────────────
function runCheck(check, base) {
  const type = check.type;

  if (type === 'no-console-log') {
    const files = getChangedFiles(base).filter(f => /\.(js|ts|jsx|tsx|mjs|cjs)$/.test(f));
    const hits = [];
    for (const f of files) {
      if (!existsSync(f)) continue;
      const lines = readFileSync(f, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (/console\s*\.\s*log\s*\(/.test(line)) {
          hits.push(`  ${c.gray}${f}:${i + 1}${c.reset}  ${line.trim()}`);
        }
      });
    }
    if (hits.length === 0) return { status: 'PASS' };
    return { status: check.warn ? 'WARN' : 'FAIL', detail: hits.join('\n') };
  }

  if (type === 'no-todo') {
    const files = getChangedFiles(base);
    const hits = [];
    const pattern = /\b(TODO|FIXME)\b/;
    for (const f of files) {
      if (!existsSync(f)) continue;
      try {
        const lines = readFileSync(f, 'utf8').split('\n');
        lines.forEach((line, i) => {
          if (pattern.test(line)) {
            hits.push(`  ${c.gray}${f}:${i + 1}${c.reset}  ${line.trim()}`);
          }
        });
      } catch { /* binary file */ }
    }
    if (hits.length === 0) return { status: 'PASS' };
    return { status: check.warn ? 'WARN' : 'FAIL', detail: hits.join('\n') };
  }

  if (type === 'tests-pass' || type === 'build-passes') {
    const cmdParts = (check.command || (type === 'tests-pass' ? 'npm test' : 'npm run build')).split(/\s+/);
    const [cmd, ...args] = cmdParts;
    const r = run(cmd, args);
    if (r.error) return { status: 'FAIL', detail: `  Command not found: ${cmd}` };
    if (r.status === 0) return { status: 'PASS' };
    const out = [r.stdout, r.stderr].filter(Boolean).join('\n');
    return { status: 'FAIL', detail: out ? out.split('\n').slice(-10).map(l => `  ${l}`).join('\n') : undefined };
  }

  if (type === 'branch-name') {
    const branch = getCurrentBranch();
    const pattern = new RegExp(check.pattern || '.+');
    if (pattern.test(branch)) return { status: 'PASS', detail: `  branch: ${branch}` };
    return {
      status: check.warn ? 'WARN' : 'FAIL',
      detail: `  branch "${branch}" does not match /${check.pattern}/`,
    };
  }

  if (type === 'commit-count') {
    const count = getCommitCount(base);
    const max = check.max || 20;
    if (count <= max) return { status: 'PASS', detail: `  ${count} commit(s)` };
    return {
      status: check.warn ? 'WARN' : 'FAIL',
      detail: `  ${count} commits exceed max of ${max}`,
    };
  }

  if (type === 'files-changed') {
    const files = getChangedFiles(base);
    const max = check.max || 50;
    if (files.length <= max) return { status: 'PASS', detail: `  ${files.length} file(s) changed` };
    return {
      status: check.warn ? 'WARN' : 'FAIL',
      detail: `  ${files.length} files exceed max of ${max}`,
    };
  }

  if (type === 'no-secrets') {
    const diff = getDiff(base);
    const patterns = [
      { re: /sk-[A-Za-z0-9]{20,}/g,        label: 'OpenAI key' },
      { re: /ghp_[A-Za-z0-9]{36}/g,         label: 'GitHub token' },
      { re: /AKIA[A-Z0-9]{16}/g,             label: 'AWS key' },
      { re: /xoxb-[0-9A-Za-z-]+/g,          label: 'Slack bot token' },
      { re: /AIza[0-9A-Za-z_-]{35}/g,       label: 'Google API key' },
      { re: /-----BEGIN (RSA|EC|DSA|OPENSSH) PRIVATE KEY-----/g, label: 'Private key' },
    ];
    const hits = [];
    for (const { re, label } of patterns) {
      const matches = diff.match(re);
      if (matches) hits.push(`  ${label}: ${matches.length} match(es)`);
    }
    if (hits.length === 0) return { status: 'PASS' };
    return { status: 'FAIL', detail: hits.join('\n') };
  }

  if (type === 'custom') {
    if (!check.command) return { status: 'SKIP', detail: '  No command specified' };
    const [cmd, ...args] = check.command.split(/\s+/);
    const r = run(cmd, args);
    if (r.error) return { status: 'FAIL', detail: `  Command not found: ${cmd}` };
    if (r.status === 0) return { status: 'PASS' };
    const out = [r.stdout, r.stderr].filter(Boolean).join('\n');
    return { status: check.warn ? 'WARN' : 'FAIL', detail: out ? out.split('\n').slice(-5).map(l => `  ${l}`).join('\n') : undefined };
  }

  return { status: 'SKIP', detail: `  Unknown check type: ${type}` };
}

// ─── Interactive TUI ──────────────────────────────────────────────────────────
async function interactiveRun(results) {
  const failed = results.filter(r => r.result.status === 'FAIL');
  if (failed.length === 0) return true;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(res => rl.question(q, res));

  console.log(`\n${c.bold}${c.yellow}Interactive mode — ${failed.length} check(s) failed${c.reset}`);

  for (const item of failed) {
    console.log(`\n${c.bold}Failed:${c.reset} ${item.check.name}`);
    if (item.result.detail) console.log(item.result.detail);
    const ans = await ask(`  Override and continue? [y/N] `);
    if (ans.toLowerCase() !== 'y') {
      rl.close();
      return false;
    }
  }

  rl.close();
  console.log(`\n${c.yellow}All failures overridden by user.${c.reset}`);
  return true;
}

// ─── Commands ─────────────────────────────────────────────────────────────────
function cmdInit() {
  const dest = join(process.cwd(), '.pr-checklist.json');
  if (existsSync(dest)) {
    console.log(`${c.yellow}.pr-checklist.json already exists.${c.reset}`);
    return;
  }

  const example = {
    base: 'main',
    checks: [
      {
        name: 'No console.log',
        type: 'no-console-log',
        warn: false,
      },
      {
        name: 'No TODO/FIXME',
        type: 'no-todo',
        warn: true,
      },
      {
        name: 'Tests pass',
        type: 'tests-pass',
        command: 'npm test',
      },
      {
        name: 'Build passes',
        type: 'build-passes',
        command: 'npm run build',
      },
      {
        name: 'Branch name convention',
        type: 'branch-name',
        pattern: '^(feat|fix|chore|docs|refactor|test)/.+',
        warn: true,
      },
      {
        name: 'Max 10 commits',
        type: 'commit-count',
        max: 10,
        warn: true,
      },
      {
        name: 'Max 30 files changed',
        type: 'files-changed',
        max: 30,
        warn: true,
      },
      {
        name: 'No secrets in diff',
        type: 'no-secrets',
      },
      {
        name: 'Lint passes',
        type: 'custom',
        command: 'npm run lint',
        warn: false,
      },
    ],
  };

  writeFileSync(dest, JSON.stringify(example, null, 2) + '\n');
  console.log(`${c.green}Created .pr-checklist.json${c.reset}`);
  console.log(`${c.gray}Edit it to match your project's needs.${c.reset}`);
}

function cmdInstallHook() {
  const hookDir = join(process.cwd(), '.git', 'hooks');
  if (!existsSync(hookDir)) {
    console.error(`${c.red}Not a git repo (no .git/hooks found)${c.reset}`);
    process.exit(1);
  }

  const hookPath = join(hookDir, 'pre-push');
  const hookContent = `#!/bin/sh
# Installed by git-pr-checklist
prc
`;

  writeFileSync(hookPath, hookContent, { mode: 0o755 });
  console.log(`${c.green}Installed pre-push hook at ${hookPath}${c.reset}`);
  console.log(`${c.gray}Runs prc automatically on every git push.${c.reset}`);
}

function cmdHelp() {
  console.log(`
${c.bold}git-pr-checklist${c.reset} — pre-PR checklist runner

${c.bold}USAGE${c.reset}
  prc [options]            Run all checks
  prc init                 Create .pr-checklist.json with examples
  prc install-hook         Install as git pre-push hook
  prc --help               Show this help

${c.bold}OPTIONS${c.reset}
  --base <branch>          Base branch to diff against  (default: main)
  --config <path>          Path to config file           (default: .pr-checklist.json)
  --interactive            Prompt to override failures
  --help                   Show this help

${c.bold}CHECK TYPES${c.reset}
  no-console-log           Scan changed JS/TS files for console.log
  no-todo                  Scan changed files for TODO/FIXME
  tests-pass               Run test command, check exit code
  build-passes             Run build command, check exit code
  branch-name              Regex test on current branch name
  commit-count             Max commits since base
  files-changed            Max files changed since base
  no-secrets               Scan diff for leaked credentials
  custom                   Run any shell command

${c.bold}EXAMPLES${c.reset}
  prc --base develop
  prc --interactive
  prc --config ./config/.pr-checklist.json
`);
}

async function cmdRun(opts) {
  const config = loadConfig(opts.config);
  const base = opts.base || config.base || 'main';
  const checks = config.checks || [];

  if (checks.length === 0) {
    console.log(`${c.yellow}No checks defined in config.${c.reset}`);
    return;
  }

  // Verify base branch exists
  const baseCheck = git('rev-parse', '--verify', base);
  if (baseCheck.status !== 0) {
    console.error(`${c.red}Base branch "${base}" not found. Use --base to specify.${c.reset}`);
    process.exit(1);
  }

  const branch = getCurrentBranch();
  const fileCount = getChangedFiles(base).length;
  const commitCount = getCommitCount(base);

  console.log(`\n${c.bold}git-pr-checklist${c.reset}`);
  console.log(`${c.dim}branch: ${branch}  base: ${base}  commits: ${commitCount}  files: ${fileCount}${c.reset}\n`);

  const results = [];
  let maxNameLen = 0;
  for (const check of checks) maxNameLen = Math.max(maxNameLen, (check.name || check.type || '').length);

  for (const check of checks) {
    const name = (check.name || check.type || 'unnamed').padEnd(maxNameLen);
    process.stdout.write(`  ${c.dim}running${c.reset}  ${name}\r`);

    let result;
    try {
      result = runCheck(check, base);
    } catch (e) {
      result = { status: 'FAIL', detail: `  ${e.message}` };
    }

    results.push({ check, result });

    const statusIcon = icon[result.status] || '?';
    const statusCol  = col[result.status] || c.white;
    console.log(`  ${statusIcon}  ${statusCol}${result.status}${c.reset}  ${name}`);
    if (result.detail) console.log(`${c.gray}${result.detail}${c.reset}`);
  }

  const passed  = results.filter(r => r.result.status === 'PASS').length;
  const failed  = results.filter(r => r.result.status === 'FAIL').length;
  const warned  = results.filter(r => r.result.status === 'WARN').length;
  const skipped = results.filter(r => r.result.status === 'SKIP').length;

  console.log(`\n${c.dim}${'─'.repeat(50)}${c.reset}`);
  console.log(
    `  ${c.green}${passed} passed${c.reset}` +
    (failed  ? `  ${c.red}${failed} failed${c.reset}`    : '') +
    (warned  ? `  ${c.yellow}${warned} warned${c.reset}` : '') +
    (skipped ? `  ${c.gray}${skipped} skipped${c.reset}` : '')
  );

  if (failed === 0) {
    console.log(`\n${c.green}${c.bold}All checks passed. Safe to push.${c.reset}\n`);
    return;
  }

  if (opts.interactive) {
    const ok = await interactiveRun(results);
    if (ok) return;
  }

  console.log(`\n${c.red}${c.bold}${failed} check(s) failed. Fix before pushing.${c.reset}\n`);
  process.exit(1);
}

// ─── Argument parsing ─────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { base: null, config: null, interactive: false };
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--base')        { opts.base = args[++i]; continue; }
    if (a === '--config')      { opts.config = args[++i]; continue; }
    if (a === '--interactive') { opts.interactive = true; continue; }
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    positional.push(a);
  }

  opts.subcommand = positional[0] || null;
  return opts;
}

// ─── Entry point ──────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv);

  if (opts.help || opts.subcommand === 'help') { cmdHelp(); return; }
  if (opts.subcommand === 'init')              { cmdInit(); return; }
  if (opts.subcommand === 'install-hook')      { cmdInstallHook(); return; }

  await cmdRun(opts);
}

main().catch(e => {
  console.error(`${c.red}Fatal: ${e.message}${c.reset}`);
  process.exit(1);
});
