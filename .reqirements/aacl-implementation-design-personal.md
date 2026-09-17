# Agent Asset Control Layer — 実装設計書（個人用）

更新日: 2026-09-17
状態: Draft

本書は、AACL v15の製品要求を実装へ落とすために合意した設計をまとめる。細かな内部方式は実装者に委ね、ユーザーが決定した動作と責務境界を固定する。

## 1. 目的と初回実装範囲

AACLは、Claude CodeとCodexで利用する開発用AssetをCoreで管理し、Workflow実行、Journal、改善提案をローカルで支援する個人向けシステムとする。初回実装から、製品要求にある管理・実行・Journal・レビュー・CLI・UI・Backup / exportの全機能を対象とする。

実装対象は次のとおり。

- Core Service、MCP Interface、CLI、localhost UI
- Global / Project scopeのAsset、紐づけ、Project Common
- Project登録、Runtime入口の生成と更新
- Workflow、Stage、Run、Context、Snapshot
- Journal、Journal Review、Proposal、History、Provenance、Change Set、Diagnostics
- 明示的なexportとBackup

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

- CoreはSQLiteを唯一の正本として、Asset、Project、Workflow Run、Snapshot、Journal、履歴、提案等を管理する。
- UI、MCP、CLIはCoreを通じてデータを読み書きする。SQLiteへの直接アクセスはしない。
- CoreはAIによる開発作業、shell / Gitの任意操作、外部API呼び出しを担わない。filesystem accessはAACLデータ、Runtime入口、Project path照合、ユーザー指定のexport / Backupに限る。
- CapabilityはCoreの処理・保存対象に含めない。
- Model名は文字列としてそのまま受け渡す。CoreはModelの存在、利用可能性、provider、metadata、指定値と実使用値の一致を判断しない。

## 3. 実行環境と保存場所

- 実装言語はTypeScript、実行環境はWSL上のNode.js 24とする。Node.js 24はWSL側に必要で、AACLには同梱しない。
- Coreアプリケーションとデータは同じAACL管理フォルダーに配置する。既定場所は`$XDG_DATA_HOME/aacl`（通常`~/.local/share/aacl`）とし、初期設定時に別の場所を選択できる。
- アンインストールで削除するのはAACL管理フォルダーだけとする。Claude Code / Codex設定先に生成したRuntime入口は残す。
- Coreは永続localhost Serviceとする。`aacl serve`で明示起動でき、RuntimeまたはCLIから利用するとき未起動なら起動する。
- Serviceはloopbackだけにbindし、初回実装ではユーザー認証を設けない。外部LANからは接続させない。
- UIはJavaScriptが有効なChromium系ブラウザーを対象とし、Windowsホストまたは同じWSL内からlocalhost経由で利用する。

## 4. ProjectとRuntime入口

### 4.1 Project identity

- `aacl init`で、実行時に指定された現在のProject rootをCoreのProject registryへ登録する。
- Projectは登録済みroot pathとの完全一致で解決する。親ディレクトリ探索、Git root推測、Project Markerは使わない。
- Windows形式またはLinux形式で渡されたpathをLinux表記に変換し、`.`・`..`と区切り文字を正規化して照合する。path aliasは作らず、symlinkも解決しない。
- Project解決にはRuntimeが示す開いているProject rootのみを使う。

### 4.2 Scopeと初期導入

- GlobalとProjectのAssetは同じSQLiteに別Assetとして保存し、Project AssetはProject scopeで限定する。
- Project内にAACL管理用`.aacl`フォルダーは作らない。
- `aacl init`ではGlobalの紐づけをProject scopeへ複製して以後独立管理する。Global Asset本文は複製せず、Project Commonは空から開始する。
- Project Commonには、そのProjectで共通して使うRuleへの明示参照を保持する。
- Projectで使うAssetはProject scopeの紐づけまたはProject Commonから明示的に参照する。

### 4.3 Runtime入口

