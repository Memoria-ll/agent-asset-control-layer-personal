# Agent Asset Control Layer — 用語定義

作成日: 2026-09-16  
状態: Draft

本書は、Agent Asset Control Layerの製品要求書と実装決定書で使用する用語を統一するための定義書である。

## A

### AACL

Agent Asset Control Layerの略称。ユーザーがClaude Code / Codexで使う開発方法、知識、規則、役割をAssetとして管理し、明示的に選択したUse Caseの実行、Context提供、観測、改善を管理するlocal-firstの個人向けMCP Service。

### Asset

AACLが管理する再利用可能なCanonical Asset。Workflow、Skill、Role、Ruleの4種がある。

### Asset ID

Assetを名前から独立して識別するCore生成のUUID。名前変更後も同じAssetを識別する。

### Asset scope

Assetの適用範囲。Global scopeまたは特定ProjectのProject scopeを表す。

## B

### Bootstrap

MCP接続時にAIへ渡すAACLの利用案内。AACLの責務、通常利用との境界、Project確認、Use Case開始、Asset管理、Run、Context、Journalの操作方法を案内する。

## C

### Canonical Asset

AACLが正本として管理するWorkflow、Skill、Role、Rule。Runtime固有のCommandやSkillはCanonical Assetではなく、Canonical Assetを起動するための生成物である。

### Capability

Use Caseの実行に必要な外部能力を表す情報。filesystem、shell、GitHub、browser、external API等が該当する。能力の提供・利用可能性の判断はRuntime / AI側が担い、Coreの管理対象には含めない。

### Context

RunでAIへ渡す実行情報。Use Case Definition、現在Stage、Role、Rule、Skill catalog、Model、成果物要件、completion condition等を含む。

### Context Handle

Runに対応する実行コンテキストをRuntimeが保持する識別情報。MCP操作を正しいRunへ関連づけるために使う。具体的なMCP sessionとの結合方法は未確定である。

### Context Resolution

Use Case、Stage、Role、Projectの紐づけ、Project Common、revision boundaryから、Runで利用対象となるAssetとContextを決定する処理。名前や本文の意味からAssetを選ばず、明示参照だけを辿る。

## D

### Diagnostics

明示状態と実行記録から機械的に検出した問題。参照先欠落、revision取得不能、状態不整合、繰り返すretry、Context量等を対象とする。

## E

### Evidence

AIが完了判断や実行報告に添える根拠。Artifact、Snapshot、Report、外部参照等の構造化参照と、補足の自由記述を保持できる。Coreは形式と参照関係を検証し、根拠の意味や真偽は判定しない。

### Execution Snapshot

Runの実行試行時に提供したContextと、その構成を保持する不変記録。Use Case revision、resolution revision boundary、Project、Role、Model、利用対象Asset、提供情報、参照経路、未取得情報等を含む。

## G

### Global Asset

特定Projectに限定されず、ユーザーのCore領域で管理されるAsset。Projectで使う場合は紐づけまたはProject Commonによって明示的に参照する。

## H

### History

現在状態に至るまでに何が変わったかを表す変更履歴。変更理由や出所を表すProvenanceとは分けて管理する。

## J

### Journal

管理対象Runで得た、開発方法や道具の使い方に関する一次観測。実際に使ったTool、Skill、Rule、良かった点、困った点、改善の種、根拠、確かさ等を記録する。

### Journal Review

ユーザーが明示的に開始するレビュー。新しいJournalと保留中の気づきを横断し、繰り返す摩擦、価値あるパターン、Assetや紐づけの改善候補をまとめる。

## M

### MCP Interface

Claude Code / CodexとAACL Coreを接続する主要なIntegration Interface。Bootstrap、Asset、Project、Run、Context、Journal、History、Provenance等のdomain operationを提供する。

### Model

Roleや実行に関連づけるモデル情報。Coreは指定Model metadataと、Runtimeから報告された実Modelを分けて保持する。実際のモデル起動はRuntimeが担う。

## O

### operation ID

同じWrite操作の再送を同一操作として識別するID。revision更新を重複させないために使う。

## P

### Project

Asset、紐づけ、Project Common、Run、Snapshot、Journal、改善の適用範囲を表す単位。CoreのProject registryにstable project IDとProject root pathを登録する。

### Project Asset

特定Projectのscopeで管理されるAsset。`project_id`等によって適用Projectを限定する。

