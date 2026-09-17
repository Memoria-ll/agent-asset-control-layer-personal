# Agent Asset Control Layer — 実装設計書（個人用）

更新日: 2026-09-17
状態: Draft

本書は、[AACL 開発要求 v16](aacl-requirements-personal.md)を実装するための技術要件と内部設計をまとめる。利用者に見える機能・責務・動作の正本は開発要求書とし、本書ではそれらを再定義しない。

## 1. 目的と初回実装範囲

初回実装では、開発要求 v16 の対象機能一式を同時に実装する。実装単位はCore Service、MCP adapter、CLI、localhost UI、Runtime adapter、永続化・export / Backup層に分ける。要求書に定義された動作条件は、各層の実装・試験へ追跡可能にする。

## 2. 構成と責務境界

```text
Claude Code / Codex (Windows または同一WSL内のLinux)
          │ MCP: Streamable HTTP
          ▼
     AACL Core Service ───── localhost UI / CLI
          │
          ├── 単一SQLite（Canonical State）
          └── 登録済みRuntime設定先へ生成入口を配置
```

- Core Serviceを全機能のデータアクセス境界とし、Asset、Project、Workflow Run、Snapshot、Journal、履歴、Proposal等の状態をSQLiteへ永続化する。
- SQLiteへの読み書きはCore Service内へ閉じ、UI、MCP adapter、CLIからの直接DBアクセスを設けない。
- Coreのfilesystem accessをAACL管理フォルダー、登録されたRuntime設定先、Project path照合、ユーザー指定のexport / Backupに制限する。
- Runtime上の開発操作をCoreのプロセスで実行しない。

## 3. 実行環境と保存場所

- 実装言語はTypeScript、実行環境はWSL上のNode.js 24とする。Node.js 24はWSL側に必要で、AACLには同梱しない。
- Coreアプリケーションとデータは同じAACL管理フォルダーに配置する。既定場所は`$XDG_DATA_HOME/aacl`（通常`~/.local/share/aacl`）とし、初期設定時に別の場所を選択できる。
- アンインストールで削除するのはAACL管理フォルダーだけとする。Claude Code / Codex設定先に生成したRuntime入口は残す。
- Coreは永続localhost Serviceとする。`aacl serve`で明示起動でき、RuntimeまたはCLIから利用するとき未起動なら起動する。
- Serviceはloopbackだけにbindし、初回実装ではユーザー認証を設けない。外部LANからは接続させない。
- UIはJavaScriptが有効なChromium系ブラウザーを対象とし、Windowsホストまたは同じWSL内からlocalhost経由で利用する。

## 4. ProjectとRuntime入口

### 4.1 Project identity

- Project registryはstable IDと、要求書のProject Identity規則に従って正規化したroot pathを保持する。
- Path adapterはWindows形式・Linux形式の入力をCore内のLinux path表記へ変換し、区切り文字とdot segmentを正規化してregistry照合へ渡す。
- Path変換とregistry照合を分離し、別名生成やsymlink解決を追加しない。

### 4.2 Scopeと初期導入

- Global AssetとProject Assetは単一SQLite内のscope付きrecordとして保存し、Project recordにはproject_idを持たせる。
- Project初期導入の登録とGlobal bindingの複製は一つのtransactionで行い、参照Assetは複製しない。
- Project CommonとbindingはProject scopeの関連recordとしてAsset本体と分離して保存する。

### 4.3 Runtime入口

- Runtime adapterはGlobal設定先を標準位置から列挙し、ユーザー登録先を同じ形式で保持する。Windows側とWSL側の設定先は個別のtargetとして扱う。
- Runtime entryは対象Canonical Assetの安定IDのみを格納する薄い生成物とし、Canonical本文や処理定義を含めない。
- File writerは対象Runtime・scopeに応じた配置先へentryを生成し、部分失敗を個別に検出できる単位で処理する。
- 生成状態とCanonical Stateの整合確認に失敗した場合、DB transactionを巻き戻さずDiagnosticsへ失敗結果を記録する。

### 4.4 起動後の動作

