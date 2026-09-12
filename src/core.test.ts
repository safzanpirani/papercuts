import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import {
  annotateMarkdownEntry,
  bumpPapercut,
  canonicalTag,
  collectTranscriptFiles,
  detectAgent,
  detectModelId,
  entryId,
  findProjectRoot,
  findSimilar,
  modelFromClaudeTranscripts,
  normalizeTags,
  readGlobalEntries,
  recordPapercut,
  resolveGlobalFile,
  resolveLogFile,
  resolvePapercut,
  suggestTag,
  writeUniqueMirrors,
} from "./core.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "papercuts-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("project location", () => {
  test("uses the enclosing Git root while preserving the called directory", async () => {
    const root = await temporaryDirectory();
    const nested = join(root, "packages", "app");
    await mkdir(join(root, ".git"));
    await mkdir(nested, { recursive: true });

    expect(findProjectRoot(nested)).toBe(root);
    expect(resolveLogFile(nested, undefined, {})).toBe(join(root, "PAPERCUTS.md"));

    const entry = await recordPapercut({
      directory: nested,
      agent: "test-agent",
      modelId: "test-model-v1",
      message: "A dead-end tool call needed a retry.",
      now: new Date("2026-07-10T07:30:00.000Z"),
      environment: { PAPERCUTS_GLOBAL_FILE: "off" },
    });
    const content = await readFile(entry.file, "utf8");

    expect(content).toContain("# PAPERCUTS");
    expect(content).toContain("2026-07-10T07:30:00.000Z — test-agent — test-model-v1");
    expect(content).toContain(`**Directory:** \`${nested}\``);
    expect(content).toContain("A dead-end tool call needed a retry.");
  });

  test("honors an explicit output file", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, ".git"), "gitdir: elsewhere\n");
    expect(resolveLogFile(root, "notes/cuts.md", {})).toBe(join(root, "notes", "cuts.md"));
  });

  test("writes the header exactly once across appends", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, ".git"));
    const environment = { PAPERCUTS_GLOBAL_FILE: "off" };

    await recordPapercut({ directory: root, agent: "a", modelId: "m", message: "First.", environment });
    const entry = await recordPapercut({ directory: root, agent: "a", modelId: "m", message: "Second.", environment });

    const content = await readFile(entry.file, "utf8");
    expect(content.split("# PAPERCUTS").length - 1).toBe(1);
    expect(content).toContain("First.");
    expect(content).toContain("Second.");
  });

  test("escapes line-leading '#' so a message cannot become a heading", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, ".git"));

    const entry = await recordPapercut({
      directory: root,
      agent: "a",
      modelId: "m",
      message: "## sneaky heading\nreal content",
      environment: { PAPERCUTS_GLOBAL_FILE: "off" },
    });
    const content = await readFile(entry.file, "utf8");
    expect(content).toContain("\\## sneaky heading");
  });
});

describe("global mirror", () => {
  test("mirrors entries to the global JSONL and reads them back", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, ".git"));
    const globalFile = join(await temporaryDirectory(), "global.jsonl");
    const environment = { PAPERCUTS_GLOBAL_FILE: globalFile };

    await recordPapercut({
      directory: root,
      agent: "test-agent",
      modelId: "test-model-v1",
      tags: ["flaky-command", "flaky-command", " "],
      message: "The build cache went stale.",
      environment,
    });

    const entries = await readGlobalEntries(environment);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.directory).toBe(root);
    expect(entries[0]!.tags).toEqual(["flaky-command"]);
    expect(entries[0]!.message).toBe("The build cache went stale.");
  });

  test("defaults under HOME and can be disabled", async () => {
    const home = await temporaryDirectory();
    expect(resolveGlobalFile({ HOME: home })).toBe(join(home, ".papercuts", "global.jsonl"));
    expect(resolveGlobalFile({ PAPERCUTS_GLOBAL_FILE: "off" })).toBeUndefined();
    expect(await readGlobalEntries({ HOME: home })).toEqual([]);
  });
});

