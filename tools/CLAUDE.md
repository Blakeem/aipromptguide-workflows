# tools — repo development machinery (for Claude)

Plain Node, run directly, **zero dependencies**. These are NOT Workflow engines: they use real imports,
`node --check` works on them, and they are judged as ordinary code (`../tests/CLAUDE.md` §2).
`trash-windows.ps1` is the one PowerShell file, a helper that only `trash.mjs` runs. The only programs
`trash.mjs` starts are osascript on macOS and, on Windows, `pwsh.exe`, or the `powershell.exe` that
Windows ships when pwsh cannot start. Its Linux backend runs no program.

Most of them build and verify this repo's own artifacts. **`plan-block.mjs` is the exception: it runs
DURING a workflow**, invoked by agents that develop-cycle and refine-cycle hand a command. Its argv
shape, its stdout bytes and its exit codes are a run-time contract two engines depend on — change them
and you change what a developer agent receives, so treat it as engine surface, not dev machinery.
`plan-pull.mjs` runs during a develop run too, invoked by a proactive round-1 developer, so its argv and
its JSON output are engine surface the same way.

| File | What it does |
|---|---|
| `plan-block.mjs` | Prints ONE `## Plan: <id>` block out of a multi-unit plan file, byte-exact, or `--list`s the file's control data. It reads the plan-bus metadata grammar. **Called by agents at run time** (see above). Keeps a multi-unit plan out of every agent's context and makes the block's end a parser's decision rather than an agent's. |
| `plan-edit.mjs` | Writes plan files, the only tool that does: `set` upserts one block or issue metadata line, `move` relocates an issue entry (a cut, never a copy), `args` folds finished develop runs' statuses into the plans and prints the next launch's args. **Operator-invoked between runs**, never handed to a run-time agent. It is a separate file from `plan-block.mjs` because the run-time allowlist rule covers every subcommand of the file it names. Imports plan-block's exported grammar. |
| `plan-pull.mjs` | Prints, read-only, the ready backlog entries in the files a block changes: `pullable --backlog <dir> --files <path,...> [--exclude <plan.md,...>]`. **Called by a proactive round-1 developer at run time**, so it holds no write verb. Imports the backlog rules from `plan-edit.mjs`. |
| `plugin-access.mjs` | `check`s for, and on the user's yes `grant`s, the Read allow rule in the user settings that lets the Workflow tool launch an **installed** plugin's engines. A plugin path through a link gets a second rule for the resolved folder. The tool refuses a scriptPath the session cannot already read, and a plugin cannot grant itself its own folder. **Run by each skill's first step**, operator-side, never by a run-time agent, apart from the develop and debug skills, whose `onboard.mjs` check asks for access through the exported `accessState`. A cache install is granted the plugin folder above the version folder, so updates keep the rule. |
| `onboard.mjs` | Asks every setup answer a build needs from the user once per repo, together. `check --root --repo` prints `ready <key> policy=<policy> delivery=<commit\|stage>` when nothing is missing. Otherwise it prints `ask <key>`, then each open question with its options and the one `save` command. The questions are plugin access (skipped when the working directory holds the plugin folder, or when `--access session` says the user declined it and ran `/add-dir` for this session), the change policy, the delivery, and, only beside the delivery, whether to hide Claude's author details. The policy and delivery options list the recommendation first: `proactive` and `commit` when every commit of the repo is the user's own, else `focused` and `stage`. `check` takes `--access session`, which writes nothing. `save` takes `--access allow\|session`, `--policy`, `--delivery commit\|stage` and `--attribution hide\|keep`, writes the user settings once for access and attribution and the store through `project-settings.mjs`, then prints what `check` prints. It reads every answer from where its tool keeps it, so a skill runs it before every run. **Operator-invoked** by the develop and debug skills' first step, never by a run-time agent. |
| `project-settings.mjs` | Holds each repo's settings in `<root>/projects.json`, which maps a repo key to an object whose optional fields are `changePolicy` (`focused`, `proactive` or `auto`, and the engines take only the first two), `commit` (a boolean, whether develop commits each accepted block), `provision` (the command that readies a fresh run worktree for the gates, or `none`), `worktreeDir` (the absolute parent folder of the run worktrees, when it is not the default one under the repo) and the role settings `models` and `efforts`, each mapping a role key (`develop`, `park`, `quality`, `acceptance` or `sweep`) to a model name or a reasoning level. `check` prints a repo's saved policy, and `set` saves `--policy focused|proactive|auto`, `--commit on|off`, `--provision "<cmd>"|none`, `--worktree-dir <abs dir>|default` or any of them together and keeps every other key. The value `default` removes `worktreeDir`. A repo with no saved policy reads `missing` from `check`, whatever else it saved. `commit` prints `on <key>`, `off <key>` or `missing <key>` for the saved commit choice and never asks or recommends. `provision` prints `{"key":...,"provision":...,"worktreeDir":...}`, each null when none is saved. `onboard.mjs` imports `POLICIES`, `checkPolicy`, `repoSettings`, `saveRepoSettings` and `recommendedPolicy`. `roles` prints the repo's saved `models` and `efforts` as one JSON line. `set-roles` merges the roles named in `--models` and `--efforts` into them and keeps every other setting, and the value `default` removes a role's saved value. The tool imports the `model:` and `effort:` sets from plan-block's exported grammar and holds its own copy of the role keys, and a test compares all three with the develop engine's. `backlog` prints the project's backlog folder, `<root>/backlog/<project>/`, and never creates it. `<project>` is the key's last path segment without the characters a Windows file name refuses and cut to 48 characters, a hyphen, and the first 8 hex digits of the key's SHA-256, taken after case folding where keys fold, so two repos with the same folder name get different folders. The key is the repo's main checkout, so a linked worktree shares its settings and its backlog folder. A bare repository or a separate git dir is keyed by its git dir. For a missing key, `check` recommends `proactive` when the repo has no commits or only the user's `git config user.email` as author, and `focused` otherwise. **Operator-invoked** through `onboard.mjs` or by the develop guide's §2 steps 3 and 4, §4 and §10, never by a run-time agent. develop takes the folder `backlog` prints as its `backlogDir` arg. |
| `attribution.mjs` | `check`s whether the user settings hide Claude Code's author details on commits and pull requests, and on the user's yes `set`s the hiding value of each key that shows. The settings hide them when `attribution` is `false`, or when `attribution.commit` is `""`, `attribution.pr` is `""` and `attribution.sessionUrl` is `false`. `check` prints `hidden <settings>` or `shown <keys> in <settings>`. `set` keeps every other setting and every other `attribution` key, never writes `"attribution": false`, and is a no-op on `hidden`. A settings file that does not parse, or whose `attribution` is neither an object nor `false`, exits 1 and stays unwritten. It imports the settings path, read and write from `plugin-access.mjs`, so both tools share one path rule and one safe write. `onboard.mjs` imports `shownKeys` and `withHidden` and asks the question. The CLI is for an operator who changes the setting outside onboarding, never a run-time agent. |
| `wt.mjs` | The batch-worktree lifecycle (`init`/`prep`/`land`/`clean`) for running several engine runs in **parallel**, each in its own git worktree, and `open`/`close` for building one change in its own worktree, which every develop run uses. With no `--dir`, `init` and `open` make a worktree in `.claude/worktrees/` of the main worktree, or beside a bare repository, and first append `/.claude/worktrees/` to the repo's `info/exclude`, never to a `.gitignore`. `--dir` names another parent folder, which the operator passes from the repo's saved `worktreeDir`, as the develop guide's §2 step 4 says. `open` records the branch it cut from in the branch's config, and `close` lands on it when `--into` is omitted. `close` fast-forwards the `--into` branch to the exact commit its gate passed, or with `--stage` commits the worktree's staged work as one carrier commit and stages the gated change in the checkout of the `--into` branch, then removes the worktree and deletes its branch. The checkout that takes the landing may hold the user's own uncommitted work, and only a change at a path the landing writes is refused. `clean` and `close` move a worktree folder to the trash through `trash.mjs` and never run `git worktree remove`. **Operator-invoked around the runs** — no agent ever calls it, no engine knows it exists. Its header comment is the contract (hook bytes, lock liveness, exit codes — all measured decisions); the operator playbook is [`../docs/worktree-batches.md`](../docs/worktree-batches.md). |
| `trash.mjs`, `trash-windows.ps1` | Moves a file or directory to the operating system's trash, refuses with every file left in place, or reports unknown. **Operator-invoked or imported by another tool**, never handed to a run-time agent. Each path ends `trashed` (the trash location on stdout), `refused` (nothing moved) or `unknown` (the tool cannot confirm where the item is. It may be partly or wholly in the trash, and part of it may remain at its path). Exit 0 all trashed, 2 any refused and none unknown, 3 any unknown, 1 usage. Backends: on Windows it runs `trash-windows.ps1` (IFileOperation with a sink that vetoes any delete that would not recycle), on macOS it runs NSFileManager `trashItemAtURL` through osascript, and on Linux and WSL it implements freedesktop.org Trash 1.0 in Node. None copies across devices. `AIPG_TRASH_BACKEND=xdg` forces the Linux backend on any platform, so tests trash into a temporary `XDG_DATA_HOME`. `AIPG_TRASH_LIVE=1` adds the live test cases: they trash temp directories through the real backend, on Windows one at a path of MAX_PATH or more, and on Windows one checks that the helper refuses a path the shell parses as another item. The macOS backend has run only against fabricated output, since no Mac is available. |
| `gen-flows.mjs` | Generates `workflows/<x>/FLOW.md` — the Mermaid flow map of an engine's complete agent flow. Runs each engine through `tests/harness.mjs` against a scenario table and draws what it **watched**, so a diagram can only ever show a path that really executes. |
| `freeze-notes.mjs` | Copies an engine for a **live test of the workflow itself**: every agent call is wrapped so its prompt ends with a note asking the agent to record, from its own seat, what in the workflow was unclear, wrong or wasteful, in `<notesDir>/<label>.md`. The suite cannot test agents, so this is how prompt changes get tested. Put the copy under `runs/_engines/<runId>/` (gitignored), since the Workflow tool refuses a scriptPath outside the checkout. |
| `gen-prompts.mjs` | Snapshots every distinct prompt variant each engine sends to `tests/snapshots/<name>.prompts.md`, from the same scenario tables. A prompt edit then shows in the git diff under every role, mode and round it reaches. `--dump <file>` writes every distinct call as JSON, to prove a refactor left the prompts byte-identical. |
| `render-flows.mjs` | Lays every generated map out in **real Mermaid** (headless Chrome) and reports labels that overlap. Answers "is the picture legible", which `gen-flows.mjs` cannot. |
| `flows/<name>.flow.mjs` | One scenario table per engine: the args + scripted agent replies that drive each distinct path. The only hand-written part of a flow map. |
| `.cache/` | Gitignored. Downloaded Mermaid + rendered PNGs. Safe to delete. |

