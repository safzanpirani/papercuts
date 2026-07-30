#!/usr/bin/env bun
import { sep } from "node:path";
import {
  bumpPapercut,
  CANONICAL_TAGS,
  canonicalTag,
  findSimilar,
  findProjectRoot,
  normalizeAbout,
  normalizeTags,
  readGlobalEntries,
  recordPapercut,
  resolveLogFile,
  resolvePapercut,
  suggestTag,
  type Papercut,
} from "./core.ts";

const HELP = `papercuts — log the tiny frustrations agents hit while working

Usage:
  papercuts [options] <message...>
  papercuts add [options] <message...>
  papercuts list [list options]
  papercuts top [tag|about|project|agent|model] [list options]
  papercuts resolve <id> [--note <text>]
  papercuts bump <id>
  papercuts tags
  papercuts path [--file <path>]

Options:
  -a, --agent <name>      agent runtime responsible for the entry
  -m, --model <model-id>  exact model ID responsible for the entry
  -b, --about <subject>   what the friction is about (tool/CLI/service), not where
  -t, --tag <tag>         categorize the entry (repeatable, comma-separated ok)
  -f, --file <path>       override PAPERCUTS.md destination
      --note <text>       resolution note (with \`resolve\`)
      --json              print JSON instead of text
  -h, --help              show this help

List options:
      --all               entries from every project, not just this one
      --open              only unresolved entries (default for \`list\`)
      --resolved          only resolved entries
      --any-status        both open and resolved
  -n, --limit <n>         show at most n entries (default 20, 0 for all)
      --since <date>      only entries at or after this date/time
  -a, -m, -t, -b          filter by agent, model, tag, or subject

Entries go to PAPERCUTS.md at the enclosing Git root (or the current directory
outside a Git project) and are mirrored to ~/.papercuts/global.jsonl, which
\`list\`, \`top\`, \`resolve\`, and \`bump\` read. Map a subject to the repo that owns
it in ~/.papercuts/subjects.json ({"fleet": "/path/to/fleet"}) and --about also
files the entry there. PAPERCUTS_AGENT, PAPERCUTS_MODEL_ID, PAPERCUTS_FILE, and
PAPERCUTS_GLOBAL_FILE (set to "off" to disable the mirror) override defaults.`;

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

type Command = "add" | "path" | "list" | "top" | "resolve" | "bump" | "tags" | "help";
type StatusFilter = "open" | "resolved" | "any";

interface ParsedArgs {
  command: Command;
  message: string;
  agent?: string;
  modelId?: string;
  about?: string;
  tags: string[];
  file?: string;
  note?: string;
  json: boolean;
  all: boolean;
  status?: StatusFilter;
  limit?: number;
  since?: string;
  positionals: string[];
}

const COMMANDS = new Set(["add", "path", "list", "top", "resolve", "bump", "tags", "help"]);

function parseArgs(argv: string[]): ParsedArgs {
  const args = [...argv];
  const parsed: ParsedArgs = {
    command: "add",
    message: "",
    tags: [],
    json: false,
    all: false,
    positionals: [],
  };
  const message: string[] = [];

  if (args[0] && COMMANDS.has(args[0])) parsed.command = args.shift() as Command;
  if (parsed.command === "help") return parsed;

  let positionalOnly = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (positionalOnly) {
      message.push(arg);
      continue;
    }
    if (arg === "--") {
      positionalOnly = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") return { ...parsed, command: "help", message: "" };
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--all") {
      parsed.all = true;
      continue;
    }
    if (arg === "--open" || arg === "--resolved") {
      parsed.status = arg === "--open" ? "open" : "resolved";
      continue;
    }
    if (arg === "--any-status") {
      parsed.status = "any";
      continue;
    }
    if (arg === "-a" || arg === "--agent") {
      parsed.agent = args[++index] ?? fail(`${arg} requires a value`);
      continue;
    }
    if (arg === "-m" || arg === "--model") {
      parsed.modelId = args[++index] ?? fail(`${arg} requires a value`);
      continue;
    }
    if (arg === "-b" || arg === "--about") {
      parsed.about = args[++index] ?? fail(`${arg} requires a value`);
      continue;
    }
    if (arg === "--note") {
      parsed.note = args[++index] ?? fail(`${arg} requires a value`);
      continue;
    }
    if (arg === "-t" || arg === "--tag") {
      const value = args[++index] ?? fail(`${arg} requires a value`);
      parsed.tags.push(...value.split(",").map((tag) => tag.trim()).filter(Boolean));
      continue;
    }
    if (arg === "-f" || arg === "--file") {
      parsed.file = args[++index] ?? fail(`${arg} requires a value`);
      continue;
    }
    if (arg === "-n" || arg === "--limit") {
      const value = args[++index] ?? fail(`${arg} requires a value`);
      parsed.limit = Number.parseInt(value, 10);
      if (Number.isNaN(parsed.limit) || parsed.limit < 0) fail(`invalid ${arg} value: ${value}`);
      continue;
    }
    if (arg === "--since") {
      parsed.since = args[++index] ?? fail(`${arg} requires a value`);
      continue;
    }
    if (arg.startsWith("-")) fail(`unknown option: ${arg}`);
    message.push(arg);
    parsed.positionals.push(arg);
  }

  parsed.message = message.join(" ").trim();
  return parsed;
}

