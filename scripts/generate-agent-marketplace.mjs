#!/usr/bin/env node

// Generates the cross-agent layer on top of the Cursor marketplace.
//
// .cursor-plugin/marketplace.json is the source of truth. From it, this script
// generates or verifies the files that other agents read:
//
//   plugin.json                      portable Agent Plugins manifest, per plugin
//   .claude-plugin/plugin.json       Claude Code plugin manifest, per plugin
//   .mcp.json                        Claude Code MCP config, copied from mcp.json, per plugin
//   .claude-plugin/marketplace.json  Claude Code marketplace (Codex and Qwen read it too)
//   .agents/plugins/marketplace.json Codex native marketplace
//   .factory-plugin/marketplace.json Droid (Factory) marketplace
//   skills/                          aggregate of every plugin skill, real copies (goose installs from here)
//   plugin.json                      whole-repo bundle manifest for goose and other Agent Plugins clients
//   gemini-extension.json            Gemini CLI extension manifest
//
// pstack installs in Claude Code from harness/pstack/claude-code, the tree that
// scripts/generate-pstack-harness-trees.mjs keeps in sync, so its Claude manifest
// is generated there and not in pstack/.
//
// Usage:
//   node scripts/generate-agent-marketplace.mjs          # write files
//   node scripts/generate-agent-marketplace.mjs --check  # verify committed output, exit 1 on drift

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMMAND = "node scripts/generate-agent-marketplace.mjs";
const NAME = "cursor-plugins";
const DISPLAY_NAME = "Cursor Plugins";
const BUNDLE_VERSION = "1.0.0";
const CLAUDE_SOURCES = { pstack: "./harness/pstack/claude-code" };

function readJSON(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    if (name === ".DS_Store" || name === "node_modules") return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function file(path) {
  return { bytes: readFileSync(path), executable: (statSync(path).mode & 0o111) !== 0 };
}

const cursor = readJSON(join(ROOT, ".cursor-plugin/marketplace.json"));

const plugins = cursor.plugins.map((entry) => {
  const manifest = readJSON(join(ROOT, entry.source, ".cursor-plugin/plugin.json"));
  return { entry, manifest };
});

function category(manifest) {
  const raw = manifest.category ?? "productivity";
  return raw
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

const outputs = new Map();
function put(path, bytes, executable = false) {
  outputs.set(path, { bytes: Buffer.from(bytes), executable });
}
function putJSON(path, value) {
  put(path, `${JSON.stringify(value, null, 2)}\n`);
}

// Files that already exist upstream and are kept as hand-written: verified instead of generated.
const pinned = [];
const problems = [];

for (const { entry, manifest } of plugins) {
  const dir = entry.source;
  const hasSkills = existsSync(join(ROOT, dir, "skills"));
  const hasMCP = existsSync(join(ROOT, dir, "mcp.json"));

  const portablePath = `${dir}/plugin.json`;
  if (existsSync(join(ROOT, portablePath))) {
    pinned.push({ path: portablePath, manifest, existing: readJSON(join(ROOT, portablePath)) });
  } else {
    putJSON(portablePath, {
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      author: manifest.author,
      homepage: manifest.homepage,
      repository: manifest.repository,
      license: manifest.license,
      keywords: manifest.keywords,
    });
  }

  if (!CLAUDE_SOURCES[manifest.name]) {
    const claudePath = `${dir}/.claude-plugin/plugin.json`;
    if (existsSync(join(ROOT, claudePath))) {
      pinned.push({ path: claudePath, manifest, existing: readJSON(join(ROOT, claudePath)) });
    } else {
      putJSON(claudePath, {
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        author: manifest.author,
        homepage: manifest.homepage,
        repository: manifest.repository,
        license: manifest.license,
        keywords: manifest.keywords,
        ...(hasSkills ? { skills: "./skills/" } : {}),
      });
    }
  }

  if (hasMCP) put(`${dir}/.mcp.json`, readFileSync(join(ROOT, dir, "mcp.json")));
}

for (const { path, manifest, existing } of pinned) {
  if (existing.name !== manifest.name || existing.version !== manifest.version) {
    problems.push(
      `${path} says name ${JSON.stringify(existing.name)} version ${JSON.stringify(existing.version)}, ` +
        `expected ${JSON.stringify(manifest.name)} version ${JSON.stringify(manifest.version)}`
    );
  }
}

const description = cursor.metadata?.description ?? "Cursor plugin marketplace";

putJSON(".claude-plugin/marketplace.json", {
  name: NAME,
  owner: cursor.owner,
  metadata: { description },
  plugins: plugins.map(({ entry, manifest }) => ({
    name: manifest.name,
    source: CLAUDE_SOURCES[manifest.name] ?? `./${entry.source}`,
    description: entry.description ?? manifest.description,
  })),
});

putJSON(".agents/plugins/marketplace.json", {
  name: NAME,
  interface: { displayName: DISPLAY_NAME },
  plugins: plugins.map(({ entry, manifest }) => ({
    name: manifest.name,
    source: { source: "local", path: `./${entry.source}` },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    category: category(manifest),
  })),
});

putJSON(".factory-plugin/marketplace.json", {
  name: NAME,
  description,
  owner: cursor.owner,
  plugins: plugins.map(({ entry, manifest }) => ({
    name: manifest.name,
    description: entry.description ?? manifest.description,
    source: `./${entry.source}`,
    category: category(manifest),
  })),
});

// The aggregate root skills/ tree: one copy per skill name. Two plugins may offer
// the same skill name; the larger copy wins, so the richer variant survives, and
// ties keep the earlier marketplace entry.
const skills = new Map();
const collisions = [];
for (const { entry } of plugins) {
  const dir = join(ROOT, entry.source, "skills");
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir)) {
    const skillDir = join(dir, name);
    if (!statSync(skillDir).isDirectory()) continue;
    const files = new Map(walk(skillDir).map((path) => [relative(skillDir, path), file(path)]));
    const size = [...files.values()].reduce((total, { bytes }) => total + bytes.length, 0);
    const current = skills.get(name);
    if (current && size <= current.size) {
      collisions.push(`${name}: kept ${current.from}, dropped ${entry.name}`);
      continue;
    }
    if (current) collisions.push(`${name}: kept ${entry.name}, dropped ${current.from}`);
    skills.set(name, { from: entry.name, files, size });
  }
}
for (const [name, { files }] of skills) {
  for (const [path, { bytes, executable }] of files) {
    put(`skills/${name}/${path}`, bytes, executable);
  }
}

