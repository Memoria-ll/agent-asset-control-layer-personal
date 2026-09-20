# Agent Asset Control Layer — 開発要求 v16 Draft

作成日: 2026-09-15
更新日: 2026-09-18

本書は、Agent Asset Control Layer（AACL）の完成形における製品の責務、管理対象、実行境界、観測と改善の仕組みを定義する。

---

# 1. 目的と利用形態

AACLは、ユーザーがClaude Code / Codexとの開発で繰り返し使う方法・知識・規則・役割をAssetとして管理し、Workflowの実行と、その実行から得たJournalを通じて開発方法を改善する個人向けシステムである。

正式なExecution SurfaceはClaude CodeとCodexとする。ユーザーは両者との会話を通じてAACLを操作する。

```text
User
  ↓ 自然言語による依頼
Claude Code / Codex
  ↓ MCPによる明示操作
AACL Core
```

AACLは次を製品機能として提供する。

- Workflow / Skill / Role / Rule / ModelをCanonical Assetとして保存する。
- グローバルとプロジェクト別のAssetおよび紐づけを管理する。
- Workflowを明示的に選択してRunを開始する。
- useCaseが有効なSkillを、Run管理を伴わない直接起動可能なAssetとして提供する。
- 明示参照を辿り、今回使う資産とそのrevisionを確定する。
- 実行に必要なContextを段階的に渡し、渡した情報を記録する。
- Workflow Runの状態、Context提供、実行報告を追跡する。
- Journalを提供Contextに関連づけ、開発方法の改善材料を蓄積する。
- ユーザーが開始したJournal Reviewで、Journalを横断した改善案を扱う。
- ユーザー判断に基づく変更を保存し、変更内容と変更理由を追跡する。

初回実装では、本書に定義する管理・Workflow実行・Journal・Review・CLI・UI・export / Backupを一括して対象とする。個々の機能の優先順位による初回対象の縮小は行わない。

ユーザーはUIまたは接続中AIを通じてAssetを管理できる。AI経由の管理では、接続中AIが自然言語の依頼を具体的なAACL操作へ変換する。保存内容の意味判断と開発作業はユーザーおよび接続先AIが担う。

---

# 2. 基本原則と責務分担

## 2.1 ユーザーの決定権

開発方法、Assetの意図、紐づけ、Runtime上のModel選択、改善方針の最終決定主体はユーザーとする。

依頼から対象・変更内容・適用先が一意に決まる場合、その依頼自体を変更意思として扱う。方針が一意に決まらない場合、AIが具体案を示してユーザーへ判断を戻す。

## 2.2 AIによる操作と意味判断

Claude Code / Codex側のAIは、自然言語の理解、既存情報の調査、資産化、成果物の意味的な品質判断、改善案の作成、具体的なAACL操作への変換を担う。

保存する判断は、Asset、紐づけ、実行報告、提案、意思決定などの明示的な情報へ変換する。

## 2.3 Coreの責務

Coreは、Asset、Project Identity、紐づけ、Workflow Run、Snapshot、Journal、History、Provenance、Change Set、Diagnosticsを管理する。

Coreは同じ明示状態に同じ検証・解決規則を適用する。資産の本文を意味解釈して、使う資産を推測・選別する責務は持たない。

## 2.4 Runtimeの責務

Claude Code / Codexは、モデル起動、ファイル操作、shell・tool呼び出し、Git操作、subagentの起動、Runtime固有のpermissionとsession、実際のAI開発行為を担う。

## 2.5 資産の正本とContext

Canonical Assetと管理記録の正本はCoreが管理するCanonical Stateとする。Asset本文はUIで確認・編集でき、ユーザーが要求したときに人間可読形式で出力できる。

Workflow RunのContextは、Project Commonと、選択Workflow・現在Stage・Roleの紐づけに含まれる明示参照から構成する。`run.start`と遷移操作はContext本文を自動で返さず、次に実施するStage・実行主体・Model・Context Handleを示すExecution Planだけを返す。実際にStageを実施するオーケストレーターまたはサブエージェントがHandleでContextを取得し、Skill本文やsupporting files、Ruleを使う時点で取得する。Runを伴わないSkillの直接取得では、指定されたCanonical Skill本文を返す。

---

# 3. 管理対象の実行と通常利用

AACLがRun、Snapshot、実行状態を管理する対象は、ユーザーがWorkflowを明示的に選択し、CoreがRunを作成した実行とする。

```text
Workflowの明示選択
        ↓
Runの開始
        ↓
Contextの提供と実行
        ↓
Snapshot / Journal
        ↓
改善
```

Workflowの明示選択には、名前を含む自然言語依頼を含める。履歴や会話内容からAIが黙って選択することは、明示選択として扱わない。

Workflowを選択していない通常利用で、何を行い、どこまで自律実行するかは、ユーザーと接続先AI本来の関係に委ねる。AACLは通常利用へ独自の許可・禁止規則やWorkflow Stateを適用せず、Workflowの選択を催促して割り込まない。

通常利用へWorkflow / Skill / Rule / Model等を暗黙適用しない。Runを伴わないSkillの直接利用も通常のSkill利用として扱い、Run、Snapshot、実行履歴、Journal、比較用の実行統計を自動作成しない。後からそのSkill利用を管理対象Runとして記録する機能も提供しない。

