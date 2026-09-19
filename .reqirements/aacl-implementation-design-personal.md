# Agent Asset Control Layer — 実装設計書（個人用）

更新日: 2026-09-18
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
- Coreは永続localhost Serviceとする。`aacl serve`で明示起動できる。WSL上の本番導入ではWindowsログオン時のタスクからWSLを起動し、`aacl ensure`でServiceを起動する。Runtime entryはMCP operationだけを呼び出す。
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
- Runtime同期はAssetとRuntime targetのscopeが一致する入口だけを配置する。Project targetにはそのProjectのAssetだけを置き、Global targetにはGlobal Assetだけを置く。
- Runtime entryは対象Canonical Assetの安定ID、Skillの`name`、`description`とMCP operationだけを格納する薄い生成物とし、Canonical本文やsupporting files、処理定義を含めない。
- 配置名はAsset名をRuntimeで有効なslugへ整え、同一target内で衝突する場合だけAsset IDを末尾に付ける。Codex Skillではfrontmatterの`name`と親folder名を一致させ、同じSkill directoryの`agents/openai.yaml`に`policy.allow_implicit_invocation: false`を生成する。暗黙起動の制御を`SKILL.md`のfrontmatterへ記載しない。
- File writerは対象Runtime・scopeに応じた配置先へentryを生成し、部分失敗を個別に検出できる単位で処理する。
- 生成状態とCanonical Stateの整合確認に失敗した場合、DB transactionを巻き戻さずDiagnosticsへ失敗結果を記録する。

### 4.4 起動後の動作

| Runtime entry | Core operation mapping |
| --- | --- |
| Workflow入口 | 型付きMCP operationでWorkflow IDを送り、Run開始応答からRun Context Handleを得る |
| Skill入口 | 型付きMCP operationでAsset IDを送り、Canonical Skill本文を取得する |

各operationの製品動作は開発要求書で定義し、本書ではRuntime adapterとCore operationの対応だけを定める。

### 4.5 Service autostart

- `aacl setup`とBackup復元後は、WSL distribution名を使ってWindows Task Schedulerへ現在ユーザーのlogon taskを登録する。taskは`wsl.exe --distribution <name> --exec <managed aacl> ensure`を実行する。
- `aacl autostart enable|disable|status`でtaskを管理する。task identityは解決済み管理directoryから安定して生成し、複数のAACL installationを区別する。
- task登録・解除はCLI境界に閉じる。task登録失敗はCLIへ返し、Runtime entryの生成やCanonical Stateを巻き戻さない。
- `aacl uninstall`はService停止と管理directory削除の前にtask登録を解除する。Runtime entryは既存要件どおり残す。

## 5. Canonical Assetと保存モデル

### 5.1 Asset共通

- Canonical AssetはWorkflow、Skill、Role、Rule、Modelの5種とする。
- Coreが生成するUUIDをAsset IDとし、名前変更後も同じIDを使う。
- Asset revisionは単調増加整数とし、現在値と不変の過去revisionを分離して保存する。
- Revision recordにはAsset ID、revision、本文、更新時刻を含め、Run開始時の参照を再現できるindexを用意する。
- Writeの適用とoperation IDの冪等記録を同一transactionに含める。既存Asset・Binding・Project Commonの更新・解除は`expectedRevision`を検証し、不一致ならChange Set全体をConflictとして保存しない。Asset payloadは完全な全置換として扱う。
- 過去revisionの復元は、その内容を新revisionとして保存する。
- ScopeはGlobal / Projectを共通record上で識別し、同名Assetの一意性を名前に依存させない。
- Asset削除は物理削除を行わず、`deletedAt`を持つ新revisionとして保存する。削除済みAssetは通常のAsset検索・利用・紐づけ候補から除外し、過去revisionとRun Snapshotは保持する。
- `asset.delete.preview`は参照する紐づけ、参照される紐づけ、Project CommonのRule参照を名前・方向・revision付きで返す。`asset.delete`はpreviewのAsset・参照revisionと明示確認を必須とし、表示後に参照状態が変わっていたら拒否する。
- 明示確認後の削除は、previewに含まれる紐づけとProject Common参照の解除、Assetの削除状態、History、Provenance、Change Setを同じtransactionで保存する。過去Change Setの復元ではAssetと参照関係を復元する。

