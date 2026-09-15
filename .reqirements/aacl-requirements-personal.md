# Agent Asset Control Layer — 開発要求 v15 Draft

作成日: 2026-09-15
更新日: 2026-09-16

本書は、Agent Asset Control Layer（AACL）の完成形における製品の責務、管理対象、実行境界、観測と改善の仕組みを定義する。

---

# 1. 目的と利用形態

AACLは、ユーザーがClaude Code / Codexとの開発で繰り返し使う方法・知識・規則・役割を資産として一元管理し、明示的に選択したUse Caseから再利用・観測・改善するための、個人向けlocal-first MCP Serviceである。

正式なExecution SurfaceはClaude CodeとCodexとする。ユーザーは両者との会話を通じてAACLを操作する。

```text
User
  ↓ 自然言語による依頼
Claude Code / Codex
  ↓ MCPによる明示操作
AACL Core
```

AACLは次を担う。

- Workflow / Skill / Role / RuleをCanonical Assetとして保存する。
- グローバルとプロジェクト別のAssetおよび紐づけを管理する。
- 短い依頼から、明示されたUse CaseのRunを開始する。
- 明示参照を辿り、今回使う資産とそのrevisionを確定する。
- 実行に必要なContextを段階的に渡し、渡した情報を記録する。
- Runの進行、成果物、実行報告を追跡する。
- Journalを提供Contextに関連づけ、開発方法の改善材料を蓄積する。
- ユーザーが開始したJournal Reviewを通じて、根拠のある改善案を扱う。
- ユーザー判断に基づく変更を保存し、変更内容と変更理由を追跡する。

日常的な管理は、接続中AIがユーザーの自然言語を具体的なAACL操作へ変換して行う。

---

# 2. 基本原則と責務分担

## 2.1 ユーザーの決定権

開発方法、Assetの意図、紐づけ、RoleとModelの組み合わせ、改善方針の最終決定主体はユーザーとする。

依頼から対象・変更内容・適用先が一意に決まる場合、その依頼自体を変更意思として扱う。方針が一意に決まらない場合、AIが具体案を示してユーザーへ判断を戻す。

## 2.2 AIによる操作と意味判断

Claude Code / Codex側のAIは、自然言語の理解、既存情報の調査、資産化、成果物の意味的な品質判断、改善案の作成、具体的なAACL操作への変換を担う。

保存する判断は、Asset、紐づけ、実行報告、提案、意思決定などの明示的な情報へ変換する。

## 2.3 Coreの責務

Coreは、Canonical State、Project Identity、紐づけ、Run State、Workflow State、revision、Snapshot、Journal、History、Provenance、Change Set、Diagnosticsを管理する。

Coreは同じ明示状態に同じ検証・解決規則を適用する。資産の本文を意味解釈して、使う資産を推測・選別する責務は持たない。

## 2.4 Runtimeの責務

Claude Code / Codexは、モデル起動、ファイル操作、shell・tool呼び出し、Git操作、subagentの起動、Runtime固有のpermissionとsession、実際のAI開発行為を担う。

## 2.5 資産の正本とContext

Canonical Assetは人間が内容を確認・diffするための正本とする。

Contextは、Project Commonと、選択したUse Case・現在の工程・Roleの紐づけに含まれる明示参照から構成する。Skill本文やsupporting filesは、AIが使う時点で取得する。

---

# 3. 管理対象の実行と通常利用

AACLが実行の管理・観測・改善を行う対象は、ユーザーがUse Caseを一意かつ明示的に選択し、CoreがRunを作成した実行とする。

```text
Use Caseの明示選択
        ↓
Runの開始
        ↓
Contextの提供と実行
        ↓
Snapshot / Journal
        ↓
改善
```

Use Caseの明示選択には、名前を含む自然言語依頼を含める。履歴や会話内容からAIが黙って選択することは、明示選択として扱わない。

Use Caseを選択していない通常利用で、何を行い、どこまで自律実行するかは、ユーザーと接続先AI本来の関係に委ねる。AACLは通常利用へ独自の許可・禁止規則やWorkflow Stateを適用せず、Use Caseの選択を催促して割り込まない。

