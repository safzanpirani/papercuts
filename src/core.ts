import { appendFile, mkdir, open, readdir, readFile, stat } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";

export const LOG_NAME = "PAPERCUTS.md";

const HEADER = `# PAPERCUTS

Small, non-blocking frictions encountered by agents while working. Review this file periodically and sand them down.

`;

export interface Papercut {
  timestamp: string;
  agent: string;
  modelId: string;
  directory: string;
  message: string;
  tags: string[];
  file: string;
}

/** Find the enclosing Git project without requiring the git executable. */
export function findProjectRoot(start: string): string {
  let current = resolve(start);
  const filesystemRoot = parse(current).root;

  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    if (current === filesystemRoot) return resolve(start);
    current = dirname(current);
  }
}

/** Prefer an explicit name, then agent-specific session markers. */
export function detectAgent(
  environment: NodeJS.ProcessEnv = process.env,
  explicit?: string,
): string {
  const requested = explicit?.trim() || environment.PAPERCUTS_AGENT?.trim();
  if (requested) return requested;

  if (environment.CODEX_THREAD_ID || environment.CODEX_CI) return "codex";
  if (environment.CLAUDECODE || environment.CLAUDE_CODE_ENTRYPOINT) return "claude-code";
  if (environment.CURSOR_TRACE_ID || environment.CURSOR_AGENT) return "cursor";
  if (environment.FACTORY_AGENT || environment.DROID_SESSION_ID) return "factory-droid";
  if (environment.PI_AGENT || environment.PI_SESSION_ID) return "pi";
  if (environment.OPENCODE_SESSION_ID) return "opencode";
  if (environment.GEMINI_CLI) return "gemini-cli";

  return "unknown-agent";
}

async function directoryEntriesNewestFirst(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory)).sort().reverse();
  } catch {
    return [];
  }
}

