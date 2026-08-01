# Claude Code plugins — doc set index

Curated for: authoring a Claude Code plugin that ships this repo's Workflow-tool `.mjs` engines behind
user-invocable skills (e.g. `/aipg-feature`). Official Anthropic docs only, retrieved 2026-08-01.

This is round 2: round 1 curated eight files and filed two gaps (Windows path form of
`${CLAUDE_PLUGIN_ROOT}`, and the uncaptured plugin-dependencies page). A gap-fill gather added three
files to close them; this round integrated those files (moved out of gather-tool-named folders into
`plugins/`, renamed to kebab-case) and rewrites this index in full.

| File | Covers | Read when |
|---|---|---|
| `plugins/create-plugins.md` | Plugin vs standalone `.claude/`, quickstart (manifest → skill → `--plugin-dir` test → `$ARGUMENTS`), plugin structure overview table, adding agents/LSP/monitors/settings.json, `--plugin-dir`/`--plugin-url` local testing, converting `.claude/` to a plugin, submitting to the community marketplace | First — end-to-end tutorial for building and locally testing a plugin |
| `plugins/plugin-components-reference.md` | Full spec for each component type: Skills, Agents, Hooks (event table, hook types), MCP servers, LSP servers, Monitors, Themes — location, file format, integration behavior for each | Wiring up `skills/`, `agents/`, `hooks/hooks.json`, `.mcp.json` precisely |
| `plugins/plugin-manifest-schema.md` | Plugin installation scopes; skills-directory (`@skills-dir`) plugins; **complete `.claude-plugin/plugin.json` schema** — required/metadata/component-path fields, `userConfig`, `channels`, path behavior rules, `${CLAUDE_PLUGIN_ROOT}`/`${CLAUDE_PLUGIN_DATA}`/`${CLAUDE_PROJECT_DIR}` (which fields substitute them, persistent data directory) | Writing or validating `plugin.json`; referencing plugin-bundled paths from hooks/MCP/LSP config |
| `plugins/plugin-directory-cli-reference.md` | Plugin caching (`~/.claude/plugins/cache`, symlink rules), standard directory layout + file-locations table, full `claude plugin` CLI (`init`, `install`, `uninstall`, `prune`, `enable`, `disable`, `update`, `list`, `details`, `tag`), debugging/validation tools and common error messages, version resolution (`plugin.json` vs marketplace entry vs commit SHA) | Scripting install/update/uninstall; diagnosing why a plugin/skill/hook isn't loading; deciding a versioning strategy |
| `plugins/plugin-dependencies.md` | **New this round.** Full `dependencies` array schema (`name`/`version` semver range/`marketplace` fields) in `plugin.json`; dependency-bundle pattern; cross-marketplace dependencies (`allowCrossMarketplaceDependenciesOn`); `{plugin-name}--v{version}` git-tag convention and `claude plugin tag`; multi-constraint resolution table; enable/disable cascading; `claude plugin prune`; the four dependency error codes and how to resolve each | Declaring `dependencies` in `plugin.json`, or bundling several of this repo's engines behind one install |
| `plugins/windows-path-resolution.md` | **New this round.** `~/.claude` resolves to `%USERPROFILE%\.claude` on Windows (backslash, `CLAUDE_CONFIG_DIR` override); the "what's not shown" table (`managed-settings.json`, `CLAUDE.local.md`, `~/.claude/plugins` — orphaned versions deleted after 14 days); which files under `~/.claude` must never be deleted | Confirming where `~/.claude` and the plugin cache actually land on a Windows install |
| `plugins/hooks-exec-shell-form.md` | **New this round.** Command-hook field table (`command`, `args`, `async`, `asyncRewake`, `shell`); **exec form vs shell form** in full — which shell runs shell-form hooks per platform (`sh -c` / Git Bash / PowerShell), the Windows `.cmd`/`.bat`-shim caveat (not real executables, need a `node` wrapper), quoting rules for each form; `${CLAUDE_PLUGIN_ROOT}`/`${CLAUDE_PLUGIN_DATA}`/`${CLAUDE_PROJECT_DIR}` path-placeholder reference with project- and plugin-hook JSON examples; `${user_config.*}` exec-form-only substitution; a `MessageDisplay` PowerShell example | Writing a plugin hook that must work identically on Windows and Linux/macOS — the exec-vs-shell-form choice is what makes that portable |
| `marketplaces/create-and-distribute-a-marketplace.md` | Full `marketplace.json` schema (required/owner/optional fields), plugin entries + all plugin source types (relative path, `github`, `url`, `git-subdir`, `npm`) with field tables, strict mode, hosting on GitHub/other git hosts/private repos, team auto-install (`extraKnownMarketplaces`), container seed dirs, managed restrictions (`strictKnownMarketplaces`), version/release-channel management, rename/remove, validation, troubleshooting | Writing `.claude-plugin/marketplace.json` and hosting/distributing it in a git repo |
| `marketplaces/discover-and-install-plugins.md` | User-facing install/update flow: official/community/demo marketplaces, `/plugin marketplace add` (all source forms), `/plugin install` + scopes, managing installed plugins (`/plugin list/enable/disable/uninstall`), `/reload-plugins`, auto-updates, team marketplace config, security, troubleshooting | Confirming exactly what a plugin consumer (or your own test session) will run to add/install/update |
| `skills/skill-md-reference.md` | **Claude Code's own skills page** — bundled skills, skill directory locations/precedence, complete SKILL.md frontmatter field table, how a skill gets its command name (incl. plugin-namespaced `plugin:name`), string substitutions (`$ARGUMENTS`, `${CLAUDE_SKILL_DIR}`, etc.), subagent/`context: fork` execution, `skillOverrides`, and — since Anthropic merged the old "Slash Commands" page here — the full custom-slash-command frontmatter/arguments/relationship-to-skills content | The primary reference for SKILL.md format and slash-command invocation; read this before `skill-authoring-best-practices.md` |
| `skills/skill-authoring-best-practices.md` | Cross-product Agent Skills authoring guidance (not Claude-Code-specific mechanics): conciseness, degrees of freedom, naming/description conventions, progressive disclosure, workflows/feedback loops, eval-driven iteration, anti-patterns, executable-script patterns | Writing the *content* of a SKILL.md well, once the mechanical format is known from `skill-md-reference.md` |

