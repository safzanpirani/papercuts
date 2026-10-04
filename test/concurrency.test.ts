import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bumpPapercut, readGlobalEntries, recordPapercut, resolvePapercut, writeGlobalEntries, writeUniqueMirrors } from "../src/core.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function store(about?: string) {
  const root = await mkdtemp(join(tmpdir(), "papercuts-concurrency-"));
  roots.push(root);
  const environment = { HOME: root, PAPERCUTS_GLOBAL_FILE: join(root, "global.jsonl") };
  if (about) {
    await mkdir(join(root, ".papercuts"));
    await writeFile(join(root, ".papercuts", "subjects.json"), JSON.stringify({ [about]: join(root, "subject") }));
  }
  const options = { about, directory: root, agent: "test", modelId: "test-model", environment };
  const entry = await recordPapercut({ ...options, message: "Recurring synthetic failure." });
  return { root, environment, options, entry };
}

async function expectClean(root: string) {
  const files = await readdir(root, { recursive: true });
  expect(files.filter((file) => file.includes(".tmp-") || file.endsWith(".lock"))).toEqual([]);
}

test("preserves two simultaneous bumps in one process", async () => {
  const { root, environment, entry } = await store();
  const results = await Promise.allSettled([
    bumpPapercut(entry.id, { environment }),
    bumpPapercut(entry.id, { environment }),
  ]);
  expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
  expect((await readGlobalEntries(environment))[0]!.occurrences).toBe(3);
  const markdown = await readFile(entry.file, "utf8");
  expect(markdown.match(/\*\*Hit again:\*\*/g)).toHaveLength(2);
  expect(markdown).toContain("(3 total)");
  await expectClean(root);
});