### 5.2 Schema境界

- SchemaはCore内部の保存・受け渡し契約として実装し、独立したAsset recordを作らない。
- 内容schemaを持つ対象はSkill、Journal、Workflow、Stage、Modelとする。Role、Ruleは保存・参照に必要な共通recordとする。
- Schemaの具体的な表現、DB正規化、version、migrationは実装事項とする。
- Validatorは要求書で指定された構造条件だけを検査し、自由記述の値に意味解釈を加えない。

### 5.3 Skill、Workflow、Stage

- Skill recordの必須本文fieldはname、description、explanation、bodyとし、`description`はRuntime入口のYAML front matter、`explanation`はUIで人が呼び出し方を判断する説明として保存する。useCase設定をRuntime target生成処理へ渡す。
- Workflow recordはStage listとtransition定義を保持し、StageはWorkflow内の子recordとして保存する。
- Model recordはModel名と呼び出し方を保持する。ModelからSkill / Ruleを参照でき、WorkflowのStageから`stage-model` purposeとstageIdでModelを1件まで指定できる。
- Workflow内の各Stageに`stage-role` purposeとstageIdで指定したRoleを1件割り当て、各transitionに遷移先へ進む必須`condition`を保存・検証する。担当Roleの責務をStageの基本とし、Stageの`additionalInstructions`は任意の追加指示として保存する。Modelを指定したStageはサブエージェント実行の指示とし、連続する同じRole・Modelでは同じsubagent IDをRunへ保持する。
- Workflow編集UIではStageごとにRoleを割り当て、任意の追加指示を設定できる。新規RoleとWorkflowは`asset.create`でIDを確定してからbindingと同じChange Setで作成し、Roleを複数Workflow / Stageから再利用する。重複IDは拒否する。
- 作業分類のfieldはWorkflow、Role、Stage、Rule、Modelへ格納しない。旧recordに残る分類値は読み出し・更新時に破棄する。

## 6. Workflow Run

### 6.1 Run開始とContext

- Workflow Run開始用とSkill本文取得用に、別々のtyped MCP operationを実装する。Skill取得operationはRun Contextを生成しない。
- `run.start`の応答にRun IDとRun Context Handleを含め、CoreはRun IDとHandleの対応を保存する。
- Run単位のMCP operationはContext Handleを必須入力として受け取り、その値から対象Runを解決する。AIは`run.start`から受け取ったHandleを同じAI実行Contextの後続operationへ渡す。
- Run開始transactionでWorkflowと参照revisionの境界を固定し、変更不能なExecution Snapshotを作成する。Snapshotにはrun id、Workflowとrevision、resolution revision boundary、Project、使用した紐づけとrevision、Project CommonのrevisionとRule参照、該当するStage、Role、Runtime、利用対象Assetとrevision、提供したRuleとSkill catalog、timestampを保持する。
- Resolution recordには、利用対象になった各Assetの参照経路と解決理由を保持する。取得できなかったContextと理由も記録し、初期Contextに渡した情報と区別する。
- Initial ContextはWorkflow Definition、現在Stageからの許可transitionと各`condition`、`stageRoleId`、担当Roleのresponsibilities、Stageの`additionalInstructions`、明示参照されたRule、利用対象Skill catalog、指定Modelの固定revision、呼び出し方、サブエージェント継続指示で構成する。
- Context、Skill本文、supporting fileをRunへ返すRead operationは、RunとSnapshotに対応するappend-only delivery recordを残す。recordには取得対象とrevision、参照経路、提供結果、提供した内容または同一内容を再現できる不変参照を含める。取得できない場合は対象と理由を記録する。
- 利用対象になった状態、実際に提供した状態、Journal等で報告された実利用を別々に保持する。取得記録だけから実利用を推定しない。Context Costは提供recordを集計し、未取得のSkill本文を含めない。
- ResolverはAsset ID relationを再帰的にたどり、visited setで重複排除と循環検出を行う。必須参照不在時の開始失敗と、任意supporting fileの取得失敗理由を別結果として扱う。
- Run IDをpartition keyとして状態、Context参照、Snapshot、Journal link、append-only eventを分離する。Snapshot本体は作成後に更新せず、以後の提供記録をdelivery recordとして追記する。

### 6.2 MCPのRun関連づけ