- Globalの入口はClaude CodeのCommand領域とCodexのSkill領域へ配置する。Projectの入口はProject内の`.claude/commands/`と`.codex/skills/`へ配置する。
- Global Runtime設定先は標準位置から検出し、UIで追加できる。追加先には、そのscopeで利用可能な全Use Case入口を生成する。Windows側とWSL側のGlobal設定先は別々に扱う。
- 設定先を管理対象から外す場合、既存ファイルを削除せず、以後Coreの管理対象から外す。
- 入口はRuntime固有の生成物であり、Canonical Asset本文を正本として扱わない。入口の実行定義は対象Assetの安定したIDを中心に構成する。
- `useCase=true`の変更でSkill入口を配置し、`false`への変更で管理対象の入口を解除する。入口の解除や名前変更はCanonical Assetを削除しない。
- 生成・更新・解除に失敗した場合はCanonical Stateを保持し、Diagnosticsへ記録する。

### 4.4 起動後の動作

| 入口の種類 | Coreの動作 | Workflow Run |
| --- | --- | --- |
| Workflow | MCP経由でWorkflowを特定し、Runを開始してContextを提供する | 作成する |
| `useCase=true`のSkill | 入口内のAsset IDを使い、MCP経由でCanonical Skill本文を取得してAIへ渡す | 作成しない |

Use Case Skillの直接実行についてCoreはRun、Snapshot、実行履歴、Journal関連、完了状態を管理しない。実行内容と完了の判断はユーザーとAIの責務とする。Journal Reviewもこの直接Skill利用に含み、レビュー内容や提案の永続化は個別のJournal / Proposal操作で行う。

## 5. Canonical Assetと保存モデル

### 5.1 Asset共通

- Canonical AssetはWorkflow、Skill、Role、Ruleの4種とする。
- Coreが生成するUUIDをAsset IDとし、名前変更後も同じIDを使う。
- 各Assetに単調増加する整数revisionを持たせる。revisionは履歴・Workflow Run・Snapshotの再現に使う。
- 古いrevisionを理由とした通常Writeの拒否や楽観的競合検出は行わない。Writeは現在状態を基に新revisionを作り、同じoperation IDによる再送は冪等に扱う。
- 過去revisionの復元は、過去内容を新しいrevisionとして保存する。
- Assetを実質的に取り下げる場合も削除・アーカイブせず、本文に`処置なし`等の空内容を示す記述を残す。Asset IDと紐づけは維持する。
- Global / Projectで同名Assetがあっても、異なるAsset IDなら別Assetとして扱う。

### 5.2 Schema境界

- SchemaはCore内部の保存・受け渡し契約であり、独立したAssetとしてユーザーに管理させない。
- 内容schemaを持つ対象はSkill、Journal、Workflow、Stageとする。Role、Rule等は保存・参照に必要な共通構造を持つ。
- Schemaの具体的な表現、DB正規化、version、migrationは実装上の選択とする。
- CoreはSkill本文、Stageの`completion_condition`、Journalの自由記述、コメント、根拠の意味を解釈しない。

### 5.3 Skill、Workflow、Stage

- Skillに必要な基本情報は`name`、`description`、`body`。`useCase`はRuntime入口の配置を切り替える設定であり、Use Case Skill専用の追加必須項目は設けない。
- WorkflowはStage一覧と許可するtransitionを持つ。
- StageをWorkflowの実行単位とし、独立したTask entityは設けない。各Stageは必須の`completion_condition`を持つ。
- StageのSkill、Role、Rule参照は任意とする。
- AIはStageの完了条件を評価し、利用可能なtransitionを選ぶ。Coreは現在状態・許可された遷移・必須構造のみを検証する。

## 6. Workflow Run

### 6.1 Run開始とContext

- RunはWorkflowを実行するときにのみ作成する。直接Skillを利用するだけではRunを作らない。
- `run.start`でRun IDとRun Context Handleを発行し、AIにIDを各操作へ入力させず、以後の操作を該当Runへ自動的に関連づける。
- 1つのAI実行コンテキストにつきRunは1つとする。並列Runは別々のAI実行コンテキストで行う。
- Run開始時にUse Case、Asset、紐づけ、Project Commonのrevision境界を固定する。実行中の更新は進行中Runへ影響させない。
- SnapshotはRun開始時に提供したContextとrevision構成を保持する不変記録とする。
- Context ResolutionはIDによる明示参照を再帰的に解決し、重複Assetを排除する。必須参照が解決できなければ開始を拒否する。循環参照は検出して失敗として記録する。任意supporting fileの取得失敗は理由付きでContextへ返す。
- RunごとにState、Context、Snapshot、Journal関連、イベント履歴を分離する。

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