Assetの検索・編集・資産化など、ユーザーが明示した管理操作はRun外でも扱う。変更・資産化を行った場合は、その依頼と変更理由をProvenanceへ記録する。

---

# 4. Canonical Asset

Canonical Assetは次の5種とする。

- Workflow
- Skill
- Role
- Rule
- Model

各Assetは、ID、name、description、revision、管理先、metadata、history、provenanceを持ち、種類ごとの本文・定義を保持する。SkillはRuntime入口のYAML front matterへ渡す`description`と、UIで人が呼び出し方を判断するための`explanation`、bodyを保持する。Modelはname、description、Model名、呼び出し方、選択肢グループを保持し、Model名と呼び出し方の`{{choice.<選択肢名>}}`をStageの選択値へ展開する。

Asset削除は対象Assetへの影響を確認してから確定する。確定前に、対象Assetを参照する紐づけ、対象Assetから参照する紐づけ、Project CommonからのRule参照をユーザーへ返す。参照の有無にかかわらず、Asset削除と一覧に含まれる参照解除にはユーザーの明示承認を必須とする。確認後、参照解除とAssetの削除状態への変更を一つの変更として保存する。プレビュー後にAssetまたは参照関係が変更された場合は削除を適用せず、最新の一覧から確認し直す。

削除したAssetは通常の検索・利用・紐づけ選択の対象から外す。Asset ID、削除revision、過去revision、History、Provenance、Change Setは保持し、過去のRun Snapshotは変更しない。削除によって参照解除された紐づけとProject Commonの変更も、それぞれの履歴へ保存する。

管理先はグローバルまたは特定のプロジェクトとする。グローバルのAssetとプロジェクトのAssetで名前が重複していても、別のAssetとして識別する。利用するAssetは紐づけやProject Commonの明示参照によって決まり、参照先をAsset IDで特定する。

Asset本体と、利用するAssetを示す紐づけを分けて管理する。ModelはSkill / Ruleを参照できるCanonical Assetとして管理する。Asset本体と紐づけはそれぞれrevisionで履歴を保持する。

revisionは履歴、Run、Snapshotの再現に用いる。既存Asset・紐づけ・Project CommonのWriteは取得時点の`expectedRevision`を必須とし、現在revisionと一致しない場合はConflictとして変更全体を拒否する。同じoperation IDによる再送は同一Writeとして扱う。Asset Writeは差分更新ではなく完全なAssetの全置換とし、bodyやsupporting filesを省略しない。過去revisionの復元は、その内容を新しいrevisionとして保存する。

---

# 5. Project Identity

AACL ProjectはCoreのProject registryに登録したstable project IDで識別する。ユーザーがProjectでaacl initを実行したとき、その時点で開いているProject rootを登録する。

Projectは、プロジェクト資産の管理先、紐づけ、Project Common、Run、Snapshot、Journal、改善の適用先を識別するために用いる。

ProjectはRuntimeが示す開いているProject rootと登録済みrootとの完全一致で解決する。親ディレクトリ探索、Git root推測、Project Marker、path alias、symlink解決を用いない。Windows形式とLinux形式のpathはLinux表記へ正規化してから照合する。

## 5.1 Project Common

Project Commonは、そのProjectで共通して使うRuleへの参照一覧を保持するProject設定である。Rule本文はCanonical Assetとして管理し、Project Commonには使うRuleのAsset IDを明示的に登録する。

登録したRuleは、そのProjectで開始するWorkflow RunのContextに含める。直接利用するSkillにはProject CommonやWorkflow Contextを自動では付与しない。特定のRoleや工程で使うRuleは、そのRole / Workflow / Stageへの紐づけで指定する。

Project Commonの登録・解除には、revision、変更履歴、変更理由を保持する。

---

# 6. グローバルとプロジェクト別の紐づけ

AACLはグローバルの紐づけと、各Projectの紐づけを別々に保存する。Project初期導入時にGlobalの紐づけをProject用として複製し、以後は独立して管理する。参照先のAsset本文は複製しない。

紐づけは、使う対象を明示する定義であり、次の関係を扱う。

- Workflow / Stage → Role / Skill / Rule
- Role → Skill / Rule
- Skill → Skill
- Model → Skill / Rule
- Workflow / Stage → Model
- Model → Skill / Rule
- Workflow / Stage → Model

Workflowのentry roleとStageごとの担当Roleは紐づけで指定する。各Stageには担当Roleを1件割り当て、必要なStageにはModelを1件指定する。StageへModelを紐づけることは、そのStageを指定Modelのサブエージェントで実行する指示になる。

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

Runtime入口はAssetとRuntime設定先のscopeが一致する場合に生成する。Global Assetの入口はGlobal設定先へ、Project Assetの入口は対応するProject内の`.claude/commands/`または`.codex/skills/`へ配置する。Project内にはそのProject専用の入口だけを置き、Global入口は複製しない。入口はCanonical Assetの複製ではなく、対象Use Caseを特定してAACLへ処理を渡すためのRuntime固有の生成物とする。Codexの入口は`SKILL.md`と同じSkill directoryに`agents/openai.yaml`を生成し、暗黙起動を禁止するpolicyをそこへ記載する。

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

Workflowはユーザーが明示的に選択してRunを開始する入口とする。useCaseが有効なSkillは、Runを開始せずCanonical Skill本文を直接取得してAIへ渡す入口とする。

