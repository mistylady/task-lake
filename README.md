# Task Lake (`tlk`)

Task Lake は、Redmine に登録するほどではない小さな作業をローカルの1つの箱で管理する CLI です。人間が読みやすく、AI エージェントが少ない往復で安全に操作できる、決定的な入出力を重視しています。

## 導入

[Bun](https://bun.sh/) を用意し、このリポジトリで次を実行します。

```sh
bun install
bun run tlk --help
```

開発中は `bun run tlk <command>` で実行できます。`package.json` の `bin` は `tlk` を `src/index.ts` に割り当てているため、任意の Bun 対応の方法でリンクまたはパッケージ化することもできます。実行時依存はありません。

データは既定で `~/.task-lake/tasks.jsonl` に保存されます。テストや一時利用では保存ディレクトリを変更できます。

```sh
TASK_LAKE_HOME=/tmp/my-task-lake bun run tlk list --json
```

## 使い方

```sh
# 登録
bun run tlk add "A社へ返信する" --due 2026-07-20 -l redmine:1234
bun run tlk add "ログを調べる" --note - < investigation.txt

# 一覧と詳細（通常のlistはopenのみ、期限順）
bun run tlk list
bun run tlk list -l redmine:1234 --json
bun run tlk list --all --limit 100
bun run tlk show 12
bun run tlk show "A社へ"

# ID完全一致で変更
bun run tlk done 12 --note "対応済み"
bun run tlk reopen 12
bun run tlk edit 12 --title "A社へ再返信する" --clear-due
bun run tlk edit 12 --add-label followup --remove-label redmine:1234
bun run tlk edit 12 --set-labels followup,customer --note "確認待ち"
bun run tlk rm 12

# CLIスキーマとデータ診断
bun run tlk describe
bun run tlk describe edit --json
bun run tlk describe --all --json
bun run tlk validate --json
```

全コマンドが `--json` を受け付けます。変更系の成功結果は常に次の形です。

```json
{"changed":true,"task":{"id":"12","title":"A社へ返信する","status":"open","labels":[],"created":"2026-07-15T21:30:00+09:00"}}
```

`list --json` は `{"total": ..., "items": [...]}` を返します。項目から `note` は除かれ、代わりに `has_note` が入ります。`show` だけがタイトル断片を受け付け、複数候補がある場合は候補付きのエラーになります。`done`、`reopen`、`edit`、`rm` は誤操作を避けるため数値 ID のみを受け付けます。

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
{"error":{"code":"not_found","message":"ID 12 のタスクが見つかりません","next_step":"tlk list --json でIDを確認してください"}}
```

## 保存の安全性

変更時はロックを取得してから最新データを読み直し、旧データを `tasks.jsonl.bak` に原子的に更新した後、同じディレクトリの一時ファイルを `rename` して本体を差し替えます。不正なJSONLや重複IDなどを見つけた場合は変更しません。ロックは自動強奪しません。

このMVPが保証するのはプロセスクラッシュ時の部分書き込み防止までです。電源断に対する `fsync` ベースの耐久性は保証しません。

## 開発

```sh
bun test
bun run typecheck
```

実装は純粋関数コアと薄いI/O層に分かれています。引数解析、ヘルプ、`describe` は同じ CommandSpec を参照します。
