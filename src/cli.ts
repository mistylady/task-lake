import {
  describeAll,
  describeCommand,
  describeSummary,
  renderCommandHelp,
  renderDescribeAll,
  renderDescribeSummary,
  renderGlobalHelp,
} from "./command-spec.ts";
import {
  addTask,
  doneTask,
  editTask,
  listTasks,
  reopenTask,
  removeTask,
  showTask,
  type EditTaskInput,
} from "./core.ts";
import {
  detectJsonFlag,
  getArgument,
  getBooleanOption,
  getNumberOption,
  getRepeatedOption,
  getStringOption,
  parseArgs,
  type ParsedCommandInvocation,
} from "./parser.ts";
import {
  EXIT_CODES,
  formatList,
  formatMutation,
  formatTask,
  formatValidation,
  writeError,
  writeJson,
  writeText,
} from "./output.ts";
import {
  diagnoseTasks,
  loadTasks,
  withWriteTransaction,
  type StorageOptions,
} from "./storage.ts";
import { formatLocalDate, formatOffsetTimestamp } from "./time.ts";
import { err, ok, type MutationResult, type Result, type TaskLakeError } from "./types.ts";
import { validationIssuesToError } from "./validation.ts";

export interface CliIo {
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
  readonly readStdin: () => Promise<string>;
  readonly stdoutIsTTY: boolean;
  readonly now: () => Date;
  readonly storage?: StorageOptions;
}

const trimOneLineEnding = (value: string): string => {
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n")) return value.slice(0, -1);
  return value;
};

const noteValue = async (
  value: string | undefined,
  readStdin: () => Promise<string>,
): Promise<Result<string | undefined>> => {
  if (value !== "-") return ok(value);
  try {
    return ok(trimOneLineEnding(await readStdin()));
  } catch (cause) {
    return err({
      code: "io",
      message: `stdin からnoteを読み込めません: ${cause instanceof Error ? cause.message : String(cause)}`,
      next_step: "stdinを確認するか、--note にテキストを直接指定してください",
    });
  }
};

const fail = (io: CliIo, error: TaskLakeError, json: boolean): number => {
  writeError(io.writeStderr, error, json);
  return EXIT_CODES[error.code];
};

const mutationEnvelope = (
  result: MutationResult,
): Readonly<{ changed: boolean; task: MutationResult["task"] }> => ({
  changed: result.changed,
  task: result.task,
});

const outputMutation = (
  io: CliIo,
  result: MutationResult,
  json: boolean,
): number => {
  if (json) writeJson(io.writeStdout, mutationEnvelope(result));
  else writeText(io.writeStdout, formatMutation(result));
  return 0;
};

const outputHelp = (io: CliIo, invocation: ParsedCommandInvocation): number => {
  if (invocation.json) {
    const description = describeCommand(invocation.command);
    writeJson(io.writeStdout, description ?? describeSummary());
  } else {
    writeText(io.writeStdout, renderCommandHelp(invocation.command));
  }
  return 0;
};

const outputDescribe = (
  io: CliIo,
  invocation: ParsedCommandInvocation,
): number => {
  const command = getArgument(invocation, "command");
  const all = getBooleanOption(invocation, "all");
  if (all) {
    if (invocation.json) writeJson(io.writeStdout, describeAll());
    else writeText(io.writeStdout, renderDescribeAll());
    return 0;
  }
  if (command !== undefined) {
    const description = describeCommand(command);
    // The parser validates command-name positionals, so this is defensive only.
    if (description === undefined) {
      return fail(
        io,
        {
          code: "usage",
          message: `不明なコマンドです: ${command}`,
          next_step: "tlk describe でコマンド一覧を確認してください",
        },
        invocation.json,
      );
    }
    if (invocation.json) writeJson(io.writeStdout, description);
    else writeText(io.writeStdout, renderCommandHelp(description.name));
    return 0;
  }

  if (invocation.json) writeJson(io.writeStdout, describeSummary());
  else writeText(io.writeStdout, renderDescribeSummary());
  return 0;
};

const outputReadCommand = async (
  io: CliIo,
  invocation: ParsedCommandInvocation,
): Promise<number> => {
  if (invocation.command === "validate") {
    const diagnosed = await diagnoseTasks(io.storage);
    if (!diagnosed.ok) return fail(io, diagnosed.error, invocation.json);
    if (!diagnosed.value.valid) {
      return fail(io, validationIssuesToError(diagnosed.value.issues), invocation.json);
    }
    if (invocation.json) writeJson(io.writeStdout, diagnosed.value);
    else writeText(io.writeStdout, formatValidation(diagnosed.value));
    return 0;
  }

  const loaded = await loadTasks(io.storage);
  if (!loaded.ok) return fail(io, loaded.error, invocation.json);

  if (invocation.command === "list") {
    const limit = getNumberOption(invocation, "limit");
    const listed = listTasks(loaded.value, {
      all: getBooleanOption(invocation, "all"),
      ...(limit === undefined ? {} : { limit }),
      labels: getRepeatedOption(invocation, "label"),
    });
    if (!listed.ok) return fail(io, listed.error, invocation.json);
    if (invocation.json) writeJson(io.writeStdout, listed.value);
    else
      writeText(
        io.writeStdout,
        formatList(listed.value, formatLocalDate(io.now()), io.stdoutIsTTY),
      );
    return 0;
  }

  const shown = showTask(loaded.value, getArgument(invocation, "selector") ?? "");
  if (!shown.ok) return fail(io, shown.error, invocation.json);
  if (invocation.json) writeJson(io.writeStdout, shown.value);
  else writeText(io.writeStdout, formatTask(shown.value));
  return 0;
};