次をUse Caseとして扱う。

- Workflow
- `useCase=true`のSkill

Use Caseの検索ではWorkflowと直接起動可能なSkillを扱う。Run開始操作の対象はWorkflowに限る。

Claude Code / CodexのRuntime入口は、Workflowを指定してRunを開始するか、直接起動Skillの本文を取得する。Skill入口からRunを開始しない。

Workflow Runは定義されたStageに沿って進行する。Skillの直接利用はユーザーとAIの通常のやりとりとして進み、Coreは実行状態や完了状態を管理しない。

---

# 9. Workflow

Workflowは、複数工程からなる再利用可能な開発方法を定義する。

Workflowは次を保持する。

- ID、name、description、revision
- transitions
- Stageの一覧と、各Stageからのtransition定義

Workflow / Stageで使うRole・Skill・Rule・Modelは紐づけで指定し、対象Projectの構成から取得する。

StageをWorkflowの実行単位とする。各Stageには担当Roleを必ず1件割り当て、Roleのresponsibilitiesを工程の基本としてContextへ含める。Stage固有の追加指示は任意の自由記述としてRoleのresponsibilitiesを補足してStage Contextへ含める。Stageが参照するSkill、Rule、Modelは任意とする。Modelを指定したStageはそのModelのサブエージェントで実行する指示としてContextへ含める。連続するStageの担当RoleとModelが同一なら、同じサブエージェントIDを継続して使う。各transitionは遷移先へ進むための必須自由記述conditionを持ち、Coreはその意味を判定しない。CoreはWorkflowのStage一覧、担当Role、Model、許可されたtransitionを管理し、AIまたはユーザーが選んだtransitionのconditionに対する判断報告を受けて構造と現在状態を検証する。

---

# 10. Skill

Skillは、再利用する手順、専門知識、範囲の定まった作業を表す。

Skillは次を保持する。

- ID、name、description、explanation、revision
- body
- supporting files
- useCase

別のSkillを使う関係は、Skill → Skillの紐づけで定義する。Workflow RunのContext Resolutionでは明示参照を再帰的に辿る。

本文とsupporting filesは、AIが必要時に取得する。利用対象になったことと、本文を取得したこと、実際に使ったことを区別する。

`useCase=true`のSkillは、直接起動できるSkillであることを示す。Runtime入口はAsset IDを指定し、Coreから取得したCanonical Skill本文をAIへ渡す。直接利用ではRunを作成せず、実行内容、結果、完了判断、Journalとの関連づけはCoreの管理対象にしない。

---

# 11. RoleとModel名の受け渡し

Roleは、実行主体が何者として振る舞い、何を担うかを定義する。共通の責務として複数のWorkflow / Stageから再利用する。

RoleはID、name、description、revision、responsibilitiesを保持する。responsibilitiesは、期待する責務・判断観点・成果責任を表す。

Roleで使うSkill / Ruleは、使用するGlobalまたはProject scopeの紐づけから取得する。Skill / Ruleの本文は独立したCanonical Assetとして管理し、Roleから参照する。ModelはStageから参照し、Model自身からSkill / Ruleを参照できる。

Coreは次をRole Contextとして構成する。

- Roleのresponsibilities
- 現在Stageに割り当てられた担当Roleの識別情報
- Roleから参照するSkill / Rule
- Workflow / Stageで使うと明示されたSkill / Rule
- Project Commonに登録されたRule

ModelはModel名と呼び出し方、任意の選択肢グループを保持し、Model名と呼び出し方には`{{choice.<選択肢名>}}`を埋め込める。StageのModel紐づけには各選択肢グループの選択値を保存し、ContextとExecution Planでは選択値へ展開する。未定義または未選択の選択肢は拒否する。Modelから明示参照されたSkill / RuleをContextへ含める。ModelからSkill / Ruleへの紐づけには選択肢条件を指定でき、同じ条件内はAND、複数条件はORとして一致する参照だけをContextへ含める。条件を指定しない参照はすべての選択状態で有効とする。外部Modelの実在性と利用可否、実際のサブエージェント起動はユーザーとRuntime / AIが担う。

---

# 12. RuleとSkillのRuntime description

Ruleは、対象実行で守る判断・行動指針を表す。ID、name、description、revision、bodyを保持する。

Roleのresponsibilitiesが責務・成果責任を定義するのに対し、Ruleは具体的な行動上の制約や判断基準を記述する。

使うRuleはRole / Workflow / Stageへの紐づけ、またはProject Commonへの登録で明示する。

Skillの`description`はRuntime入口のYAML front matterへそのまま渡す短い説明とする。UIのSkillの「説明」欄には、人が呼び出すか判断しやすい`explanation`を保存する。Workflow、Role、Stage、Rule、Modelには作業分類を保持せず、既存の分類値も通常利用・保存時に破棄する。

作業方法はWorkflow、実行責務はRole、具体的な手順や知識はSkill、制約はRuleとして表現する。

---

# 13. Capability

外部能力（filesystem、shell、GitHub、browser、external API等）の定義、提供状態、実行可否はClaude Code / CodexのRuntimeとユーザーが扱う。CoreはCapabilityを管理・保存・検証せず、Run開始、Stage遷移、完了判定にも用いない。

---

# 14. 自然言語によるAsset管理