通常利用へWorkflow / Skill / Rule等を暗黙適用することを標準動作としない。通常利用に対するRun、Snapshot、Journal、比較用の実行統計を自動作成せず、後から管理対象の実行として記録することもしない。

Assetの検索・編集・資産化など、ユーザーが明示した管理操作はRun外でも扱う。変更・資産化を行った場合は、その依頼と変更理由をProvenanceへ記録する。

---

# 4. Canonical Asset

Canonical Assetは次の4種とする。

- Workflow
- Skill
- Role
- Rule

各Assetは、ID、name、description、revision、管理先、metadata、history、provenanceを持ち、種類ごとの本文・定義を保持する。

管理先はグローバルまたは特定のプロジェクトとする。グローバルのAssetとプロジェクトのAssetで名前が重複していても、別のAssetとして識別する。利用するAssetは紐づけやProject Commonの明示参照によって決まり、参照先をAsset IDで特定する。

Asset本体と、どのAsset・Modelを使うかを示す紐づけを分けて管理する。Asset本体の変更と紐づけの変更は、それぞれrevisionと変更理由を追跡する。

---

# 5. Project Identity

AACL Projectはstable project IDで識別し、明示操作で登録する。

Projectは、プロジェクト資産の管理先、紐づけ、Project Common、Run、Snapshot、Journal、改善の適用先を識別するために用いる。

Project rootに置くProject Markerを通じて、接続中AIが対象Projectを確認する。

## 5.1 Project Common

Project Commonは、そのProjectで共通して使うRuleへの参照一覧を保持するProject設定である。Rule本文はCanonical Assetとして管理し、Project Commonには使うRuleのAsset IDを明示的に登録する。

登録したRuleは、そのProjectで開始するWorkflowとUse Case Skillの両方の管理Runに含める。特定のRoleや工程で使うRuleは、そのRole / Workflow / Stageへの紐づけで指定する。

Project Commonの登録・解除には、revision、変更履歴、変更理由を保持する。

---

# 6. グローバルとプロジェクト別の紐づけ

AACLはグローバルの紐づけと、各プロジェクトの紐づけを別々に保存する。

紐づけは、使う対象を明示する定義であり、次の関係を扱う。

- Workflow / Stage → Role / Skill / Rule
- Role → Model / Skill / Rule
- Skill → Skill

Workflowのentry roleとStageごとの担当Roleも紐づけで指定する。RoleとModelは、使用する紐づけの中で1対1とする。

ProjectのRunでは、そのProjectに保存された紐づけを使う。グローバルとプロジェクトで同名のAssetが存在する場合も、紐づけに記録されたAssetを参照する。

RoleからSkill / Ruleを参照することは、それを使う明示指定である。AACLは、参照先の本文や管理先を理由にその指定を再選別しない。

Skillから別のSkillへの参照も辿る。

```text
Role
 ├─ Rule
 └─ Skill A
      └─ Skill B

利用対象のSkill：A、B
```

紐づけの作成・変更・削除は、AIがユーザーの依頼を具体化して明示操作で行う。紐づけにもrevision、history、provenanceを保持する。

---

# 7. プロジェクト初期導入

プロジェクトの初期導入時に、グローバルの紐づけをプロジェクト用の紐づけとしてコピーする。対象は、グローバルに定義された各種類の紐づけとする。

コピーするのは紐づけであり、参照先のAsset本体は共有する。コピー元とそのrevisionを由来として記録する。

Project Commonは空の一覧として作成する。そのProjectで共通して使うRuleは、Projectごとに既存のRuleから明示的に登録する。

初期導入では、対象Projectで利用できるWorkflowと`useCase=true`のSkillについて、Claude Code向けには起動用Commandを`.claude/commands/`配下に、Codex向けには起動用Skillを`.codex/skills/`配下に配置する。これらはCanonical Assetの複製ではなく、対象Use Caseを特定してAACLへ処理を渡すためのRuntime固有の入口とする。