| Runtime entry | Core operation mapping |
| --- | --- |
| Workflow入口 | 型付きMCP operationでWorkflow IDを送り、Run開始応答からRun Context Handleを得る |
| Skill入口 | 型付きMCP operationでAsset IDを送り、Canonical Skill本文を取得する |

各operationの製品動作は開発要求書で定義し、本書ではRuntime adapterとCore operationの対応だけを定める。

## 5. Canonical Assetと保存モデル

### 5.1 Asset共通

- Canonical AssetはWorkflow、Skill、Role、Ruleの4種とする。
- Coreが生成するUUIDをAsset IDとし、名前変更後も同じIDを使う。
- Asset revisionは単調増加整数とし、現在値と不変の過去revisionを分離して保存する。
- Revision recordにはAsset ID、revision、本文、更新時刻を含め、Run開始時の参照を再現できるindexを用意する。
- Writeの適用とoperation IDの冪等記録を同一transactionに含める。revision比較による通常Writeの拒否は設けない。
- 過去revisionの復元は、その内容を新revisionとして保存する。
- ScopeはGlobal / Projectを共通record上で識別し、同名Assetの一意性を名前に依存させない。

### 5.2 Schema境界

- SchemaはCore内部の保存・受け渡し契約として実装し、独立したAsset recordを作らない。
- 内容schemaを持つ対象はSkill、Journal、Workflow、Stageとする。Role、Rule等は保存・参照に必要な共通recordとする。
- Schemaの具体的な表現、DB正規化、version、migrationは実装事項とする。
- Validatorは要求書で指定された構造条件だけを検査し、自由記述の値に意味解釈を加えない。

### 5.3 Skill、Workflow、Stage

- Skill recordの必須本文fieldはname、description、bodyとし、useCase設定をRuntime target生成処理へ渡す。
- Workflow recordはStage listとtransition定義を保持し、StageはWorkflow内の子recordとして保存する。
- Stage recordのcompletion_conditionを必須fieldとして検証する。Skill、Role、Rule参照はnullable relationとして表現する。
- Task相当のfieldはStageに格納し、Task用の独立tableを設けない。

## 6. Workflow Run

### 6.1 Run開始とContext

- Workflow Run開始用とSkill本文取得用に、別々のtyped MCP operationを実装する。Skill取得operationはRun Contextを生成しない。
- `run.start`の応答にRun IDとRun Context Handleを含める。IDを各AI要求に再入力させないよう、Runtime接続層で以後の要求にHandleを付与する。
- 一つのRuntime実行Contextから一つのRun Handleだけを利用できるようbindingを分離する。
- Run開始transactionでWorkflowと参照revisionの境界を固定し、Snapshotの初期recordを作成する。Asset更新後もRunは開始時のrevision参照を保持する。
- ResolverはAsset ID relationを再帰的にたどり、visited setで重複排除と循環検出を行う。必須参照不在時の開始失敗と、任意supporting fileの取得失敗理由を別結果として扱う。
- Run IDをpartition keyとして状態、Context参照、Snapshot、Journal link、append-only eventを分離する。

### 6.2 MCPのRun関連づけ

- 採用transportはStreamable HTTPとする。MCP 2026-07-28仕様はprotocol sessionを使わないため、Run関連づけはアプリケーション側のContextとして実装する。[MCP Transport仕様](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)
- Run Context HandleをRuntime / 接続層が各操作へ自動付与し、AIの手入力を不要にする。
- 具体的なRuntime接続方式・Context注入方式は内部設計事項とし、Claude Code / Codexの双方でRunが混線しないことを結合試験で確認する。

### 6.3 実行状態と遷移

- Runの終端状態は`completed`、`cancelled`、`failed`。ユーザーの中止は`cancelled`、継続不能の報告またはtimeoutは`failed`とする。
- Workflowの進行可能な遷移はCoreが管理する。AIまたはユーザーが完了判断後に遷移を選び、Coreは構造と現在状態を検証する。
- transition更新はSQLite transactionで直列化する。同一操作の再送は`duplicate`、既に状態が進んだ後の別要求は`stale`として記録し、現在状態を不正に戻さない。
- Run eventはappend-onlyで保存する。
- 非活動timeoutは既定24時間とし、Global設定で変更できる。読み取りを含むRun-scoped MCP操作があればtimeoutの活動時刻を更新する。

