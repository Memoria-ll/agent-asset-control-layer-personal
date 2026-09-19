import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { Store } from './store.ts';
import { assetSchema, bindingSchema, parseJournal } from './schema.ts';
import type { Asset, AssetDeletionPreview, Binding, Change, ChangeSet, Common, Context, Decision, Delivery, Diagnostic, History, Insight, Journal, Project, Proposal, Provenance, Run, RunEvent, Snapshot, Stamp } from './schema.ts';

function sameRevisions(a: { id: string; revision: number }[], b: { id: string; revision: number }[]) {
  const sorted = (values: { id: string; revision: number }[]) => [...values].sort((x, y) => x.id.localeCompare(y.id));
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
}

export function normalizeRoot(input: string): string {
  let path = input.trim().replaceAll('\\', '/');
  if (/^[a-z]:\//i.test(path)) path = `/mnt/${path[0].toLowerCase()}/${path.slice(3)}`;
  else if (/^\/\/(wsl\.localhost|wsl\$)\/[^/]+\//i.test(path)) path = path.replace(/^\/\/(wsl\.localhost|wsl\$)\/[^/]+/i, '');
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\0')) throw new Error('Project rootはLinuxまたはWindowsの絶対パスで指定してください。');
  return posix.normalize(path).replace(/\/$/, '') || '/';
}

export class Core {
  store: Store;
  constructor(store: Store) { this.store = store; }
  assertScope(scope: string) { if (scope !== 'global') this.store.get<Project>(scope, 'project'); }
  asset(id: string, includeDeleted = false) {
    const asset = this.store.get<Asset>(id, 'asset');
    if (!includeDeleted && asset.deletedAt) throw new Error('削除済みAssetは利用できません。');
    return asset;
  }
  bindings(scope?: string) { return this.store.list<Binding>('binding', scope).filter(b => b.active); }
  common(projectId: string): Common {
    this.store.get<Project>(projectId, 'project');
    return this.store.list<Common>('common', projectId)[0];
  }
  assetDeletionPreview(assetId: string): AssetDeletionPreview {
    const asset = this.asset(assetId), assets = new Map(this.store.list<Asset>('asset').map(a => [a.id, a]));
    const bindings = this.bindings().filter(b => b.sourceId === assetId || b.targetId === assetId).map(b => {
      const source = assets.get(b.sourceId), target = assets.get(b.targetId);
      if (!source || !target) throw new Error(`紐づけ先Assetを取得できません: ${b.id}`);
      const stageName = b.stageId && source.kind === 'workflow' ? source.stages.find(s => s.id === b.stageId)?.name : undefined;
      return { id: b.id, revision: b.revision, scope: b.scope, sourceId: source.id, sourceName: source.name, targetId: target.id, targetName: target.name, stageId: b.stageId, stageName, purpose: b.purpose, direction: b.sourceId === assetId ? 'outgoing' as const : 'incoming' as const };
    });
    const projects = new Map(this.store.list<Project>('project').map(p => [p.id, p]));
    const projectCommons = this.store.list<Common>('common').filter(c => c.ruleIds.includes(assetId)).map(c => {
      const project = projects.get(c.projectId);
      if (!project) throw new Error(`Project CommonのProjectを取得できません: ${c.projectId}`);
      return { id: c.id, revision: c.revision, projectId: c.projectId, projectName: project.name };
    });
    return { asset: { id: asset.id, name: asset.name, kind: asset.kind, scope: asset.scope, revision: asset.revision }, bindings, projectCommons };
  }
  deleteAsset(input: { assetId: string; expectedRevision: number; expectedBindingRevisions: { id: string; revision: number }[]; expectedProjectCommonRevisions: { id: string; revision: number }[]; confirmed: true }, provenance: Provenance) {
    const preview = this.assetDeletionPreview(input.assetId);
    const bindingRevisions = preview.bindings.map(({ id, revision }) => ({ id, revision }));
    const projectCommonRevisions = preview.projectCommons.map(({ id, revision }) => ({ id, revision }));
    if (preview.asset.revision !== input.expectedRevision || !sameRevisions(bindingRevisions, input.expectedBindingRevisions) || !sameRevisions(projectCommonRevisions, input.expectedProjectCommonRevisions)) {
      throw new Error('Assetまたは参照関係が変わりました。参照一覧を再取得し、削除を確認してください。');
    }
    const changes: Change[] = preview.bindings.map(b => ({ type: 'binding.remove', id: b.id }));
    for (const reference of preview.projectCommons) {
      const common = this.store.get<Common>(reference.id, 'common');
      changes.push({ type: 'common.save', projectId: common.projectId, ruleIds: common.ruleIds.filter(id => id !== input.assetId) });
    }
    changes.push({ type: 'asset.delete', id: input.assetId, expectedRevision: input.expectedRevision, expectedBindingRevisions: input.expectedBindingRevisions, expectedProjectCommonRevisions: input.expectedProjectCommonRevisions, confirmed: input.confirmed });
    return this.applyChanges(changes, provenance, undefined, undefined, undefined, undefined, true);
  }
  validateBinding(b: Omit<Binding, keyof Stamp | 'active'>) {
    this.assertScope(b.scope);
    const source = this.asset(b.sourceId), target = this.asset(b.targetId);
    const allowed: Record<Asset['kind'], string[]> = { workflow: ['role', 'skill', 'rule', 'model'], role: ['skill', 'rule'], skill: ['skill'], rule: [], model: ['skill', 'rule'] };
    if (!allowed[source.kind].includes(target.kind)) throw new Error('このAssetの組み合わせは紐づけられません。');
    if ([source, target].some(a => a.scope !== 'global' && a.scope !== b.scope)) throw new Error('別ProjectのAssetは参照できません。');
    if (b.stageId && (source.kind !== 'workflow' || !source.stages.some(s => s.id === b.stageId))) throw new Error('指定されたStageがありません。');
    if (b.purpose === 'entry-role' && (b.stageId || source.kind !== 'workflow' || target.kind !== 'role')) throw new Error('入口のRoleはWorkflowに指定してください。');
    if (b.purpose === 'stage-role' && (!b.stageId || source.kind !== 'workflow' || target.kind !== 'role')) throw new Error('担当RoleはWorkflowのStageに指定してください。');
    if (b.purpose === 'stage-model' && (!b.stageId || source.kind !== 'workflow' || target.kind !== 'model')) throw new Error('ModelはWorkflowのStageに指定してください。');
    if (source.id === target.id) throw new Error('Skillの循環参照は登録できません。');
  }
  assertStageRoles(workflow: Asset, scope: string) {
    for (const stage of workflow.stages) {
      const assignments = this.bindings(scope).filter(b => b.sourceId === workflow.id && b.stageId === stage.id && b.purpose === 'stage-role');
      if (assignments.length !== 1 || this.asset(assignments[0].targetId).kind !== 'role') throw new Error(`各Stageには担当Roleを1件割り当ててください: ${stage.id}`);
    }
  }
  applyChanges(changes: Change[], provenance: Provenance, proposalId?: string, approvalId?: string, restore?: { entityId: string; revision: number }[], restoresChangeSetId?: string, allowAssetDelete = false) {
    if (!allowAssetDelete && changes.some(c => c.type === 'asset.delete')) throw new Error('Asset削除は影響一覧を確認した後、専用の削除操作から確定してください。');
    for (const change of changes.filter((c): c is Extract<Change, { type: 'asset.delete' }> => c.type === 'asset.delete')) {
      const preview = this.assetDeletionPreview(change.id);
      const bindingRevisions = preview.bindings.map(({ id, revision }) => ({ id, revision }));
      const projectCommonRevisions = preview.projectCommons.map(({ id, revision }) => ({ id, revision }));
      if (!change.confirmed || preview.asset.revision !== change.expectedRevision || !sameRevisions(bindingRevisions, change.expectedBindingRevisions) || !sameRevisions(projectCommonRevisions, change.expectedProjectCommonRevisions)) {
        throw new Error('Assetまたは参照関係が変わりました。参照一覧を再取得し、削除を確認してください。');
      }
      for (const reference of preview.bindings) if (!changes.some(c => c.type === 'binding.remove' && c.id === reference.id)) throw new Error('削除前に参照する紐づけを解除してください。');
      for (const reference of preview.projectCommons) {
        const commonChange = changes.find(c => c.type === 'common.save' && c.projectId === reference.projectId);
        if (!commonChange || commonChange.type !== 'common.save' || commonChange.ruleIds.includes(change.id)) throw new Error('削除前にProject CommonのRule参照を解除してください。');
      }
    }
    const changeSetId = randomUUID();
    const p = this.store.put('provenance', { ...provenance, changeSetId });
    const histories: History[] = [], entities: (Asset | Binding | Common)[] = [];
    const stageRoleScopes = new Map<string, Set<string>>();
    const validateStageRoles = (workflowId: string, scope: string) => {
      const scopes = stageRoleScopes.get(workflowId) ?? new Set<string>();
      scopes.add(scope);
      stageRoleScopes.set(workflowId, scopes);
    };
    const save = <T extends object>(kind: string, data: T & { id?: string }, scope: string, create = false) => {
      const before = data.id && !create ? this.store.get<Stamp>(data.id, kind).revision : null;
      const result = this.store.put(kind, data, scope);
      histories.push(this.store.put('history', { entityId: result.id, kind, before, after: result.revision, changeSetId, restoredFrom: restore?.find(r => r.entityId === result.id)?.revision }));
      return result;
    };
    for (const change of changes) {
      if (change.type === 'asset.create') {
        const a = assetSchema.parse(change.asset);
        this.assertScope(a.scope);
        if (this.store.maybe(change.id)) throw new Error('指定されたAsset IDは登録済みです。');
        entities.push(save('asset', { ...a, id: change.id }, a.scope, true));
        if (a.kind === 'workflow') validateStageRoles(change.id, a.scope);
      } else if (change.type === 'asset.save') {
        const a = assetSchema.parse(change.asset);
        this.assertScope(a.scope);
        if (change.id) {
          const restoring = restore?.some(r => r.entityId === change.id) ?? false;
          const old = this.asset(change.id, restoring);
          if (old.kind !== a.kind || old.scope !== a.scope) throw new Error('Assetの種類と管理先は変更できません。');
          if (a.kind === 'workflow') for (const b of this.bindings().filter(b => b.sourceId === change.id && b.stageId)) {
            if (!a.stages.some(s => s.id === b.stageId)) throw new Error('削除するStageの紐づけを先に解除してください。');
          }
        }
        const saved = save('asset', { ...a, id: change.id }, a.scope) as Asset;
        entities.push(saved);
        if (a.kind === 'workflow') validateStageRoles(saved.id, a.scope);
      } else if (change.type === 'asset.delete') {
        const asset = this.asset(change.id);
        if (this.bindings().some(b => b.sourceId === change.id || b.targetId === change.id)) throw new Error('Assetへの紐づけを解除してから削除してください。');
        if (this.store.list<Common>('common').some(c => c.ruleIds.includes(change.id))) throw new Error('Project CommonのRule参照を解除してから削除してください。');
        entities.push(save('asset', { ...asset, deletedAt: new Date().toISOString() }, asset.scope));
      } else if (change.type === 'binding.save') {
        const b = bindingSchema.parse(change.binding);
        const previous = change.id ? this.store.get<Binding>(change.id, 'binding') : undefined;
        const target = this.asset(b.targetId);
        if (change.id && this.store.get<Binding>(change.id, 'binding').scope !== b.scope) throw new Error('紐づけの管理先は変更できません。');
        this.validateBinding(b);
        const peers = this.bindings(b.scope).filter(v => v.id !== change.id && v.sourceId === b.sourceId && v.stageId === b.stageId);
        if (peers.some(v => v.targetId === b.targetId && v.purpose === b.purpose)) throw new Error('同じ紐づけが存在します。');
        if (b.purpose !== 'reference' && peers.some(v => v.purpose === b.purpose)) throw new Error('担当Roleは1件です。既存の紐づけを付け替えてください。');
        if (b.stageId && target.kind === 'model' && peers.some(v => this.asset(v.targetId).kind === 'model')) throw new Error('StageのModelは1件です。既存のModelを付け替えてください。');
        const graph = this.bindings(b.scope).filter(v => v.id !== change.id).concat({ ...b, id: '', active: true } as Binding);
        const visit = (id: string, trail: Set<string>) => {
          if (trail.has(id)) throw new Error('Skillの循環参照は登録できません。');
          const next = new Set(trail).add(id);
          for (const edge of graph.filter(e => e.sourceId === id)) visit(edge.targetId, next);
        };
        visit(b.sourceId, new Set());
        entities.push(save('binding', { ...b, id: change.id, active: true }, b.scope));
        if (previous?.purpose === 'stage-role') validateStageRoles(previous.sourceId, previous.scope);
        if (b.purpose === 'stage-role') validateStageRoles(b.sourceId, b.scope);
      } else if (change.type === 'binding.remove') {
        const b = this.store.get<Binding>(change.id, 'binding');
        entities.push(save('binding', { ...b, active: false }, b.scope));
        if (b.purpose === 'stage-role') validateStageRoles(b.sourceId, b.scope);
      } else {
        const c = this.common(change.projectId);
        for (const id of change.ruleIds) {
          const a = this.asset(id);
          if (a.kind !== 'rule' || (a.scope !== 'global' && a.scope !== change.projectId)) throw new Error('このProjectで利用できるRuleを指定してください。');
        }
        entities.push(save('common', { ...c, ruleIds: [...new Set(change.ruleIds)] }, change.projectId));
      }
    }
    for (const [workflowId, scopes] of stageRoleScopes) {
      const workflow = this.asset(workflowId, true);
      if (workflow.deletedAt || workflow.kind !== 'workflow') continue;
      for (const scope of scopes) {
        if (scope !== 'global' && this.bindings(scope).length === 0) continue;
        this.assertStageRoles(workflow, scope);
      }
    }
    const changeSet = this.store.put('changeset', { id: changeSetId, operations: changes, provenanceId: p.id, historyIds: histories.map(h => h.id), proposalId, approvalId, restoresChangeSetId });
    return { changeSet, entities };
  }
  initProject(root: string, name: string) {
    root = normalizeRoot(root);
    if (this.store.list<Project>('project').some(p => p.root === root)) throw new Error('このProject rootは登録済みです。');
    const project = this.store.put('project', { name, root });
    const common = this.store.put('common', { projectId: project.id, ruleIds: [] }, project.id);
    const originals = this.bindings('global');
    const result = this.applyChanges(originals.map(b => ({ type: 'binding.save', binding: { scope: project.id, sourceId: b.sourceId, targetId: b.targetId, stageId: b.stageId, purpose: b.purpose } })), {
      origin: 'init', reason: 'Globalの紐づけをProject初期構成へコピー', userRequest: `Project初期導入: ${root}`, proposedBy: '', decision: '',
      sources: originals.map(b => ({ type: 'binding-revision', reference: `${b.id}@${b.revision}` })),
    });
    return { project, common, ...result };
  }
  resolve(snapshot: Snapshot, stageId: string, roleId?: string, subagent?: { id: string; continuity: 'new' | 'same' }): Context {
    const { workflow, bindings, common } = snapshot;
    const stage = workflow.stages.find(s => s.id === stageId);
    if (!stage) throw new Error('SnapshotにStageが存在しません。');
    const stageRoleBindings = bindings.filter(b => b.sourceId === workflow.id && b.stageId === stageId && b.purpose === 'stage-role');
    if (stageRoleBindings.length !== 1) throw new Error(`このStageには担当Roleを1件指定してください: ${stageId}`);
    const stageRoleId = stageRoleBindings[0].targetId;
    const stageModelBindings = bindings.filter(b => b.sourceId === workflow.id && b.stageId === stageId && (b.purpose === 'stage-model' || snapshot.assets.find(a => a.id === b.targetId)?.kind === 'model'));
    if (stageModelBindings.length > 1) throw new Error(`このStageにはModelを1件まで指定できます: ${stageId}`);
    const stageModelId = stageModelBindings[0]?.targetId;
    const assets = new Map(snapshot.assets.map(a => [a.id, a]));
    const chosen = new Map<string, Asset>(), resolution: Context['resolution'] = [];
    const seen = new Set<string>();
    const walk = (assetId: string, path: string[], stack: Set<string>, reason: string) => {
      if (stack.has(assetId)) throw new Error(`循環参照: ${[...path, assetId].join(' → ')}`);
      const a = assets.get(assetId);
      if (!a) throw new Error(`必須参照を取得できません: ${assetId}`);
      resolution.push({ assetId, revision: a.revision, path: [...path, assetId], reason });
      chosen.set(assetId, a);
      if (seen.has(assetId)) return;
      seen.add(assetId);
      const next = new Set(stack).add(assetId);
      for (const b of bindings.filter(b => b.sourceId === assetId && !b.stageId)) walk(b.targetId, [...path, assetId, `${b.id}@${b.revision}`], next, '明示的な紐づけ');
    };
    for (const b of bindings.filter(b => b.sourceId === workflow.id && (!b.stageId || b.stageId === stageId))) {
      walk(b.targetId, [workflow.id, ...(b.stageId ? [b.stageId] : []), `${b.id}@${b.revision}`], new Set([workflow.id]), b.stageId ? 'Stageの直接参照' : 'Workflowの直接参照');
    }
    for (const id of common?.ruleIds ?? []) walk(id, [`Project Common@${common!.revision}`], new Set(), 'Project Common');
    if (chosen.get(stageRoleId)?.kind !== 'role') throw new Error(`このStageの担当Roleを取得できません: ${stageId}`);
    if (roleId && (!chosen.has(roleId) || chosen.get(roleId)?.kind !== 'role')) throw new Error('このStageで利用対象になっているRoleを指定してください。');
    const model = stageModelId ? chosen.get(stageModelId) : undefined;
    if (stageModelId && model?.kind !== 'model') throw new Error(`このStageのModelを取得できません: ${stageId}`);
    return {
      runId: snapshot.runId, workflow, stage, stageRoleId,
      ...(model ? { model } : {}),
      roles: [...chosen.values()].filter(a => a.kind === 'role'),
      rules: [...chosen.values()].filter(a => a.kind === 'rule'),
      skillCatalog: [...chosen.values()].filter(a => a.kind === 'skill').map(({ id, name, description, revision }) => ({ id, name, description, revision })),
      ...(model && subagent ? { subagent: { id: subagent.id, roleId: stageRoleId, modelId: model.id, continuity: subagent.continuity, instruction: 'このStageは指定Modelをサブエージェントとして呼び出して実行する。直前のStageと担当Role・Modelが同じ場合は同じサブエージェントへ依頼する。' } } : {}),
      resolution, unavailable: [],
    };
  }
  startRun(input: { workflowId: string; projectId?: string; root?: string; runtime: string; instruction: string; target: string }) {
    let project: Project | null = input.projectId ? this.store.get(input.projectId, 'project') : null;
    if (input.root) {
      const found = this.store.list<Project>('project').find(p => p.root === normalizeRoot(input.root!));
      if (!found) throw new Error('Project rootが未登録です。aacl initで登録してください。');
      if (project && project.id !== found.id) throw new Error('Project IDとrootが一致しません。');
      project = found;
    }
    const workflow = this.asset(input.workflowId);
    assetSchema.parse(this.assetPayload(workflow));
    if (workflow.kind !== 'workflow') throw new Error('Runを開始できるのはWorkflowです。');
    if (workflow.scope !== 'global' && workflow.scope !== project?.id) throw new Error('このProjectのWorkflowではありません。');
    const scope = project?.id ?? 'global', allBindings = this.bindings(scope);
    const common = project ? this.common(project.id) : null;
    const needed = new Set<string>([workflow.id, ...(common?.ruleIds ?? [])]);
    const visited = new Set<string>();
    const visit = (source: string, stack: Set<string>) => {
      if (stack.has(source)) throw new Error('循環参照を検出しました。');
      if (visited.has(source)) return;
      visited.add(source);
      const next = new Set(stack).add(source);
      this.asset(source);
      for (const b of allBindings.filter(b => b.sourceId === source)) {
        this.validateBinding(b);
        needed.add(b.targetId); visit(b.targetId, next);
      }
    };
    visit(workflow.id, new Set());
    for (const ruleId of common?.ruleIds ?? []) if (this.asset(ruleId).kind !== 'rule') throw new Error('Project CommonにRule以外の参照があります。');
    const assets = [...needed].map(id => this.asset(id));
    const bindings = allBindings.filter(b => needed.has(b.sourceId));
    const runId = randomUUID(), snapshotId = randomUUID(), contextHandle = randomUUID();
    const draft = { id: snapshotId, runId, boundary: this.store.boundary(), workflow, assets, bindings, common, project, runtime: input.runtime } as Snapshot;
    for (const stage of workflow.stages) this.resolve(draft, stage.id);
    const initialBaseContext = this.resolve(draft, workflow.entryStage);
    const initialSubagentId = initialBaseContext.model ? randomUUID() : undefined;
    const initialContext = this.resolve(draft, workflow.entryStage, undefined, initialSubagentId ? { id: initialSubagentId, continuity: 'new' } : undefined);
    const snapshot = this.store.put('snapshot', { ...draft, initialContext });
    const run = this.store.put('run', { id: runId, contextHandle, workflowId: workflow.id, workflowRevision: workflow.revision, projectId: project?.id, snapshotId,
      stageId: workflow.entryStage, status: 'active' as const, version: 1, runtime: input.runtime, instruction: input.instruction, target: input.target,
      taskType: workflow.taskType, lastActivity: new Date().toISOString(),
      ...(initialBaseContext.model ? { subagentId: initialSubagentId, subagentRoleId: initialBaseContext.stageRoleId, subagentModelId: initialBaseContext.model.id, subagentContinuity: 'new' as const } : {}),
    }, scope);
    this.event(run, 'started', { snapshotId, ...(initialBaseContext.model ? { subagentId: initialSubagentId, modelId: initialBaseContext.model.id } : {}) });
    this.deliver(run, 'context', initialContext, true, [workflow.id], workflow.revision, initialContext.roles.map(a => a.id));
    return { run, contextHandle, context: initialContext, snapshotId: snapshot.id };
  }
  assetPayload(a: Asset) {
    const { id: _id, revision: _rev, createdAt: _created, updatedAt: _updated, deletedAt: _deletedAt, ...payload } = a;
    return payload;
  }
  run(handle: string, touch = true): Run {
    this.expireRuns();
    const run = this.store.list<Run>('run').find(r => r.contextHandle === handle);
    if (!run) throw new Error('Run Context Handleが見つかりません。run.startの応答を使用してください。');
    if (touch && run.status === 'active') return this.store.put('run', { ...run, lastActivity: new Date().toISOString() }, run.projectId ?? 'global');
    return run;
  }
  event(run: Run, type: string, data: unknown) { return this.store.put('event', { runId: run.id, type, data }); }
  deliver(run: Run, target: string, content: unknown, success: boolean, path: string[], revision?: number, roleIds: string[] = [], reason?: string) {
    return this.store.put('delivery', { runId: run.id, snapshotId: run.snapshotId, stageId: run.stageId, roleIds, target, content, success, path, assetRevision: revision, reason,
      bytes: success ? Buffer.byteLength(JSON.stringify(content), 'utf8') : 0,
    });
  }
  context(handle: string, roleId?: string, model?: string) {
    const run = this.run(handle), snapshot = this.store.get<Snapshot>(run.snapshotId, 'snapshot');
    const context = this.resolve(snapshot, run.stageId, roleId, run.subagentId && run.subagentContinuity ? { id: run.subagentId, continuity: run.subagentContinuity } : undefined);
    const payload = { ...context, ...(roleId ? { handoffRoleId: roleId } : {}), ...(model !== undefined ? { model } : {}) };
    this.deliver(run, roleId ? `role:${roleId}` : 'context', context, true, [snapshot.workflow.id, run.stageId], snapshot.workflow.revision, context.roles.map(a => a.id));
    return payload;
  }
  skillGet(assetId: string) {
    const asset = this.asset(assetId);
    if (asset.kind !== 'skill') throw new Error('Skillを指定してください。');
    return { id: asset.id, name: asset.name, revision: asset.revision, body: asset.body };
  }
  runSkillGet(handle: string, assetId: string, file?: string) {
    const run = this.run(handle), snapshot = this.store.get<Snapshot>(run.snapshotId, 'snapshot');
    const context = this.resolve(snapshot, run.stageId), reference = context.resolution.find(r => r.assetId === assetId);
    const asset = snapshot.assets.find(a => a.id === assetId && a.kind === 'skill');
    const target = file ? `${assetId}/${file}` : assetId;
    if (!reference || !asset || (file !== undefined && !Object.hasOwn(asset.supportingFiles, file))) {
      const reason = !reference || !asset ? 'このStageの利用対象Skillではありません。' : '固定revisionに補助ファイルがありません。';
      this.deliver(run, target, null, false, reference?.path ?? [], asset?.revision, context.roles.map(r => r.id), reason);
      return { available: false, target, reason };
    }
    const result = { available: true, id: asset.id, revision: asset.revision, file, body: file === undefined ? asset.body : asset.supportingFiles[file] };
    this.deliver(run, target, result, true, reference.path, asset.revision, context.roles.map(r => r.id));
    return result;
  }
  transition(input: { contextHandle: string; version: number; transitionId: string; report: string; evidence: { type: string; reference: string }[]; comment: string }) {
    const run = this.run(input.contextHandle);
    if (run.version !== input.version || run.status !== 'active') {
      this.event(run, 'stale', input);
      return { outcome: 'stale', run };
    }
    const snapshot = this.store.get<Snapshot>(run.snapshotId, 'snapshot');
    const transition = snapshot.workflow.transitions.find(t => t.id === input.transitionId && t.from === run.stageId);
    if (!transition) throw new Error('現在のStageから許可されていない遷移です。');
    const nextStageId = transition.to === 'completed' ? undefined : transition.to;
    const nextContext = nextStageId ? this.resolve(snapshot, nextStageId) : undefined;
    const sameSubagent = Boolean(nextContext?.model && run.subagentId && run.subagentRoleId === nextContext.stageRoleId && run.subagentModelId === nextContext.model.id);
    const nextSubagentId = nextContext?.model ? (sameSubagent ? run.subagentId : randomUUID()) : undefined;
    const result = this.store.put('run', { ...run, status: transition.to === 'completed' ? 'completed' as const : 'active' as const,
      stageId: transition.to === 'completed' ? run.stageId : transition.to, version: run.version + 1,
      ...(nextContext?.model ? { subagentId: nextSubagentId, subagentRoleId: nextContext.stageRoleId, subagentModelId: nextContext.model.id, subagentContinuity: sameSubagent ? 'same' as const : 'new' as const } : nextStageId ? { subagentId: undefined, subagentRoleId: undefined, subagentModelId: undefined, subagentContinuity: undefined } : { subagentId: run.subagentId, subagentRoleId: run.subagentRoleId, subagentModelId: run.subagentModelId, subagentContinuity: run.subagentContinuity }),
    }, run.projectId ?? 'global');
    this.event(result, 'transition', { transition, report: input.report, evidence: input.evidence, comment: input.comment,
      ...(nextContext?.model ? { subagentId: nextSubagentId, modelId: nextContext.model.id, continuity: sameSubagent ? 'same' : 'new' } : {}) });
    return { outcome: 'applied', run: result };
  }
  endRun(handle: string, status: 'cancelled' | 'failed', reason: string) {
    const run = this.run(handle);
    if (run.status !== 'active') throw new Error('このRunは終了しています。');
    const result = this.store.put('run', { ...run, status, version: run.version + 1 }, run.projectId ?? 'global');
    this.event(result, status, { reason });
    return { run: result };
  }
  settings() { return this.store.maybe<{ id: string; timeoutHours: number }>('settings') ?? { id: 'settings', timeoutHours: 24 }; }
  expireRuns(now = Date.now()) {
    for (const run of this.store.list<Run>('run')) {
      if (run.status === 'active' && now - Date.parse(run.lastActivity) > this.settings().timeoutHours * 3600000) {
        const failed = this.store.put('run', { ...run, status: 'failed' as const, version: run.version + 1 }, run.projectId ?? 'global');
        this.event(failed, 'timeout', { lastActivity: run.lastActivity, timeoutHours: this.settings().timeoutHours });
      }
    }
  }
  runDetail(run: Run) {
    return { run, snapshot: this.store.get<Snapshot>(run.snapshotId, 'snapshot'), events: this.store.list<RunEvent>('event').filter(e => e.runId === run.id).reverse(),
      deliveries: this.store.list<Delivery>('delivery').filter(d => d.runId === run.id), journals: this.store.list<Journal>('journal').filter(j => j.runId === run.id) };
  }
  writeJournal(input: { body: string; contextHandle?: string; postRunId?: string; task?: string }) {
    if (input.contextHandle && input.postRunId) throw new Error('Handleと終了後Run IDはどちらか一方を指定してください。');
    const run = input.contextHandle ? this.run(input.contextHandle) : input.postRunId ? this.store.get<Run>(input.postRunId, 'run') : undefined;
    if (input.postRunId && run?.status === 'active') throw new Error('進行中のRunにはContext Handleを使ってください。');
    const parsed = parseJournal(input.body);
    const task = input.task?.trim() || parsed.sections.Task?.trim() || '';
    if (!run && !task) throw new Error('Runを指定しないJournalにはTaskが必要です。');
    const snapshot = run ? this.store.get<Snapshot>(run.snapshotId, 'snapshot') : undefined;
    const journal = this.store.put('journal', { raw: input.body, parsed, task, runId: run?.id, snapshotId: snapshot?.id, projectId: run?.projectId,
      stageId: run?.stageId, workflowRevision: snapshot?.workflow.revision, assetRevisions: snapshot?.assets.map(a => ({ id: a.id, revision: a.revision })),
      bindingRevisions: snapshot?.bindings.map(b => ({ id: b.id, revision: b.revision })),
    }, run?.projectId ?? 'global');
    const insights = parsed.insights.map(i => this.store.put('insight', { journalId: journal.id, ...i, status: 'pending' as const }));
    return { journal, insights };
  }
  review() {
    const insights = this.store.list<Insight>('insight').filter(i => i.status === 'pending');
    const reviewed = new Set(this.store.list<Proposal>('proposal').flatMap(p => p.reviewedJournalIds));
    const journals = this.store.list<Journal>('journal').filter(j => !reviewed.has(j.id) || insights.some(i => i.journalId === j.id));
    return { journals, insights };
  }
  saveProposal(input: Omit<Proposal, keyof Stamp>, proposalId?: string) {
    if (proposalId) {
      this.store.get<Proposal>(proposalId, 'proposal');
      if (this.store.list<Decision>('decision').some(d => d.proposalId === proposalId)) throw new Error('判断済みの提案を変更する場合は、新しい提案を作成してください。');
    }
    for (const id of [...input.evidenceJournalIds, ...input.reviewedJournalIds]) this.store.get(id, 'journal');
    for (const id of input.affectedAssetIds) this.asset(id);
    for (const id of input.affectedBindingIds) this.store.get(id, 'binding');
    for (const id of input.affectedProjectIds) this.store.get(id, 'project');
    for (const id of input.insightIds) {
      const insight = this.store.get<Insight>(id, 'insight');
      if (!input.evidenceJournalIds.includes(insight.journalId)) throw new Error('処理対象の気づきには根拠Journalを指定してください。');
    }
    return { proposal: this.store.put('proposal', { ...input, id: proposalId }) };
  }
  applyProposal(proposalId: string) {
    const p = this.store.get<Proposal>(proposalId, 'proposal');
    const decision = this.store.list<Decision>('decision').find(d => d.proposalId === proposalId);
    if (decision?.choice !== 'approved') throw new Error('この提案は承認されていません。');
    if (this.store.list<ChangeSet>('changeset').some(c => c.proposalId === proposalId)) throw new Error('この提案は適用済みです。');
    for (const id of p.insightIds) if (this.store.get<Insight>(id, 'insight').status !== 'pending') throw new Error('処理対象の気づきの状態が変更されています。');
    const result = this.applyChanges(p.changes, { origin: 'proposal', reason: p.reason, userRequest: decision.note, sources: p.evidenceJournalIds.map(reference => ({ type: 'journal', reference })), proposedBy: 'Journal Review', decision: decision.id }, p.id, decision.id);
    for (const id of p.insightIds) this.store.put('insight', { ...this.store.get<Insight>(id, 'insight'), status: 'processed' });
    return result;
  }
  restoreAsset(assetId: string, revision: number) {
    const old = this.store.revision<Asset>(assetId, revision);
    return this.applyChanges([{ type: 'asset.save', id: assetId, asset: this.assetPayload(old) }], { origin: 'restore', reason: '', userRequest: '', sources: [], proposedBy: '', decision: '' }, undefined, undefined, [{ entityId: assetId, revision }]);
  }
  restoreChangeSet(id: string) {
    const cs = this.store.get<ChangeSet>(id, 'changeset'), operations: Change[] = [], restored: { entityId: string; revision: number }[] = [];
    for (const historyId of [...cs.historyIds].reverse()) {
      const h = this.store.get<History>(historyId, 'history');
      if (h.before === null) {
        if (h.kind === 'binding') operations.push({ type: 'binding.remove', id: h.entityId });
        if (h.kind === 'asset') { const a = this.asset(h.entityId); operations.push({ type: 'asset.save', id: a.id, asset: { ...this.assetPayload(a), body: '処置なし', ...(a.kind === 'role' ? { responsibilities: '処置なし' } : {}) } }); }
      } else {
        restored.push({ entityId: h.entityId, revision: h.before });
        if (h.kind === 'asset') operations.push({ type: 'asset.save', id: h.entityId, asset: this.assetPayload(this.store.revision(h.entityId, h.before)) });
        if (h.kind === 'binding') {
          const b = this.store.revision<Binding>(h.entityId, h.before);
          operations.push(b.active ? { type: 'binding.save', id: b.id, binding: { scope: b.scope, sourceId: b.sourceId, targetId: b.targetId, stageId: b.stageId, purpose: b.purpose } } : { type: 'binding.remove', id: b.id });
        }
        if (h.kind === 'common') { const c = this.store.revision<Common>(h.entityId, h.before); operations.push({ type: 'common.save', projectId: c.projectId, ruleIds: c.ruleIds }); }
      }
    }
    return this.applyChanges(operations, { origin: 'restore', reason: '', userRequest: '', sources: [], proposedBy: '', decision: '' }, undefined, undefined, restored, id);
  }
  diagnostics() {
    const diagnostics: Omit<Diagnostic, keyof Stamp>[] = [];
    for (const b of this.bindings()) {
      try { this.validateBinding(b); } catch (e) { diagnostics.push({ severity: 'error', code: 'reference', target: b.id, message: String(e), evidence: b }); }
    }
    for (const run of this.store.list<Run>('run')) {
      try {
        const snapshot = this.store.get<Snapshot>(run.snapshotId, 'snapshot');
        for (const a of snapshot.assets) this.store.revision(a.id, a.revision);
        this.resolve(snapshot, run.stageId);
      } catch (e) { diagnostics.push({ severity: 'error', code: 'snapshot', target: run.id, message: String(e), evidence: { snapshotId: run.snapshotId } }); }
      const retries = this.store.list<RunEvent>('event').filter(e => e.runId === run.id && e.type === 'transition' && ['retry', 'return', 'reject'].includes((e.data as { transition: { type: string } }).transition.type));
      if (retries.length >= 3) diagnostics.push({ severity: 'warning', code: 'repeated-transition', target: run.id, message: `${retries.length}回のretry・差し戻しがあります。`, evidence: retries.map(e => e.id) });
    }
    return { diagnostics: [...this.store.list<Diagnostic>('diagnostic').filter(d => !d.resolvedAt), ...diagnostics], costs: this.costs() };
  }
  costs() {
    const groups = new Map<string, { runId: string; workflowId: string; workflowRevision: number; boundary: number; projectId?: string; runtime: string; stageId: string; roleIds: string[]; target: string; bytes: number; deliveries: number }>();
    for (const d of this.store.list<Delivery>('delivery').filter(d => d.success)) {
      const run = this.store.get<Run>(d.runId, 'run'), snapshot = this.store.get<Snapshot>(d.snapshotId, 'snapshot');
      const key = `${run.id}/${d.stageId}/${d.roleIds.join(',')}/${d.target}`;
      const row = groups.get(key) ?? { runId: run.id, workflowId: run.workflowId, workflowRevision: run.workflowRevision, boundary: snapshot.boundary, projectId: run.projectId, runtime: run.runtime, stageId: d.stageId, roleIds: d.roleIds, target: d.target, bytes: 0, deliveries: 0 };
      row.bytes += d.bytes; row.deliveries++; groups.set(key, row);
    }
    return [...groups.values()];
  }
}
