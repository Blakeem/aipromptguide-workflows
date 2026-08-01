Source: https://code.claude.com/docs/en/plugins-reference (sections: "Plugin installation scopes", "Skills-directory plugins", "Plugin manifest schema")
Version: Claude Code docs (current as of retrieval)
Retrieved: 2026-08-01

---

# Plugins reference

## Plugin installation scopes

When you install a plugin, you choose a **scope** that determines where the plugin is available and who else can use it:

| Scope     | Settings file                                   | Use case                                                                    |
| :-------- | :------------------------------------------------ | :---------------------------------------------------------------------------- |
| `user`    | `~/.claude/settings.json`                       | Personal plugins available across all projects (default)                    |
| `project` | `.claude/settings.json`                         | Team plugins shared via version control                                     |
| `local`   | `.claude/settings.local.json`                   | Project-specific plugins, gitignored when Claude Code saves a setting to it |
| `managed` | [Managed settings](/docs/en/settings#settings-files) | Managed plugins (read-only, update only)                                    |

Plugins use the same scope system as other Claude Code configurations. For installation instructions and scope flags, see [Install plugins](/docs/en/discover-plugins#install-plugins). For a complete explanation of scopes, see [Configuration scopes](/docs/en/settings#configuration-scopes).

---

## Skills-directory plugins

Any folder under a skills directory that contains a `.claude-plugin/plugin.json` manifest is loaded as a plugin named `<name>@skills-dir` on the next session, with no marketplace and no install step. Scaffold one with [`plugin init`](#plugin-init). Unlike a marketplace install, the plugin is discovered in place rather than copied into the plugin cache.

A skills directory tree supports three distinct things:

| What you have                                 | What it is                                                                          |
| :---------------------------------------------- | :------------------------------------------------------------------------------------ |
| `<skills-dir>/foo/SKILL.md` with no manifest  | A plain [skill](/docs/en/skills) named `foo`                                             |
| `<skills-dir>/foo/.claude-plugin/plugin.json` | A plugin `foo@skills-dir`, which can bundle its own skills, agents, hooks, and more |
| `<plugin>/skills/bar/SKILL.md`                | A skill `bar` packaged inside a plugin                                              |

### Choose where the plugin loads from

| Skills directory        | Scope    | Loads                                                                            |
| :------------------------ | :------- | :---------------------------------------------------------------------------------- |
| `~/.claude/skills/`     | personal | In every project, since the location is yours alone                              |
| `<cwd>/.claude/skills/` | project  | Only after you accept the workspace [trust dialog](/docs/en/settings) for that folder |

A project-scope plugin is checked into the repository and reaches every collaborator who clones it. Because that content comes from the repository rather than from you, it loads only after the same trust gate that governs `.claude/settings.json`, and components that run code are restricted further:

* MCP servers it declares go through the [same per-server approval](/docs/en/mcp) as a project `.mcp.json`
* LSP servers start only after you trust the workspace
* [Background monitors](#monitors) do not load

Personal-scope plugins have none of these restrictions.

> **Warning:** Project-scope `@skills-dir` plugins load only from the `.claude/skills/` of the directory where you start Claude Code. They don't [walk up to the repository root](/docs/en/skills#discovery-from-parent-and-nested-directories) the way plain skills and commands do, so launching from a subdirectory misses a plugin that lives at the repo root. Launch from the repository root, or run `/reload-plugins` after changing directories.

### Edit, reload, and disable a skills-directory plugin

Changes you make to a skill's `SKILL.md` take effect immediately in the current session. Changes to the plugin's other components, such as `hooks/`, `.mcp.json`, `agents/`, and `output-styles/`, do not. Run `/reload-plugins` or restart Claude Code to pick those up. See [Live change detection](/docs/en/skills#live-change-detection).

To stop loading a skills-directory plugin, delete its folder or disable it by name. There is no `uninstall` step because nothing was installed from a marketplace.

```bash
claude plugin disable my-tool@skills-dir
```

---

## Plugin manifest schema

The `.claude-plugin/plugin.json` file defines your plugin's metadata and configuration. This section documents all supported fields and options.

The manifest is optional. If omitted, Claude Code auto-discovers components in [default locations](#file-locations-reference) and derives the plugin name from the directory name. Use a manifest when you need to provide metadata or custom component paths.

### Complete schema

```json
{
  "name": "plugin-name",
  "displayName": "Plugin Name",
  "version": "1.2.0",
  "description": "Brief plugin description",
  "author": {
    "name": "Author Name",
    "email": "author@example.com",
    "url": "https://github.com/author"
  },
  "homepage": "https://docs.example.com/plugin",
  "repository": "https://github.com/author/plugin",
  "license": "MIT",
  "keywords": ["keyword1", "keyword2"],
  "skills": "./custom/skills/",
  "commands": ["./custom/commands/special.md"],
  "agents": ["./custom/agents/reviewer.md"],
  "hooks": "./config/hooks.json",
  "mcpServers": "./mcp-config.json",
  "outputStyles": "./styles/",
  "lspServers": "./.lsp.json",
  "experimental": {
    "themes": "./themes/",
    "monitors": "./monitors.json"
  },
  "dependencies": [
    "helper-lib",
    { "name": "secrets-vault", "version": "~2.1.0" }
  ]
}
```

### Required fields

If you include a manifest, `name` is the only required field.

| Field  | Type   | Description                                                                                                                                                                                                                       | Example              |
| :----- | :----- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------- |
| `name` | string | Unique identifier (kebab-case, no spaces). When a [marketplace entry](/docs/en/plugin-marketplaces#plugin-entries) lists the plugin under a different name, the marketplace entry name is what `enabledPlugins` keys and `/plugin` use | `"deployment-tools"` |

This name is used for namespacing components. For example, in the UI, the agent `agent-creator` for the plugin with name `plugin-dev` will appear as `plugin-dev:agent-creator`.

### Unrecognized fields

Claude Code ignores top-level fields it does not recognize. You can keep metadata from another ecosystem in `plugin.json` and the plugin still loads. This makes it practical to maintain one manifest that doubles as a VS Code or Cursor extension manifest, an npm `package.json`, or an MCPB/DXT bundle manifest.

`claude plugin validate` reports unrecognized fields as warnings, not errors. If a field is one or two characters off from a recognized one, the warning suggests the likely intended name. A plugin with only unrecognized-field warnings still passes validation and loads at runtime.

Fields with the wrong type still fail. For example, a `keywords` value that is a string instead of an array is a load error, and `claude plugin validate` reports it as one.

Pass `--strict` to treat warnings as errors. Use it in CI to catch a misspelled field name or a field left over from another tool's manifest before publishing, even though the plugin would load at runtime.

```bash
claude plugin validate ./my-plugin --strict
```

### Metadata fields

| Field            | Type    | Description                                                                                                                                                                                                                                                                                                                                      | Example                                                           |
| :---------------- | :------ | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------ |
| `$schema`        | string  | JSON Schema URL for editor autocomplete and validation. Claude Code ignores this field at load time.                                                                                                                                                                                                                                             | `"https://json.schemastore.org/claude-code-plugin-manifest.json"` |
| `displayName`    | string  | (min-version: 2.1.143) Human-readable name shown in the `/plugin` picker and other UI surfaces. Falls back to `name` when omitted. Unlike `name`, may contain spaces and any casing. Not used for namespacing or lookup. Requires Claude Code v2.1.143 or later.                                                                            | `"Deployment Tools"`                                              |
| `version`        | string  | Optional. Semantic version. Setting this pins the plugin to that version string, so users only receive updates when you bump it. If omitted, Claude Code falls back to the git commit SHA, so every commit is treated as a new version. If also set in the marketplace entry, `plugin.json` wins. See [Version management](#version-management). | `"2.1.0"`                                                         |
| `description`    | string  | Brief explanation of plugin purpose                                                                                                                                                                                                                                                                                                              | `"Deployment automation tools"`                                   |
| `author`         | object  | Author information                                                                                                                                                                                                                                                                                                                               | `{"name": "Dev Team", "email": "dev@company.com"}`                |
| `homepage`       | string  | Documentation URL                                                                                                                                                                                                                                                                                                                                | `"https://docs.example.com"`                                      |
| `repository`     | string  | Source code URL                                                                                                                                                                                                                                                                                                                                  | `"https://github.com/user/plugin"`                                |
| `license`        | string  | License identifier                                                                                                                                                                                                                                                                                                                               | `"MIT"`, `"Apache-2.0"`                                           |
| `keywords`       | array   | Discovery tags                                                                                                                                                                                                                                                                                                                                   | `["deployment", "ci-cd"]`                                         |
| `defaultEnabled` | boolean | (min-version: 2.1.154) Whether the plugin starts in an enabled state when the user has not set one. Defaults to `true`. See [Default enablement](#default-enablement). Requires Claude Code v2.1.154 or later.                                                                                                                              | `false`                                                           |

### Default enablement

Set `defaultEnabled: false` in `plugin.json` to ship a plugin that installs disabled. The user turns it on with `claude plugin enable <plugin>` or the `/plugin` interface. Use this for plugins that add cost or scope a user should opt into, such as one that connects to an external service. This requires Claude Code v2.1.154 or later. Earlier versions ignore the field and enable the plugin on install.

`defaultEnabled` is the fallback when nothing else has decided the plugin's state. Two things take precedence over it:

* **The user's setting**: an entry for the plugin in `enabledPlugins` at any settings scope. Once written, it persists across plugin updates and reinstalls, so changing `defaultEnabled` in a later release does not flip an existing user.
* **A dependency requirement**: when a plugin is required by another one that is active, Claude Code writes `true` for it at install or enable time. That gives it an explicit setting, so its own default no longer applies. See [Enable or disable a plugin with dependencies](/docs/en/plugin-dependencies#enable-or-disable-a-plugin-with-dependencies).

The same field can appear in a plugin's marketplace entry, where it takes precedence over the value in `plugin.json`. See [Optional plugin fields](/docs/en/plugin-marketplaces#optional-plugin-fields).

### Component path fields

| Field                   | Type                  | Description                                                                                                                                                                   | Example                                              |
| :---------------------- | :--------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------- |
| `skills`                | string\|array         | Custom skill directories containing `<name>/SKILL.md`. Adds to the default `skills/` scan. See [Path behavior rules](#path-behavior-rules) for the marketplace-root exception | `"./custom/skills/"`                                 |
| `commands`              | string\|array         | Custom flat `.md` skill files or directories (replaces default `commands/`)                                                                                                   | `"./custom/cmd.md"` or `["./cmd1.md"]`               |
| `agents`                | string\|array         | Custom agent files (replaces default `agents/`)                                                                                                                               | `"./custom/agents/reviewer.md"`                      |
| `workflows`             | string\|array         | Custom [workflow](/docs/en/workflows) script files or directories (replaces default `workflows/`)                                                                                  | `"./custom/workflows/"`                              |
| `hooks`                 | string\|array\|object | Hook config paths or inline config                                                                                                                                            | `"./my-extra-hooks.json"`                            |
| `mcpServers`            | string\|array\|object | MCP config paths or inline config                                                                                                                                             | `"./my-extra-mcp-config.json"`                       |
| `outputStyles`          | string\|array         | Custom output style files/directories (replaces default `output-styles/`)                                                                                                     | `"./styles/"`                                        |
| `lspServers`            | string\|array\|object | [Language Server Protocol](https://microsoft.github.io/language-server-protocol/) configs for code intelligence (go to definition, find references, etc.)                     | `"./.lsp.json"`                                      |
| `experimental.themes`   | string\|array         | Color theme files/directories (replaces default `themes/`). See [Themes](#themes)                                                                                             | `"./themes/"`                                        |
| `experimental.monitors` | string\|array         | Background [Monitor](/docs/en/tools-reference#monitor-tool) configurations that start automatically when the plugin is active. See [Monitors](#monitors)                           | `"./monitors.json"`                                  |
| `userConfig`            | object                | User-configurable values prompted at enable time. See [User configuration](#user-configuration)                                                                               | See below                                            |
| `channels`              | array                 | Channel declarations for message injection (Telegram, Slack, Discord style). See [Channels](#channels)                                                                        | See below                                            |
| `dependencies`          | array                 | Other plugins this plugin requires, optionally with semver version constraints. See [Constrain plugin dependency versions](/docs/en/plugin-dependencies)                           | `[{ "name": "secrets-vault", "version": "~2.1.0" }]` |

### Experimental components

Components under the `experimental` key, `themes` and `monitors`, have a manifest schema that may change between releases while they stabilize. Where you declare them is a separate migration: the top level still works, `claude plugin validate` warns, and a future release will require `experimental.*`.

### User configuration

The `userConfig` field declares values that Claude Code prompts the user for when the plugin is enabled. Use this instead of requiring users to hand-edit `settings.json`.

```json
{
  "userConfig": {
    "api_endpoint": {
      "type": "string",
      "title": "API endpoint",
      "description": "Your team's API endpoint"
    },
    "api_token": {
      "type": "string",
      "title": "API token",
      "description": "API authentication token",
      "sensitive": true
    }
  }
}
```

Keys must be valid identifiers. Each option supports these fields:

| Field         | Required | Description                                                                              |
| :------------ | :------- | :------------------------------------------------------------------------------------------ |
| `type`        | Yes      | One of `string`, `number`, `boolean`, `directory`, or `file`                             |
| `title`       | Yes      | Label shown in the configuration dialog                                                  |
| `description` | Yes      | Help text shown beneath the field                                                        |
| `sensitive`   | No       | If `true`, masks input and stores the value in secure storage instead of `settings.json` |
| `required`    | No       | If `true`, validation fails when the field is empty                                      |
| `default`     | No       | Value used when the user provides nothing                                                |
| `multiple`    | No       | For `string` type, allow an array of strings                                             |
| `min` / `max` | No       | Bounds for `number` type                                                                 |

Each value is available for substitution as `${user_config.KEY}` in MCP and LSP server configs and hook commands. Non-sensitive values can also be substituted in skill and agent content. All values are exported to hook processes as `CLAUDE_PLUGIN_OPTION_<KEY>` environment variables, where `<KEY>` is the option key uppercased.

Fields that run in a shell reject `${user_config.*}`: substituting a configured value into a shell command would let the shell run whatever that value contains, so the component fails with an [error](/docs/en/errors#plugin-command-references-user-config) instead. Each rejected field has an alternative way to pass the value:

| Rejected field                                                               | How to pass the value                                                                                                             |
| :------------------------------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------ |
| Shell-form hook commands                                                     | Use [exec form](/docs/en/hooks#exec-form-and-shell-form) with `args`, or read `CLAUDE_PLUGIN_OPTION_<KEY>` from the hook's environment |
| [Monitor](#monitors) commands                                                | Read the value from a config file in the script                                                                                   |
| MCP [`headersHelper`](/docs/en/mcp#use-dynamic-headers-for-custom-authentication) | Read the value from a config file in the script                                                                                   |

Before v2.1.207, these fields substituted `${user_config.KEY}` values; update plugins that relied on this.

Non-sensitive values are stored under the [`pluginConfigs`](/docs/en/settings#pluginconfigs) key in your user `settings.json` as `pluginConfigs[<plugin-id>].options`.

Sensitive values go to the macOS Keychain, or to `~/.claude/.credentials.json` on platforms where no supported keychain is available. Keychain storage is shared with OAuth tokens and has an approximately 2 KB total limit, so keep sensitive values small.

Claude Code reads all `pluginConfigs` values from only three settings sources:

* **User settings**: `~/.claude/settings.json`, the file the enable-time prompt writes to
* **`--settings`**: the CLI flag or SDK inline settings
* **Managed settings**: [organization-controlled policy](/docs/en/permissions#managed-settings)

When more than one source sets the same key, managed settings take precedence, then `--settings`, then user settings. The [`--setting-sources`](/docs/en/cli-reference#cli-flags) flag narrows the list further.

Entries in a project's `.claude/settings.json` or `.claude/settings.local.json` are ignored. Both files live in the workspace, so a cloned repository could supply values there, and those values would flow into plugin hook commands, MCP server configs, LSP commands, and monitor commands. Before v2.1.207, these entries were read. The restriction is specific to `pluginConfigs`: [`enabledPlugins`](/docs/en/settings#enabledplugins) still honors project and local settings.

### Channels

The `channels` field lets a plugin declare one or more message channels that inject content into the conversation. Each channel binds to an MCP server that the plugin provides.

```json
{
  "channels": [
    {
      "server": "telegram",
      "userConfig": {
        "bot_token": {
          "type": "string",
          "title": "Bot token",
          "description": "Telegram bot token",
          "sensitive": true
        },
        "owner_id": {
          "type": "string",
          "title": "Owner ID",
          "description": "Your Telegram user ID"
        }
      }
    }
  ]
}
```

The `server` field is required and must match a key in the plugin's `mcpServers`. The optional per-channel `userConfig` uses the same schema as the top-level field, letting the plugin prompt for bot tokens or owner IDs when the plugin is enabled.

### Path behavior rules

Whether a custom path replaces or extends the plugin's default directory depends on the field:

* **Replaces the default**: `commands`, `agents`, `workflows`, `outputStyles`, `experimental.themes`, `experimental.monitors`. For example, when the manifest specifies `commands`, the default `commands/` directory is not scanned. To keep the default and add more, list it explicitly: `"commands": ["./commands/", "./extras/"]`
* **Adds to the default**: `skills`. The default `skills/` directory is always scanned, and directories listed in `skills` are loaded alongside it. Exception: for a [marketplace entry whose `source` resolves to the marketplace root](/docs/en/plugin-marketplaces#advanced-plugin-entries), declaring specific subdirectories replaces the default `skills/` scan
* **Own merge rules**: [hooks](#hooks), [MCP servers](#mcp-servers), and [LSP servers](#lsp-servers). See each section for how multiple sources combine

When a plugin has both a default folder and the matching manifest key, Claude Code v2.1.140 and later warns about the ignored folder in `claude plugin list` and the `/plugin` detail view. The plugin still loads using the manifest paths. Claude Code doesn't warn when the manifest key points into the default folder, for example `"commands": ["./commands/deploy.md"]`, because that path names the folder explicitly.

For all path fields:

* All paths must be relative to the plugin root and start with `./`
* Components from custom paths use the same naming and namespacing rules
* Multiple paths can be specified as arrays
* When a skill path points to a directory that contains a `SKILL.md` directly, for example `"skills": ["./"]` pointing to the plugin root, the frontmatter `name` field in `SKILL.md` determines the skill's invocation name. This gives a stable name regardless of the install directory. If `name` is not set in the frontmatter, the directory basename is used as a fallback.

A plugin that has a `SKILL.md` at its root, no `skills/` subdirectory, and no `skills` manifest field is automatically loaded as a single-skill plugin in Claude Code v2.1.142 and later. You do not need to set `"skills": ["./"]` in `plugin.json` for this layout. The skill's invocation name follows the same rule as above: the frontmatter `name` field, or the directory basename as a fallback.

**Path examples**:

```json
{
  "commands": [
    "./specialized/deploy.md",
    "./utilities/batch-process.md"
  ],
  "agents": [
    "./custom-agents/reviewer.md",
    "./custom-agents/tester.md"
  ]
}
```

### Environment variables

Claude Code provides three variables for referencing paths:

| Variable                | Resolves to                                                                                                 | Use it for                                                                                               |
| :------------------------ | :-------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------- |
| `${CLAUDE_PLUGIN_ROOT}` | Absolute path to the plugin's installation directory                                                        | Scripts, binaries, and config files bundled with the plugin                                              |
| `${CLAUDE_PLUGIN_DATA}` | [Persistent directory](#persistent-data-directory) that survives plugin updates, created on first reference | Installed dependencies such as `node_modules` or Python virtual environments, generated code, and caches |
| `${CLAUDE_PROJECT_DIR}` | The project root                                                                                            | Project-local scripts and config files                                                                   |

All three are exported as environment variables to hook processes and to MCP and LSP server subprocesses. Which fields substitute them inline depends on the plugin component:

| Plugin component                | Fields where placeholders resolve           |
| :--------------------------------- | :--------------------------------------------- |
| Skill and agent content         | Anywhere the placeholder appears            |
| Hook and monitor commands       | Anywhere the placeholder appears            |
| MCP `stdio` servers             | `command`, `args`, `env`                    |
| MCP `http`, `sse`, `ws` servers | `url`, `headers`, `headersHelper`           |
| LSP servers                     | `command`, `args`, `env`, `workspaceFolder` |

In hook commands, use [exec form](/docs/en/hooks#exec-form-and-shell-form) with `args` so each path is passed as one argument with no quoting. In shell-form hooks and monitor commands, wrap the variables in double quotes, as in `"${CLAUDE_PROJECT_DIR}/scripts/server.sh"`. This shell-form hook runs a script bundled with a plugin:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"${CLAUDE_PLUGIN_ROOT}\"/scripts/process.sh"
          }
        ]
      }
    ]
  }
}
```

`${CLAUDE_PLUGIN_ROOT}` changes when the plugin updates. The previous version's directory remains on disk for about two weeks after an update before cleanup, but treat it as ephemeral and don't write state there.

When a plugin updates mid-session, hook commands, monitors, MCP servers, and LSP servers keep using the previous version's path. Run `/reload-plugins` to switch hooks, MCP servers, and LSP servers to the new path; monitors require a session restart.

MCP servers can also call the `roots/list` request to read the session's working directories at runtime. See [what `roots/list` returns and when Claude Code notifies the server of changes](/docs/en/mcp#option-3-add-a-local-stdio-server).

#### Persistent data directory

The `${CLAUDE_PLUGIN_DATA}` directory resolves to `~/.claude/plugins/data/{id}/`, where `{id}` is the plugin identifier with characters outside `a-z`, `A-Z`, `0-9`, `_`, and `-` replaced by `-`. For a plugin installed as `formatter@my-marketplace`, the directory is `~/.claude/plugins/data/formatter-my-marketplace/`.

A common use is installing language dependencies once and reusing them across sessions and plugin updates. Because the data directory outlives any single plugin version, a check for directory existence alone cannot detect when an update changes the plugin's dependency manifest. The recommended pattern compares the bundled manifest against a copy in the data directory and reinstalls when they differ.

This `SessionStart` hook installs `node_modules` on the first run and again whenever a plugin update includes a changed `package.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "diff -q \"${CLAUDE_PLUGIN_ROOT}/package.json\" \"${CLAUDE_PLUGIN_DATA}/package.json\" >/dev/null 2>&1 || (cd \"${CLAUDE_PLUGIN_DATA}\" && cp \"${CLAUDE_PLUGIN_ROOT}/package.json\" . && npm install) || rm -f \"${CLAUDE_PLUGIN_DATA}/package.json\""
          }
        ]
      }
    ]
  }
}
```

The `diff` exits nonzero when the stored copy is missing or differs from the bundled one, covering both first run and dependency-changing updates. If `npm install` fails, the trailing `rm` removes the copied manifest so the next session retries.

Scripts bundled in `${CLAUDE_PLUGIN_ROOT}` can then run against the persisted `node_modules`:

```json
{
  "mcpServers": {
    "routines": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/server.js"],
      "env": {
        "NODE_PATH": "${CLAUDE_PLUGIN_DATA}/node_modules"
      }
    }
  }
}
```

The data directory is deleted automatically when you uninstall the plugin from the last scope where it is installed. The `/plugin` interface shows the directory size and prompts before deleting. The CLI deletes by default; pass [`--keep-data`](#plugin-uninstall) to preserve it.

---