```text
グローバルの紐づけ
        ↓ 初期導入時にコピー
プロジェクトの紐づけ
        ↓ プロジェクトごとに編集
そのプロジェクトで使う構成
```

コピー後の紐づけはそれぞれ独立して編集する。グローバルの紐づけを変更しても、導入済みプロジェクトの紐づけは自動変更しない。

共有しているグローバルAssetの本文を更新した場合、そのAssetを参照するプロジェクトでも、次のRunから更新後の内容を使う。進行中のRunは開始時のrevisionを使い続ける。

プロジェクト固有の本文が必要になった場合は、プロジェクトのAssetを作成し、そのプロジェクトの紐づけまたはProject Commonの参照先を変更する。同名のAssetを作成したことだけで、既存の参照先が切り替わることはない。

---

# 8. Use Case

Use Caseは、ユーザーが明示的に選択してRunを開始する入口とする。

次をUse Caseとして扱う。

- Workflow
- `useCase=true`のSkill

Use Caseの検索・選択では、この2種類を統一的に扱う。

Claude Code / CodexからのUse Case起動では、Claude Codeの`.claude/commands/`配下に配置した起動用Command、またはCodexの`.codex/skills/`配下に配置した起動用Skillを入口として利用できる。この起動用表現から対象WorkflowまたはUse Case Skillを指定してAACLへ処理を渡すことも、Use Caseの明示選択として扱う。

Workflowを選択したRunでは工程に沿って進行する。Use Case Skillを選択したRunでは、そのSkillの実行、結果・根拠の報告、完了という単位で扱う。

---

# 9. Workflow

Workflowは、複数工程からなる再利用可能な開発方法を定義する。

Workflowは次を保持する。

- ID、name、description、revision
- stages
- task type / classification
- transitions
- retry / reject / return
- 実行に必要なCapability
- 成果物の要件
- completion criteria

Workflow / Stageで使うRole・Skill・Ruleは紐づけで指定し、対象Projectの構成から取得する。

Workflowは可能な進行と完了に至る経路を定義する。今回どのtransitionを選択するかは、ユーザーまたは接続中AIが判断する。

---

# 10. Skill

Skillは、再利用する手順、専門知識、範囲の定まった作業を表す。

Skillは次を保持する。

- ID、name、description、revision
- body
- supporting files
- task type / classification
- expected output
- completion criteria
- useCase

別のSkillを使う関係は、Skill → Skillの紐づけで定義する。AACLはこの参照を辿り、参照先のSkillも利用対象へ含める。

本文とsupporting filesは、AIが必要時に取得する。利用対象になったことと、本文を取得したこと、実際に使ったことを区別する。

`useCase=true`のSkillは直接起動するUse Caseとして扱い、成果物と完了条件に基づいてRunを進める。

---

# 11. RoleとModel

Roleは、実行主体が何者として振る舞い、何を担うかを定義する。共通の責務として複数のWorkflow / Stageから再利用する。

RoleはID、name、description、revision、responsibilities、task type / classificationを保持する。responsibilitiesは、期待する責務・判断観点・成果責任を表す。

Roleで使うSkill / Rule / Modelは、使用するグローバルまたはプロジェクト別の紐づけから取得する。Skill / Ruleの本文は独立したCanonical Assetとして管理し、Roleから参照する。

Coreは次をRole Contextとして構成する。

- Roleのresponsibilities
- Roleから参照するSkill / Rule
- Workflow / Stageで使うと明示されたSkill / Rule
- Project Commonに登録されたRule
- 紐づけられたModel

Model metadataには、identifier、display name、provider、notes、provenanceを記録する。実際のモデル起動はClaude Code / Codexが担う。

指定モデルを使えないと判明した場合、接続中AIは事実を提示し、ユーザーへ判断を戻す。実モデルの情報を取得できない状態とは区別する。

指定したModelと、実行時に報告されたModelを区別して記録する。

---

# 12. Ruleと作業分類