- Streamable HTTPでMCP 2026-07-28を提供し、旧protocol requestはSDKのstateless fallbackで処理する。protocol sessionをRun関連づけに使わず、Run Context Handleをアプリケーション側のContextとして実装する。[MCP Transport仕様](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)
- Run単位の各MCP operationはRun Context Handleをtyped inputとして受け取り、CoreはHandleからRun IDを解決する。
- AIは`run.start`応答のHandleを同じ実行Contextからの後続MCP operationへ渡す。Claude CodeとCodexのそれぞれで、同一Runtime内の複数チャットから並行操作しても各Handleが別のRunへ解決されることを結合試験で確認する。

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

- Journal write APIはMarkdown bodyを受け、Run Context Handleまたは明示されたpost-run Run IDからRun associationを決定する。Run Context HandleはMCP入力として受け取り、Journal bodyからCore IDを解析しない。Handleもpost-run Run IDも伴わないJournalにはTask associationを必須とする。
- Journal recordにはRunまたはTaskのassociationを保持する。Context Handleを伴う場合はCoreが対象Runを特定し、Project、Workflow revision、Stage、Snapshot、関連Assetと紐づけのrevisionも付与する。
- AIが報告した実利用はJournal内の該当気づきとして記録し、Context Handleから解決したRunに対応するSnapshotと関連Asset revisionへ結び付ける。Resolutionの対象または提供記録だけから実利用を判定しない。
- Parserは固定見出しを文字列として照合する。見出し対応、重複見出しの順序連結、未知見出しの自由記述格納、原文保存をunit testで固定する。
- Parseに失敗した断片を破棄・推測分類しない。raw bodyと構造化部分を同一Journal revisionへ保存する。
- Review対象の気づきはJournal全体と別の`ReviewItem`識別単位で保持し、`journalTaskId`、`journalId`、`insightId`を直接関連づける。各ReviewItemは`pending`、`processed`、`rejected`と`lastDecision`を持ち、Journal taskにはReviewItem全体の集約`reviewStatus`を保存する。同じJournal内の各気づきは独立して状態更新できる。

### 7.2 Journal ReviewとProposal

- Journal Review用のRead operationは`status`、Project、`limit`、`cursor`、関連データの`include`、本文・変更内容のinclude指定で一覧を絞り、ReviewItemの要約と`journalTaskId`・`insightId`・Proposal IDを返す。変更内容や履歴は`review.item.get`と`proposal.get`で対象を指定して取得し、関連するSnapshot、Run進行記録、Asset・紐づけの履歴、Provenanceを参照可能にする。保留中の気づきは次回のReadにも含める。
- Journal ReviewそのもののRun、Snapshot、実行履歴recordは作らない。Reviewで扱ったJournal一覧はProposal作成時に渡して保存する。
- Proposalはobserved context、proposed change、reason、evidence Journal、affected assets、影響する紐づけとProjectを保持する。Proposalの対象変更、根拠、Reviewで扱ったJournal一覧を明示する。
- Proposal、Proposalへのユーザー判断、ReviewItem、insight status、Journal task、Change Set relationは別recordとして保存する。提案の承認時は適用完了までReviewItemとInsightを`pending`のまま保ち、`proposal.apply`で変更適用と対象ReviewItem・Insight・Journal taskの更新を同じtransactionで行う。提案を伴わないReview判断はReviewItem単位の操作で3対象を同じtransactionで更新する。
- 気づき単位で保留・処理済み・却下を更新できる。一部だけを処理した場合、未処理の気づきは`pending`のまま次回Reviewへ引き継ぐ。
- 合意した変更の適用と、その変更に対応する気づきの`processed`更新は同一DB transactionとする。対象Journalと気づきを限定し、同じJournal内の保留分を処理済みにしない。重複操作はoperation IDで冪等に扱う。

## 8. UI、CLI、MCP

