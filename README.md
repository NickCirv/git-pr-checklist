<div align="center">

# git-pr-checklist

**Catch console.logs, secrets, and broken tests before they reach your PR**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue?labelColor=0B0A09)](LICENSE)
[![Zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen?labelColor=0B0A09)](package.json)
[![Node >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen?labelColor=0B0A09)](package.json)

</div>

## Install

```bash
npx github:NickCirv/git-pr-checklist init
```

Or install the `prc` shorthand globally:

```bash
npm install -g github:NickCirv/git-pr-checklist
```

## Usage

```bash
prc init            # scaffold .pr-checklist.json in your project
prc                 # run all checks against main (or configured base)
prc install-hook    # install as git pre-push hook — runs automatically on every push
prc --interactive   # prompt to override individual failures
prc --base develop  # diff against a different base branch
```

| Flag | Description |
|------|-------------|
| `--base <branch>` | Base branch to diff against (default: `main`) |
| `--config <path>` | Path to config file (default: `.pr-checklist.json`) |
| `--interactive` | Prompt to override each failed check |

## What it does

Reads a `.pr-checklist.json` config and runs each check against the diff between your branch and the base. Built-in check types cover `console.log` scanning, TODO/FIXME detection, secret pattern matching (OpenAI keys, GitHub tokens, AWS keys, PEM blocks, and more), branch-name conventions, commit and file-count limits, and arbitrary shell commands. Exit code `0` = all checks pass; `1` = at least one failure. Warnings never fail the run.

```
git-pr-checklist
branch: feat/my-feature  base: main  commits: 3  files: 7

  ✅  PASS  No console.log
  ⚠️   WARN  No TODO/FIXME
  ❌  FAIL  Tests pass
  ✅  PASS  No secrets in diff

──────────────────────────────────────────────────
  2 passed  1 failed  1 warned

❌ 1 check(s) failed. Fix before pushing.
```

---
<sub>Zero dependencies · Node ≥18 · MIT · by <a href="https://github.com/NickCirv">NickCirv</a></sub>