Ruleは、対象実行で守る判断・行動指針を表す。ID、name、description、revision、bodyを保持する。

Roleのresponsibilitiesが責務・成果責任を定義するのに対し、Ruleは具体的な行動上の制約や判断基準を記述する。

使うRuleはRole / Workflow / Stageへの紐づけ、またはProject Commonへの登録で明示する。

Task Typeは作業の性質を表す分類情報とし、Workflow / Role / Skill等へ付与する。Runのmetadataとして記録し、実行の説明や観測・比較の軸として利用する。

作業方法はWorkflow、実行責務はRole、具体的な手順や知識はSkill、制約はRuleとして表現する。

---

# 13. Capability

Capabilityは、Use Caseの実行に必要な外部能力を表すExecution Context情報とする。GitHub、browser、filesystem、shell、external API等が該当する。

Capabilityを提供する主体はClaude Code / Codexの実行環境とし、AACLはその利用可能状態を扱う。

状態はavailable / unavailable / degraded / conflictとして示し、Run開始、transition、completion validationで、定義された条件に従って参照する。

---

# 14. 自然言語によるAsset管理

Asset・紐づけ・Project Commonの管理操作は、Claude Code / CodexからMCP経由で行う。

AIは次の流れで操作する。

1. ユーザーの依頼を理解する。
2. 対象のAsset・紐づけ・Project Common・関連資料を検索して読む。
3. 対象、変更内容、グローバル／プロジェクトの適用先を具体化する。
4. 一意に決まらない方針をユーザーへ確認する。
5. Coreへ明示操作を送り、検証と保存を行う。
6. 依頼、変更理由、判断、変更履歴を関連づける。

ユーザーは「このRuleの確認項目Aを削除して」のように、内容への変更として依頼する。変更箇所や過去の変更IDの調査はAIが担う。

管理操作には、Assetの検索・取得・作成・更新、紐づけの検索・取得・作成・変更・解除、Project Commonの取得・編集、Use Case設定、Model metadataの更新、History・Provenanceの確認を含める。

---

# 15. 既存情報と通常利用からの資産化

AIは、ユーザーが指定した既存の指示ファイル・設定・会話・成果物・要約・進め方を読み、Workflow / Skill / Role / Ruleへ整理する。

使う資産と紐づけ、その管理先を具体化し、ユーザーの依頼と判断に基づいて保存する。

通常利用で見つけた方法も、ユーザーの明示依頼で資産化する。元の通常利用は管理対象のRunやJournalへ遡及変換せず、資産化元の情報としてProvenanceへ関連づける。

通常利用からの資産化と、管理対象の実行を振り返るJournal Reviewを、それぞれの入口として扱う。

---

# 16. Bootstrapと実行の入口

Bootstrapは、MCP接続時にAIへAACLの存在と利用方法を知らせる。案内には次を含める。

- AACLの役割と通常利用との境界
- Projectの確認方法
- Use Caseの検索・開始方法
- Asset・紐づけの検索・編集・資産化方法
- Run StateとContextの取得方法
- JournalとJournal Reviewの操作方法

Bootstrapは繰り返し取得しても同じ案内として扱う。通常会話へ全Workflow・Skill・Ruleの本文を常時注入する用途にはしない。

接続先で使う起動用表現は、Claude CodeではCommand、CodexではSkillとし、Canonical Assetを参照する入口として扱う。これらのRuntime固有の起動用表現と、Canonical AssetとしてのSkillを区別する。

AACLは、対象Projectで利用できる各Workflowと`useCase=true`のSkillについて、Claude Codeでは`.claude/commands/`配下に起動用Commandを、Codexでは`.codex/skills/`配下に起動用Skillを配置する。初期導入時に作成し、Use Caseの追加・削除・名称変更等で入口との対応関係が変わる場合は、Canonical Stateと一致するよう更新する。

起動用表現の責務は、対象Use Caseを安定したAsset IDで特定し、AACLのMCP Interfaceへ処理を渡してUse Caseの取得・Run開始へ進ませることに限定する。Workflowの工程、Skill本文、Role / Rule、紐づけ、completion criteria、Context Resolution等の実行定義や判断ロジックを起動用表現へ複製しない。

