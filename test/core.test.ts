import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { Core, normalizeRoot } from '../src/core.ts';
import { Operations } from '../src/operations.ts';
import { assetSchema, parseJournal } from '../src/schema.ts';
import { backupData, exportData, restoreBackup } from '../src/maintenance.ts';
import { relatedWorkflows, workflowDiagram } from '../web/view-model.ts';
import type { Asset, Binding, ChangeSet, Context, Delivery, Insight, Journal, Project, Run, RuntimeTarget, Snapshot } from '../src/schema.ts';

const provenance = { origin: 'ai', userRequest: 'テスト用の明示依頼', reason: '挙動の確認' };
function fixture(t: { after: (fn: () => void) => void }) {
  const store = new Store(':memory:'), core = new Core(store), ops = new Operations(core);
  t.after(() => store.close());
  const call = <T>(name: string, input: object = {}, operationId = randomUUID()) => ops.execute(name, { ...input, ...(ops.entries.get(name)!.write ? { operationId } : {}) }) as Promise<T>;
  const asset = async (kind: Asset['kind'], overrides: object = {}) => (await call<{ entities: Asset[] }>('asset.save', { asset: { kind, name: kind, description: '説明', body: '本文', ...overrides }, provenance })).entities[0];
  const workflow = () => asset('workflow', { name: 'テストWorkflow', entryStage: 'build', stages: [{ id: 'build', name: '実装', completion_condition: '実装を確認' }, { id: 'review', name: '確認', completion_condition: '確認結果を報告' }], transitions: [{ id: 'next', from: 'build', to: 'review', type: 'next', label: '確認へ' }, { id: 'retry', from: 'build', to: 'build', type: 'retry', label: '再試行' }, { id: 'return', from: 'review', to: 'build', type: 'return', label: '差し戻し' }, { id: 'done', from: 'review', to: 'completed', type: 'complete', label: '完了' }] });
  const bind = async (source: Asset, target: Asset, overrides: object = {}) => (await call<{ entities: Binding[] }>('binding.save', { binding: { sourceId: source.id, targetId: target.id, ...overrides }, provenance })).entities[0];
  const start = (w: Asset, overrides: object = {}) => call<{ run: Run; contextHandle: string; context: Context; snapshotId: string }>('run.start', { workflowId: w.id, runtime: 'codex', instruction: '明示した作業', ...overrides });
  return { store, core, ops, call, asset, workflow, bind, start };
}

test('C02 C04 C13 C14 C15 C28 C29: schema / stable identity / idempotent writes / provenance / restoration', async t => {
  const f = fixture(t), a = await f.asset('skill');
  const operationId = randomUUID(), input = { id: a.id, revision: 0, asset: { ...f.core.assetPayload(a), name: '改名', body: '更新' }, provenance };
  const first = await f.call<{ entities: Asset[] }>('asset.save', input, operationId);
  const retry = await f.call<{ duplicate: boolean; entities: Asset[] }>('asset.save', input, operationId);
  assert.equal(first.entities[0].id, a.id); assert.equal(retry.duplicate, true); assert.equal(f.core.asset(a.id).revision, 2);
  await assert.rejects(f.call('asset.save', { ...input, asset: { ...input.asset, body: '別操作' } }, operationId), /operation ID/);
  assert.equal(f.store.revision<Asset>(a.id, 1).body, '本文');
  await f.call('asset.restore', { assetId: a.id, revision: 1 });
  assert.equal(f.core.asset(a.id).revision, 3); assert.equal(f.core.asset(a.id).body, '本文');
  await assert.rejects(f.asset('skill', { body: '' }));
  await assert.rejects(f.asset('skill', { metadata: { model: 'test' } }));
  await assert.rejects(f.asset('skill', { capability: ['shell'] }));
  await assert.rejects(f.call('asset.save', { asset: f.core.assetPayload(a), provenance: { origin: 'ai' } }));
  const history = await f.call<{ provenance: { userRequest: string; reason: string }[] }>('history.get', { entityId: a.id });
  assert.ok(history.provenance.some(p => p.userRequest === provenance.userRequest && p.reason === provenance.reason));
  assert.throws(() => f.store.db.exec("UPDATE revisions SET data='{}'"), /immutable/);
});

