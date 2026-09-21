import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, existsSync, mkdirSync, rmdirSync, unlinkSync, writeFileSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Store } from '../src/store.ts';
import { Core, normalizeRoot } from '../src/core.ts';
import { Operations } from '../src/operations.ts';
import { assetSchema, parseJournal } from '../src/schema.ts';
import { backupData, exportData, restoreBackup } from '../src/maintenance.ts';
import { diagnosticAsset, diagnosticAssetId, relatedWorkflows, stageRoleBindingChanges, workflowDiagram } from '../web/view-model.ts';
import type { Asset, Binding, ChangeSet, Context, Delivery, ExecutionPlan, Insight, Journal, Project, ReviewItem, Run, RuntimeTarget, Snapshot } from '../src/schema.ts';

const provenance = { origin: 'ai', userRequest: 'テスト用の明示依頼', reason: '挙動の確認' };
function fixture(t: { after: (fn: () => void) => void }) {
  const store = new Store(':memory:'), core = new Core(store), ops = new Operations(core);
  t.after(() => store.close());
  const call = <T>(name: string, input: object = {}, operationId = randomUUID()) => ops.execute(name, { ...input, ...(ops.entries.get(name)!.write ? { operationId } : {}) }) as Promise<T>;
  const asset = async (kind: Asset['kind'], overrides: object = {}) => (await call<{ entities: Asset[] }>('asset.save', { asset: { kind, name: kind, description: '説明', body: '本文', ...overrides }, provenance })).entities[0];
  const workflow = async (assignedRole?: Asset) => {
    const workflowId = randomUUID(), roleId = assignedRole?.id ?? randomUUID();
    const stages = [{ id: 'build', name: '実装' }, { id: 'review', name: '確認' }];
    const changes = [
      { type: 'asset.create', id: workflowId, asset: { kind: 'workflow', name: 'テストWorkflow', description: '説明', entryStage: 'build', stages, transitions: [{ id: 'next', from: 'build', to: 'review', condition: '実装とテストが完了した', label: '確認へ' }, { id: 'retry', from: 'build', to: 'build', condition: '実装結果が不十分で再作業が必要', label: '再試行' }, { id: 'return', from: 'review', to: 'build', condition: '修正が必要', label: '差し戻し' }, { id: 'done', from: 'review', to: 'completed', condition: '確認結果を受け入れられる', label: '完了' }] } },
      ...(assignedRole ? [] : [{ type: 'asset.create', id: roleId, asset: { kind: 'role', name: '担当Role', description: '各工程の責務を担う' } }]),
      ...stages.map(stage => ({ type: 'binding.save', binding: { sourceId: workflowId, targetId: roleId, stageId: stage.id, purpose: 'stage-role' } })),
    ];
    await call('changeset.apply', { changes, provenance });
    return core.asset(workflowId);
  };
  const bind = async (source: Asset, target: Asset, overrides: object = {}) => (await call<{ entities: Binding[] }>('binding.save', { binding: { sourceId: source.id, targetId: target.id, ...overrides }, provenance })).entities[0];
  const start = async (w: Asset, overrides: object = {}) => {
    const started = await call<{ run: Run; contextHandle: string; nextExecution: ExecutionPlan; snapshotId: string }>('run.start', { workflowId: w.id, runtime: 'codex', instruction: '明示した作業', ...overrides });
    const context = await call<Context>('context.get', { contextHandle: started.contextHandle });
    return { ...started, context };
  };
  return { store, core, ops, call, asset, workflow, bind, start };
}

test('Skill metadata separates the human explanation from Runtime description and discards old classifications', async t => {
  const f = fixture(t);
  const skill = await f.asset('skill', { name: 'frontmatter-skill', description: '人が読む説明', taskType: 'Runtimeが使う説明', body: '本文' });
  assert.equal(skill.description, 'Runtimeが使う説明');
  assert.equal(skill.explanation, '人が読む説明');
  assert.equal('taskType' in skill, false);

  const role = await f.asset('role', { taskType: 'Roleの旧分類' });
  assert.equal('taskType' in role, false);
  const workflow = await f.workflow();
  assert.equal('taskType' in workflow, false);
  assert.equal('taskType' in workflow.stages[0]!, false);
  await f.bind(workflow, skill);
  const run = await f.start(workflow);
  assert.deepEqual(run.context.skillCatalog, [{ id: skill.id, name: skill.name, description: skill.description }]);
  assert.equal('revision' in run.context.skillCatalog[0]!, false);
  assert.equal('taskType' in run.run, false);
});

test('Diagnostic evidence resolves the concrete Asset from its assetId', async t => {
  const f = fixture(t);
  const skill = await f.asset('skill', { name: '具体的な診断対象' });
  assert.equal(diagnosticAssetId({ assetId: skill.id }), skill.id);
  assert.equal(diagnosticAsset({ assetId: skill.id }, [skill]), skill);
  assert.equal(diagnosticAssetId({ target: skill.id }), undefined);
  assert.equal(diagnosticAsset({ assetId: randomUUID() }, [skill]), undefined);
});

test('Journal Skills are protected, journal is not a direct entry, and recording can be disabled', async t => {
  const f = fixture(t);
  await f.call('setup.skills');
  const assets = (await f.call<{ assets: Asset[] }>('asset.list', { kind: 'skill', includeBody: true })).assets;
  const journal = assets.find(asset => asset.metadata.aaclUtility === 'journal')!;
  const review = assets.find(asset => asset.metadata.aaclUtility === 'journal-review')!;
  assert.equal(journal.name, 'journal');
  assert.equal(journal.useCase, false);
  assert.equal(review.name, 'journal-review');
  assert.equal(review.useCase, true);
  assert.match(journal.description, /^タスク完了時に/);
  assert.ok(!journal.body.includes('明確な設計・実装タスクの区切りで、'));
  const useCases = await f.call<{ assets: Asset[] }>('usecase.search');
  assert.ok(useCases.assets.some(asset => asset.id === review.id));
  assert.ok(!useCases.assets.some(asset => asset.id === journal.id));

  for (const asset of [journal, review]) {
    await assert.rejects(f.call('asset.save', { id: asset.id, expectedRevision: asset.revision, asset: { ...f.core.assetPayload(asset), name: `${asset.name}-renamed` }, provenance }), /名前は変更できません/);
    const preview = await f.call<{ asset: Asset; bindings: { id: string; revision: number }[]; projectCommons: { id: string; revision: number }[] }>('asset.delete.preview', { assetId: asset.id });
    await assert.rejects(f.call('asset.delete', { assetId: asset.id, expectedRevision: preview.asset.revision, expectedBindingRevisions: preview.bindings, expectedProjectCommonRevisions: preview.projectCommons, confirmed: true, provenance }), /削除できません/);
  }
  await assert.rejects(f.call('skill.usecase', { assetId: journal.id, enabled: true, provenance }), /直接起動設定は変更できません/);
  await f.call('skill.usecase', { assetId: review.id, enabled: false, provenance });
  assert.equal(f.core.asset(review.id).useCase, false);
  await f.call('skill.usecase', { assetId: review.id, enabled: true, provenance });

  await f.call('settings.save', { journalEnabled: false });
  assert.equal((await f.call<{ journalEnabled: boolean }>('settings.get')).journalEnabled, false);
  await assert.rejects(f.call('journal.write', { task: '記録停止の確認', body: '## 困った点\n停止中は記録しない' }), /Journal記録が無効/);
  await f.call('settings.save', { journalEnabled: true });
  const written = await f.call<{ journal: Journal }>('journal.write', { task: '記録再開の確認', body: '## 良かった点\n設定を切り替えられる' });
  assert.equal(written.journal.task, '記録再開の確認');
});

test('Legacy Workflow completion fields are normalized into transition conditions', () => {
  const workflow = assetSchema.parse({
    kind: 'workflow', name: '旧Workflow', description: '旧形式', entryStage: 'work',
    stages: [{ id: 'work', name: '作業', completion_condition: '作業結果を確認' }],
    transitions: [{ id: 'done', from: 'work', to: 'completed', type: 'complete', label: '完了' }],
  });
  assert.equal(Object.hasOwn(workflow.stages[0]!, 'completion_condition'), false);
  assert.equal(Object.hasOwn(workflow.transitions[0]!, 'type'), false);
  assert.equal(workflow.transitions[0]!.condition, '作業結果を確認');
});

test('Run start returns an execution plan before the executor retrieves Context', async t => {
  const f = fixture(t), workflow = await f.workflow();
  const started = await f.call<{ run: Run; contextHandle: string; nextExecution: ExecutionPlan; snapshotId: string; context?: Context }>('run.start', { workflowId: workflow.id, runtime: 'codex', instruction: '明示した作業' });
  assert.equal('context' in started, false);
  assert.equal(f.store.list('delivery').length, 0);
  assert.equal(started.nextExecution.stage.id, 'build');
  assert.equal(started.nextExecution.executor, 'orchestrator');
  assert.equal(started.nextExecution.version, started.run.version);
  const recovered = await f.call<{ nextExecution: ExecutionPlan }>('run.get', { contextHandle: started.contextHandle });
  assert.deepEqual(recovered.nextExecution, started.nextExecution);
  const context = await f.call<Context>('context.get', { contextHandle: started.contextHandle });
  assert.equal(context.runId, started.run.id);
  assert.equal(f.store.list('delivery').length, 1);
});