async function readPipedMessage(): Promise<string> {
  if (process.stdin.isTTY) return "";
  return (await Bun.stdin.text()).trim();
}

function matchesFilters(entry: Papercut, parsed: ParsedArgs, projectRoot: string, since?: Date): boolean {
  if (!parsed.all && entry.directory !== projectRoot && !entry.directory.startsWith(projectRoot + sep)) {
    return false;
  }
  const status = parsed.status ?? "open";
  if (status !== "any" && entry.status !== status) return false;
  if (parsed.agent && entry.agent !== parsed.agent) return false;
  if (parsed.modelId && entry.modelId !== parsed.modelId) return false;
  if (parsed.about && entry.about !== normalizeAbout(parsed.about)) return false;
  if (parsed.tags.length) {
    const wanted = parsed.tags.map(canonicalTag);
    const owned = entry.tags.map(canonicalTag);
    if (!wanted.every((tag) => owned.includes(tag))) return false;
  }
  if (since && new Date(entry.timestamp) < since) return false;
  return true;
}

async function selectEntries(parsed: ParsedArgs): Promise<Papercut[]> {
  let since: Date | undefined;
  if (parsed.since) {
    since = new Date(parsed.since);
    if (Number.isNaN(since.getTime())) fail(`invalid --since date: ${parsed.since}`);
  }
  const projectRoot = findProjectRoot(process.cwd());
  return (await readGlobalEntries())
    .filter((entry) => matchesFilters(entry, parsed, projectRoot, since))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function describe(entry: Papercut): string {
  const bits = [entry.about ? `about:${entry.about}` : undefined, ...entry.tags].filter(Boolean);
  const meta = bits.length ? `  [${bits.join(", ")}]` : "";
  const seen = entry.occurrences > 1 ? `  ×${entry.occurrences}` : "";
  const state = entry.status === "resolved" ? "  ✓resolved" : "";
  return [
    `${entry.id}  ${entry.timestamp}  ${entry.agent} — ${entry.modelId}${meta}${seen}${state}`,
    `  ${entry.directory}`,
    `  ${entry.message.replace(/\s+/g, " ").trim()}`,
    "",
  ].join("\n");
}

async function runList(parsed: ParsedArgs): Promise<void> {
  const entries = await selectEntries(parsed);
  const limit = parsed.limit ?? 20;
  const shown = limit > 0 ? entries.slice(-limit) : entries;

  if (parsed.json) {
    console.log(JSON.stringify(shown, null, 2));
    return;
  }
  if (!shown.length) {
    const scope = parsed.all ? "" : " for this project (try --all)";
    console.log(`No ${parsed.status === "resolved" ? "resolved" : "open"} papercuts${scope}.`);
    return;
  }
  for (const entry of shown) console.log(describe(entry));
  if (entries.length > shown.length) {
    console.log(`(showing ${shown.length} of ${entries.length}; use --limit 0 for all)`);
  }
}

const GROUPERS: Record<string, (entry: Papercut) => string[]> = {
  tag: (entry) => (entry.tags.length ? entry.tags.map(canonicalTag) : ["(untagged)"]),
  about: (entry) => [entry.about ?? "(unset)"],
  project: (entry) => [entry.directory],
  agent: (entry) => [entry.agent],
  // Group Claude's [1m] context variants with their base model.
  model: (entry) => [entry.modelId.replace(/\[[^\]]*\]$/, "")],
};