test('C05 C06 C07: exact Project identity and independent copied bindings / common', async t => {
  const f = fixture(t), w = await f.workflow(), s = await f.asset('skill'), rule = await f.asset('rule');
  const globalBinding = await f.bind(w, s);
  assert.equal(normalizeRoot('C:\\work\\x\\..\\app\\'), '/mnt/c/work/app');
  assert.equal(normalizeRoot('\\\\wsl.localhost\\Ubuntu\\home\\me\\app'), '/home/me/app');
  assert.throws(() => normalizeRoot('relative/path'));
  const root = mkdtempSync(join(tmpdir(), 'aacl-project-'));
  const { project } = await f.call<{ project: Project }>('project.init', { root, name: 'Project' });
  assert.equal(f.core.common(project.id).ruleIds.length, 0);
  const copy = f.core.bindings(project.id)[0];
  assert.equal(copy.targetId, s.id); assert.notEqual(copy.id, globalBinding.id);
  assert.equal(f.store.list('asset').length, 3);
  await f.call('binding.remove', { id: globalBinding.id, provenance });
  assert.equal(f.core.bindings(project.id).length, 1);
  assert.equal((await f.call<{ project: Project | null }>('project.resolve', { root: `${root}/child` })).project, null);
  assert.equal((await f.call<{ project: Project | null }>('project.resolve', { root: `${root}/../${root.split('/').at(-1)}` })).project?.id, project.id);
  await f.call('common.save', { projectId: project.id, ruleIds: [rule.id], provenance });
  const r = await f.start(w, { projectId: project.id });
  assert.equal(r.context.rules[0].id, rule.id);
  const count = f.store.list('project').length;
  await assert.rejects(f.call('project.init', { root, name: '重複' }));
  assert.equal(f.store.list('project').length, count);
  assert.ok(existsSync(join(root, '.claude/commands', `aacl-${w.id}.md`)));
  assert.ok(existsSync(join(root, '.codex/skills', `aacl-${w.id}`, 'SKILL.md')));
});

test('C03 C08 C10 C16 C34: direct Skill retrieval never creates a managed execution', async t => {
  const f = fixture(t), s = await f.asset('skill', { useCase: true }), w = await f.workflow();
  const before = f.store.boundary();
  const result = await f.call<{ body: string }>('skill.get', { assetId: s.id });
  assert.equal(result.body, '本文'); assert.equal(f.store.boundary(), before);
  for (const kind of ['run', 'snapshot', 'journal', 'delivery', 'event']) assert.equal(f.store.list(kind).length, 0);
  await assert.rejects(f.start(s), /Workflow/);
  assert.equal((await f.call<{ assets: Asset[] }>('usecase.search')).assets.length, 2);
  await f.call('skill.usecase', { assetId: s.id, enabled: false, provenance });
  assert.deepEqual((await f.call<{ assets: Asset[] }>('usecase.search')).assets.map(a => a.id), [w.id]);
});

test('C09 C11 C12 C17 C20 C21 C22 C23 C24 C31: immutable resolution, progressive delivery, concurrent Handles', async t => {
  const f = fixture(t), w = await f.workflow(), role = await f.asset('role', { responsibilities: '責務' }), a = await f.asset('skill', { body: '未取得本文'.repeat(100), supportingFiles: { 'guide.md': '元ファイル' } }), b = await f.asset('skill', { name: 'B' }), rule = await f.asset('rule');
  await f.bind(w, role, { purpose: 'entry-role' }); await f.bind(role, a); await f.bind(a, b); await f.bind(role, rule);
  const one = await f.start(w), two = await f.start(w, { runtime: 'claude' });
  assert.notEqual(one.contextHandle, two.contextHandle);
  assert.equal(one.context.roles[0].responsibilities, '責務');
  assert.deepEqual(new Set(one.context.skillCatalog.map(a => a.id)), new Set([a.id, b.id]));
  assert.ok(!JSON.stringify(one).includes('未取得本文'));
  const snapshot = f.store.get<Snapshot>(one.snapshotId, 'snapshot'), sealed = JSON.stringify(snapshot);
  const cost = f.core.costs().filter(c => c.runId === one.run.id).reduce((sum, c) => sum + c.bytes, 0);
  assert.equal(cost, Buffer.byteLength(JSON.stringify(one.context)));
  await f.call('asset.save', { id: a.id, asset: { ...f.core.assetPayload(a), body: '新本文', supportingFiles: { 'guide.md': '新ファイル' } }, provenance });
  await f.call('binding.remove', { id: f.core.bindings().find(b => b.sourceId === role.id && b.targetId === a.id)!.id, provenance });
  assert.equal((await f.call<{ body: string }>('run.skill.get', { contextHandle: one.contextHandle, assetId: a.id })).body, a.body);
  assert.equal((await f.call<{ body: string }>('run.skill.get', { contextHandle: two.contextHandle, assetId: a.id, file: 'guide.md' })).body, '元ファイル');
  const missing = await f.call<{ available: boolean; reason: string }>('run.skill.get', { contextHandle: one.contextHandle, assetId: a.id, file: 'missing.md' });
  assert.equal(missing.available, false); assert.ok(missing.reason);
  assert.equal(JSON.stringify(f.store.get(one.snapshotId)), sealed);
  assert.throws(() => f.store.put('snapshot', snapshot), /immutable/);
  const handoff = await f.call<Context & { model: string }>('context.handoff', { contextHandle: one.contextHandle, roleId: role.id, model: 'unknown/free-name' });
  assert.equal(handoff.model, 'unknown/free-name'); assert.equal(handoff.runId, one.run.id);
  assert.ok(!JSON.stringify(f.store.list('delivery')).includes('unknown/free-name'));
  assert.equal((await f.start(w)).context.skillCatalog.length, 0);
  assert.equal(f.store.list('event').filter((e: unknown) => (e as { type: string }).type === 'usage-reported').length, 0);
  await f.call('run.report', { contextHandle: one.contextHandle, body: 'Skillを使った', usedAssetIds: [a.id] });
  assert.equal(f.store.list('event').filter((e: unknown) => (e as { type: string }).type === 'usage-reported').length, 1);
  await assert.rejects(f.bind(b, a), /循環/);
  const other = await f.asset('skill', { name: a.name });
  assert.equal((await f.call<{ available: boolean }>('run.skill.get', { contextHandle: one.contextHandle, assetId: other.id })).available, false);
});