test('Runtime Skill entries carry only frontmatter metadata and the AACL entry ID', async t => {
  const f = fixture(t), skill = await f.asset('skill', { name: 'runtime-description', description: 'yaml frontmatter description', explanation: '人が呼んで分かる説明', body: 'CANONICAL_SKILL_BODY_42', useCase: true });
  const root = mkdtempSync(join(tmpdir(), 'aacl-runtime-description-'));
  await f.call('runtime.register', { runtime: 'codex', platform: 'wsl', scope: 'global', path: root });
  const content = readFileSync(join(root, 'skills', skill.name, 'SKILL.md'), 'utf8');
  assert.match(content, /^name: runtime-description$/m);
  assert.match(content, /^description: "yaml frontmatter description"$/m);
  assert.match(content, new RegExp(`<!-- aacl-entry:${skill.id} -->`));
  assert.ok(skill.explanation);
  assert.ok(!content.includes(skill.explanation));
  assert.ok(!content.includes(skill.body));
  assert.ok(!content.includes('disable-model-invocation'));
});

test('C09: a Workflow cannot be saved while a Stage lacks its responsible Role', async t => {
  const f = fixture(t);
  const workflow = { kind: 'workflow', name: 'Role前提Workflow', description: '担当Roleを必須にする', entryStage: 'work', stages: [{ id: 'work', name: '作業' }], transitions: [{ id: 'done', from: 'work', to: 'completed', condition: '作業結果を確認できる', label: '完了' }] };
  await assert.rejects(f.call('asset.save', { asset: workflow, provenance }), /担当Role/);
  assert.equal(f.store.list('asset').length, 0);
});

test('C09 C11 C17: optional Stage instructions accompany its responsible Role in Context', async t => {
  const f = fixture(t), workflowId = randomUUID(), roleId = randomUUID();
  const workflow = { kind: 'workflow', name: 'Role前提Workflow', description: 'Roleと追加指示をContextへ渡す', entryStage: 'work', stages: [{ id: 'work', name: '作業', additionalInstructions: '既存のRole責務を踏まえて、対象範囲を先に確認する。' }], transitions: [{ id: 'done', from: 'work', to: 'completed', condition: '作業結果を確認できる', label: '完了' }] };
  await f.call('changeset.apply', { changes: [
    { type: 'asset.create', id: workflowId, asset: workflow },
    { type: 'asset.create', id: roleId, asset: { kind: 'role', name: '実装担当', description: '実装を担う', responsibilities: '変更の意図を守り、結果を検証する。' } },
    { type: 'binding.save', binding: { sourceId: workflowId, targetId: roleId, stageId: 'work', purpose: 'stage-role' } },
  ], provenance });
  const run = await f.start(f.core.asset(workflowId));
  const context = run.context as Context & { stageRoleId: string; stage: Context['stage'] & { additionalInstructions: string } };
  assert.equal(context.stageRoleId, roleId);
  assert.equal(context.stage.additionalInstructions, '既存のRole責務を踏まえて、対象範囲を先に確認する。');
  assert.equal(context.roles.find(role => role.id === roleId)?.responsibilities, '変更の意図を守り、結果を検証する。');
  const stageRoleBinding = f.core.bindings().find(b => b.sourceId === workflowId && b.purpose === 'stage-role')!;
  await assert.rejects(f.call('binding.remove', { id: stageRoleBinding.id, expectedRevision: stageRoleBinding.revision, provenance }), /担当Role/);
});

test('Model assets bind Skills and Rules, and consecutive matching Stage assignments reuse one subagent', async t => {
  const f = fixture(t), model = await f.asset('model', { name: '実装Model', modelName: 'provider/implementer', invocationMethod: 'Runtimeのsubagent呼び出し' }), skill = await f.asset('skill', { name: 'Model Skill' }), rule = await f.asset('rule', { name: 'Model Rule' });
  await f.bind(model, skill); await f.bind(model, rule);
  const workflow = await f.workflow();
  await f.bind(workflow, model, { stageId: 'build', purpose: 'stage-model' });
  await f.bind(workflow, model, { stageId: 'review', purpose: 'stage-model' });

  const first = await f.start(workflow);
  assert.equal(first.nextExecution.executor, 'subagent');
  assert.equal(first.nextExecution.model?.id, model.id);
  assert.equal(first.nextExecution.model?.modelName, 'provider/implementer');
  assert.equal(first.nextExecution.subagent?.continuity, 'new');
  assert.equal(first.context.model?.id, model.id);
  assert.equal(first.context.model?.modelName, 'provider/implementer');
  assert.equal(first.context.model?.invocationMethod, 'Runtimeのsubagent呼び出し');
  assert.equal(Object.hasOwn(first.context.workflow, 'description'), false);
  assert.equal(Object.hasOwn(first.context.workflow.stages[0]!, 'description'), false);
  assert.equal(Object.hasOwn(first.context.stage, 'description'), false);
  assert.equal(Object.hasOwn(first.context.model!, 'description'), false);
  assert.equal(Object.hasOwn(first.context.roles[0]!, 'description'), false);
  assert.equal(Object.hasOwn(first.context.rules[0]!, 'description'), false);
  assert.equal(first.context.subagent?.continuity, 'new');
  assert.ok(first.context.subagent?.id);
  assert.equal(first.context.skillCatalog.some(skillAsset => skillAsset.id === skill.id), true);
  assert.equal(first.context.rules.some(ruleAsset => ruleAsset.id === rule.id), true);
  assert.equal((await f.call<{ body: string }>('run.skill.get', { contextHandle: first.contextHandle, assetId: skill.id })).body, '本文');

  const moved = await f.call<{ run: Run; nextExecution: ExecutionPlan }>('run.transition', { contextHandle: first.contextHandle, version: 1, transitionId: 'next', report: '実装完了' });
  assert.equal(moved.nextExecution.stage.id, 'review');
  assert.equal(moved.nextExecution.executor, 'subagent');
  assert.equal(moved.nextExecution.model?.id, model.id);
  assert.equal(moved.nextExecution.subagent?.continuity, 'same');
  assert.equal(moved.run.subagentId, first.run.subagentId);
  assert.equal(moved.run.subagentContinuity, 'same');
  const next = await f.call<Context & { subagent: { id: string; continuity: string } }>('context.get', { contextHandle: first.contextHandle });
  assert.equal(next.model?.id, model.id);
  assert.equal(next.subagent.id, first.context.subagent?.id);
  assert.equal(next.subagent.continuity, 'same');
  assert.equal(next.subagent.instruction.includes('同じサブエージェント'), true);
});

