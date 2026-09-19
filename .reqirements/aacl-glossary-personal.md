# Agent Asset Control Layer — 用語定義

更新日: 2026-09-18
状態: Draft

本書は、Agent Asset Control Layerの開発要求書と実装設計書で使用する用語を統一するための定義書である。

## A

### AACL

Agent Asset Control Layerの略称。ユーザーがClaude Code / Codexで使う開発方法、知識、規則、役割、Model設定をAssetとして管理し、Workflow Runと直接起動Skillの本文提供、Journal、改善を支援する個人向けシステム。

### Asset

AACLが管理する再利用可能なCanonical Asset。Workflow、Skill、Role、Rule、Modelの5種がある。内容を実質的に取り下げる場合もAsset IDと紐づけを残し、本文に`処置なし`等の空内容を示す記述を保存する。

### Asset ID

Assetを名前から独立して識別するCore生成のUUID。名前変更後も同じAssetを識別する。

### Asset scope

Assetの適用範囲。Global scopeまたは特定ProjectのProject scopeを表す。

## B

### Bootstrap

MCP接続時にAIへ渡すAACLの利用案内。AACLの責務、通常利用との境界、Project確認、Workflow Run開始、直接起動Skill取得、Asset管理、Context、Journalの操作方法を案内する。

## C

### Canonical Asset

AACLが正本として管理するWorkflow、Skill、Role、Rule、Model。Runtime固有のCommandやSkillはCanonical Assetではなく、Canonical Assetを起動するための生成物である。

### Capability

filesystem、shell、GitHub、browser、external API等、Runtimeが提供する実行能力。提供・利用可能性の判断はRuntime / AI側が担い、Coreの処理・保存対象には含めない。

### Context

Workflow RunでAIへ渡す実行情報。Workflow Definition、現在Stage、担当Role IDと責務、Stageの追加指示、現在Stageからの遷移と各condition、明示参照されたRuleとSkill、指定Modelの固定情報、サブエージェント継続指示等を含む。直接起動Skillの取得は指定Assetの本文を返す。

### Context Handle

CoreがRunごとに発行し、`run.start`の応答で返す識別子。以後のRun単位MCP操作に入力として含め、Coreが対象Runを特定する。一つのHandleは一つのRunに対応し、並行するAI実行コンテキストはそれぞれのRunのHandleを使う。

### Context Resolution

Workflow、Stage、Role、Projectの紐づけ、Project Common、revision boundaryから、Workflow Runで利用対象となるAssetとContextを決定する処理。名前や本文の意味からAssetを選ばず、明示参照だけを辿る。

## D

### Diagnostics

明示状態と実行記録から機械的に検出した問題。参照先欠落、revision取得不能、状態不整合、繰り返すretry、Context量等を対象とする。

## E

### Evidence

AIが完了判断や実行報告に添える根拠。Artifact、Snapshot、Report、外部参照等の構造化参照と、補足の自由記述を保持できる。Coreは形式と参照関係を検証し、根拠の意味や真偽は判定しない。

### Execution Snapshot

Workflow Runの実行試行時に提供したContextと、その構成を保持する不変記録。Workflow revision、resolution revision boundary、Project、Role、利用対象Asset、提供情報、参照経路、未取得情報、指定Model、サブエージェント継続情報等を含む。

## G

### Global Asset

特定Projectに限定されず、ユーザーのCore領域で管理されるAsset。Projectで使う場合は紐づけまたはProject Commonによって明示的に参照する。

## H

### History

現在状態に至るまでに何が変わったかを表す変更履歴。変更理由や出所を表すProvenanceとは分けて管理する。

## J

### Journal

開発方法や道具の使い方に関する一次観測。本文とTaskまたはRunへの関連づけを持つ。実際に使ったTool、Skill、Rule、良かった点、困った点、改善の種、根拠、確かさ等を記録する。Model情報はCoreの構造化fieldにしない。

### Journal template

AIがJournalを記述するための固定見出しMarkdown。Task、実際に使ったもの、良かった点、困った点、改善の種、根拠・確かさ等を含む。Coreは既知見出しから構造化し、重複見出しは出現順に連結する。未知見出しや構造化できない内容と入力原文は保持する。

### Journal Review

ユーザーが明示的に開始するSkillによるレビュー。Review自体のRunや実行履歴は作らず、新しいJournalと保留中の気づきを横断して改善候補をまとめる。Proposalと気づきの状態は個別のMCP操作で保存し、`pending`、`processed`、`rejected`で管理する。

## M

### MCP Interface

Claude Code / CodexとAACL Coreを接続する主要なIntegration Interface。Bootstrap、Asset、Project、Workflow Run、直接起動Skill本文取得、Context、Journal、History、Provenance等のdomain operationを提供する。

### Model

Workflow Stageから参照するCanonical Asset。`name`、`description`、`modelName`、`invocationMethod`を持ち、SkillまたはRuleを参照できる。外部Modelの存在、利用可能性、provider、指定値と実使用値の一致、実際の起動はRuntime / AI側の責務とする。

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

`aacl init`で登録したProjectのルートディレクトリ。Windows形式またはLinux形式の入力をLinux形式へ変換し、通常のpath表記を整えてからRuntimeが示す開いているProject rootと完全一致で照合する。別表記のaliasは作らず、親ディレクトリからの自動探索やsymlinkの解決は行わない。

### Provenance

