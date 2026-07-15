import {
  type CommandConstraint,
  type CommandName,
  type DefinedCommandSpec,
  GLOBAL_OPTIONS,
  type OptionSpec,
  type PositionalSpec,
  getCommandSpec,
  getEffectiveOptions,
  isCommandName,
} from "./command-spec";
import { err as failure, ok as success, type Result } from "./types";

export type UsageError = Readonly<{
  code: "usage";
  message: string;
  next_step: string;
}>;

export type ParsedOptionValue = boolean | string | number | readonly string[];

export type ParsedCommandInvocation = Readonly<{
  kind: "command";
  command: CommandName;
  args: Readonly<Record<string, string>>;
  options: Readonly<Record<string, ParsedOptionValue>>;
  json: boolean;
  help: boolean;
}>;

export type GlobalHelpInvocation = Readonly<{
  kind: "global-help";
  json: boolean;
  help: true;
}>;

export type ParsedInvocation = ParsedCommandInvocation | GlobalHelpInvocation;

type ParseState = Readonly<{
  index: number;
  endOfOptions: boolean;
  positionalValues: readonly string[];
  options: Readonly<Record<string, ParsedOptionValue>>;
}>;

type LocatedCommand = Readonly<{
  command: CommandName;
  commandIndex: number;
  prefixOptions: Readonly<Record<string, ParsedOptionValue>>;
}>;

const usageError = (
  message: string,
  programName: string,
  command?: CommandName,
): UsageError => ({
  code: "usage",
  message,
  next_step:
    command === undefined
      ? `${programName} --help でコマンド一覧を確認してください`
      : `${programName} ${command} --help で使い方を確認してください`,
});

const owns = (record: Readonly<Record<string, unknown>>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key);

const setOption = (
  options: Readonly<Record<string, ParsedOptionValue>>,
  spec: OptionSpec,
  value: boolean | string | number,
  programName: string,
  command?: CommandName,
): Result<Readonly<Record<string, ParsedOptionValue>>, UsageError> => {
  const previous = options[spec.name];
  if (spec.kind === "value" && spec.repeatable) {
    const values = Array.isArray(previous) ? previous : [];
    return success({ ...options, [spec.name]: [...values, String(value)] });
  }
  if (owns(options, spec.name)) {
    return failure(
      usageError(`--${spec.name} は複数回指定できません`, programName, command),
    );
  }
  return success({ ...options, [spec.name]: value });
};

const findOption = (token: string, specs: readonly OptionSpec[]): OptionSpec | undefined => {
  if (token.startsWith("--")) {
    const name = token.slice(2).split("=", 1)[0] ?? "";
    return specs.find((spec) => spec.name === name);
  }
  return specs.find((spec) => spec.aliases.includes(token));
};

const hasRecognizedOptionShape = (token: string, specs: readonly OptionSpec[]): boolean =>
  token !== "-" && findOption(token, specs) !== undefined;