起動用表現はRuntime固有の生成物でありCanonical Assetではない。削除・再生成してもCanonical Stateを失わず、表示名や接続先での表現形式が変わっても、参照するAssetの識別を維持する。

---

# 17. Runの開始と記録

Runは、一回のUse Case実行を識別するCanonical Entityとする。

Coreは次を検証し、Run IDと初期状態を作成した時点で管理対象の実行を開始する。

- 明示選択されたUse Caseが存在し、そのrevisionを取得する。
- Definitionがvalidationを通る。
- 対象Project、使用する紐づけ、Project Commonの参照を解決する。
- 実行に必要なCapabilityの状態を判定する。
- Context Resolutionに使うrevisionの基準を確立する。
- Initial Stateを作成する。

接続、validation、revision整合性等によりRunを作成できなかった場合は、開始失敗として扱う。

Runは次を保持する。

- run id
- use case type / id / revision
- project
- 使用する紐づけとそのrevision
- 使用するProject Commonのrevision
- instruction / target
- task type / classification
- resolution revision boundary
- status
- created at / updated at
- Workflowの場合の現在Stage
- 関連するSnapshot、Journal、実行報告、成果物

---

# 18. Runの状態とWorkflowの進行

Runの状態を次のように扱う。

| 状態 | 意味 |
|---|---|
| active | 実行が進行中である |
| completed | 完了要求が受理され、完了条件の構造的検証を通った |
| cancelled | ユーザー意思により中止した |
| failed | 継続不能として終了した |

Workflow Runでは、Coreが現在Stageを保持し、定義に従って可能なtransitionを示す。retry / reject / returnと、Run全体のfailedを区別する。

Orchestratorは、進行管理を担うRoleとして定義する。その責務には、現在状態の理解、assignment、transitionの選択、retry、return、reject、fallback、完了判断を含める。

実際の進行判断と作業の割り当てはユーザーまたは接続中AIが行い、Coreが状態遷移を検証して保存する。

---

# 19. 完了条件と終了

WorkflowとUse Case Skillは、Runをcompletedとして扱うためのcompletion criteriaを定義する。

Coreは、そのUse CaseのDefinitionで指定された完了条件を扱う。条件として、工程の完了、成果物の存在、レビュー結果、Roleの実行報告、Capabilityの結果、根拠の存在、未解決の差し戻し条件の解消を表現する。

成果物の意味的な品質判断はAIが担い、完了要求と根拠をCoreへ送る。

Coreは、状態遷移上の完了可否、定義された成果物・実行報告・根拠の存在、状態の整合性を検証する。

ユーザーは接続中AIを通じてRunのcancelを要求する。Runtime / AIは継続不能なRunをfailedとして終了報告する。

---

# 20. revisionの一貫性

Run開始時にUse Caseのrevisionを固定し、資産・紐づけ・Project Commonの解決に使うstable revision boundaryを確立する。

同じRun内のContext Resolutionは、同じ基準を使う。途中で取得するSkill本文とsupporting filesも、そのRunの基準に従う。

新しいAsset・紐づけ・Project Commonの状態を使う場合は、新しいRunを開始する。

作成済みExecution Snapshotは変更しない。Asset・紐づけ・Project Commonが更新されても、過去のSnapshotから当時の内容とrevisionを確認する。

---

# 21. Context Resolver

Resolverは、Runで選択されたUse Case、現在Stage、Role、Projectの紐づけから明示参照を辿り、利用対象の資産を解決する。Project Commonに登録されたRuleも、その明示参照から解決する。

RoleがSkill Aを参照し、Skill AがSkill Bを参照する場合、AとBを対象に含める。各参照には、そのRunで使う紐づけとrevisionの基準を適用する。

利用対象は明示参照から決定する。名前の重複やグローバル／プロジェクトという管理先を理由に資産を選び直さず、条件が一致しただけの未参照資産を追加しない。

