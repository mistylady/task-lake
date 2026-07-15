---
name: use-task-lake
description: ローカルタスク管理CLI「tlk」（Task Lake）の操作。ユーザーがタスク・TODOの登録/確認/完了/編集/削除を頼んだとき（「タスクに積んでおいて」「今日やることは?」「あれ完了にしといて」「期限切れある?」等）、Redmineチケットにするほどでもない小さい作業をローカルに記録したいとき、tlk・task-lake という語が出たときに必ず使う。
---

# tlk（Task Lake）の操作

ローカルの `~/.task-lake` にタスクを一元管理するCLI。AIエージェント向けに設計されており、全コマンドが `--json`・意味のある終了コード・構造化エラーを備える。

## 基本規則

- 常に `--json` を付ける。stdoutはデータのみ、エラーはstderrに1行のJSON
- **変更系（`done` / `reopen` / `edit` / `rm`）はID必須**。タイトルでは指定できない。IDが不明なら先に `tlk list --json` で特定する
- 再送は安全（冪等）: done済みへの`done`、openへの`reopen`、存在しないIDへの`rm` は `changed:false` の成功になる。exit 0なら再実行不要
- 失敗したらstderrのエラーJSONの `code` と `next_step` に従う。終了コード: 0=成功 / 1=io・internal / 2=usage / 3=not_found / 4=ambiguous / 5=validation

## よく使う操作

```bash
# 登録（作成されたタスクが返る。案件紐付けはラベルで。記法: Redmine=rdm:1234 / GitHub=gh:123）
tlk add "見積書のレビュー" --due 2026-07-20 -l rdm:1234 --json
tlk add "タイトル" --note - --json   # 長いnoteはstdinから

# 一覧（openのみ・期限昇順。noteは出ず has_note で有無が分かる）
tlk list --json
tlk list --all --json        # done込み・新しい順50件（--limit Nで調整、0で無制限）
tlk list -l rdm:1234 --json

# 詳細（noteの中身を見るのはこれ。タイトル断片でも一意なら引ける）
tlk show <id> --json

# 完了・取消・編集・削除
tlk done <id> --note "対応済みの補足" --json
tlk reopen <id> --json
tlk edit <id> --due 2026-07-25 --add-label urgent --json
tlk edit <id> --clear-due --clear-note --json
tlk rm <id> --json           # 誤登録の物理削除専用。作業が終わったなら done を使う
```

## フラグや制約が不明なとき

`tlk describe <command> --json` でそのコマンドの引数・制約・入出力例が取れる（`--help` より機械可読）。コマンド一覧は `tlk describe --json`。

## 注意

- `due` は `YYYY-MM-DD` の実在日付のみ。`tomorrow` 等の相対指定は不可（今日の日付から計算して渡す）
- 完全非対話。確認プロンプトは出ないので応答待ちをしない
- データ異常を疑ったら `tlk validate --json` で診断。書き換え前バックアップは `~/.task-lake/tasks.jsonl.bak`
