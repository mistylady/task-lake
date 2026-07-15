import { describe, expect, test } from "bun:test";

import {
  addTask,
  doneTask,
  editTask,
  listTasks,
  removeTask,
  reopenTask,
  showTask,
} from "../src/core";
import type { Task } from "../src/types";

const CREATED = "2026-07-15T21:30:00+09:00";
const CLOSED = "2026-07-16T08:00:00+09:00";

const task = (id: string, overrides: Record<string, unknown> = {}): Task =>
  ({
    id,
    title: `task ${id}`,
    status: "open",
    labels: [],
    created: CREATED,
    ...overrides,
  }) as Task;

const valueOf = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!result.ok) throw new Error(`unexpected error: ${JSON.stringify(result.error)}`);
  return result.value;
};

describe("addTask", () => {
  test("uses max ID across open and done tasks plus one", () => {
    const existing = [
      task("9"),
      task("15", { status: "done", closed: CLOSED, extension: "keep" }),
    ];
    const result = valueOf(
      addTask(existing, {
        title: "new",
        note: "details",
        due: "2026-07-20",
        labels: ["a", "a", "b"],
        created: CREATED,
      }),
    );

    expect(result.changed).toBe(true);
    expect(result.task).toEqual({
      id: "16",
      title: "new",
      note: "details",
      status: "open",
      due: "2026-07-20",
      labels: ["a", "b"],
      created: CREATED,
    });
    expect(result.tasks).toHaveLength(3);
    expect(existing).toHaveLength(2);
  });

  test("omits optional keys and rejects an empty title or impossible due date", () => {
    const added = valueOf(addTask([], { title: "minimal", created: CREATED }));
    expect(added.task).not.toHaveProperty("note");
    expect(added.task).not.toHaveProperty("due");
    expect(added.task).not.toHaveProperty("closed");

    const empty = addTask([], { title: "", created: CREATED });
    expect(empty.ok ? undefined : empty.error.code).toBe("validation");
    const badDue = addTask([], { title: "x", due: "2026-02-31", created: CREATED });
    expect(badDue.ok ? undefined : badDue.error.code).toBe("validation");
  });
});

describe("listTasks", () => {
  test("defaults to open, due ascending, no due last, then ID ascending", () => {
    const tasks = [
      task("5"),
      task("3", { due: "2026-08-01", note: "secret", extension: 42 }),
      task("2", { due: "2026-07-20" }),
      task("1", { due: "2026-07-20" }),
      task("4", { status: "done", closed: CLOSED }),
    ];
    const result = valueOf(listTasks(tasks));
    expect(result.total).toBe(4);
    expect(result.items.map(({ id }) => id)).toEqual(["1", "2", "3", "5"]);
    expect(result.items[2]).not.toHaveProperty("note");
    expect(result.items[2]?.has_note).toBe(true);
    expect(result.items[2]?.extension).toBe(42);
    expect(result.items[0]?.has_note).toBe(false);
  });

  test("--all sorts by descending ID and defaults to 50 after sorting", () => {
    const tasks = Array.from({ length: 55 }, (_, index) => task(String(index + 1)));
    const result = valueOf(listTasks(tasks, { all: true }));
    expect(result.total).toBe(55);
    expect(result.items).toHaveLength(50);
    expect(result.items[0]?.id).toBe("55");
    expect(result.items[49]?.id).toBe("6");

    const unlimited = valueOf(listTasks(tasks, { all: true, limit: 0 }));
    expect(unlimited.items).toHaveLength(55);
  });

  test("filters by every requested label and applies limit after sorting", () => {
    const tasks = [
      task("1", { due: "2026-07-30", labels: ["a", "b"] }),
      task("2", { due: "2026-07-20", labels: ["a", "b", "c"] }),
      task("3", { due: "2026-07-10", labels: ["a"] }),
    ];
    const result = valueOf(listTasks(tasks, { labels: ["a", "b"], limit: 1 }));
    expect(result.total).toBe(2);
    expect(result.items.map(({ id }) => id)).toEqual(["2"]);
  });
});