- 複数Runは並行できるが、Coreはworkspaceを自動的に分離しない。同じProject作業領域を使う場合がある。
- worktree等による分離はユーザーまたはRuntimeが明示する。Coreはworkspace情報を記録するだけで、作成・削除や実ファイルの競合解決はしない。

## 7. JournalとJournal Review

### 7.1 Journal入力

- Journal SkillはAIへ固定見出しのMarkdownテンプレートを渡す。見出しが扱う内容はTask、実際に使ったもの、良かった点、困った点、改善の種、根拠・確かさとする。
- AIはJournal本文を送信し、Core IDや構造化JSONを組み立てない。
- Coreは既知見出しを機械的に構造化し、同じ既知見出しが重複する場合は出現順に連結する。
- 未知見出しや既知形式として構造化できない内容は自由記述へ保持する。意味を推測して欄へ割り当てず、入力原文も保存する。
- Journalの必須情報はTaskまたはRunへの関連と本文。Project、Stage、Snapshot、Asset revision等の関連は可能な範囲でCoreが実行Contextから付与する。AIにIDの手入力を要求しない。
- Workflow Run終了後にJournalを足す場合は、明示的に対象Runを指定するPost-run Journal操作とする。
- Runを伴わないUse Case Skillの直接実行はJournalへ自動関連づけしない。

### 7.2 Journal ReviewとProposal

- Journal Reviewはユーザーが明示的に起動するSkillであり、管理済みRunの新しいJournalと保留中の気づきを横断して読む。
- Review結果は気づき・提案単位で`pending`、`processed`、`rejected`を持つ。Reviewをしただけでは`processed`にしない。
- 提案は論理的な変更単位にまとめ、単一または複数Assetにまたがる変更を扱う。変更の採否はユーザーが決める。
- 合意済みChange Setの適用と対応する気づきの`processed`化は一連の操作として扱う。却下は`rejected`、保留は`pending`のまま残す。
- Coreは本文の意味や提案の妥当性を判断しない。Proposal、承認結果、変更、History、Provenance間の構造的な関連を保持する。

## 8. UI、CLI、MCP

- UIはAsset、紐づけ、Project Common、Workflow Run、Snapshot、Journal、History、Provenance、Diagnosticsの閲覧・編集を行う。
- Canonical情報の編集はUI経由でCoreへ送る。SQLiteやCanonical情報を直接ファイル編集する運用は提供しない。
- CLIはCore起動、`aacl init`、接続・health確認、保守、診断、export、Backupを提供する。
- MCPはAsset、Project、Workflow Run、Context、Journal、Proposal等の目的別operationを提供する。汎用action実行やSQLite CRUDは公開しない。
- MCPのRequest / Responseは型付きschemaで検証する。tool名と具体的schemaは実装時に決める。

## 9. ExportとBackup

- SQLiteが正本であり、exportは要求時にだけ生成する。出力先はユーザーが指定する。
- AssetとJournalの人間向け出力はMarkdownとYAML front matterを基本にする。Run、Snapshot、History、Provenance等の機械的な情報はJSONを基本にする。
- BackupはUIまたはCLIからユーザーが明示的に実行し、保存先もユーザーが指定する。自動`.backup`生成は必須にしない。
- Backupの具体的なファイル形式、整合性確保、復元操作は内部設計で決める。

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

## 12. 製品要求書との整合

製品要求書は機能範囲の参照元とし、本書と異なる記述がある箇所は別途整合させる。本書の作成では製品要求書を変更していない。少なくとも次の設計事項は要求書上の記載と整合が必要である。

- Project Markerを置かず、Core registryと正規化したProject root pathで識別する。
- Canonical Asset・管理記録の正本をSQLiteに置き、Markdown / JSONは要求時の出力とする。
- Capabilityの状態判定・管理をCoreの責務に含めない。
- Model metadataや利用可否をCoreで管理せず、Model名を不透明な文字列として扱う。
- `useCase=true` Skillの直接利用はRun、Snapshot、完了条件管理の対象にせず、入口からSkill本文をMCPで取得する。
- Workflowの実行単位をStageとし、Stageに必須`completion_condition`を置く。
- Journalを固定見出しMarkdownで受け取り、未知内容と原文を保持する。
- Asset編集はUI経由とし、直接ファイル編集をCanonicalな更新経路にしない。
