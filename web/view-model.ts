import type { Asset, Binding, Change } from '../src/schema.ts';

export function relatedWorkflows(assetId: string, assets: Asset[], bindings: Binding[]) {
  const result: { workflow: Asset; stageId?: string; via: string[]; binding: Binding }[] = [];
  const walk = (target: string, via: string[], visited: Set<string>, attachment?: Binding) => {
    if (visited.has(target)) return;
    const next = new Set(visited).add(target);
    for (const b of bindings.filter(b => b.active && b.targetId === target)) {
      const source = assets.find(a => a.id === b.sourceId);
      if (!source) continue;
      if (source.kind === 'workflow') result.push({ workflow: source, stageId: b.stageId, via, binding: attachment ?? b });
      else walk(source.id, [source.name, ...via], next, attachment ?? b);
    }
  };
  walk(assetId, [], new Set());
  return result;
}

export function stageRoleBindingChanges(workflowId: string, scope: string, assignments: { stageId: string; roleId: string }[], bindings: Binding[]): Change[] {
  const desired = new Map(assignments.filter(a => a.roleId).map(a => [a.stageId, a.roleId]));
  const current = bindings.filter(b => b.active && b.scope === scope && b.sourceId === workflowId && b.purpose === 'stage-role');
  const changes: Change[] = [];
  for (const binding of current) {
    const stageId = binding.stageId ?? '';
    const roleId = desired.get(stageId);
    if (!roleId) changes.push({ type: 'binding.remove', id: binding.id, expectedRevision: binding.revision });
    else if (roleId !== binding.targetId) changes.push({ type: 'binding.save', id: binding.id, expectedRevision: binding.revision, binding: { scope, sourceId: workflowId, stageId, targetId: roleId, purpose: 'stage-role', selectedChoices: {} } });
    desired.delete(stageId);
  }
  for (const [stageId, roleId] of desired) changes.push({ type: 'binding.save', binding: { scope, sourceId: workflowId, stageId, targetId: roleId, purpose: 'stage-role', selectedChoices: {} } });
  return changes;
}

export function stageModelBindingChanges(workflowId: string, scope: string, assignments: { stageId: string; modelId: string; selectedChoices?: Record<string, string> }[], bindings: Binding[]): Change[] {
  const desired = new Map(assignments.filter(a => a.modelId).map(a => [a.stageId, a.modelId]));
  const desiredChoices = new Map(assignments.filter(a => a.modelId).map(a => [a.stageId, a.selectedChoices ?? {}]));
  const current = bindings.filter(b => b.active && b.scope === scope && b.sourceId === workflowId && b.purpose === 'stage-model');
  const changes: Change[] = [];
  for (const binding of current) {
    const stageId = binding.stageId ?? '';
    const modelId = desired.get(stageId);
    if (!modelId) changes.push({ type: 'binding.remove', id: binding.id, expectedRevision: binding.revision });
    else if (modelId !== binding.targetId || JSON.stringify(desiredChoices.get(stageId) ?? {}) !== JSON.stringify(binding.selectedChoices ?? {})) changes.push({ type: 'binding.save', id: binding.id, expectedRevision: binding.revision, binding: { scope, sourceId: workflowId, stageId, targetId: modelId, purpose: 'stage-model', selectedChoices: desiredChoices.get(stageId) ?? {} } });
    desired.delete(stageId);
    desiredChoices.delete(stageId);
  }
  for (const [stageId, modelId] of desired) changes.push({ type: 'binding.save', binding: { scope, sourceId: workflowId, stageId, targetId: modelId, purpose: 'stage-model', selectedChoices: desiredChoices.get(stageId) ?? {} } });
  return changes;
}

export function workflowDiagram(asset: Asset) {
  const nodes = [...asset.stages.map(s => ({ id: s.id, name: s.name })), { id: 'completed', name: '完了' }].map((s, i) => ({ ...s, x: 35 + i * 210, y: 125 }));
  const edges = asset.transitions.map((t, i) => {
    const from = nodes.find(n => n.id === t.from), to = nodes.find(n => n.id === t.to);
    if (!from || !to) return null;
    const x1 = from.x + 80, x2 = to.x + 80, lane = 48 + (i % 3) * 25;
    const self = from.id === to.id;
    return { ...t, path: self ? `M ${x1 - 30} 125 C ${x1 - 95} 25 ${x1 + 95} 25 ${x1 + 30} 125` : x2 > x1 ? `M ${from.x + 160} 149 C ${from.x + 183} ${149 - lane} ${to.x - 22} ${149 - lane} ${to.x} 149` : `M ${x1} 173 C ${x1} ${235 + lane} ${x2} ${235 + lane} ${x2} 173`, labelX: self ? x1 : (x1 + x2) / 2, labelY: self ? 51 : x2 > x1 ? 140 - lane * 0.7 : 218 + lane * 0.65 };
  }).filter(e => e !== null);
  return { nodes, edges, width: Math.max(500, nodes.length * 210 + 30), height: 320 };
}