- UI、CLI、MCPはCore Serviceのapplication APIだけを利用する。UIからの変更も同じvalidation・transaction pathへ送る。
- UIは開発要求§33の視覚・操作要件を満たし、Workflow / Stage視点とAsset視点の紐づき確認・編集、SkillのuseCase切替、許可遷移の図示を実装する。
- MCP adapterはpurpose-specific typed operationを登録し、generic action dispatchやSQL passthroughを実装しない。`changeset.preview`、`asset.get_many`を提供し、Asset一覧は概要を既定にする。Change Setの`changes`はasset.save / asset.create / binding.save / binding.remove / common.save等の具体的な判別unionとして公開する。共通Bootstrapは`bootstrap.get`へ分離し、個別tool説明へ長文案内を重複させない。
- Request / Responseの型と内容schemaは内部契約として管理し、Skill、Journal、Workflow、Stageのpayloadを検証する。
- CLI bootstrapはService起動、Project登録、health確認、診断、export / Backup commandを提供する。

## 9. ExportとBackup

- SerializerはAsset / JournalをMarkdown + YAML front matter、Run / Snapshot / History等のrecordをJSONへ写像する。
- Exportはユーザー指定directoryへの明示的なfile writeとして実装し、Canonical SQLite stateを書き換えない。
- Backup formatはSQLite整合性を保つ取得方式を選び、復元時のschema migrationとの互換条件を定義する。

## 10. 初回実装で確認する重要条件

§12の確認IDを実装試験へ割り当て、少なくとも次の結合経路を確認する。

- `C03`、`C08`、`C17`、`C20`、`C24`、`C35`：Workflowを明示選択してRunを開始し、固定revisionでContextを提供・記録し、Journal Reviewの変更を次のRunで確認する。並行RunのContextと記録は混線しない。
- `C08`、`C10`、`C16`：Workflow入口はRunを開始し、直接起動Skill入口は指定Assetの本文だけを取得する。後者にRun、Snapshot、実行記録、Journalを作らない。
- `C33`：UIでStage / Assetの双方から紐づきを確認・変更し、SkillのuseCaseを切り替える。Workflow図に次工程、差し戻し、retry等の自己ループを含む許可遷移が表示され、リキッドグラス風の視覚表現を満たすことを受入確認する。
- `C21`–`C24`、`C31`：解決理由、提供した情報、取得失敗理由、実際に提供した量を記録し、対象になっただけの情報や未取得本文を提供量へ数えない。
- `C25`–`C27`：Task関連JournalをReviewでき、同一Journal内の保留分を次回へ残しながら選択した気づきと合意変更だけを処理済みにする。提案判断、Change Set適用、処理状態の整合を確認する。
- `C01`–`C35`：§12の全確認条件を、対応する実装/API領域の試験で満たす。MCP toolの具体名はAPI契約確定時に確認IDへ対応づける。

## 11. 内部設計で確定する事項

次は製品動作の選択ではなく、合意した設計を実装するために実装者が決める事項である。

- SQLiteテーブル、内部schema表現、migration方式、index、operation IDの形式
- MCP tool名、各payload、Bootstrap本文、HTTP endpointの構成
- Run Context HandleをRun単位MCP operationのtyped inputへ含めるpayload field名と、Runtime別の起動方法
- Runtime別標準設定先の検出方法、設定先追加画面、生成ファイル名と衝突回避
- UI画面構成、部品配置、紐づけ・useCaseの編集操作、diff表示、エラー表示の具体形
- Journal見出しの確定文字列、Task参照のpayload表現、気づきの抽出単位とMarkdown構文処理の詳細
- SnapshotおよびContext delivery recordの物理schema、提供内容の保持形式と保存先
- Backup形式、オンライン取得時の整合性確保、復元フロー
- Setup / uninstall UI・CLI。データ削除範囲はAACL管理フォルダー内に限定する

## 12. 要求トレーサビリティ

本書の実装条件/API領域と確認条件を、開発要求 v16 の各節へ対応づける。確認条件は実装時に試験へ割り当て、MCP toolの具体名と試験識別子の対応はAPI契約確定時に記録する。利用者に見える仕様の追加・変更は開発要求書へ記載し、その後に必要な実装条件を本書へ反映する。