### 6.4 Workspace

- Run schemaにWorkspace fieldやworkspace relationを設けず、workspace作成、worktree制御、実ファイルlockを実装しない。

## 7. JournalとJournal Review

### 7.1 Journal入力

- Journal write APIはMarkdown bodyを受け、Run Context Handleまたはpost-run targetからassociationを決定する。個別IDのAI入力を要求しない。
- Parserは固定見出しを文字列として照合する。見出し対応、重複見出しの順序連結、未知見出しの自由記述格納、原文保存をunit testで固定する。
- Parseに失敗した断片を破棄・推測分類しない。raw bodyと構造化部分を同一Journal revisionへ保存する。

### 7.2 Journal ReviewとProposal

- Proposal、insight status、Change Set relationは別recordとして保存し、Review起動そのもののRunを作らない。
- Change Set適用と対象insightのprocessed更新は同一DB transactionとする。重複操作はoperation IDで冪等に扱う。

## 8. UI、CLI、MCP

- UI、CLI、MCPはCore Serviceのapplication APIだけを利用する。UIからの変更も同じvalidation・transaction pathへ送る。
- MCP adapterはpurpose-specific typed operationを登録し、generic action dispatchやSQL passthroughを実装しない。
- Request / Responseの型と内容schemaは内部契約として管理し、Skill、Journal、Workflow、Stageのpayloadを検証する。
- CLI bootstrapはService起動、Project登録、health確認、診断、export / Backup commandを提供する。

## 9. ExportとBackup

- SerializerはAsset / JournalをMarkdown + YAML front matter、Run / Snapshot / History等のrecordをJSONへ写像する。
- Exportはユーザー指定directoryへの明示的なfile writeとして実装し、Canonical SQLite stateを書き換えない。
- Backup formatはSQLite整合性を保つ取得方式を選び、復元時のschema migrationとの互換条件を定義する。

## 10. 初回実装で確認する重要条件

- Claude CodeとCodexの両方からStreamable HTTPで接続できる。
- Windowsホストと同一WSL内Linuxから同じCoreへ接続でき、Windows / LinuxのProject path表記が同一登録Projectへ解決される。
- Workflow入口からRunを開始し、AIにRun IDを手入力させず、並行する別Runへ誤関連づけしない。
- `useCase=true` Skillの入口はAsset IDだけを指し、MCP取得で最新のCanonical本文を渡す。Skillの直接実行がRunやJournalに誤記録されない。
- Runtime設定先を追加すると対象入口が配置され、設定先の管理解除では既存入口ファイルが残る。
- Journalの未知内容・解析不能内容・重複見出し・入力原文が欠落しない。
- Asset更新、Run遷移、Journal Reviewの採否・適用が定義したrevision・冪等性・状態の整合性を保つ。

## 11. 内部設計で確定する事項

次は製品動作の選択ではなく、合意した設計を実装するために実装者が決める事項である。

- SQLiteテーブル、内部schema表現、migration方式、index、operation IDの形式
- MCP tool名、各payload、Bootstrap本文、HTTP endpointの構成
- Streamable HTTP接続にRun Contextを自動結び付ける具体策と、両Runtimeでの起動方法
- Runtime別標準設定先の検出方法、設定先追加画面、生成ファイル名と衝突回避
- UI画面構成、編集フォーム、diff表示、エラー表示
- Journal見出しの確定文字列とMarkdown構文処理の詳細
- Backup形式、オンライン取得時の整合性確保、復元フロー
- Setup / uninstall UI・CLI。データ削除範囲はAACL管理フォルダー内に限定する

## 12. 要求トレーサビリティ

本書の実装条件と試験観点は、開発要求 v16 の各節へ対応づける。利用者に見える仕様の追加・変更は開発要求書へ記載し、その後に必要な実装条件を本書へ反映する。
