import {
  err,
  ok,
  type Result,
  type Task,
  type TaskLakeError,
  type ValidationIssue,
  type ValidationReport,
} from "./types";

export const DATA_VALIDATION_NEXT_STEP =
  ".bak から復旧するか、tlk validate で詳細を確認してください";

const DUE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})([+-])(\d{2}):(\d{2})$/;
const ID_PATTERN = /^\d+$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const isLeapYear = (year: number): boolean =>
  year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

const daysInMonth = (year: number, month: number): number => {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
};

const isCalendarDate = (year: number, month: number, day: number): boolean =>
  year >= 1 &&
  year <= 9999 &&
  month >= 1 &&
  month <= 12 &&
  day >= 1 &&
  day <= daysInMonth(year, month);

export const isValidDue = (value: string): boolean => {
  const match = DUE_PATTERN.exec(value);
  if (match === null) return false;
  return isCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]));
};

export const isValidTimestamp = (value: string): boolean => {
  const match = TIMESTAMP_PATTERN.exec(value);
  if (match === null) return false;

  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] =
    match;
  const offsetHours = Number(offsetHour);
  const offsetMinutes = Number(offsetMinute);

  return (
    isCalendarDate(Number(year), Number(month), Number(day)) &&
    Number(hour) >= 0 &&
    Number(hour) <= 23 &&
    Number(minute) >= 0 &&
    Number(minute) <= 59 &&
    Number(second) >= 0 &&
    Number(second) <= 59 &&
    offsetHours >= 0 &&
    offsetHours <= 14 &&
    offsetMinutes >= 0 &&
    offsetMinutes <= 59 &&
    (offsetHours < 14 || offsetMinutes === 0)
  );
};

export const validateDue = (value: string): Result<string> =>
  isValidDue(value)
    ? ok(value)
    : err({
        code: "validation",
        message: `due「${value}」は暦上実在する YYYY-MM-DD 形式ではありません`,
        field: "due",
        next_step: "YYYY-MM-DD 形式の実在する日付を指定してください",
      });

export const validateTimestamp = (value: string): Result<string> =>
  isValidTimestamp(value)
    ? ok(value)
    : err({
        code: "validation",
        message: `時刻「${value}」はオフセット付き ISO 8601 形式ではありません`,
        next_step: "YYYY-MM-DDTHH:mm:ss+09:00 の形式で指定してください",
      });

const issue = (
  line: number,
  message: string,
  field?: string,
): ValidationIssue => ({
  code: "validation",
  line,
  message,
  ...(field === undefined ? {} : { field }),
});

interface TaskAnalysis {
  readonly task?: Task;
  readonly validId?: string;
  readonly issues: readonly ValidationIssue[];
}

const analyzeTask = (value: unknown, line: number): TaskAnalysis => {
  if (!isRecord(value)) {
    return { issues: [issue(line, "JSONオブジェクトではありません")] };
  }

  const issues: ValidationIssue[] = [];
  const id = value.id;
  const title = value.title;
  const status = value.status;
  const note = value.note;
  const due = value.due;
  const labels = value.labels;
  const created = value.created;
  const closed = value.closed;

  const validId = typeof id === "string" && ID_PATTERN.test(id) ? id : undefined;
  if (validId === undefined) {
    issues.push(issue(line, "id は純数字の文字列でなければなりません", "id"));
  }

  if (typeof title !== "string" || title.length === 0) {
    issues.push(issue(line, "title は空でない文字列でなければなりません", "title"));
  }

  if (status !== "open" && status !== "done") {
    issues.push(issue(line, 'status は "open" または "done" でなければなりません', "status"));
  }

  if (note !== undefined && note !== null && typeof note !== "string") {
    issues.push(issue(line, "note は文字列または null でなければなりません", "note"));
  }

  if (
    due !== undefined &&
    due !== null &&
    (typeof due !== "string" || !isValidDue(due))
  ) {
    issues.push(
      issue(line, "due は暦上実在する YYYY-MM-DD、null、または未設定でなければなりません", "due"),
    );
  }

  if (!Array.isArray(labels) || !labels.every((label) => typeof label === "string")) {
    issues.push(issue(line, "labels は文字列の配列でなければなりません", "labels"));
  }

  if (typeof created !== "string" || !isValidTimestamp(created)) {
    issues.push(
      issue(line, "created はオフセット付き ISO 8601 形式でなければなりません", "created"),
    );
  }

  const closedIsMissing = !hasOwn(value, "closed") || closed === null || closed === undefined;
  const closedIsTimestamp = typeof closed === "string" && isValidTimestamp(closed);
  if (!closedIsMissing && !closedIsTimestamp) {
    issues.push(
      issue(line, "closed はオフセット付き ISO 8601、null、または未設定でなければなりません", "closed"),
    );
  }

  if (status === "open" && !closedIsMissing) {
    issues.push(issue(line, "status=open のタスクに closed は設定できません", "closed"));
  }
  if (status === "done" && !closedIsTimestamp) {
    issues.push(issue(line, "status=done のタスクには closed が必要です", "closed"));
  }

  if (issues.length > 0) {
    return { issues, ...(validId === undefined ? {} : { validId }) };
  }

  // null is accepted for backwards compatibility, but omitted in canonical data.
  const { note: _note, due: _due, closed: _closed, ...rest } = value;
  const task: Task = {
    ...rest,
    id: id as string,
    title: title as string,
    status: status as "open" | "done",
    labels: [...(labels as readonly string[])],
    created: created as string,
    ...(note === undefined || note === null ? {} : { note: note as string }),
    ...(due === undefined || due === null ? {} : { due: due as string }),
    ...(closedIsMissing ? {} : { closed: closed as string }),
  };

  return { task, validId: id as string, issues: [] };
};