const setLabelsValue = (value: string | undefined): readonly string[] | undefined =>
  value === undefined ? undefined : value.length === 0 ? [] : value.split(",");

const mutationResult = async (
  io: CliIo,
  invocation: ParsedCommandInvocation,
): Promise<Result<MutationResult>> => {
  const rawNote = getStringOption(invocation, "note");
  const note = await noteValue(rawNote, io.readStdin);
  if (!note.ok) return note;
  const timestamp = formatOffsetTimestamp(io.now());
  const storage = io.storage;

  switch (invocation.command) {
    case "add": {
      const due = getStringOption(invocation, "due");
      return await withWriteTransaction(
        (tasks, nextId) =>
          addTask(tasks, {
            title: getArgument(invocation, "title") ?? "",
            ...(note.value === undefined ? {} : { note: note.value }),
            ...(due === undefined ? {} : { due }),
            labels: getRepeatedOption(invocation, "label"),
            created: timestamp,
            nextId,
          }),
        storage,
      );
    }
    case "done":
      return await withWriteTransaction(
        (tasks) =>
          doneTask(tasks, getArgument(invocation, "id") ?? "", {
            closed: timestamp,
            ...(note.value === undefined ? {} : { note: note.value }),
          }),
        storage,
      );
    case "reopen":
      return await withWriteTransaction(
        (tasks) => reopenTask(tasks, getArgument(invocation, "id") ?? ""),
        storage,
      );
    case "edit": {
      const title = getStringOption(invocation, "title");
      const due = getStringOption(invocation, "due");
      const setLabels = setLabelsValue(getStringOption(invocation, "set-labels"));
      const input: EditTaskInput = {
        ...(title === undefined ? {} : { title }),
        ...(due === undefined ? {} : { due }),
        ...(getBooleanOption(invocation, "clear-due") ? { clearDue: true } : {}),
        ...(note.value === undefined ? {} : { note: note.value }),
        ...(getBooleanOption(invocation, "clear-note") ? { clearNote: true } : {}),
        ...(getRepeatedOption(invocation, "add-label").length === 0
          ? {}
          : { addLabels: getRepeatedOption(invocation, "add-label") }),
        ...(getRepeatedOption(invocation, "remove-label").length === 0
          ? {}
          : { removeLabels: getRepeatedOption(invocation, "remove-label") }),
        ...(setLabels === undefined ? {} : { setLabels }),
      };
      return await withWriteTransaction(
        (tasks) => editTask(tasks, getArgument(invocation, "id") ?? "", input),
        storage,
      );
    }
    case "rm":
      return await withWriteTransaction(
        (tasks) => removeTask(tasks, getArgument(invocation, "id") ?? ""),
        storage,
      );
    default:
      return err({
        code: "internal",
        message: `変更コマンドを実行できません: ${invocation.command}`,
        next_step: "tlk --help で利用可能なコマンドを確認してください",
      });
  }
};

const execute = async (
  argv: readonly string[],
  io: CliIo,
): Promise<number> => {
  const parsed = parseArgs(argv);
  if (!parsed.ok) return fail(io, parsed.error, detectJsonFlag(argv));
  if (parsed.value.kind === "global-help") {
    if (parsed.value.json) writeJson(io.writeStdout, describeSummary());
    else writeText(io.writeStdout, renderGlobalHelp());
    return 0;
  }

  const invocation = parsed.value;
  if (invocation.help) return outputHelp(io, invocation);
  if (invocation.command === "describe") return outputDescribe(io, invocation);
  if (
    invocation.command === "list" ||
    invocation.command === "show" ||
    invocation.command === "validate"
  ) {
    return await outputReadCommand(io, invocation);
  }

  const mutation = await mutationResult(io, invocation);
  return mutation.ok
    ? outputMutation(io, mutation.value, invocation.json)
    : fail(io, mutation.error, invocation.json);
};

export const runCli = async (
  argv: readonly string[],
  io: CliIo,
): Promise<number> => {
  const json = detectJsonFlag(argv);
  try {
    return await execute(argv, io);
  } catch (cause) {
    return fail(
      io,
      {
        code: "internal",
        message: `予期しない内部エラーが発生しました: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        next_step: "同じ操作を再実行し、解消しない場合はtlkの不具合として報告してください",
      },
      json,
    );
  }
};
