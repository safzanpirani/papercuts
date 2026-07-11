#!/usr/bin/env bun
import { sep } from "node:path";
import {
  findProjectRoot,
  readGlobalEntries,
  recordPapercut,
  resolveLogFile,
  type Papercut,
} from "./core.ts";

const HELP = `papercuts — log the tiny frustrations agents hit while working

Usage:
  papercuts [options] <message...>
  papercuts add [options] <message...>
  papercuts list [list options]
  papercuts path [--file <path>]

Options:
  -a, --agent <name>      agent runtime responsible for the entry
  -m, --model <model-id>  exact model ID responsible for the entry
  -t, --tag <tag>         categorize the entry (repeatable, comma-separated ok)
  -f, --file <path>       override PAPERCUTS.md destination
      --json              print JSON instead of text
  -h, --help              show this help

List options:
      --all               entries from every project, not just this one
  -n, --limit <n>         show at most n entries (default 20, 0 for all)
      --since <date>      only entries at or after this date/time
  -a, -m, -t              filter by agent, model, or tag

Entries go to PAPERCUTS.md at the enclosing Git root (or the current directory
outside a Git project) and are mirrored to ~/.papercuts/global.jsonl, which
\`list\` reads. PAPERCUTS_AGENT, PAPERCUTS_MODEL_ID, PAPERCUTS_FILE, and
PAPERCUTS_GLOBAL_FILE (set to "off" to disable the mirror) override defaults.`;

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

interface ParsedArgs {
  command: "add" | "path" | "list" | "help";
  message: string;
  agent?: string;
  modelId?: string;
  tags: string[];
  file?: string;
  json: boolean;
  all: boolean;
  limit?: number;
  since?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = [...argv];
  const parsed: ParsedArgs = { command: "add", message: "", tags: [], json: false, all: false };
  const message: string[] = [];

  if (args[0] === "add" || args[0] === "path" || args[0] === "list") {
    parsed.command = args.shift() as "add" | "path" | "list";
  } else if (args[0] === "help") {
    return { ...parsed, command: "help" };
  }

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
    if (arg === "-a" || arg === "--agent") {
      parsed.agent = args[++index] ?? fail(`${arg} requires a value`);
      continue;
    }
    if (arg === "-m" || arg === "--model") {
      parsed.modelId = args[++index] ?? fail(`${arg} requires a value`);
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
  if (parsed.agent && entry.agent !== parsed.agent) return false;
  if (parsed.modelId && entry.modelId !== parsed.modelId) return false;
  if (parsed.tags.length && !parsed.tags.every((tag) => entry.tags.includes(tag))) return false;
  if (since && new Date(entry.timestamp) < since) return false;
  return true;
}

async function runList(parsed: ParsedArgs): Promise<void> {
  let since: Date | undefined;
  if (parsed.since) {
    since = new Date(parsed.since);
    if (Number.isNaN(since.getTime())) fail(`invalid --since date: ${parsed.since}`);
  }

  const projectRoot = findProjectRoot(process.cwd());
  const entries = (await readGlobalEntries())
    .filter((entry) => matchesFilters(entry, parsed, projectRoot, since))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const limit = parsed.limit ?? 20;
  const shown = limit > 0 ? entries.slice(-limit) : entries;

  if (parsed.json) {
    console.log(JSON.stringify(shown, null, 2));
    return;
  }
  if (!shown.length) {
    console.log(parsed.all ? "No papercuts recorded yet." : "No papercuts recorded for this project (try --all).");
    return;
  }
  for (const entry of shown) {
    const tags = entry.tags.length ? `  [${entry.tags.join(", ")}]` : "";
    console.log(`${entry.timestamp}  ${entry.agent} — ${entry.modelId}${tags}`);
    console.log(`  ${entry.directory}`);
    console.log(`  ${entry.message.replace(/\s+/g, " ").trim()}`);
    console.log("");
  }
  if (entries.length > shown.length) {
    console.log(`(showing ${shown.length} of ${entries.length}; use --limit 0 for all)`);
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.command === "help") {
    console.log(HELP);
    return;
  }
  if (parsed.command === "path") {
    console.log(resolveLogFile(process.cwd(), parsed.file));
    return;
  }
  if (parsed.command === "list") {
    await runList(parsed);
    return;
  }

  const message = parsed.message || (await readPipedMessage());
  if (!message) fail("provide a message (see `papercuts --help`)");

  const entry = await recordPapercut({
    message,
    agent: parsed.agent,
    modelId: parsed.modelId,
    tags: parsed.tags,
    file: parsed.file,
  });
  if (parsed.json) console.log(JSON.stringify(entry, null, 2));
  else console.log(`✓ Logged papercut → ${entry.file}`);
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
