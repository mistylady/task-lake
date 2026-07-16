export type PositionalValueType = "string" | "id" | "selector" | "command-name";
export type OptionValueType = "string" | "non-negative-integer";

export type PositionalSpec = Readonly<{
  name: string;
  valueName: string;
  description: string;
  required: boolean;
  valueType: PositionalValueType;
}>;

type OptionBase = Readonly<{
  /** Long option name without the leading `--`. */
  name: string;
  /** Aliases include their prefix, for example `-l`. */
  aliases: readonly string[];
  description: string;
  conflicts: readonly string[];
}>;

export type BooleanOptionSpec = OptionBase &
  Readonly<{
    kind: "boolean";
  }>;

export type ValueOptionSpec = OptionBase &
  Readonly<{
    kind: "value";
    valueName: string;
    valueType: OptionValueType;
    repeatable: boolean;
  }>;

export type OptionSpec = BooleanOptionSpec | ValueOptionSpec;

export type CommandConstraint =
  | Readonly<{
      kind: "at-least-one-option";
      options: readonly string[];
      message: string;
    }>
  | Readonly<{
      kind: "option-conflicts-with-argument";
      option: string;
      argument: string;
      message: string;
    }>;

export type CommandExample = Readonly<{
  input: string;
  output: unknown;
}>;

export type CommandSpec = Readonly<{
  name: string;
  summary: string;
  arguments: readonly PositionalSpec[];
  options: readonly OptionSpec[];
  constraints: readonly CommandConstraint[];
  /** Domain and behavior rules shown by help/describe but enforced outside the parser. */
  rules: readonly string[];
  example: CommandExample;
}>;

const booleanOption = (
  name: string,
  description: string,
  config: Readonly<{
    aliases?: readonly string[];
    conflicts?: readonly string[];
  }> = {},
): BooleanOptionSpec => ({
  kind: "boolean",
  name,
  aliases: config.aliases ?? [],
  description,
  conflicts: config.conflicts ?? [],
});

const valueOption = (
  name: string,
  valueName: string,
  description: string,
  config: Readonly<{
    aliases?: readonly string[];
    conflicts?: readonly string[];
    repeatable?: boolean;
    valueType?: OptionValueType;
  }> = {},
): ValueOptionSpec => ({
  kind: "value",
  name,
  aliases: config.aliases ?? [],
  description,
  conflicts: config.conflicts ?? [],
  valueName,
  valueType: config.valueType ?? "string",
  repeatable: config.repeatable ?? false,
});

const positional = (
  name: string,
  valueName: string,
  description: string,
  config: Readonly<{
    required?: boolean;
    valueType?: PositionalValueType;
  }> = {},
): PositionalSpec => ({
  name,
  valueName,
  description,
  required: config.required ?? true,
  valueType: config.valueType ?? "string",
});

export const GLOBAL_OPTIONS: readonly OptionSpec[] = [
  booleanOption("json", "JSON形式で出力する"),
  booleanOption("help", "ヘルプを表示する"),
];

const exampleTask = {
  id: "12",
  title: "設定値を確認する",
  status: "open",
  due: "2026-07-20",
  labels: ["rdm:1234"],
  created: "2026-07-15T21:30:00+09:00",
};

const editOptions = [
  valueOption("title", "title", "タイトルを置き換える"),
  valueOption("due", "YYYY-MM-DD", "期限を設定する", { conflicts: ["clear-due"] }),
  booleanOption("clear-due", "期限を未設定に戻す", { conflicts: ["due"] }),
  valueOption("add-label", "label", "ラベルを追加する（複数回指定可）", {
    conflicts: ["set-labels"],
    repeatable: true,
  }),
  valueOption("remove-label", "label", "ラベルを削除する（複数回指定可）", {
    conflicts: ["set-labels"],
    repeatable: true,
  }),
  valueOption("set-labels", "a,b", "カンマ区切りのラベルで全置換する", {
    conflicts: ["add-label", "remove-label"],
  }),
  valueOption("note", "text|-", "noteを置き換える。- はstdinから読む", {
    conflicts: ["clear-note"],
  }),
  booleanOption("clear-note", "noteを未設定に戻す", { conflicts: ["note"] }),
] as const;

