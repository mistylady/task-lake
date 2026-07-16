import {
  err,
  ok,
  type MutationResult,
  type Result,
  type Task,
  type TaskCandidate,
  type TaskLakeError,
  type TaskListItem,
  type TaskListResult,
} from "./types";
import {
  validateDue,
  validateTasks,
  validateTimestamp,
} from "./validation";

const NUMERIC_SELECTOR = /^\d+$/;

const usageError = (message: string, nextStep: string): TaskLakeError => ({
  code: "usage",
  message,
  next_step: nextStep,
});

const validationError = (
  message: string,
  field: string,
  nextStep: string,
): TaskLakeError => ({
  code: "validation",
  message,
  field,
  next_step: nextStep,
});

const notFoundError = (id: string): TaskLakeError => ({
  code: "not_found",
  message: `ID「${id}」のタスクが見つかりません`,
  next_step: "tlk list --json でIDを確認してください",
});

const validateMutationId = (id: string, command: string): Result<string> =>
  NUMERIC_SELECTOR.test(id)
    ? ok(id)
    : err(
        usageError(
          `${command} の対象IDは純数字で指定してください`,
          `tlk ${command} <id> のようにIDで再実行してください`,
        ),
      );

const compareIds = (left: string, right: string): number => {
  const leftId = BigInt(left);
  const rightId = BigInt(right);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
};

const stableUnique = (values: readonly string[]): readonly string[] => {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
};

const withoutKey = (task: Task, key: "due" | "note" | "closed"): Task => {
  const { [key]: _removed, ...rest } = task;
  return rest as Task;
};

const replaceTask = (
  tasks: readonly Task[],
  index: number,
  replacement: Task,
): readonly Task[] => tasks.map((task, taskIndex) => (taskIndex === index ? replacement : task));

export interface AddTaskInput {
  readonly title: string;
  readonly note?: string;
  readonly due?: string;
  readonly labels?: readonly string[];
  /** Offset-bearing ISO timestamp supplied by the I/O shell. */
  readonly created: string;
  readonly nextId: bigint;
}

export const addTask = (
  tasks: readonly Task[],
  input: AddTaskInput,
): Result<MutationResult> => {
  const validated = validateTasks(tasks);
  if (!validated.ok) return validated;

  if (typeof input.title !== "string" || input.title.length === 0) {
    return err(
      validationError(
        "title は空でない文字列でなければなりません",
        "title",
        "空でないタイトルを指定してください",
      ),
    );
  }
  if (input.note !== undefined && typeof input.note !== "string") {
    return err(
      validationError("note は文字列でなければなりません", "note", "note を文字列で指定してください"),
    );
  }
  if (
    input.labels !== undefined &&
    (!Array.isArray(input.labels) || !input.labels.every((label) => typeof label === "string"))
  ) {
    return err(
      validationError(
        "labels は文字列の配列でなければなりません",
        "labels",
        "ラベルを文字列で指定してください",
      ),
    );
  }
  if (input.due !== undefined) {
    const due = validateDue(input.due);
    if (!due.ok) return due;
  }
  const created = validateTimestamp(input.created);
  if (!created.ok) return created;

  const maxExisting = validated.value.reduce(
    (maximum, task) => {
      const current = BigInt(task.id);
      return current > maximum ? current : maximum;
    },
    0n,
  );
  const nextId = input.nextId > maxExisting ? input.nextId : maxExisting + 1n;

  const task: Task = {
    id: nextId.toString(),
    title: input.title,
    ...(input.note === undefined ? {} : { note: input.note }),
    status: "open",
    ...(input.due === undefined ? {} : { due: input.due }),
    labels: stableUnique(input.labels ?? []),
    created: input.created,
  };
  const nextTasks = [...validated.value, task];
  return ok({ tasks: nextTasks, changed: true, task, assignedId: nextId });
};

export interface ListTaskOptions {
  /** Include done tasks; also changes sorting and the default limit. */
  readonly all?: boolean;
  /** Zero means unlimited. */
  readonly limit?: number;
  /** A task must contain every requested label. */
  readonly labels?: readonly string[];
}

const toListItem = (task: Task): TaskListItem => {
  const { note: _note, ...withoutNote } = task;
  return {
    ...withoutNote,
    has_note: task.note !== undefined,
  } as TaskListItem;
};

