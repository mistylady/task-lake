import { afterEach, describe, expect, test } from "bun:test";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  diagnoseTasks,
  loadTasks,
  resolveStoragePaths,
  resolveTaskLakeHome,
  withWriteTransaction,
} from "../src/storage";
import type { Task } from "../src/types";

const temporaryDirectories: string[] = [];

const makeTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "task-lake-storage-"));
  temporaryDirectories.push(directory);
  return directory;
};

const task = (overrides: Partial<Task> = {}): Task => ({
  id: "1",
  title: "before",
  status: "open",
  labels: ["local"],
  created: "2026-07-15T12:00:00+09:00",
  ...overrides,
});

const jsonl = (...tasks: readonly Task[]): string =>
  tasks.length === 0
    ? ""
    : `${tasks.map((value) => JSON.stringify(value)).join("\n")}\n`;

afterEach(async () => {
  const directories = temporaryDirectories.splice(0);
  await Promise.all(
    directories.map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("storage paths", () => {
  test("TASK_LAKE_HOME overrides the default home", () => {
    const actual = resolveTaskLakeHome(
      { TASK_LAKE_HOME: "/tmp/task-lake-explicit" },
      "/home/example",
    );
    expect(actual).toBe("/tmp/task-lake-explicit");
  });

  test("the default is .task-lake below the user home", () => {
    const actual = resolveTaskLakeHome({}, "/home/example");
    expect(actual).toBe("/home/example/.task-lake");
  });

  test("all files use the specified home and required names", () => {
    const paths = resolveStoragePaths({ home: "/tmp/lake" });
    expect(paths).toEqual({
      home: "/tmp/lake",
      dataFile: "/tmp/lake/tasks.jsonl",
      backupFile: "/tmp/lake/tasks.jsonl.bak",
      backupTempFile: "/tmp/lake/tasks.jsonl.bak.tmp",
      lockFile: "/tmp/lake/tasks.jsonl.lock",
    });
  });
});

describe("read-only storage", () => {
  test("a missing file is an empty lake and does not create the directory", async () => {
    const root = await makeTemporaryDirectory();
    const home = join(root, "not-created");

    const result = await loadTasks({ home });

    expect(result).toEqual({ ok: true, value: [] });
    await expect(access(home)).rejects.toThrow();
  });

  test("unknown fields survive parsing and optional null is canonicalized", async () => {
    const home = await makeTemporaryDirectory();
    const paths = resolveStoragePaths({ home });
    await writeFile(
      paths.dataFile,
      jsonl(task({ note: null as never, future_field: { nested: true } })),
      "utf8",
    );

    const result = await loadTasks({ home });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.future_field).toEqual({ nested: true });
      expect("note" in (result.value[0] ?? {})).toBe(false);
    }
  });

  test("malformed JSON stops loading with a line-numbered validation error", async () => {
    const home = await makeTemporaryDirectory();
    const paths = resolveStoragePaths({ home });
    await writeFile(paths.dataFile, `${jsonl(task())}{not-json}\n`, "utf8");

    const result = await loadTasks({ home });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation");
      expect(result.error.line).toBe(2);
      expect(result.error.next_step).toContain("tlk validate");
    }
  });

  test("diagnosis returns all detectable issues instead of failing at the first", async () => {
    const home = await makeTemporaryDirectory();
    const paths = resolveStoragePaths({ home });
    const invalidStatus = task({ id: "2", status: "invalid" as Task["status"] });
    await writeFile(
      paths.dataFile,
      `${jsonl(task())}{not-json}\n${jsonl(invalidStatus)}`,
      "utf8",
    );

    const result = await diagnoseTasks({ home });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.valid).toBe(false);
      expect(result.value.issues.map((issue) => issue.line)).toEqual([2, 3]);
    }
  });
});