test('C18 C19 C30: transitions are structural, idempotent, stale-safe; timeout includes reads', async t => {
  const f = fixture(t), w = await f.workflow(), r = await f.start(w);
  const input = { contextHandle: r.contextHandle, version: 1, transitionId: 'retry', report: '自由な意味判断' }, operationId = randomUUID();
  assert.equal((await f.call<{ outcome: string }>('run.transition', input, operationId)).outcome, 'applied');
  assert.equal((await f.call<{ duplicate: boolean }>('run.transition', input, operationId)).duplicate, true);
  assert.equal((await f.call<{ outcome: string }>('run.transition', { ...input, transitionId: 'next' })).outcome, 'stale');
  assert.equal(f.core.run(r.contextHandle).version, 2);
  await assert.rejects(f.call('run.transition', { ...input, version: 2, transitionId: 'done' }), /許可/);
  await assert.rejects(f.call('run.transition', { ...input, version: 2, report: '' }));
  for (let version = 2; version < 4; version++) await f.call('run.transition', { ...input, version });
  assert.ok(f.core.diagnostics().diagnostics.some(d => d.code === 'repeated-transition'));
  await f.call('run.transition', { ...input, version: 4, transitionId: 'next' });
  const done = await f.call<{ run: Run }>('run.transition', { ...input, version: 5, transitionId: 'done' });
  assert.equal(done.run.status, 'completed');
  const second = await f.start(w);
  const run = f.core.run(second.contextHandle);
  f.store.put('run', { ...run, lastActivity: new Date(Date.now() - 10000).toISOString() });
  await f.call('run.get', { contextHandle: second.contextHandle });
  assert.ok(Date.now() - Date.parse(f.core.run(second.contextHandle, false).lastActivity) < 1000);
  f.core.expireRuns(Date.now() + 25 * 3600000);
  assert.equal(f.core.run(second.contextHandle).status, 'failed');
  assert.equal(f.core.run(r.contextHandle).status, 'completed');
  const cancelled = await f.start(w);
  await f.call('run.cancel', { contextHandle: cancelled.contextHandle, reason: '利用者が中止' });
  assert.equal(f.core.run(cancelled.contextHandle).status, 'cancelled');
  const failed = await f.start(w);
  await f.call('run.fail', { contextHandle: failed.contextHandle, reason: '継続不能' });
  assert.equal(f.core.run(failed.contextHandle).status, 'failed');
  await assert.rejects(f.call('asset.get', { assetId: failed.run.id, revision: 1 }), /対象が見つかりません/);
  assert.throws(() => assetSchema.parse({ kind: 'workflow', name: 'x', description: 'x', stages: [{ id: 'x', name: 'x', completion_condition: '' }], entryStage: 'x' }));
});