describe("showTask", () => {
  test("treats a numeric selector only as an exact ID", () => {
    const result = showTask([task("1", { title: "ticket 12" })], "12");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  test("returns one title-fragment match and reports sorted candidates for ambiguity", () => {
    const tasks = [
      task("10", { title: "メールを送る" }),
      task("2", { title: "メールを読む" }),
      task("3", { title: "電話する", note: "full" }),
    ];
    expect(valueOf(showTask(tasks, "電話")).note).toBe("full");

    const ambiguous = showTask(tasks, "メール");
    expect(ambiguous.ok).toBe(false);
    if (ambiguous.ok) return;
    expect(ambiguous.error.code).toBe("ambiguous");
    expect(ambiguous.error.candidates?.map(({ id }) => id)).toEqual(["2", "10"]);
  });
});

describe("doneTask and reopenTask", () => {
  test("done appends a note on transition and keeps unknown fields", () => {
    const source = task("1", { note: "before", future: { x: 1 } });
    const result = valueOf(doneTask([source], "1", { closed: CLOSED, note: "after" }));
    expect(result.changed).toBe(true);
    expect(result.task).toMatchObject({
      status: "done",
      closed: CLOSED,
      note: "before\nafter",
      future: { x: 1 },
    });
    expect(source.status).toBe("open");
    expect(source).not.toHaveProperty("closed");
  });

  test("done on a done task is a complete no-op, including --note", () => {
    const source = task("1", { status: "done", closed: CLOSED, note: "once" });
    const result = valueOf(
      doneTask([source], "1", { closed: "invalid-but-unused", note: "again" }),
    );
    expect(result.changed).toBe(false);
    expect(result.task?.note).toBe("once");
    expect(result.tasks[0]?.note).toBe("once");
  });

  test("reopen clears closed and is idempotent for an open task", () => {
    const done = task("1", { status: "done", closed: CLOSED, extension: true });
    const reopened = valueOf(reopenTask([done], "1"));
    expect(reopened.changed).toBe(true);
    expect(reopened.task?.status).toBe("open");
    expect(reopened.task).not.toHaveProperty("closed");
    expect(reopened.task?.extension).toBe(true);

    const again = valueOf(reopenTask(reopened.tasks, "1"));
    expect(again.changed).toBe(false);
  });

  test("mutation selectors reject titles and done/reopen report missing IDs", () => {
    const invalid = doneTask([task("1")], "task 1", { closed: CLOSED });
    expect(invalid.ok ? undefined : invalid.error.code).toBe("usage");
    const missingDone = doneTask([task("1")], "2", { closed: CLOSED });
    expect(missingDone.ok ? undefined : missingDone.error.code).toBe("not_found");
    const missingReopen = reopenTask([task("1")], "2");
    expect(missingReopen.ok ? undefined : missingReopen.error.code).toBe("not_found");
  });
});

describe("editTask", () => {
  test("edits all supported fields by immutable differential operations", () => {
    const source = task("1", {
      title: "old",
      note: "old note",
      due: "2026-07-20",
      labels: ["keep", "remove"],
      future: "preserved",
    });
    const edited = valueOf(
      editTask([source], "1", {
        title: "new",
        due: "2026-08-01",
        note: "replacement",
        removeLabels: ["remove"],
        addLabels: ["added", "added"],
      }),
    );
    expect(edited.changed).toBe(true);
    expect(edited.task).toMatchObject({
      title: "new",
      due: "2026-08-01",
      note: "replacement",
      labels: ["keep", "added"],
      future: "preserved",
    });
    expect(source.title).toBe("old");
  });

  test("clears due/note, replaces labels, and reports semantic no-ops", () => {
    const source = task("1", { due: "2026-07-20", note: "x", labels: ["a"] });
    const cleared = valueOf(
      editTask([source], "1", { clearDue: true, clearNote: true, setLabels: [] }),
    );
    expect(cleared.task).not.toHaveProperty("due");
    expect(cleared.task).not.toHaveProperty("note");
    expect(cleared.task?.labels).toEqual([]);

    const noOp = valueOf(editTask([task("2", { labels: ["a"] })], "2", { addLabels: ["a"] }));
    expect(noOp.changed).toBe(false);
  });

  test("rejects invalid values and conflicting operations", () => {
    const source = [task("1")];
    const title = editTask(source, "1", { title: "" });
    expect(title.ok ? undefined : title.error.code).toBe("validation");
    const due = editTask(source, "1", { due: "2026-02-31" });
    expect(due.ok ? undefined : due.error.code).toBe("validation");
    const clearConflict = editTask(source, "1", { due: "2026-07-20", clearDue: true });
    expect(clearConflict.ok ? undefined : clearConflict.error.code).toBe("usage");
    const labelConflict = editTask(source, "1", { setLabels: [], addLabels: ["x"] });
    expect(labelConflict.ok ? undefined : labelConflict.error.code).toBe("usage");
  });
});

describe("removeTask", () => {
  test("physically removes an exact ID and returns the removed task", () => {
    const source = [task("1"), task("2", { extension: true })];
    const result = valueOf(removeTask(source, "2"));
    expect(result.changed).toBe(true);
    expect(result.task?.id).toBe("2");
    expect(result.task?.extension).toBe(true);
    expect(result.tasks.map(({ id }) => id)).toEqual(["1"]);
    expect(source).toHaveLength(2);
  });

  test("a missing numeric ID is successful and idempotent", () => {
    const result = valueOf(removeTask([task("1")], "99"));
    expect(result.changed).toBe(false);
    expect(result.task).toBeNull();
    expect(result.tasks.map(({ id }) => id)).toEqual(["1"]);
  });
});
