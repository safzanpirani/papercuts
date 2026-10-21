import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function run(cwd: string, environment: Record<string, string>, ...args: string[]) {
  const child = Bun.spawn({
    cmd: [process.execPath, "--no-env-file", cli, ...args],
    cwd,
    env: { PATH: process.env.PATH ?? "", ...environment },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

test("show prints an entry instead of logging `show <id>` as a new papercut", async () => {
  const root = await mkdtemp(join(tmpdir(), "papercuts-cli-"));
  directories.push(root);
  const environment = {
    HOME: root,
    PAPERCUTS_FILE: join(root, "PAPERCUTS.md"),
    PAPERCUTS_GLOBAL_FILE: join(root, "global.jsonl"),
    PAPERCUTS_AGENT: "test-agent",
    PAPERCUTS_MODEL_ID: "test-model",
  };

  const added = await run(root, environment, "--json", "-b", "fleet", "fleet cp rejected a second source file.");
  expect(added.code).toBe(0);
  const { id } = JSON.parse(added.stdout) as { id: string };
  const markdown = await readFile(environment.PAPERCUTS_FILE, "utf8");
  const mirror = await readFile(environment.PAPERCUTS_GLOBAL_FILE, "utf8");

  const shown = await run(root, environment, "show", id.slice(0, 4));
  expect(shown.code).toBe(0);
  expect(shown.stdout).toContain(id);
  expect(shown.stdout).toContain("fleet cp rejected a second source file.");
  expect(shown.stdout).toContain("about:fleet");

  const json = await run(root, environment, "show", id, "--json");
  expect(JSON.parse(json.stdout)).toMatchObject({ id, status: "open", about: "fleet" });

  const missing = await run(root, environment, "show", "zzzzzz");
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain("no papercut with ID zzzzzz");

  expect(await readFile(environment.PAPERCUTS_FILE, "utf8")).toBe(markdown);
  expect(await readFile(environment.PAPERCUTS_GLOBAL_FILE, "utf8")).toBe(mirror);
});
