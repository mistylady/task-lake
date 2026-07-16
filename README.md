# Task Lake (`tlk`)

[English](README.en.md) | 日本語

Task Lake は、チケットにするほどではない小さな作業をローカルの1つの箱で管理する CLI です。

Task Lake を操作するのは、主に AI エージェント（Claude Code や Codex）です。タスクの登録、完了、編集はエージェントに任せ、人間はできあがった一覧を眺める。そういう使い方を前提に作りました。だから対話プロンプトや確認ダイアログの類はありません。もちろん手動でも普通に使えます。

エージェントが少ない往復で確実に動かせることを重視しています。全コマンドが `--json` の構造化出力に対応し（エージェントは常に付ける想定です）、終了コードは失敗の種類ごとに分かれています。エラーには必ず次の一手（`next_step`）が添えられます。

`done` や `rm` などの変更操作は冪等で、応答を見失って再送しても壊れません。ただし `add` だけは再送すると同じタスクが重複登録されるので、応答が不明なときは `list` で確認してから再試行します。

## 導入

[Bun](https://bun.sh/) を用意し、このリポジトリで次を実行します。

```sh
bun install
bun link          # tlk コマンドを ~/.bun/bin に登録する
```

`~/.bun/bin` が PATH に入っていない場合は追加してください（例: シェルの rc ファイルに `export PATH="$HOME/.bun/bin:$PATH"` を追記）。Windows（PowerShell）の場合はプロファイルに以下を追記します。

```powershell
$env:PATH = "$HOME\.bun\bin;$env:PATH"
```

プロファイルの場所:

- PowerShell 7: `~\Documents\PowerShell\Microsoft.PowerShell_profile.ps1`
- PowerShell 5（Windows PowerShell）: `~\Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1`

最後に動作確認します。

```sh
tlk --help
```

実行時依存はありません。リンクせずに使うときは `bun run --silent tlk <command>` でも同じ動きになります。`--silent` を付けない `bun run tlk` は bun 自身のログが stderr に混ざり、「エラー時は stderr に JSON 1件だけ」という保証が崩れるため、エージェントに使わせる場合は避けてください。

データは既定で `~/.task-lake/` の下に保存されます。平常時にあるのは次の3ファイルです。

```text
~/.task-lake/
├── tasks.jsonl       # タスクファイル（1行1タスクのJSONL）
├── tasks.jsonl.bak   # 直前の状態のバックアップ（1世代）
└── next_id           # 次に使うID（採番カウンタ）
```

実質的な変更を加えるたびに、直前の状態が `tasks.jsonl.bak` に1世代だけ残ります。冪等なno-op（done済みタスクへのdone再送など）ではバックアップもタスクファイルも更新しません。操作を間違えたときは、この `.bak` を `tasks.jsonl` に戻せば直前の状態に復旧できます。

`next_id` は採番用のカウンタで、削除後のID再利用を防ぎます。ファイルの中身はプレーンテキストの整数です。書き込み中は `tasks.jsonl.lock` とリネーム用の一時ファイルも作られますが、正常に終了すれば残りません。

テストや一時利用では保存ディレクトリを変更できます。

```sh
TASK_LAKE_HOME=/tmp/my-task-lake tlk list --json
```

## 使い方

```sh
# 登録
tlk add "A社へ返信する" --due 2026-07-20 -l rdm:1234
tlk add "ログを調べる" --note - < investigation.txt

# 一覧と詳細（通常のlistはopenのみ、期限順）
tlk list
tlk list -l rdm:1234 --json
tlk list --all --limit 100
tlk show 12
tlk show "A社へ"

# ID完全一致で変更
tlk done 12 --note "対応済み"
tlk reopen 12
tlk edit 12 --title "A社へ再返信する" --clear-due
tlk edit 12 --add-label followup --remove-label rdm:1234
tlk edit 12 --set-labels followup,customer --note "確認待ち"
tlk rm 12

# CLIスキーマとデータ診断
tlk describe
tlk describe edit --json
tlk describe --all --json
tlk validate --json
```

全コマンドが `--json` を受け付けます。変更系の成功結果は常に `{"changed": boolean, "task": Task | null}` の形です。`task` が `null` になるのは、存在しないIDへの `rm`（冪等なno-op）だけです。

```json
{"changed":true,"task":{"id":"12","title":"A社へ返信する","status":"open","labels":[],"created":"2026-07-15T21:30:00+09:00"}}
```

`list --json` は `{"total": ..., "items": [...]}` を返します。項目から `note` は除かれ、代わりに `has_note` が入ります。

タスクの特定方法はコマンドによって異なります。`show` だけがタイトル断片を受け付け、複数候補がある場合は候補付きのエラーになります。`done`、`reopen`、`edit`、`rm` は誤操作を避けるため数値 ID のみを受け付けます。

## AI エージェントから使う

エージェントに tlk を教える仕組みは、スキルとスニペットのセットで同梱しています。導入は2ステップです。

1. `skills/use-task-lake/` をエージェントのスキル置き場へコピーする（Claude Code ならプロジェクトの `.claude/skills/`）。スキルには全コマンド例、エラー回復手順、`describe` への誘導が入っており、タスク操作の依頼時だけ読み込まれます
2. `AGENTS-snippet.md` の2行を CLAUDE.md や AGENTS.md 等の指示ファイルに貼る。中身は「操作前に必ず `use-task-lake` スキルを読む」という誘導と、ラベル記法の取り決めだけです。スキルの自動発火は取りこぼしがあるため、常時指示から名前で呼ばせて確実にします

つまりスニペットが引き金、中身はスキルという分担です。常時コンテキストに載るのは2行ぶんで済みます。なお Codex など Claude Code 以外のエージェントには、AGENTS.md に SKILL.md のファイルパスを直接書いて読ませるのが確実です。

エージェントがフラグや制約を知りたいときは `tlk describe <command> --json` で機械可読なスキーマを取得できます。

ラベルの慣習: チケット紐付けは `rdm:<番号>`（Redmine）/ `gh:<番号>`（GitHub）の形式で統一します（ラベル自体は自由文字列です）。

## 終了コードとエラー

| exit | 意味 | JSONエラーcode |
|---:|---|---|
| 0 | 成功（冪等なno-opを含む） | — |
| 1 | I/Oまたは内部エラー | `io` / `internal` |
| 2 | 引数の誤り | `usage` |
| 3 | 対象なし | `not_found` |
| 4 | `show` の曖昧一致 | `ambiguous` |
| 5 | 引数値または保存データの不正 | `validation` |

`--json` 指定時の失敗は、stderr にJSONエンベロープを1件だけ出します。stdout にはデータ以外を混ぜません。

```json
{"error":{"code":"not_found","message":"ID「12」のタスクが見つかりません","next_step":"tlk list --json でIDを確認してください"}}
```

## 保存の安全性

変更時はまずロックを取得し、最新データと採番カウンタを読み直します。旧データをリネームで `tasks.jsonl.bak` へ退避した後、同じディレクトリの一時ファイルを `rename` してタスクファイルを差し替えます。実質的な変更がない場合はバックアップとタスクファイルの書き込みをスキップします。

採番カウンタは同じ方式でタスクファイルより先に更新し、削除済みIDの再利用を防ぎます。不正なJSONLや重複IDなどを見つけた場合は変更しません。ロックは自動強奪しません。

このMVPが保証するのはプロセスクラッシュ時の部分書き込み防止までです。電源断に対する `fsync` ベースの耐久性は保証しません。

## 開発

```sh
bun test
bun run typecheck
```

実装は純粋関数コアと薄いI/O層に分かれています。引数解析、ヘルプ、`describe` は同じ CommandSpec を参照します。