describe("write transaction", () => {
  test("backs up the exact old file, atomically replaces data, and preserves unknown fields", async () => {
    const home = await makeTemporaryDirectory();
    const paths = resolveStoragePaths({ home });
    const oldRaw = jsonl(
      task({
        note: null as never,
        future_field: { owner: "newer-tlk" },
      }),
    );
    await writeFile(paths.dataFile, oldRaw, "utf8");

    const result = await withWriteTransaction(
      (tasks) => ({
        ok: true,
        value: {
          tasks: tasks.map((current) =>
            current.id === "1" ? { ...current, title: "after" } : current,
          ),
          changed: true,
        },
      }),
      { home },
    );

    expect(result.ok).toBe(true);
    expect(await readFile(paths.backupFile, "utf8")).toBe(oldRaw);

    const stored = await loadTasks({ home });
    expect(stored.ok).toBe(true);
    if (stored.ok) {
      expect(stored.value[0]?.title).toBe("after");
      expect(stored.value[0]?.future_field).toEqual({ owner: "newer-tlk" });
      expect("note" in (stored.value[0] ?? {})).toBe(false);
    }

    await expect(access(paths.lockFile)).rejects.toThrow();
    await expect(access(paths.backupTempFile)).rejects.toThrow();
    expect((await readdir(home)).some((name) => name.includes(".tmp-"))).toBe(
      false,
    );
  });

  test("creates the home, an empty backup, and the first data file", async () => {
    const root = await makeTemporaryDirectory();
    const home = join(root, "new-lake");
    const paths = resolveStoragePaths({ home });

    const result = await withWriteTransaction(
      () => ({
        ok: true,
        value: { tasks: [task()], changed: true },
      }),
      { home },
    );

    expect(result.ok).toBe(true);
    expect(await readFile(paths.backupFile, "utf8")).toBe("");
    expect(await readFile(paths.dataFile, "utf8")).toBe(jsonl(task()));
  });

  test("does not steal an existing lock and returns an actionable io error", async () => {
    const home = await makeTemporaryDirectory();
    const paths = resolveStoragePaths({ home });
    await writeFile(paths.lockFile, "owned elsewhere\n", "utf8");
    let transformed = false;

    const result = await withWriteTransaction(
      (tasks) => {
        transformed = true;
        return { ok: true, value: { tasks, changed: false } };
      },
      { home, lockRetryAttempts: 2, lockRetryDelayMs: 1 },
    );

    expect(transformed).toBe(false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("io");
      expect(result.error.message).toContain(paths.lockFile);
      expect(result.error.next_step).toContain("手動削除");
      expect(result.error.next_step).toContain(paths.lockFile);
    }
    expect(await readFile(paths.lockFile, "utf8")).toBe("owned elsewhere\n");
  });

  test("shell-quotes special characters in the manual lock removal command", async () => {
    const root = await makeTemporaryDirectory();
    const home = join(root, "lake-$(printf unsafe)-it's");
    await mkdir(home);
    const paths = resolveStoragePaths({ home });
    await writeFile(paths.lockFile, "owned elsewhere\n", "utf8");

    const result = await withWriteTransaction(
      (tasks) => ({ ok: true, value: { tasks, changed: false } }),
      { home, lockRetryAttempts: 1, lockRetryDelayMs: 0 },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.next_step).toContain("rm -- '");
      expect(result.error.next_step).toContain("$(printf unsafe)");
      expect(result.error.next_step).toContain("'\"'\"'");
    }
    expect(await readFile(paths.lockFile, "utf8")).toBe("owned elsewhere\n");
  });

  test("corruption aborts before backup or replacement and still releases the lock", async () => {
    const home = await makeTemporaryDirectory();
    const paths = resolveStoragePaths({ home });
    const corrupt = "{not-json}\n";
    await writeFile(paths.dataFile, corrupt, "utf8");
    let transformed = false;

    const result = await withWriteTransaction(
      (tasks) => {
        transformed = true;
        return { ok: true, value: { tasks, changed: false } };
      },
      { home },
    );

    expect(transformed).toBe(false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation");
      expect(result.error.line).toBe(1);
    }
    expect(await readFile(paths.dataFile, "utf8")).toBe(corrupt);
    await expect(access(paths.backupFile)).rejects.toThrow();
    await expect(access(paths.lockFile)).rejects.toThrow();
  });

  test("a transform error performs no write and releases the lock", async () => {
    const home = await makeTemporaryDirectory();
    const paths = resolveStoragePaths({ home });
    const oldRaw = jsonl(task());
    await writeFile(paths.dataFile, oldRaw, "utf8");

    const result = await withWriteTransaction(
      () => ({
        ok: false,
        error: {
          code: "validation",
          message: "rejected by core",
          line: 1,
        },
      }),
      { home },
    );

    expect(result.ok).toBe(false);
    expect(await readFile(paths.dataFile, "utf8")).toBe(oldRaw);
    await expect(access(paths.backupFile)).rejects.toThrow();
    await expect(access(paths.lockFile)).rejects.toThrow();
  });
});