describe("mirror writes", () => {
  test("deduplicates destinations and runs independent mirrors concurrently", async () => {
    const finished: string[] = [];
    let active = 0;
    let peak = 0;
    let duplicateRan = false;
    const mirror = (file: string, delay: number) => ({
      file,
      write: async () => {
        active++;
        peak = Math.max(peak, active);
        await Bun.sleep(delay);
        finished.push(file);
        active--;
      },
    });

    await writeUniqueMirrors([
      mirror("/tmp/subject", 8),
      mirror("/tmp/global", 2),
      { file: "/tmp/subject", write: async () => { duplicateRan = true; } },
    ]);

    expect(peak).toBe(2);
    expect(finished).toEqual(["/tmp/global", "/tmp/subject"]);
    expect(duplicateRan).toBe(false);
  });

  test("writes the primary first and does not touch mirrors when it fails", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, ".git"));
    const blocked = join(root, "blocked");
    await mkdir(blocked);
    const home = await temporaryDirectory();
    const subject = await temporaryDirectory();
    const globalFile = join(await temporaryDirectory(), "global.jsonl");
    await mkdir(join(home, ".papercuts"), { recursive: true });
    await writeFile(join(home, ".papercuts", "subjects.json"), JSON.stringify({ fleet: subject }));

    await expect(recordPapercut({
      directory: root,
      file: blocked,
      agent: "a",
      modelId: "m",
      about: "fleet",
      message: "Primary write must fail.",
      environment: { HOME: home, PAPERCUTS_GLOBAL_FILE: globalFile },
    })).rejects.toThrow();

    expect(await Bun.file(join(subject, "PAPERCUTS.md")).exists()).toBe(false);
    expect(await Bun.file(globalFile).exists()).toBe(false);
  });

  test("deduplicates a subject/global path and keeps one Markdown mirror", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, ".git"));
    const home = await temporaryDirectory();
    const subject = await temporaryDirectory();
    const sharedMirror = join(subject, "PAPERCUTS.md");
    await mkdir(join(home, ".papercuts"), { recursive: true });
    await writeFile(join(home, ".papercuts", "subjects.json"), JSON.stringify({ fleet: subject }));

    await recordPapercut({
      directory: root,
      agent: "a",
      modelId: "m",
      about: "fleet",
      message: "One mirror destination should receive one entry.",
      environment: { HOME: home, PAPERCUTS_GLOBAL_FILE: sharedMirror },
    });

    const mirrored = await readFile(sharedMirror, "utf8");
    expect(mirrored.split("# PAPERCUTS").length - 1).toBe(1);
    expect(mirrored.split("One mirror destination should receive one entry.").length - 1).toBe(1);
    expect(mirrored).not.toContain('"message":"One mirror destination');
  });
});

describe("tags", () => {
  test("folds known aliases onto the canonical vocabulary", () => {
    expect(canonicalTag("Fleet-CLI")).toBe("remote-ops");
    expect(canonicalTag("misleading-output")).toBe("misleading-error");
    expect(canonicalTag("shell_quoting")).toBe("shell-quoting");
  });

  test("reports non-canonical tags without dropping them", () => {
    const result = normalizeTags(["docs", "modal", "modal"]);
    expect(result.tags).toEqual(["docs", "modal"]);
    expect(result.unknown).toEqual(["modal"]);
    expect(suggestTag("doc")).toBe("docs");
  });
});