export const listTasks = (
  tasks: readonly Task[],
  options: ListTaskOptions = {},
): Result<TaskListResult> => {
  const validated = validateTasks(tasks);
  if (!validated.ok) return validated;

  if (
    options.limit !== undefined &&
    (!Number.isSafeInteger(options.limit) || options.limit < 0)
  ) {
    return err(
      usageError(
        "--limit は0以上の整数で指定してください",
        "--limit 0（無制限）または正の整数を指定してください",
      ),
    );
  }
  if (
    options.labels !== undefined &&
    (!Array.isArray(options.labels) || !options.labels.every((label) => typeof label === "string"))
  ) {
    return err(usageError("-l は文字列で指定してください", "-l <label> の形式で指定してください"));
  }

  const includeAll = options.all === true;
  const labels = options.labels ?? [];
  const matching = validated.value.filter(
    (task) =>
      (includeAll || task.status === "open") &&
      labels.every((label) => task.labels.includes(label)),
  );
  const sorted = [...matching].sort((left, right) => {
    if (includeAll) return compareIds(right.id, left.id);
    if (left.due === undefined && right.due !== undefined) return 1;
    if (left.due !== undefined && right.due === undefined) return -1;
    if (left.due !== undefined && right.due !== undefined && left.due !== right.due) {
      return left.due < right.due ? -1 : 1;
    }
    return compareIds(left.id, right.id);
  });

  const defaultLimit = includeAll ? 50 : 0;
  const limit = options.limit ?? defaultLimit;
  const limited = limit === 0 ? sorted : sorted.slice(0, limit);
  return ok({ total: matching.length, items: limited.map(toListItem) });
};

const candidatesById = (tasks: readonly Task[]): readonly TaskCandidate[] =>
  [...tasks]
    .sort((left, right) => compareIds(left.id, right.id))
    .map(({ id, title }) => ({ id, title }));

export const showTask = (tasks: readonly Task[], selector: string): Result<Task> => {
  const validated = validateTasks(tasks);
  if (!validated.ok) return validated;

  if (selector.length === 0) {
    return err(usageError("show の検索条件が空です", "tlk show <id|タイトル断片> を指定してください"));
  }
  if (NUMERIC_SELECTOR.test(selector)) {
    const task = validated.value.find(({ id }) => id === selector);
    return task === undefined ? err(notFoundError(selector)) : ok(task);
  }

  const matches = validated.value.filter(({ title }) => title.includes(selector));
  if (matches.length === 0) {
    return err({
      code: "not_found",
      message: `タイトルに「${selector}」を含むタスクが見つかりません`,
      next_step: "tlk list --json でIDまたはタイトルを確認してください",
    });
  }
  if (matches.length > 1) {
    return err({
      code: "ambiguous",
      message: `「${selector}」に複数マッチしました`,
      candidates: candidatesById(matches),
      next_step: "tlk show <id> のようにIDで再実行してください",
    });
  }
  return ok(matches[0] as Task);
};

export interface DoneTaskInput {
  readonly closed: string;
  readonly note?: string;
}

const appendNote = (current: string | undefined, addition: string): string => {
  if (current === undefined || current.length === 0) return addition;
  if (addition.length === 0) return current;
  return `${current}\n${addition}`;
};

export const doneTask = (
  tasks: readonly Task[],
  id: string,
  input: DoneTaskInput,
): Result<MutationResult> => {
  const validated = validateTasks(tasks);
  if (!validated.ok) return validated;
  const validId = validateMutationId(id, "done");
  if (!validId.ok) return validId;

  const index = validated.value.findIndex((task) => task.id === id);
  if (index < 0) return err(notFoundError(id));
  const current = validated.value[index] as Task;
  if (current.status === "done") {
    return ok({ tasks: validated.value, changed: false, task: current });
  }

  const closed = validateTimestamp(input.closed);
  if (!closed.ok) return closed;
  if (input.note !== undefined && typeof input.note !== "string") {
    return err(
      validationError("note は文字列でなければなりません", "note", "note を文字列で指定してください"),
    );
  }

  const replacement: Task = {
    ...current,
    status: "done",
    closed: input.closed,
    ...(input.note === undefined ? {} : { note: appendNote(current.note, input.note) }),
  };
  const nextTasks = replaceTask(validated.value, index, replacement);
  return ok({ tasks: nextTasks, changed: true, task: replacement });
};

export const reopenTask = (
  tasks: readonly Task[],
  id: string,
): Result<MutationResult> => {
  const validated = validateTasks(tasks);
  if (!validated.ok) return validated;
  const validId = validateMutationId(id, "reopen");
  if (!validId.ok) return validId;

  const index = validated.value.findIndex((task) => task.id === id);
  if (index < 0) return err(notFoundError(id));
  const current = validated.value[index] as Task;
  if (current.status === "open") {
    return ok({ tasks: validated.value, changed: false, task: current });
  }

  const replacement: Task = {
    ...withoutKey(current, "closed"),
    status: "open",
  };
  const nextTasks = replaceTask(validated.value, index, replacement);
  return ok({ tasks: nextTasks, changed: true, task: replacement });
};