## Coverage notes

**Inconsistencies:** none found across all eleven files. All were retrieved the same day (2026-08-01).
Version gates cited in more than one file agree across sources: `displayName`/`defaultEnabled` min-version
2.1.143/2.1.154 (both `plugin-manifest-schema.md` and `create-and-distribute-a-marketplace.md`); the
boolean-field `yes/no/on/off/1/0` parsing added in v2.1.218 (both `plugin-components-reference.md` and
`skill-md-reference.md`); the `${user_config.*}` shell-form-vs-exec-form-only rule and its v2.1.207 cutover
(both `plugin-manifest-schema.md` and the new `plugins/hooks-exec-shell-form.md`); `claude plugin prune`'s
v2.1.121 floor (both `plugin-directory-cli-reference.md` and `plugin-dependencies.md`).

**Gaps from round 1 — resolved:**

1. **Plugin dependencies page** — was entirely uncaptured; `plugins/plugin-dependencies.md` now covers it
   in full (schema, tagging, resolution, errors). Closed.
2. **`${CLAUDE_PLUGIN_ROOT}` Windows vs Linux path form** — **partially resolved.** The gap-fill gather
   established two concrete facts: (a) `~/.claude` itself resolves to the Windows-native
   `%USERPROFILE%\.claude` (backslash form) — `plugins/windows-path-resolution.md`; (b) shell-form hooks on
   Windows run through Git Bash (or PowerShell if Git Bash is absent), while exec form spawns the resolved
   executable directly with no shell tokenization, and `.cmd`/`.bat` npm shims aren't real executables so
   they need a `node <script.js>` wrapper in exec form — `plugins/hooks-exec-shell-form.md`. What neither
   file states — and what no captured source states — is the literal separator character
   (`C:\Users\...\plugins\cache\...` vs a forward-slash/Git-Bash-normalized form) that Claude Code actually
   substitutes into `command`/`args` for `${CLAUDE_PLUGIN_ROOT}` on Windows. This may simply be undocumented
   rather than missing from the capture; see the gap below if it needs settling before authoring
   Windows-sensitive hook/MCP commands.

**Gaps still open (a fresh gather could fix):**

1. **Literal `${CLAUDE_PLUGIN_ROOT}` substitution format on Windows** — narrower than round 1's version of
   this gap (which is now mostly closed, see above). Needed only if this plugin ships a hook or MCP server
   command that path-joins or string-matches the substituted value on Windows (e.g. a script that splits on
   `/`). A targeted read of `/docs/en/env-vars` (linked from both `claude-directory` and `hooks` pages but
   not yet captured) is the next place to check; if that page doesn't state it either, this is likely an
   implementation detail Anthropic hasn't documented, and the safe authoring rule already captured — prefer
   exec form with `args`, quote in shell form — sidesteps needing to know it.

## Fidelity spot-check (round 2: 3 new files checked against their own cited source)

- `plugins/plugin-dependencies.md` vs `https://code.claude.com/docs/en/plugin-dependencies` — fetched the
  live page and compared the entire "Declare a dependency with a version constraint" section (intro
  paragraph, JSON manifest example, field table for `name`/`version`/`marketplace`) word for word:
  **exact match**.
- `plugins/windows-path-resolution.md` vs `https://code.claude.com/docs/en/claude-directory` — the live
  page is now a React-driven interactive explorer; fetched its underlying source and compared the captured
  intro paragraph, the Windows/`%USERPROFILE%` sentence, the full "What's not shown" table (all three rows),
  and the "Application data" closing sentence word for word: **exact match** on all four passages.
- `plugins/hooks-exec-shell-form.md` vs `https://code.claude.com/docs/en/hooks` — compared the full
  "Command hook fields" table (`command`/`args`/`async`/`asyncRewake`/`shell`, all five rows) and the
  "Exec form" / "Shell form" definition paragraphs word for word: **exact match**.

No failures. `fidelity_checked: 3`, `fidelity_failures: 0`. (Round 1 separately checked three of the
original eight files with the same result — see git history of this index for that round's citations —
so 6 of 11 files across both rounds now have a verified verbatim spot-check; the remaining five are
unchanged since round 1's pass and weren't re-checked here.)

No local repo/file-path sources are in this set (all eleven files are web captures), so no free
"local read" checks were available.
