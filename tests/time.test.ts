import { describe, expect, test } from "bun:test";
import { formatLocalDate, formatOffsetTimestamp } from "../src/time.ts";

describe("time formatting", () => {
  test("formats local calendar dates without UTC conversion", () => {
    const date = new Date(2026, 1, 3, 4, 5, 6);
    expect(formatLocalDate(date)).toBe("2026-02-03");
  });

  test("formats timestamps with seconds and an explicit numeric offset", () => {
    const date = new Date(2026, 1, 3, 4, 5, 6);
    expect(formatOffsetTimestamp(date)).toMatch(
      /^2026-02-03T04:05:06(?:\+|-)\d{2}:\d{2}$/,
    );
  });
});