const sortedIssues = (issues: readonly ValidationIssue[]): readonly ValidationIssue[] =>
  issues
    .map((item, index) => ({ item, index }))
    .sort((left, right) => left.item.line - right.item.line || left.index - right.index)
    .map(({ item }) => item);

export const validationIssuesToError = (
  issues: readonly ValidationIssue[],
): TaskLakeError => {
  const ordered = sortedIssues(issues);
  const first = ordered[0];
  return {
    code: "validation",
    message:
      first === undefined
        ? "データ検証に失敗しました"
        : `行 ${first.line}: ${first.message}`,
    ...(first?.line === undefined ? {} : { line: first.line }),
    ...(first?.field === undefined ? {} : { field: first.field }),
    issues: ordered,
    next_step: DATA_VALIDATION_NEXT_STEP,
  };
};

const appendDuplicateIssues = (
  idsWithLines: readonly { readonly id: string; readonly line: number }[],
  target: ValidationIssue[],
): void => {
  const firstLineById = new Map<string, number>();
  for (const { id, line } of idsWithLines) {
    const firstLine = firstLineById.get(id);
    if (firstLine === undefined) {
      firstLineById.set(id, line);
    } else {
      target.push(
        issue(line, `id「${id}」が重複しています（最初の出現: 行 ${firstLine}）`, "id"),
      );
    }
  }
};

export const validateTasks = (values: readonly unknown[]): Result<readonly Task[]> => {
  const tasksWithLines: { readonly task: Task; readonly line: number }[] = [];
  const idsWithLines: { readonly id: string; readonly line: number }[] = [];
  const issues: ValidationIssue[] = [];

  values.forEach((value, index) => {
    const line = index + 1;
    const analysis = analyzeTask(value, line);
    issues.push(...analysis.issues);
    if (analysis.validId !== undefined) idsWithLines.push({ id: analysis.validId, line });
    if (analysis.task !== undefined) tasksWithLines.push({ task: analysis.task, line });
  });
  appendDuplicateIssues(idsWithLines, issues);

  return issues.length > 0
    ? err(validationIssuesToError(issues))
    : ok(tasksWithLines.map(({ task }) => task));
};

interface JsonlScan {
  readonly tasks: readonly Task[];
  readonly issues: readonly ValidationIssue[];
}

const jsonlLines = (text: string): readonly string[] => {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

const scanJsonl = (text: string): JsonlScan => {
  const tasksWithLines: { readonly task: Task; readonly line: number }[] = [];
  const idsWithLines: { readonly id: string; readonly line: number }[] = [];
  const issues: ValidationIssue[] = [];

  jsonlLines(text).forEach((lineText, index) => {
    const line = index + 1;
    let value: unknown;
    try {
      value = JSON.parse(lineText) as unknown;
    } catch {
      issues.push(issue(line, "JSONとして解釈できません"));
      return;
    }

    const analysis = analyzeTask(value, line);
    issues.push(...analysis.issues);
    if (analysis.validId !== undefined) idsWithLines.push({ id: analysis.validId, line });
    if (analysis.task !== undefined) tasksWithLines.push({ task: analysis.task, line });
  });

  appendDuplicateIssues(idsWithLines, issues);
  return {
    tasks: tasksWithLines.map(({ task }) => task),
    issues: sortedIssues(issues),
  };
};

export const parseAndValidateJsonl = (text: string): Result<readonly Task[]> => {
  const scan = scanJsonl(text);
  return scan.issues.length > 0
    ? err(validationIssuesToError(scan.issues))
    : ok(scan.tasks);
};

export const diagnoseJsonl = (text: string): ValidationReport => {
  const scan = scanJsonl(text);
  return {
    valid: scan.issues.length === 0,
    task_count: scan.tasks.length,
    issues: scan.issues,
  };
};

export const serializeJsonl = (tasks: readonly Task[]): string =>
  tasks.length === 0 ? "" : `${tasks.map((task) => JSON.stringify(task)).join("\n")}\n`;
