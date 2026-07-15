## Task Lake

- 小タスクは `tlk add "title" --json`、確認は `tlk list --json` / `tlk show <id> --json` を使う。
- 案件紐付けはラベルで統一: Redmineは `-l rdm:<番号>`、GitHubは `-l gh:<番号>`。
- 変更は一覧でIDを取得してから `tlk done|reopen|edit|rm <id> --json` を使う。変更系でタイトル断片を指定しない。
- 再送は安全（`done` / `reopen` / 存在しないIDの`rm`はno-op成功）。失敗時はJSONエラーの `next_step` に従う。
- 詳細なCLIスキーマが必要なときだけ `tlk describe <command> --json`、全量は `tlk describe --all --json` を使う。
