# Agent Asset Control Layer — 実装決定事項

作成日: 2026-09-16  
状態: Draft

本書は、[aacl-requirements-personal.md](aacl-requirements-personal.md)で定義された製品要求を実装へ落とすために、2026-09-16時点で決定した事項をまとめる。製品要求書の代替ではなく、実装方針、責務境界、実装上の制約を定義する。

## 1. 初回実装の範囲

初回実装は製品要求書v15 Draftの全機能を対象とする。最小版へ分割せず、次の領域を同じ実装対象として扱う。

- CoreとMCP Service
- Claude Code / Codex対応
- Asset、紐づけ、Project Commonの管理
- Project登録とUse Case入口の生成
- Use Case、Workflow、Run、Context、Snapshot
- Model、Runtime、実行報告
- Journal、Journal Review、Proposal、Provenance、History、Change Set
- Diagnostics
- CLI、localhost UI、Backup / export

## 2. 技術基盤と構成

### 2.1 実行基盤

- 実装言語・実行環境はTypeScript / Node.js 24とする。
- Coreは単独の永続localhost Serviceとして起動する。
- `aacl serve`で明示起動できる。
- RuntimeまたはCLIからCoreが未起動の場合は自動起動する。
- UI、MCP、CLIはCoreだけを経由してデータを読み書きする。
- UI、MCP、CLIからSQLiteへ直接アクセスしない。
- CoreはAI、shell、filesystem操作、Git操作、外部API呼び出しを実行しない。実際の開発行為とRuntime固有の操作はClaude Code / Codex側が担う。

### 2.2 UI

- UIはlocalhostのWeb UIとする。
- 初回対応ブラウザはJavaScriptが有効なChromium系ブラウザとする。
- UIはAsset、紐づけ、Project Common、Run、Snapshot、Journal、History、Provenance、Diagnosticsを閲覧・編集・確認する。
- Canonical AssetやJournalの変更はUIからCoreへ送る。
- 管理データを直接ファイル編集する運用は提供しない。

### 2.3 MCPと公開範囲

- MCPはlocalhostの永続Core Serviceへ接続する。
- MCP toolは、Asset、Run、Context、Journal等の目的別domain operationとして公開する。
- 汎用の任意action実行toolやSQLite CRUDの直接公開は行わない。
- Request / Responseは型付きschemaで扱う。
- domain schemaの検証対象はSkill、Journal、Workflow、Stageとする。その他の情報はCoreが保存・関連づけに必要な共通構造を持つ。
- APIの具体的なtool名とpayload schemaは別途定義する。
- Serviceはloopbackアドレスだけにbindする。
- 初回実装ではユーザー認証を設けず、外部LANから接続できない構成とする。

## 3. Projectと保存

### 3.1 Projectの認識

- ProjectはCoreが管理するProject registryへ登録する。
- `aacl init`を実行した現在ディレクトリをProject rootとして登録する。
- Project rootは現在位置との完全一致で解決する。
- 親ディレクトリの探索やGit rootからの推測は行わない。
- Project Markerは配置しない。
- CoreはProject IDとProject root pathを関連づけて保持する。

### 3.2 SQLiteの正本

- Global Asset、Project Asset、紐づけ、Project Common、Run、Snapshot、Journal、History、Provenance、Change Set、Diagnosticsは、ユーザー領域の単一SQLiteで管理する。
- Project Assetは`project_id`等のProject scopeによって適用範囲を管理する。
- Project内にAACLデータ用の`.aacl`フォルダを作らない。
- Global AssetとProject AssetはAsset IDで別のAssetとして識別する。
- Projectに適用するAssetは、紐づけまたはProject Commonで明示的に指定する。

### 3.3 人間向けexport

- Markdown / JSONは正本ではなく、Coreが生成する確認・diff・Backup用の出力とする。
- exportは常時生成せず、UIまたはCLIからユーザーが明示的に要求した時に生成する。
- 出力先はユーザーが指定する。
- Asset本文とJournalはMarkdownとYAML front matterを基本形式とする。
- Run、Snapshot、History、Provenance等の機械的な記録はJSONを基本形式とする。
- 自動的な`.backup`生成は必須にしない。
- BackupはUIまたはCLIから明示的に実行し、保存先をユーザーが指定する。

