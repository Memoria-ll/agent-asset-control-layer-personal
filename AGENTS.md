# AACL実装の規約

- 製品の正本は`.reqirements/aacl-requirements-personal.md`、技術条件は`.reqirements/aacl-implementation-design-personal.md`。対応範囲はWSLのNode.js 24、JavaScript有効のChromium、Claude Code / Codex。
- 正式な検証は`npm run check`。初回は`npm ci`と`npx playwright install chromium`を実行する。ビルド・Core／HTTP／CLI・画面テストを順に通す。
- UI・MCP・CLIのデータ操作は`src/operations.ts`からCoreへ渡す。SQLiteへ直接アクセスするコードはServiceと新規管理先へのBackup復元に閉じる。
- Canonical Writeとoperation IDの保存は同じtransaction。非同期処理を`Store.write`のcallbackへ入れない。Runtime入口のfilesystem同期はcommit後に実行し、失敗を診断へ保存する。
- Assetを物理削除しない。Snapshot・delivery・event・history・provenance・decision・Change Setは不変、復元は新revision。Context提供と実利用報告を別に保存する。
- RunのContext取得にはHandleを必須とする。初期Contextへ未取得Skill本文を含めない。Run単位の操作にworkspaceやModelの構造化管理を追加しない。
- `web/view-model.ts`がUI表示から分離した判断ロジック。関係のたどり方・遷移図などの分岐を変更したら、実データを使う`test/core.test.ts`で振る舞いを固定する。画面からの操作は`test/ui.spec.ts`で確認する。
- テストで利用者のRuntime設定先や既存DBを変更しない。CLI・filesystemの試験はOSの一時ディレクトリを使う。
- 改行は`.gitattributes`のLFへ統一し、編集後は行数と差分を確認する。
- CodeGraphの索引は`.codegraph/`、ローカルMCP設定は`.mcp.json`。どちらもGitの対象外。コード理解は`codegraph node <symbol>`または`codegraph explore <query>`から始める。
- ここではskills、rules、models、workflowはこのプロジェクトaaclの中の話として受け取って。