なぜ変更されたか、どこから来たかを表す由来情報。User request、reason、source Run / Journal / Snapshot、提案、判断、Change Set等を記録する。

## R

### Role

実行主体が何者として振る舞い、何を担うかを定義するCanonical Asset。責務、判断観点、成果責任を保持し、SkillとRuleを参照できる。Modelの選択はWorkflow StageのModel参照で定義する。

### Run

一回のWorkflow実行を識別するCanonical Entity。Workflow revision、Project、紐づけ、Project Common、Context解決基準、状態、Stage、Snapshot、Journal、実行報告を関連づける。直接起動するSkillにはRunを作成しない。

### Run Context Handle

Run単位のMCP操作で対象Runを識別するContext Handle。`run.start`の応答で受け取り、同じAI実行コンテキストの後続操作へ渡す。並行RunのContext、Journal、報告はHandleに対応するRunごとに分離する。

### Runtime

Claude Code / Codexの実行環境。モデル起動、filesystem、shell、Git、Tool、subagent、permission、session、実際のAI開発行為を担う。

## S

### Skill

再利用する手順、専門知識、範囲の定まった作業を表すCanonical Asset。必須情報はname、description、body。`useCase`設定で直接起動対象にするかを切り替える。

### Snapshot

Run中に提供したContext、Asset、revision、参照経路、実行情報を後から確認できる不変記録。Execution Snapshotを指す。

### schema

Coreが受け付けるデータの構造と、保存時に確認する項目の定義。本実装ではModelを含むAsset、Journal、Workflow、Stageをschema検証の対象とする。本文、遷移condition、コメント、根拠説明等の意味はschemaで判定しない。

### Stage

Workflow内の工程であり、Workflowの実行単位。Runの現在位置として管理される。各Stageには担当Roleを1件割り当て、そのRoleの責務を基本とする。任意でModelを1件割り当てると、そのModelをサブエージェントとして実行する。連続するStageで担当RoleとModelが同じ場合は同じサブエージェントへ依頼する。`additionalInstructions`は必要に応じて加える自由記述である。WorkflowがStage一覧と、各Stageからの許可transitionおよび遷移conditionを定義する。

## T

### Task

Workflow上のTaskはStageに対応し、独立したTaskエンティティは設けない。JournalテンプレートのTask欄は自由記述の作業名とし、独立Task recordではない。

### Skillのdescriptionとexplanation

Skillの`description`はRuntime入口のYAML front matterへ渡す短い説明であり、`explanation`はUIで人がSkillを呼び出すか判断するための説明である。Workflow、Stage、Role、Rule、Modelには作業分類を保存しない。

### transition

Workflowの現在Stageから別のStageまたは終端状態へ進む定義。`from`、`to`、行き先を選ぶための必須`condition`、表示用の`label`を持つ。Coreが許可されたtransitionを管理し、conditionの意味判断と選択はAIまたはユーザーが行う。

## U

### Use Case

ユーザーが明示的に選択する起動対象。WorkflowはRunを開始し、`useCase=true`のSkillはRunを伴わずCanonical本文を直接取得する。

### useCase

Skillが直接起動可能なUse Caseであることを示す設定値。trueへの切り替えでRuntime入口を生成し、falseへの切り替えで入口を解除する。

## W

### Workflow

複数のStageとtransitionからなる再利用可能な開発方法を定義するCanonical Asset。各Stageは担当Roleを1件、任意のModelを1件持ち、各transitionは行き先へ進む必須の`condition`を持つ。`additionalInstructions`でそのStageの作業を補足できる。

### Workspace

Runが実際の作業で使うディレクトリまたはGit worktree。選択・作成・分離はユーザーまたはRuntimeが行い、CoreはWorkspaceを管理・記録しない。

## その他

### Change Set

一つの意思決定で行う複数のAsset、紐づけ、Project Commonの変更をまとめた単位。操作、理由、User request、Proposal reference、承認情報、History referenceを保持する。

### Core

AACLの状態管理・検証・解決・保存を担う中心Service。アプリケーションとデータを同じAACL管理フォルダーに置き、その中のSQLite、Project registry、Asset、Run、Context、Snapshot、Journal、History、Provenance、Diagnosticsを管理する。AIや外部Toolを実行しない。

### transition.condition

Workflowの現在Stageからその遷移先へ進むとAIまたはユーザーが判断するための条件記述。各transitionの必須自由記述として保存し、現在Stageの許可遷移とともにContextへ渡す。Coreは内容の意味を判定しない。

### additionalInstructions

Workflow Stageの担当Roleと責務を基本としたうえで、必要に応じて加える任意の自由記述。遷移conditionとは別fieldとして保存し、StageのContextに含める。

### revision

Asset、紐づけ、Project Common等の状態を識別する単調増加整数。履歴とRun / Snapshotの再現に使う。通常Writeの競合拒否を目的としない。

### revision boundary

Run開始時に固定する、Workflow、Asset、紐づけ、Project Commonの解決基準。Run中のContext解決は同じ基準を使う。

### 紐づけ

Workflow / StageとRole / Skill / Rule / Model、RoleとSkill / Rule、ModelとSkill / Rule、SkillとSkill等の明示的な参照関係。Coreは本文の意味から参照を追加・削除しない。StageのModel参照はサブエージェント実行と、Role・Modelが連続して一致する場合の同一サブエージェント継続を表す。