test("coordinates appends, bumps and resolutions across two processes", async () => {
  const { root, environment, entry } = await store("tool");
  const worker = `
    import { recordPapercut, bumpPapercut, resolvePapercut } from ${JSON.stringify(new URL("../src/core.ts", import.meta.url).pathname)};
    const [root, id, worker] = process.argv.slice(1);
    const environment = { HOME: root, PAPERCUTS_GLOBAL_FILE: root + '/global.jsonl' };
    console.log('ready');
    await Bun.stdin.text();
    for (let i = 0; i < 12; i++) {
      await bumpPapercut(id, { environment });
      const added = await recordPapercut({ directory: root, agent: 'test', modelId: 'test-model',
        message: 'Synthetic ' + worker + ' entry ' + i, about: 'tool', environment });
      await resolvePapercut(added.id, { environment, note: 'Resolved synthetic entry.' });
    }
  `;
  const children = ["a", "b"].map((name) => Bun.spawn({
    cmd: [process.execPath, "--no-env-file", "-e", worker, root, entry.id, name],
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  }));
  try {
    await Promise.all(children.map(async (child) => {
      const reader = child.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready");
      reader.releaseLock();
    }));
    children.forEach((child) => child.stdin.end());
    const results = await Promise.all(children.map(async (child) => ({
      code: await child.exited, error: await new Response(child.stderr).text(),
    })));
    expect(results).toEqual([{ code: 0, error: "" }, { code: 0, error: "" }]);
  } finally {
    children.forEach((child) => child.kill());
    await Promise.all(children.map((child) => child.exited));
  }
  const entries = await readGlobalEntries(environment);
  expect(entries).toHaveLength(25);
  expect(entries.find((item) => item.id === entry.id)!.occurrences).toBe(25);
  expect(entries.filter((item) => item.status === "resolved")).toHaveLength(24);
  for (const file of [entry.file, join(root, "subject", "PAPERCUTS.md")]) {
    const markdown = await readFile(file, "utf8");
    expect(markdown.match(/^# PAPERCUTS$/gm)).toHaveLength(1);
    const sections = markdown.split(/^## /m).slice(1);
    expect(sections).toHaveLength(25);
    for (const current of entries) {
      const matching = sections.filter((section) => section.startsWith(`${current.id} `));
      expect(matching).toHaveLength(1);
      const section = matching[0]!;
      if (current.id === entry.id) {
        expect(section.match(/\*\*Hit again:\*\*/g)).toHaveLength(24);
        for (let count = 2; count <= 25; count++) expect(section).toContain(`(${count} total)`);
        expect(section).not.toContain("**Resolved:**");
      } else {
        expect(current.occurrences).toBe(1);
        expect(section.match(/\*\*Resolved:\*\*/g)).toHaveLength(1);
        expect(section).toContain(current.resolution!);
        expect(section).not.toContain("**Hit again:**");
      }
    }
  }
  await expectClean(root);
}, 30000);

test("cleans temporary files after a failed replacement and allows a retry", async () => {
  const { root, environment, entry } = await store();
  await rm(environment.PAPERCUTS_GLOBAL_FILE);
  await mkdir(environment.PAPERCUTS_GLOBAL_FILE);
  await expect(writeGlobalEntries([entry], environment)).rejects.toThrow();
  await expectClean(root);
  await rm(environment.PAPERCUTS_GLOBAL_FILE, { recursive: true });
  await writeGlobalEntries([entry], environment);
  expect(await readGlobalEntries(environment)).toEqual([entry]);
  await expectClean(root);
});

test("keeps JSON unchanged when a Markdown projection cannot be read", async () => {
  const { root, environment, entry } = await store();
  const markdown = await readFile(entry.file, "utf8");
  await rm(entry.file);
  await mkdir(entry.file);
  await expect(bumpPapercut(entry.id, { environment })).rejects.toThrow();
  expect((await readGlobalEntries(environment))[0]!.occurrences).toBe(1);
  await expectClean(root);
  await rm(entry.file, { recursive: true });
  await writeFile(entry.file, markdown);
  expect((await bumpPapercut(entry.id, { environment })).occurrences).toBe(2);
  await expectClean(root);
});

test("rolls Markdown back when publishing JSON fails and releases every lock", async () => {
  const { root, environment, entry } = await store();
  const before = await readFile(entry.file, "utf8");
  const rename = fs.rename;
  const failure = spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (to === environment.PAPERCUTS_GLOBAL_FILE) throw new Error("synthetic rename failure");
    return rename(from, to);
  });
  try {
    await expect(bumpPapercut(entry.id, { environment })).rejects.toThrow("synthetic rename failure");
  } finally {
    failure.mockRestore();
  }
  expect(await readFile(entry.file, "utf8")).toBe(before);
  expect((await readGlobalEntries(environment))[0]!.occurrences).toBe(1);
  await expectClean(root);
  expect((await bumpPapercut(entry.id, { environment })).occurrences).toBe(2);
  await expectClean(root);
});

test("preserves concurrent lifecycle history in the primary and subject logs", async () => {
  const { root, options, environment } = await store();
  const subject = join(root, "subject");
  await mkdir(join(root, ".papercuts"));
  await writeFile(join(root, ".papercuts", "subjects.json"), JSON.stringify({ tool: subject }));
  const entry = await recordPapercut({ ...options, about: "tool", message: "Synthetic tool failure." });
  await Promise.all([
    bumpPapercut(entry.id, { environment }),
    resolvePapercut(entry.id, { environment, note: "Synthetic resolution." }),
  ]);
  const current = (await readGlobalEntries(environment)).find((item) => item.id === entry.id)!;
  expect(current.occurrences).toBe(2);
  for (const file of [entry.file, join(subject, "PAPERCUTS.md")]) {
    const markdown = await readFile(file, "utf8");
    expect(markdown.match(/\*\*Hit again:\*\*/g)).toHaveLength(1);
    expect(markdown.match(/\*\*Resolved:\*\*/g)).toHaveLength(1);
    const resolvedLast = markdown.lastIndexOf("**Resolved:**") > markdown.lastIndexOf("**Hit again:**");
    expect(current.status).toBe(resolvedLast ? "resolved" : "open");
  }
  await expectClean(root);
});

test("serializes first Markdown appends when global mirroring is disabled", async () => {
  const { root, options, entry } = await store();
  await rm(entry.file);
  const environment = { HOME: root, PAPERCUTS_GLOBAL_FILE: "off" };
  await Promise.all(["First", "Second"].map((message) => recordPapercut({ ...options, environment, message })));
  const markdown = await readFile(entry.file, "utf8");
  expect(markdown.match(/^# PAPERCUTS$/gm)).toHaveLength(1);
  expect(markdown.match(/^## /gm)).toHaveLength(2);
  expect(markdown).toContain("First");
  expect(markdown).toContain("Second");
  await expectClean(root);
});

test("waits for pending mirror writes before reporting another mirror's failure", async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  let settled = false;
  const result = writeUniqueMirrors([
    { file: "failed", write: async () => { throw new Error("synthetic mirror failure"); } },
    { file: "pending", write: () => pending },
  ]).catch((error: Error) => { settled = true; return error.message; });
  // An event-loop turn lets the rejection propagate without releasing the other writer.
  await Bun.sleep(0);
  expect(settled).toBe(false);
  finish();
  expect(await result).toBe("synthetic mirror failure");
});

for (const failureFirst of [true, false]) {
  test(`waits for pending mirrors after a synchronous throw (failure first: ${failureFirst})`, async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    let started = false;
    let settled = false;
    const mirrors = [
      { file: "pending", write: () => { started = true; return pending; } },
      { file: "failed", write: (): Promise<void> => { throw new Error("synchronous failure"); } },
    ];
    const result = writeUniqueMirrors(failureFirst ? mirrors.reverse() : mirrors)
      .catch((error: Error) => error.message)
      .finally(() => { settled = true; });
    try {
      await Bun.sleep(0);
      expect(started).toBe(true);
      expect(settled).toBe(false);
    } finally {
      finish();
      await result;
    }
    expect(await result).toBe("synchronous failure");
  });
}

test("preserves an unowned temporary file when exclusive creation collides", async () => {
  const { root, environment, entry } = await store();
  const originalOpen = fs.open;
  let collision: string | undefined;
  const failure = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]).includes(".tmp-")) {
      collision = String(args[0]);
      await writeFile(collision, "another writer owns this file");
    }
    return originalOpen(...args);
  });
  try {
    await expect(writeGlobalEntries([entry], environment)).rejects.toThrow();
  } finally {
    failure.mockRestore();
  }
  expect(collision).toBeDefined();
  expect(await readFile(collision!, "utf8")).toBe("another writer owns this file");
  expect(await readGlobalEntries(environment)).toEqual([entry]);
  await rm(collision!);
  await expectClean(root);
});
