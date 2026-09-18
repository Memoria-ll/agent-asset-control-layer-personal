import { assetSchema, journalTemplate } from './schema.js';
export function installJournalSkills(core) {
    const definitions = [
        { key: 'journal', name: 'journal', description: '作業の区切りで、進め方や道具の使い方に関する気づきを記録する。', body: `明確な設計・実装タスクの区切りで、気づきがある場合だけ短いJournalを残す。定番の成功報告で埋めない。実際に使ったものと、その働き方を記述する。\n\n以下の固定見出しMarkdownを使い、書くことのない項目は省略する。気づきは空行で区切る。根拠と確かさは対応する気づきの段落に添える。\n\n${journalTemplate}\n本文をaacl_journal_writeへ送る。現在のRunがあればrun.startで受け取ったcontextHandleを入力へ渡す。終了後のRunを明示する場合はpostRunIdを使う。Run外ではTaskを必ず指定する。本文にCore IDを埋め込まず、Modelは構造化しない。` },
        { key: 'journal-review', name: 'journal-review', description: 'ユーザーが開始したJournal Reviewで、気づきを横断して改善を提案する。', body: 'ユーザーが明示的にレビューを開始した場合に使う。Review用のRunを作成しない。aacl_review_pendingから新しいJournalと保留中の気づきを読み、関連するRun・Snapshot・History・Provenanceを確認する。繰り返す摩擦、再現する価値のある方法、資産やContextを減らす候補を集める。既存資産が担うべき問題は、その資産の修正として具体化する。各提案に変更内容、理由、根拠Journal、影響する資産・紐づけ・Project、レビューしたJournal一覧、処理する気づきを示し、aacl_proposal_saveで保存する。ユーザーの判断をaacl_proposal_decideで記録し、承認後にaacl_proposal_applyを実行する。保留した気づきを処理済みにしない。汎用的な改善はGlobal、Project固有の改善はそのProjectへ適用する。' },
    ];
    const existing = core.store.list('asset').filter(a => !a.deletedAt);
    const changes = definitions.filter(d => !existing.some(a => a.metadata.aaclUtility === d.key)).map(d => ({ type: 'asset.save', asset: assetSchema.parse({ kind: 'skill', name: d.name, description: d.description, body: d.body, useCase: true, metadata: { aaclUtility: d.key } }) }));
    if (!changes.length)
        return { installed: [] };
    return core.applyChanges(changes, { origin: 'cli', reason: 'JournalとJournal Reviewの標準入口を導入', userRequest: 'AACLの初期設定', sources: [], proposedBy: '', decision: '' });
}