`workflows/debug/gen-units.mjs` is the same *kind* of thing but lives with debug, because you run it as
part of that workflow rather than to maintain this repo.

## plan-block.mjs

```bash
node tools/plan-block.mjs <plan.md|plan-name> <id>            # that block, verbatim, on stdout
node tools/plan-block.mjs <plan.md|plan-name> --list          # { goal, ordered, suite, sweep, blocks: [...] }
```

It parses the plan-bus metadata grammar: file keys (`goal`, `ordered`, `suite`, `synced`,
`sweep`), a block preamble (`mode`, `gate`, `status`, `model`, `effort`, plus informational
`test_selector`/`depends_on`), and `### [<id>]` issue entries in fix-mode blocks. An issue entry holds `id`, `status`, `file`, `loc`,
`severity`, `category`, `lens`, `size`, `decision`, `theme`, a park entry's `branch` and `origin`, and `pulled`, the `<runId>#<block id>` of a developer that took the entry beside its block. A `- effort:` line in an entry fails the parse with a
message that names the entry and says the key was renamed to `size`. `plan-edit.mjs set` refuses `effort=` on an
issue entry with the same rename. `model` takes `opus | sonnet | haiku | fable` and names the block's developer model. `effort` takes `low | medium | high | xhigh | max` and
names the block's developer reasoning level. `--list` emits the file keys plus a `blocks`
array of `{ id, title, mode, gate, status }`, defaults applied, and a row carries `model` or `effort` only when
its block sets one. The file keys are the first lines of the file, after any frontmatter and before any heading, and a file key anywhere else above the first block (outside a code fence) fails the parse. Each other metadata run is the contiguous `key: value` lines under its heading, leading blank lines crossed. A
blank line above a run is crossed to find it, never to continue one, and body prose never registers
as metadata. Every block's gate is its preamble `gate:` line. A bare plan-name resolves
against `<CLAUDE_CONFIG_DIR | ~/.claude>/plans/`.

