import { appendFile, mkdir, open, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";

export const LOG_NAME = "PAPERCUTS.md";
const TRANSCRIPT_STAT_PARALLELISM = 8;

const HEADER = `# PAPERCUTS

Small, non-blocking frictions encountered by agents while working. Review this file periodically and sand them down.

`;

/** Run independent work with a fixed ceiling while preserving input order. */
export async function mapPool<T, R>(
  items: readonly T[],
  maxParallel: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(maxParallel) || maxParallel < 1)
    throw new Error(`maxParallel must be an integer ≥ 1 (got ${maxParallel})`);
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await run(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(maxParallel, items.length) }, worker));
  return results;
}

export interface Papercut {
  id: string;
  timestamp: string;
  agent: string;
  modelId: string;
  directory: string;
  /** What the friction is *about* (tool, CLI, service), independent of where it was hit. */
  about?: string;
  message: string;
  tags: string[];
  status: "open" | "resolved";
  occurrences: number;
  lastSeen?: string;
  resolvedAt?: string;
  resolution?: string;
  file: string;
}

/**
 * Closed tag vocabulary. Free-form tags decay into near-duplicates
 * (fleet/fleet-cli/remote-ops), which makes recurring friction uncountable.
 */
export const CANONICAL_TAGS = [
  "broken-link",
  "cleanup",
  "config",
  "deps",
  "docs",
  "dx",
  "flaky-command",
  "misleading-error",
  "missing-tool",
  "noisy-output",
  "remote-ops",
  "security",
  "shell-quoting",
  "slow-command",
  "stale-cache",
  "test-gap",
  "tooling",
  "upstream-bug",
] as const;

const TAG_ALIASES: Record<string, string> = {
  api: "upstream-bug",
  auth: "config",
  "broken-feature": "tooling",
  "broken-tool": "tooling",
  cli: "tooling",
  fleet: "remote-ops",
  "fleet-cli": "remote-ops",
  "github-connector": "tooling",
  "gpu-ops": "remote-ops",
  "import-path": "config",
  infra: "remote-ops",
  "misleading-output": "misleading-error",
  noisy: "noisy-output",
  observability: "dx",
  performance: "slow-command",
  "python-venv": "config",
  remote: "remote-ops",
  shell: "shell-quoting",
  ssh: "remote-ops",
  testing: "test-gap",
  tests: "test-gap",
  validation: "test-gap",
  windows: "remote-ops",
  workflow: "dx",
};

/** Map a tag onto the canonical vocabulary; unknown tags pass through unchanged. */
export function canonicalTag(tag: string): string {
  const slug = tag.trim().toLowerCase().replace(/[\s_]+/g, "-");
  return TAG_ALIASES[slug] ?? slug;
}

export function normalizeTags(tags: string[]): { tags: string[]; unknown: string[] } {
  const normalized = [...new Set(tags.map(canonicalTag).filter(Boolean))];
  return {
    tags: normalized,
    unknown: normalized.filter((tag) => !(CANONICAL_TAGS as readonly string[]).includes(tag)),
  };
}

/** Nearest canonical tag by character-bigram overlap, for "did you mean" hints. */
export function suggestTag(tag: string): string | undefined {
  const bigrams = (value: string) =>
    new Set(Array.from({ length: Math.max(value.length - 1, 0) }, (_, i) => value.slice(i, i + 2)));
  const target = bigrams(tag);
  let best: { tag: string; score: number } | undefined;
  for (const candidate of CANONICAL_TAGS) {
    const other = bigrams(candidate);
    const shared = [...target].filter((gram) => other.has(gram)).length;
    const score = shared / Math.max(target.size + other.size - shared, 1);
    if (!best || score > best.score) best = { tag: candidate, score };
  }
  return best && best.score >= 0.3 ? best.tag : undefined;
}

/** Stable short ID derived from the entry's immutable fields. */
export function entryId(timestamp: string, message: string): string {
  return createHash("sha1").update(`${timestamp}\n${message.trim()}`).digest("hex").slice(0, 6);
}

