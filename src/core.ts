import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { Store } from './store.ts';
import { renderModelChoiceTemplate } from './model-template.ts';
import { assetPatchSchema, assetSchema, bindingSchema, parseJournal } from './schema.ts';
import { journalSkillKey, journalSkillNames, journalSkillUseCases } from './canonical-assets.ts';
import type { Asset, AssetDeletionPreview, Binding, Change, ChangeSet, Common, Context, ContextAsset, ContextStage, Decision, Delivery, Diagnostic, ExecutionPlan, History, Insight, Journal, Project, Proposal, Provenance, ReviewItem, Run, RunEvent, SkillCatalogEntry, SkillLoader, Snapshot, Stamp } from './schema.ts';

export class ConflictError extends Error {
  readonly code = 'CONFLICT';
  readonly details?: { kind: string; id: string; expected?: number; actual?: number };
  constructor(message: string, details?: { kind: string; id: string; expected?: number; actual?: number }) {
    super(`Conflict: ${message}`);
    this.name = 'ConflictError';
    this.details = details;
  }
}

function sameRevisions(a: { id: string; revision: number }[], b: { id: string; revision: number }[]) {
  const sorted = (values: { id: string; revision: number }[]) => [...values].sort((x, y) => x.id.localeCompare(y.id));
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
}

