import type { AssetSummary, Binding, Change } from '../src/schema.ts';

export function diagnosticAssetId(evidence: unknown) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return undefined;
  const assetId = (evidence as { assetId?: unknown }).assetId;
  return typeof assetId === 'string' ? assetId : undefined;
}

export function diagnosticAsset(evidence: unknown, assets: AssetSummary[]) {
  const assetId = diagnosticAssetId(evidence);
  return assetId ? assets.find(asset => asset.id === assetId) : undefined;
}

export function relatedWorkflows(assetId: string, assets: AssetSummary[], bindings: Binding[]) {
  const result: { workflow: AssetSummary; stageId?: string; via: string[]; binding: Binding }[] = [];
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

function stageBindingChanges(workflowId: string, scope: string, purpose: 'stage-role' | 'stage-model', assignments: { stageId: string; targetId: string; selectedChoices?: Record<string, string> }[], bindings: Binding[]): Change[] {
  const desired = new Map(assignments.filter(a => a.targetId).map(a => [a.stageId, {
    scope, sourceId: workflowId, stageId: a.stageId, targetId: a.targetId, purpose,
    selectedChoices: a.selectedChoices ?? {}, choiceConditions: [],
  }]));
  const current = bindings.filter(b => b.active && b.scope === scope && b.sourceId === workflowId && b.purpose === purpose);
  const changes: Change[] = [];
  for (const binding of current) {
    const stageId = binding.stageId ?? '';
    const next = desired.get(stageId), choices = binding.selectedChoices ?? {};
    if (!next) changes.push({ type: 'binding.remove', id: binding.id, expectedRevision: binding.revision });
    else if (next.targetId !== binding.targetId || Object.keys(next.selectedChoices).length !== Object.keys(choices).length || Object.entries(next.selectedChoices).some(([key, value]) => choices[key] !== value)) {
      changes.push({ type: 'binding.save', id: binding.id, expectedRevision: binding.revision, binding: next });
    }
    desired.delete(stageId);
  }
  for (const binding of desired.values()) changes.push({ type: 'binding.save', binding });
  return changes;
}

export function stageRoleBindingChanges(workflowId: string, scope: string, assignments: { stageId: string; roleId: string }[], bindings: Binding[]): Change[] {
  return stageBindingChanges(workflowId, scope, 'stage-role', assignments.map(a => ({ stageId: a.stageId, targetId: a.roleId })), bindings);
}

export function stageModelBindingChanges(workflowId: string, scope: string, assignments: { stageId: string; modelId: string; selectedChoices?: Record<string, string> }[], bindings: Binding[]): Change[] {
  return stageBindingChanges(workflowId, scope, 'stage-model', assignments.map(a => ({ stageId: a.stageId, targetId: a.modelId, selectedChoices: a.selectedChoices })), bindings);
}

export function workflowDiagram(asset: AssetSummary) {
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