export interface EditTaskInput {
  readonly title?: string;
  readonly due?: string;
  readonly clearDue?: boolean;
  readonly note?: string;
  readonly clearNote?: boolean;
  readonly addLabels?: readonly string[];
  readonly removeLabels?: readonly string[];
  readonly setLabels?: readonly string[];
}

const validateLabelOperations = (input: EditTaskInput): Result<true> => {
  const groups = [input.addLabels, input.removeLabels, input.setLabels].filter(
    (value): value is readonly string[] => value !== undefined,
  );
  if (groups.some((labels) => !Array.isArray(labels) || !labels.every((label) => typeof label === "string"))) {
    return err(
      validationError(
        "ラベル操作には文字列の配列を指定してください",
        "labels",
        "ラベルを文字列で指定してください",
      ),
    );
  }
  if (
    input.setLabels !== undefined &&
    (input.addLabels !== undefined || input.removeLabels !== undefined)
  ) {
    return err(
      usageError(
        "--set-labels は --add-label / --remove-label と同時に指定できません",
        "ラベルの全置換か差分操作のどちらか一方を指定してください",
      ),
    );
  }
  return ok(true);
};

const editedLabels = (current: readonly string[], input: EditTaskInput): readonly string[] => {
  if (input.setLabels !== undefined) return stableUnique(input.setLabels);
  const removals = new Set(input.removeLabels ?? []);
  const retained = current.filter((label) => !removals.has(label));
  return stableUnique([...retained, ...(input.addLabels ?? [])]);
};

export const editTask = (
  tasks: readonly Task[],
  id: string,
  input: EditTaskInput,
): Result<MutationResult> => {
  const validated = validateTasks(tasks);
  if (!validated.ok) return validated;
  const validId = validateMutationId(id, "edit");
  if (!validId.ok) return validId;

  if (input.due !== undefined && input.clearDue === true) {
    return err(
      usageError(
        "--due と --clear-due は同時に指定できません",
        "期限の設定か削除のどちらか一方を指定してください",
      ),
    );
  }
  if (input.note !== undefined && input.clearNote === true) {
    return err(
      usageError(
        "--note と --clear-note は同時に指定できません",
        "noteの設定か削除のどちらか一方を指定してください",
      ),
    );
  }
  if (input.title !== undefined && (typeof input.title !== "string" || input.title.length === 0)) {
    return err(
      validationError(
        "title は空でない文字列でなければなりません",
        "title",
        "空でないタイトルを指定してください",
      ),
    );
  }
  if (input.note !== undefined && typeof input.note !== "string") {
    return err(
      validationError("note は文字列でなければなりません", "note", "note を文字列で指定してください"),
    );
  }
  if (input.due !== undefined) {
    const due = validateDue(input.due);
    if (!due.ok) return due;
  }
  const labelsValid = validateLabelOperations(input);
  if (!labelsValid.ok) return labelsValid;

  const index = validated.value.findIndex((task) => task.id === id);
  if (index < 0) return err(notFoundError(id));
  const current = validated.value[index] as Task;
  let replacement: Task = current;

  if (input.title !== undefined) replacement = { ...replacement, title: input.title };
  if (input.clearDue === true) replacement = withoutKey(replacement, "due");
  else if (input.due !== undefined) replacement = { ...replacement, due: input.due };
  if (input.clearNote === true) replacement = withoutKey(replacement, "note");
  else if (input.note !== undefined) replacement = { ...replacement, note: input.note };
  if (
    input.setLabels !== undefined ||
    input.addLabels !== undefined ||
    input.removeLabels !== undefined
  ) {
    replacement = { ...replacement, labels: editedLabels(replacement.labels, input) };
  }

  const changed = JSON.stringify(replacement) !== JSON.stringify(current);
  if (!changed) return ok({ tasks: validated.value, changed: false, task: current });
  const nextTasks = replaceTask(validated.value, index, replacement);
  return ok({ tasks: nextTasks, changed: true, task: replacement });
};

export const removeTask = (
  tasks: readonly Task[],
  id: string,
): Result<MutationResult> => {
  const validated = validateTasks(tasks);
  if (!validated.ok) return validated;
  const validId = validateMutationId(id, "rm");
  if (!validId.ok) return validId;

  const index = validated.value.findIndex((task) => task.id === id);
  if (index < 0) return ok({ tasks: validated.value, changed: false, task: null });
  const removed = validated.value[index] as Task;
  return ok({
    tasks: validated.value.filter((_, taskIndex) => taskIndex !== index),
    changed: true,
    task: removed,
  });
};