Coreは、参照先の存在、revisionの取得可否、紐づけ・Project Common・Run Stateの整合性を検証する。

Resolutionの入力は、Project、使用する紐づけ、Project Common、Use Case、Workflow Stage、Role、およびRunで固定したrevisionの基準とする。Use Case SkillにはWorkflow Stageを設けない。

---

# 22. Contextの提供と説明

初期Contextには次を含める。

- Use Case Definition
- 紐づけとProject Commonで明示参照されたRule
- 利用対象Skillのcatalog
- 成果物の要件
- completion criteria

Workflowの場合は現在Stageを含める。Roleが指定された実行には、そのRoleとresponsibilities、紐づけられたModelを含める。

Skill本文とsupporting filesは、AIが必要時に取得する。利用対象のSkill集合とrevisionをContextの一部として扱う。

AACLは、資産がどの参照経路から利用対象になったか、何を渡したか、取得できなかった対象と理由を説明する。

今回利用対象になった理由はResolutionの記録で示し、その紐づけやProject Commonへの登録が行われた理由はProvenanceで示す。

---

# 23. Role間のContext引き渡し

Workflowで別のRoleへ作業を委譲する場合、Coreは引き渡すContextを構成する。

Contextには、run id、Use Caseとrevision、Stage、task、Roleとresponsibilities、Task Type、指定Model、使うRule、利用対象Skill、関連成果物、制約、expected output、completion criteriaを含める。

実際の割り当てと実行主体の起動は、接続中AIとRuntimeが担う。

---

# 24. 提供情報と実行報告

AACLが管理対象のRunに渡した情報と、AIから報告された実際の使用状況を、それぞれ記録して関連づける。

Execution Snapshotは、実行試行に提供したContextと、その構成を保持する。

- run id
- Use Caseとrevision
- resolution revision boundary
- Project
- 使用した紐づけとrevision
- 使用したProject CommonのrevisionとRule参照
- Workflowの場合のStage
- Role、Task Type、Runtime
- 指定Model
- 利用対象のAssetとrevision
- 提供したRuleとSkill catalog
- 提供情報、関連成果物、参照経路と解決理由
- 取得できなかったContextと理由
- timestamp

AACLはSkill本文・supporting filesの提供も記録し、Runと対応するContextに関連づける。

Journalに記録する気づきには、実際に何をどう使ったかを補足する。Use Caseの完了条件に基づく実行報告は、そのDefinitionに従う。AACLは、Skillが利用対象になった状態、本文を取得した状態、実際に使ったという報告を区別して保持する。

実Runtime・Modelを把握した場合は、接続中AIが報告する。指定Modelと報告された実Modelを分けて保持し、対象RunとSnapshotへ関連づける。

---

# 25. Journal

Journalは、管理対象のRunで得た、開発方法や道具の使い方に関する一次観測とする。

既存journalの気づき中心の運用を保ち、明確な設計・実装タスクの区切りで、記録する気づきがある場合に残す。定番として確立した良さを毎回繰り返さず、書くことのない項目は省略する。

Journalには現行の情報を保持する。

- date
- project
- branch
- task
- type：design / impl / both
- 実際に使ったtools / skills / rules
- 良かった点
- 困ったこと・詰まったこと
- 改善の種

各気づきには、把握した範囲で次の詳細を加える。

- 関係するAsset・道具と、その場面
- 期待したことと実際の使用状況
- 結果への影響、摩擦、手戻り、不足したContext等
- 根拠となる実行結果・成果物・発言等
- 観測や解釈の確かさ

AACLはJournalを、Run、Use Caseとrevision、Stage、Role、報告されたModel、Snapshot、関連Assetと紐づけのrevisionへ関連づける。AACLが渡した情報はこの関連から辿り、AIが報告した実際の使用状況と併せて読む。

記録の中心は、どう進め、道具や指示がどう働いたかとする。気づきのない実行に成功報告を求めず、Journalへの記載がないことだけを未使用・不要の根拠として扱わない。

---

# 26. Journal Review