class PreviewAbort extends Error {
  readonly result: ReturnType<Core['applyChanges']>;
  constructor(result: ReturnType<Core['applyChanges']>) { super('preview'); this.result = result; }
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
  private skillCatalogFrom(rootId: string, assets: Iterable<Asset>, bindings: Iterable<Binding>) {
    const assetMap = new Map([...assets].map(asset => [asset.id, asset]));
    const bindingList = [...bindings];
    const entries: SkillCatalogEntry[] = [];
    const loaders: SkillLoader[] = [];
    const visited = new Set<string>();
    const walk = (sourceId: string) => {
      for (const binding of bindingList) {
        if (binding.sourceId !== sourceId || binding.stageId || binding.purpose !== 'reference') continue;
        const target = assetMap.get(binding.targetId);
        if (!target || target.kind !== 'skill' || visited.has(target.id)) continue;
        visited.add(target.id);
        entries.push({ id: target.id, name: target.name, description: target.description });
        loaders.push({
          catalogKey: `aacl:${target.id}:${target.revision}`,
          name: target.name,
          source: 'aacl',
          loader: { type: 'aacl-asset', assetId: target.id, revision: target.revision },
        });
        walk(target.id);
      }
    };
    walk(rootId);
    return { entries, loaders };
  }
  skillCatalog(assetId: string, resolvedRoot?: Asset) {
    const root = resolvedRoot ?? this.asset(assetId);
    if (root.kind !== 'skill') throw new Error('Skillを指定してください。');
    const assets = this.store.list<Asset>('asset').filter(asset => !asset.deletedAt && (asset.scope === 'global' || asset.scope === root.scope));
    return this.skillCatalogFrom(root.id, assets, this.bindings(root.scope));
  }
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
    const asset = this.asset(input.assetId);
    if (journalSkillKey(asset)) throw new Error('JournalとJournal Reviewの標準Skillは削除できません。');
    const preview = this.assetDeletionPreview(input.assetId);
    const bindingRevisions = preview.bindings.map(({ id, revision }) => ({ id, revision }));
    const projectCommonRevisions = preview.projectCommons.map(({ id, revision }) => ({ id, revision }));
    if (preview.asset.revision !== input.expectedRevision || !sameRevisions(bindingRevisions, input.expectedBindingRevisions) || !sameRevisions(projectCommonRevisions, input.expectedProjectCommonRevisions)) {
      throw new Error('Assetまたは参照関係が変わりました。参照一覧を再取得し、削除を確認してください。');
    }
    const changes: Change[] = preview.bindings.map(b => ({ type: 'binding.remove', id: b.id, expectedRevision: b.revision }));
    for (const reference of preview.projectCommons) {
      const common = this.store.get<Common>(reference.id, 'common');
      changes.push({ type: 'common.save', projectId: common.projectId, expectedRevision: common.revision, ruleIds: common.ruleIds.filter(id => id !== input.assetId) });
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
    const selectedChoices = b.selectedChoices ?? {};
    if (Object.keys(selectedChoices).length && (b.purpose !== 'stage-model' || target.kind !== 'model')) throw new Error('Modelの選択肢はWorkflowのStageに指定してください。');
    if (b.purpose === 'stage-model' && target.kind === 'model') {
      const choices = target.choices ?? [], choiceNames = new Set(choices.map(choice => choice.name));
      for (const [name, value] of Object.entries(selectedChoices)) {
        const choice = choices.find(candidate => candidate.name === name);
        if (!choiceNames.has(name) || !choice?.options.includes(value)) throw new Error(`Modelの選択肢「${name}」の値「${value}」は利用できません。`);
      }
      const missing = choices.find(choice => !(choice.name in selectedChoices));
      if (missing) throw new Error(`Modelの選択肢「${missing.name}」を選択してください。`);
    }
    const choiceConditions = b.choiceConditions ?? [];
    if (choiceConditions.length && (source.kind !== 'model' || b.purpose !== 'reference' || !['skill', 'rule'].includes(target.kind))) {
      throw new Error('選択肢条件はModelからSkillまたはRuleへの参照にだけ指定できます。');
    }
    if (source.kind === 'model' && choiceConditions.length) {
      const choices = source.choices ?? [];
      for (const condition of choiceConditions) for (const [name, value] of Object.entries(condition)) {
        const choice = choices.find(candidate => candidate.name === name);
        if (!choice || !choice.options.includes(value)) throw new Error(`Modelの選択肢条件「${name}=${value}」は利用できません。`);
      }
    }
    if (source.id === target.id) throw new Error('Skillの循環参照は登録できません。');
  }
  bindingMatchesChoices(binding: Pick<Binding, 'choiceConditions'>, selectedChoices?: Record<string, string>) {
    const conditions = binding.choiceConditions ?? [];
    if (!conditions.length) return true;
    if (!selectedChoices) return false;
    return conditions.some(condition => Object.entries(condition).every(([name, value]) => selectedChoices[name] === value));
  }
  private validateExpectedRevisions(changes: Change[]) {
    const virtual = new Map<string, number>();
    const current = (kind: string, id: string) => {
      const value = kind === 'common' ? this.store.list<Common>('common').find(c => c.projectId === id) : this.store.maybe<Stamp>(id);
      if (!value) throw new ConflictError(`${kind}の対象が見つかりません: ${id}`, { kind, id });
      const key = `${kind}:${value.id}`;
      const revision = virtual.get(key) ?? value.revision;
      return { key, revision };
    };
    const advance = (kind: string, id: string, expected: number | undefined) => {
      const target = current(kind, id);
      if (expected === undefined) throw new ConflictError(`${kind} ${id} のexpectedRevisionが必要です。最新revisionを取得して再試行してください。`, { kind, id, actual: target.revision });
      if (target.revision !== expected) throw new ConflictError(`${kind} ${id} はrev.${expected}ではなくrev.${target.revision}です。`, { kind, id, expected, actual: target.revision });
      virtual.set(target.key, target.revision + 1);
    };
    for (const change of changes) {
      if (change.type === 'asset.save' && change.id) advance('asset', change.id, change.expectedRevision);
      if (change.type === 'asset.delete') advance('asset', change.id, change.expectedRevision);
      if (change.type === 'binding.save' && change.id) advance('binding', change.id, change.expectedRevision);
      if (change.type === 'binding.remove') advance('binding', change.id, change.expectedRevision);
      if (change.type === 'common.save') {
        advance('common', change.projectId, change.expectedRevision);
      }
    }
  }
  assertStageRoles(workflow: Asset, scope: string) {
    for (const stage of workflow.stages) {
      const assignments = this.bindings(scope).filter(b => b.sourceId === workflow.id && b.stageId === stage.id && b.purpose === 'stage-role');
      if (assignments.length !== 1 || this.asset(assignments[0].targetId).kind !== 'role') throw new Error(`各Stageには担当Roleを1件割り当ててください: ${stage.id}`);
    }
  }
  applyChanges(changes: Change[], provenance: Provenance, proposalId?: string, approvalId?: string, restore?: { entityId: string; revision: number }[], restoresChangeSetId?: string, allowAssetDelete = false, allowJournalSkillSetup = false) {
    const stagedAssets = new Map<string, ReturnType<Core['assetPayload']>>();
    const resolvedChanges = changes.map(change => {
      if (change.type !== 'asset.update') return change;
      const current = stagedAssets.get(change.id) ?? this.assetPayload(this.asset(change.id));
      const patch = assetPatchSchema.parse(change.asset);
      const asset = assetSchema.parse({ ...current, ...patch });
      stagedAssets.set(change.id, asset);
      return {
        type: 'asset.save' as const,
        id: change.id,
        expectedRevision: change.expectedRevision,
        asset,
      };
    });
    if (!allowAssetDelete && resolvedChanges.some(c => c.type === 'asset.delete')) throw new Error('Asset削除は影響一覧を確認した後、専用の削除操作から確定してください。');
    for (const change of resolvedChanges) {
      if (change.type === 'asset.delete' && journalSkillKey(this.asset(change.id))) throw new Error('JournalとJournal Reviewの標準Skillは削除できません。');
    }
    this.validateExpectedRevisions(resolvedChanges);
    for (const change of resolvedChanges.filter((c): c is Extract<Change, { type: 'asset.delete' }> => c.type === 'asset.delete')) {
      const preview = this.assetDeletionPreview(change.id);
      const bindingRevisions = preview.bindings.map(({ id, revision }) => ({ id, revision }));
      const projectCommonRevisions = preview.projectCommons.map(({ id, revision }) => ({ id, revision }));
      if (!change.confirmed || preview.asset.revision !== change.expectedRevision || !sameRevisions(bindingRevisions, change.expectedBindingRevisions) || !sameRevisions(projectCommonRevisions, change.expectedProjectCommonRevisions)) {
        throw new Error('Assetまたは参照関係が変わりました。参照一覧を再取得し、削除を確認してください。');
      }
      for (const reference of preview.bindings) if (!resolvedChanges.some(c => c.type === 'binding.remove' && c.id === reference.id)) throw new Error('削除前に参照する紐づけを解除してください。');
      for (const reference of preview.projectCommons) {
        const commonChange = resolvedChanges.find(c => c.type === 'common.save' && c.projectId === reference.projectId);
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
    for (const change of resolvedChanges) {
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
          const utility = journalSkillKey(old);
          if (utility) {
            if (a.name !== journalSkillNames[utility]) throw new Error(`標準Skill「${journalSkillNames[utility]}」の名前は変更できません。`);
            if (a.metadata.aaclUtility !== utility) throw new Error(`標準Skill「${journalSkillNames[utility]}」の識別情報は変更できません。`);
            if (!allowJournalSkillSetup && utility === 'journal' && a.useCase !== journalSkillUseCases[utility]) throw new Error(`標準Skill「${journalSkillNames[utility]}」の直接起動設定は変更できません。`);
          }
          if (a.kind === 'workflow') for (const b of this.bindings().filter(b => b.sourceId === change.id && b.stageId)) {
            if (!a.stages.some(s => s.id === b.stageId)) throw new Error('削除するStageの紐づけを先に解除してください。');
          }
        } else if (journalSkillKey(a) && !allowJournalSkillSetup) {
          throw new Error('JournalとJournal Reviewの標準Skill識別情報は予約されています。');
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
    const changeSet = this.store.put('changeset', { id: changeSetId, operations: resolvedChanges, provenanceId: p.id, historyIds: histories.map(h => h.id), proposalId, approvalId, restoresChangeSetId });
    return { changeSet, entities };
  }
  previewChanges(changes: Change[], provenance: Provenance) {
    try {
      this.store.atomic(() => {
        const result = this.applyChanges(changes, provenance);
        throw new PreviewAbort(result);
      });
    } catch (error) {
      if (error instanceof PreviewAbort) {
        return {
          valid: true,
          changeCount: changes.length,
          affected: error.result.entities.map(entity => ({ id: entity.id, revision: entity.revision })),
        };
      }
      if (error instanceof ConflictError) return { valid: false, error: { code: error.code, message: error.message, details: error.details } };
      return { valid: false, error: { code: 'INVALID_CHANGESET', message: error instanceof Error ? error.message : String(error) } };
    }
  }
  initProject(root: string, name: string) {
    root = normalizeRoot(root);
    if (this.store.list<Project>('project').some(p => p.root === root)) throw new Error('このProject rootは登録済みです。');
    const project = this.store.put('project', { name, root });
    const common = this.store.put('common', { projectId: project.id, ruleIds: [] }, project.id);
    const originals = this.bindings('global');
    const result = this.applyChanges(originals.map(b => ({ type: 'binding.save', binding: { scope: project.id, sourceId: b.sourceId, targetId: b.targetId, stageId: b.stageId, purpose: b.purpose, selectedChoices: b.selectedChoices ?? {}, choiceConditions: b.choiceConditions ?? [] } })), {
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
    const stageModelBinding = stageModelBindings[0];
    const stageModelId = stageModelBinding?.targetId;
    const modelSelections = stageModelBinding?.selectedChoices ?? {};
    const assets = new Map(snapshot.assets.map(a => [a.id, a]));
    const chosen = new Map<string, Asset>(), resolution: Context['resolution'] = [];
    const seen = new Set<string>();
    const walk = (assetId: string, path: string[], stack: Set<string>, reason: string, selectedChoices?: Record<string, string>) => {
      if (stack.has(assetId)) throw new Error(`循環参照: ${[...path, assetId].join(' → ')}`);
      const a = assets.get(assetId);
      if (!a) throw new Error(`必須参照を取得できません: ${assetId}`);
      resolution.push({ assetId, revision: a.revision, path: [...path, assetId], reason });
      chosen.set(assetId, a);
      if (seen.has(assetId)) return;
      seen.add(assetId);
      const next = new Set(stack).add(assetId);
      for (const b of bindings.filter(b => b.sourceId === assetId && !b.stageId)) {
        if (a.kind === 'model' && !this.bindingMatchesChoices(b, selectedChoices)) continue;
        walk(b.targetId, [...path, assetId, `${b.id}@${b.revision}`], next, b.choiceConditions?.length ? '選択肢条件に一致した明示的な紐づけ' : '明示的な紐づけ');
      }
    };
    for (const b of bindings.filter(b => b.sourceId === workflow.id && (!b.stageId || b.stageId === stageId))) {
      const target = assets.get(b.targetId);
      const selected = target?.kind === 'model' && b.stageId === stageId ? b.selectedChoices : undefined;
      walk(b.targetId, [workflow.id, ...(b.stageId ? [b.stageId] : []), `${b.id}@${b.revision}`], new Set([workflow.id]), b.stageId ? 'Stageの直接参照' : 'Workflowの直接参照', selected);
    }
    for (const id of common?.ruleIds ?? []) walk(id, [`Project Common@${common!.revision}`], new Set(), 'Project Common');
    if (chosen.get(stageRoleId)?.kind !== 'role') throw new Error(`このStageの担当Roleを取得できません: ${stageId}`);
    if (roleId && (!chosen.has(roleId) || chosen.get(roleId)?.kind !== 'role')) throw new Error('このStageで利用対象になっているRoleを指定してください。');
    const model = stageModelId ? chosen.get(stageModelId) : undefined;
    if (stageModelId && model?.kind !== 'model') throw new Error(`このStageのModelを取得できません: ${stageId}`);
    const contextStage = ({ description: _description, ...contextStage }: Asset['stages'][number]): ContextStage => contextStage;
    const contextAsset = ({ description: _description, stages, ...contextAsset }: Asset): ContextAsset => ({ ...contextAsset, stages: stages.map(contextStage) });
    const contextModel = model?.kind === 'model' ? { ...contextAsset(model), modelName: renderModelChoiceTemplate(model.modelName, modelSelections), invocationMethod: renderModelChoiceTemplate(model.invocationMethod, modelSelections) } : undefined;
    return {
      runId: snapshot.runId, workflow: contextAsset(workflow), stage: contextStage(stage), stageRoleId,
      ...(contextModel ? { model: contextModel } : {}),
      ...(model ? { modelSelections } : {}),
      roles: [...chosen.values()].filter(a => a.kind === 'role').map(contextAsset),
      rules: [...chosen.values()].filter(a => a.kind === 'rule').map(contextAsset),
      skillCatalog: [...chosen.values()].filter(a => a.kind === 'skill').map(({ id, name, description }) => ({ id, name, description })),
      skillLoaders: [...chosen.values()].filter(a => a.kind === 'skill').map(({ id, name, revision }) => ({
        catalogKey: `aacl:${id}:${revision}`,
        name,
        source: 'aacl' as const,
        loader: { type: 'aacl-asset' as const, assetId: id, revision },
      })),
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
    const visit = (source: string, stack: Set<string>, selectedChoices?: Record<string, string>) => {
      if (stack.has(source)) throw new Error('循環参照を検出しました。');
      const sourceAsset = this.asset(source);
      const visitKey = sourceAsset.kind === 'model' ? `${source}:${JSON.stringify(selectedChoices ?? {})}` : source;
      if (visited.has(visitKey)) return;
      visited.add(visitKey);
      const next = new Set(stack).add(source);
      for (const b of allBindings.filter(b => b.sourceId === source)) {
        this.validateBinding(b);
        if (sourceAsset.kind === 'model' && !this.bindingMatchesChoices(b, selectedChoices)) continue;
        const target = this.asset(b.targetId);
        const targetChoices = sourceAsset.kind === 'workflow' && target.kind === 'model' && b.stageId ? b.selectedChoices : undefined;
        needed.add(b.targetId); visit(b.targetId, next, targetChoices);
      }
    };
    visit(workflow.id, new Set());
    for (const ruleId of common?.ruleIds ?? []) if (this.asset(ruleId).kind !== 'rule') throw new Error('Project CommonにRule以外の参照があります。');
    const assets = [...needed].map(id => this.asset(id));
    const bindings = allBindings.filter(b => needed.has(b.sourceId) && needed.has(b.targetId));
    const runId = randomUUID(), snapshotId = randomUUID(), contextHandle = randomUUID();
    const draft = { id: snapshotId, runId, boundary: this.store.boundary(), workflow, assets, bindings, common, project, runtime: input.runtime } as Snapshot;
    for (const stage of workflow.stages) this.resolve(draft, stage.id);
    const initialBaseContext = this.resolve(draft, workflow.entryStage);
    const initialSubagentId = initialBaseContext.model ? randomUUID() : undefined;
    const initialContext = this.resolve(draft, workflow.entryStage, undefined, initialSubagentId ? { id: initialSubagentId, continuity: 'new' } : undefined);
    const snapshot = this.store.put('snapshot', { ...draft, initialContext });
    const run = this.store.put('run', { id: runId, contextHandle, workflowId: workflow.id, workflowRevision: workflow.revision, projectId: project?.id, snapshotId,
      stageId: workflow.entryStage, status: 'active' as const, version: 1, runtime: input.runtime, instruction: input.instruction, target: input.target,
      lastActivity: new Date().toISOString(),
      ...(initialBaseContext.model ? { subagentId: initialSubagentId, subagentRoleId: initialBaseContext.stageRoleId, subagentModelId: initialBaseContext.model.id, subagentContinuity: 'new' as const } : {}),
    }, scope);
    this.event(run, 'started', { snapshotId, ...(initialBaseContext.model ? { subagentId: initialSubagentId, modelId: initialBaseContext.model.id } : {}) });
    return { run, contextHandle, nextExecution: this.executionPlan(run, snapshot), snapshotId: snapshot.id };
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
  executionPlan(run: Run, snapshot: Snapshot): ExecutionPlan | undefined {
    if (run.status !== 'active') return undefined;
    const context = this.resolve(snapshot, run.stageId, undefined, run.subagentId && run.subagentContinuity ? { id: run.subagentId, continuity: run.subagentContinuity } : undefined);
    return {
      runId: run.id, contextHandle: run.contextHandle, version: run.version,
      stage: { id: context.stage.id, name: context.stage.name },
      executor: context.model ? 'subagent' : 'orchestrator',
      ...(context.model ? { model: { id: context.model.id, name: context.model.name, modelName: context.model.modelName, invocationMethod: context.model.invocationMethod, selections: context.modelSelections ?? {} } } : {}),
      ...(context.subagent ? { subagent: context.subagent } : {}),
    };
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
  private loadSkill(assetId: string, revision?: number) {
    const current = this.store.maybe<Asset>(assetId);
    const requestedRevision = revision ?? current?.revision;
    try {
      const asset = revision === undefined ? this.asset(assetId) : this.store.revision<Asset>(assetId, revision);
      if (asset.kind !== 'skill') throw new Error('Skillを指定してください。');
      if (asset.deletedAt) throw new Error('削除済みAssetは利用できません。');
      return asset;
    } catch (error) {
      const name = current?.name ?? '(unknown)';
      const cause = error instanceof Error ? error.message : String(error);
      throw new Error(`AACL Skill取得失敗: name=${name}, assetId=${assetId}, revision=${requestedRevision ?? 'unknown'}: ${cause}`);
    }
  }
  skillGet(assetId: string, revision?: number) {
    const asset = this.loadSkill(assetId, revision);
    const catalog = this.skillCatalog(asset.id, asset);
    return { id: asset.id, name: asset.name, description: asset.description, revision: asset.revision, body: asset.body, skillCatalog: catalog.entries, skillLoaders: catalog.loaders };
  }
  private skillBody(asset: Asset, file?: string) {
    return file === undefined ? asset.body : asset.supportingFiles[file];
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
    const result = { available: true, id: asset.id, name: asset.name, description: asset.description, revision: asset.revision, file, body: this.skillBody(asset, file) };
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
    const nextExecution = this.executionPlan(result, snapshot);
    return { outcome: 'applied', run: result, ...(nextExecution ? { nextExecution } : {}) };
  }
  endRun(handle: string, status: 'cancelled' | 'failed', reason: string) {
    const run = this.run(handle);
    if (run.status !== 'active') throw new Error('このRunは終了しています。');
    const result = this.store.put('run', { ...run, status, version: run.version + 1 }, run.projectId ?? 'global');
    this.event(result, status, { reason });
    return { run: result };
  }
  settings() {
    const current = this.store.maybe<{ id: string; timeoutHours?: number; journalEnabled?: boolean }>('settings');
    return { id: 'settings', timeoutHours: current?.timeoutHours ?? 24, journalEnabled: current?.journalEnabled ?? true };
  }
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
  reviewRunInspect(journalId: string) {
    const journal = this.store.get<Journal>(journalId, 'journal');
    const hasReviewItem = this.store.list<ReviewItem>('review-item').some(item => item.journalId === journal.id);
    const hasInsight = this.store.list<Insight>('insight').some(insight => insight.journalId === journal.id);
    if (!hasReviewItem && !hasInsight) throw new Error('Review経由で取得したJournalを指定してください。');
    if (!journal.runId) throw new Error('Journalに関連するRunがありません。');
    const run = this.store.get<Run>(journal.runId, 'run');
    if (run.status === 'active') throw new Error('進行中のRunはJournal Review inspectionの対象外です。');
    const snapshot = this.store.get<Snapshot>(run.snapshotId, 'snapshot');
    const assets = snapshot.assets.map(asset => ({ id: asset.id, kind: asset.kind, name: asset.name, revision: asset.revision }));
    return {
      journalId: journal.id,
      run,
      snapshot: { id: snapshot.id, boundary: snapshot.boundary, runtime: snapshot.runtime, assets },
      deliveries: this.store.list<Delivery>('delivery').filter(delivery => delivery.runId === run.id).map(delivery => ({
        target: delivery.target, revision: delivery.assetRevision, success: delivery.success, bytes: delivery.bytes,
      })),
      events: this.store.list<RunEvent>('event').filter(event => event.runId === run.id).map(event => ({ type: event.type, timestamp: event.createdAt })),
    };
  }
  writeJournal(input: { body: string; contextHandle?: string; postRunId?: string; task?: string }) {
    if (!this.settings().journalEnabled) throw new Error('Journal記録が無効です。設定でJournal記録を有効にしてください。');
    if (input.contextHandle && input.postRunId) throw new Error('Handleと終了後Run IDはどちらか一方を指定してください。');
    const run = input.contextHandle ? this.run(input.contextHandle) : input.postRunId ? this.store.get<Run>(input.postRunId, 'run') : undefined;
    if (input.postRunId && run?.status === 'active') throw new Error('進行中のRunにはContext Handleを使ってください。');
    const parsed = parseJournal(input.body);
    const task = input.task?.trim() || parsed.sections.Task?.trim() || '';
    if (!run && !task) throw new Error('Runを指定しないJournalにはTaskが必要です。');
    const snapshot = run ? this.store.get<Snapshot>(run.snapshotId, 'snapshot') : undefined;
    const journal = this.store.put('journal', { raw: input.body, parsed, task, reviewStatus: 'pending' as const, runId: run?.id, snapshotId: snapshot?.id, projectId: run?.projectId,
      stageId: run?.stageId, workflowRevision: snapshot?.workflow.revision, assetRevisions: snapshot?.assets.map(a => ({ id: a.id, revision: a.revision })),
      bindingRevisions: snapshot?.bindings.map(b => ({ id: b.id, revision: b.revision })),
    }, run?.projectId ?? 'global');
    const insights = parsed.insights.map(i => this.store.put('insight', { journalId: journal.id, ...i, status: 'pending' as const }));
    for (const insight of insights) this.store.put('review-item', { journalId: journal.id, journalTaskId: journal.id, insightId: insight.id, projectId: journal.projectId, heading: insight.heading, body: insight.body, status: 'pending' as const, lastDecision: 'none' as const, proposalIds: [] }, journal.projectId ?? 'global');
    return { journal, insights };
  }
  private reviewItemForInsight(insightId: string, create = false) {
    const existing = this.store.list<ReviewItem>('review-item').find(item => item.insightId === insightId);
    if (existing || !create) return existing;
    const insight = this.store.get<Insight>(insightId, 'insight'), journal = this.store.get<Journal>(insight.journalId, 'journal');
    return this.store.put('review-item', { journalId: journal.id, journalTaskId: journal.id, insightId: insight.id, projectId: journal.projectId, heading: insight.heading, body: insight.body, status: insight.status, lastDecision: insight.status === 'processed' ? 'approved' as const : insight.status === 'rejected' ? 'rejected' as const : 'none' as const, proposalIds: [] }, journal.projectId ?? 'global');
  }
  private updateJournalReviewStatus(journalId: string) {
    const journal = this.store.get<Journal>(journalId, 'journal'), items = this.store.list<ReviewItem>('review-item').filter(item => item.journalId === journalId);
    const reviewStatus = items.some(item => item.status === 'pending') || !items.length ? 'pending' as const : items.some(item => item.status === 'processed') ? 'processed' as const : 'rejected' as const;
    if (journal.reviewStatus === reviewStatus) return journal;
    return this.store.put('journal', { ...journal, reviewStatus }, journal.projectId ?? 'global');
  }
  private proposalSummary(proposal: Proposal) {
    const { changes: _changes, ...summary } = proposal;
    return summary;
  }
  private updateReviewState(insightId: string, status: Insight['status'], lastDecision: ReviewItem['lastDecision'], note = '') {
    const insight = this.store.get<Insight>(insightId, 'insight'), item = this.reviewItemForInsight(insightId, true)!;
    const updatedInsight = this.store.put('insight', { ...insight, status });
    const updatedItem = this.store.put('review-item', { ...item, status, lastDecision, lastNote: note }, item.projectId ?? 'global');
    const journalTask = this.updateJournalReviewStatus(item.journalId);
    return { reviewItem: updatedItem, insight: updatedInsight, journalTask };
  }
  updateInsightStatus(insightId: string, status: Insight['status']) {
    const decision: ReviewItem['lastDecision'] = status === 'processed' ? 'approved' : status === 'rejected' ? 'rejected' : 'none';
    return this.updateReviewState(insightId, status, decision);
  }
  decideReview(input: { reviewItemId: string; decision: Exclude<ReviewItem['lastDecision'], 'none'>; note: string }) {
    const stored = this.store.maybe<ReviewItem>(input.reviewItemId), item = stored?.insightId ? stored : this.reviewItemForInsight(input.reviewItemId, true);
    if (!item) throw new Error(`Review項目が見つかりません: ${input.reviewItemId}`);
    const status: Insight['status'] = input.decision === 'approved' ? 'processed' : input.decision === 'rejected' ? 'rejected' : 'pending';
    return this.updateReviewState(item.insightId, status, input.decision, input.note);
  }
  decideReviewBulk(updates: { reviewItemId: string; decision: Exclude<ReviewItem['lastDecision'], 'none'>; note: string }[]) {
    const ids = new Set<string>();
    const results = [];
    for (const update of updates) {
      if (ids.has(update.reviewItemId)) throw new Error('一括判断に同じReview項目を重複指定できません。');
      ids.add(update.reviewItemId);
      results.push(this.decideReview(update));
    }
    return { updates: results };
  }
  journalList(input: { projectId?: string; limit?: number; cursor?: string | null; includeBodies?: boolean } = {}) {
    const allJournals = this.store.list<Journal>('journal').filter(journal => !input.projectId || journal.projectId === input.projectId || !journal.projectId);
    const cursorIndex = input.cursor ? allJournals.findIndex(journal => journal.id === input.cursor) : -1;
    const start = cursorIndex < 0 ? 0 : cursorIndex + 1;
    const page = allJournals.slice(start, start + (input.limit ?? 20));
    const pageIds = new Set(page.map(journal => journal.id));
    const pageInsights = this.store.list<Insight>('insight').filter(insight => pageIds.has(insight.journalId));
    const journals = page.map(journal => {
      if (input.includeBodies) return journal;
      const { raw: _raw, parsed: _parsed, ...summary } = journal;
      const insights = pageInsights.filter(insight => insight.journalId === journal.id);
      return { ...summary, insightCount: insights.length, pendingInsightCount: insights.filter(insight => insight.status === 'pending').length };
    });
    const insights = pageInsights.map(insight => input.includeBodies ? insight : (() => {
      const { body: _body, ...summary } = insight;
      return summary;
    })());
    return { journals, insights, total: allJournals.length, nextCursor: start + page.length < allJournals.length ? page.at(-1)?.id ?? null : null };
  }
  review(input: { status?: ReviewItem['status']; projectId?: string; include?: ('journalTask' | 'insights' | 'proposalRefs')[]; includeBodies?: boolean; includeChanges?: boolean; limit?: number; cursor?: string | null } = {}) {
    const include = input.include ?? ['journalTask', 'insights', 'proposalRefs'], includeBodies = input.includeBodies ?? false;
    const allInsights = this.store.list<Insight>('insight'), journalsById = new Map(this.store.list<Journal>('journal').map(journal => [journal.id, journal])), insightItems = new Map(this.store.list<ReviewItem>('review-item').map(item => [item.insightId, item]));
    const items = allInsights.map(insight => insightItems.get(insight.id) ?? this.reviewItemForInsight(insight.id, false) ?? ({ id: insight.id, revision: insight.revision, createdAt: insight.createdAt, updatedAt: insight.updatedAt, journalId: insight.journalId, journalTaskId: insight.journalId, insightId: insight.id, projectId: journalsById.get(insight.journalId)?.projectId, heading: insight.heading, body: insight.body, status: insight.status, lastDecision: insight.status === 'processed' ? 'approved' : insight.status === 'rejected' ? 'rejected' : 'none', proposalIds: [] } as ReviewItem)).filter(item => !input.status || item.status === input.status).filter(item => !input.projectId || item.projectId === input.projectId);
    const cursorIndex = input.cursor ? items.findIndex(item => item.id === input.cursor) : -1;
    const start = cursorIndex < 0 ? 0 : cursorIndex + 1, page = items.slice(start, start + (input.limit ?? 100));
    const journals = include.includes('journalTask') ? this.store.list<Journal>('journal').filter(journal => page.some(item => item.journalTaskId === journal.id)).map(journal => {
      if (includeBodies) return journal;
      const { raw: _raw, parsed: _parsed, ...summary } = journal;
      return summary;
    }) : [];
    const insights = include.includes('insights') ? allInsights.filter(insight => page.some(item => item.insightId === insight.id)).map(insight => includeBodies ? insight : { ...insight, body: '' }) : [];
    const proposalIds = [...new Set(page.flatMap(item => item.proposalIds ?? []))];
    const proposalRefs = include.includes('proposalRefs') ? this.store.list<Proposal>('proposal').filter(proposal => proposalIds.includes(proposal.id)).map(proposal => input.includeChanges ? proposal : this.proposalSummary(proposal)) : [];
    const reviewItems = page.map(({ body, ...item }) => includeBodies ? { ...item, body } : item);
    return { reviewItems, journals, insights, proposalRefs, nextCursor: start + page.length < items.length ? page.at(-1)?.id ?? null : null };
  }
  history(input: { entityId?: string; changeSetId?: string; limit?: number; cursor?: string | null; includeDetails?: boolean } = {}) {
    if (input.entityId) {
      return {
        histories: this.store.list<History>('history').filter(history => history.entityId === input.entityId),
        revisions: this.store.revisions(input.entityId),
        changeSets: this.store.list<ChangeSet>('changeset'),
        provenance: this.store.list<Provenance>('provenance'),
      };
    }
    const allChangeSets = this.store.list<ChangeSet>('changeset');
    const selected = input.changeSetId
      ? allChangeSets.filter(changeSet => changeSet.id === input.changeSetId)
      : (() => {
          const cursorIndex = input.cursor ? allChangeSets.findIndex(changeSet => changeSet.id === input.cursor) : -1;
          const start = cursorIndex < 0 ? 0 : cursorIndex + 1;
          return allChangeSets.slice(start, start + (input.limit ?? 20));
        })();
    const selectedIds = new Set(selected.map(changeSet => changeSet.id));
    const histories = this.store.list<History>('history').filter(history => selectedIds.has(history.changeSetId));
    const provenanceIds = new Set(selected.map(changeSet => changeSet.provenanceId));
    const provenance = this.store.list<Provenance & { id: string }>('provenance').filter(item => provenanceIds.has(item.id));
    const changeSets = selected.map(changeSet => {
      if (input.includeDetails || input.changeSetId) return changeSet;
      const { operations: _operations, ...summary } = changeSet;
      return summary;
    });
    const cursorIndex = input.cursor ? allChangeSets.findIndex(changeSet => changeSet.id === input.cursor) : -1;
    const start = cursorIndex < 0 ? 0 : cursorIndex + 1;
    const hasMore = !input.changeSetId && start + selected.length < allChangeSets.length;
    return { histories, revisions: [], changeSets, provenance, nextCursor: hasMore ? selected.at(-1)?.id ?? null : null };
  }
  reviewItemGet(reviewItemId: string, includeChanges = false) {
    const stored = this.store.maybe<ReviewItem>(reviewItemId), item = stored?.insightId ? stored : this.reviewItemForInsight(reviewItemId, true);
    if (!item) throw new Error(`Review項目が見つかりません: ${reviewItemId}`);
    const journal = this.store.get<Journal>(item.journalTaskId, 'journal'), insight = this.store.get<Insight>(item.insightId, 'insight'), proposalIds: string[] = item.proposalIds ?? [];
    const proposals = this.store.list<Proposal>('proposal').filter(proposal => proposalIds.includes(proposal.id)).map(proposal => includeChanges ? proposal : this.proposalSummary(proposal));
    return { reviewItem: item, journalTask: journal, insight, proposals };
  }
  proposalGet(proposalId: string, includeChanges = false) {
    const proposal = this.store.get<Proposal>(proposalId, 'proposal'), decision = this.store.list<Decision>('decision').find(item => item.proposalId === proposalId);
    return { proposal: includeChanges ? proposal : this.proposalSummary(proposal), decision, changeSets: this.store.list<ChangeSet>('changeset').filter(changeSet => changeSet.proposalId === proposalId) };
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
    const proposal = this.store.put('proposal', { ...input, id: proposalId });
    for (const id of input.insightIds) {
      const item = this.reviewItemForInsight(id, true)!;
      this.store.put('review-item', { ...item, proposalIds: [...new Set([...(item.proposalIds ?? []), proposal.id])] }, item.projectId ?? 'global');
    }
    return { proposal };
  }
  decideProposal(proposalId: string, choice: Decision['choice'], note: string) {
    const proposal = this.store.get<Proposal>(proposalId, 'proposal');
    if (this.store.list<ChangeSet>('changeset').some(c => c.proposalId === proposalId)) throw new Error('適用済みの提案です。');
    for (const id of proposal.insightIds) if (this.store.get<Insight>(id, 'insight').status !== 'pending') throw new Error('処理対象の気づきの状態が変更されています。');
    const decision = this.store.put('decision', { proposalId, choice, note });
    const updates = proposal.insightIds.map(id => this.updateReviewState(id, choice === 'rejected' ? 'rejected' : 'pending', choice === 'approved' ? 'approved' : choice === 'deferred' ? 'deferred' : 'rejected', note));
    return { decision, updates };
  }
  applyProposal(proposalId: string) {
    const p = this.store.get<Proposal>(proposalId, 'proposal');
    const decision = this.store.list<Decision>('decision').find(d => d.proposalId === proposalId);
    if (decision?.choice !== 'approved') throw new Error('この提案は承認されていません。');
    if (this.store.list<ChangeSet>('changeset').some(c => c.proposalId === proposalId)) throw new Error('この提案は適用済みです。');
    for (const id of p.insightIds) if (this.store.get<Insight>(id, 'insight').status !== 'pending') throw new Error('処理対象の気づきの状態が変更されています。');
    const result = this.applyChanges(p.changes, { origin: 'proposal', reason: p.reason, userRequest: decision.note, sources: p.evidenceJournalIds.map(reference => ({ type: 'journal', reference })), proposedBy: 'Journal Review', decision: decision.id }, p.id, decision.id);
    const reviewUpdates = p.insightIds.map(id => this.updateReviewState(id, 'processed', 'approved', decision.note));
    return { ...result, reviewUpdates };
  }
  restoreAsset(assetId: string, revision: number, expectedRevision: number) {
    const old = this.store.revision<Asset>(assetId, revision);
    return this.applyChanges([{ type: 'asset.save', id: assetId, expectedRevision, asset: this.assetPayload(old) }], { origin: 'restore', reason: '', userRequest: '', sources: [], proposedBy: '', decision: '' }, undefined, undefined, [{ entityId: assetId, revision }]);
  }
  restoreChangeSet(id: string) {
    const cs = this.store.get<ChangeSet>(id, 'changeset'), histories = cs.historyIds.map(historyId => this.store.get<History>(historyId, 'history'));
    const latest = new Map<string, number>();
    for (const history of histories) latest.set(`${history.kind}:${history.entityId}`, history.after);
    for (const [key, expected] of latest) {
      const [kind, entityId] = key.split(':', 2), current = this.store.maybe<Stamp>(entityId);
      if (!current || current.revision !== expected) throw new ConflictError(`${kind} ${entityId} はChange Set適用後のrev.${expected}から変更されています。復元を中止しました。`, { kind, id: entityId, expected, actual: current?.revision });
    }
    const current = new Map(latest);
    const operations: Change[] = [], restored: { entityId: string; revision: number }[] = [];
    const expectedRevision = (kind: string, entityId: string) => {
      const key = `${kind}:${entityId}`, revision = current.get(key);
      if (revision === undefined) throw new ConflictError(`${kind} ${entityId} の現在revisionを確認できません。`, { kind, id: entityId });
      current.set(key, revision + 1);
      return revision;
    };
    for (const h of [...histories].reverse()) {
      if (h.before === null) {
        if (h.kind === 'binding') operations.push({ type: 'binding.remove', id: h.entityId, expectedRevision: expectedRevision('binding', h.entityId) });
        if (h.kind === 'asset') { const a = this.asset(h.entityId, true); operations.push({ type: 'asset.save', id: a.id, expectedRevision: expectedRevision('asset', h.entityId), asset: { ...this.assetPayload(a), body: '処置なし', ...(a.kind === 'role' ? { responsibilities: '処置なし' } : {}) } }); }
      } else {
        restored.push({ entityId: h.entityId, revision: h.before });
        if (h.kind === 'asset') operations.push({ type: 'asset.save', id: h.entityId, expectedRevision: expectedRevision('asset', h.entityId), asset: this.assetPayload(this.store.revision(h.entityId, h.before)) });
        if (h.kind === 'binding') {
          const b = this.store.revision<Binding>(h.entityId, h.before);
          operations.push(b.active ? { type: 'binding.save', id: b.id, expectedRevision: expectedRevision('binding', b.id), binding: { scope: b.scope, sourceId: b.sourceId, targetId: b.targetId, stageId: b.stageId, purpose: b.purpose, selectedChoices: b.selectedChoices ?? {}, choiceConditions: b.choiceConditions ?? [] } } : { type: 'binding.remove', id: b.id, expectedRevision: expectedRevision('binding', b.id) });
        }
        if (h.kind === 'common') { const c = this.store.revision<Common>(h.entityId, h.before); operations.push({ type: 'common.save', projectId: c.projectId, expectedRevision: expectedRevision('common', h.entityId), ruleIds: c.ruleIds }); }
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
      const transitions = this.store.list<RunEvent>('event').filter(e => e.runId === run.id && e.type === 'transition');
      const counts = new Map<string, number>();
      for (const event of transitions) {
        const transition = (event.data as { transition: { id: string } }).transition;
        counts.set(transition.id, (counts.get(transition.id) ?? 0) + 1);
      }
      const repeated = transitions.filter(event => {
        const transition = (event.data as { transition: { id: string; from: string; to: string } }).transition;
        return transition.from === transition.to || (counts.get(transition.id) ?? 0) >= 3;
      });
      if (repeated.length >= 3) diagnostics.push({ severity: 'warning', code: 'repeated-transition', target: run.id, message: `${repeated.length}回の自己ループ・同一遷移の反復があります。`, evidence: repeated.map(e => e.id) });
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