## 4. Assetとrevision

### 4.1 Asset種別

Canonical AssetはWorkflow、Skill、Role、Ruleの4種とする。

- Asset IDはCoreが生成するUUIDとする。
- Assetごとに単調増加する整数revisionを持つ。
- 名前変更ではAsset IDを変更しない。
- Global AssetとProject Assetで名前が同じでも、Asset IDが異なる別Assetとして扱う。

### 4.2 revisionの役割

- revisionは履歴、Run、Snapshot、過去状態の再現に使う。
- 通常のWriteでは、古いrevisionを理由に更新を拒否しない。
- 更新は現在状態から新しいrevisionを作る。
- 過去revisionの復元は、過去内容を現在の新しいrevisionとして保存する。
- 同じWrite操作の再送はoperation IDで冪等に扱う。
- Run開始時にはUse Case、Asset、紐づけ、Project Commonの解決基準を固定する。
- Run中にAssetが更新されても、進行中Runは開始時のrevision基準を使う。

### 4.3 schemaの対象

- schemaによる内容検証を行う対象はSkill、Journal、Workflow、Stageとする。
- Skill、Workflow、Stageは、Context ResolutionとRun進行に必要な構造を検証する。
- Journalはテンプレートの構造を検証し、解析できない内容を自由記述欄へ保持する。
- Role、Rule、Model、Project、紐づけ等は、保存・参照・関連づけに必要な共通構造を持つ。
- Asset本文、completion_condition、コメント、根拠説明等の意味はCoreが解釈しない。

## 5. Runtime入口

- Global Use Caseの入口はGlobalのClaude Code用Command領域、Codex用Skill領域へ配置する。
- Project Use Caseの入口はProject内の`.claude/commands/`と`.codex/skills/`へ配置する。
- 入口はCoreが生成・更新・解除するRuntime固有の生成物とする。
- 入口には対象Use Caseを安定したAsset IDで特定する情報だけを持たせる。
- Workflow定義、Skill本文、Role、Rule、紐づけ、完了条件、Context解決ロジックを入口へ複製しない。
- `useCase=true`への切り替えで対象Skillの入口を配置する。
- `useCase=false`への切り替えで入口を解除する。
- 名前変更やscope変更では古い生成物を整理する。
- 入口を解除してもCanonical Assetは削除しない。
- 生成・更新・解除に失敗した場合は、Canonical Stateを壊さずDiagnosticsへ記録する。

## 6. WorkflowとRun

### 6.1 Workflow Stage

- WorkflowはStageを持ち、Stageを実行単位とする。
- Stageは実行に必要な定義情報と、Stage固有の`completion_condition`を持つ。
- `completion_condition`は必須入力とする。
- 完了条件はAIへContextとして提供する自由記述であり、Coreは条件の意味を解釈しない。
- CoreはStage、transition、Runの構造と状態を管理する。

### 6.2 transition

- Coreは現在Stageから利用可能なtransitionを管理・提示する。
- AIまたはユーザーが、完了条件を満たしたと判断した後にtransitionを選ぶ。
- AIはtransition ID、完了報告、根拠、任意コメントを送る。
- Coreはtransition ID、現在Stage、Run状態、必須項目、参照ID等の構造だけを検証する。
- Coreは完了条件を満たしたか、コメントが正しいか、根拠が事実を証明するかを判定しない。
- transitionの受理時には、報告とAIによる判断をRunイベントへ保存する。

### 6.3 Runの並列実行

- 複数Runを同時にactiveにできる。
- RunごとにRun状態、Context、Snapshot、Journal関連、イベント履歴を分離する。
- 同じProjectの複数Runを並列処理できる。
- 通常は同じProject作業領域で実行する。
- worktreeや別workspaceが必要な場合は、ユーザーまたはRuntimeが明示的に指定する。
- Coreはworkspaceを自動作成・削除せず、指定されたworkspace情報をRunへ記録する。
- 実ファイルや成果物の競合管理はRuntime、Git、ユーザーの責務とする。

### 6.4 同一Runのtransition競合

