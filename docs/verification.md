# 要件と検証の対応

正式コマンドは`npm run check`。`test/core.test.ts`、`test/service.test.ts`、`test/cli.test.ts`、`test/ui.spec.ts`を使用する。

| 確認ID | 主な操作 | 試験で固定する条件 |
| --- | --- | --- |
| C01、C35 | `run.start`、`journal.write`、`proposal.*` | Run→Journal→承認→一部気づきと変更の同時適用→次Runのrevision |
| C02、C04 | `asset.save`、`asset.restore`、`changeset.preview` | 共通schema、不正入力拒否、安定ID、expectedRevisionによるConflict、Dry Run、冪等性、不変履歴 |
| C03、C08、C10 | `usecase.search`、`skill.get`、`run.skill.get` | Skill直接取得でRun等を作らない。本文・補助ファイルの遅延取得 |
| C05、C07 | `project.init`、`project.resolve`、`common.*` | path正規化、root完全一致、重複登録拒否、Global紐づけだけの複製、空のCommon、scopeに一致するProject入口とGlobal入口の非重複 |
| C06 | `binding.*` | コピー後の独立性、IDでの参照、Role→Skill→Skill、循環拒否 |
| C09、C19 | `asset.save`、`run.transition` | Stage完了条件必須、遷移元・先・種別、許可されていない遷移の拒否、完了報告 |
| C11、C12、C13 | `context.get`、`context.handoff` | Role責務と明示Rule、指定Modelの固定情報とサブエージェント継続、分類、Capabilityを入力契約へ追加しない |
| C14、C15、C28 | `asset.save`、`changeset.preview`、`changeset.apply`、`history.get` | 依頼・理由の保存、完全Assetの全置換、expectedRevisionによる一括Conflict、UI／MCPの共通処理、通常利用をRunにしない |
| C16、C34 | `runtime.*`、`setup.skills`、`skill.autoinvocation` | Skillのname・description・IDだけを持つ入口、description原文のYAML出力、autoInvocationに応じたCodex policy、supportingFilesのRuntime別相対配置・hash管理・owner-only権限・削除／改名・ユーザー編集／symlink／予約パス衝突の診断、通常Skillの名称変更、標準Journal Skillの名称変更・削除拒否、journalの直接起動除外、useCase／autoInvocation解除、衝突検出、設定先管理解除後のファイル保持、ユーザー所有の定義 |
| C17 | `run.start`とRun単位の各操作 | 異なるHandle、並行HTTP／MCP要求のContextと状態の分離 |
| C18 | `run.get`、`run.transition`、`run.cancel`、`run.fail` | duplicate／stale、自己ループ、終端状態、読み取りによる活動時刻、timeout |
| C20〜C24 | `context.*`、`run.skill.get`、`run.inspect`、`review.run.inspect`、`run.report` | 不変Snapshot、更新後も固定revision、明示参照のみ、取得失敗の理由、提供と使用報告の区別。Workflow実行主体向けMCPから全Snapshot inspectionを除外し、Journalに紐づく完了Runだけbody-lessに参照する |
| C25 | `journal.template`、`journal.write`、`insight.status`、`settings.save` | Journal記録ON/OFF、TaskまたはRun必須、原文、未知・重複見出し、コードフェンス、個別の気づき状態 |
| C26、C27 | `review.pending`、`review.item.get`、`review.decide*`、`proposal.*` | ReviewItemの絞り込み・詳細分離、直接紐づくJournal task / Insightの同一transaction更新、承認前の適用拒否、判断と適用の分離、保留の持ち越し、Review用Runを作らない |
| C29 | `asset.restore`、`changeset.restore` | 過去内容を新revisionとして復元、復元元の記録 |
| C30、C31 | `diagnostics.get`、`costs.get` | 繰り返すretry、提供した内容だけのUTF-8バイト量、未取得本文・直接Skill利用の除外 |
| C32 | MCP `tools/list`・`tools/call` | 用途別typed tool、Handle必須schema、protocol metadata、Readで資産revisionを変更しない |
| C33 | CLI・UI・保守API | loopback、Origin／Host検査、SQLite永続化、Backup復元、管理範囲内のアンインストール、画面での編集・遷移図・改善ループ |

## 実環境での受入確認

自動試験に加えて、利用するRuntimeとWindows／WSLの組み合わせで次を確認する。

1. WindowsホストのChromiumからWSLのUIへlocalhostで接続できる。
2. Claude CodeとCodexのそれぞれからMCP接続し、Bootstrapを取得できる。protocol 2026-07-28と旧protocolのstateless fallbackは自動試験で確認する。
3. 各Runtimeで2つのチャットを同時に開き、別々にRunを開始する。各チャットが自身のHandleを後続操作へ渡し、Context・Journal・遷移が混線しない。
4. Global／Projectの生成入口をRuntimeが認識し、Windows側ではWSL経由でServiceの起動を確認できる。Skill入口は本文だけを取得し、Workflow入口はRunを開始する。
5. Stage側とAsset側の参照表示・編集、直接参照とRole経由の表示、Stage Modelの指定、SkillのuseCase／autoInvocation切り替え、次工程・差し戻し・自己ループの図、リキッドグラス風の見た目を利用者が確認する。

実Runtimeとの会話とWindowsホスト接続は自動試験では代替しない。MCP試験のRuntime識別子は入力データであり、Claude Code／Codexプロセスを実行した証明ではない。