export function normalizeAbout(about: string): string {
  return about.trim().toLowerCase().replace(/[\s_]+/g, "-");
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

export interface TranscriptFile {
  file: string;
  modifiedMs: number;
}

/** Collect Claude transcripts deterministically. Stats run through an eight-slot
 * pool; files that disappear after listing are skipped without masking other IO
 * errors. The existing newest-mtime-first order gets a stable path tie-break. */
export async function collectTranscriptFiles(
  projectDirectories: string[],
  options: {
    maxParallel?: number;
    statFile?: (file: string) => Promise<{ mtimeMs: number }>;
  } = {},
): Promise<TranscriptFile[]> {
  const listed = await Promise.all(projectDirectories.map(async (projectDirectory) =>
    (await directoryEntriesNewestFirst(projectDirectory))
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => join(projectDirectory, name)),
  ));
  const files = listed.flat();
  const statFile = options.statFile ?? stat;
  const transcripts = await mapPool(files, options.maxParallel ?? TRANSCRIPT_STAT_PARALLELISM, async (file) => {
    try {
      return { file, modifiedMs: (await statFile(file)).mtimeMs };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  });
  return transcripts
    .filter((transcript): transcript is TranscriptFile => transcript !== undefined)
    .sort((a, b) => b.modifiedMs - a.modifiedMs || a.file.localeCompare(b.file));
}

export async function modelFromClaudeTranscripts(
  transcripts: readonly TranscriptFile[],
): Promise<string | undefined> {
  for (const transcript of transcripts) {
    try {
      const model = await lastJsonLineValue(transcript.file, '"model":', (record) => {
        const value = (record as { message?: { model?: unknown } }).message?.model;
        return typeof value === "string" && value !== "<synthetic>" ? value : undefined;
      });
      if (model) return model;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  return undefined;
}

async function modelFromClaudeSession(
  environment: NodeJS.ProcessEnv,
  directory: string,
): Promise<string | undefined> {
  if (!environment.CLAUDECODE && !environment.CLAUDE_CODE_ENTRYPOINT) return undefined;

  const configDirectory =
    environment.CLAUDE_CONFIG_DIR?.trim() || join(environment.HOME?.trim() || homedir(), ".claude");
  const candidates = [...new Set([resolve(directory), findProjectRoot(directory)])];
  const projectDirectories = candidates.map((candidate) =>
    join(configDirectory, "projects", claudeProjectSlug(candidate)));
  const transcripts = await collectTranscriptFiles(projectDirectories);
  return modelFromClaudeTranscripts(transcripts);
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
      const record = JSON.parse(line) as Partial<Papercut>;
      if (typeof record.timestamp !== "string" || typeof record.message !== "string") continue;
      entries.push({
        ...(record as Papercut),
        // Entries written before the lifecycle fields existed get their ID
        // derived on read, so old logs need no migration.
        id: record.id ?? entryId(record.timestamp, record.message),
        tags: Array.isArray(record.tags) ? record.tags : [],
        status: record.status === "resolved" ? "resolved" : "open",
        occurrences: typeof record.occurrences === "number" && record.occurrences > 0 ? record.occurrences : 1,
      });
    } catch {
      // Skip a torn line from a concurrent write.
    }
  }
  return entries;
}

/** Rewrite the global mirror in place (read-modify-write via a temp file + rename). */
export async function writeGlobalEntries(
  entries: Papercut[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const globalFile = resolveGlobalFile(environment);
  if (!globalFile) throw new Error("global mirror is disabled; nothing to update");
  const temporary = `${globalFile}.tmp-${process.pid}`;
  await mkdir(dirname(globalFile), { recursive: true });
  await writeFile(temporary, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""), "utf8");
  await rename(temporary, globalFile);
}

const STOPWORDS = new Set(
  ("a an the and or but so then than that this these those it its is was were be been being of in on at to for from with " +
    "while during after before because when where which what why how i we my our not no did does do done had has have " +
    "as by if into out up down over under again only just also very can could would should still even").split(" "),
);

function significantWords(message: string): Set<string> {
  return new Set(
    message
      .toLowerCase()
      .split(/[^a-z0-9._/-]+/)
      .filter((word) => word.length > 2 && !STOPWORDS.has(word)),
  );
}

/**
 * Overlap coefficient (shared / smaller vocabulary), boosted when both entries
 * name the same subject. Overlap rather than Jaccard because a terse repeat of a
 * thoroughly-described papercut is still the same papercut.
 */
export function similarity(a: Papercut | { message: string; about?: string }, b: Papercut): number {
  const left = significantWords(a.message);
  const right = significantWords(b.message);
  const shared = [...left].filter((word) => right.has(word)).length;
  // Two very short messages can overlap fully by accident; demand real evidence.
  if (shared < 4) return 0;
  const base = shared / Math.max(Math.min(left.size, right.size), 1);
  const sameSubject = a.about && b.about && a.about === b.about;
  return sameSubject ? Math.min(base * 1.2, 1) : base;
}

export function findSimilar(
  entries: Papercut[],
  candidate: { message: string; about?: string },
  threshold = 0.5,
): { entry: Papercut; score: number } | undefined {
  let best: { entry: Papercut; score: number } | undefined;
  for (const entry of entries) {
    const score = similarity(candidate, entry);
    if (score >= threshold && (!best || score > best.score)) best = { entry, score };
  }
  return best;
}

/**
 * Locate an entry's section in a Markdown log. Matches on the ID when present and
 * falls back to the timestamp for pre-ID entries. `bulletsEnd` is the index just
 * past the contiguous metadata bullet block that follows the heading.
 */
function findMarkdownEntry(
  lines: string[],
  entry: Pick<Papercut, "id" | "timestamp">,
): { bulletsStart: number; bulletsEnd: number } | undefined {
  let headingIndex = lines.findIndex((line) => line.startsWith(`## ${entry.id} `));
  if (headingIndex === -1) {
    headingIndex = lines.findIndex((line) => line.startsWith(`## ${entry.timestamp} — `));
  }
  if (headingIndex === -1) return undefined;

  let bulletsStart = headingIndex + 1;
  while (bulletsStart < lines.length && !lines[bulletsStart]!.startsWith("- **")) {
    if (lines[bulletsStart]!.startsWith("## ")) return undefined;
    bulletsStart++;
  }
  let bulletsEnd = bulletsStart;
  while (bulletsEnd < lines.length && lines[bulletsEnd]!.startsWith("- **")) bulletsEnd++;
  return { bulletsStart, bulletsEnd };
}

/** Add metadata bullets to an entry already written to a Markdown log. */
export async function annotateMarkdownEntry(
  file: string,
  entry: Papercut,
  bullets: string[],
): Promise<boolean> {
  let content: string;
  try {
    content = await readFile(file, "utf8");
  } catch {
    return false;
  }

  const lines = content.split("\n");
  const block = findMarkdownEntry(lines, entry);
  if (!block) return false;

  lines.splice(block.bulletsEnd, 0, ...bullets);
  await writeFile(file, lines.join("\n"), "utf8");
  return true;
}

/**
 * Status recorded in a Markdown copy: the last lifecycle bullet wins, because
 * bump reopens a resolved entry by appending "Hit again" after "Resolved".
 */
export function markdownStatus(
  content: string,
  entry: Pick<Papercut, "id" | "timestamp">,
): Papercut["status"] | undefined {
  const lines = content.split("\n");
  const block = findMarkdownEntry(lines, entry);
  if (!block) return undefined;
  let status: Papercut["status"] = "open";
  for (const line of lines.slice(block.bulletsStart, block.bulletsEnd)) {
    if (line.startsWith("- **Resolved:**")) status = "resolved";
    else if (line.startsWith("- **Hit again:**")) status = "open";
  }
  return status;
}

/**
 * Every Markdown log that should hold a copy of the entry: the file it was
 * written to and the subject repo's log from ~/.papercuts/subjects.json.
 */
export async function markdownCopies(
  entry: Papercut,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const subjectFile = await subjectLogFile(entry.about, environment);
  return [...new Set([entry.file, subjectFile].filter((file): file is string => !!file).map((file) => resolve(file)))];
}

export interface LifecycleOptions {
  now?: Date;
  environment?: NodeJS.ProcessEnv;
  /** Annotate only these Markdown logs instead of every known copy; [] updates only the global mirror. */
  files?: string[];
}

export interface LifecycleResult {
  entry: Papercut;
  /** Markdown logs that received the annotation. */
  annotated: string[];
  /** Markdown logs that were missing or did not contain the entry. */
  missed: string[];
}

async function updateEntry(
  id: string,
  apply: (entry: Papercut) => { entry: Papercut; bullets: string[] },
  options: LifecycleOptions,
): Promise<LifecycleResult> {
  const environment = options.environment ?? process.env;
  const entries = await readGlobalEntries(environment);
  const matches = entries.filter((entry) => entry.id === id || entry.id.startsWith(id));
  if (!matches.length) throw new Error(`no papercut with ID ${id}`);
  if (matches.length > 1) throw new Error(`ID ${id} is ambiguous (${matches.map((e) => e.id).join(", ")})`);

  const target = matches[0]!;
  const { entry, bullets } = apply(target);
  await writeGlobalEntries(
    entries.map((existing) => (existing.id === target.id ? entry : existing)),
    environment,
  );

  const files = options.files
    ? [...new Set(options.files.map((file) => resolve(file)))]
    : await markdownCopies(entry, environment);
  const annotated: string[] = [];
  const missed: string[] = [];
  // Serial: two copies may be the same file under different spellings.
  for (const file of files) {
    if (bullets.length && (await annotateMarkdownEntry(file, entry, bullets))) annotated.push(file);
    else missed.push(file);
  }
  return { entry, annotated, missed };
}

export function resolutionBullet(resolvedAt: string, note?: string): string {
  return `- **Resolved:** ${resolvedAt}${note ? ` — ${oneLine(note)}` : ""}`;
}

export function hitAgainBullet(lastSeen: string, occurrences: number): string {
  return `- **Hit again:** ${lastSeen} (${occurrences} total)`;
}

export async function resolvePapercut(
  id: string,
  options: LifecycleOptions & { note?: string } = {},
): Promise<LifecycleResult> {
  const resolvedAt = (options.now ?? new Date()).toISOString();
  return updateEntry(
    id,
    (entry) => {
      if (entry.status === "resolved") throw new Error(`papercut ${entry.id} is already resolved`);
      const note = options.note?.trim();
      return {
        entry: { ...entry, status: "resolved", resolvedAt, resolution: note },
        bullets: [resolutionBullet(resolvedAt, note)],
      };
    },
    options,
  );
}

export async function bumpPapercut(
  id: string,
  options: LifecycleOptions = {},
): Promise<LifecycleResult> {
  const lastSeen = (options.now ?? new Date()).toISOString();
  return updateEntry(
    id,
    (entry) => ({
      entry: { ...entry, occurrences: entry.occurrences + 1, lastSeen, status: "open", resolvedAt: undefined, resolution: undefined },
      bullets: [hitAgainBullet(lastSeen, entry.occurrences + 1)],
    }),
    options,
  );
}

export interface CopyDrift {
  file: string;
  /** Absent when an explicitly named file is missing. */
  entry?: Papercut;
  kind: "missing-file" | "missing-entry" | "status";
  /** Status the Markdown copy records, for "status" drift. */
  markdownStatus?: Papercut["status"];
  fixed?: boolean;
}

/**
 * Compare the global mirror against Markdown copies. Without `files`, checks each
 * entry's known copies; with `files`, checks every global entry those files hold,
 * which covers copies the mirror does not know about. `fix` appends the missing
 * lifecycle bullet to a copy whose status disagrees with the mirror.
 */
export async function checkMarkdownCopies(
  entries: Papercut[],
  options: { files?: string[]; fix?: boolean; environment?: NodeJS.ProcessEnv } = {},
): Promise<CopyDrift[]> {
  const environment = options.environment ?? process.env;
  const contents = new Map<string, string | undefined>();
  const read = async (file: string): Promise<string | undefined> => {
    if (!contents.has(file)) contents.set(file, await readFile(file, "utf8").catch(() => undefined));
    return contents.get(file);
  };

  const pairs: { file: string; entry: Papercut }[] = [];
  const drift: CopyDrift[] = [];
  if (options.files) {
    for (const file of [...new Set(options.files.map((name) => resolve(name)))]) {
      const content = await read(file);
      if (content === undefined) {
        drift.push({ file, kind: "missing-file" });
        continue;
      }
      for (const entry of entries) {
        if (markdownStatus(content, entry) !== undefined) pairs.push({ file, entry });
      }
    }
  } else {
    for (const entry of entries) {
      for (const file of await markdownCopies(entry, environment)) pairs.push({ file, entry });
    }
  }

  for (const { file, entry } of pairs) {
    const content = await read(file);
    if (content === undefined) {
      drift.push({ file, entry, kind: "missing-file" });
      continue;
    }
    const recorded = markdownStatus(content, entry);
    if (recorded === undefined) {
      drift.push({ file, entry, kind: "missing-entry" });
      continue;
    }
    if (recorded === entry.status) continue;

    const item: CopyDrift = { file, entry, kind: "status", markdownStatus: recorded };
    if (options.fix) {
      const bullet =
        entry.status === "resolved" && entry.resolvedAt
          ? resolutionBullet(entry.resolvedAt, entry.resolution)
          : entry.status === "open" && entry.lastSeen
            ? hitAgainBullet(entry.lastSeen, entry.occurrences)
            : undefined;
      if (bullet && (await annotateMarkdownEntry(file, entry, [bullet]))) {
        item.fixed = true;
        contents.delete(file);
      }
    }
    drift.push(item);
  }
  return drift;
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
  const bullets = [`- **Directory:** ${inlineCode(entry.directory)}`];
  if (entry.about) bullets.push(`- **About:** ${inlineCode(entry.about)}`);
  if (entry.tags.length) bullets.push(`- **Tags:** ${entry.tags.map(inlineCode).join(", ")}`);
  return `## ${entry.id} · ${entry.timestamp} — ${oneLine(entry.agent)} — ${oneLine(entry.modelId)}

${bullets.join("\n")}

${sanitizeMessage(entry.message)}

`;
}

/**
 * Optional `about` → repo map at ~/.papercuts/subjects.json, e.g.
 * {"fleet": "/Users/me/Development/fleet"}. Friction about a tool is usually hit
 * from some *other* repo, so mirror it where the tool's maintainer will see it.
 */
async function subjectLogFile(
  about: string | undefined,
  environment: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  if (!about) return undefined;
  const mapFile = join(environment.HOME?.trim() || homedir(), ".papercuts", "subjects.json");
  try {
    const map = JSON.parse(await readFile(mapFile, "utf8")) as Record<string, string>;
    const directory = map[about]?.trim();
    return directory ? join(resolve(directory), LOG_NAME) : undefined;
  } catch {
    return undefined;
  }
}

async function appendMarkdownLog(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
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
}

export interface MirrorWrite {
  file: string;
  write: () => Promise<void>;
}

/** Run one write per resolved destination. Subject wins a deliberate collision
 * with the global path because callers list it first. Independent mirrors start
 * together only after the primary log has succeeded. */
export async function writeUniqueMirrors(mirrors: MirrorWrite[]): Promise<void> {
  const seen = new Set<string>();
  const unique = mirrors.filter((mirror) => {
    const destination = resolve(mirror.file);
    if (seen.has(destination)) return false;
    seen.add(destination);
    return true;
  });
  await Promise.all(unique.map((mirror) => mirror.write()));
}

export async function recordPapercut(options: {
  message: string;
  directory?: string;
  agent?: string;
  modelId?: string;
  about?: string;
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
  const timestamp = (options.now ?? new Date()).toISOString();
  const entry: Papercut = {
    id: entryId(timestamp, message),
    timestamp,
    agent: detectAgent(environment, options.agent),
    modelId: await detectModelId(environment, options.modelId, directory),
    directory,
    about: options.about ? normalizeAbout(options.about) : undefined,
    message,
    tags: normalizeTags(options.tags ?? []).tags,
    status: "open",
    occurrences: 1,
    file,
  };

  const text = formatEntry(entry);
  await appendMarkdownLog(file, text);

  const primary = resolve(file);
  const mirrors: MirrorWrite[] = [];
  const subjectFile = await subjectLogFile(entry.about, environment);
  if (subjectFile && resolve(subjectFile) !== primary) {
    mirrors.push({
      file: subjectFile,
      write: () => appendMarkdownLog(subjectFile, text),
    });
  }

  const globalFile = resolveGlobalFile(environment);
  if (globalFile && resolve(globalFile) !== primary) {
    mirrors.push({
      file: globalFile,
      write: async () => {
        await mkdir(dirname(globalFile), { recursive: true });
        await appendFile(globalFile, `${JSON.stringify(entry)}\n`, "utf8");
      },
    });
  }
  await writeUniqueMirrors(mirrors);

  return entry;
}