- SQLite transactionで同一Runの状態変更を直列化する。
- 最初に成立したtransitionを採用する。
- 同じtransitionの再送は`duplicate`として冪等に扱う。
- 状態が進んだ後に届いた別transitionは`stale`として状態を変更せず記録する。
- Coreはtransition結果として`accepted`、`duplicate`、`stale`、`invalid`等を返す。
- Runイベントはappend-onlyで保存し、現在状態は参照用の現在値として保持する。

## 7. Run ContextとContext Resolution

- `run.start`でCoreがRun IDとRun Context Handleを発行する。
- Runtimeが以後のMCP操作へRun Contextを自動付与する。
- AIはRun ID、Snapshot ID、Asset revisionを各操作へ手入力しない。
- CoreはContext Handleから対象Runを特定する。
- Context ResolutionはUse Case、現在Stage、Role、Project scopeの紐づけ、Project Common、固定revision基準から明示参照を辿る。
- Skill参照は再帰的に辿る。
- 同じAsset IDは重複排除する。
- Skill参照の循環を検出した場合はRun開始またはContext解決を失敗させ、Diagnosticsへ記録する。
- 必須Asset、紐づけ、Project Common、Use Case revisionが解決できない場合はRunを開始しない。
- 任意のsupporting file等が取得できない場合は、理由付きの未取得情報としてContextへ返す。

## 8. Journal

- Journalは管理対象Runで得た開発方法・道具の一次観測として扱う。
- Journal Skillが記載テンプレートをAIへ渡す。
- AIはテンプレートに沿って内容を記述する。
- Coreはテンプレートの項目と形式を構造化する。
- Coreは内容を意味解釈しない。
- 解釈・解析できない内容は削除せず、すべて自由記述欄へ保存する。
- 入力原文も保持する。
- Journal Reviewは構造化項目と自由記述欄の両方を対象にする。
- Journal作成時のRun、Use Case、Stage、Role、Snapshot、Asset revision等の関連はCoreが自動で付与する。
- AIにRun ID、Snapshot ID、Asset revisionの入力を要求しない。
- Run終了後のJournal追加は、明示的なPost-run Journal操作として扱う。

## 9. Project初期導入

- `aacl init`でProjectをCoreへ登録する。
- 初期導入時にGlobalの紐づけをProject scopeへコピーし、以後はProjectごとに独立して管理する。
- Project Commonは空の状態から開始する。
- GlobalのAsset本文をProjectへ自動コピーしない。
- Projectで使うAssetは、Projectの紐づけまたはProject Commonから明示的に指定する。
- Projectで利用可能なWorkflowと`useCase=true`のSkillについて、Project scopeのRuntime入口を生成する。

## 10. Coreが保持する情報とRuntime報告

- Model metadataはCoreが保持する。
- 指定ModelとRuntimeが報告した実Modelを分けて記録する。
- Runtime identifier、実際に使ったModel、使用したTool、成果物、実行報告はRuntimeから受け取り、RunとSnapshotへ関連づける。
- Credential、access token、password、secret keyはCoreのAsset・Journal・Snapshotへ保存しない。

## 11. 未確定事項

次の事項は、本書では未確定として扱う。

- CapabilityのRuntime / AI側での表現と、Use Case実行時の扱い。
- Skill、Journal、Workflow、Stageの具体的な保存schema、必須field、schema version、拡張fieldの扱い。
- Run Context HandleをMCP session、Runtime内部metadata、Run専用namespaceのどれで実装するか。
- MCPの具体的なtool名、Request / Response schema、Bootstrapの詳細文面。
- GlobalとProjectのRuntime入口を配置する具体的なOS上のディレクトリ設定。
- UIの画面一覧、編集フォーム、revision表示、diff表示の詳細。
- Journalテンプレートの具体的な見出しと、自由記述欄へ集約する解析規則。
- Backupのファイル形式と、SQLiteからの復元操作。

## 12. 製品要求書との整合待ち

実装方針として次を採用しているため、製品要求書側の表現を後で整合させる必要がある。

- Project Markerを使わず、`aacl init`とCoreのProject registry・正確なpathでProjectを識別する。
- SQLiteを正本とし、人間向けMarkdown / JSONを要求時に生成する。
- CapabilityはCoreの管理対象とせず、Runtime / AI側の実行環境情報として扱う。
- Workflowの実行単位をStageとし、独立したTaskエンティティを設けない。