test('C25: Markdown raw, duplicate headings, unknown fragments, fences, independent insights', async t => {
  const f = fixture(t);
  const raw = '  原文\r\n## Task\r\nタスク\r\n## 良かった点\r\n一つ目\r\n\r\n二つ目\r\n## 良かった点\r\n三つ目\r\n## 未知\r\n分類しない\r\n```md\r\n## 困った点\r\nコードの中\r\n```\r\n';
  const parsed = parseJournal(raw);
  assert.equal(parsed.raw, raw); assert.match(parsed.sections['良かった点'], /一つ目[\s\S]*三つ目/);
  assert.equal(parsed.sections['困った点'], undefined); assert.equal(parsed.insights.length, 3);
  assert.ok(parsed.fragments.some(f => f.heading === '未知' && f.body.includes('コードの中')));
  const result = await f.call<{ journal: Journal; insights: Insight[] }>('journal.write', { body: raw });
  assert.equal(result.journal.raw, raw); assert.equal(result.journal.task, 'タスク');
  await f.call('insight.status', { insightId: result.insights[0].id, status: 'processed' });
  assert.equal((await f.call<{ insights: Insight[] }>('review.pending')).insights.length, 2);
  await assert.rejects(f.call('journal.write', { body: '関連づけなし' }), /Task/);
});

test('C01 C26 C27 C28 C35: review approval applies changes and selected insights atomically; next Run adopts revision', async t => {
  const f = fixture(t), w = await f.workflow(), skill = await f.asset('skill');
  await f.bind(w, skill);
  const r = await f.start(w);
  const journal = await f.call<{ journal: Journal; insights: Insight[] }>('journal.write', { contextHandle: r.contextHandle, body: '## 困った点\n改善する部分\n\n保留する部分' });
  assert.equal(journal.journal.snapshotId, r.snapshotId); assert.equal(journal.journal.assetRevisions?.find(a => a.id === skill.id)?.revision, 1);
  const proposal = await f.call<{ proposal: { id: string } }>('proposal.save', { title: '改善', observedContext: '実際の観測', proposedChange: '本文を更新', reason: '気づきに対応', evidenceJournalIds: [journal.journal.id], reviewedJournalIds: [journal.journal.id], affectedAssetIds: [skill.id], affectedBindingIds: [], affectedProjectIds: [], changes: [{ type: 'asset.save', id: skill.id, asset: { ...f.core.assetPayload(skill), body: '改善後' } }], insightIds: [journal.insights[0].id] });
  await assert.rejects(f.call('proposal.apply', { proposalId: proposal.proposal.id }), /承認/);
  await f.call('proposal.decide', { proposalId: proposal.proposal.id, choice: 'approved', note: '変更を承認' });
  assert.equal(f.core.asset(skill.id).revision, 1);
  assert.equal(f.store.get<Insight>(journal.insights[0].id).status, 'pending');
  const operationId = randomUUID();
  await f.call('proposal.apply', { proposalId: proposal.proposal.id }, operationId);
  assert.equal((await f.call<{ duplicate: boolean }>('proposal.apply', { proposalId: proposal.proposal.id }, operationId)).duplicate, true);
  assert.equal(f.core.asset(skill.id).revision, 2);
  const pending = await f.call<{ insights: Insight[]; journals: Journal[] }>('review.pending');
  assert.deepEqual(pending.insights.map(i => i.id), [journal.insights[1].id]); assert.equal(pending.journals.length, 1);
  assert.equal(f.store.list('run').length, 1);
  assert.equal((await f.call<{ body: string }>('run.skill.get', { contextHandle: r.contextHandle, assetId: skill.id })).body, '本文');
  const next = await f.start(w);
  assert.equal((await f.call<{ body: string }>('run.skill.get', { contextHandle: next.contextHandle, assetId: skill.id })).body, '改善後');
  const before = f.core.asset(skill.id).revision;
  await assert.rejects(f.call('changeset.apply', { changes: [{ type: 'asset.save', id: skill.id, asset: { ...f.core.assetPayload(skill), body: '失敗で戻る' } }, { type: 'binding.save', binding: { sourceId: skill.id, targetId: randomUUID() } }], provenance }));
  assert.equal(f.core.asset(skill.id).revision, before);
});

