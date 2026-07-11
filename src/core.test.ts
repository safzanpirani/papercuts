import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  detectAgent,
  detectModelId,
  findProjectRoot,
  readGlobalEntries,
  recordPapercut,
  resolveGlobalFile,
  resolveLogFile,
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