### Project Common

Projectで共通して使うRuleの明示参照一覧。Rule本文は独立したCanonical Assetとして保持する。

### Project root

`aacl init`で登録したProjectのルートディレクトリ。Project解決は現在位置との完全一致で行い、親ディレクトリからの自動探索は行わない。

### Provenance

なぜ変更されたか、どこから来たかを表す由来情報。User request、reason、source Run / Journal / Snapshot、提案、判断、Change Set等を記録する。

## R

### Role

実行主体が何者として振る舞い、何を担うかを定義するCanonical Asset。責務、判断観点、成果責任を保持し、Skill、Rule、Modelと紐づく。

### Run

一回のUse Case実行を識別するCanonical Entity。Use Case revision、Project、紐づけ、Project Common、Context解決基準、状態、Stage、Snapshot、Journal、実行報告を関連づける。

### Run Context Handle

RuntimeがRun単位のMCP操作へ自動付与するContext識別情報。並列RunのContext、Journal、報告を分離するために使う。

### Runtime

Claude Code / Codexの実行環境。モデル起動、filesystem、shell、Git、Tool、subagent、permission、session、実際のAI開発行為を担う。

## S

### Skill

再利用する手順、専門知識、範囲の定まった作業を表すCanonical Asset。本文、supporting files、Task Type、expected output、completion condition、useCase等を保持する。

### Snapshot

Run中に提供したContext、Asset、revision、参照経路、実行情報を後から確認できる不変記録。Execution Snapshotを指す。

### schema

Coreが受け付けるデータの構造と、保存時に確認する項目の定義。本実装ではSkill、Journal、Workflow、Stageをschema検証の対象とする。本文、completion_condition、コメント、根拠説明等の意味はschemaで判定しない。

### Stage

Workflow内の工程であり、Workflowの実行単位。実行に必要な定義情報、Stage固有の`completion_condition`、利用可能なtransitionを持ち、Runの現在位置として管理される。

## T

### Task

WorkflowのStageを指す作業上の呼称。保存・schema・Run管理ではStageとして扱い、独立したTaskエンティティは設けない。

### Task Type

作業の性質を表す分類情報。Workflow、Stage、Role、Skill、Rule等へ付与でき、Runの観測・比較軸として記録する。

### transition

Workflowの現在Stageから別のStageまたは終端状態へ進む定義。Coreが許可されたtransitionを管理し、AIまたはユーザーが選択する。

## U

### Use Case

ユーザーが明示的に選択してRunを開始する入口。Workflowまたは`useCase=true`のSkillを指す。

### useCase

Skillが直接起動可能なUse Caseであることを示す設定値。trueへの切り替えでRuntime入口を生成し、falseへの切り替えで入口を解除する。

## W

### Workflow

複数のStageとtransitionからなる再利用可能な開発方法を定義するCanonical Asset。各Stageに必須の`completion_condition`を持つ。

### Workspace

Runが実際の作業で使うディレクトリまたはGit worktree。通常はProjectの作業領域を使い、分離が必要な場合だけユーザーまたはRuntimeが明示する。Coreはworkspaceの情報を記録するが、作成・削除は行わない。

## その他

### Change Set

一つの意思決定で行う複数のAsset、紐づけ、Project Commonの変更をまとめた単位。操作、理由、User request、Proposal reference、承認情報、History referenceを保持する。

### Core

AACLの状態管理・検証・解決・保存を担う中心Service。SQLite、Project registry、Asset、Run、Context、Snapshot、Journal、History、Provenance、Diagnosticsを管理する。AIや外部Toolを実行しない。

### completion_condition

Workflow Stageが完了したとAIが判断するための条件記述。Stageごとの必須自由記述として保存し、CoreがAIへContextとして渡す。Coreは内容の意味を判定しない。

### revision

Asset、紐づけ、Project Common等の状態を識別する単調増加整数。履歴とRun / Snapshotの再現に使う。通常Writeの競合拒否を目的としない。

### revision boundary

Run開始時に固定する、Use Case、Asset、紐づけ、Project Commonの解決基準。Run中のContext解決は同じ基準を使う。

### 紐づけ

Workflow / StageとRole / Skill / Rule、RoleとModel / Skill / Rule、SkillとSkill等の明示的な参照関係。Coreは本文の意味から参照を追加・削除しない。