AIがユーザー依頼を受けて行うAsset・紐づけ・Project Commonの管理操作は、Claude Code / CodexからMCP経由で行う。ユーザーはUIからもこれらを管理できる。

AIは次の流れで操作する。

1. ユーザーの依頼を理解する。
2. 対象のAsset・紐づけ・Project Common・関連資料を検索して読む。
3. 対象、変更内容、グローバル／プロジェクトの適用先を具体化する。
4. 一意に決まらない方針をユーザーへ確認する。
5. Coreへ明示操作を送り、検証と保存を行う。
6. 依頼、変更理由、判断、変更履歴を関連づける。

Asset自体の削除依頼では、AIはaacl_asset_delete_previewの結果から参照する紐づけ・参照される紐づけ・Project CommonのRule参照をユーザーへ示す。ユーザーが対象Assetの削除と一覧に含まれる参照解除を明示承認した後にだけ削除を確定する。最初の削除依頼だけでは確定操作を行わない。

ユーザーは「このRuleの確認項目Aを削除して」のように、内容への変更として依頼する。変更箇所や過去の変更IDの調査はAIが担う。

管理操作には、Assetの検索・取得・作成・更新・削除前確認・削除確定、紐づけの検索・取得・作成・変更・解除、Project Commonの取得・編集、Skillの直接起動設定、History・Provenanceの確認を含める。ModelのModel名と呼び出し方もAssetとして登録・更新する。

---

# 15. 既存情報と通常利用からの資産化

AIは、ユーザーが指定した既存の指示ファイル・設定・会話・成果物・要約・進め方を読み、Workflow / Skill / Role / Rule / Modelへ整理する。

使う資産と紐づけ、その管理先を具体化し、ユーザーの依頼と判断に基づいて保存する。

通常利用で見つけた方法も、ユーザーの明示依頼で資産化する。元の通常利用は管理対象のRunやJournalへ遡及変換せず、資産化元の情報としてProvenanceへ関連づける。

通常利用からの資産化と、管理対象の実行を振り返るJournal Reviewを、それぞれの入口として扱う。

---

# 16. Bootstrapと実行の入口

Bootstrapは、MCP接続時にAIへAACLの存在と利用方法を知らせる。案内には次を含める。

- AACLの役割と通常利用との境界
- Projectの確認方法
- Workflow Runの開始方法と直接起動Skill本文の取得方法
- Asset・紐づけの検索・編集・資産化方法
- Run StateとContextの取得方法、およびrun.startが返すContext Handleを後続のRun単位操作へ渡す方法
- JournalとJournal Reviewの操作方法

Bootstrapは繰り返し取得しても同じ案内として扱う。通常会話へ全Workflow・Skill・Ruleの本文を常時注入する用途にはしない。

接続先で使う起動用表現は、Claude CodeではCommand、CodexではSkillとし、Canonical Assetを参照する入口として扱う。これらのRuntime固有の起動用表現と、Canonical AssetとしてのSkillを区別する。

初期導入する`journal`と`journal-review`は標準Skillとして扱い、どちらも名称変更と削除を禁止する。本文、description、explanationは利用者が編集できる。`journal`は`useCase=false`としてRuntimeの直接起動入口を作らず、`journal-review`だけをユーザーが明示的に起動する入口とする。

Runtime設定先には、そのscopeに属する各Workflowと`useCase=true`のSkillだけを入口として配置する。Claude Codeでは`.claude/commands/`配下に起動用Commandを、Codexでは`.codex/skills/`配下に起動用Skillを生成する。Global scopeの入口はGlobal設定先に、Project scopeの入口は該当Project内に配置する。入口名は対象Asset名をRuntimeで使える形式に整えて生成し、同一設定先で名前が衝突する場合だけAsset IDを末尾に付ける。Codexの`SKILL.md`には`name`と`description`を記載し、SkillはCanonical Skillの`description`を、Workflowは`<Asset名>をAACLから起動する`をdescriptionへ渡す。いずれもAsset IDとMCP operationを記載する。暗黙起動の制御は`agents/openai.yaml`の`policy.allow_implicit_invocation: false`で行う。配置単位はWorkflow全体または直接起動Skillとし、StageやWorkflow内で参照する通常SkillはWorkflowの構成要素として扱う。初期導入時に作成し、対象の追加・解除・名称変更等で入口との対応関係が変わる場合は、Canonical Stateと一致するよう更新する。

Runtime入口にはSkillの`name`、`description`、AACL Asset IDと対応するMCP operationの呼び出し方法だけを記載し、Canonical本文やsupporting files、Service起動用のshell commandを含めない。発火後はAACLのSkill取得operationから本文を取得する。WSL上のServiceはWindowsログオン時にタスクスケジューラから起動する。自動起動はCLIで有効・無効・状態確認でき、アンインストール時に登録を解除する。

`journal`はJournal記録の設定対象であり、Runtimeの直接起動入口ではない。`journal-review`はユーザーが明示的に開始する直接起動Skillである。標準Skillの名称変更・削除・`journal`の直接起動化はCoreで拒否する。

Global設定先はRuntimeの標準位置から検出し、UIから追加できる。Windows側とWSL側のGlobal設定先は別々に扱う。各設定先にはscopeが一致するUse Case入口を配置する。設定先を管理対象から外す場合は既存ファイルを残し、以後Coreの管理対象から外す。SkillのuseCaseをfalseに変更した場合は、そのSkillのRuntime入口を解除する。

