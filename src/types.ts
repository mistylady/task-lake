export type TaskStatus = "open" | "done";

/**
 * The index signature is intentional: Task Lake must preserve fields introduced
 * by newer versions (or by other tools) whenever it rewrites a task.
 */
export interface Task {
  readonly [key: string]: unknown;
  readonly id: string;
  readonly title: string;
  readonly note?: string;
  readonly status: TaskStatus;
  readonly due?: string;
  readonly labels: readonly string[];
  readonly created: string;
  readonly closed?: string;
}

export interface TaskCandidate {
  readonly id: string;
  readonly title: string;
}

export type ErrorCode =
  | "io"
  | "internal"
  | "usage"
  | "not_found"
  | "ambiguous"
  | "validation";

export interface TaskLakeError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly candidates?: readonly TaskCandidate[];
  readonly next_step?: string;
  readonly line?: number;
  readonly field?: string;
  readonly issues?: readonly ValidationIssue[];
}

export type Result<T, E = TaskLakeError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

export const err = <E = TaskLakeError>(error: E): Result<never, E> => ({
  ok: false,
  error,
});

export interface ValidationIssue {
  readonly code: "validation";
  readonly line: number;
  readonly message: string;
  readonly field?: string;
}

export interface ValidationReport {
  readonly valid: boolean;
  readonly task_count: number;
  readonly issues: readonly ValidationIssue[];
}

export interface MutationResult {
  readonly tasks: readonly Task[];
  readonly changed: boolean;
  readonly task: Task | null;
}

export interface TaskListItem {
  readonly [key: string]: unknown;
  readonly id: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly due?: string;
  readonly labels: readonly string[];
  readonly created: string;
  readonly closed?: string;
  readonly has_note: boolean;
}

export interface TaskListResult {
  /** Number of matching tasks before --limit is applied. */
  readonly total: number;
  readonly items: readonly TaskListItem[];
}
