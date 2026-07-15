import { describe, expect, test } from "bun:test";
import {
  detectJsonFlag,
  getArgument,
  getBooleanOption,
  getNumberOption,
  getRepeatedOption,
  getStringOption,
  parseArgs,
  type ParsedCommandInvocation,
} from "../src/parser";

const parsedCommand = (argv: readonly string[]): ParsedCommandInvocation => {
  const result = parseArgs(argv);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  if (result.value.kind !== "command") {
    throw new Error("expected a command invocation");
  }
  return result.value;
};

describe("parseArgs", () => {
  test.each([
    [["add", "title"], "add"],
    [["list"], "list"],
    [["show", "mail"], "show"],
    [["done", "12"], "done"],
    [["reopen", "12"], "reopen"],
    [["edit", "12", "--title", "new title"], "edit"],
    [["rm", "12"], "rm"],
    [["describe"], "describe"],
    [["validate"], "validate"],
  ] as const)("parses %p as %s", (argv, command) => {
    expect(parsedCommand(argv).command).toBe(command);
  });

  test("accepts common flags before and after a command", () => {
    const before = parsedCommand(["--json", "list"]);
    const after = parsedCommand(["list", "--json", "--help"]);

    expect(before.json).toBe(true);
    expect(before.help).toBe(false);
    expect(after.json).toBe(true);
    expect(after.help).toBe(true);
  });

  test("represents --help without a command as global help", () => {
    expect(parseArgs(["--json", "--help"])).toEqual({
      ok: true,
      value: { kind: "global-help", json: true, help: true },
    });
  });

  test("normalizes positional arguments and value flags", () => {
    const result = parsedCommand([
      "add",
      "設定値を確認する",
      "--note",
      "詳細",
      "--due=2026-07-20",
    ]);

    expect(getArgument(result, "title")).toBe("設定値を確認する");
    expect(getStringOption(result, "note")).toBe("詳細");
    expect(getStringOption(result, "due")).toBe("2026-07-20");
  });

  test("collects repeatable short and long label flags in order", () => {
    const result = parsedCommand([
      "add",
      "task",
      "-l",
      "redmine:1234",
      "--label",
      "local",
    ]);

    expect(getRepeatedOption(result, "label")).toEqual(["redmine:1234", "local"]);
  });

  test("collects repeated edit label operations independently", () => {
    const result = parsedCommand([
      "edit",
      "12",
      "--add-label",
      "a",
      "--add-label=b",
      "--remove-label",
      "old",
    ]);

    expect(getRepeatedOption(result, "add-label")).toEqual(["a", "b"]);
    expect(getRepeatedOption(result, "remove-label")).toEqual(["old"]);
  });

  test("parses --limit as a safe non-negative integer", () => {
    const limited = parsedCommand(["list", "--all", "--limit", "0"]);

    expect(getBooleanOption(limited, "all")).toBe(true);
    expect(getNumberOption(limited, "limit")).toBe(0);
  });

  test("allows a flag-looking positional after the option terminator", () => {
    const result = parsedCommand(["add", "--", "--not-a-flag"]);
    expect(result.args.title).toBe("--not-a-flag");
    expect(result.json).toBe(false);
  });

  test("accepts '-' as a note value for stdin", () => {
    expect(getStringOption(parsedCommand(["done", "12", "--note", "-"]), "note")).toBe(
      "-",
    );
  });

  test("help bypasses required arguments and command constraints", () => {
    expect(parsedCommand(["add", "--help"]).help).toBe(true);
    expect(parsedCommand(["edit", "--help"]).help).toBe(true);
  });

  test.each([
    [[], "コマンドを指定"],
    [["wat"], "不明なコマンド"],
    [["--wat"], "不明なオプション"],
    [["add"], "必須引数"],
    [["done", "title"], "純数値のID"],
    [["list", "--limit", "-1"], "0以上の整数"],
    [["list", "--limit", "1.5"], "0以上の整数"],
    [["show", "one", "two"], "余分な引数"],
    [["add", "task", "--due"], "値が必要"],
    [["add", "task", "--note", "--unknown"], "値が必要"],
    [["add", "task", "--json", "--json"], "複数回"],
    [["describe", "unknown"], "不明なコマンド"],
  ] as const)("returns a structured usage error for %p", (argv, message) => {
    const result = parseArgs(argv);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("usage");
    expect(result.error.message).toContain(message);
    expect(result.error.next_step).toContain("--help");
  });

  test.each([
    ["--due", "--clear-due"],
    ["--note", "--clear-note"],
    ["--set-labels", "--add-label"],
    ["--set-labels", "--remove-label"],
  ] as const)("rejects conflicting edit flags %s and %s", (left, right) => {
    const leftValue = left === "--due" ? "2026-07-20" : left === "--note" ? "n" : "a,b";
    const rightValue =
      right === "--add-label" || right === "--remove-label" ? ["x"] : [];
    const result = parseArgs(["edit", "12", left, leftValue, right, ...rightValue]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("usage");
      expect(result.error.message).toContain("同時指定");
    }
  });

  test("requires at least one actual edit option", () => {
    const result = parseArgs(["edit", "12", "--json"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("1つ以上");
    }
  });

  test("rejects describe command and --all together", () => {
    const result = parseArgs(["describe", "add", "--all"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("同時指定");
    }
  });
});

describe("detectJsonFlag", () => {
  test("detects an exact JSON flag even if parsing later fails", () => {
    expect(detectJsonFlag(["done", "bad-id", "--json"])).toBe(true);
    expect(detectJsonFlag(["done", "bad-id", "--json=true"])).toBe(false);
  });

  test("does not treat data after -- as a JSON flag", () => {
    expect(detectJsonFlag(["add", "--", "--json"])).toBe(false);
  });
});