| 確認ID | 要件節 | 実装条件 / API領域 | 確認条件 |
| --- | --- | --- | --- |
| C01 | §1 目的と利用形態 | Asset管理、Run、Context、Journal、Review、UI・CLI・Export各domain operation | Assetを管理し、Workflow実行からReviewによる改善までの機能境界が一貫して利用できる。 |
| C02 | §2 基本原則と責務分担 | Core validation、MCP / UI application API | 構造不正はCoreが拒否し、本文の意味判断はCoreが行わない。UIとMCPの変更が同じCore経路を通る。 |
| C03 | §3 管理対象の実行と通常利用 | Workflow選択・Run API、Skill取得API | 明示したWorkflowだけがRunを作り、通常利用と直接Skill利用ではRun等の管理記録を自動作成しない。 |
| C04 | §4 Canonical Asset | Asset CRUD、revision、History API | 5種のAsset IDが名前変更後も維持され、完全Asset payloadとexpectedRevisionでWriteを検証し、競合時は拒否、再送は冪等となる。参照一覧をユーザーへ示して明示確認を得た後にだけ削除し、参照解除と削除状態を同じChange Setへ保存する。 |
| C05 | §5 Project Identity | Project registry、path adapter、Project Common API | Windows / Linux pathが定義どおり照合され、未登録rootや親・alias・symlinkから別Projectを推定しない。Project Commonの変更revisionとRule参照を確認できる。 |
| C06 | §6 グローバルとプロジェクト別の紐づけ | Binding CRUD、Asset reference API | Global / Projectの紐づけが独立し、明示したAsset IDを参照する。Skillの再帰参照を解決し、同名Assetへ勝手に切り替わらない。 |
| C07 | §7 プロジェクト初期導入 | `aacl init`、binding copy、Runtime entry生成 | Global紐づけのみがコピーされ、Asset本文は複製されず、Project Commonは空で始まる。失敗時に登録とコピーが部分状態にならない。 |
| C08 | §8 Use Case | Use Case search、Run start、direct Skill retrieval | 検索はWorkflowと`useCase=true` Skillを扱い、Run startはWorkflowだけを受け付ける。Skill取得はRunを作らない。 |
| C09 | §9 Workflow | Workflow / Stage schema、transition API | 各Stageの担当Role 1件、任意のStage Model 1件、各transitionの必須condition、許可transitionが検証され、Workflow定義にない遷移を受理しない。追加指示は任意で保存される。 |
| C10 | §10 Skill | Skill CRUD、body / supporting file retrieval | 本文とsupporting filesを固定revisionで取得でき、対象・取得・実利用報告を別状態として参照できる。 |
| C11 | §11 RoleとModel名の受け渡し | Role / Model API、Context builder、Runtime report | Stageの担当Roleと責務をContextの基本とし、追加指示を任意で含める。指定Modelの固定revision、Model名、呼び出し方、明示参照Skill / Rule、サブエージェント継続指示をContextへ含める。外部Modelの実在性は検証しない。 |
| C12 | §12 RuleとSkillのRuntime description | Rule CRUD、Skill description / explanation、Context builder | Ruleは明示参照でのみContextに入り、Skillの`description`はRuntime入口へ渡し、`explanation`はUI向けに保持する。非Skillの作業分類は保持しない。 |
| C13 | §13 Capability | Core schema / validation境界 | Capability情報がCoreの保存・検証やRun開始・遷移条件に使われない。 |
| C14 | §14 自然言語によるAsset管理 | MCP Asset / Binding / Project Common API、UI編集API、Provenance | 検索・取得・作成・更新・解除・削除の変更が明示操作で保存され、依頼と変更理由へ関連づく。削除は影響一覧と明示確認を経て確定する。 |
| C15 | §15 既存情報と通常利用からの資産化 | Asset write、Provenance API | 明示依頼で資産化した元資料をProvenanceから確認でき、通常利用をRunやJournalへ遡及変換しない。 |
| C16 | §16 Bootstrapと実行の入口 | Bootstrap API、Runtime adapter、entry writer | Bootstrap再取得で同じ案内を返し、入口はAsset IDを参照する。追加・解除・名称変更時に対応を更新し、管理解除した既存ファイルを残す。 |
| C17 | §17 Runの開始と記録 | `run.start`、Context Handle返却・Run単位operation入力 | 不正なWorkflow・参照では開始せず、成功時はRun ID、Handle、revision境界、初期状態を作成する。並行Contextが別Handleで分離される。 |
| C18 | §18 Runの状態とWorkflowの進行 | Run read、transition、cancel、fail API | activeから許可された終端状態へ遷移し、再送をduplicate、進行後の別要求をstaleとして状態を壊さず記録する。 |
| C19 | §19 遷移条件と終了 | transition condition、transition API | 各transitionのconditionを必須保存し、Coreは意味の正しさを判定せず、`to=completed`の許可遷移でのみcompletedにする。 |
| C20 | §20 revisionの一貫性 | revision resolver、Snapshot API | Run中の更新後も全Resolutionと取得が固定境界を使い、既存Snapshotは変わらず、次Runは新revisionを使う。 |
| C21 | §21 Context Resolver | Resolver API、reference graph validation | 明示参照のみを辿って重複を除き、循環と必須参照欠落を検出する。任意ファイルの取得失敗は理由付きで返す。 |
| C22 | §22 Contextの提供と説明 | Context read、Resolution record | 初期Contextの構成要素として現在StageのRole ID、Role責務、追加指示を提供し、各Assetの参照経路・解決理由、取得できない対象と理由を確認できる。 |
| C23 | §23 Role間のContext引き渡し | Role handoff Context API | Run、Workflow revision、Stage、現在Stageからの許可transitionとcondition、`stageRoleId`、Role responsibilities、追加指示、明示参照Rule / Skillを渡し、実行主体の起動はRuntime側に残す。 |
| C24 | §24 提供情報と実行報告 | Snapshot、Context delivery、Journal usage report API | Snapshotの全必須項目と提供内容を再現でき、未取得理由を保持する。利用対象・提供済み・実利用報告を区別する。 |
| C25 | §25 Journal | Journal write/read、Run / Task association、parser | RunなしではTask associationを要求し、Run Context由来の関連を自動付与する。未知見出し・重複見出し・解析不能部分・原文が保たれ、気づき状態を個別更新できる。 |
| C26 | §26 Journal Review | Pending insight read、Proposal / status / apply API | Review自体にRun等を作らず、新規Journalと保留気づきを読める。同一Journalの一部だけを処理し、残りを次回へ引き継ぐ。 |
| C27 | §27 改善提案とユーザー判断 | Proposal CRUD、decision、Change Set API | Proposalにobserved context、proposed change、reason、evidence、affected assets、紐づけ、Projectを保持する。未確定の提案はユーザー判断前に適用しない。 |
| C28 | §28 Provenanceと変更履歴 | History、Provenance、Change Set API | 変更内容と理由が別に追跡でき、Change Setから対象、operations、依頼、判断、履歴を確認できる。 |
| C29 | §29 過去の状態の復元 | UI revision / Change Set restore API | 選択した過去内容を新revisionとして復元し、復元元revisionを履歴へ記録する。理由入力を要求しない。 |
| C30 | §30 Diagnostics | Diagnostics API、evidence link | 欠落参照、取得不能revision、不整合、反復遷移、Context量を対象と根拠付きで提示し、意味的修正を自動適用しない。 |
| C31 | §31 Context Costと改善の比較軸 | Delivery record aggregation、comparison API | 実際に渡した情報だけをWorkflow / Stage / Role等で比較し、未取得本文と直接Skill実行を統計へ含めない。ModelはContextの構成要素として記録する。 |
| C32 | §32 MCP Interface | Typed domain operations、idempotent Write、Run-scoped Read | 要求書のdomain operation群を提供し、ReadはCanonical stateを変えず、Run向け提供記録と活動時刻のみを更新する。Write再送は冪等となる。 |
| C33 | §33 保存、CLI、閲覧UI | Core service、SQLite、CLI、UI、Export / Backup | WSL上のCoreへWindows / Linux clientから接続できる。Windowsログオン時のtaskでWSLとServiceを起動し、taskを解除・削除できる。loopback境界、削除範囲、credential除外、明示的なExport / Backupを確認する。UIではStage / Assetの双方から紐づきを確認・変更でき、各Stageの必須Roleと任意の追加指示を編集できる。useCase切替とStage別の許可遷移図示を備え、リキッドグラス風の視覚表現を満たす。 |
| C34 | §34 ユーザーが育てるUse Case | Workflow / Skill CRUD、Runtime entry | ユーザー定義のWorkflowと直接Skillを作成・変更して起動できる。例示された工程やAssetを組み込み必須データにしない。 |
| C35 | §35 改善ループ | Run、Snapshot、Journal、Review、Proposal、Change Set、次Run | Runの実際の提供記録とJournalをReviewへ渡し、ユーザー判断に沿う変更を記録した後、次RunのContextへ反映する。 |