async function runTop(parsed: ParsedArgs): Promise<void> {
  const dimension = parsed.positionals[0] ?? "tag";
  const group = GROUPERS[dimension] ?? fail(`unknown group: ${dimension} (tag|about|project|agent|model)`);
  const entries = await selectEntries(parsed);

  const counts = new Map<string, { entries: number; hits: number }>();
  for (const entry of entries) {
    for (const key of group(entry)) {
      const bucket = counts.get(key) ?? { entries: 0, hits: 0 };
      bucket.entries += 1;
      bucket.hits += entry.occurrences;
      counts.set(key, bucket);
    }
  }

  const ranked = [...counts.entries()].sort((a, b) => b[1].hits - a[1].hits || a[0].localeCompare(b[0]));
  const limit = parsed.limit ?? 20;
  const shown = limit > 0 ? ranked.slice(0, limit) : ranked;

  if (parsed.json) {
    console.log(JSON.stringify(shown.map(([key, value]) => ({ [dimension]: key, ...value })), null, 2));
    return;
  }
  if (!shown.length) {
    console.log("No papercuts match.");
    return;
  }
  const width = Math.max(...shown.map(([key]) => key.length));
  console.log(`${dimension.padEnd(width)}  entries  hits`);
  for (const [key, value] of shown) {
    console.log(`${key.padEnd(width)}  ${String(value.entries).padStart(7)}  ${String(value.hits).padStart(4)}`);
  }
}

async function runTags(parsed: ParsedArgs): Promise<void> {
  const used = new Map<string, number>();
  for (const entry of await readGlobalEntries()) {
    for (const tag of entry.tags.map(canonicalTag)) used.set(tag, (used.get(tag) ?? 0) + 1);
  }
  if (parsed.json) {
    console.log(JSON.stringify({ canonical: CANONICAL_TAGS, used: Object.fromEntries(used) }, null, 2));
    return;
  }
  console.log("Canonical tags (reuse these; anything else is a one-off):");
  for (const tag of CANONICAL_TAGS) {
    const count = used.get(tag) ?? 0;
    console.log(`  ${tag.padEnd(18)}${count ? `${count} logged` : ""}`);
  }
  const extra = [...used.keys()].filter((tag) => !(CANONICAL_TAGS as readonly string[]).includes(tag));
  if (extra.length) console.log(`\nNon-canonical tags in the log: ${extra.sort().join(", ")}`);
}

async function runAdd(parsed: ParsedArgs): Promise<void> {
  const message = parsed.message || (await readPipedMessage());
  if (!message) fail("provide a message (see `papercuts --help`)");

  const { unknown } = normalizeTags(parsed.tags);
  for (const tag of unknown) {
    const suggestion = suggestTag(tag);
    console.error(
      `! non-canonical tag \`${tag}\`${suggestion ? ` — did you mean \`${suggestion}\`?` : ""} (see \`papercuts tags\`)`,
    );
  }

  const about = parsed.about ? normalizeAbout(parsed.about) : undefined;
  const similar = findSimilar(
    (await readGlobalEntries()).filter((entry) => entry.status === "open"),
    { message, about },
  );

  const entry = await recordPapercut({
    message,
    agent: parsed.agent,
    modelId: parsed.modelId,
    about,
    tags: parsed.tags,
    file: parsed.file,
  });

  if (parsed.json) {
    console.log(JSON.stringify({ ...entry, similarTo: similar?.entry.id }, null, 2));
    return;
  }
  console.log(`✓ Logged papercut ${entry.id} → ${entry.file}`);
  if (similar) {
    console.log(
      `↺ Similar open papercut ${similar.entry.id} (×${similar.entry.occurrences}, ${Math.round(similar.score * 100)}% overlap):`,
    );
    console.log(`  ${similar.entry.message.replace(/\s+/g, " ").trim().slice(0, 160)}`);
    console.log(`  Same friction? \`papercuts bump ${similar.entry.id}\` counts it instead of duplicating.`);
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  switch (parsed.command) {
    case "help":
      console.log(HELP);
      return;
    case "path":
      console.log(resolveLogFile(process.cwd(), parsed.file));
      return;
    case "list":
      await runList(parsed);
      return;
    case "top":
      await runTop(parsed);
      return;
    case "tags":
      await runTags(parsed);
      return;
    case "resolve": {
      const id = parsed.positionals[0] ?? fail("resolve requires a papercut ID");
      const entry = await resolvePapercut(id, { note: parsed.note });
      console.log(parsed.json ? JSON.stringify(entry, null, 2) : `✓ Resolved ${entry.id} (${entry.file})`);
      return;
    }
    case "bump": {
      const id = parsed.positionals[0] ?? fail("bump requires a papercut ID");
      const entry = await bumpPapercut(id);
      console.log(
        parsed.json ? JSON.stringify(entry, null, 2) : `✓ Bumped ${entry.id} to ×${entry.occurrences}`,
      );
      return;
    }
    case "add":
      await runAdd(parsed);
      return;
  }
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
