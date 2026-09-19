import { z } from 'zod';
import { normalizeRoot } from './core.js';
import { RuntimeEntries } from './runtime.js';
import { installJournalSkills } from './journal-skills.js';
import { backupData, exportData } from './maintenance.js';
import { assetSchema, bindingSchema, changeSchema, id, journalTemplate, provenanceSchema, revision, scope, text } from './schema.js';
export const bootstrap = `AACLはWorkflow・Skill・Role・Rule・Modelと、明示的なWorkflow実行・Journalによる改善を管理します。
通常の会話にWorkflow選択を催促せず、未選択の資産を適用しません。ユーザーが選択したWorkflowだけをaacl_run_startで開始します。
aacl_project_resolveへ開いているProject rootを渡して完全一致で確認します。未登録の場合はaacl initで登録します。
aacl_usecase_searchでWorkflowと直接起動Skillを探します。Skillの直接利用はaacl_skill_getだけを使い、Runや実行記録を作成しません。
aacl_run_startから返るcontextHandleを、同じAI実行Contextの後続Run操作に必ず渡してください。別の会話のHandleを使わず、ユーザーへHandleの入力を求めません。
ContextのSkill catalogから必要な本文・補助ファイルをaacl_run_skill_getで取得します。意味判断と開発操作はAI・Runtimeが行います。
StageにModelが紐づいている場合、ContextのModel情報とsubagent指示に従ってそのStageを実行します。連続する同じRole・ModelのStageでは同じsubagentを継続します。
Modelには自由な名前の選択肢グループを複数定義できます。WorkflowのStageへModelを紐づけるときは、各選択肢の値をselectedChoicesで指定し、ContextのmodelSelectionsで確認します。
Stageのcompletion_conditionを評価し、完了報告とaacl_run_getのversionを付けて許可された遷移を要求します。retry・returnとRun全体のfailedは別です。
資産管理はまずaacl_asset_list（既定は概要のみ）またはaacl_asset_get_manyで対象を確かめ、Asset ID・scope・完全なAsset内容・理由・userRequestを明示して型付き操作を実行します。既存Asset・紐づけ・Project Commonの更新／解除とChange Set内の各変更には取得時点のexpectedRevisionを必ず付け、Conflictなら最新状態を再取得して変更全体を組み直します。asset.saveは差分更新ではなく全置換なのでbodyやsupportingFilesを省略しません。複数変更はまずaacl_changeset_previewでDry Runし、問題がなければaacl_changeset_applyを実行します。Assetを削除する前にaacl_asset_delete_previewの参照一覧をユーザーへ示し、削除と参照解除の明示承認を得てからaacl_asset_deleteを実行します。方針が曖昧なら具体案を示してユーザーへ確認します。認証情報は保存しません。
書き込みのoperationIdにはUUIDを使用し、同じ操作の再送だけで再利用します。
気づきがあればaacl_journal_templateのMarkdownでaacl_journal_writeへ送ります。Core IDは本文に書かず、contextHandleまたは終了後のpostRunIdを操作入力に指定します。Run外のJournalにはTaskを指定します。
Journal Reviewはユーザーが明示的に開始します。Review自体のRunを作らず、aacl_review_pendingで要約と関連IDを取得し、必要な対象だけaacl_review_item_get・aacl_proposal_getと関連するSnapshot・History・Provenanceを参照します。提案を伴わない判断はaacl_review_decideまたはaacl_review_decide_bulkで直接記録します。
提案には対象変更・理由・根拠Journal・レビューしたJournal一覧・処理する気づきを明示します。aacl_proposal_decideでユーザー判断を記録し、承認後aacl_proposal_applyを実行します。保留の気づきは残します。`;
export class Operations {
    core;
    runtime;
    entries = new Map();
    constructor(core) {
        this.core = core;
        this.runtime = new RuntimeEntries(core);
        const store = core.store;
        const read = (name, description, shape, fn) => this.register(name, description, z.object(shape).strict(), fn);
        const write = (name, description, shape, fn, sync = false) => this.register(name, description, z.object(shape).strict(), fn, true, sync);
        const provenance = provenanceSchema;
        const handle = { contextHandle: id };
        const evidence = z.array(z.object({ type: text, reference: text }).strict()).default([]);
        const assetListFields = z.array(z.enum(['body', 'supportingFiles'])).default([]);
        const assetView = (asset, includeBody, fields) => {
            const result = { ...asset };
            if (!includeBody && !fields.includes('body'))
                delete result.body;
            if (!includeBody && !fields.includes('supportingFiles'))
                delete result.supportingFiles;
            return result;
        };
        read('bootstrap.get', 'AACLの利用案内とRuntimeに応じた入口を取得', { runtime: z.enum(['claude', 'codex']).optional() }, p => ({ instructions: bootstrap, runtime: p.runtime, entry: p.runtime === 'claude' ? 'Command' : 'Skill' }));
        read('asset.list', 'Assetを概要（本文・補助ファイルなし）で検索。本文が必要ならincludeBodyまたはfieldsを指定する。例: { kind: "skill", query: "review" }', { scope: scope.optional(), kind: z.enum(['workflow', 'skill', 'role', 'rule', 'model']).optional(), query: z.string().default(''), includeDeleted: z.boolean().default(false), includeBody: z.boolean().default(false), fields: assetListFields }, p => ({ assets: store.list('asset', p.scope).filter(a => (p.includeDeleted || !a.deletedAt) && (!p.kind || a.kind === p.kind) && `${a.name} ${a.description} ${a.kind === 'skill' ? a.explanation : ''} ${a.kind === 'model' ? `${a.modelName} ${a.invocationMethod}` : ''}`.toLowerCase().includes(p.query.toLowerCase())).map(a => assetView(a, p.includeBody, p.fields)) }));
        write('setup.skills', 'Journal・Journal Reviewの標準Skillを導入。導入済みの編集内容を保持', {}, () => installJournalSkills(core), true);
        read('asset.get', 'Assetの現在または過去revisionを取得', { assetId: id, revision: z.int().positive().optional() }, p => { const current = core.asset(p.assetId, true); return { asset: p.revision ? store.revision(p.assetId, p.revision) : current }; });
        read('asset.get_many', '複数AssetをID順で取得。本文も返す。例: { assetIds: ["uuid", "uuid"] }', { assetIds: z.array(id).min(1).max(100), includeDeleted: z.boolean().default(false) }, p => ({ assets: p.assetIds.map(assetId => core.asset(assetId, p.includeDeleted)) }));
        write('asset.save', 'Assetを完全な内容で作成・更新する。既存Assetの更新は取得時点のexpectedRevisionを指定する。例: { id: "uuid", expectedRevision: 3, asset: { ... } }', { id: id.optional(), expectedRevision: revision.optional(), asset: assetSchema, provenance }, p => core.applyChanges([{ type: 'asset.save', id: p.id, expectedRevision: p.expectedRevision, asset: p.asset }], p.provenance), true);
        read('asset.delete.preview', '削除対象Assetを参照する紐づけとProject Commonを確認', { assetId: id }, p => core.assetDeletionPreview(p.assetId));
        write('asset.delete', '影響一覧を確認したユーザーの明示承認後にAssetと参照を削除状態へ変更', { assetId: id, expectedRevision: z.int().positive(), expectedBindingRevisions: z.array(z.object({ id, revision: z.int().positive() }).strict()), expectedProjectCommonRevisions: z.array(z.object({ id, revision: z.int().positive() }).strict()), confirmed: z.literal(true), provenance }, p => core.deleteAsset(p, p.provenance), true);
        write('asset.restore', '過去revisionを新revisionとして復元。現在revisionが変わっていないことをexpectedRevisionで確認する', { assetId: id, revision, expectedRevision: revision }, p => core.restoreAsset(p.assetId, p.revision, p.expectedRevision), true);
        read('usecase.search', 'WorkflowとuseCaseが有効なSkillを検索', { scope: scope.default('global'), query: z.string().default('') }, p => ({ assets: store.list('asset').filter(a => !a.deletedAt && (a.scope === 'global' || a.scope === p.scope) && (a.kind === 'workflow' || a.kind === 'skill' && a.useCase) && `${a.name} ${a.description} ${a.kind === 'skill' ? a.explanation : ''}`.toLowerCase().includes(p.query.toLowerCase())) }));
        read('skill.get', '指定Skillの本文のみを取得。Runを作成しない', { assetId: id }, p => core.skillGet(p.assetId));
        write('skill.usecase', 'Skillの直接起動を切り替えRuntime入口を同期', { assetId: id, enabled: z.boolean(), provenance }, p => {
            const a = core.asset(p.assetId);
            if (a.kind !== 'skill')
                throw new Error('Skillを指定してください。');
            return core.applyChanges([{ type: 'asset.save', id: a.id, expectedRevision: a.revision, asset: { ...core.assetPayload(a), useCase: p.enabled } }], p.provenance);
        }, true);
        read('project.list', '登録済みProjectを取得', {}, () => ({ projects: store.list('project') }));
        read('project.resolve', '正規化したrootの完全一致でProjectを確認', { root: text }, p => ({ root: normalizeRoot(p.root), project: store.list('project').find(v => v.root === normalizeRoot(p.root)) ?? null }));
        write('project.init', 'Project登録とGlobal紐づけコピーを一括実行', { root: text, name: text }, p => {
            const result = core.initProject(p.root, p.name);
            this.runtime.registerProject(result.project.id, result.project.root);
            return result;
        }, true);
        read('common.get', 'Project CommonのRule参照を取得', { projectId: id }, p => ({ common: core.common(p.projectId) }));
        write('common.save', 'Project CommonのRule参照を更新する。取得時点のexpectedRevisionを指定する', { projectId: id, expectedRevision: revision, ruleIds: z.array(id), provenance }, p => core.applyChanges([{ type: 'common.save', projectId: p.projectId, expectedRevision: p.expectedRevision, ruleIds: p.ruleIds }], p.provenance));
        read('binding.list', '管理先ごとの紐づけを一覧', { scope: scope.optional(), assetId: id.optional() }, p => ({ bindings: core.bindings(p.scope).filter(b => !p.assetId || b.sourceId === p.assetId || b.targetId === p.assetId) }));
        read('binding.get', '紐づけの現在または過去revisionを取得', { bindingId: id, revision: z.int().positive().optional() }, p => { const binding = store.get(p.bindingId, 'binding'); return { binding: p.revision ? store.revision(p.bindingId, p.revision) : binding }; });
        write('binding.save', '明示参照を追加・付け替え。既存紐づけの更新は取得時点のexpectedRevisionを指定する', { id: id.optional(), expectedRevision: revision.optional(), binding: bindingSchema, provenance }, p => core.applyChanges([{ type: 'binding.save', id: p.id, expectedRevision: p.expectedRevision, binding: p.binding }], p.provenance));
        write('binding.remove', '紐づけを解除する。取得時点のexpectedRevisionを指定する', { id, expectedRevision: revision, provenance }, p => core.applyChanges([{ type: 'binding.remove', id: p.id, expectedRevision: p.expectedRevision }], p.provenance));
        write('run.start', '明示選択したWorkflowのRunを開始しContext Handleを返す', { workflowId: id, projectId: id.optional(), root: text.optional(), runtime: text, instruction: text, target: z.string().default('') }, p => core.startRun(p));
        read('run.list', 'Workflow Runを一覧', { projectId: id.optional() }, p => { core.expireRuns(); return { runs: store.list('run', p.projectId) }; });
        read('run.get', 'Handleに対応するRunと許可遷移を取得', handle, p => {
            const run = core.run(p.contextHandle), snapshot = store.get(run.snapshotId, 'snapshot');
            return { run, transitions: run.status === 'active' ? snapshot.workflow.transitions.filter(t => t.from === run.stageId) : [] };
        });
        read('run.inspect', 'RunのSnapshot・提供記録・進行履歴・Journalを参照', handle, p => {
            const run = core.run(p.contextHandle), detail = core.runDetail(run);
            core.deliver(run, 'snapshot-inspection', detail.snapshot, true, [run.snapshotId]);
            return detail;
        });
        read('context.get', '固定revisionで現在StageのContextを提供', { ...handle, model: z.string().optional() }, p => core.context(p.contextHandle, undefined, p.model));
        read('context.handoff', '明示されたRoleへの引き渡しContextを構成', { ...handle, roleId: id, model: z.string().optional() }, p => core.context(p.contextHandle, p.roleId, p.model));
        read('run.skill.get', 'Runの固定revisionからSkill本文・補助ファイルを取得', { ...handle, assetId: id, file: text.optional() }, p => core.runSkillGet(p.contextHandle, p.assetId, p.file));
        write('run.transition', '完了報告を付けて許可されたStage遷移を選択', { ...handle, version: z.int().positive(), transitionId: text, report: text, evidence, comment: z.string().default('') }, p => core.transition(p));
        write('run.cancel', 'ユーザー意思によるRunの中止', { ...handle, reason: text }, p => core.endRun(p.contextHandle, 'cancelled', p.reason));
        write('run.fail', '継続不能なRunの終了報告', { ...handle, reason: text }, p => core.endRun(p.contextHandle, 'failed', p.reason));
        write('run.report', '実際に使用したAssetと実行結果を報告', { ...handle, body: text, usedAssetIds: z.array(id).default([]), evidence }, p => {
            const run = core.run(p.contextHandle), snapshot = store.get(run.snapshotId, 'snapshot');
            for (const id of p.usedAssetIds)
                if (!snapshot.assets.some(a => a.id === id))
                    throw new Error('Snapshotの関連Assetを指定してください。');
            return { report: core.event(run, 'usage-reported', { body: p.body, usedAssets: p.usedAssetIds.map(id => ({ id, revision: snapshot.assets.find(a => a.id === id).revision })), evidence: p.evidence }) };
        });
        read('journal.template', '固定見出しMarkdownテンプレートを取得', {}, () => ({ template: journalTemplate }));
        read('journal.list', 'Journalを一覧', {}, () => ({ journals: store.list('journal'), insights: store.list('insight') }));
        read('journal.get', 'Journalと関連する気づきを取得', { journalId: id }, p => ({ journal: store.get(p.journalId, 'journal'), insights: store.list('insight').filter(i => i.journalId === p.journalId) }));
        write('journal.write', 'Markdown原文を保持しRunまたはTaskへ関連づけ', { body: z.string().min(1).refine(s => s.trim().length > 0), contextHandle: id.optional(), postRunId: id.optional(), task: text.optional() }, p => core.writeJournal(p));
        read('review.pending', 'Review項目を関連ID中心で取得。必要に応じて本文・変更内容を含める', {
            status: z.enum(['pending', 'processed', 'rejected']).default('pending'), projectId: id.optional(),
            include: z.array(z.enum(['journalTask', 'insights', 'proposalRefs'])).default(['journalTask', 'insights', 'proposalRefs']),
            includeBodies: z.boolean().default(false), includeChanges: z.boolean().default(false), limit: z.int().positive().max(100).default(100), cursor: z.string().nullable().optional(),
        }, p => core.review(p));
        read('review.item.get', 'Review項目と直接紐づくJournal task・Insight・提案を取得', { reviewItemId: id, includeChanges: z.boolean().default(false) }, p => core.reviewItemGet(p.reviewItemId, p.includeChanges));
        write('review.decide', 'Review項目、Insight、直接紐づくJournal taskを同時に判断', { reviewItemId: id, decision: z.enum(['approved', 'deferred', 'rejected']), note: z.string().default('') }, p => core.decideReview(p));
        write('review.decide.bulk', '複数のReview項目を一つの判断として一括更新', { updates: z.array(z.object({ reviewItemId: id, decision: z.enum(['approved', 'deferred', 'rejected']), note: z.string().default('') }).strict()).min(1).max(100) }, p => core.decideReviewBulk(p.updates));
        write('insight.status', '気づき単位の保留・処理済み・却下を指定', { insightId: id, status: z.enum(['pending', 'processed', 'rejected']) }, p => core.updateInsightStatus(p.insightId, p.status));
        read('proposal.list', '改善提案・ユーザー判断・適用結果を一覧', { includeChanges: z.boolean().default(false) }, p => ({ proposals: store.list('proposal').map(proposal => {
                if (p.includeChanges)
                    return proposal;
                const { changes: _changes, ...summary } = proposal;
                return summary;
            }), decisions: store.list('decision'), changeSets: store.list('changeset').filter(c => c.proposalId) }));
        read('proposal.get', '改善提案を関連判断・適用結果とともに取得', { proposalId: id, includeChanges: z.boolean().default(false) }, p => core.proposalGet(p.proposalId, p.includeChanges));
        write('proposal.save', '具体的な変更と根拠を含む改善提案を保存', {
            id: id.optional(), title: text, observedContext: text, proposedChange: text, reason: text,
            evidenceJournalIds: z.array(id).min(1), reviewedJournalIds: z.array(id).min(1), affectedAssetIds: z.array(id), affectedBindingIds: z.array(id), affectedProjectIds: z.array(id), changes: z.array(changeSchema).min(1), insightIds: z.array(id),
        }, p => { const { id, ...proposal } = p; return core.saveProposal(proposal, id); });
        write('proposal.decide', '提案へのユーザー判断と対象Review項目の状態を同時に記録', { proposalId: id, choice: z.enum(['approved', 'deferred', 'rejected']), note: text }, p => core.decideProposal(p.proposalId, p.choice, p.note));
        write('proposal.apply', '承認済み変更の適用と対象の気づき処理を一括実行', { proposalId: id }, p => core.applyProposal(p.proposalId), true);
        read('changeset.preview', 'Change Setを保存せず検証するDry Run。各更新・解除にはexpectedRevisionを含め、valid=falseなら全体を適用しない', { changes: z.array(changeSchema).min(1), provenance: provenance.optional() }, p => core.previewChanges(p.changes, p.provenance ?? { origin: 'ui', reason: 'Change SetのDry Run', userRequest: '', sources: [], proposedBy: '', decision: '' }));
        write('changeset.apply', 'expectedRevision付きの具体的なasset.save / asset.create / binding.save / binding.remove / common.saveを一括適用する。1件でもConflictなら全体を適用しない', { changes: z.array(changeSchema).min(1), provenance }, p => core.applyChanges(p.changes, p.provenance), true);
        write('changeset.restore', 'Change Set適用前の内容を新revisionとして復元する。適用後revisionから変更されていればConflictとして中止する', { changeSetId: id }, p => core.restoreChangeSet(p.changeSetId), true);
        read('history.get', '変更履歴・revision・由来・Change Setを確認', { entityId: id.optional() }, p => ({ histories: store.list('history').filter(h => !p.entityId || h.entityId === p.entityId), revisions: p.entityId ? store.revisions(p.entityId) : [], changeSets: store.list('changeset'), provenance: store.list('provenance') }));
        read('diagnostics.get', '参照・状態・反復遷移と実提供量を診断', {}, () => core.diagnostics());
        read('costs.get', '実際のContext提供量をRun・Stage・Role・対象別に比較', {}, () => ({ costs: core.costs() }));
        read('runtime.list', 'Runtime設定先と入口の状態を確認', {}, () => ({ targets: store.list('runtime-target'), entries: store.list('runtime-entry') }));
        read('runtime.discover', 'Windows・WSLの標準設定先を列挙', {}, () => ({ candidates: this.runtime.discover() }));
        write('runtime.register', 'Runtime設定先を登録して入口を生成', { runtime: z.enum(['claude', 'codex']), scope, path: text, platform: z.enum(['wsl', 'windows']) }, p => ({ target: this.runtime.register(p) }), true);
        write('runtime.unregister', '設定先の管理を解除。生成済み入口は残す', { targetId: id }, p => ({ target: store.put('runtime-target', { ...store.get(p.targetId, 'runtime-target'), enabled: false }) }));
        write('runtime.sync', '生成入口をCanonical Stateへ同期', {}, () => ({}), true);
        read('settings.get', 'Global設定を取得', {}, () => core.settings());
        write('settings.save', '非活動timeout時間を設定', { timeoutHours: z.number().positive().max(8760) }, p => store.put('settings', { id: 'settings', ...p }));
        read('data.export', '明示された新規directoryへ人間可読データを出力', { directory: text }, p => exportData(core, p.directory));
        read('data.backup', 'SQLite整合性を保つBackupを新規fileへ出力', { path: text }, p => backupData(core, p.path));
    }
    register(name, description, schema, handler, write = false, sync = false) {
        const inputSchema = write ? schema.extend({ operationId: id }) : schema;
        this.entries.set(name, { description, schema: inputSchema, write, execute: async (raw) => {
                const parsed = inputSchema.parse(raw);
                const { operationId, ...fields } = parsed;
                let result;
                if (write) {
                    const saved = this.core.store.write(operationId, name, fields, () => handler(fields));
                    result = { ...saved.result, duplicate: saved.duplicate };
                    if (saved.duplicate && name.startsWith('run.')) {
                        const run = this.core.run(fields.contextHandle || saved.result.contextHandle);
                        this.core.event(run, 'duplicate', { operationId, operation: name });
                    }
                }
                else
                    result = handler(parsed);
                result = await result;
                return sync ? { ...result, runtimeSync: this.runtime.sync() } : result;
            } });
    }
    async execute(name, input) {
        const operation = this.entries.get(name);
        if (!operation)
            throw new Error(`操作が見つかりません: ${name}`);
        return operation.execute(input);
    }
}