**Every failure is loud** — unknown id, duplicate id (across the block AND issue namespaces), empty
body, missing or invalid gate, a gate outside its mode's set, an unknown or illegal metadata key or
value, an indented
header, a **malformed** header (colon forgotten, a colon with no id, a space before the colon, or a `###`
level), an **unclosed code fence**, no blocks at all. Nothing may resolve to a plausible default, because
the consumer is an agent that would build against it. Two silent-wrong-answer classes are guarded and
have tests: a header inside a **fenced code block** is an example (it used to mint a phantom unit and
truncate the real one), and the gate is read only from the **block preamble** (a `gate:` in
prose used to outrank the real one and yield `build-only`, which makes the engine accept a feature with
nothing tested).
The last two loud failures share one shape: a block that merges into its predecessor deletes a unit from
the control array AND flips the survivor's gate to the merged tail's, in one exit-0 answer.

The engines cannot verify the command ran — the harness has no tools. `plan_obtained` on develop's developer
and acceptance schemas is that signal, and develop halts on an explicit `false`. The refine editor's
`plan_parses` is the same signal for its re-validation run, and refine halts on `false`.

## plan-edit.mjs

```bash
node tools/plan-edit.mjs set <plan.md|plan-name> <id> <key>=<value>          # upsert one metadata line
node tools/plan-edit.mjs move <src> <issue-id> <dest> <block-id>             # relocate one issue entry
node tools/plan-edit.mjs args [<plan.md> ...] [--expect <wf-id>] [--backlog <dir>] [--pack <repo> [--loc-cap <n>] | --fold-only]
                                                                             # fold finished runs, print develop's args
```