test('Model choices are configured freely, selected per Workflow Stage, and delivered in Context', async t => {
  const f = fixture(t), model = await f.asset('model', {
    name: '選択式Model', modelName: 'agent-{{choice.実行系}}', invocationMethod: 'Runtimeへ渡す {{choice.実行系}} / {{choice.effort}}',
    choices: [
      { name: '実行系', options: ['codex luna', 'codex sol', 'claude opes', 'claude fable'] },
      { name: 'effort', options: ['low', 'medium', 'high'] },
    ],
  });
  const codexSkill = await f.asset('skill', { name: 'Codex用Skill' });
  const highRule = await f.asset('rule', { name: 'High用Rule' });
  const codexHighSkill = await f.asset('skill', { name: 'Codex High用Skill' });
  const multiCombinationSkill = await f.asset('skill', { name: '複数組み合わせSkill' });
  const otherSkill = await f.asset('skill', { name: 'Claude Low用Skill' });
  await f.bind(model, codexSkill, { choiceConditions: [{ 実行系: 'codex sol' }] });
  await f.bind(model, highRule, { choiceConditions: [{ effort: 'high' }] });
  await f.bind(model, codexHighSkill, { choiceConditions: [{ 実行系: 'codex sol', effort: 'high' }] });
  await f.bind(model, multiCombinationSkill, { choiceConditions: [{ 実行系: 'codex sol', effort: 'high' }, { 実行系: 'claude opes', effort: 'low' }] });
  await f.bind(model, otherSkill, { choiceConditions: [{ 実行系: 'claude opes', effort: 'low' }] });
  const workflow = await f.workflow();
  const selectedChoices = { 実行系: 'codex sol', effort: 'high' };
  const binding = await f.bind(workflow, model, { stageId: 'build', purpose: 'stage-model', selectedChoices });
  const run = await f.start(workflow);
  assert.deepEqual(binding.selectedChoices, selectedChoices);
  assert.deepEqual(run.context.modelSelections, selectedChoices);
  assert.deepEqual(run.context.model?.choices, model.choices);
  assert.equal(run.context.model?.modelName, 'agent-codex sol');
  assert.equal(run.context.model?.invocationMethod, 'Runtimeへ渡す codex sol / high');
  assert.equal(run.nextExecution.model?.modelName, 'agent-codex sol');
  assert.equal(run.nextExecution.model?.invocationMethod, 'Runtimeへ渡す codex sol / high');
  assert.deepEqual(new Set(run.context.skillCatalog.map(skill => skill.id)), new Set([codexSkill.id, codexHighSkill.id, multiCombinationSkill.id]));
  assert.deepEqual(run.context.rules.map(rule => rule.id), [highRule.id]);
  assert.ok(run.context.resolution.some(reference => reference.assetId === codexHighSkill.id && reference.reason.includes('選択肢条件')));
  assert.ok(!run.context.resolution.some(reference => reference.assetId === otherSkill.id));
  const snapshot = f.store.get<Snapshot>(run.snapshotId, 'snapshot');
  assert.ok(!snapshot.assets.some(asset => asset.id === otherSkill.id));
  assert.ok(!snapshot.bindings.some(binding => binding.targetId === otherSkill.id));
  await assert.rejects(f.bind(workflow, model, { stageId: 'review', purpose: 'stage-model', selectedChoices: { 実行系: 'other', effort: 'high' } }), /利用できません/);
  const invalidSkill = await f.asset('skill', { name: '無効条件Skill' });
  await assert.rejects(f.bind(model, invalidSkill, { choiceConditions: [{ 実行系: 'other' }] }), /選択肢条件.*利用できません/);
  assert.throws(() => assetSchema.parse({ kind: 'model', name: '重複', description: '説明', modelName: 'agent', invocationMethod: 'Runtime', choices: [{ name: 'effort', options: ['low', 'low'] }] }), /重複/);
  assert.throws(() => assetSchema.parse({ kind: 'model', name: '未定義', description: '説明', modelName: 'agent-{{choice.variant}}', invocationMethod: 'Runtime', choices: [{ name: 'effort', options: ['low'] }] }), /定義されていません/);
  assert.throws(() => assetSchema.parse({ kind: 'model', name: '不正', description: '説明', modelName: 'agent-{{choice.}}', invocationMethod: 'Runtime', choices: [{ name: 'effort', options: ['low'] }] }), /空、または不正/);
});

test('C02 C04 C13 C14 C15 C28 C29: schema / stable identity / idempotent writes / provenance / restoration', async t => {
  const f = fixture(t), a = await f.asset('skill');
  const operationId = randomUUID(), input = { id: a.id, expectedRevision: a.revision, asset: { ...f.core.assetPayload(a), name: '改名', body: '更新' }, provenance };
  const first = await f.call<{ entities: Asset[] }>('asset.save', input, operationId);
  const retry = await f.call<{ duplicate: boolean; entities: Asset[] }>('asset.save', input, operationId);
  assert.equal(first.entities[0].id, a.id); assert.equal(retry.duplicate, true); assert.equal(f.core.asset(a.id).revision, 2);
  await assert.rejects(f.call('asset.save', { ...input, asset: { ...input.asset, body: '別操作' } }, operationId), /operation ID/);
  assert.equal(f.store.revision<Asset>(a.id, 1).body, '本文');
  await f.call('asset.restore', { assetId: a.id, revision: 1, expectedRevision: f.core.asset(a.id).revision });
  assert.equal(f.core.asset(a.id).revision, 3); assert.equal(f.core.asset(a.id).body, '本文');
  await assert.rejects(f.asset('skill', { body: '' }));
  await assert.rejects(f.asset('skill', { metadata: { model: 'test' } }));
  await assert.rejects(f.asset('skill', { capability: ['shell'] }));
  await assert.rejects(f.call('asset.save', { asset: f.core.assetPayload(a), provenance: { origin: 'ai' } }));
  const history = await f.call<{ provenance: { userRequest: string; reason: string }[] }>('history.get', { entityId: a.id });
  assert.ok(history.provenance.some(p => p.userRequest === provenance.userRequest && p.reason === provenance.reason));
  assert.throws(() => f.store.db.exec("UPDATE revisions SET data='{}'"), /immutable/);
});

test('Asset writes use optimistic revisions, Change Set preview is read-only, and lists omit content by default', async t => {
  const f = fixture(t), asset = await f.asset('skill', { supportingFiles: { 'guide.md': '元' } });
  const summary = await f.call<{ assets: Record<string, unknown>[] }>('asset.list', { kind: 'skill' });
  assert.equal('body' in summary.assets[0]!, false);
  assert.equal('supportingFiles' in summary.assets[0]!, false);
  const many = await f.call<{ assets: Asset[] }>('asset.get_many', { assetIds: [asset.id] });
  assert.equal(many.assets[0]!.body, '本文');
  assert.deepEqual(many.assets[0]!.supportingFiles, { 'guide.md': '元' });

  const preview = await f.call<{ valid: boolean; changeCount: number }>('changeset.preview', {
    changes: [{ type: 'asset.save', id: asset.id, expectedRevision: asset.revision, asset: { ...f.core.assetPayload(asset), body: 'Preview' } }],
  });
  assert.deepEqual(preview, { valid: true, changeCount: 1, affected: [{ id: asset.id, revision: 2 }] });
  assert.equal(f.core.asset(asset.id).revision, 1);
  const saved = await f.call<{ entities: Asset[] }>('asset.save', { id: asset.id, expectedRevision: asset.revision, asset: { ...f.core.assetPayload(asset), body: '更新1' }, provenance });
  assert.equal(saved.entities[0]!.revision, 2);
  await assert.rejects(f.call('asset.save', { id: asset.id, expectedRevision: asset.revision, asset: { ...f.core.assetPayload(asset), body: '古い更新' }, provenance }), /Conflict/);
  assert.equal(f.core.asset(asset.id).body, '更新1');
  const before = f.core.asset(asset.id);
  await assert.rejects(f.call('changeset.apply', { changes: [
    { type: 'asset.save', id: asset.id, expectedRevision: before.revision, asset: { ...f.core.assetPayload(before), body: '一部だけ適用しない' } },
    { type: 'asset.save', id: asset.id, expectedRevision: 1, asset: { ...f.core.assetPayload(before), body: '競合' } },
  ], provenance }), /Conflict/);
  assert.equal(f.core.asset(asset.id).body, '更新1');
});

test('asset.update preserves omitted fields such as supportingFiles', async t => {
  const f = fixture(t), asset = await f.asset('skill', {
    supportingFiles: { 'eval-viewer/viewer.html': 'viewer', 'references/guide.md': 'guide' },
  });
  const updated = await f.call<{ entities: Asset[]; changeSet: ChangeSet }>('asset.update', {
    id: asset.id, expectedRevision: asset.revision, asset: { body: '本文だけ更新' }, provenance,
  });
  assert.equal(updated.entities[0]!.body, '本文だけ更新');
  assert.deepEqual(updated.entities[0]!.supportingFiles, asset.supportingFiles);
  assert.deepEqual(updated.changeSet.operations[0], {
    type: 'asset.save', id: asset.id, expectedRevision: asset.revision,
    asset: { ...f.core.assetPayload(asset), body: '本文だけ更新' },
  });
  assert.equal(f.core.asset(asset.id).revision, 2);
  await assert.rejects(f.call('asset.update', { id: asset.id, expectedRevision: asset.revision, asset: {}, provenance }), /更新するAsset field/);
});

test('Change Set restore detects edits made after the original Change Set', async t => {
  const f = fixture(t), asset = await f.asset('skill');
  const edit = await f.call<{ changeSet: ChangeSet }>('asset.save', { id: asset.id, expectedRevision: asset.revision, asset: { ...f.core.assetPayload(asset), body: '変更後' }, provenance });
  await f.call('asset.save', { id: asset.id, expectedRevision: 2, asset: { ...f.core.assetPayload(f.core.asset(asset.id)), body: '後続変更' }, provenance });
  await assert.rejects(f.call('changeset.restore', { changeSetId: edit.changeSet.id }), /Conflict/);
  assert.equal(f.core.asset(asset.id).body, '後続変更');
});