async function lastJsonLineValue(
  file: string,
  marker: string,
  extract: (record: unknown) => string | undefined,
): Promise<string | undefined> {
  const lines = createInterface({
    input: createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let value: string | undefined;
  for await (const line of lines) {
    if (!line.includes(marker)) continue;
    try {
      const extracted = extract(JSON.parse(line));
      if (extracted?.trim()) value = extracted.trim();
    } catch {
      // Ignore an incomplete line if the active session is being written.
    }
  }
  return value;
}

async function modelFromCodexSession(environment: NodeJS.ProcessEnv): Promise<string | undefined> {
  const threadId = environment.CODEX_THREAD_ID?.trim();
  if (!threadId) return undefined;

  const codexHome = environment.CODEX_HOME?.trim() || join(environment.HOME?.trim() || homedir(), ".codex");
  const sessions = join(codexHome, "sessions");

  // Sessions are date-partitioned (YYYY/MM/DD); walk newest-first and stop at
  // the first rollout for this thread instead of globbing the whole tree.
  for (const year of await directoryEntriesNewestFirst(sessions)) {
    for (const month of await directoryEntriesNewestFirst(join(sessions, year))) {
      for (const day of await directoryEntriesNewestFirst(join(sessions, year, month))) {
        const dayDirectory = join(sessions, year, month, day);
        for (const name of await directoryEntriesNewestFirst(dayDirectory)) {
          if (!name.startsWith("rollout-") || !name.endsWith(`${threadId}.jsonl`)) continue;
          const model = await lastJsonLineValue(
            join(dayDirectory, name),
            '"type":"turn_context"',
            (record) => (record as { payload?: { model?: unknown } }).payload?.model as string | undefined,
          );
          if (model) return model;
        }
      }
    }
  }

  return undefined;
}

function claudeProjectSlug(directory: string): string {
  return directory.replace(/[^a-zA-Z0-9]/g, "-");
}

async function modelFromClaudeSession(
  environment: NodeJS.ProcessEnv,
  directory: string,
): Promise<string | undefined> {
  if (!environment.CLAUDECODE && !environment.CLAUDE_CODE_ENTRYPOINT) return undefined;

  const configDirectory =
    environment.CLAUDE_CONFIG_DIR?.trim() || join(environment.HOME?.trim() || homedir(), ".claude");
  const candidates = [...new Set([resolve(directory), findProjectRoot(directory)])];

  const transcripts: { file: string; modifiedMs: number }[] = [];
  for (const candidate of candidates) {
    const projectDirectory = join(configDirectory, "projects", claudeProjectSlug(candidate));
    for (const name of await directoryEntriesNewestFirst(projectDirectory)) {
      if (!name.endsWith(".jsonl")) continue;
      const file = join(projectDirectory, name);
      try {
        transcripts.push({ file, modifiedMs: (await stat(file)).mtimeMs });
      } catch {
        // A transcript can disappear between listing and stat; skip it.
      }
    }
  }
  transcripts.sort((a, b) => b.modifiedMs - a.modifiedMs);

  for (const transcript of transcripts) {
    const model = await lastJsonLineValue(transcript.file, '"model":', (record) => {
      const value = (record as { message?: { model?: unknown } }).message?.model;
      return typeof value === "string" && value !== "<synthetic>" ? value : undefined;
    });
    if (model) return model;
  }

  return undefined;
}

/** Resolve the exact model ID from an override, runtime environment, or active agent session. */
export async function detectModelId(
  environment: NodeJS.ProcessEnv = process.env,
  explicit?: string,
  directory: string = process.cwd(),
): Promise<string> {
  const configured = [
    explicit,
    environment.PAPERCUTS_MODEL_ID,
    environment.CODEX_MODEL,
    environment.CLAUDE_CODE_MODEL,
    environment.ANTHROPIC_MODEL,
    environment.CURSOR_MODEL,
    environment.OPENCODE_MODEL,
    environment.GEMINI_MODEL,
  ].find((value) => value?.trim());
  if (configured) return configured.trim();

  return (
    (await modelFromCodexSession(environment)) ??
    (await modelFromClaudeSession(environment, directory)) ??
    "unknown-model"
  );
}

export function resolveLogFile(
  directory: string,
  explicitFile?: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = explicitFile?.trim() || environment.PAPERCUTS_FILE?.trim();
  return configured ? resolve(directory, configured) : join(findProjectRoot(directory), LOG_NAME);
}

/** Cross-project JSONL mirror; set PAPERCUTS_GLOBAL_FILE=off to disable. */
export function resolveGlobalFile(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = environment.PAPERCUTS_GLOBAL_FILE?.trim();
  if (configured) {
    const lowered = configured.toLowerCase();
    if (lowered === "0" || lowered === "off" || lowered === "none") return undefined;
    return resolve(configured);
  }
  return join(environment.HOME?.trim() || homedir(), ".papercuts", "global.jsonl");
}

export async function readGlobalEntries(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Papercut[]> {
  const globalFile = resolveGlobalFile(environment);
  if (!globalFile) return [];

  let content: string;
  try {
    content = await readFile(globalFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const entries: Papercut[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as Papercut;
      if (typeof record.timestamp !== "string" || typeof record.message !== "string") continue;
      entries.push({ ...record, tags: Array.isArray(record.tags) ? record.tags : [] });
    } catch {
      // Skip a torn line from a concurrent write.
    }
  }
  return entries;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function inlineCode(value: string): string {
  return `\`${value.replaceAll("`", "\\`")}\``;
}

/** Escape line-leading '#' so a message can never introduce a new section heading. */
function sanitizeMessage(message: string): string {
  return message.trim().replace(/^(\s{0,3})#/gm, "$1\\#");
}

export function formatEntry(entry: Omit<Papercut, "file">): string {
  const tags = entry.tags.length
    ? `\n- **Tags:** ${entry.tags.map(inlineCode).join(", ")}`
    : "";
  return `## ${entry.timestamp} — ${oneLine(entry.agent)} — ${oneLine(entry.modelId)}

- **Directory:** ${inlineCode(entry.directory)}${tags}

${sanitizeMessage(entry.message)}

`;
}

export async function recordPapercut(options: {
  message: string;
  directory?: string;
  agent?: string;
  modelId?: string;
  tags?: string[];
  file?: string;
  environment?: NodeJS.ProcessEnv;
  now?: Date;
}): Promise<Papercut> {
  const message = options.message.trim();
  if (!message) throw new Error("papercut message cannot be empty");

  const directory = resolve(options.directory ?? process.cwd());
  const environment = options.environment ?? process.env;
  const file = resolveLogFile(directory, options.file, environment);
  const entry: Papercut = {
    timestamp: (options.now ?? new Date()).toISOString(),
    agent: detectAgent(environment, options.agent),
    modelId: await detectModelId(environment, options.modelId, directory),
    directory,
    message,
    tags: [...new Set((options.tags ?? []).map((tag) => tag.trim()).filter(Boolean))],
    file,
  };

  await mkdir(dirname(file), { recursive: true });
  const text = formatEntry(entry);
  try {
    // "ax" creates the file atomically, so concurrent first writes race on
    // creation instead of both prepending the header.
    const handle = await open(file, "ax");
    try {
      await handle.writeFile(HEADER + text, "utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const prefix = (await stat(file)).size === 0 ? HEADER : "";
    await appendFile(file, prefix + text, "utf8");
  }

  const globalFile = resolveGlobalFile(environment);
  if (globalFile && resolve(globalFile) !== resolve(file)) {
    await mkdir(dirname(globalFile), { recursive: true });
    await appendFile(globalFile, `${JSON.stringify(entry)}\n`, "utf8");
  }

  return entry;
}