The write surface, kept out of plan-block.mjs on purpose: the run-time allowlist rule
(`Bash(node '<blockTool>':*)`) covers every subcommand of the file it names, and an agent must never
hold a write path to a plan. `set` addresses a block or an issue through the file's single id space
and rewrites exactly one line, or appends it to the right run. `move` cuts an entry's bytes verbatim
into another fix-mode block, same file or another. Failures are loud and leave every file untouched:
unknown id, unrecognized key, illegal value, a gate the target's mode forbids, a duplicate id at the
destination, a non-fix destination block. Paths resolve through the same `resolveRoadmap` as
plan-block, so a bare name addresses the same file in both tools. BOM'd and CRLF files round-trip
byte-identically, and an appended line inherits the file's dominant line ending.

`args` is the step before every develop launch, so status bookkeeping cannot be skipped. Its output
carries `blockTool`, the absolute path, with forward slashes, of the `plan-block.mjs` in the folder of
the `plan-edit.mjs` that ran, and develop throws without it. The CLI takes that folder from argv[1], the
spelling the caller used, since Node realpaths the main module. The printed path then keeps the spelling
of the permission rules the caller wrote. `plugin-access.mjs` grants its Read rules in both spellings,
since which one a gate matches is unmeasured. An imported call, or a CLI run through a link to the `plan-edit.mjs` file
itself, which leaves no `plan-block.mjs` beside the caller's spelling, takes the folder of its own file. develop logs each
finished block's status edits as one `status-sync <json>` line. Claude Code writes every Workflow run to
`<config>/projects/<project>/<session>/workflows/wf_<id>.json` when it ends, logs included, for a
completed, failed or stopped run alike. `args` reads every develop record newer than the plan's
`synced:` file key, applies the edits naming that plan oldest first, and moves the key to the newest run
applied, so an operator's later edit is never overwritten. `--fold-only` writes every fold and cut that `args` writes,
the `--backlog` files' included. It sets no `done` backlog file to `todo`, holds back nothing and prints nothing, so an
operator reads current statuses without a launch. It refuses `--pack`. The record format is Claude Code's and
undocumented. A completed run's edits come from its result, which holds them uncut. A failed or stopped
run's come from its log lines, and the runtime cuts a long line short: a cut line that names a plan
being folded fails `args`, and one that names none is skipped with a note. A changed develop record
fails `args` loudly, `--expect <wf-id>` fails when a known run's record is missing, and
`tests/plan-bus.test.mjs` checks the newest records on the machine on every suite run. Records expire
after `cleanupPeriodDays` (30 by default).