Workflow入口は対象Workflowを安定したAsset IDで特定し、MCP経由でRunを開始する。Skill入口は対象Skillの安定したAsset IDだけを指定し、MCP経由で取得したCanonical本文をAIへ渡す。Skill入口からRunを開始しない。いずれの入口にもCanonical本文やContext解決ロジックを複製しない。

起動用表現はRuntime固有の生成物でありCanonical Assetではない。削除・再生成してもCanonical Stateを失わず、表示名や接続先での表現形式が変わっても、参照するAssetの識別を維持する。

---

# 17. Runの開始と記録

Runは、一回のWorkflow実行を識別するCanonical Entityとする。直接起動するSkillにはRunを作成しない。

Coreは次を検証し、Run IDと初期状態を作成した時点で管理対象の実行を開始する。

- 明示選択されたWorkflowが存在し、そのrevisionを取得する。
- Definitionがvalidationを通る。
- 対象Project、使用する紐づけ、Project Commonの参照を解決する。
- Context Resolutionに使うrevisionの基準を確立する。
- Initial Stateを作成する。

接続、validation、revision整合性等によりRunを作成できなかった場合は、開始失敗として扱う。

1つのAI実行コンテキストに関連づくRunは1つとする。並列実行は別のAI実行コンテキストに関連づくRunとして扱い、Run同士の状態・Context・Snapshot・Journal関連を分離する。CoreはRun IDとContext Handleを発行し、`run.start`の応答でExecution Planとともに返す。以後のRun単位MCP操作はContext Handleを必須入力として受け取り、その値から対象Runを特定する。Execution Planの実行主体がHandleでContext取得を行い、オーケストレーターはサブエージェントへSkill・Rule本文を転送しない。AIは`run.start`から受け取ったHandleを同じAI実行コンテキストの後続操作へ渡し、ユーザーにHandleの入力を求めない。

CoreはRunごとにworkspaceを作成・分離せず、成果物やファイル変更の競合を管理しない。別workspaceやworktreeが必要な場合はユーザーまたはRuntimeが明示的に用意する。

Runは次を保持する。

- run id
- context handle
- Workflow ID / revision
- project
- 使用する紐づけとそのrevision
- 使用するProject Commonのrevision
- instruction / target
- resolution revision boundary
- status
- created at / updated at
- 現在Stage
- 関連するSnapshot、Journal、実行報告

---

# 18. Runの状態とWorkflowの進行

Runの状態を次のように扱う。

| 状態 | 意味 |
|---|---|
| active | 実行が進行中である |
| completed | `completed`への許可された遷移要求が受理された |
| cancelled | ユーザー意思により中止した |
| failed | 継続不能として終了した |

Workflow Runでは、Coreが現在Stageを保持し、定義に従って可能なtransitionと各conditionを示す。自己ループ・差し戻しと、Run全体のfailedを区別する。

現在Stage、許可されたtransition、Run状態はCoreが管理する。transition conditionの意味的な評価、遷移判断の報告、利用可能なtransitionの選択はユーザーまたは接続中AIが行う。Coreはtransitionの構造と状態を検証して保存する。

Runの終端状態はcompleted、cancelled、failedとする。ユーザーによる中止はcancelled、継続不能の報告または非活動timeoutはfailedとする。timeoutは既定24時間とし、Global設定で変更できる。読み取りを含むRun関連MCP操作は非活動時間を更新する。同一操作の再送はduplicate、状態が進行した後の別transitionはstaleとして扱う。

---

# 19. 遷移条件と終了

各transitionは、その遷移先へ進むとAIまたはユーザーが判断するための必須自由記述conditionを持つ。conditionは現在Stageからの経路ごとに保存し、同じ遷移先でも遷移元や判断内容が異なる場合に別々に記述できる。

AIまたはユーザーは現在Stageから選ぶtransitionのconditionを評価し、遷移すると判断した場合、遷移判断の報告と任意の根拠・コメントを添えてCoreへtransitionを要求する。conditionの意味や根拠の真偽はCoreが判定しない。

CoreはAIやユーザーの意味判断や根拠の真偽を評価せず、現在のRun状態、許可されたtransition、必須入力の構造を検証する。`to=completed`の許可されたtransitionが受理されたとき、Runをcompletedにする。

ユーザーは接続中AIを通じてRunのcancelを要求する。Runtime / AIは継続不能なRunをfailedとして終了報告する。

---

# 20. revisionの一貫性

Run開始時にWorkflow、資産・紐づけ・Project Commonのrevisionを固定し、Context Resolutionに使うstable revision boundaryを確立する。

同じRun内のContext Resolutionは、同じ基準を使う。途中で取得するSkill本文とsupporting filesも、そのRunの基準に従う。

新しいAsset・紐づけ・Project Commonの状態を使う場合は、新しいRunを開始する。

作成済みExecution Snapshotは変更しない。Asset・紐づけ・Project Commonが更新されても、過去のSnapshotから当時の内容とrevisionを確認する。

---

# 21. Context Resolver