export const COMMAND_SPECS = [
  {
    name: "add",
    summary: "タスクを登録する",
    arguments: [positional("title", "title", "空でないタスクタイトル")],
    options: [
      valueOption("note", "text|-", "noteを設定する。- はstdinから読む"),
      valueOption("due", "YYYY-MM-DD", "期限を設定する"),
      valueOption("label", "label", "ラベルを追加する（複数回指定可）", {
        aliases: ["-l"],
        repeatable: true,
      }),
    ],
    constraints: [],
    rules: [
      "IDはmax(永続カウンタ, doneを含む全タスクの最大ID+1)。削除済みIDは再利用しない",
      "dueは暦上実在するYYYY-MM-DDのみ",
      "optional値を指定しない場合、そのキーは保存しない",
    ],
    example: {
      input: 'tlk add "設定値を確認する" --due 2026-07-20 -l rdm:1234 --json',
      output: { changed: true, task: exampleTask },
    },
  },
  {
    name: "list",
    summary: "タスクを一覧表示する",
    arguments: [],
    options: [
      booleanOption("all", "doneを含む全タスクを表示する"),
      valueOption("limit", "N", "表示件数を指定する。0は無制限", {
        valueType: "non-negative-integer",
      }),
      valueOption("label", "label", "ラベルで絞り込む（複数回指定可）", {
        aliases: ["-l"],
        repeatable: true,
      }),
    ],
    constraints: [],
    rules: [
      "デフォルトはopenのみ・無制限。due昇順、dueなしは末尾、同値はID昇順",
      "--all時はID降順でデフォルト50件",
      "limitはソート後に適用し、--limit 0は無制限",
      "noteを省略し、has_noteでnoteの有無を返す",
    ],
    example: {
      input: "tlk list --json",
      output: {
        total: 1,
        items: [{ ...exampleTask, has_note: false }],
      },
    },
  },
  {
    name: "show",
    summary: "IDまたはタイトル断片で1件を表示する",
    arguments: [
      positional("selector", "id|title-fragment", "純数値はID、それ以外はタイトル部分一致", {
        valueType: "selector",
      }),
    ],
    options: [],
    constraints: [],
    rules: [
      "純数値は常にID完全一致として解決する",
      "タイトル部分一致が複数なら候補付きambiguousエラーにする",
      "noteを含む全文を返す",
    ],
    example: {
      input: "tlk show 12 --json",
      output: exampleTask,
    },
  },
  {
    name: "done",
    summary: "タスクを完了にする",
    arguments: [positional("id", "id", "対象タスクの数値ID", { valueType: "id" })],
    options: [valueOption("note", "text|-", "openからdoneへの遷移時だけnoteに追記する")],
    constraints: [],
    rules: [
      "完了済みタスクはchanged:falseの成功にする",
      "完了済みタスクへの--noteは追記しない",
      "対象がなければnot_foundエラーにする",
    ],
    example: {
      input: "tlk done 12 --json",
      output: {
        changed: true,
        task: { ...exampleTask, status: "done", closed: "2026-07-15T22:00:00+09:00" },
      },
    },
  },
  {
    name: "reopen",
    summary: "完了済みタスクをopenに戻す",
    arguments: [positional("id", "id", "対象タスクの数値ID", { valueType: "id" })],
    options: [],
    constraints: [],
    rules: [
      "openタスクはchanged:falseの成功にする",
      "openへ戻すときclosedを削除する",
      "対象がなければnot_foundエラーにする",
    ],
    example: {
      input: "tlk reopen 12 --json",
      output: { changed: true, task: exampleTask },
    },
  },
  {
    name: "edit",
    summary: "タスクのtitle・due・labels・noteを編集する",
    arguments: [positional("id", "id", "対象タスクの数値ID", { valueType: "id" })],
    options: editOptions,
    constraints: [
      {
        kind: "at-least-one-option",
        options: editOptions.map(({ name }) => name),
        message: "editには変更するオプションを1つ以上指定してください",
      },
    ],
    rules: [
      "titleを空文字にはできない",
      "--dueと--clear-due、--noteと--clear-noteは同時指定不可",
      "--set-labelsは--add-label/--remove-labelと同時指定不可",
      "--note - はstdinから読む",
    ],
    example: {
      input: "tlk edit 12 --add-label checked --clear-due --json",
      output: {
        changed: true,
        task: {
          id: "12",
          title: "設定値を確認する",
          status: "open",
          labels: ["rdm:1234", "checked"],
          created: "2026-07-15T21:30:00+09:00",
        },
      },
    },
  },
  {
    name: "rm",
    summary: "誤登録したタスクを物理削除する",
    arguments: [positional("id", "id", "対象タスクの数値ID", { valueType: "id" })],
    options: [],
    constraints: [],
    rules: [
      "ID完全一致だけを許可する",
      "存在しないIDはchanged:false、task:nullの成功にする",
    ],
    example: {
      input: "tlk rm 12 --json",
      output: { changed: true, task: exampleTask },
    },
  },
  {
    name: "describe",
    summary: "コマンド仕様をCommandSpecから自己記述する",
    arguments: [
      positional("command", "command", "詳細を表示するコマンド名", {
        required: false,
        valueType: "command-name",
      }),
    ],
    options: [booleanOption("all", "全コマンドの詳細を表示する")],
    constraints: [
      {
        kind: "option-conflicts-with-argument",
        option: "all",
        argument: "command",
        message: "describeではcommand引数と--allを同時指定できません",
      },
    ],
    rules: [
      "引数なしではコマンド名と要約だけを返す",
      "command指定時はそのコマンドだけのフラグ・制約・入出力例を返す",
      "--all時だけ全コマンドの詳細を返す",
    ],
    example: {
      input: "tlk describe --json",
      output: {
        commands: [
          { name: "add", summary: "タスクを登録する" },
          { name: "list", summary: "タスクを一覧表示する" },
          { name: "show", summary: "IDまたはタイトル断片で1件を表示する" },
          { name: "done", summary: "タスクを完了にする" },
          { name: "reopen", summary: "完了済みタスクをopenに戻す" },
          { name: "edit", summary: "タスクのtitle・due・labels・noteを編集する" },
          { name: "rm", summary: "誤登録したタスクを物理削除する" },
          { name: "describe", summary: "コマンド仕様をCommandSpecから自己記述する" },
          { name: "validate", summary: "JSONLデータを読み取り専用で診断する" },
        ],
      },
    },
  },
  {
    name: "validate",
    summary: "JSONLデータを読み取り専用で診断する",
    arguments: [],
    options: [],
    constraints: [],
    rules: [
      "パース不能行・ID重複・既知フィールド不正を行番号付きで報告する",
      "status=doneとclosedありの同値関係を検証する",
      "データは変更しない",
    ],
    example: {
      input: "tlk validate --json",
      output: { valid: true, task_count: 1, issues: [] },
    },
  },
] as const satisfies readonly CommandSpec[];

