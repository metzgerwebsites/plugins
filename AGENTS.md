# plugins — harness-agnostic plugin marketplace

This repository is a fork of [cursor/plugins](https://github.com/cursor/plugins) that publishes the same plugins to every agent harness. The upstream content — `.cursor-plugin/marketplace.json` and the per-plugin directories — is the single source of truth. Every other root file is generated from it.

## What is generated (do not edit by hand)

- `.claude-plugin/` — Claude Code marketplace and per-plugin manifests
- `.agents/plugins/marketplace.json` — Codex native marketplace
- `.factory-plugin/marketplace.json` — Droid (Factory) marketplace
- `skills/` — aggregate of every plugin skill, in the neutral Agent Skills format
- `plugin.json` — root bundle manifest for Agent Plugins clients (Goose)
- `gemini-extension.json` — Gemini CLI extension manifest
- `<plugin>/.claude-plugin/plugin.json`, `<plugin>/.mcp.json`, `<plugin>/plugin.json` — per-plugin generated files

## Working on this repository

1. Edit upstream content only: plugin directories and `.cursor-plugin/marketplace.json`.
2. Regenerate: `node scripts/generate-agent-marketplace.mjs`.
3. Verify: `node scripts/generate-agent-marketplace.mjs --check` and `node scripts/validate-plugins.mjs`.
4. CI runs the same checks on every push to `agent-marketplace`.

## Using the marketplace

Install and registration commands for every harness are in `README.md` under "Use with other agents".