ResolverはWorkflow RunのWorkflow、現在Stage、Role、Projectの紐づけから明示参照を辿り、利用対象の資産を解決する。Project Commonに登録されたRuleも、その明示参照から解決する。直接起動するSkillの取得は、指定されたAsset IDのCanonical Skill本文に限り、Workflow ContextやProject Commonを合成しない。

RoleがSkill Aを参照し、Skill AがSkill Bを参照する場合、AとBを対象に含める。各参照には、そのRunで使う紐づけとrevisionの基準を適用する。

利用対象は明示参照から決定する。名前の重複やグローバル／プロジェクトという管理先を理由に資産を選び直さず、条件が一致しただけの未参照資産を追加しない。

Coreは、参照先の存在、revisionの取得可否、紐づけ・Project Common・Run Stateの整合性を検証する。

Resolutionの入力は、Project、使用する紐づけ、Project Common、Workflow、Workflow Stage、Role、およびRunで固定したrevisionの基準とする。Runを伴わないSkill取得にはWorkflow StageやRunのrevision boundaryを設けない。

---

# 22. Contextの提供と説明

初期Contextには次を含める。

- Workflow Definition
- 紐づけとProject Commonで明示参照されたRule
- 利用対象Skillのcatalog
- 現在Stage、担当Roleとresponsibilities、任意の追加指示、現在Stageからの許可transitionと各condition

Stageの担当Roleとresponsibilitiesを工程の基本Contextとして含める。Stage固有の追加指示があればRoleへの補足として含める。StageにModelが紐づく場合は選択肢展開済みのModel名、呼び出し方、Modelから参照したSkill / Rule、およびサブエージェント継続指示をContextへ含める。

Workflow RunではSkill本文とsupporting filesをAIが必要時に取得し、利用対象のSkill集合とrevisionをContextの一部として扱う。直接起動Skillは指定Assetの本文を取得して渡す。

AACLは、資産がどの参照経路から利用対象になったか、何を渡したか、取得できなかった対象と理由を説明する。

今回利用対象になった理由はResolutionの記録で示し、その紐づけやProject Commonへの登録が行われた理由はProvenanceで示す。

---

# 23. Role間のContext引き渡し

Workflowで別のRoleへ作業を委譲する場合、Coreは引き渡すContextを構成する。

Contextには、Run ID、Workflowとrevision、Stage、stageRoleId、Roleとresponsibilities、任意の追加指示、現在Stageからの許可transitionと各condition、明示参照されたRuleとSkillを含める。

実際の割り当てと実行主体の起動は、接続中AIとRuntimeが担う。

---

# 24. 提供情報と実行報告

AACLがWorkflow Runに渡した情報と、AIから報告された実際の使用状況を、それぞれ記録して関連づける。

Execution Snapshotは、実行試行に提供したContextと、その構成を保持する。

- run id
- Workflowとrevision
- resolution revision boundary
- Project
- 使用した紐づけとrevision
- 使用したProject CommonのrevisionとRule参照
- Workflowの場合のStage
- Role、Runtime
- 利用対象のAssetとrevision
- 提供したRuleとSkill catalog
- 提供情報、参照経路と解決理由
- 取得できなかったContextと理由
- timestamp

AACLはSkill本文・supporting filesの提供も記録し、Runと対応するContextに関連づける。

Journalに記録する気づきには、実際に何をどう使ったかを補足する。AACLは、Skillが利用対象になった状態、本文を取得した状態、実際に使ったという報告を区別して保持する。Runに成果物用workspaceを割り当てたり、成果物をRun間で分離したりしない。

外部Modelの実在性・利用可否・実際の起動結果はCoreの検証対象に含めない。Model Assetの構造化情報と、Stageへの割当およびサブエージェント継続IDはCoreが管理する。

---

# 25. Journal

Journalは、開発方法や道具の使い方に関する一次観測とする。Journal本文と、TaskまたはRunのいずれかへの関連づけを必須とする。

既存journalの気づき中心の運用を保ち、タスク完了時に記録する気づきがある場合だけ残す。定番として確立した良さを毎回繰り返さず、書くことのない項目は省略する。

Journal記録はGlobal設定のON/OFFで制御する。ONの場合だけJournal Skillを使ってタスク完了時の気づきを記録し、OFFの場合は新しいJournal記録を受け付けない。既存のJournalとJournal ReviewはOFFでも閲覧できる。

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

Run Context Handleを伴うJournal作成操作では、CoreがHandleから対象Runを特定し、Project、Workflow revision、Stage、Snapshot、関連Assetと紐づけのrevisionを自動で関連づける。Journal本文にCore IDやModel情報を記述させず、Run Context HandleはMCP操作の入力として渡す。Run Context Handleもpost-run targetも指定しないJournalはTaskへ関連づける。

Journal Skillは固定見出しMarkdownの記載テンプレートをAIへ渡す。タスク完了時に、実際に役立った方法、困ったこと、改善の種など後で活かせる気づきがある場合だけ短いJournalを作成する。AIはJournal本文をMarkdownで送信し、Journal内容を構造化JSONやCore IDへ変換しない。Run Context HandleはJournal本文と分離したMCP操作入力として渡す。Coreは既知見出しを機械的に構造化し、重複した既知見出しは出現順に連結する。未知見出しや構造化できない内容は自由記述へ保持し、入力原文も保存する。意味の推測による項目割り当ては行わない。