export type DefinedCommandSpec = (typeof COMMAND_SPECS)[number];
export type CommandName = DefinedCommandSpec["name"];

/** Runtime command names are derived from the same specs used by parsing and help. */
export const COMMAND_NAMES: readonly CommandName[] = COMMAND_SPECS.map(({ name }) => name);

export const isCommandName = (value: string): value is CommandName =>
  COMMAND_SPECS.some(({ name }) => name === value);

export const getCommandSpec = (name: string): DefinedCommandSpec | undefined =>
  COMMAND_SPECS.find((spec) => spec.name === name);

export const getEffectiveOptions = (spec: CommandSpec): readonly OptionSpec[] => [
  ...spec.options,
  ...GLOBAL_OPTIONS,
];

export const commandUsage = (spec: CommandSpec, programName = "tlk"): string => {
  const renderedArguments = spec.arguments.map((argument) => {
    const value = `<${argument.valueName}>`;
    return argument.required ? value : `[${value}]`;
  });
  const options = getEffectiveOptions(spec).length > 0 ? ["[options]"] : [];
  return [programName, spec.name, ...renderedArguments, ...options].join(" ");
};

const renderOptionSignature = (option: OptionSpec): string => {
  const names = [...option.aliases, `--${option.name}`];
  const suffix = option.kind === "value" ? ` <${option.valueName}>` : "";
  return `${names.join(", ")}${suffix}`;
};

const describedConstraints = (spec: CommandSpec): readonly string[] =>
  [...new Set([...spec.constraints.map(({ message }) => message), ...spec.rules])];

export type CommandSummary = Readonly<{
  name: CommandName;
  summary: string;
}>;

