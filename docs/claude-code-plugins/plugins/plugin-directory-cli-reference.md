Source: https://code.claude.com/docs/en/plugins-reference (sections: "Plugin caching and file resolution", "Plugin directory structure", "CLI commands reference", "Debugging and development tools", "Distribution and versioning reference")
Version: Claude Code docs (current as of retrieval)
Retrieved: 2026-08-01

---

# Plugins reference

## Plugin caching and file resolution

Plugins are specified in one of two ways:

* Through `claude --plugin-dir` or `claude --plugin-url`, for the duration of a session.
* Through a marketplace, installed for future sessions.

For security and verification purposes, Claude Code copies *marketplace* plugins to the user's local **plugin cache** (`~/.claude/plugins/cache`) rather than using them in-place. Understanding this behavior is important when developing plugins that reference external files.

Each installed version is a separate directory in the cache. When you update or uninstall a plugin, the previous version directory is marked as orphaned and removed automatically 14 days later. The grace period lets concurrent Claude Code sessions that already loaded the old version keep running without errors.

Claude's Glob and Grep tools skip orphaned version directories during searches, so file results don't include outdated plugin code.

### Path traversal limitations

Installed plugins cannot reference files outside their directory. Paths that traverse outside the plugin root (such as `../shared-utils`) will not work after installation because those external files are not copied to the cache.

### Share files within a marketplace with symlinks

If your plugin needs to share files with other parts of the same marketplace, you can create symbolic links inside your plugin directory. How a symlink is handled when the plugin is copied into the cache depends on where its target resolves:

* **Within the plugin's own directory:** the symlink is preserved as a relative symlink in the cache, so it keeps resolving to the copied target at runtime.
* **Elsewhere within the same marketplace:** the symlink is dereferenced. The target's content is copied into the cache in its place. This lets a meta-plugin's `skills/` directory link to skills defined by other plugins in the marketplace.
* **Outside the marketplace:** the symlink is skipped for security. This prevents plugins from pulling arbitrary host files such as system paths into the cache.

For plugins installed with `--plugin-dir` or from a local path, only symlinks that resolve within the plugin's own directory are preserved. All others are skipped.

The following command creates a link from inside a marketplace plugin to a shared skill defined by a sibling plugin. On Windows, use `mklink /D` from an elevated Command Prompt or enable Developer Mode:

```bash
ln -s ../../shared-plugin/skills/foo ./skills/foo
```

This provides flexibility while maintaining the security benefits of the caching system.

---

## Plugin directory structure

### Standard plugin layout

A complete plugin follows this structure:

```text
enterprise-plugin/
├── .claude-plugin/           # Metadata directory (optional)
│   └── plugin.json             # plugin manifest
├── skills/                   # Skills
│   ├── code-reviewer/
│   │   └── SKILL.md
│   └── pdf-processor/
│       ├── SKILL.md
│       └── scripts/
├── commands/                 # Skills as flat .md files
│   ├── status.md
│   └── logs.md
├── agents/                   # Subagent definitions
│   ├── security-reviewer.md
│   ├── performance-tester.md
│   └── compliance-checker.md
├── workflows/                # Workflow scripts
│   └── release-audit.js
├── output-styles/            # Output style definitions
│   └── terse.md
├── themes/                   # Color theme definitions
│   └── dracula.json
├── monitors/                 # Background monitor configurations
│   └── monitors.json
├── hooks/                    # Hook configurations
│   ├── hooks.json           # Main hook config
│   └── security-hooks.json  # Additional hooks
├── bin/                      # Plugin executables added to PATH
│   └── my-tool               # Invokable as bare command in Bash tool
├── settings.json            # Default settings for the plugin
├── .mcp.json                # MCP server definitions
├── .lsp.json                # LSP server configurations
├── scripts/                 # Hook and utility scripts
│   ├── security-scan.sh
│   ├── format-code.py
│   └── deploy.js
├── LICENSE                  # License file
└── CHANGELOG.md             # Version history
```

> **Warning:** The `.claude-plugin/` directory contains the `plugin.json` file. All other directories (commands/, agents/, skills/, workflows/, output-styles/, themes/, monitors/, hooks/) must be at the plugin root, not inside `.claude-plugin/`.