記録の中心は、どう進め、道具や指示がどう働いたかとする。気づきのない実行に成功報告を求めず、Journalへの記載がないことだけを未使用・不要の根拠として扱わない。Run終了後のJournal追加では、MCP入力で対象Run IDを明示する。

---

# 26. Journal Review

Journal Reviewはユーザーが明示的に開始するSkillとして提供する。直接起動のReview自体にはRun、Snapshot、実行履歴を作成しない。

AIはCoreから新しいJournalと以前のレビューで保留した気づきを読み、Journalを横断してテーマ別に集約する。参照可能なJournal関連のSnapshot、Runの進行記録、Assetと紐づけの履歴、Provenanceも併せて読む。Review自体は記録対象にしないが、Proposalや採否・適用状態は明示的なMCP操作によってCoreに保存する。

集約では次を扱う。

- 繰り返す摩擦・詰まり
- 再現する価値のある良いパターン
- 新しいWorkflow / Skill / Role / Rule / Modelや紐づけの候補
- 既存の資産・紐づけの改善候補
- 資産や提供Contextを減らす・軽くする候補

既存資産が働くべきだった問題は、その資産を改善する案として扱い、重複した資産の追加を避ける。

汎用の改善はグローバル、プロジェクト固有の改善はそのプロジェクトを適用先として提案する。AIはAsset本体、紐づけ、Project Commonのどれを変更するかを示し、共有Assetを参照するプロジェクトへの影響を説明する。

各案に対象・具体的な変更・理由・根拠Journalを付け、レビューで扱ったJournal一覧とともに提示する。

保留した気づきは次回へ持ち越す。一つのJournalに反映済みと保留中の内容が混在する場合も、保留分を次回扱う。合意した変更の反映と、その改善材料の処理済みへの更新を一連の操作として扱う。

---

# 27. 改善提案とユーザー判断

改善提案は次を対象とする。

- Workflowの工程・遷移・遷移条件
- Roleの責務
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

Run外でAI経由により行うAsset・紐づけ・Project Commonの変更にも、依頼、理由、判断、Change Setを記録する。UIからの過去revision復元は復元元revisionを履歴に記録し、AIへの報告や理由入力を要求しない。

Asset・紐づけ・Project Commonについて、一つの意思決定で行う複数の変更はChange Setとしてまとめる。Change SetはID、origin type、対象、operations、reason、user request、proposal reference、approval information、history referenceを保持する。

Revision Historyは何が変わったか、Provenanceはなぜ変えたかを示す。AIは両者を参照し、ユーザーの内容に関する依頼を具体的な変更へ変換する。

---

# 29. 過去の状態の復元

AACLはAssetの過去revisionの復元と、Change Setに基づく復元をUIから扱う。復元内容は新しいrevisionとして保存し、履歴には復元元revisionを記録する。復元にユーザーからAIへの報告や理由入力を要求しない。

ユーザーはUIで復元対象revisionを選択する。内容修正は通常のAsset・紐づけ・Project Commonの編集として扱う。

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

Context Costは、AACLが実際に渡した情報量とする。Workflow Run / Stage / Role単位で比較し、提供Contextを増やしすぎていないかを確認する。

利用対象のcatalogに載っていても、取得されていないSkill本文は提供情報量に含めない。

改善判断では、情報量に加えて、Journalに記録された品質上の問題、手戻り、不足Context、Runのretry・review returnを併せて見る。

主要な改善軸はWorkflow Runとする。WorkflowではStage / Role / Assetへ分解して観測する。Runを伴わないSkillの直接利用は実行統計や比較の対象にしない。

比較では、Workflow revision、resolution revision boundary、資産・紐づけ・Project Commonのrevision、Runtime、Project、Stage / Roleを参照する。CoreはModelを比較軸として保持しない。

---

# 32. MCP Interface

MCPをAACLの主要なIntegration Interfaceとする。

MCPを通じて次のdomain operationを提供する。

- Bootstrapの取得
- Projectの確認とProject Commonの取得・編集
- グローバル／プロジェクトの紐づけの検索・取得・編集
- Workflowの検索・取得・Run開始
- 直接起動Skillの検索・Canonical本文取得
- Runの取得・遷移・完了・cancel・fail
- Contextの解決・取得・Roleへの引き渡し
- Assetの検索・取得・作成・更新
- Skill本文・supporting filesの取得
- Runtimeと使用状況の報告
- Snapshotと提供情報の確認
- Journalの作成・取得とJournal Reviewの支援
- Proposal、ユーザー判断、改善反映、保留・処理済みの記録
- History・Provenance・Change Setの確認と復元

具体的なtool名は実装で定める。

Read操作はAsset、紐づけ、Project Common、Stage、Runの進行状態を変更しない。Workflow RunにContextやSkillを渡したReadは、提供記録を追記し、Runの非活動timeoutを更新する。これらの運用記録はCanonical AssetやWorkflow状態のWriteとは分けて扱う。