describe("lifecycle", () => {
  async function project(): Promise<{ root: string; environment: NodeJS.ProcessEnv }> {
    const root = await temporaryDirectory();
    await mkdir(join(root, ".git"));
    const globalFile = join(await temporaryDirectory(), "global.jsonl");
    // HOME is isolated so the real ~/.papercuts/subjects.json never routes
    // fixture entries into a maintainer's repository.
    return { root, environment: { HOME: root, PAPERCUTS_GLOBAL_FILE: globalFile } };
  }

  test("assigns a stable ID and open status, and resolves with a note", async () => {
    const { root, environment } = await project();
    const entry = await recordPapercut({
      directory: root,
      agent: "a",
      modelId: "m",
      message: "fleet exec swallowed a flag placed after the selector.",
      about: "Fleet",
      tags: ["fleet-cli"],
      environment,
    });

    expect(entry.id).toBe(entryId(entry.timestamp, entry.message));
    expect(entry.status).toBe("open");
    expect(entry.about).toBe("fleet");
    expect(entry.tags).toEqual(["remote-ops"]);

    const markdown = await readFile(entry.file, "utf8");
    expect(markdown).toContain(`## ${entry.id} · ${entry.timestamp}`);
    expect(markdown).toContain("**About:** `fleet`");

    const resolved = await resolvePapercut(entry.id, { note: "Added a targeted error in cli.ts.", environment });
    expect(resolved.status).toBe("resolved");
    expect((await readGlobalEntries(environment))[0]!.status).toBe("resolved");
    expect(await readFile(entry.file, "utf8")).toContain("**Resolved:**");
    expect(await readFile(entry.file, "utf8")).toContain("Added a targeted error in cli.ts.");

    await expect(resolvePapercut(entry.id, { environment })).rejects.toThrow("already resolved");
  });

  test("bump counts a repeat instead of adding a near-duplicate entry", async () => {
    const { root, environment } = await project();
    const entry = await recordPapercut({
      directory: root,
      agent: "a",
      modelId: "m",
      message: "The fff MCP grep failed immediately with Transport closed; fell back to ripgrep.",
      environment,
    });

    const bumped = await bumpPapercut(entry.id.slice(0, 4), { environment });
    expect(bumped.occurrences).toBe(2);
    expect(bumped.lastSeen).toBeString();
    expect(await readFile(entry.file, "utf8")).toContain("**Hit again:**");
    expect(await readGlobalEntries(environment)).toHaveLength(1);
  });

  test("resolving one entry does not annotate another with the same timestamp", async () => {
    const { root, environment } = await project();
    const options = { directory: root, agent: "a", modelId: "m", environment, now: new Date("2026-09-12T00:00:00Z") };
    const first = await recordPapercut({ ...options, message: "First separate problem." });
    const second = await recordPapercut({ ...options, message: "Second separate problem." });
    await resolvePapercut(second.id, { environment, note: "Fixed second problem." });
    const markdown = await readFile(first.file, "utf8");
    const [firstSection, secondSection] = markdown.slice(markdown.indexOf(`## ${first.id}`)).split(`## ${second.id}`);
    expect(firstSection).not.toContain("**Resolved:**");
    expect(secondSection).toContain("**Resolved:**");
    expect(secondSection).toContain("Fixed second problem.");
  });

  test("legacy annotation matches only the heading timestamp", async () => {
    const { root, environment } = await project();
    const entry = await recordPapercut({ directory: root, agent: "a", modelId: "m", message: "Legacy problem.", environment });
    await writeFile(entry.file, `## abcdef · 2000-01-01T00:00:00Z — ${entry.timestamp}\n\n- **Directory:** test\n\nUnrelated.\n\n## ${entry.timestamp} — a — m\n\n- **Directory:** test\n\nLegacy problem.\n`);
    expect(await annotateMarkdownEntry(entry.file, entry, ["- **Resolved:** fixed"])).toBe(true);
    const [unrelated, legacy] = (await readFile(entry.file, "utf8")).split(`## ${entry.timestamp} —`);
    expect(unrelated).not.toContain("**Resolved:**");
    expect(legacy).toContain("**Resolved:**");
  });

  test("bumping a resolved entry removes its old resolution from the current state", async () => {
    const { root, environment } = await project();
    const entry = await recordPapercut({ directory: root, agent: "a", modelId: "m", message: "A recurring problem.", environment });
    await resolvePapercut(entry.id, { environment, note: "Previously fixed." });
    const bumped = await bumpPapercut(entry.id, { environment });
    expect(bumped.status).toBe("open");
    expect(bumped.resolution).toBeUndefined();
    expect(bumped.resolvedAt).toBeUndefined();
    const [stored] = await readGlobalEntries(environment);
    expect(stored?.resolution).toBeUndefined();
    expect(stored?.resolvedAt).toBeUndefined();
    expect(await readFile(entry.file, "utf8")).toContain("Previously fixed.");
    expect(await readFile(entry.file, "utf8")).toContain("**Hit again:**");
  });

  test("finds a similar open entry for a near-duplicate message", async () => {
    const { root, environment } = await project();
    await recordPapercut({
      directory: root,
      agent: "a",
      modelId: "m",
      message: "fleet spawn silently forwarded --name after the command into the remote python argv.",
      about: "fleet",
      environment,
    });
    const entries = await readGlobalEntries(environment);

    expect(
      findSimilar(entries, {
        message: "fleet spawn forwarded its documented --cwd option into the remote pytest argv.",
        about: "fleet",
      })?.entry.id,
    ).toBe(entries[0]!.id);
    expect(findSimilar(entries, { message: "The portfolio README is empty so pnpm dev fails." })).toBeUndefined();
  });

  test("derives IDs for entries written before the lifecycle fields existed", async () => {
    const globalFile = join(await temporaryDirectory(), "global.jsonl");
    const legacy = {
      timestamp: "2026-07-13T15:36:36.645Z",
      agent: "claude-code",
      modelId: "claude-opus-4-8",
      directory: "/tmp/legacy",
      message: "A stale systemd Description made a plain restart bug look deliberate.",
      tags: ["misleading-error"],
      file: "/tmp/legacy/PAPERCUTS.md",
    };
    await writeFile(globalFile, `${JSON.stringify(legacy)}\n`);

    const [entry] = await readGlobalEntries({ PAPERCUTS_GLOBAL_FILE: globalFile });
    expect(entry!.id).toBe(entryId(legacy.timestamp, legacy.message));
    expect(entry!.status).toBe("open");
    expect(entry!.occurrences).toBe(1);
  });
});