putJSON("plugin.json", {
  $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  name: NAME,
  version: BUNDLE_VERSION,
  description: `${description}, bundled for agents that install a repository as a single plugin.`,
  author: cursor.owner,
  homepage: "https://github.com/cursor/plugins",
  repository: "https://github.com/cursor/plugins",
  license: "MIT",
  keywords: ["cursor", "plugins", "marketplace", "skills"],
});

putJSON("gemini-extension.json", {
  name: NAME,
  version: BUNDLE_VERSION,
  description,
});

if (problems.length > 0) {
  for (const problem of problems) console.log(`FAIL ${problem}`);
  process.exit(1);
}

const summary =
  `${plugins.length} plugins, ${skills.size} aggregate skills, ` +
  `${plugins.filter(({ entry }) => existsSync(join(ROOT, entry.source, "mcp.json"))).length} MCP configs`;
for (const collision of collisions) console.log(`note ${collision}`);

if (process.argv.includes("--check")) {
  const drifted = [];
  for (const [path, want] of outputs) {
    const full = join(ROOT, path);
    const have = existsSync(full) ? file(full) : undefined;
    if (!have || !have.bytes.equals(want.bytes) || have.executable !== want.executable) drifted.push(path);
  }
  if (existsSync(join(ROOT, "skills"))) {
    for (const full of walk(join(ROOT, "skills"))) {
      const path = relative(ROOT, full);
      if (!outputs.has(path)) drifted.push(`${path} (not generated)`);
    }
  }
  for (const path of drifted.slice(0, 20)) console.log(path);
  if (drifted.length > 0) {
    console.log(`Cross-agent marketplace files are out of date. Run \`${COMMAND}\` and commit the result.`);
    process.exit(1);
  }
  console.log(`${summary}. All cross-agent marketplace files are up to date.`);
} else {
  const skillsRoot = join(ROOT, "skills");
  if (existsSync(skillsRoot)) {
    for (const full of walk(skillsRoot)) {
      if (!outputs.has(relative(ROOT, full))) rmSync(full);
    }
    const dirs = (function collect(dir) {
      return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? [path, ...collect(path)] : [];
      });
    })(skillsRoot);
    for (const dir of dirs.sort((a, b) => b.length - a.length)) {
      if (readdirSync(dir).length === 0) rmSync(dir);
    }
  }
  for (const [path, { bytes, executable }] of outputs) {
    mkdirSync(dirname(join(ROOT, path)), { recursive: true });
    writeFileSync(join(ROOT, path), bytes);
    chmodSync(join(ROOT, path), executable ? 0o755 : 0o644);
  }
  console.log(summary);
}