`--backlog <dir>` adds each backlog file in `<dir>` whose `status:` is `todo` or `done` and that holds an entry with
`- decision: ACTIONABLE` and `- status: open`, after folding the finished runs into it. A file that also holds an
`ACTIONABLE` entry with `- status: needs-attention` is not added, since the fix-mode developer would rebuild that entry
without the user. A file is not added while the block that wrote it is not `done`, `skip` or `backlogged`, since a relaunch
of that block may still append to it. A `parked` writer, an older engine's park that develop never relaunches, holds its
file back until the user sets it `skip` to drop it, `todo` to rebuild it, or `backlogged` only when a backlog entry carries its
work, and the note that names the left-out file says so. The file's header names that block and its develop `runId`, and the run records
with that `runId` arg and this `--backlog` folder as their `backlogDir` arg, or with no `backlogDir` arg, give its plan path, through their block status edits or their `plans` rows. A record with no args stands for its runId through the `runId` its result echoes. Both runIds are compared after the header title's own split at a spaced dash, rejoin with ` - ` and trim. A header that names a pass
matches each member of that pass's row, and one that names a member matches that member. Its status is read with those records folded in memory, and its plan file is never written. A file whose block
no record names, or whose plan file is gone, is not held back. A writer plan file that exists but fails to read or validate, or whose run records cannot be folded into it, fails the command, since its status is unknown. A file named as a plan skips this check. A file is not added either while one of its ready entries names, in its `- file:` path, a file that the text of a `blocked` block, or of an older engine's `parked` block, names, as an entire path in either slash direction, since a relaunch of that block may change that file. A file named as a plan skips this hold too, so name one only once no such block's text names the `- file:` path of one of its ready entries. Those blocks are the `blocked` and `parked` blocks of the given plans and of every plan in the `plans` rows of a run whose `backlogDir` arg is this folder, including a pass row's members, read with the records folded in memory. A note names each held entry with the block that holds it and that block's status, and for a `parked` block the statuses the user sets to release the file. Every other file builds. The file, not the entry, is held, since develop builds every ACTIONABLE entry of a file it builds. Such a plan file that is gone holds nothing, and one that exists but fails to read, validate or fold fails the command. The fold of every `todo` or `done` backlog file with an `ACTIONABLE` entry is written, built or not. An entry with no `- status:` line counts as `open`. A `done` file is
set to `todo` on disk. A file already named as a plan is not added twice. The backlog files carry no file keys, so they take the given
plans' keys, and the defaults when no plan is given. The flag lets the plan list be empty, and fails with a message that
ends `nothing to build` when it then adds no file. A missing folder adds nothing. An `ordered: true` plan set is refused.
An entry with a `- pulled:` line is not ready, so it neither makes its file buildable nor weighs in `--pack`, since
the developer that pulled it, or that block's park entry, builds it. An entry with a line that starts with
`**Parked with:**` at column 0 is held the same way. Before the file is judged, `--backlog` looks up the block that a
`**Parked with:** block <id>` line names in the run the file's header names, as for the writer hold, and cuts the line,
with its own ending, from each open `ACTIONABLE` entry whose block is `done` or `skip` in every plan file the records give
for it. The cut is written with the fold. A block in any other status keeps the hold. A line that names no block as
`block <id>`, a block no record names, a plan file that is gone and a plan file that no longer holds the block keep it
too, each with a note that says to delete the line by hand once the block is `done` or `skip`. A parked block's plan file
that exists but fails to read or validate, or whose run records cannot be folded into it, fails the command. A file named
as a plan gets no cut. A status edit whose `value` is null removes its key's
line, with the line's own ending, and is a no-op when the line is absent. develop removes a pulled entry's `- pulled:`
line that way. A status edit that carries `expectPulled` applies only to an issue entry whose `- pulled:` value is
`expectPulled`, and is skipped with a note otherwise. develop gives each status edit and removal of a pulled entry its
block's mark, so a run never edits an entry its block did not mark.

`--pack <repo>` groups the todo fix blocks into passes, so one set of agents builds several small ones.
A block's weight is the line count of each distinct file its open ACTIONABLE issues name: the `- loc:`
line, else the file in `<repo>`, else 200. A pass runs on the strongest model among its members, in the
order fable, opus, sonnet, haiku, and on the highest effort, in the order max, xhigh, high, medium, low.
A member with no `model` or `effort` line runs on the run's default, which `--pack` cannot see, so it
shares a pass with a member that sets that line only when the pass's value is `fable` or `max`. A pass
whose members all lack the line carries no key for it. The `packed` note names each member whose own
value differs from its pass's, as `<id> <key> <value> -> <pass value>`, with `default` for a member with
no line. Blocks are sorted by model and then by effort: a set value other than the top rank (`fable` or
`max`) first, then the top rank, then no line. Then they sort by the first file they touch. Each block
joins the first pass it fits, one that stays under `--loc-cap` (default 5000, scaled from resolve's
3000-line batches of about 150-200k tokens), whose members it can share a developer with, and that holds
none of its issues. A block opens a new pass only when no pass fits. A block over the cap, one with nothing open and
ACTIONABLE, or one whose open ACTIONABLE issue carries a `- branch:` line, stays its own row, so two
unfinished branches never restore in one round 1. A pass row is `{ id: <first>-plus-<n>, mode: fix,
model?, effort?, blocks: [{ id, planPath, issues }] }`, and develop writes each member's status and each
issue's into the file that holds it. Packing regroups blocks, so an `ordered: true` file is refused.