Asset・Binding・Project Commonの更新・解除では取得時点の`expectedRevision`を受け取り、1件でも不一致ならChange Set全体をConflictとして保存しない。`changeset.preview`は同じ検証をDry Runし、適用予定の対象と不整合を返す。`changeset.restore`はChange Set適用後のrevisionが現在値と一致する場合だけ復元し、復元内容は新revisionとして保存する。Asset一覧は既定で概要だけを返し、本文・補助ファイルは明示指定または一括取得で返す。Runtime同期結果は成功数・失敗数・対象IDを返し、詳細な失敗理由はDiagnosticsへ保存する。Bootstrapの共通案内は専用operationで取得し、個別toolの説明は操作条件と入力例に絞る。Run transitionは現在状態と許可された遷移を検証し、同じ操作の再送をduplicate、進行後の別要求をstaleとして扱う。Run単位のMCP操作はContext Handleを入力として受け取り、CoreはそのHandleに対応するRunを特定する。

---

# 33. 保存、CLI、閲覧UI

AACLはsingle-userのlocalhost運用を基本とし、Canonical Assetと管理情報をCoreで管理する。Global AssetとProject AssetはCore内の別scopeとして扱い、Project内に共有用または正本用のAACLフォルダーを要求しない。初回対応環境はWSL上のLinux Coreとし、Windowsホストおよび同じWSL内のLinuxからClaude Code / CodexのMCP接続を利用できる。

Serviceはlocalhostのloopback interfaceだけで待ち受け、初回実装ではユーザー認証を設けない。外部LANからの接続は受け付けない。UIはJavaScriptが有効なChromium系ブラウザーで、Windowsホストまたは同じWSL内から利用する。

アンインストールの削除対象はAACLが管理するアプリケーション・データ用フォルダーに限る。Claude Code / Codex設定先に生成したRuntime入口はアンインストールで削除しない。

Canonical AssetはUIから確認・編集し、直接ファイル編集をCanonicalな更新経路として扱わない。Runtime固有の起動用Command / SkillはCanonical AssetのIDを参照する生成物とし、正本として扱わない。

認証情報はClaude Code / Codexや外部Tool Provider側で管理する。Asset本文へcredential、access token、password、secret keyを保存しない。

CLIはCoreの起動、Project初期導入、health・接続確認、保守、診断、明示的なexport / Backupを提供する。Project初期導入は現在開いているProject rootでaacl initを実行して行う。

Coreの起動にはaacl serveを利用できる。CLIの`aacl ensure`はServiceが未起動なら起動する。初期導入時はWindowsログオン時の自動起動を登録し、Windowsから起動した対象WSL内で`aacl ensure`を実行する。MCP Runtime入口は起動処理を持たず、MCP operationだけを呼び出す。自動起動はCLIから解除・再登録でき、アンインストール時に解除する。AssetとJournalのexportはMarkdownとYAML front matter、Run・Snapshot・History等の機械記録はJSONを基本形式とする。ExportとBackupはUIまたはCLIからユーザーが明示し、出力先はユーザーが指定する。自動Backupは要求しない。

UIはAsset、Global / Projectの紐づけ、Project Common、Workflow Run、Snapshot、Journal、Proposal、Provenance、Diagnostics、Historyを閲覧・編集する。変更はCoreへ送信する。Runを伴わないSkill利用自体は管理画面の実行記録として表示しない。

UIの視覚表現はリキッドグラス風とする。画面構成や個別の操作部品などの詳細は実装に委ね、次の操作性を備える。

- Workflow / StageごとにRole、Skill、Rule、Modelの紐づきを一覧でき、各Assetからも関連するWorkflow / Stageを確認できる。Stageへの直接参照と担当Role経由の参照を区別して示す。
- UIから紐づけを追加・解除・付け替えでき、SkillのuseCase設定を有効・無効に簡単に切り替えられる。現在の設定状態を見分けられる。
- Workflow編集画面でStageごとに既存Roleを必ず1件選ぶか、新しいRoleをGlobal Assetとして作成して割り当てられる。担当Roleの責務がStageの基本となり、追加指示は任意で記入できる。作成したRoleは他のWorkflow / Stageでも再利用できる。
- Workflow編集画面でStageごとにModelを任意に指定できる。Modelを指定したStageはサブエージェント実行の指示になり、連続する同じRole・ModelのStageでは同じサブエージェントへ依頼する。
- WorkflowのStage間の許可された遷移を図で表示する。各遷移の遷移元・遷移先・condition・表示名が分かり、自己ループや差し戻しも確認できる。
- UIの対応保証はviewport幅880 CSS px以上とする。

Runtime差は、Runtime identifierとRuntime固有Bootstrapとして扱う。外部Modelの実在性・利用可否はRuntimeが扱い、Model Assetの名前、Model名、呼び出し方、Skill / Rule参照、Stageへの割当はCoreが管理する。

---

# 34. ユーザーが育てるUse Case

WorkflowとSkillの定義はユーザーが所有し、作成・変更する。

Workflowの例として、issue-developmentやrefactoringがある。直接起動Skillの例として、architecture-review、security-review、test-review、journal-reviewがある。直接起動Skillの実行はRunを作らず、Journal Reviewの提案等は個別のMCP操作で管理する。

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

実際のWorkflow工程とRole、Skill、Rule、Modelの紐づけは、ユーザーの開発方法に合わせて定義する。Modelの実行自体はRuntimeへ委ねる。

---

# 35. 改善ループ

```text
ユーザー所有のAssetと紐づけ
        ↓
Workflowの明示選択
        ↓
Workflow Runとrevisionの固定
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
次のWorkflow Run
```

このループによって、ユーザー自身がClaude Code / Codexと作ってきた開発方法を蓄積し、実際の利用から改善し続ける。