test('Asset deletion shows both reference directions, requires fresh confirmation and restores recorded links', async t => {
  const f = fixture(t), workflow = await f.workflow(), parent = await f.asset('skill'), child = await f.asset('skill'), rule = await f.asset('rule'), role = await f.asset('role');
  const root = mkdtempSync(join(tmpdir(), 'aacl-delete-project-'));
  const { project } = await f.call<{ project: Project }>('project.init', { root, name: '削除確認Project' });
  await f.bind(workflow, parent);
  await f.bind(role, parent);
  await f.bind(parent, child);
  await f.bind(workflow, rule, { scope: project.id });
  await f.call('common.save', { projectId: project.id, expectedRevision: f.core.common(project.id).revision, ruleIds: [rule.id], provenance });
  const run = await f.start(workflow);

  const preview = await f.call<{ asset: Asset; bindings: { id: string; revision: number; direction: string }[]; projectCommons: { id: string; revision: number; projectId: string }[] }>('asset.delete.preview', { assetId: parent.id });
  assert.deepEqual(new Set(preview.bindings.map(b => b.direction)), new Set(['incoming', 'outgoing']));
  assert.equal(preview.projectCommons.length, 0);
  const unconfirmed = { assetId: parent.id, expectedRevision: preview.asset.revision, expectedBindingRevisions: preview.bindings.map(({ id, revision }) => ({ id, revision })), expectedProjectCommonRevisions: [], provenance };
  await assert.rejects(f.call('asset.delete', unconfirmed));
  await assert.rejects(f.call('changeset.apply', { changes: [{ type: 'asset.delete', id: parent.id, expectedRevision: preview.asset.revision, expectedBindingRevisions: unconfirmed.expectedBindingRevisions, expectedProjectCommonRevisions: [], confirmed: true }], provenance }), /専用の削除操作/);
  const anotherRole = await f.asset('role', { name: '追加Role' });
  await f.bind(anotherRole, parent);
  await assert.rejects(f.call('asset.delete', { ...unconfirmed, confirmed: true }), /参照関係が変わりました/);
  assert.equal(f.core.asset(parent.id).deletedAt, undefined);

  const current = await f.call<typeof preview>('asset.delete.preview', { assetId: parent.id });
  const deleted = await f.call<{ changeSet: ChangeSet }>('asset.delete', { assetId: parent.id, expectedRevision: current.asset.revision, expectedBindingRevisions: current.bindings.map(({ id, revision }) => ({ id, revision })), expectedProjectCommonRevisions: [], confirmed: true, provenance });
  assert.ok(f.core.asset(parent.id, true).deletedAt);
  assert.equal((await f.call<{ assets: Asset[] }>('asset.list')).assets.some(a => a.id === parent.id), false);
  assert.equal((await f.call<{ assets: Asset[] }>('asset.list', { includeDeleted: true })).assets.some(a => a.id === parent.id), true);
  assert.equal((await f.call<{ bindings: Binding[] }>('binding.list', { assetId: parent.id })).bindings.length, 0);
  assert.equal((await f.call<{ body: string }>('run.skill.get', { contextHandle: run.contextHandle, assetId: parent.id })).body, '本文');
  await assert.rejects(f.call('skill.get', { assetId: parent.id }), /削除済みAsset/);

  const rulePreview = await f.call<typeof preview>('asset.delete.preview', { assetId: rule.id });
  assert.equal(rulePreview.projectCommons.length, 1);
  assert.equal(rulePreview.projectCommons[0].projectId, project.id);
  const deletedRule = await f.call<{ changeSet: ChangeSet }>('asset.delete', { assetId: rule.id, expectedRevision: rulePreview.asset.revision, expectedBindingRevisions: rulePreview.bindings.map(({ id, revision }) => ({ id, revision })), expectedProjectCommonRevisions: rulePreview.projectCommons.map(({ id, revision }) => ({ id, revision })), confirmed: true, provenance });
  assert.deepEqual(f.core.common(project.id).ruleIds, []);
  assert.equal(f.core.bindings(project.id).some(b => b.targetId === rule.id), false);
  await f.call('changeset.restore', { changeSetId: deletedRule.changeSet.id });
  assert.equal(f.core.asset(rule.id).deletedAt, undefined);
  assert.deepEqual(f.core.common(project.id).ruleIds, [rule.id]);
  assert.equal(f.core.bindings(project.id).some(b => b.targetId === rule.id), true);
  assert.ok(deleted.changeSet.historyIds.length > 0);
});

test('C05 C06 C07: exact Project identity and independent copied bindings / common', async t => {
  const f = fixture(t), originalWorkflow = await f.workflow(), s = await f.asset('skill'), rule = await f.asset('rule');
  const w = (await f.call<{ entities: Asset[] }>('asset.save', { id: originalWorkflow.id, expectedRevision: originalWorkflow.revision, asset: { ...f.core.assetPayload(originalWorkflow), name: 'issue-development' }, provenance })).entities[0];
  const globalBinding = await f.bind(w, s);
  assert.equal(normalizeRoot('C:\\work\\x\\..\\app\\'), '/mnt/c/work/app');
  assert.equal(normalizeRoot('\\\\wsl.localhost\\Ubuntu\\home\\me\\app'), '/home/me/app');
  assert.throws(() => normalizeRoot('relative/path'));
  const globalRoot = mkdtempSync(join(tmpdir(), 'aacl-global-runtime-'));
  await f.call('runtime.register', { runtime: 'claude', platform: 'wsl', scope: 'global', path: join(globalRoot, '.claude') });
  await f.call('runtime.register', { runtime: 'codex', platform: 'wsl', scope: 'global', path: join(globalRoot, '.codex') });
  const root = mkdtempSync(join(tmpdir(), 'aacl-project-'));
  const { project } = await f.call<{ project: Project }>('project.init', { root, name: 'Project' });
  assert.equal(f.core.common(project.id).ruleIds.length, 0);
  const copy = f.core.bindings(project.id).find(b => b.targetId === s.id)!;
  assert.equal(copy.targetId, s.id); assert.notEqual(copy.id, globalBinding.id);
  assert.equal(f.store.list('asset').length, 4);
  const projectTargets = f.store.list<RuntimeTarget>('runtime-target').filter(target => target.scope === project.id);
  assert.equal(projectTargets.length, 2);
  assert.ok(existsSync(join(globalRoot, '.claude/commands/issue-development.md')));
  assert.ok(existsSync(join(globalRoot, '.codex/skills/issue-development/SKILL.md')));
  assert.ok(!existsSync(join(root, '.claude/commands/issue-development.md')));
  assert.ok(!existsSync(join(root, '.codex/skills/issue-development/SKILL.md')));
  const projectSkill = await f.asset('skill', { scope: project.id, name: 'project-only', useCase: true });
  assert.ok(existsSync(join(root, '.claude/commands/project-only.md')));
  assert.ok(existsSync(join(root, '.codex/skills/project-only/SKILL.md')));
  assert.ok(!existsSync(join(globalRoot, '.claude/commands/project-only.md')));
  assert.ok(!existsSync(join(globalRoot, '.codex/skills/project-only/SKILL.md')));
  await f.call('binding.remove', { id: globalBinding.id, expectedRevision: globalBinding.revision, provenance });
  assert.equal(f.core.bindings(project.id).filter(b => b.targetId === s.id).length, 1);
  assert.equal(f.core.bindings(project.id).filter(b => b.purpose === 'stage-role').length, 2);
  assert.equal((await f.call<{ project: Project | null }>('project.resolve', { root: `${root}/child` })).project, null);
  assert.equal((await f.call<{ project: Project | null }>('project.resolve', { root: `${root}/../${root.split('/').at(-1)}` })).project?.id, project.id);
  await f.call('common.save', { projectId: project.id, expectedRevision: f.core.common(project.id).revision, ruleIds: [rule.id], provenance });
  const r = await f.start(w, { projectId: project.id });
  assert.equal(r.context.rules[0].id, rule.id);
  const count = f.store.list('project').length;
  await assert.rejects(f.call('project.init', { root, name: '重複' }));
  assert.equal(f.store.list('project').length, count);
  assert.equal(projectSkill.scope, project.id);
});

