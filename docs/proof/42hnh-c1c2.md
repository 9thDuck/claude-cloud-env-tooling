tooling head: eb1d142f720923596cb75c846c0654fc6ced15b9

# diff-review C1+C2 proof (bead astro_template-42hnh)

Code commit `eb1d142f720923596cb75c846c0654fc6ced15b9` on
`claude/project-thread-6yoovy` (not pushed; this proof is a follow-up commit).
Files: `diff-review/diff-review-lib.mjs`, `diff-review/diff-review.mjs`,
`test/diff-review-lib.test.mjs`, `test/diff-review.test.mjs`, `README.md`.

## npm test

Run with the project suite only (a temporary `.work/old-tooling` worktree used
for the C1 old-code proof is still on disk; plain `npm test` also passes but
also discovers that worktree's duplicated tests, 127 passed):

```
$ npx vitest run --exclude '.work/**' --exclude 'node_modules/**'

 Test Files  3 passed (3)
      Tests  72 passed (72)
```

New coverage:

- `splitDiff` orders `src/`, `e2e/`, `scripts/`, `config/`, tests first and
  `docs/`, `.beads/` last, packs whole files under the limit, and splits one
  oversized file by hunk while keeping every hunk;
- planted coverage drop: removing one file from the chunks yields
  `file src/a.js is in the diff but no chunk covers it`; dropping a whole chunk
  also yields problems; a diff with no file headers is a problem;
- `mergeVerdicts`: PASS only when all chunks pass, FAIL when any fails (with
  `chunk N:` prefixes on untested), ERROR when any chunk errors or there are no
  chunks;
- C1 integration: a fake worker reads `./app.js`, a repo file *outside* the
  diff, and writes its verdict; the review passes only because the worker runs
  in the repository root;
- C2 integration: three files at a small chunk limit produce multiple
  `chunks/<n>/` worker runs; `verdict.md` lists every chunk and every file with
  no `not covered`;
- CLI `--diff-file` end-to-end: the reviewer runs in the repo root, an advisory
  FAIL exits 0, and the verdict path is printed.

## diff-review --self-test

```
$ node diff-review/diff-review.mjs --self-test
...
diff-review: ERROR report: chunk 1: the worker exited non-zero twice
diff-review: ERROR (advisory) chunk 1: the worker exited non-zero twice
...
case  verdict  findings  verdict.md
bad   ERROR    0         /root/.local/state/diff-review/self-test-runs/...-bad/verdict.md
good  ERROR    0         /root/.local/state/diff-review/self-test-runs/...-good/verdict.md
self-test FAIL: bad=ERROR good=ERROR (/root/.local/state/diff-review/self-test.json)
exit 1
```

Cause: this session has no `ECO_WORKER_API_KEY`; eco-worker exits 2 with
`FAILED ECO_WORKER_API_KEY not set` on both attempts for both fixtures. This is
**unproven here**; rerun with the endpoint key (the caller will).

## C1 planted proof (old code denies/errors, new code reads)

Same planted repo (committed `app.js` is not in the diff), same fake worker.
The old module is `cd24044` (pre-fix) loaded from a worktree; the new module is
`eb1d142`. The fake worker does `value="$(cat app.js)"` and writes its verdict
and a proof file to its log directory.

```
$ node .work/c1-demo.mjs
[diff-review] worker attempt 1/2 (-d .../.diff-review/2026-10-30T15-37-54-415Z-old)
cat: app.js: No such file or directory
[diff-review] FAILED: worker exited 1 on attempt 1/2
[diff-review] worker attempt 2/2 (-d .../.diff-review/2026-10-30T15-37-54-415Z-old)
cat: app.js: No such file or directory
[diff-review] FAILED: worker exited 1 on attempt 2/2
OLD parsed: {"ok":false,"error":"the worker exited non-zero twice"}
OLD line: diff-review: ERROR (advisory) the worker exited non-zero twice
OLD proof exists: no (worker could not read app.js)
[diff-review] worker attempt 1/2 (workdir .../c1-demo-JaWJwL, logs .../.diff-review/2026-10-30T15-37-54-428Z-new)
NEW parsed: {"ok":true,"verdict":"PASS","findings":[],"untested":[]}
NEW line: diff-review: PASS (advisory) 0 findings — second reader, never acceptance
NEW proof:
cwd=/root/claude-cloud-env-tooling/.work/c1-demo-JaWJwL
read app.js=export const marker = 'from-repo';
```

The old run's `-d <run dir>` is the spawn `diff-review.mjs` used before this
change (`cwd = dir`); the new run uses the repository root and
`ECO_WORKER_LOG_DIR = <run dir>` (existing eco-worker env, so eco-worker.sh is
unchanged). Logs and `verdict.json` stay in the run directory.

## C2 scale check

Synthetic 1,236,498-character diff, 42 files across src/e2e/scripts/config/
docs/.beads/other:

```
diff chars: 1236498
chunks: 7
max chunk chars: 176693
over limit: 0
files in diff: 42
coverage problems: 0
first files: config/file-00.js, config/file-01.js, config/file-02.js, config/file-03.js
last files: docs/file-02.js, docs/file-03.js, docs/file-04.js, docs/file-05.js
coverage problems after dropping last chunk: [
  'file docs/file-00.js is in the diff but no chunk covers it',
  ... one line per dropped docs file ...
]
```

## Real #468 run

Not run here: `/home/user/nexus-template` is outside this session's allowed
directory; `ls` and `Read` there were refused. Per the caller, the caller runs
`node /root/claude-cloud-env-tooling/diff-review/diff-review.mjs --diff-file
.eco-worker/pr468.patch` in `/home/user/nexus-template` after this commit. The
original evidence run (`/home/user/nexus-template/.diff-review/2026-10-30T14-06-40-116Z/`)
was not readable for the same reason. Expected result: exit 0 or an advisory
FAIL (not ERROR), covering all files; `verdict.md` now lists every chunk and
file.

## Blocked / unproven

1. `--self-test` pass: no `ECO_WORKER_API_KEY` in this session (quote above).
2. Real #468 run and the original evidence directory: refused by the session's
   allowed-directory policy; caller runs the real diff.
3. Strict OS-level read-only for the repository is not enforced: the prompt
   tells the worker the repo is read-only and eco-worker's deny list blocks
   destructive commands, but acceptEdits plus the existing allow list
   (`node`, `tee`, ...) can still write. eco-worker documents that it is not a
   sandbox. The proof above covers the actual failure (repo reads).
4. The originally requested proof path
   `/home/user/nexus-template/docs/qa/astro_template-42hnh/c1c2-verdict.md` was
   refused; this file is the instructed `docs/proof/42hnh-c1c2.md` copy.
5. A temporary `.work/old-tooling` worktree remains because `git worktree
   remove` was denied; it is gitignored, absent from the commit, and only
   affects test discovery in this checkout.
