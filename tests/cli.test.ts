import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli, type CliIo } from "../src/cli.ts";

type InvocationResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

describe("CLI integration", () => {
  let home = "";

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "task-lake-cli-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const invoke = async (
    args: readonly string[],
    stdin = "",
    storageOverrides: NonNullable<CliIo["storage"]> = {},
  ): Promise<InvocationResult> => {
    let stdout = "";
    let stderr = "";
    const exitCode = await runCli(args, {
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      readStdin: async () => stdin,
      stdoutIsTTY: false,
      now: () => new Date("2026-07-15T12:30:00Z"),
      storage: {
        home,
        lockRetryAttempts: 1,
        lockRetryDelayMs: 0,
        ...storageOverrides,
      },
    });
    return { exitCode, stdout, stderr };
  };

  test("executes all nine commands with fixed JSON contracts and idempotency", async () => {
    const added = await invoke(
      ["add", "メール A", "--due", "2026-07-20", "-l", "work", "--note", "-", "--json"],
      "first line\nsecond line\n",
    );
    expect(added.exitCode).toBe(0);
    expect(added.stderr).toBe("");
    expect(JSON.parse(added.stdout)).toMatchObject({
      changed: true,
      task: { id: "1", title: "メール A", note: "first line\nsecond line" },
    });
    expect((JSON.parse(added.stdout) as { task: Record<string, unknown> }).task).not.toHaveProperty(
      "closed",
    );

    expect((await invoke(["add", "メール B", "--json"])).exitCode).toBe(0);

    const listed = await invoke(["list", "-l", "work", "--json"]);
    expect(JSON.parse(listed.stdout)).toEqual({
      total: 1,
      items: [
        expect.objectContaining({
          id: "1",
          title: "メール A",
          has_note: true,
        }),
      ],
    });
    expect(JSON.parse(listed.stdout).items[0]).not.toHaveProperty("note");

    const ambiguous = await invoke(["show", "メール", "--json"]);
    expect(ambiguous.exitCode).toBe(4);
    expect(ambiguous.stdout).toBe("");
    expect(ambiguous.stderr.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(ambiguous.stderr)).toMatchObject({
      error: { code: "ambiguous", candidates: [{ id: "1" }, { id: "2" }] },
    });

    const done = await invoke(["done", "1", "--note", "closed", "--json"]);
    expect(JSON.parse(done.stdout)).toMatchObject({
      changed: true,
      task: { id: "1", status: "done", note: "first line\nsecond line\nclosed" },
    });
    const doneAgain = await invoke(["done", "1", "--note", "duplicate", "--json"]);
    expect(JSON.parse(doneAgain.stdout)).toMatchObject({
      changed: false,
      task: { note: "first line\nsecond line\nclosed" },
    });

    const reopened = await invoke(["reopen", "1", "--json"]);
    expect(JSON.parse(reopened.stdout)).toMatchObject({
      changed: true,
      task: { id: "1", status: "open" },
    });
    expect(JSON.parse(reopened.stdout).task).not.toHaveProperty("closed");
    expect(JSON.parse((await invoke(["reopen", "1", "--json"])).stdout).changed).toBe(false);

    const edited = await invoke([
      "edit",
      "1",
      "--title",
      "返信する",
      "--clear-due",
      "--set-labels",
      "customer,followup",
      "--clear-note",
      "--json",
    ]);
    expect(JSON.parse(edited.stdout)).toMatchObject({
      changed: true,
      task: { title: "返信する", labels: ["customer", "followup"] },
    });
    expect(JSON.parse(edited.stdout).task).not.toHaveProperty("due");
    expect(JSON.parse(edited.stdout).task).not.toHaveProperty("note");

    const missingRemoval = await invoke(["rm", "999", "--json"]);
    expect(JSON.parse(missingRemoval.stdout)).toEqual({ changed: false, task: null });
    expect(JSON.parse((await invoke(["rm", "1", "--json"])).stdout)).toMatchObject({
      changed: true,
      task: { id: "1" },
    });

    const described = await invoke(["describe", "edit", "--json"]);
    expect(JSON.parse(described.stdout)).toMatchObject({ name: "edit" });
    expect(JSON.parse(described.stdout).flags).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "--clear-note" })]),
    );

    const validated = await invoke(["validate", "--json"]);
    expect(JSON.parse(validated.stdout)).toEqual({ valid: true, task_count: 1, issues: [] });
  });

  test("emits one structured usage error and no stdout", async () => {
    const result = await invoke(["edit", "abc", "--json"]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: { code: "usage", next_step: expect.any(String) },
    });
  });

  test("validate reports every corrupt row with exit 5 without rewriting data", async () => {
    const raw = [
      '{"id":"1","title":"bad","status":"done","labels":[],"created":"2026-07-15T12:00:00+09:00"}',
      "not json",
      "",
    ].join("\n");
    await writeFile(join(home, "tasks.jsonl"), raw, "utf8");

    const result = await invoke(["validate", "--json"]);
    expect(result.exitCode).toBe(5);
    expect(result.stdout).toBe("");
    const error = JSON.parse(result.stderr).error;
    expect(error.code).toBe("validation");
    expect(error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ line: 1, field: "closed" }),
        expect.objectContaining({ line: 2 }),
      ]),
    );
  });

  test("lock contention is an actionable io error and the lock is not stolen", async () => {
    const lockPath = join(home, "tasks.jsonl.lock");
    await writeFile(lockPath, "held\n", "utf8");
    const result = await invoke(["add", "blocked", "--json"]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: {
        code: "io",
        message: expect.stringContaining(lockPath),
        next_step: expect.stringContaining("手動削除"),
      },
    });
    expect(await Bun.file(lockPath).text()).toBe("held\n");
  });
});