Journal Reviewは、ユーザーが明示的に開始するUse Case Skillとする。

新しいJournalと、以前のレビューで保留した気づきの全体を対象とする。AIはJournalを横断してテーマ別に集約し、Snapshot、Runの進行記録、Assetと紐づけの履歴、Provenanceを併せて読む。

集約では次を扱う。

- 繰り返す摩擦・詰まり
- 再現する価値のある良いパターン
- 新しいWorkflow / Skill / Role / Ruleや紐づけの候補
- 既存の資産・紐づけの改善候補
- 資産や提供Contextを減らす・軽くする候補

既存資産が働くべきだった問題は、その資産を改善する案として扱い、重複した資産の追加を避ける。

汎用の改善はグローバル、プロジェクト固有の改善はそのプロジェクトを適用先として提案する。AIはAsset本体、紐づけ、Project Commonのどれを変更するかを示し、共有Assetを参照するプロジェクトへの影響を説明する。

各案に対象・具体的な変更・理由・根拠Journalを付け、レビューで扱ったJournal一覧とともに提示する。

保留した気づきは次回へ持ち越す。一つのJournalに反映済みと保留中の内容が混在する場合も、保留分を次回扱う。合意した変更の反映と、その改善材料の処理済みへの更新を一連の操作として扱う。

---

# 27. 改善提案とユーザー判断

改善提案は次を対象とする。

- Workflowの工程・遷移・完了条件
- Roleの責務とModelの指定
- Skill / Ruleの内容
- 明示参照の追加・変更・削除
- グローバル／プロジェクトの資産と紐づけ
- Project CommonのRule参照
- 資産の整理
- 提供Contextの削減

Proposalには、observed context、proposed change、reason、evidence、affected assets、影響する紐づけとProjectを保持する。

自由度のあるJournal Reviewの提案は、ユーザーが判断した後に反映する。具体的な変更依頼から内容が一意に決まる場合は、その依頼を変更意思として扱う。

---

# 28. Provenanceと変更履歴

Asset・紐づけ・Project Commonの現在状態、変更内容の履歴、変更理由を分けて保持する。

Provenanceでは次を追跡する。

- origin
- user request
- proposed by
- reason
- source run / journal / snapshot
- 資産化元の資料・会話・成果物
- 紐づけのコピー元とrevision
- decision
- related change set

Run外のAsset・紐づけ・Project Commonの変更にも、依頼、理由、判断、Change Setを記録する。

Asset・紐づけ・Project Commonについて、一つの意思決定で行う複数の変更はChange Setとしてまとめる。Change SetはID、origin type、対象、operations、reason、user request、proposal reference、approval information、history referenceを保持する。

Revision Historyは何が変わったか、Provenanceはなぜ変えたかを示す。AIは両者を参照し、ユーザーの内容に関する依頼を具体的な変更へ変換する。

---

# 29. 過去の状態の復元

AACLはAssetの過去revisionの復元と、Change Setに基づく復元を扱う。復元も新しい変更として理由と履歴を残す。

AIはユーザーが戻したい内容を理解し、履歴を調べ、対象と変更内容を具体化する。対象が一意に決まらない場合は、その内容を示してユーザーへ判断を戻す。

現在の内容に対する修正依頼は、通常のAsset・紐づけ・Project Commonの更新として扱う。

---

# 30. Diagnostics

Diagnosticsは、明示状態と実行記録から機械的に確認する問題を検出・計測・提示する。

- 参照先の欠落
- 取得できないrevision
- 紐づけや状態の不整合
- 繰り返すretry・review return
- 提供Contextの量

診断結果には対象と根拠を付ける。意味的な解釈、修正案の作成、適用先の判断はAIが担い、方針の決定はユーザーが行う。

---

# 31. Context Costと改善の比較軸

Context Costは、AACLが実際に渡した情報量とする。Run / Use Case / Stage / Role単位で比較し、提供Contextを増やしすぎていないかを確認する。

利用対象のcatalogに載っていても、取得されていないSkill本文は提供情報量に含めない。

