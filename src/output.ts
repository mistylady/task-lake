import type {
  ErrorCode,
  MutationResult,
  Task,
  TaskLakeError,
  TaskListItem,
  TaskListResult,
  ValidationReport,
} from "./types.ts";

export const EXIT_CODES: Readonly<Record<ErrorCode, number>> = {
  io: 1,
  internal: 1,
  usage: 2,
  not_found: 3,
  ambiguous: 4,
  validation: 5,
};

const singleLine = (value: string): string => value.replace(/[\t\r\n]+/gu, " ");

const colorOverdue = (due: string, today: string, color: boolean): string =>
  color && due < today ? `\u001b[31;1m${due}\u001b[0m` : due;

const formatListItem = (item: TaskListItem, today: string, color: boolean): string => {
  const due = item.due === undefined ? "-" : colorOverdue(item.due, today, color);
  const labels = item.labels.length === 0 ? "-" : item.labels.join(",");
  const note = item.has_note ? "note" : "-";
  return [item.id, item.status, due, singleLine(item.title), labels, note].join("\t");
};

export const formatList = (
  result: TaskListResult,
  today: string,
  color: boolean,
): string => {
  const header = "ID\tSTATUS\tDUE\tTITLE\tLABELS\tNOTE";
  const rows = result.items.map((item) => formatListItem(item, today, color));
  return [header, ...rows].join("\n");
};

export const formatTask = (task: Task): string => JSON.stringify(task, null, 2);

export const formatMutation = (result: MutationResult): string => {
  const state = result.changed ? "changed" : "unchanged";
  if (result.task === null) {
    return state;
  }
  return `${state}\t${result.task.id}\t${singleLine(result.task.title)}`;
};

export const formatValidation = (report: ValidationReport): string =>
  report.valid
    ? `valid\t${report.task_count}`
    : [
        `invalid\t${report.issues.length}`,
        ...report.issues.map(
          (issue) =>
            `line ${issue.line}${issue.field === undefined ? "" : ` (${issue.field})`}: ${issue.message}`,
        ),
      ].join("\n");

export const writeJson = (write: (text: string) => void, value: unknown): void => {
  write(`${JSON.stringify(value)}\n`);
};

export const writeText = (write: (text: string) => void, value: string): void => {
  write(`${value}\n`);
};

export const writeError = (
  write: (text: string) => void,
  error: TaskLakeError,
  json: boolean,
): void => {
  if (json) {
    writeJson(write, { error });
    return;
  }

  const location =
    error.line === undefined
      ? ""
      : ` (line ${error.line}${error.field === undefined ? "" : `, ${error.field}`})`;
  const candidates =
    error.candidates === undefined
      ? []
      : error.candidates.map((candidate) => `  ${candidate.id}\t${singleLine(candidate.title)}`);
  const issues =
    error.issues === undefined
      ? []
      : error.issues.map(
          (issue) =>
            `  line ${String(issue.line)}${
              issue.field === undefined ? "" : ` (${String(issue.field)})`
            }: ${String(issue.message)}`,
        );
  const next = error.next_step === undefined ? [] : [`next: ${error.next_step}`];
  writeText(write, [`${error.code}: ${error.message}${location}`, ...issues, ...candidates, ...next].join("\n"));
};