const parseNonNegativeInteger = (
  value: string,
  option: OptionSpec,
  programName: string,
  command: CommandName,
): Result<number, UsageError> => {
  if (!/^[0-9]+$/.test(value)) {
    return failure(
      usageError(`--${option.name} には0以上の整数を指定してください`, programName, command),
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    return failure(
      usageError(`--${option.name} の値が大きすぎます`, programName, command),
    );
  }
  return success(parsed);
};

const parseOptionValue = (
  value: string,
  option: OptionSpec,
  programName: string,
  command: CommandName,
): Result<string | number, UsageError> => {
  if (option.kind === "boolean" || option.valueType === "string") {
    return success(value);
  }
  return parseNonNegativeInteger(value, option, programName, command);
};

const locateCommand = (
  argv: readonly string[],
  programName: string,
): Result<LocatedCommand | GlobalHelpInvocation, UsageError> => {
  const visit = (
    index: number,
    options: Readonly<Record<string, ParsedOptionValue>>,
  ): Result<LocatedCommand | GlobalHelpInvocation, UsageError> => {
    if (index >= argv.length) {
      if (options.help === true) {
        return success({ kind: "global-help", json: options.json === true, help: true });
      }
      return failure(usageError("コマンドを指定してください", programName));
    }

    const token = argv[index] ?? "";
    if (isCommandName(token)) {
      return success({ command: token, commandIndex: index, prefixOptions: options });
    }

    const option = findOption(token, GLOBAL_OPTIONS);
    if (option !== undefined) {
      if (token.includes("=")) {
        return failure(
          usageError(`--${option.name} は値を取りません`, programName),
        );
      }
      const nextOptions = setOption(options, option, true, programName);
      return nextOptions.ok ? visit(index + 1, nextOptions.value) : nextOptions;
    }

    if (token.startsWith("-")) {
      return failure(usageError(`不明なオプションです: ${token}`, programName));
    }
    return failure(usageError(`不明なコマンドです: ${token}`, programName));
  };

  return visit(0, {});
};

const consumeCommandTokens = (
  tokens: readonly string[],
  spec: DefinedCommandSpec,
  initialOptions: Readonly<Record<string, ParsedOptionValue>>,
  programName: string,
): Result<ParseState, UsageError> => {
  const availableOptions = getEffectiveOptions(spec);

  const visit = (state: ParseState): Result<ParseState, UsageError> => {
    if (state.index >= tokens.length) {
      return success(state);
    }

    const token = tokens[state.index] ?? "";
    if (!state.endOfOptions && token === "--") {
      return visit({ ...state, index: state.index + 1, endOfOptions: true });
    }

    if (!state.endOfOptions && token.startsWith("-") && token !== "-") {
      const option = findOption(token, availableOptions);
      if (option === undefined) {
        return failure(
          usageError(`不明なオプションです: ${token}`, programName, spec.name),
        );
      }

      const equalsIndex = token.startsWith("--") ? token.indexOf("=") : -1;
      const attachedValue = equalsIndex >= 0 ? token.slice(equalsIndex + 1) : undefined;
      if (option.kind === "boolean") {
        if (attachedValue !== undefined) {
          return failure(
            usageError(`--${option.name} は値を取りません`, programName, spec.name),
          );
        }
        const nextOptions = setOption(state.options, option, true, programName, spec.name);
        return nextOptions.ok
          ? visit({ ...state, index: state.index + 1, options: nextOptions.value })
          : nextOptions;
      }

      if (!token.startsWith("--") && !option.aliases.includes(token)) {
        return failure(
          usageError(`短いオプションは連結できません: ${token}`, programName, spec.name),
        );
      }

      const valueIndex = state.index + 1;
      const following = tokens[valueIndex];
      if (
        attachedValue === undefined &&
        (following === undefined ||
          hasRecognizedOptionShape(following, availableOptions) ||
          (following.startsWith("-") &&
            following !== "-" &&
            !(
              option.valueType === "non-negative-integer" && /^-[0-9]+$/.test(following)
            )))
      ) {
        return failure(
          usageError(`--${option.name} には値が必要です`, programName, spec.name),
        );
      }
      const rawValue = attachedValue ?? following ?? "";
      const parsedValue = parseOptionValue(rawValue, option, programName, spec.name);
      if (!parsedValue.ok) {
        return parsedValue;
      }
      const nextOptions = setOption(
        state.options,
        option,
        parsedValue.value,
        programName,
        spec.name,
      );
      if (!nextOptions.ok) {
        return nextOptions;
      }
      return visit({
        ...state,
        index: attachedValue === undefined ? state.index + 2 : state.index + 1,
        options: nextOptions.value,
      });
    }

    if (state.positionalValues.length >= spec.arguments.length) {
      return failure(
        usageError(`余分な引数です: ${token}`, programName, spec.name),
      );
    }
    return visit({
      ...state,
      index: state.index + 1,
      positionalValues: [...state.positionalValues, token],
    });
  };

  return visit({
    index: 0,
    endOfOptions: false,
    positionalValues: [],
    options: initialOptions,
  });
};

const validatePositional = (
  argument: PositionalSpec,
  value: string,
  programName: string,
  command: CommandName,
): Result<string, UsageError> => {
  if (argument.valueType === "id" && !/^[0-9]+$/.test(value)) {
    return failure(
      usageError(`${argument.name} には純数値のIDを指定してください`, programName, command),
    );
  }
  if (argument.valueType === "command-name" && !isCommandName(value)) {
    return failure(
      usageError(`不明なコマンドです: ${value}`, programName, command),
    );
  }
  return success(value);
};

const validatePositionals = (
  spec: DefinedCommandSpec,
  values: readonly string[],
  programName: string,
  skipRequired: boolean,
): Result<Readonly<Record<string, string>>, UsageError> => {
  const visit = (
    index: number,
    result: Readonly<Record<string, string>>,
  ): Result<Readonly<Record<string, string>>, UsageError> => {
    if (index >= spec.arguments.length) {
      return success(result);
    }
    const argument = spec.arguments[index];
    if (argument === undefined) {
      return success(result);
    }
    const value = values[index];
    if (value === undefined) {
      if (argument.required && !skipRequired) {
        return failure(
          usageError(`必須引数 <${argument.valueName}> がありません`, programName, spec.name),
        );
      }
      return visit(index + 1, result);
    }
    if (skipRequired) {
      return visit(index + 1, { ...result, [argument.name]: value });
    }
    const validated = validatePositional(argument, value, programName, spec.name);
    return validated.ok
      ? visit(index + 1, { ...result, [argument.name]: validated.value })
      : validated;
  };

  return visit(0, {});
};

const validateOptionConflicts = (
  spec: DefinedCommandSpec,
  options: Readonly<Record<string, ParsedOptionValue>>,
  programName: string,
): Result<void, UsageError> => {
  const optionSpecs = getEffectiveOptions(spec);
  const firstConflict = optionSpecs
    .flatMap((option) =>
      option.conflicts.map((conflict) => ({ left: option.name, right: conflict })),
    )
    .find(({ left, right }) => owns(options, left) && owns(options, right));

  return firstConflict === undefined
    ? success(undefined)
    : failure(
        usageError(
          `--${firstConflict.left} と --${firstConflict.right} は同時指定できません`,
          programName,
          spec.name,
        ),
      );
};

const validateConstraint = (
  constraint: CommandConstraint,
  options: Readonly<Record<string, ParsedOptionValue>>,
  args: Readonly<Record<string, string>>,
  programName: string,
  command: CommandName,
): Result<void, UsageError> => {
  if (constraint.kind === "at-least-one-option") {
    return constraint.options.some((option) => owns(options, option))
      ? success(undefined)
      : failure(usageError(constraint.message, programName, command));
  }
  return owns(options, constraint.option) && owns(args, constraint.argument)
    ? failure(usageError(constraint.message, programName, command))
    : success(undefined);
};

const validateConstraints = (
  spec: DefinedCommandSpec,
  options: Readonly<Record<string, ParsedOptionValue>>,
  args: Readonly<Record<string, string>>,
  programName: string,
): Result<void, UsageError> => {
  const conflicts = validateOptionConflicts(spec, options, programName);
  if (!conflicts.ok) {
    return conflicts;
  }
  for (const constraint of spec.constraints) {
    const result = validateConstraint(constraint, options, args, programName, spec.name);
    if (!result.ok) {
      return result;
    }
  }
  return success(undefined);
};

export const detectJsonFlag = (argv: readonly string[]): boolean => {
  const marker = argv.indexOf("--");
  const optionTokens = marker < 0 ? argv : argv.slice(0, marker);
  return optionTokens.includes("--json");
};

export const parseArgs = (
  argv: readonly string[],
  programName = "tlk",
): Result<ParsedInvocation, UsageError> => {
  const located = locateCommand(argv, programName);
  if (!located.ok) {
    return located;
  }
  if ("kind" in located.value) {
    return success(located.value);
  }

  const spec = getCommandSpec(located.value.command);
  if (spec === undefined) {
    return failure(usageError(`不明なコマンドです: ${located.value.command}`, programName));
  }
  const tokens = argv.slice(located.value.commandIndex + 1);
  const consumed = consumeCommandTokens(tokens, spec, located.value.prefixOptions, programName);
  if (!consumed.ok) {
    return consumed;
  }

  const help = consumed.value.options.help === true;
  const args = validatePositionals(
    spec,
    consumed.value.positionalValues,
    programName,
    help,
  );
  if (!args.ok) {
    return args;
  }
  if (!help) {
    const constraints = validateConstraints(spec, consumed.value.options, args.value, programName);
    if (!constraints.ok) {
      return constraints;
    }
  }

  return success({
    kind: "command",
    command: spec.name,
    args: args.value,
    options: consumed.value.options,
    json: consumed.value.options.json === true,
    help,
  });
};

export const getArgument = (
  invocation: ParsedCommandInvocation,
  name: string,
): string | undefined => invocation.args[name];

export const getBooleanOption = (
  invocation: ParsedCommandInvocation,
  name: string,
): boolean => invocation.options[name] === true;

export const getStringOption = (
  invocation: ParsedCommandInvocation,
  name: string,
): string | undefined => {
  const value = invocation.options[name];
  return typeof value === "string" ? value : undefined;
};

export const getNumberOption = (
  invocation: ParsedCommandInvocation,
  name: string,
): number | undefined => {
  const value = invocation.options[name];
  return typeof value === "number" ? value : undefined;
};

export const getRepeatedOption = (
  invocation: ParsedCommandInvocation,
  name: string,
): readonly string[] => {
  const value = invocation.options[name];
  return Array.isArray(value) ? value : [];
};
