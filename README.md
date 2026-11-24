[![mend](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/claymoreth/hidden-spec-cli-entry/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/claymoreth/hidden-spec-cli-entry/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend: one patch tool for every AI edit format

`mend` applies an edit that an AI model wrote to a tree of text files. Models write edits in four formats, and `mend` handles every one of them:

- a unified diff (often with wrong line numbers — hunks are matched by content, nearest to the stated position);
- SEARCH/REPLACE blocks;
- the V4A patch format;
- text-editor tool calls as JSON.

Every file is changed or nothing is: edits apply in order, a failed edit changes nothing and is reported, and when any edit fails no file is written at all.

Built for [make.fun](https://make.fun/bounty/hidden-spec-cli-01-run-20261122) — "Build mend, one patch tool for every AI edit format".

## Usage

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- The working directory is the root of the tree. Every path in a patch is relative to it.
- `PATCH` is the path of the patch file, relative to the working directory. When it is absent or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit 0 lists the changed files (`A` created, `D` deleted, `M` modified, `R old -> new` moved) and ends with `ok: <n> files`. Exit 1 lists each failed edit and ends with `failed: <k> of <n> edits`. Exit 2 reports a usage, missing-patch, format or parse error.

Matching works at three tiers: exact lines, then lines equal after trailing whitespace is removed, then lines equal after leading and trailing whitespace is removed (with new lines re-indented to the file's indentation). Line numbers in a unified diff are a hint, never trusted: a hunk lands on the occurrence nearest to its stated position.

## Files

- `main.ts` — the CLI. Node 22 and its standard library alone.
- `runner.ts` — the kit's trial runner, kept as it is.
- `LICENSE` — MIT.