export type OptionDescription = Readonly<{
  name: string;
  aliases: readonly string[];
  kind: "boolean" | "value";
  value_name?: string;
  repeatable: boolean;
  description: string;
  conflicts: readonly string[];
}>;

export type CommandDescription = Readonly<{
  name: CommandName;
  summary: string;
  usage: string;
  arguments: readonly Readonly<{
    name: string;
    value_name: string;
    required: boolean;
    description: string;
  }>[];
  flags: readonly OptionDescription[];
  constraints: readonly string[];
  input_example: string;
  output_example: unknown;
}>;

export const describeSummary = (): Readonly<{ commands: readonly CommandSummary[] }> => ({
  commands: COMMAND_SPECS.map(({ name, summary }) => ({ name, summary })),
});

export const createCommandDescription = (spec: DefinedCommandSpec): CommandDescription => ({
  name: spec.name,
  summary: spec.summary,
  usage: commandUsage(spec),
  arguments: spec.arguments.map(({ name, valueName, required, description }) => ({
    name,
    value_name: valueName,
    required,
    description,
  })),
  flags: getEffectiveOptions(spec).map((option) => ({
    name: `--${option.name}`,
    aliases: option.aliases,
    kind: option.kind,
    ...(option.kind === "value" ? { value_name: option.valueName } : {}),
    repeatable: option.kind === "value" && option.repeatable,
    description: option.description,
    conflicts: option.conflicts.map((name) => `--${name}`),
  })),
  constraints: describedConstraints(spec),
  input_example: spec.example.input,
  output_example: spec.example.output,
});

export const describeCommand = (name: string): CommandDescription | undefined => {
  const spec = getCommandSpec(name);
  return spec === undefined ? undefined : createCommandDescription(spec);
};

export const describeAll = (): Readonly<{ commands: readonly CommandDescription[] }> => ({
  commands: COMMAND_SPECS.map(createCommandDescription),
});

export const renderGlobalHelp = (programName = "tlk"): string => {
  const commandLines = COMMAND_SPECS.map(
    ({ name, summary }) => `  ${name.padEnd(10, " ")} ${summary}`,
  );
  const optionLines = GLOBAL_OPTIONS.map(
    (option) => `  ${renderOptionSignature(option).padEnd(22, " ")} ${option.description}`,
  );
  return [
    "Task Lake - 小さいタスクをローカルで管理する",
    "",
    `Usage: ${programName} <command> [options]`,
    "",
    "Commands:",
    ...commandLines,
    "",
    "Global options:",
    ...optionLines,
    "",
    `Run '${programName} <command> --help' for command details.`,
  ].join("\n");
};

export const renderCommandHelp = (
  specOrName: DefinedCommandSpec | string,
  programName = "tlk",
): string => {
  const spec = typeof specOrName === "string" ? getCommandSpec(specOrName) : specOrName;
  if (spec === undefined) {
    return renderGlobalHelp(programName);
  }

  const argumentSection =
    spec.arguments.length === 0
      ? []
      : [
          "",
          "Arguments:",
          ...spec.arguments.map(
            (argument) =>
              `  ${`<${argument.valueName}>`.padEnd(22, " ")} ${argument.description}${
                argument.required ? "" : " (optional)"
              }`,
          ),
        ];
  const optionSection = [
    "",
    "Options:",
    ...getEffectiveOptions(spec).map(
      (option) =>
        `  ${renderOptionSignature(option).padEnd(22, " ")} ${option.description}${
          option.kind === "value" && option.repeatable ? " (repeatable)" : ""
        }`,
    ),
  ];
  const constraints = describedConstraints(spec);
  const constraintSection =
    constraints.length === 0
      ? []
      : ["", "Constraints:", ...constraints.map((constraint) => `  - ${constraint}`)];

  return [
    `${spec.name} - ${spec.summary}`,
    "",
    `Usage: ${commandUsage(spec, programName)}`,
    ...argumentSection,
    ...optionSection,
    ...constraintSection,
    "",
    "Example:",
    `  ${spec.example.input}`,
    `  ${JSON.stringify(spec.example.output)}`,
  ].join("\n");
};

export const renderDescribeSummary = (): string =>
  describeSummary()
    .commands.map(({ name, summary }) => `${name}\t${summary}`)
    .join("\n");

export const renderDescribeAll = (): string =>
  COMMAND_SPECS.map((spec) => renderCommandHelp(spec)).join("\n\n");