## plan-pull.mjs

```bash
node tools/plan-pull.mjs pullable --backlog <dir> --files <path,...> [--exclude <plan.md,...>]
```

Prints a JSON array of `{ id, title, planPath, file, size }`, one per entry a `plan-edit.mjs args --backlog <dir>`
launch would build whose `- file:` path names one of `--files`, compared with forward slashes and no leading `./`.
It folds the run records into each backlog file in memory and applies every file and entry rule of `--backlog`,
the writer hold, the blocked-block hold, and the parked-with hold and its cut included. It also leaves out an entry with a `- branch:` line, which restores parked work and
builds alone, an entry with a `- pulled:` line, an entry whose id is not its file's name and `-<n>`, since develop
finds a pulled entry's file from its id, and every entry of an `--exclude` file, which develop passes as the run's
own plan files. It writes nothing, and each fold note it passes on starts `in memory only:`. So a listed entry
may still carry its released `**Parked with:**` line on disk, and develop's developer deletes that line when it
takes the entry. Exit 0 prints the
array, a missing folder prints `[]`, and exit 1 prints the reason on stderr. develop's proactive round-1
developer runs it, so the command needs its own allowlist rule beside `blockTool`'s, and the file holds no write
verb for the reason `plan-edit.mjs` is a separate file.

## gen-flows.mjs

```bash
node tools/gen-flows.mjs              # regenerate every map
node tools/gen-flows.mjs develop      # one
node tools/gen-flows.mjs --check      # write nothing; exit 1 naming stale files (what the suite runs)
node tools/gen-flows.mjs develop --json   # the intermediate graph, for rendering elsewhere
```

**Its header comment is the contract** — spec shape, terminal identity, and every graph-derivation rule.
Read it before writing or changing a scenario table. The short version: node identity, concurrency,
loops, loop bounds and unit boundaries are all *derived* from a trace; only each scenario's `when` string
is authored.

Output is byte-stable (no timestamps), so `--check` is a meaningful gate. Edit an engine
and you must regenerate, or `node tests/run.mjs` goes red. A map cites each throw site's line number, so an
edit that only moves lines stales it too.

It is also **dash-free**: `dedash` flattens the finished document to ASCII hyphens (em, en and horizontal
bar) because the maps are published on a user-facing site. Presentation only, applied once at the end of
`generate()` — engine prose, `--json` and terminal identity keep the real characters, and the substitution
is 1:1 so no label changes width. Write your prose however you like; only the emitted page is normalized.
`tests/flow-coverage.test.mjs` asserts it over every spec.

## render-flows.mjs

```bash
node tools/render-flows.mjs           # measure all, report overlaps, exit 1 if any
node tools/render-flows.mjs --png     # also write PNGs to tools/.cache/render/
```

Drives the Chrome already on the machine via `--dump-dom` — no puppeteer, no playwright. Mermaid does no
collision avoidance on edge labels, and that failure is invisible to every text assertion, so this
measures the real bounding boxes instead of guessing.

**Deliberately not part of `node tests/run.mjs`**: it needs a browser and, once, the network, and the
suite has to stay runnable anywhere. Run it by hand after anything that affects layout. Raise the spacing
constants in `gen-flows.mjs` before shortening label text — room is free, dropped information is not.

## The gates these feed

- `tests/flows.test.mjs` — the emitter's own rules (determinism, concurrency, loop counts, escaping).
- `tests/flow-coverage.test.mjs` — every role, throw site and terminal state reached by some scenario,
  `meta.phases` agreement, and map freshness.
- `tests/returns.test.mjs` — every returning scenario's `out` against the Shared return fields in
  `principles/WORKFLOW-PRINCIPLES.md` Mechanics.

Full working notes, including what the coverage gate structurally *cannot* see, are in
[`../tests/CLAUDE.md`](../tests/CLAUDE.md) §7.
