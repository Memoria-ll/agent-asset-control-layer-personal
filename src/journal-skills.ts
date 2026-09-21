import { assetSchema, journalTemplate } from './schema.ts';
import { journalSkillNames, journalSkillUseCases, type JournalSkillKey } from './canonical-assets.ts';
import type { Asset, Change } from './schema.ts';
import type { Core } from './core.ts';

const definitions: { key: JournalSkillKey; name: string; description: string; body: string; useCase: boolean }[] = [
  {
    key: 'journal',
    name: journalSkillNames.journal,
    description: 'タスク完了時に、実際に使ったTool・Skill・Ruleとその働き方について後で活かせる気づき（良かった点、困った点、改善の種）がある場合だけJournalを記録する。定番の成功報告は記録しない。',
    body: `気づきがある場合だけ短いJournalを残す。定番の成功報告で埋めない。何を使い、どう進め、道具や指示がどう働いたかを記述する。

「実際に使ったもの」ではTool・Skill・Ruleを区別し、対象とその場面・役割を書く。Typeはdesign / impl / bothのいずれかを記録する。良かった点は、次も再現したい今回固有の方法や意外に効いた組み合わせを中心にし、すでに定番として確立した良さは繰り返さない。コードの変更内容や差分ではなく、進め方と道具の働きを書く。

以下の固定見出しMarkdownを使い、書くことのない項目は省略する。気づきは空行で区切る。各気づきには、期待したことと実際の使用状況、結果への影響・摩擦・手戻り・不足したContext、根拠、確かさを把握できる範囲で添える。

${journalTemplate}
本文をaacl_journal_writeへ送る。現在のRunがあればrun.startで受け取ったcontextHandleを入力へ渡す。終了後のRunを明示する場合はpostRunIdを使う。Run外ではTaskを必ず指定する。本文にCore IDを埋め込まず、Modelは構造化しない。`,
    useCase: journalSkillUseCases.journal,
  },
  {
    key: 'journal-review',
    name: journalSkillNames['journal-review'],
    description: 'ユーザーが開始したJournal Reviewで、気づきを横断して改善を提案する。',
    body: `ユーザーが明示的にレビューを開始した場合に使う。Review用のRunを作成しない。

aacl_review_pendingへstatus=pendingを基本にprojectId、include、includeBodies、includeChanges、limit、cursorを必要に応じて渡し、Review項目の要約と関連IDを取得する。nextCursorがある限りページを読み、本文・変更内容が必要な対象だけaacl_review_item_getとaacl_proposal_getで詳細取得する。各Review項目は一つのJournal taskとInsightへ直接紐づくため、Journal全体やevidenceJournalIdsだけで状態を推測しない。

関連するRun・Snapshot・History・Provenanceを確認し、Journalを横断してテーマ別に集約する。最低限、次の分類を扱う。

- 繰り返す摩擦・詰まり
- 再現する価値のある良いパターン
- 新しいWorkflow・Skill・Role・Rule・Model・紐づけの候補
- 既存Asset・紐づけ・Project Commonの改善候補
- Assetや提供Contextを削除・降格・解除・縮小・軽量化する候補

Journalに記載がないことだけを、未使用・不要・効果がないことの根拠にしない。棚卸しでは「未観測」と「不要」を区別し、根拠が不足する案は確認候補または保留として扱う。既存資産が担うべき問題は、その資産の修正として具体化し、重複した資産の追加を避ける。

各テーマまたは提案に、テーマ名、提案種別（新規・修正・削除・降格・解除・縮小・軽量化・保留）、変更対象、具体的な変更、理由、根拠Journal、影響するAsset・紐づけ・Project、共有Assetを参照する他Projectへの影響、確かさ、処理する気づきを示す。レビューで扱ったJournalの一覧も最後に示す。Journalにない事実を推測で補わず、根拠が足りない場合はその不確かさを明記する。

aacl_proposal_saveでProposalを保存する。提案の判断はaacl_proposal_decide、提案を伴わないReview項目の判断はaacl_review_decideまたはaacl_review_decide_bulkで記録する。承認した提案はaacl_proposal_applyを実行し、変更と対象の気づき処理を一連で行う。保留した気づきを処理済みにしない。汎用的な改善はGlobal、Project固有の改善はそのProjectへ適用する。`,
    useCase: journalSkillUseCases['journal-review'],
  },
];

export function installJournalSkills(core: Core) {
  const existing = core.store.list<Asset>('asset').filter(a => !a.deletedAt);
  const changes: Change[] = [];
  for (const definition of definitions) {
    const current = existing.find(a => a.metadata.aaclUtility === definition.key);
    if (!current) {
      changes.push({ type: 'asset.save', asset: assetSchema.parse({ kind: 'skill', name: definition.name, description: definition.description, body: definition.body, useCase: definition.useCase, metadata: { aaclUtility: definition.key } }) });
    } else if (definition.key === 'journal' && current.useCase !== definition.useCase) {
      changes.push({ type: 'asset.save', id: current.id, expectedRevision: current.revision, asset: assetSchema.parse({ ...core.assetPayload(current), useCase: definition.useCase }) });
    }
  }
  if (!changes.length) return { installed: [] };
  return core.applyChanges(changes, { origin: 'cli', reason: 'JournalとJournal Reviewの標準入口を導入', userRequest: 'AACLの初期設定', sources: [], proposedBy: '', decision: '' }, undefined, undefined, undefined, undefined, false, true);
}