describe("agent attribution", () => {
  test("prefers explicit identity", () => {
    expect(detectAgent({ CODEX_THREAD_ID: "thread" }, "gpt-5-codex")).toBe("gpt-5-codex");
  });

  test("detects common agent session markers", () => {
    expect(detectAgent({ CODEX_THREAD_ID: "thread" })).toBe("codex");
    expect(detectAgent({ CLAUDECODE: "1" })).toBe("claude-code");
    expect(detectAgent({})).toBe("unknown-agent");
  });
});

describe("model attribution", () => {
  test("prefers the explicit model ID", async () => {
    expect(await detectModelId({ PAPERCUTS_MODEL_ID: "env-model" }, "exact-model")).toBe("exact-model");
  });

  test("reads the exact model from the active Codex rollout", async () => {
    const codexHome = await temporaryDirectory();
    const sessions = join(codexHome, "sessions", "2026", "07", "10");
    const threadId = "019f4ae3-test-thread";
    await mkdir(sessions, { recursive: true });
    await writeFile(
      join(sessions, `rollout-2026-07-10T12-47-34-${threadId}.jsonl`),
      [
        JSON.stringify({ type: "session_meta", payload: { id: threadId } }),
        JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
      ].join("\n"),
    );

    expect(await detectModelId({ CODEX_HOME: codexHome, CODEX_THREAD_ID: threadId })).toBe("gpt-5.6-sol");
  });

  test("keeps the Codex session scan newest-first", async () => {
    const codexHome = await temporaryDirectory();
    const threadId = "019f4ae3-newest-thread";
    for (const [day, model] of [["09", "older-model"], ["10", "newer-model"]] as const) {
      const directory = join(codexHome, "sessions", "2026", "07", day);
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, `rollout-2026-07-${day}T12-00-00-${threadId}.jsonl`),
        JSON.stringify({ type: "turn_context", payload: { model } }),
      );
    }

    expect(await detectModelId({ CODEX_HOME: codexHome, CODEX_THREAD_ID: threadId })).toBe("newer-model");
  });

  test("stats Claude transcripts with an eight-file cap and deterministic mtime order", async () => {
    const directory = await temporaryDirectory();
    for (let index = 0; index < 12; index++)
      await writeFile(join(directory, `session-${String(index).padStart(2, "0")}.jsonl`), "{}\n");

    let active = 0;
    let peak = 0;
    const completed: string[] = [];
    const transcripts = await collectTranscriptFiles([directory], {
      statFile: async (file) => {
        const name = basename(file);
        const index = Number(name.match(/\d+/)![0]);
        active++;
        peak = Math.max(peak, active);
        try {
          await Bun.sleep((index + 1) * 2);
          completed.push(name);
          if (index === 4) throw Object.assign(new Error("gone"), { code: "ENOENT" });
          return { mtimeMs: Math.floor(index / 2) };
        } finally {
          active--;
        }
      },
    });

    expect(peak).toBe(8);
    expect(completed).not.toEqual([...completed].sort().reverse());
    expect(transcripts.map((transcript) => basename(transcript.file))).toEqual([
      "session-10.jsonl", "session-11.jsonl",
      "session-08.jsonl", "session-09.jsonl",
      "session-06.jsonl", "session-07.jsonl",
      "session-05.jsonl",
      "session-02.jsonl", "session-03.jsonl",
      "session-00.jsonl", "session-01.jsonl",
    ]);
  });

  test("returns the same ordered pool results with one worker and the default limit", async () => {
    const directory = await temporaryDirectory();
    for (let index = 0; index < 6; index++)
      await writeFile(join(directory, `session-${index}.jsonl`), "{}\n");
    const statFile = async (file: string) => {
      const index = Number(basename(file).match(/\d+/)![0]);
      await Bun.sleep((index + 1) * 2);
      return { mtimeMs: Math.floor(index / 2) };
    };

    const serial = await collectTranscriptFiles([directory], { maxParallel: 1, statFile });
    const pooled = await collectTranscriptFiles([directory], { statFile });

    expect(pooled).toEqual(serial);
    expect(pooled.map((transcript) => basename(transcript.file))).toEqual([
      "session-4.jsonl", "session-5.jsonl",
      "session-2.jsonl", "session-3.jsonl",
      "session-0.jsonl", "session-1.jsonl",
    ]);
  });

  test("rejects transcript pool limits that are not integers of at least one", async () => {
    for (const maxParallel of [0, -1, 1.5, Number.NaN]) {
      await expect(collectTranscriptFiles([], { maxParallel })).rejects.toThrow(
        "maxParallel must be an integer ≥ 1",
      );
    }
  });

  test("continues when a Claude transcript disappears after stat and before read", async () => {
    const directory = await temporaryDirectory();
    const disappeared = join(directory, "newest.jsonl");
    const fallback = join(directory, "older.jsonl");
    await writeFile(disappeared, JSON.stringify({ message: { model: "gone-model" } }));
    await writeFile(fallback, JSON.stringify({ message: { model: "fallback-model" } }));

    const transcripts = await collectTranscriptFiles([directory], {
      statFile: async (file) => ({ mtimeMs: file === disappeared ? 2 : 1 }),
    });
    await rm(disappeared);

    expect(await modelFromClaudeTranscripts(transcripts)).toBe("fallback-model");
  });

  test("does not hide non-ENOENT transcript read errors", async () => {
    const directory = await temporaryDirectory();

    await expect(modelFromClaudeTranscripts([{ file: directory, modifiedMs: 1 }])).rejects.toMatchObject({
      code: "EISDIR",
    });
  });

  test("reads the exact model from the newest Claude Code transcript", async () => {
    const configDirectory = await temporaryDirectory();
    const project = await temporaryDirectory();
    await mkdir(join(project, ".git"));
    const slug = project.replace(/[^a-zA-Z0-9]/g, "-");
    const transcripts = join(configDirectory, "projects", slug);
    await mkdir(transcripts, { recursive: true });
    await writeFile(
      join(transcripts, "session.jsonl"),
      [
        JSON.stringify({ type: "assistant", message: { model: "<synthetic>" } }),
        JSON.stringify({ type: "assistant", message: { model: "claude-fable-5" } }),
      ].join("\n"),
    );

    expect(
      await detectModelId({ CLAUDECODE: "1", CLAUDE_CONFIG_DIR: configDirectory }, undefined, project),
    ).toBe("claude-fable-5");
  });
});