改善判断では、情報量に加えて、Journalに記録された品質上の問題、手戻り、不足Context、Runのretry・review returnを併せて見る。

主要な改善軸はUse Caseとする。WorkflowではStage / Role / Assetへ分解し、Use Case Skillでは一回のRunの単位で観測する。

比較では、Use Case revision、resolution revision boundary、資産・紐づけ・Project Commonのrevision、Runtime、報告されたModel、Project、Stage / Role、Task Typeを参照する。

---

# 32. MCP Interface

MCPをAACLの主要なIntegration Interfaceとする。

MCPを通じて次のdomain operationを提供する。

- Bootstrapの取得
- Projectの確認とProject Commonの取得・編集
- グローバル／プロジェクトの紐づけの検索・取得・編集
- Use Caseの検索・取得
- Runの開始・取得・遷移・完了・cancel・fail
- Contextの解決・取得・Roleへの引き渡し
- Assetの検索・取得・作成・更新
- Skill本文・supporting filesの取得
- Model metadataの取得・更新
- 実Runtime・Model・使用状況・成果物等の報告
- Snapshotと提供情報の確認
- Journalの作成・取得とJournal Reviewの支援
- Proposal、ユーザー判断、改善反映、保留・処理済みの記録
- History・Provenance・Change Setの確認と復元

具体的なtool名は実装で定める。

Read操作でAsset本体・紐づけ・Project Common・Runの進行状態は変更しない。これらの変更は明示的なWrite操作で行う。管理対象のRunへContextやSkillを渡した事実は、取得に伴う提供記録として残す。

更新時には対象のrevisionを用いて競合を検出し、再送によって同じ状態変更が重複しないよう扱う。

---

# 33. 保存、CLI、閲覧UI

AACLはsingle-userのlocalhost運用を基本とし、Canonical Assetと管理情報をローカルに保持する。

Canonical Assetは、人間が本文を確認・diffするための形式で保存する。Runtime固有の表現はCanonical Assetを参照または生成元として扱う。`.claude/commands/`配下の起動用Commandと`.codex/skills/`配下の起動用SkillもRuntime固有の生成物とし、正本として扱わない。

認証情報はClaude Code / Codexや外部Tool Provider側で管理する。Asset本文へcredential、access token、password、secret keyを保存しない。

CLIはCoreの起動、Projectの初期導入、health・接続確認、保守、診断の補助操作を提供する。

GUIは、Asset、グローバル／プロジェクトの紐づけ、Project Common、Run、Snapshot、Journal、Provenance、Diagnostics、Historyを閲覧・確認する用途に使う。

Runtime差は、Runtime identifier、Model identifier、利用可能なCapability、Runtime固有Bootstrapとして扱う。

---

# 34. ユーザーが育てるUse Case

Use Caseの定義はユーザーが所有し、作成・変更する。

Workflowの例として、issue-developmentやrefactoringがある。Use Case Skillの例として、architecture-review、security-review、test-review、journal-reviewがある。

issue-developmentを定義する場合の工程例を示す。

```text
仕様の整理
    ↓
仕様レビュー
    ↓
実装
    ↓
コードレビュー
 ┌──┴──┐
合格   差し戻し
 ↓       ↓
完了    実装へ戻る
```

実際の工程、Role、Model、Skill、Ruleと紐づけは、ユーザーの開発方法に合わせて定義する。

---

# 35. 改善ループ

```text
ユーザー所有のAssetと紐づけ
        ↓
Use Caseの明示選択
        ↓
Runとrevisionの固定
        ↓
明示参照によるContextの提供
        ↓
Claude Code / Codexでの実行
        ↓
提供情報の記録と、気づきのJournal
        ↓
ユーザーが開始する全体のJournal Review
        ↓
AIによる具体的な改善提案
        ↓
ユーザー判断
        ↓
Asset・紐づけの更新と変更理由の記録
        ↓
次のRun
```

このループによって、ユーザー自身がClaude Code / Codexと作ってきた開発方法を蓄積し、実際の利用から改善し続ける。
