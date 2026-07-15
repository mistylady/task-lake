import { describe, expect, test } from "bun:test";
import {
  COMMAND_NAMES,
  COMMAND_SPECS,
  GLOBAL_OPTIONS,
  commandUsage,
  createCommandDescription,
  describeAll,
  describeCommand,
  describeSummary,
  getCommandSpec,
  getEffectiveOptions,
  renderCommandHelp,
  renderDescribeAll,
  renderDescribeSummary,
  renderGlobalHelp,
} from "../src/command-spec";

describe("CommandSpec", () => {
  test("defines each of the nine commands exactly once", () => {
    expect(COMMAND_SPECS.map(({ name }) => name)).toEqual([...COMMAND_NAMES]);
    expect(new Set(COMMAND_SPECS.map(({ name }) => name)).size).toBe(9);
  });

  test("has unique long names and aliases within every command", () => {
    for (const spec of COMMAND_SPECS) {
      const options = getEffectiveOptions(spec);
      const longNames = options.map(({ name }) => name);
      const aliases = options.flatMap(({ aliases: values }) => values);
      expect(new Set(longNames).size).toBe(longNames.length);
      expect(new Set(aliases).size).toBe(aliases.length);
    }
  });

  test("makes --json and --help effective for every command", () => {
    expect(GLOBAL_OPTIONS.map(({ name }) => name)).toEqual(["json", "help"]);
    for (const spec of COMMAND_SPECS) {
      expect(getEffectiveOptions(spec).map(({ name }) => name)).toContain("json");
      expect(getEffectiveOptions(spec).map(({ name }) => name)).toContain("help");
    }
  });

  test("models all explicitly repeatable and conflicting flags", () => {
    const add = getCommandSpec("add");
    const edit = getCommandSpec("edit");
    expect(add?.options.find(({ name }) => name === "label")).toMatchObject({
      kind: "value",
      repeatable: true,
      aliases: ["-l"],
    });
    expect(edit?.options.find(({ name }) => name === "add-label")).toMatchObject({
      repeatable: true,
      conflicts: ["set-labels"],
    });
    expect(edit?.options.find(({ name }) => name === "due")).toMatchObject({
      conflicts: ["clear-due"],
    });
  });

  test("records required versus optional positional arguments", () => {
    expect(getCommandSpec("add")?.arguments[0]).toMatchObject({
      name: "title",
      required: true,
    });
    expect(getCommandSpec("describe")?.arguments[0]).toMatchObject({
      name: "command",
      required: false,
    });
  });
});

describe("help generation", () => {
  test("renders the global command list from CommandSpec", () => {
    const help = renderGlobalHelp();
    for (const spec of COMMAND_SPECS) {
      expect(help).toContain(spec.name);
      expect(help).toContain(spec.summary);
    }
    expect(help).toContain("--json");
    expect(help).toContain("--help");
  });

  test("renders command usage, arguments, flags, constraints and example", () => {
    const help = renderCommandHelp("edit");
    expect(help).toContain("Usage: tlk edit <id> [options]");
    expect(help).toContain("--add-label <label>");
    expect(help).toContain("--clear-note");
    expect(help).toContain("同時指定不可");
    expect(help).toContain("tlk edit 12");
  });

  test("uses a custom program name without changing the spec", () => {
    const add = getCommandSpec("add");
    if (add === undefined) {
      throw new Error("missing add spec");
    }
    expect(commandUsage(add, "task-lake")).toBe("task-lake add <title> [options]");
    expect(renderCommandHelp(add, "task-lake")).toContain(
      "Usage: task-lake add <title> [options]",
    );
  });
});

describe("describe generation", () => {
  test("default description contains names and summaries only", () => {
    const description = describeSummary();
    expect(description.commands).toHaveLength(9);
    expect(Object.keys(description.commands[0] ?? {}).sort()).toEqual(["name", "summary"]);
    expect(renderDescribeSummary().split("\n")).toHaveLength(9);
  });

  test("single-command description is derived from its CommandSpec", () => {
    const spec = getCommandSpec("list");
    const description = describeCommand("list");
    if (spec === undefined || description === undefined) {
      throw new Error("missing list description");
    }

    expect(description).toEqual(createCommandDescription(spec));
    expect(description.flags.map(({ name }) => name)).toEqual([
      "--all",
      "--limit",
      "--label",
      "--json",
      "--help",
    ]);
    expect(description.input_example).toBe(spec.example.input);
    expect(description.output_example).toBe(spec.example.output);
  });

  test("all-description contains detailed specs only when requested", () => {
    const all = describeAll();
    expect(all.commands).toHaveLength(9);
    expect(all.commands.every(({ input_example }) => input_example.startsWith("tlk "))).toBe(true);
    expect(renderDescribeAll()).toContain("validate - JSONLデータを読み取り専用で診断する");
  });

  test("returns undefined for an unknown single-command description", () => {
    expect(describeCommand("unknown")).toBeUndefined();
  });

  test("examples are deterministic JSON values", () => {
    const first = JSON.stringify(describeAll());
    const second = JSON.stringify(describeAll());
    expect(first).toBe(second);
    expect(first).not.toContain("undefined");
  });
});
