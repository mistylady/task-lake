import { describe, expect, test } from "bun:test";

import type { Task } from "../src/types";
import {
  diagnoseJsonl,
  isValidDue,
  isValidTimestamp,
  parseAndValidateJsonl,
  serializeJsonl,
  validateTasks,
} from "../src/validation";

const CREATED = "2026-07-15T21:30:00+09:00";

const task = (id: string, overrides: Record<string, unknown> = {}): Task =>
  ({
    id,
    title: `task ${id}`,
    status: "open",
    labels: [],
    created: CREATED,
    ...overrides,
  }) as Task;

describe("date and timestamp validation", () => {
  test("accepts only real YYYY-MM-DD calendar dates", () => {
    expect(isValidDue("2024-02-29")).toBe(true);
    expect(isValidDue("2026-02-29")).toBe(false);
    expect(isValidDue("2026-02-31")).toBe(false);
    expect(isValidDue("2026-2-01")).toBe(false);
    expect(isValidDue("0000-01-01")).toBe(false);
  });

  test("accepts the fixed offset-bearing ISO timestamp form", () => {
    expect(isValidTimestamp(CREATED)).toBe(true);
    expect(isValidTimestamp("2024-02-29T00:00:00-14:00")).toBe(true);
    expect(isValidTimestamp("2026-07-15T21:30:00Z")).toBe(false);
    expect(isValidTimestamp("2026-07-15T21:30:00.000+09:00")).toBe(false);
    expect(isValidTimestamp("2026-07-15T24:00:00+09:00")).toBe(false);
    expect(isValidTimestamp("2026-07-15T21:30:00+14:01")).toBe(false);
  });
});

describe("task validation", () => {
  test("normalizes legacy null optional fields and preserves unknown fields", () => {
    const result = validateTasks([
      task("1", { note: null, due: null, closed: null, extension: { value: 3 } }),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const normalized = result.value[0];
    expect(normalized).toEqual({
      id: "1",
      title: "task 1",
      status: "open",
      labels: [],
      created: CREATED,
      extension: { value: 3 },
    });
    expect("note" in (normalized as Task)).toBe(false);
    expect("due" in (normalized as Task)).toBe(false);
    expect("closed" in (normalized as Task)).toBe(false);
  });

  test("requires status=done exactly when a valid closed timestamp exists", () => {
    const report = validateTasks([
      task("1", { status: "done" }),
      task("2", { closed: CREATED }),
      task("3", { status: "done", closed: "not-a-time" }),
    ]);
    expect(report.ok).toBe(false);
    if (report.ok) return;
    expect(report.error.code).toBe("validation");
    expect(report.error.issues?.map(({ line }) => line)).toEqual([1, 2, 3, 3]);
  });

  test("rejects duplicate IDs and reports the duplicate line", () => {
    const result = validateTasks([task("7"), task("7")]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.line).toBe(2);
    expect(result.error.message).toContain("重複");
    expect(result.error.issues?.[0]?.field).toBe("id");
  });

  test("still diagnoses duplicate IDs when another known field is invalid", () => {
    const result = validateTasks([task("7", { due: "invalid" }), task("7")]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.issues?.some(({ message }) => message.includes("重複"))).toBe(true);
  });

  test("rejects every invalid known field rather than silently skipping the row", () => {
    const result = validateTasks([
      {
        id: "x",
        title: "",
        status: "waiting",
        note: 1,
        due: "2026-02-31",
        labels: ["ok", 2],
        created: "2026-07-15",
        closed: false,
      },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const fields = result.error.issues?.map(({ field }) => field);
    expect(fields).toContain("id");
    expect(fields).toContain("title");
    expect(fields).toContain("status");
    expect(fields).toContain("note");
    expect(fields).toContain("due");
    expect(fields).toContain("labels");
    expect(fields).toContain("created");
    expect(fields).toContain("closed");
  });
});

describe("JSONL validation", () => {
  test("parses valid lines, keeps unknown fields, and serializes with a final newline", () => {
    const raw = `${JSON.stringify(task("1", { future: true }))}\n${JSON.stringify(
      task("2", { status: "done", closed: CREATED }),
    )}\n`;
    const parsed = parseAndValidateJsonl(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value[0]?.future).toBe(true);
    expect(serializeJsonl(parsed.value)).toBe(raw);
  });

  test("reports parse failures and an interior blank line with their physical lines", () => {
    const report = diagnoseJsonl(`${JSON.stringify(task("1"))}\n\n{broken}\n`);
    expect(report.valid).toBe(false);
    expect(report.task_count).toBe(1);
    expect(report.issues.map(({ line }) => line)).toEqual([2, 3]);
  });

  test("an empty file is valid", () => {
    expect(diagnoseJsonl("")).toEqual({ valid: true, task_count: 0, issues: [] });
    expect(serializeJsonl([])).toBe("");
  });
});
