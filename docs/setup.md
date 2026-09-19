# 導入・利用手順

Claude Code / Codexで使うWorkflow・Skill・Role・Ruleを管理し、Workflow実行とJournalから開発方法を改善する個人用アプリです。正本はWSL上のSQLiteに保存します。

要件の正本は[開発要求](../.reqirements/aacl-requirements-personal.md)、技術条件は[実装設計](../.reqirements/aacl-implementation-design-personal.md)です。

## 開発用に起動する

WSL上のNode.js 24とnpmが必要です。UIはJavaScriptが有効なChromium系ブラウザーで利用します。

```bash
npm ci
npm run dev
```

[http://127.0.0.1:4318](http://127.0.0.1:4318)を開きます。開発用データは、このリポジトリの`.local/`に保存します。Workflowのサンプルや利用者の資産は自動登録しません。

## アプリとして導入する

GitHubからCLIを一度実行してアプリを導入します。WSL上のNode.js 24、npm、Gitが必要です。GitHub指定はnpm packageのscope形式ではなく、`github:owner/repository`形式を使います。

```bash
npm exec --yes --package=github:Memoria-ll/agent-asset-control-layer-personal -- aacl setup
```

導入用のBuild済みCLIをリポジトリに含めているため、GitHubから実行するときにBuildは不要です。npm 12以降はGit依存を既定で拒否するため、その場合はこのコマンドでGit導入を許可してください。

```bash
npm exec --yes --allow-git=all --package=github:Memoria-ll/agent-asset-control-layer-personal -- aacl setup
```

`setup`はBuildしたアプリと依存パッケージを管理フォルダーへコピーします。
更新時も同じコマンドを実行してください。Serviceを停止してアプリ部分だけを入れ替え、SQLiteのデータと生成済みRuntime入口は保持します。

4318で導入済みの環境を4319へ移行する場合だけ、先に4318のServiceを停止します。

```bash
npm exec --yes --prefer-online --package=github:Memoria-ll/agent-asset-control-layer-personal -- aacl --port 4318 stop
npm exec --yes --prefer-online --package=github:Memoria-ll/agent-asset-control-layer-personal -- aacl setup
```

既定の管理フォルダーは`$XDG_DATA_HOME/aacl`、未設定なら`~/.local/share/aacl`です。導入後のServiceとMCPは`127.0.0.1:4319`を使います。アプリ・依存パッケージ・データ・起動用CLIをこの中に配置します。初期設定時は`--dir /absolute/path/to/aacl`で別の保存先を選べます。既存の一般フォルダーを誤って管理対象にしないよう、空のフォルダーかAACL管理フォルダーを受け付けます。

導入後に表示される`bin`のパスをPATHへ追加してください。既定場所なら次のとおりです。

```bash
export PATH="$HOME/.local/share/aacl/bin:$PATH"
aacl health
```

`setup`はJournal記録用の`journal`、横断レビュー用の`journal-review`をCanonical Skillとして導入します。本文・description・explanationは編集できますが、2件の名称と削除状態は固定です。`journal`は直接起動入口を持たず、設定・接続のJournal記録ON/OFFで制御します。`journal-review`はユーザーが明示的に起動します。UIの「設定・接続 → Journal用Skillを導入」から追加することもでき、導入済みの本文は上書きしません。

| コマンド | 動作 |
| --- | --- |
| `aacl serve` | loopbackにServiceを起動 |
| `aacl ensure` | 未起動ならバックグラウンドで起動 |
| `aacl autostart <action>` | `enable`、`disable`、`status`でWindowsログオン時のWSL Service自動起動を管理 |
| `aacl connect` | 起動を確認しMCPの登録コマンドを表示 |
| `aacl init` | 現在のディレクトリをProject rootとして登録 |
| `aacl health` | Service・管理フォルダー・プロセスを確認 |
| `aacl diagnostics` | 参照・実行状態・提供Context量を診断 |
| `aacl export /absolute/new-directory` | Markdown / JSONを出力 |
| `aacl backup /absolute/new-backup.sqlite` | 整合性を保ったSQLite Backupを出力 |
| `aacl restore /absolute/backup.sqlite --dir /absolute/new-aacl` | 新規管理フォルダーへデータとアプリを復元 |
| `aacl stop` | Serviceを停止 |
| `aacl uninstall --yes` | 確認した管理フォルダーを削除 |

全コマンドに`--dir`と`--port`を指定できます。インストールされたCLIには導入時の場所とportが設定されます。Backupの復元対象はschema version 1です。出力済みのExportやBackupを上書きする場合は、利用者が別の出力先を選びます。

## Claude Code / Codexから利用する

`aacl setup`はWindowsログオン時のタスクスケジューラ登録も行い、対象WSL内でServiceを自動起動します。状態は`aacl autostart status`、解除は`aacl autostart disable`、再登録は`aacl autostart enable`です。起動タスクは`aacl ensure`を呼ぶため、既に同じServiceが起動している場合はそのまま使います。

Serviceを確認した後、接続先RuntimeでMCPを登録します。

```bash
aacl connect
codex mcp add aacl --url http://127.0.0.1:4319/mcp
claude mcp add --transport http aacl http://127.0.0.1:4319/mcp
```

MCP endpointはStreamable HTTP、protocol revisionは`2026-07-28`です。Runの対応づけには`run.start`が返す`contextHandle`を使用します。後続のRun操作へAIがこの値を渡します。

配置するWorkflow CommandとCodex Skillには、対象Asset IDを渡すMCP operationだけを記載します。Skill入口にはRuntime用の`name`と`description`も持たせます。入口は`aacl ensure`やshell commandを実行しません。Windowsログオン後は同じWSLのServiceへlocalhostで接続できます。Serviceを手動停止した場合は、WSLで`aacl ensure`を実行して再開します。

Projectで`aacl init`を実行すると、Globalの紐づけをProject用にコピーし、Project scopeのAsset用Runtime設定先を登録します。Project内にはProject専用の入口だけを配置し、Global入口はGlobal設定先に置きます。Global設定先はUIで標準候補を確認して登録できます。生成するSkill入口には`name`、`description`、Asset IDと取得手順を記載し、Canonical本文は発火後にSQLiteから取得します。Codex入口では暗黙起動の制御を`agents/openai.yaml`の`policy.allow_implicit_invocation: false`へ記載します。生成後に利用者が編集した入口は自動上書きせず、診断へ記録します。

Asset、紐づけ、Project Commonの書き込みでは、新しい`operationId`を使用してください。同じ操作の再送時だけ、同じIDと同じ入力を再利用します。既存対象の更新・解除には取得時点の`expectedRevision`を付け、複数変更は`aacl_changeset_preview`でDry Runしてから適用します。`asset.save`は全置換なので、本文や補助ファイルを省略せず完全なAssetを送ってください。AI経由の資産変更には`provenance.origin: "ai"`と`userRequest`・`reason`が必要です。`aacl_asset_list`は概要が既定で、本文は`includeBody`、`fields`、または`aacl_asset_get_many`で明示取得します。用途別のtool一覧と入力schemaはMCPの`tools/list`から取得できます。共通案内は`aacl_bootstrap_get`で取得します。

設定ファイルへのMCP登録は、上のコマンドを利用者のRuntime環境で実行します。アプリのセットアップは既存の認証情報やRuntime設定ファイルを編集しません。登録済み入口は、設定先の管理解除やAACLのアンインストール後も残ります。

## 画面での操作

- **資産ライブラリ**: 作成・編集、Skillの直接起動切り替え、Workflowの工程・遷移図、直接参照とRole経由の参照、Stage側／Asset側の紐づけ編集。
- **Workflow Run**: 明示的な開始、許可遷移の選択、完了報告、中止、Snapshot・提供内容・実行記録。
- **Journal / Journal Review**: タスク完了時の気づき記録ON/OFF、Markdown記録、気づきごとの保留・処理済み・却下、提案、ユーザー判断、承認済み変更の適用。
- **変更履歴**: Assetの過去版と現在版の比較、revision復元、Change Set適用前への復元、変更理由。
- **診断**: 明示参照の不整合、固定revisionの取得可否、反復遷移、提供ContextのUTF-8バイト量。
- **設定・接続**: Project、Project Common、Runtime設定先、非活動timeout、Journal記録ON/OFF、Export・Backup。

UIの提案作成フォームは、1つのAssetの本文・責務の変更を扱います。工程・遷移・複数資産・紐づけ・Project Commonをまとめた提案は、接続中AIから`aacl_proposal_save`で登録できます。UIで変更内容を確認し、判断・適用できます。

## 保存と実行の契約

`src/schema.ts`が入力の構造、`src/core.ts`が変更・解決・遷移、`src/store.ts`がSQLite境界です。UIとMCPは`src/operations.ts`の同じ検証・適用処理を通ります。CLIもServiceのAPIを使います。Backup復元は停止中の新規管理先へ行います。

Run開始時にWorkflow・関連Asset・紐づけ・Project Commonを不変Snapshotへ固定します。初期ContextにはWorkflow、現在Stage、Role、Rule、Skill catalogを渡し、Skill本文と補助ファイルは必要時に取得します。提供の記録と、実際に使ったという報告は別に保存します。

Journalの既知見出しは`Task`、`実際に使ったもの`、`良かった点`、`困った点`、`改善の種`、`根拠・確かさ`、`日付`、`Project`、`Branch`、`Type`です。重複見出しは順序を保って連結し、未知の見出し・断片・原文を保持します。良かった点・困った点・改善の種の空行区切りの段落を、独立した気づきとして扱います。

## 検証

```bash
npx playwright install chromium
npm run check
```

`check`はTypeScriptビルド、Node標準test runnerによるCore・HTTP／MCP・CLI試験、Chromiumによる画面操作を順に実行します。Nodeの試験だけなら`npm test`、画面だけならビルド後に`npm run test:ui`を使用します。

試験データはOSの一時ディレクトリに置き、利用者の資産・Runtime設定先を試験用に変更しません。試験とC01〜C35の対応、実環境での受入項目は[検証表](verification.md)に記載しています。

実際のClaude Code／Codexの複数チャットと、WindowsホストからWSLへの接続は受入確認が必要です。自動試験は同一Coreへ複数のHTTP／MCP要求を送り、Handleによる分離を確認します。

参考: [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)、[CodexのMCP接続](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)、[Claude CodeのMCP接続](https://code.claude.com/docs/en/mcp)。Runtime入口の配置先は、このリポジトリの要件書に従います。

## 既存Skill・指示の移行

既存ファイルをAACLへ移す際の分類、紐づけ、移行後の照合手順は[既存Skill・指示の移行ガイド](skill-migration.md)を参照してください。