test('C16 C33: Runtime entries are thin, owned, updated and retained on unregistration', async t => {
  const f = fixture(t), skill = await f.asset('skill', { useCase: true, body: 'CANONICAL_ONLY_CONTENT_928' });
  const root = mkdtempSync(join(tmpdir(), 'aacl-runtime-'));
  const { target } = await f.call<{ target: RuntimeTarget }>('runtime.register', { runtime: 'codex', platform: 'wsl', scope: 'global', path: root });
  const path = join(root, 'skills', `aacl-${skill.id}`, 'SKILL.md');
  const content = readFileSync(path, 'utf8');
  assert.match(content, new RegExp(skill.id)); assert.ok(!content.includes(skill.body)); assert.ok(!content.includes('aacl_run_start'));
  await f.call('asset.save', { id: skill.id, asset: { ...f.core.assetPayload(skill), name: '新しい名前' }, provenance });
  assert.match(readFileSync(path, 'utf8'), /新しい名前/);
  await f.call('skill.usecase', { assetId: skill.id, enabled: false, provenance }); assert.equal(existsSync(path), false);
  await f.call('skill.usecase', { assetId: skill.id, enabled: true, provenance }); assert.equal(existsSync(path), true);
  await f.call('runtime.unregister', { targetId: target.id }); assert.equal(existsSync(path), true);
  await f.call('skill.usecase', { assetId: skill.id, enabled: false, provenance }); assert.equal(existsSync(path), true);
  const collision = join(root, 'other'); mkdirSync(join(collision, 'commands'), { recursive: true });
  const w = await f.workflow(), blocked = join(collision, 'commands', `aacl-${w.id}.md`);
  writeFileSync(blocked, '利用者のファイル');
  const result = await f.call<{ runtimeSync: { ok: boolean }[] }>('runtime.register', { runtime: 'claude', platform: 'wsl', scope: 'global', path: collision });
  assert.ok(result.runtimeSync.some(r => !r.ok)); assert.equal(readFileSync(blocked, 'utf8'), '利用者のファイル');
  const linkRoot = join(root, 'link'); symlinkSync(collision, linkRoot);
  await f.call('runtime.register', { runtime: 'claude', platform: 'wsl', scope: 'global', path: linkRoot });
  assert.ok(f.core.diagnostics().diagnostics.some(d => d.code === 'runtime-entry'));
  writeFileSync(blocked, f.ops.runtime.body(w, 'claude'));
  await f.call('runtime.sync');
  assert.ok(!f.core.diagnostics().diagnostics.some(d => d.target === f.store.list<RuntimeTarget>('runtime-target').find(t => t.path === collision)!.id));
});

test('C29 C33: Change Set restoration / persistent SQLite / export / consistent Backup restore', async t => {
  const f = fixture(t), skill = await f.asset('skill');
  const edit = await f.call<{ changeSet: ChangeSet }>('asset.save', { id: skill.id, asset: { ...f.core.assetPayload(skill), body: '編集後' }, provenance });
  await f.call('changeset.restore', { changeSetId: edit.changeSet.id }); assert.equal(f.core.asset(skill.id).body, '本文');
  const root = mkdtempSync(join(tmpdir(), 'aacl-backup-')), backupPath = join(root, 'backup.sqlite');
  await backupData(f.core, backupPath); await assert.rejects(backupData(f.core, backupPath));
  exportData(f.core, join(root, 'export'));
  assert.match(readFileSync(join(root, 'export', `asset-${skill.id}.md`), 'utf8'), /^---\n/);
  assert.ok(JSON.parse(readFileSync(join(root, 'export/records.json'), 'utf8')).revisions.length);
  assert.throws(() => exportData(f.core, join(root, 'export')));
  await restoreBackup(backupPath, join(root, 'restored'));
  const restored = new Store(join(root, 'restored/aacl.sqlite'));
  assert.equal(restored.get<Asset>(skill.id).revision, 3); assert.equal(restored.revision<Asset>(skill.id, 2).body, '編集後'); restored.close();
  const opened = new Store(join(root, 'restored/aacl.sqlite')); assert.equal(opened.get<Asset>(skill.id).body, '本文'); opened.close();
});

test('C33: UI relationship projections distinguish direct / Role paths and graph includes return and retry', async t => {
  const f = fixture(t), w = await f.workflow(), role = await f.asset('role'), s = await f.asset('skill');
  await f.bind(w, role, { stageId: 'build', purpose: 'stage-role' }); await f.bind(role, s); await f.bind(w, s, { stageId: 'review' });
  const views = relatedWorkflows(s.id, f.store.list('asset'), f.core.bindings());
  assert.ok(views.some(v => v.stageId === 'build' && v.via[0] === role.name && v.binding.sourceId === role.id));
  assert.ok(views.some(v => v.stageId === 'review' && !v.via.length));
  const graph = workflowDiagram(w);
  assert.equal(graph.edges.length, 4); assert.ok(graph.edges.some(e => e.type === 'retry' && e.from === e.to));
  assert.ok(graph.edges.some(e => e.type === 'return' && e.to === 'build'));
});
