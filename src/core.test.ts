import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  bumpPapercut,
  canonicalTag,
  detectAgent,
  detectModelId,
  entryId,
  findProjectRoot,
  findSimilar,
  normalizeTags,
  readGlobalEntries,
  recordPapercut,
  resolveGlobalFile,
  resolveLogFile,
  resolvePapercut,
  suggestTag,
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
    return { root, environment: { PAPERCUTS_GLOBAL_FILE: globalFile } };
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
