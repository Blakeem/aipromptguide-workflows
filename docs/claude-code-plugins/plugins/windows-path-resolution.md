Source: https://code.claude.com/docs/en/claude-directory (sections: intro paragraph, "What's not shown", "Application data" closing note)
Version: Claude Code docs (current as of retrieval)
Retrieved: 2026-08-01

---

# Explore the .claude directory

> Where Claude Code reads CLAUDE.md, settings.json, hooks, skills, commands, subagents, workflows, rules, and auto memory. Explore the .claude directory in your project and ~/.claude in your home directory.

Claude Code reads instructions, settings, skills, subagents, and memory from your project directory and from `~/.claude` in your home directory. Commit project files to git to share them with your team; files in `~/.claude` are personal configuration that applies across all your projects.

On Windows, `~/.claude` resolves to `%USERPROFILE%\.claude`. If you set [`CLAUDE_CONFIG_DIR`](/docs/en/env-vars), every `~/.claude` path on this page lives under that directory instead.

Most users only edit `CLAUDE.md` and `settings.json`. The rest of the directory is optional: add skills, rules, or subagents as you need them.

## What's not shown

The explorer covers files you author and edit. A few related files live elsewhere:

| File                    | Location                   | Purpose                                                                                                                                                                                                                                                             |
| ----------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `managed-settings.json` | System-level, varies by OS | Enterprise-enforced settings that you can't override. See [server-managed settings](/docs/en/server-managed-settings).                                                                                                                                                   |
| `CLAUDE.local.md`       | Project root               | Your private preferences for this project, loaded alongside CLAUDE.md. Create it manually and add it to `.gitignore`.                                                                                                                                               |
| Installed plugins       | `~/.claude/plugins`        | Cloned marketplaces, installed plugin versions, and per-plugin data, managed by `claude plugin` commands. Orphaned versions are deleted 14 days after a plugin update or uninstall. See [plugin caching](/docs/en/plugins-reference#plugin-caching-and-file-resolution). |

`~/.claude` also holds data Claude Code writes as you work: transcripts, prompt history, file snapshots, caches, and logs. See [application data](#application-data) below.

## Application data (closing note)

Don't delete `~/.claude.json`, `~/.claude/settings.json`, or `~/.claude/plugins/`: those hold your auth, preferences, and installed plugins.