test('Project binding scope can be cleared without changing Global bindings', async t => {
  const f = fixture(t), workflow = await f.workflow(), skill = await f.asset('skill');
  await f.bind(workflow, skill);
  const project = f.core.initProject(`/tmp/project-${randomUUID()}`, 'Project').project;
  const projectBindings = f.core.bindings(project.id);
  assert.equal(projectBindings.length, 3);

  const removed = await f.call<{ changeSet: ChangeSet }>('changeset.apply', {
    changes: projectBindings.map(binding => ({ type: 'binding.remove', id: binding.id, expectedRevision: binding.revision })),
    provenance,
  });
  assert.equal(f.core.bindings(project.id).length, 0);
  assert.equal(f.core.bindings('global').length, 3);
  assert.equal(removed.changeSet.historyIds.length, 3);
  await f.start(workflow);
  await assert.rejects(f.start(workflow, { projectId: project.id }), /担当Role/);
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

test('AACL Skill bindings become ordinary candidates with host-side loaders independently of useCase', async t => {
  const f = fixture(t);
  const parent = await f.asset('skill', { name: 'setup-project-architecture', useCase: true, body: '親Skill本文' });
  const child = await f.asset('skill', { name: 'setup-codegraph-project', description: '新規プロジェクトへCodeGraphを導入する', useCase: false, body: '子Skill本文' });
  const grandchild = await f.asset('skill', { name: 'verify-codegraph', description: 'CodeGraphの導入結果を確認する', useCase: false, body: '孫Skill本文' });
  await f.asset('skill', { name: child.name, description: '別Assetの同名Skill', body: 'フォールバックしてはいけない本文' });
  await f.bind(parent, child, { purpose: 'reference' });
  await f.bind(child, grandchild, { purpose: 'reference' });

  const loaded = await f.call<{
    body: string;
    skillCatalog: { id: string; name: string; description: string }[];
    skillLoaders: { catalogKey: string; name: string; source: string; loader: { type: string; assetId: string; revision: number } }[];
  }>('skill.get', { assetId: parent.id });
  assert.equal(loaded.body, '親Skill本文');
  assert.deepEqual(loaded.skillCatalog, [
    { id: child.id, name: child.name, description: child.description },
    { id: grandchild.id, name: grandchild.name, description: grandchild.description },
  ]);
  assert.deepEqual(loaded.skillLoaders, [
    { catalogKey: `aacl:${child.id}:${child.revision}`, name: child.name, source: 'aacl', loader: { type: 'aacl-asset', assetId: child.id, revision: child.revision } },
    { catalogKey: `aacl:${grandchild.id}:${grandchild.revision}`, name: grandchild.name, source: 'aacl', loader: { type: 'aacl-asset', assetId: grandchild.id, revision: grandchild.revision } },
  ]);

  const workflow = await f.workflow(); await f.bind(workflow, parent);
  const run = await f.start(workflow);
  assert.deepEqual(run.context.skillCatalog.map(skill => skill.name), [parent.name, child.name, grandchild.name]);
  assert.deepEqual(run.context.skillLoaders.map(loader => loader.catalogKey), [
    `aacl:${parent.id}:${parent.revision}`, `aacl:${child.id}:${child.revision}`, `aacl:${grandchild.id}:${grandchild.revision}`,
  ]);
  assert.equal((await f.call<{ body: string }>('skill.get', { assetId: child.id })).body, '子Skill本文');
  await assert.rejects(f.call('skill.get', { assetId: child.id, revision: child.revision + 100 }), new RegExp(`name=${child.name}.*assetId=${child.id}.*revision=${child.revision + 100}`));
});

test('C09 C11 C12 C17 C20 C21 C22 C23 C24 C31: immutable resolution, progressive delivery, concurrent Handles', async t => {
  const f = fixture(t), role = await f.asset('role', { responsibilities: '責務' }), w = await f.workflow(role), a = await f.asset('skill', { body: '未取得本文'.repeat(100), supportingFiles: { 'guide.md': '元ファイル' } }), b = await f.asset('skill', { name: 'B' }), rule = await f.asset('rule');
  await f.bind(w, role, { purpose: 'entry-role' }); await f.bind(role, a); await f.bind(a, b); await f.bind(role, rule);
  const one = await f.start(w), two = await f.start(w, { runtime: 'claude' });
  assert.notEqual(one.contextHandle, two.contextHandle);
  assert.equal(one.context.roles[0].responsibilities, '責務');
  assert.deepEqual(new Set(one.context.skillCatalog.map(a => a.id)), new Set([a.id, b.id]));
  assert.ok(!JSON.stringify(one).includes('未取得本文'));
  const snapshot = f.store.get<Snapshot>(one.snapshotId, 'snapshot'), sealed = JSON.stringify(snapshot);
  const cost = f.core.costs().filter(c => c.runId === one.run.id).reduce((sum, c) => sum + c.bytes, 0);
  assert.equal(cost, Buffer.byteLength(JSON.stringify(one.context)));
  await f.call('asset.save', { id: a.id, expectedRevision: a.revision, asset: { ...f.core.assetPayload(a), body: '新本文', supportingFiles: { 'guide.md': '新ファイル' } }, provenance });
  const roleSkillBinding = f.core.bindings().find(b => b.sourceId === role.id && b.targetId === a.id)!;
  await f.call('binding.remove', { id: roleSkillBinding.id, expectedRevision: roleSkillBinding.revision, provenance });
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
  const applied = await f.call<{ outcome: string; nextExecution: ExecutionPlan }>('run.transition', input, operationId);
  assert.equal(applied.outcome, 'applied');
  assert.equal(applied.nextExecution.stage.id, 'build');
  assert.equal(applied.nextExecution.version, 2);
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
  assert.throws(() => assetSchema.parse({ kind: 'workflow', name: 'x', description: 'x', stages: [{ id: 'x', name: 'x' }], transitions: [{ id: 'done', from: 'x', to: 'completed', label: '完了' }], entryStage: 'x' }));
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
  const journalList = await f.call<{ journals: Journal[]; insights: Insight[]; total: number }>('journal.list');
  assert.equal(journalList.total, 1); assert.equal(journalList.journals.length, 1); assert.equal(journalList.insights.length, 3);
  await f.call('insight.status', { insightId: result.insights[0].id, status: 'processed' });
  assert.equal((await f.call<{ insights: Insight[] }>('review.pending')).insights.length, 2);
  await assert.rejects(f.call('journal.write', { body: '関連づけなし' }), /Task/);
});

test('Journal, Review and History list pages stay compact and load details by cursor or ID', async t => {
  const f = fixture(t);
  await f.call('journal.write', { task: '一つ目の記録', body: '## 困った点\n本文を個別取得する' });
  await f.call('journal.write', { task: '二つ目の記録', body: '## 改善の種\n次のページへ進む' });

  const journalPage = await f.call<{ journals: (Journal & { raw?: string })[]; total: number; nextCursor: string | null }>('journal.list', { limit: 1 });
  assert.equal(journalPage.total, 2);
  assert.equal(journalPage.journals.length, 1);
  assert.equal(journalPage.journals[0]!.task, '二つ目の記録');
  assert.equal('raw' in journalPage.journals[0]!, false);
  assert.ok(journalPage.nextCursor);
  const olderJournalPage = await f.call<{ journals: Journal[] }>('journal.list', { limit: 1, cursor: journalPage.nextCursor });
  assert.equal(olderJournalPage.journals[0]!.task, '一つ目の記録');

  const reviewPage = await f.call<{ reviewItems: (ReviewItem & { body?: string })[]; journals: (Journal & { raw?: string })[]; nextCursor: string | null }>('review.pending', { limit: 1, include: ['journalTask'], includeBodies: false });
  assert.equal('body' in reviewPage.reviewItems[0]!, false);
  assert.equal('raw' in reviewPage.journals[0]!, false);
  assert.ok(reviewPage.nextCursor);

  const asset = await f.asset('skill', { name: '履歴の概要確認' });
  const updated = await f.call<{ entities: Asset[] }>('asset.save', { id: asset.id, expectedRevision: asset.revision, asset: { ...f.core.assetPayload(asset), body: '更新後の本文' }, provenance });
  assert.equal(updated.entities[0]!.revision, 2);
  const historyPage = await f.call<{ changeSets: (ChangeSet & { operations?: ChangeSet['operations'] })[]; nextCursor: string | null }>('history.get', { limit: 1 });
  assert.equal(historyPage.changeSets.length, 1);
  assert.equal('operations' in historyPage.changeSets[0]!, false);
  const detailedHistory = await f.call<{ changeSets: ChangeSet[] }>('history.get', { changeSetId: historyPage.changeSets[0]!.id, includeDetails: true });
  assert.ok(detailedHistory.changeSets[0]!.operations.length > 0);
});

test('Review items keep direct Journal task links and independent decisions', async t => {
  const f = fixture(t), result = await f.call<{ journal: Journal; insights: Insight[] }>('journal.write', { body: '## Task\n独立Review\n\n## 良かった点\n残す方法\n\n## 困った点\n直す詰まり' });
  const compact = await f.call<{ reviewItems: (ReviewItem & { body?: string })[]; journals: Journal[]; insights: Insight[]; nextCursor: string | null }>('review.pending', { includeBodies: false, limit: 1 });
  assert.equal(compact.reviewItems.length, 1); assert.equal(compact.reviewItems[0].body, undefined); assert.equal(compact.journals.length, 1); assert.equal(compact.insights[0].body, ''); assert.ok(compact.nextCursor);
  const detailed = await f.call<{ reviewItem: ReviewItem; journalTask: Journal; insight: Insight }>('review.item.get', { reviewItemId: compact.reviewItems[0].id });
  assert.equal(detailed.reviewItem.journalTaskId, result.journal.id); assert.equal(detailed.journalTask.id, result.journal.id); assert.equal(detailed.insight.id, compact.reviewItems[0].insightId);

  await f.call('review.decide', { reviewItemId: compact.reviewItems[0].id, decision: 'deferred', note: '後で再確認' });
  const second = (await f.call<{ reviewItems: ReviewItem[] }>('review.pending', { includeBodies: true })).reviewItems.find(item => item.insightId !== compact.reviewItems[0].insightId)!;
  await f.call('review.decide', { reviewItemId: second.id, decision: 'approved', note: '採用' });
  assert.equal(f.store.get<Insight>(second.insightId).status, 'processed');
  assert.equal(f.store.get<ReviewItem>(compact.reviewItems[0].id).status, 'pending');
  assert.equal(f.store.get<Journal>(result.journal.id).reviewStatus, 'pending');

  await f.call('review.decide', { reviewItemId: compact.reviewItems[0].id, decision: 'rejected', note: '今回は見送る' });
  assert.equal(f.store.get<Insight>(second.insightId).status, 'processed');
  assert.equal(f.store.get<Insight>(compact.reviewItems[0].insightId).status, 'rejected');
  assert.equal(f.store.get<Journal>(result.journal.id).reviewStatus, 'processed');
});

test('C01 C26 C27 C28 C35: review approval applies changes and selected insights atomically; next Run adopts revision', async t => {
  const f = fixture(t), w = await f.workflow(), skill = await f.asset('skill');
  await f.bind(w, skill);
  const r = await f.start(w);
  const journal = await f.call<{ journal: Journal; insights: Insight[] }>('journal.write', { contextHandle: r.contextHandle, body: '## 困った点\n改善する部分\n\n保留する部分' });
  assert.equal(journal.journal.snapshotId, r.snapshotId); assert.equal(journal.journal.assetRevisions?.find(a => a.id === skill.id)?.revision, 1);
  const proposal = await f.call<{ proposal: { id: string } }>('proposal.save', { title: '改善', observedContext: '実際の観測', proposedChange: '本文を更新', reason: '気づきに対応', evidenceJournalIds: [journal.journal.id], reviewedJournalIds: [journal.journal.id], affectedAssetIds: [skill.id], affectedBindingIds: [], affectedProjectIds: [], changes: [{ type: 'asset.save', id: skill.id, expectedRevision: skill.revision, asset: { ...f.core.assetPayload(skill), body: '改善後' } }], insightIds: [journal.insights[0].id] });
  const linked = await f.call<{ reviewItem: ReviewItem }>('review.item.get', { reviewItemId: f.store.list<ReviewItem>('review-item').find(item => item.insightId === journal.insights[0].id)!.id });
  assert.deepEqual(linked.reviewItem.proposalIds, [proposal.proposal.id]);
  const proposalSummary = await f.call<{ proposal: { changes?: unknown[] } }>('proposal.get', { proposalId: proposal.proposal.id });
  assert.equal('changes' in proposalSummary.proposal, false);
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
  await assert.rejects(f.call('changeset.apply', { changes: [{ type: 'asset.save', id: skill.id, expectedRevision: skill.revision + 1, asset: { ...f.core.assetPayload(skill), body: '失敗で戻る' } }, { type: 'binding.save', binding: { sourceId: skill.id, targetId: randomUUID() } }], provenance }));
  assert.equal(f.core.asset(skill.id).revision, before);
});

test('C16 C33: Runtime entries are thin, owned, updated and retained on unregistration', async t => {
  const f = fixture(t), skill = await f.asset('skill', { name: 'journal-review', useCase: true, body: 'CANONICAL_ONLY_CONTENT_928' });
  const root = mkdtempSync(join(tmpdir(), 'aacl-runtime-'));
  const { target } = await f.call<{ target: RuntimeTarget }>('runtime.register', { runtime: 'codex', platform: 'wsl', scope: 'global', path: root });
  const path = join(root, 'skills', 'journal-review', 'SKILL.md');
  const policyPath = join(root, 'skills', 'journal-review', 'agents', 'openai.yaml');
  const content = readFileSync(path, 'utf8');
  assert.match(content, new RegExp(skill.id)); assert.match(content, /^name: journal-review$/m); assert.ok(!content.includes(skill.body)); assert.ok(!content.includes('aacl_run_start')); assert.ok(!content.includes('disable-model-invocation'));
  assert.equal(readFileSync(policyPath, 'utf8'), 'policy:\n  allow_implicit_invocation: false\n');
  writeFileSync(policyPath, 'policy:\n  allow_implicit_invocation: true\n');
  const blockedPolicy = await f.call<{ runtimeSync: { failureCount: number } }>('runtime.sync');
  assert.ok(blockedPolicy.runtimeSync.failureCount > 0); assert.equal(readFileSync(policyPath, 'utf8'), 'policy:\n  allow_implicit_invocation: true\n');
  writeFileSync(policyPath, f.ops.runtime.policy('codex')!); await f.call('runtime.sync');
  const renamedPath = join(root, 'skills', 'security-review', 'SKILL.md');
  const renamedPolicyPath = join(root, 'skills', 'security-review', 'agents', 'openai.yaml');
  await f.call('asset.save', { id: skill.id, expectedRevision: skill.revision, asset: { ...f.core.assetPayload(skill), name: 'security-review' }, provenance });
  assert.equal(existsSync(path), false); assert.equal(existsSync(policyPath), false); assert.match(readFileSync(renamedPath, 'utf8'), /^name: security-review$/m); assert.equal(readFileSync(renamedPolicyPath, 'utf8'), 'policy:\n  allow_implicit_invocation: false\n');
  await f.call('skill.usecase', { assetId: skill.id, enabled: false, provenance }); assert.equal(existsSync(renamedPath), false); assert.equal(existsSync(renamedPolicyPath), false); assert.equal(existsSync(dirname(renamedPath)), false);
  await f.call('skill.usecase', { assetId: skill.id, enabled: true, provenance }); assert.equal(existsSync(renamedPath), true); assert.equal(existsSync(renamedPolicyPath), true);
  await f.call('runtime.unregister', { targetId: target.id }); assert.equal(existsSync(renamedPath), true); assert.equal(existsSync(renamedPolicyPath), true);
  await f.call('skill.usecase', { assetId: skill.id, enabled: false, provenance }); assert.equal(existsSync(renamedPath), true);
  const collision = join(root, 'other'); mkdirSync(join(collision, 'commands'), { recursive: true });
  const w = await f.workflow(), blocked = join(collision, 'commands', 'workflow.md');
  writeFileSync(blocked, '利用者のファイル');
  const result = await f.call<{ runtimeSync: { failureCount: number } }>('runtime.register', { runtime: 'claude', platform: 'wsl', scope: 'global', path: collision });
  assert.ok(result.runtimeSync.failureCount > 0); assert.equal(readFileSync(blocked, 'utf8'), '利用者のファイル');
  const linkRoot = join(root, 'link'); symlinkSync(collision, linkRoot);
  await f.call('runtime.register', { runtime: 'claude', platform: 'wsl', scope: 'global', path: linkRoot });
  assert.ok(f.core.diagnostics().diagnostics.some(d => d.code === 'runtime-entry'));
  writeFileSync(blocked, f.ops.runtime.body(w, 'claude'));
  await f.call('runtime.sync');
  assert.ok(!f.core.diagnostics().diagnostics.some(d => d.target === f.store.list<RuntimeTarget>('runtime-target').find(t => t.path === collision)!.id));
});

test('Confirmed Asset deletion removes its owned Runtime entry', async t => {
  const f = fixture(t), skill = await f.asset('skill', { name: 'delete-runtime-entry', useCase: true });
  const root = mkdtempSync(join(tmpdir(), 'aacl-delete-runtime-'));
  await f.call('runtime.register', { runtime: 'codex', platform: 'wsl', scope: 'global', path: root });
  const path = join(root, 'skills', 'delete-runtime-entry', 'SKILL.md');
  const policyPath = join(root, 'skills', 'delete-runtime-entry', 'agents', 'openai.yaml');
  assert.equal(existsSync(path), true); assert.equal(existsSync(policyPath), true);
  const preview = await f.call<{ asset: Asset; bindings: { id: string; revision: number }[]; projectCommons: { id: string; revision: number }[] }>('asset.delete.preview', { assetId: skill.id });
  await f.call('asset.delete', { assetId: skill.id, expectedRevision: preview.asset.revision, expectedBindingRevisions: preview.bindings, expectedProjectCommonRevisions: preview.projectCommons, confirmed: true, provenance });
  assert.equal(existsSync(path), false); assert.equal(existsSync(policyPath), false);
  assert.equal(f.store.list<{ assetId: string; active: boolean }>('runtime-entry').find(e => e.assetId === skill.id)?.active, false);
});

test('Runtime entry names come from Workflow and direct Skill names, with IDs only for collisions', async t => {
  const f = fixture(t), workflow = await f.workflow();
  await f.call('asset.save', { id: workflow.id, expectedRevision: workflow.revision, asset: { ...f.core.assetPayload(workflow), name: 'shared-review' }, provenance });
  const sharedSkill = await f.asset('skill', { name: 'shared-review', useCase: true });
  const anotherSharedSkill = await f.asset('skill', { name: 'shared-review', useCase: true });
  const uniqueSkill = await f.asset('skill', { name: 'architecture-review', useCase: true });
  const longName = `${'a'.repeat(26)}-review`;
  const longSkill = await f.asset('skill', { name: longName, useCase: true });
  const anotherLongSkill = await f.asset('skill', { name: longName, useCase: true });
  const internalSkill = await f.asset('skill', { name: 'design-review', useCase: false });
  const claudeRoot = mkdtempSync(join(tmpdir(), 'aacl-runtime-claude-'));
  const codexRoot = mkdtempSync(join(tmpdir(), 'aacl-runtime-codex-'));
  await f.call('runtime.register', { runtime: 'claude', platform: 'wsl', scope: 'global', path: claudeRoot });
  await f.call('runtime.register', { runtime: 'codex', platform: 'wsl', scope: 'global', path: codexRoot });
  const names = [workflow.id, sharedSkill.id, anotherSharedSkill.id].map(id => `shared-review-${id}`);
  for (const name of names) {
    assert.ok(existsSync(join(claudeRoot, 'commands', `${name}.md`)));
    assert.ok(existsSync(join(codexRoot, 'skills', name, 'SKILL.md')));
    assert.match(readFileSync(join(codexRoot, 'skills', name, 'SKILL.md'), 'utf8'), new RegExp(`^name: ${name}$`, 'm'));
  }
  const workflowEntry = readFileSync(join(claudeRoot, 'commands', `${names[0]}.md`), 'utf8');
  assert.ok(!workflowEntry.includes('\ndescription:'));
  assert.match(workflowEntry, /MCPの aacl_run_start/); assert.ok(!workflowEntry.includes('ensure')); assert.ok(!workflowEntry.includes('shellで'));
  const codexWorkflowEntry = readFileSync(join(codexRoot, 'skills', names[0], 'SKILL.md'), 'utf8');
  assert.match(codexWorkflowEntry, /^description: "shared-reviewをAACLから起動する"$/m);
  const skillEntry = readFileSync(join(codexRoot, 'skills', 'architecture-review', 'SKILL.md'), 'utf8');
  assert.match(skillEntry, /MCPの aacl_skill_get/); assert.ok(!skillEntry.includes('ensure')); assert.ok(!skillEntry.includes('shellで'));
  for (const name of [longSkill.id, anotherLongSkill.id].map(id => `${'a'.repeat(26)}-${id}`)) {
    assert.ok(name.length <= 64); assert.ok(!name.includes('--'));
    assert.ok(existsSync(join(claudeRoot, 'commands', `${name}.md`)));
    assert.ok(existsSync(join(codexRoot, 'skills', name, 'SKILL.md')));
  }
  assert.ok(existsSync(join(claudeRoot, 'commands', 'architecture-review.md')));
  assert.ok(existsSync(join(codexRoot, 'skills', 'architecture-review', 'SKILL.md')));
  assert.ok(!existsSync(join(claudeRoot, 'commands', 'aacl-' + uniqueSkill.id + '.md')));
  assert.ok(!existsSync(join(codexRoot, 'skills', `aacl-${uniqueSkill.id}`)));
  assert.ok(!existsSync(join(claudeRoot, 'commands', 'design-review.md')));
  assert.ok(!existsSync(join(codexRoot, 'skills', 'design-review')));
  assert.ok(!existsSync(join(claudeRoot, 'commands', `${internalSkill.id}.md`)));
});

test('Binding-referenced Skills are implicit Codex candidates without becoming direct use cases', async t => {
  const f = fixture(t), parent = await f.asset('skill', { name: 'setup-project-architecture', useCase: false }), child = await f.asset('skill', { name: 'setup-codegraph-project', description: 'CodeGraphを導入する', useCase: false });
  const root = mkdtempSync(join(tmpdir(), 'aacl-runtime-binding-'));
  await f.bind(parent, child);
  await f.call('runtime.register', { runtime: 'codex', platform: 'wsl', scope: 'global', path: root });
  const path = join(root, 'skills', child.name, 'SKILL.md'), policyPath = join(root, 'skills', child.name, 'agents', 'openai.yaml');
  assert.equal(existsSync(path), true);
  assert.match(readFileSync(path, 'utf8'), /^description: "CodeGraphを導入する"$/m);
  assert.equal(readFileSync(policyPath, 'utf8'), 'policy:\n  allow_implicit_invocation: true\n');
  const entry = f.store.list<{ assetId: string; implicitInvocation?: boolean }>('runtime-entry').find(item => item.assetId === child.id)!;
  assert.equal(entry.implicitInvocation, true);
  await f.call('binding.remove', { id: f.core.bindings().find(binding => binding.sourceId === parent.id && binding.targetId === child.id)!.id, expectedRevision: f.core.bindings().find(binding => binding.sourceId === parent.id && binding.targetId === child.id)!.revision, provenance });
  await f.call('runtime.sync');
  assert.equal(existsSync(path), false);
  assert.equal(existsSync(policyPath), false);
});

test('Runtime sync moves an owned ID-named entry to its asset name', async t => {
  const f = fixture(t), skill = await f.asset('skill', { name: 'security-review', useCase: true });
  const root = mkdtempSync(join(tmpdir(), 'aacl-runtime-migrate-'));
  const { target } = await f.call<{ target: RuntimeTarget }>('runtime.register', { runtime: 'codex', platform: 'wsl', scope: 'global', path: root });
  const currentPath = join(root, 'skills', 'security-review', 'SKILL.md');
  const currentPolicyPath = join(root, 'skills', 'security-review', 'agents', 'openai.yaml');
  const oldPath = join(root, 'skills', `aacl-${skill.id}`, 'SKILL.md');
  const oldPolicyPath = join(root, 'skills', `aacl-${skill.id}`, 'agents', 'openai.yaml');
  const oldBody = f.ops.runtime.body(skill, 'codex', `aacl-${skill.id}`);
  unlinkSync(currentPath); unlinkSync(currentPolicyPath); rmdirSync(dirname(currentPolicyPath)); rmdirSync(dirname(currentPath)); mkdirSync(dirname(oldPolicyPath), { recursive: true }); writeFileSync(oldPath, oldBody); writeFileSync(oldPolicyPath, f.ops.runtime.policy('codex')!);
  const entry = f.store.list<{ id: string; targetId: string; assetId: string; path: string; hash: string; active: boolean }>('runtime-entry').find(item => item.targetId === target.id && item.assetId === skill.id)!;
  f.store.put('runtime-entry', { ...entry, path: oldPath, hash: createHash('sha256').update(oldBody).digest('hex') });
  writeFileSync(oldPath, '利用者による変更');
  const blocked = await f.call<{ runtimeSync: { failureCount: number } }>('runtime.sync');
  assert.ok(blocked.runtimeSync.failureCount > 0); assert.equal(readFileSync(oldPath, 'utf8'), '利用者による変更'); assert.equal(existsSync(currentPath), false);
  writeFileSync(oldPath, oldBody);
  await f.call('runtime.sync');
  assert.equal(existsSync(oldPath), false); assert.equal(existsSync(dirname(oldPath)), false);
  assert.match(readFileSync(currentPath, 'utf8'), /^name: security-review$/m); assert.equal(readFileSync(currentPolicyPath, 'utf8'), 'policy:\n  allow_implicit_invocation: false\n');
});

test('Runtime sync places Skill supporting files independently for Codex and Claude', async t => {
  const f = fixture(t), skill = await f.asset('skill', {
    name: 'integrated-browser', useCase: true,
    supportingFiles: { 'scripts/browser-api.sh': '#!/bin/sh\necho browser\n', 'references/http-api.md': 'HTTP API' },
  });
  const codexRoot = mkdtempSync(join(tmpdir(), 'aacl-support-codex-')), claudeRoot = mkdtempSync(join(tmpdir(), 'aacl-support-claude-'));
  await f.call('runtime.register', { runtime: 'codex', platform: 'wsl', scope: 'global', path: codexRoot });
  await f.call('runtime.register', { runtime: 'claude', platform: 'wsl', scope: 'global', path: claudeRoot });
  const codexScript = join(codexRoot, 'skills', skill.name, 'scripts/browser-api.sh');
  const claudeScript = join(claudeRoot, 'commands', skill.name, 'scripts/browser-api.sh');
  for (const path of [codexScript, claudeScript]) {
    assert.equal(readFileSync(path, 'utf8'), '#!/bin/sh\necho browser\n');
    assert.equal(statSync(path).mode & 0o777, 0o700);
  }
  const files = f.store.list<{ targetId: string; assetId: string; assetRevision: number; relativePath: string; hash: string; active: boolean; executable: boolean }>('runtime-file');
  assert.equal(files.filter(file => file.assetId === skill.id && file.active).length, 4);
  assert.ok(files.filter(file => file.assetId === skill.id).every(file => file.assetRevision === skill.revision));
  assert.ok(files.some(file => file.relativePath === 'scripts/browser-api.sh' && file.executable));

  const updated = await f.call<{ entities: Asset[] }>('asset.save', {
    id: skill.id, expectedRevision: skill.revision,
    asset: { ...f.core.assetPayload(skill), supportingFiles: { 'scripts/browser-api.sh': '#!/bin/sh\necho updated\n', 'references/new-api.md': 'New API' } }, provenance,
  });
  assert.equal(readFileSync(codexScript, 'utf8'), '#!/bin/sh\necho updated\n');
  assert.equal(existsSync(join(codexRoot, 'skills', skill.name, 'references/http-api.md')), false);
  assert.equal(existsSync(join(codexRoot, 'skills', skill.name, 'references/new-api.md')), true);
  await f.call('skill.usecase', { assetId: skill.id, enabled: false, provenance });
  assert.equal(existsSync(join(codexRoot, 'skills', skill.name, 'scripts/browser-api.sh')), false);
  assert.equal(existsSync(join(claudeRoot, 'commands', skill.name)), false);
  assert.ok(f.store.list<{ assetId: string; active: boolean }>('runtime-file').filter(file => file.assetId === skill.id).every(file => !file.active));
  assert.equal(updated.entities[0]!.supportingFiles['scripts/browser-api.sh'], '#!/bin/sh\necho updated\n');

  const edited = await f.asset('skill', { name: 'edited-supporting-file', useCase: true, supportingFiles: { 'scripts/tool.sh': 'original' } });
  const editedPath = join(codexRoot, 'skills', edited.name, 'scripts/tool.sh');
  writeFileSync(editedPath, 'user edit');
  const sync = await f.call<{ runtimeSync: { failureCount: number } }>('runtime.sync');
  assert.ok(sync.runtimeSync.failureCount > 0);
  assert.equal(readFileSync(editedPath, 'utf8'), 'user edit');
  assert.ok(f.core.diagnostics().diagnostics.some(d => d.code === 'runtime-file' && d.message.includes('変更')));
  assert.throws(() => assetSchema.parse({ kind: 'skill', name: 'reserved', description: '説明', body: '本文', explanation: '説明', supportingFiles: { 'agents/openai.yaml': '衝突' } }), /予約パス/);
});

test('Runtime supporting files follow the collision-safe Claude entry name', async t => {
  const f = fixture(t), first = await f.asset('skill', { name: 'same-name', useCase: true, supportingFiles: { 'scripts/tool.sh': 'first' } }), second = await f.asset('skill', { name: 'same-name', useCase: true, supportingFiles: { 'scripts/tool.sh': 'second' } });
  const root = mkdtempSync(join(tmpdir(), 'aacl-support-collision-'));
  await f.call('runtime.register', { runtime: 'claude', platform: 'wsl', scope: 'global', path: root });
  const firstEntry = `same-name-${first.id}`, secondEntry = `same-name-${second.id}`;
  assert.equal(readFileSync(join(root, 'commands', `${firstEntry}.md`), 'utf8').includes(first.id), true);
  assert.equal(readFileSync(join(root, 'commands', firstEntry, 'scripts/tool.sh'), 'utf8'), 'first');
  assert.equal(readFileSync(join(root, 'commands', secondEntry, 'scripts/tool.sh'), 'utf8'), 'second');
  assert.equal(existsSync(join(root, 'commands', 'same-name', 'scripts/tool.sh')), false);
});

test('Journal Review Run inspection is body-less and excludes active Runs', async t => {
  const f = fixture(t), workflow = await f.workflow(), skill = await f.asset('skill', { name: 'review-only-skill', body: 'SECRET_REVIEW_BODY_174' });
  await f.bind(workflow, skill);
  const started = await f.start(workflow);
  await f.call('run.cancel', { contextHandle: started.contextHandle, reason: 'Review inspection test' });
  const journal = await f.call<{ journal: Journal }>('journal.write', { postRunId: started.run.id, body: '## 改善の種\nSnapshot本文を返さない' });
  const inspected = await f.call<{ journalId: string; run: Run; snapshot: { assets: { id: string; kind: string; name: string; revision: number }[] }; deliveries: { target: string; revision?: number; success: boolean; bytes: number }[]; events: { type: string; timestamp: string }[] }>('review.run.inspect', { journalId: journal.journal.id });
  assert.equal(inspected.journalId, journal.journal.id);
  assert.equal(inspected.run.status, 'cancelled');
  assert.ok(inspected.snapshot.assets.some(asset => asset.id === skill.id && !('body' in asset)));
  assert.ok(inspected.events.every(event => !('data' in event)));
  assert.ok(inspected.deliveries.every(delivery => !('content' in delivery)));
  assert.ok(!JSON.stringify(inspected).includes('SECRET_REVIEW_BODY_174'));

  const active = await f.start(workflow);
  const activeJournal = await f.call<{ journal: Journal }>('journal.write', { contextHandle: active.contextHandle, body: '## 改善の種\n進行中はReview不可' });
  await assert.rejects(f.call('review.run.inspect', { journalId: activeJournal.journal.id }), /進行中/);
  const taskOnly = await f.call<{ journal: Journal }>('journal.write', { task: 'RunなしReview', body: '## 改善の種\nRun未関連' });
  await assert.rejects(f.call('review.run.inspect', { journalId: taskOnly.journal.id }), /関連するRun/);
});

test('C29 C33: Change Set restoration / persistent SQLite / export / consistent Backup restore', async t => {
  const f = fixture(t), skill = await f.asset('skill');
  const edit = await f.call<{ changeSet: ChangeSet }>('asset.save', { id: skill.id, expectedRevision: skill.revision, asset: { ...f.core.assetPayload(skill), body: '編集後' }, provenance });
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

test('C33: UI relationship projections distinguish direct / Role paths and graph includes conditional loops', async t => {
  const f = fixture(t), role = await f.asset('role'), w = await f.workflow(role), s = await f.asset('skill');
  await f.bind(role, s); await f.bind(w, s, { stageId: 'review' });
  const views = relatedWorkflows(s.id, f.store.list('asset'), f.core.bindings());
  assert.ok(views.some(v => v.stageId === 'build' && v.via[0] === role.name && v.binding.sourceId === role.id));
  assert.ok(views.some(v => v.stageId === 'review' && !v.via.length));
  const graph = workflowDiagram(w);
  assert.equal(graph.edges.length, 4); assert.ok(graph.edges.some(e => e.from === e.to && e.condition.includes('再作業')));
  assert.ok(graph.edges.some(e => e.to === 'build' && e.condition === '修正が必要'));
});

test('C11 C33: one Global Role is reused across Workflow stages and workflows, and removed Stage links save atomically', async t => {
  const f = fixture(t), first = await f.workflow(), second = await f.workflow(), roleId = randomUUID();
  const roleAsset = { kind: 'role', name: '共通Role', description: '複数Workflowで共有する', responsibilities: '共通の責務を担う', scope: 'global' };
  const firstBindings = stageRoleBindingChanges(first.id, 'global', [{ stageId: 'build', roleId }, { stageId: 'review', roleId }], f.core.bindings());
  await f.call('changeset.apply', { changes: [{ type: 'asset.create', id: roleId, asset: roleAsset }, ...firstBindings], provenance });
  const role = f.core.asset(roleId);
  await assert.rejects(f.call('changeset.apply', { changes: [{ type: 'asset.create', id: roleId, asset: roleAsset }], provenance }), /登録済み/);
  for (const workflow of [second]) {
    const changes = stageRoleBindingChanges(workflow.id, 'global', [{ stageId: 'build', roleId: role.id }, { stageId: 'review', roleId: role.id }], f.core.bindings());
    await f.call('changeset.apply', { changes, provenance });
  }
  assert.equal(f.core.bindings('global').filter(b => b.targetId === role.id && b.purpose === 'stage-role').length, 4);
  const firstRun = await f.start(first);
  assert.deepEqual(firstRun.context.roles.map(a => a.id), [role.id]);
  const snapshot = f.store.get<Snapshot>(firstRun.snapshotId, 'snapshot');
  assert.deepEqual(f.core.resolve(snapshot, 'review').roles.map(a => a.id), [role.id]);
  const secondRun = await f.start(second);
  assert.deepEqual(secondRun.context.roles.map(a => a.id), [role.id]);

  const remaining = stageRoleBindingChanges(first.id, 'global', [{ stageId: 'build', roleId: role.id }], f.core.bindings());
  const payload = { ...f.core.assetPayload(first), stages: [first.stages[0]], transitions: [] };
  await f.call('changeset.apply', { changes: [...remaining, { type: 'asset.save', id: first.id, expectedRevision: first.revision, asset: payload }], provenance });
  assert.equal(f.core.asset(first.id).stages.length, 1);
  assert.deepEqual(f.core.bindings('global').filter(b => b.sourceId === first.id && b.purpose === 'stage-role').map(b => b.stageId), ['build']);
  assert.equal(f.core.bindings('global').filter(b => b.sourceId === second.id && b.purpose === 'stage-role').length, 2);
});