A `CLAUDE.md` file at the plugin root is not loaded as project context. Plugins contribute context through skills, agents, and hooks rather than CLAUDE.md. To ship instructions that load into Claude's context, put them in a [skill](#skills).

### File locations reference

| Component         | Default Location             | Purpose                                                                                                                                                                                    |
| :------------------ | :----------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Manifest**      | `.claude-plugin/plugin.json` | Plugin metadata and configuration (optional)                                                                                                                                               |
| **Skills**        | `skills/`                    | Skills with `<name>/SKILL.md` structure                                                                                                                                                    |
| **Commands**      | `commands/`                  | Skills as flat Markdown files. Use `skills/` for new plugins                                                                                                                               |
| **Agents**        | `agents/`                    | Subagent Markdown files                                                                                                                                                                    |
| **Workflows**     | `workflows/`                 | [Workflow](/docs/en/workflows) script files                                                                                                                                                     |
| **Output styles** | `output-styles/`             | Output style definitions                                                                                                                                                                   |
| **Themes**        | `themes/`                    | Color theme definitions                                                                                                                                                                    |
| **Hooks**         | `hooks/hooks.json`           | Hook configuration                                                                                                                                                                         |
| **MCP servers**   | `.mcp.json`                  | MCP server definitions                                                                                                                                                                     |
| **LSP servers**   | `.lsp.json`                  | Language server configurations                                                                                                                                                             |
| **Monitors**      | `monitors/monitors.json`     | Background monitor configurations                                                                                                                                                          |
| **Executables**   | `bin/`                       | Executables added to the Bash tool's `PATH`. Files here are invokable as bare commands in any Bash tool call while the plugin is enabled                                                   |
| **Settings**      | `settings.json`              | Default configuration applied when the plugin is enabled. Only the [`agent`](/docs/en/sub-agents) and [`subagentStatusLine`](/docs/en/statusline#subagent-status-lines) keys are currently supported |

---

## CLI commands reference

Claude Code provides CLI commands for non-interactive plugin management, useful for scripting and automation.

### plugin init

Scaffold a new plugin at `~/.claude/skills/<name>/`. On the next Claude Code session it loads automatically as `<name>@skills-dir` and appears in `/plugin` and `claude plugin list` with no install step.

See [Skills-directory plugins](#skills-directory-plugins) for scope and trust requirements.

```bash
claude plugin init <name> [options]
```

**Arguments:**

* `<name>`: Plugin name. Becomes the skill namespace and the directory name under `~/.claude/skills/`, so it cannot contain spaces or path separators.

**Options:**

| Option                   | Description                                                                                                         | Default                 |
| :------------------------ | :------------------------------------------------------------------------------------------------------------------ | :------------------------ |
| `--description <text>`   | Manifest description                                                                                                |                         |
| `--author <name>`        | Author name                                                                                                         | `git config user.name`  |
| `--author-email <email>` | Author email                                                                                                        | `git config user.email` |
| `--with <components...>` | Also scaffold component folders. Valid values: `skills`, `agents`, `hooks`, `mcp`, `lsp`, `output-style`, `channel` |                         |
| `-f, --force`            | Overwrite an existing `.claude-plugin/` at the target                                                               |                         |
| `-h, --help`             | Display help for command                                                                                            |                         |

**Aliases:** `new`

Each `--with` value adds a starter file for that component, ready to edit:

| Component      | What it scaffolds                                                                                         |
| :--------------- | :------------------------------------------------------------------------------------------------------------ |
| `skills`       | An extra namespaced `<name>:example` skill alongside the default one                                      |
| `agents`       | An `agents/` subagent definition                                                                          |
| `hooks`        | A `hooks/hooks.json` with a sample event handler                                                          |
| `mcp`          | A `.mcp.json` with HTTP and stdio server examples                                                         |
| `lsp`          | A `.lsp.json` language-server example                                                                     |
| `output-style` | An `output-styles/<name>.md` that applies automatically while the plugin is enabled                       |
| `channel`      | An MCP-based [channel](/docs/en/channels): a stdio server (`server.ts`), its `.mcp.json`, and a `package.json` |

The scaffolded plugin uses the `@skills-dir` source rather than a marketplace. Admins can block this source with `strictKnownMarketplaces` or by adding `{"source": "skills-dir"}` to `blockedMarketplaces` in [managed settings](/docs/en/plugin-marketplaces#managed-marketplace-restrictions). When blocked, `plugin init` fails before writing.

**Examples:**

```bash
# Scaffold a minimal plugin
claude plugin init my-helper

# Scaffold with skill and hook folders
claude plugin init my-helper --with skills hooks

# Overwrite an existing scaffold
claude plugin init my-helper --force
```

### plugin install

Install a plugin from available marketplaces.

```bash
claude plugin install <plugin> [options]
```

**Arguments:**

* `<plugin>`: Plugin name or `plugin-name@marketplace-name` for a specific marketplace

**Options:**

| Option                 | Description                                                                                                                 | Default |
| :----------------------- | :--------------------------------------------------------------------------------------------------------------------------- | :------- |
| `-s, --scope <scope>`  | Installation scope: `user`, `project`, or `local`                                                                           | `user`  |
| `--config <key=value>` | Set a [`userConfig`](#user-configuration) option declared in the plugin's manifest. Repeat the flag to set multiple options |         |
| `-h, --help`           | Display help for command                                                                                                    |         |

Scope determines which settings file the installed plugin is added to. For example, `--scope project` writes to `enabledPlugins` in .claude/settings.json, making the plugin available to everyone who clones the project repository.

**Examples:**

```bash
# Install to user scope (default)
claude plugin install formatter@my-marketplace

# Install to project scope (shared with team)
claude plugin install formatter@my-marketplace --scope project

# Install to local scope (not shared with team)
claude plugin install formatter@my-marketplace --scope local
```

### plugin uninstall

Remove an installed plugin.

```bash
claude plugin uninstall <plugin> [options]
```

**Arguments:**

* `<plugin>`: Plugin name or `plugin-name@marketplace-name`

**Options:**

| Option                | Description                                                                                              | Default |
| :---------------------- | :----------------------------------------------------------------------------------------------------------- | :------- |
| `-s, --scope <scope>` | Uninstall from scope: `user`, `project`, or `local`                                                      | `user`  |
| `--keep-data`         | Preserve the plugin's [persistent data directory](#persistent-data-directory)                            |         |
| `--prune`             | Also remove auto-installed dependencies that no other plugin requires. See [plugin prune](#plugin-prune) |         |
| `-y, --yes`           | Skip the `--prune` confirmation prompt. Required when stdin or stdout is not a TTY                       |         |
| `-h, --help`          | Display help for command                                                                                 |         |

**Aliases:** `remove`, `rm`

By default, uninstalling from the last remaining scope also deletes the plugin's `${CLAUDE_PLUGIN_DATA}` directory. Use `--keep-data` to preserve it, for example when reinstalling after testing a new version.

> **Note:** When installed plugins from different marketplaces share a name, the `plugin-name@marketplace-name` form uninstalls only the plugin from the named marketplace. Before v2.1.212, the qualified form could match and uninstall the same-named plugin from a different marketplace.

### plugin prune

Remove auto-installed plugin dependencies that are no longer required by any installed plugin. Dependencies that Claude Code pulled in to satisfy another plugin's [`dependencies`](/docs/en/plugin-dependencies) field are removed; plugins you installed directly are never touched.

```bash
claude plugin prune [options]
```

**Options:**

| Option                | Description                                                              | Default |
| :---------------------- | :--------------------------------------------------------------------------- | :------- |
| `-s, --scope <scope>` | Prune at scope: `user`, `project`, or `local`                            | `user`  |
| `--dry-run`           | List what would be removed without removing anything                     |         |
| `-y, --yes`           | Skip the confirmation prompt. Required when stdin or stdout is not a TTY |         |
| `-h, --help`          | Display help for command                                                 |         |

**Aliases:** `autoremove`

The command lists orphaned dependencies and asks for confirmation before removing them. To remove a plugin and clean up its dependencies in one step, run `claude plugin uninstall <plugin> --prune`.

> **Note:** `claude plugin prune` requires Claude Code v2.1.121 or later.

### plugin enable

Enable a disabled plugin. If the plugin declares [dependencies](/docs/en/plugin-dependencies), Claude Code enables them transitively at the same scope, and the command fails when a dependency is not installed.

```bash
claude plugin enable <plugin> [options]
```

**Arguments:**

* `<plugin>`: Plugin name or `plugin-name@marketplace-name`

**Options:**

| Option                | Description                                                                                                               | Default     |
| :---------------------- | :---------------------------------------------------------------------------------------------------------------------- | :------------ |
| `-s, --scope <scope>` | Scope to enable: `user`, `project`, or `local`. When omitted, Claude Code detects the scope where the plugin is installed | Auto-detect |
| `-h, --help`          | Display help for command                                                                                                  |             |

### plugin disable

Disable a plugin without uninstalling it. Fails when another enabled plugin [depends on](/docs/en/plugin-dependencies#enable-or-disable-a-plugin-with-dependencies) the target. The error message includes a chained command that disables every dependent first.

```bash
claude plugin disable [plugin] [options]
```

**Arguments:**

* `[plugin]`: Plugin name or `plugin-name@marketplace-name`. Optional when using `--all`

**Options:**

| Option                | Description                                                                                                                | Default     |
| :---------------------- | :--------------------------------------------------------------------------------------------------------------------------- | :------------ |
| `-a, --all`           | Disable all enabled plugins. Can't be combined with `--scope`                                                              |             |
| `-s, --scope <scope>` | Scope to disable: `user`, `project`, or `local`. When omitted, Claude Code detects the scope where the plugin is installed | Auto-detect |
| `-h, --help`          | Display help for command                                                                                                   |             |

### plugin update

Update a plugin to the latest version.

```bash
claude plugin update <plugin> [options]
```

**Arguments:**

* `<plugin>`: Plugin name or `plugin-name@marketplace-name`

**Options:**

| Option                | Description                                               | Default |
| :---------------------- | :------------------------------------------------------------ | :------- |
| `-s, --scope <scope>` | Scope to update: `user`, `project`, `local`, or `managed` | `user`  |
| `-h, --help`          | Display help for command                                  |         |

---

### plugin list

List installed plugins with their version, source marketplace, and enable status.

```bash
claude plugin list [options]
```

**Options:**

| Option        | Description                                                    | Default |
| :-------------- | :----------------------------------------------------------------- | :------- |
| `--json`      | Output as JSON                                                 |         |
| `--available` | Include available plugins from marketplaces. Requires `--json` |         |
| `-h, --help`  | Display help for command                                       |         |

Within an interactive session, `/plugin list` prints a similar listing inline, but it covers marketplace-installed plugins only:

* Plugins loaded from skills directories appear in the `/plugin` interface and in `claude plugin list`, but not in the inline `/plugin list` output.
* Plugins loaded for the session with `--plugin-dir` or `--plugin-url` appear in the `/plugin` interface, and in `claude plugin list` only when the same flag precedes the subcommand, as in `claude --plugin-dir <dir> plugin list`. They have no installed record, so a bare `claude plugin list` doesn't show them.

The interactive form accepts `--enabled` or `--disabled` to show only plugins in that state, and `ls` as a shorthand for `list`.

### plugin details

Show a plugin's component inventory and projected token cost. The output lists all components the plugin contributes, grouped as Skills, Agents, Hooks, MCP servers, and LSP servers, along with an estimate of how many tokens it adds to each session. The Skills group includes both `skills/` and `commands/` entries.

```bash
claude plugin details <name>
```

**Arguments:**

* `<name>`: Plugin name or `plugin-name@marketplace-name`

**Options:**

| Option       | Description              | Default |
| :------------- | :-------------------------- | :------- |
| `-h, --help` | Display help for command |         |

The output shows two cost figures for each component:

* **Always-on:** tokens added to every session by the plugin's listing text, such as skill descriptions, agent descriptions, and command names, regardless of whether any component fires.
* **On-invoke:** tokens a component costs when it fires. Shown per component, not as a plugin total, because a typical session invokes only a subset of components.

This example shows what the output looks like for a plugin with two skills:

```
dependency-guard 1.2.0
  Dependency analysis for Claude Code sessions
  Source: dependency-guard@example-marketplace

Component inventory
  Skills (2)  scan-dependencies, review-changes
  Agents (0)
  Hooks (1)  SessionStart  (harness-only — no model context cost)
  MCP servers (0)
  LSP servers (0)

Projected token cost
  Always-on:   ~180 tok   added to every session

Per-component (rounded)
  component            always-on  on-invoke
  scan-dependencies        ~100      ~2400
  review-changes            ~80      ~1800

  On-invoke cost is paid each time a skill or agent fires.
  Token counts are estimates and may differ from actual usage.
```

The always-on total is computed via the `count_tokens` API for your active model. Per-component numbers are proportionally scaled from that total. If the API is unreachable, the command falls back to a character-based estimate.

### plugin tag

Create a release git tag for a plugin. By default the command tags the plugin in the current directory; pass a path to tag a plugin elsewhere. See [Tag plugin releases](/docs/en/plugin-dependencies#tag-plugin-releases-for-version-resolution).

```bash
claude plugin tag [path] [options]
```

**Arguments:**

* `[path]`: Path to the plugin directory. Defaults to the current directory.

**Options:**

| Option                | Description                                                                | Default  |
| :---------------------- | :------------------------------------------------------------------------- | :-------- |
| `--push`              | Push the tag to the remote after creating it                               |          |
| `--dry-run`           | Print what would be tagged without creating the tag                        |          |
| `-f, --force`         | Create the tag even if the working tree is dirty or the tag already exists |          |
| `-m, --message <msg>` | Tag annotation message. Use `%s` as a placeholder for the version          |          |
| `--remote <name>`     | Remote to push to with `--push`                                            | `origin` |
| `-h, --help`          | Display help for command                                                   |          |

---

## Debugging and development tools

### Debugging commands

Use `claude --debug` to see plugin loading details:

This shows:

* Which plugins are being loaded
* Any errors in plugin manifests
* Skill, agent, and hook registration
* MCP server initialization

### Common issues

| Issue                               | Cause                           | Solution                                                                                                                                                                                                                               |
| :------------------------------------ | :--------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plugin not loading                  | Invalid `plugin.json`           | Run `claude plugin validate ./my-plugin` or `/plugin validate ./my-plugin`, where `./my-plugin` is your plugin directory, to check `plugin.json`, skill/agent/command frontmatter, and `hooks/hooks.json` for syntax and schema errors |
| Skills not appearing                | Wrong directory structure       | Ensure `skills/` or `commands/` is at the plugin root, not inside `.claude-plugin/`                                                                                                                                                    |
| Hooks not firing                    | Script not executable           | Run `chmod +x script.sh`                                                                                                                                                                                                               |
| MCP server fails                    | Missing `${CLAUDE_PLUGIN_ROOT}` | Use variable for all plugin paths                                                                                                                                                                                                      |
| Path errors                         | Absolute paths used             | All paths must be relative and start with `./`                                                                                                                                                                                         |
| LSP `Executable not found in $PATH` | Language server not installed   | Install the binary (e.g., `npm install -g typescript-language-server typescript`)                                                                                                                                                      |

### Example error messages

**Manifest validation errors**:

* `Invalid JSON syntax: Unexpected token } in JSON at position 142`: check for missing commas, extra commas, or unquoted strings
* `Plugin <name> has an invalid manifest file at .claude-plugin/plugin.json. Validation errors: name: Invalid input: expected string, received undefined`: a required field is missing
* `Plugin <name> has a corrupt manifest file at .claude-plugin/plugin.json. JSON parse error: ...`: JSON syntax error

**Plugin loading errors**:

* `Warning: No commands found in plugin my-plugin custom directory: ./cmds. Expected .md files or SKILL.md in subdirectories.`: command path exists but contains no valid command files
* `Plugin directory not found at path: ./plugins/my-plugin. Check that the marketplace entry has the correct path.`: the `source` path in marketplace.json points to a non-existent directory
* `Plugin my-plugin has conflicting manifests: both plugin.json and marketplace entry specify components.`: remove duplicate component definitions or remove `strict: false` in marketplace entry

### Hook troubleshooting

**Hook script not executing**:

1. Check the script is executable: `chmod +x ./scripts/your-script.sh`
2. Verify the shebang line: First line should be `#!/bin/bash` or `#!/usr/bin/env bash`
3. Check the path uses `${CLAUDE_PLUGIN_ROOT}`: `"command": "\"${CLAUDE_PLUGIN_ROOT}\"/scripts/your-script.sh"`
4. Test the script manually: `./scripts/your-script.sh`

**Hook not triggering on expected events**:

1. Verify the event name is correct (case-sensitive): `PostToolUse`, not `postToolUse`
2. Check the matcher pattern matches your tools: `"matcher": "Write|Edit"` for file operations
3. Confirm the hook type is valid: `command`, `http`, `mcp_tool`, `prompt`, or `agent`

### MCP server troubleshooting

**Server not starting**:

1. Check the command exists and is executable
2. Verify all paths use `${CLAUDE_PLUGIN_ROOT}` variable
3. Check the MCP server logs: `claude --debug` shows initialization errors
4. Test the server manually outside of Claude Code

**Server tools not appearing**:

1. Ensure the server is properly configured in `.mcp.json` or `plugin.json`
2. Verify the server implements the MCP protocol correctly
3. Check for connection timeouts in debug output

### Directory structure mistakes

**Symptoms**: Plugin loads but components (skills, agents, hooks) are missing.

**Correct structure**: Components must be at the plugin root, not inside `.claude-plugin/`. Only `plugin.json` belongs in `.claude-plugin/`.

```text
my-plugin/
├── .claude-plugin/
│   └── plugin.json      ← Only manifest here
├── commands/            ← At root level
├── agents/              ← At root level
└── hooks/               ← At root level
```

If your components are inside `.claude-plugin/`, move them to the plugin root.

**Debug checklist**:

1. Run `claude --debug` and look for "loading plugin" messages
2. Check that each component directory is listed in the debug output
3. Verify file permissions allow reading the plugin files

---

## Distribution and versioning reference

### Version management

Claude Code uses the plugin's version as the cache key that determines whether an update is available. When you run `/plugin update` or auto-update fires, Claude Code computes the current version and skips the update if it matches what's already installed.

The version is resolved from the first of these that is set:

1. The `version` field in the plugin's `plugin.json`
2. The `version` field in the plugin's marketplace entry in `marketplace.json`
3. The git commit SHA of the plugin's source, for `github`, `url`, `git-subdir`, and relative-path sources in a git-hosted marketplace
4. `unknown`, for `npm` sources or local directories not inside a git repository

This gives you two ways to version a plugin:

| Approach               | How                                                              | Update behavior                                                                                                                                                      | Best for                                          |
| :----------------------- | :------------------------------------------------------------------ | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------- |
| **Explicit version**   | Set `"version": "2.1.0"` in `plugin.json`                        | Users get updates only when you bump this field. Pushing new commits without bumping it has no effect, and `/plugin update` reports "already at the latest version". | Published plugins with stable release cycles      |
| **Commit-SHA version** | Omit `version` from both `plugin.json` and the marketplace entry | Users get updates on every new commit to the plugin's git source                                                                                                     | Internal or team plugins under active development |

> **Warning:** If you set `version` in `plugin.json`, you must bump it every time you want users to receive changes. Pushing new commits alone is not enough, because Claude Code sees the same version string and keeps the cached copy. If you're iterating quickly, leave `version` unset so the git commit SHA is used instead.

If you use explicit versions, follow [semantic versioning](https://semver.org) (`MAJOR.MINOR.PATCH`): bump MAJOR for breaking changes, MINOR for new features, PATCH for bug fixes. Document changes in a `CHANGELOG.md`.

---

## See also

* [Plugins](/docs/en/plugins) - Tutorials and practical usage
* [Plugin marketplaces](/docs/en/plugin-marketplaces) - Creating and managing marketplaces
* [Skills](/docs/en/skills) - Skill development details
* [Subagents](/docs/en/sub-agents) - Agent configuration and capabilities
* [Hooks](/docs/en/hooks) - Event handling and automation
* [MCP](/docs/en/mcp) - External tool integration
* [Settings](/docs/en/settings) - Configuration options for plugins
