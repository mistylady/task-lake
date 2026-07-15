import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  err as failure,
  ok as success,
  type Result,
  type Task,
  type TaskLakeError,
  type ValidationReport,
} from "./types";
import {
  diagnoseJsonl,
  parseAndValidateJsonl,
  serializeJsonl,
} from "./validation";

const DATA_FILE_NAME = "tasks.jsonl";
const DEFAULT_LOCK_RETRY_ATTEMPTS = 5;
const DEFAULT_LOCK_RETRY_DELAY_MS = 25;

export interface StoragePaths {
  readonly home: string;
  readonly dataFile: string;
  readonly backupFile: string;
  readonly backupTempFile: string;
  readonly lockFile: string;
}

export interface StorageOptions {
  /** Explicit home is primarily useful to keep tests isolated. */
  readonly home?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly lockRetryAttempts?: number;
  readonly lockRetryDelayMs?: number;
}

export type TaskTransactionResult = Readonly<{
  tasks: readonly Task[];
}>;

export type TaskTransaction<T extends TaskTransactionResult> = (
  tasks: readonly Task[],
) => Result<T>;

interface RawTaskFile {
  readonly raw: string;
  readonly tasks: readonly Task[];
}

const errnoCode = (cause: unknown): string | undefined => {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) {
    return undefined;
  }

  const { code } = cause as { readonly code?: unknown };
  return typeof code === "string" ? code : undefined;
};

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`;

const ioFailure = (
  message: string,
  nextStep?: string,
): Result<never> =>
  failure({
    code: "io",
    message,
    ...(nextStep === undefined ? {} : { next_step: nextStep }),
  });

const validationNextStep = (paths: StoragePaths): string =>
  `tlk validate で内容を確認し、必要なら ${paths.backupFile} から復旧してください`;

const enrichValidationError = (
  error: TaskLakeError,
  paths: StoragePaths,
): TaskLakeError =>
  error.code === "validation" && error.next_step === undefined
    ? { ...error, next_step: validationNextStep(paths) }
    : error;

export const resolveTaskLakeHome = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  fallbackHome: string = homedir(),
): string => {
  const override = env.TASK_LAKE_HOME;
  return resolve(
    override === undefined || override.length === 0
      ? join(fallbackHome, ".task-lake")
      : override,
  );
};

export const resolveStoragePaths = (
  options: StorageOptions = {},
): StoragePaths => {
  const home = resolve(
    options.home ?? resolveTaskLakeHome(options.env ?? process.env),
  );
  const dataFile = join(home, DATA_FILE_NAME);

  return {
    home,
    dataFile,
    backupFile: `${dataFile}.bak`,
    backupTempFile: `${dataFile}.bak.tmp`,
    lockFile: `${dataFile}.lock`,
  };
};

const readRaw = async (paths: StoragePaths): Promise<Result<string>> => {
  try {
    return success(await readFile(paths.dataFile, "utf8"));
  } catch (cause) {
    if (errnoCode(cause) === "ENOENT") {
      return success("");
    }

    return ioFailure(
      `データファイルを読み込めません: ${paths.dataFile}: ${errorMessage(cause)}`,
      `ファイルと親ディレクトリの権限を確認してください: ${paths.dataFile}`,
    );
  }
};

const loadRawTaskFile = async (
  paths: StoragePaths,
): Promise<Result<RawTaskFile>> => {
  const raw = await readRaw(paths);
  if (!raw.ok) {
    return raw;
  }

  const parsed = parseAndValidateJsonl(raw.value);
  if (!parsed.ok) {
    return failure(enrichValidationError(parsed.error, paths));
  }

  return success({ raw: raw.value, tasks: parsed.value });
};

/** Read-only load. A missing home directory or data file is an empty task lake. */
export const loadTasks = async (
  options: StorageOptions = {},
): Promise<Result<readonly Task[]>> => {
  const loaded = await loadRawTaskFile(resolveStoragePaths(options));
  return loaded.ok ? success(loaded.value.tasks) : loaded;
};

/**
 * Read all rows for `validate`, including every independently detectable issue.
 * I/O failures are Result errors; invalid data is represented in the report.
 */
export const diagnoseTasks = async (
  options: StorageOptions = {},
): Promise<Result<ValidationReport>> => {
  const paths = resolveStoragePaths(options);
  const raw = await readRaw(paths);
  return raw.ok ? success(diagnoseJsonl(raw.value)) : raw;
};

const delay = async (milliseconds: number): Promise<void> =>
  await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

const removeIfPresent = async (path: string): Promise<void> => {
  try {
    await unlink(path);
  } catch (cause) {
    if (errnoCode(cause) !== "ENOENT") {
      throw cause;
    }
  }
};

const acquireLock = async (
  paths: StoragePaths,
  options: StorageOptions,
): Promise<Result<FileHandle>> => {
  const attempts =
    options.lockRetryAttempts !== undefined &&
    Number.isInteger(options.lockRetryAttempts) &&
    options.lockRetryAttempts > 0
      ? options.lockRetryAttempts
      : DEFAULT_LOCK_RETRY_ATTEMPTS;
  const retryDelayMs =
    options.lockRetryDelayMs !== undefined &&
    Number.isFinite(options.lockRetryDelayMs) &&
    options.lockRetryDelayMs >= 0
      ? options.lockRetryDelayMs
      : DEFAULT_LOCK_RETRY_DELAY_MS;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return success(await open(paths.lockFile, "wx"));
    } catch (cause) {
      if (errnoCode(cause) !== "EEXIST") {
        return ioFailure(
          `ロックを取得できません: ${paths.lockFile}: ${errorMessage(cause)}`,
          `親ディレクトリの権限を確認してください: ${paths.home}`,
        );
      }

      if (attempt < attempts) {
        await delay(retryDelayMs);
      }
    }
  }

  return ioFailure(
    `別の tlk プロセスが書き込み中のためロックを取得できません: ${paths.lockFile}`,
    `他の tlk プロセスが動いていないことを確認してからロックを手動削除してください: rm -- ${shellQuote(paths.lockFile)}`,
  );
};

const releaseLock = async (
  handle: FileHandle,
  paths: StoragePaths,
): Promise<Result<void>> => {
  let closeError: unknown;
  try {
    await handle.close();
  } catch (cause) {
    closeError = cause;
  }

  try {
    await removeIfPresent(paths.lockFile);
  } catch (cause) {
    return ioFailure(
      `ロックを解放できません: ${paths.lockFile}: ${errorMessage(cause)}`,
      `他の tlk プロセスが動いていないことを確認してからロックを手動削除してください: rm -- ${shellQuote(paths.lockFile)}`,
    );
  }

  return closeError === undefined
    ? success(undefined)
    : ioFailure(
        `ロックファイルを閉じられません: ${paths.lockFile}: ${errorMessage(closeError)}`,
      );
};

let temporaryFileSequence = 0;

const nextDataTempPath = (paths: StoragePaths): string => {
  temporaryFileSequence += 1;
  return join(
    paths.home,
    `.${DATA_FILE_NAME}.tmp-${process.pid}-${Date.now()}-${temporaryFileSequence}`,
  );
};

const writeThenRename = async (
  content: string,
  temporaryPath: string,
  destinationPath: string,
  exclusive: boolean,
): Promise<Result<void>> => {
  try {
    await writeFile(temporaryPath, content, {
      encoding: "utf8",
      ...(exclusive ? { flag: "wx" } : {}),
    });
    await rename(temporaryPath, destinationPath);
    return success(undefined);
  } catch (cause) {
    await removeIfPresent(temporaryPath).catch(() => undefined);
    return ioFailure(
      `ファイルを安全に更新できません: ${destinationPath}: ${errorMessage(cause)}`,
      `親ディレクトリの空き容量と権限を確認してください: ${dirname(destinationPath)}`,
    );
  }
};

const runTransaction = async <T extends TaskTransactionResult>(
  paths: StoragePaths,
  transform: TaskTransaction<T>,
): Promise<Result<T>> => {
  const loaded = await loadRawTaskFile(paths);
  if (!loaded.ok) {
    return loaded;
  }

  const transformed = transform(loaded.value.tasks);
  if (!transformed.ok) {
    return transformed;
  }

  const serialized = serializeJsonl(transformed.value.tasks);

  const backup = await writeThenRename(
    loaded.value.raw,
    paths.backupTempFile,
    paths.backupFile,
    false,
  );
  if (!backup.ok) {
    return backup;
  }

  const data = await writeThenRename(
    serialized,
    nextDataTempPath(paths),
    paths.dataFile,
    true,
  );
  return data.ok ? transformed : data;
};

/**
 * The sole write path: mkdir -> exclusive lock -> reread -> transform -> backup
 * rename -> same-directory data rename -> unconditional lock release.
 */
export const withWriteTransaction = async <T extends TaskTransactionResult>(
  transform: TaskTransaction<T>,
  options: StorageOptions = {},
): Promise<Result<T>> => {
  const paths = resolveStoragePaths(options);

  try {
    await mkdir(paths.home, { recursive: true });
  } catch (cause) {
    return ioFailure(
      `データディレクトリを作成できません: ${paths.home}: ${errorMessage(cause)}`,
      `親ディレクトリの権限を確認してください: ${paths.home}`,
    );
  }

  const lock = await acquireLock(paths, options);
  if (!lock.ok) {
    return lock;
  }

  let operation!: Result<T>;
  let release!: Result<void>;
  try {
    operation = await runTransaction(paths, transform);
  } finally {
    release = await releaseLock(lock.value, paths);
  }

  return release.ok ? operation : release;
};
