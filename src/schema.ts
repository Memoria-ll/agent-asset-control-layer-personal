import { z } from 'zod';

export const text = z.string().trim().min(1);
export const id = z.uuid();
export const scope = z.union([z.literal('global'), id]);

function withoutTaskType(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const { taskType: _taskType, ...rest } = value as Record<string, unknown>;
  return rest;
}

export function normalizeAssetRecord(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = { ...record };
  const oldTaskType = typeof record.taskType === 'string' ? record.taskType : '';
  const oldDescription = typeof record.description === 'string' ? record.description : '';
  delete normalized.taskType;
  if (Array.isArray(normalized.stages)) normalized.stages = normalized.stages.map(withoutTaskType);
  if (record.kind === 'skill') {
    normalized.description = oldTaskType.trim() || oldDescription;
    normalized.explanation = typeof record.explanation === 'string' ? record.explanation : oldDescription;
  } else {
    delete normalized.explanation;
  }
  return normalized;
}

export const stageSchema = z.preprocess(withoutTaskType, z.object({
  id: text, name: text, completion_condition: text,
  additionalInstructions: z.string().default(''), description: z.string().default(''),
}).strict());
export const transitionSchema = z.object({
  id: text, from: text, to: text,
  type: z.enum(['next', 'return', 'retry', 'reject', 'complete']), label: text,
}).strict();
const assetInputSchema = z.object({
  kind: z.enum(['workflow', 'skill', 'role', 'rule', 'model']),
  name: text, description: text, body: z.string().default(''),
  responsibilities: z.string().default(''), scope: scope.default('global'),
  explanation: z.string().optional(), useCase: z.boolean().default(false),
  modelName: z.string().default(''), invocationMethod: z.string().default(''),
  metadata: z.record(z.string(), z.unknown()).default({}),
  supportingFiles: z.record(z.string(), z.string()).default({}),
  stages: z.array(stageSchema).default([]),
  transitions: z.array(transitionSchema).default([]),
  entryStage: z.string().default(''),
}).strict();

export const assetSchema = z.preprocess(normalizeAssetRecord, assetInputSchema).superRefine((a, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (a.kind === 'skill' && !a.body.trim()) fail('Skillの本文は必須です。');
  if (a.kind === 'skill' && !(a.explanation ?? '').trim()) fail('Skillの説明は必須です。');
  if (a.kind === 'model' && !a.modelName.trim()) fail('Model名は必須です。');
  if (a.kind === 'model' && !a.invocationMethod.trim()) fail('呼び出し方は必須です。');
  if (a.kind !== 'skill' && a.useCase) fail('直接起動を設定できるのはSkillです。');
  if (a.kind === 'workflow') {
    const stages = new Set(a.stages.map(s => s.id));
    if (!stages.size || stages.size !== a.stages.length) fail('Stageは1件以上で、IDは重複できません。');
    if (stages.has('completed') || !stages.has(a.entryStage)) fail('開始Stageを指定してください。completedは終端用の予約語です。');
    if (new Set(a.transitions.map(t => t.id)).size !== a.transitions.length) fail('遷移IDは重複できません。');
    for (const t of a.transitions) {
      if (!stages.has(t.from) || (!stages.has(t.to) && t.to !== 'completed')) fail('遷移先・遷移元が存在しません。');
      if ((t.type === 'complete') !== (t.to === 'completed')) fail('完了遷移の行き先はcompletedです。');
      if (t.type === 'retry' && t.from !== t.to) fail('retryは同じStageへの遷移です。');
    }
  }
  for (const path of Object.keys(a.supportingFiles)) {
    if (path.startsWith('/') || path.includes('\\') || path.split('/').some(p => p === '..' || !p)) fail('補助ファイルには安全な相対名を指定してください。');
  }
  if (Object.keys(a.metadata).some(k => /^(model|capability|password|secret|token|credential)/i.test(k))) fail('Model・Capability・認証情報はmetadataの管理対象外です。');
  const content = JSON.stringify(a);
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,})\b/.test(content)) fail('認証情報をAssetへ保存できません。');
});
export const bindingSchema = z.object({
  scope: scope.default('global'), sourceId: id, stageId: text.optional(), targetId: id,
  purpose: z.enum(['reference', 'entry-role', 'stage-role', 'stage-model']).default('reference'),
}).strict();
export const provenanceSchema = z.object({
  origin: z.enum(['ui', 'ai', 'cli', 'restore', 'proposal', 'init']),
  reason: z.string().default(''), userRequest: z.string().default(''),
  sources: z.array(z.object({ type: text, reference: text }).strict()).default([]),
  proposedBy: z.string().default(''), decision: z.string().default(''),
}).strict().superRefine((p, ctx) => {
  if (p.origin === 'ai' && (!p.reason.trim() || !p.userRequest.trim())) ctx.addIssue({ code: 'custom', message: 'AIによる変更には依頼と変更理由が必要です。' });
});
export const changeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('asset.delete'), id, expectedRevision: z.int().positive(), expectedBindingRevisions: z.array(z.object({ id, revision: z.int().positive() }).strict()), expectedProjectCommonRevisions: z.array(z.object({ id, revision: z.int().positive() }).strict()), confirmed: z.literal(true) }).strict(),
  z.object({ type: z.literal('asset.save'), id: id.optional(), asset: assetSchema }).strict(),
  z.object({ type: z.literal('asset.create'), id, asset: assetSchema }).strict(),
  z.object({ type: z.literal('binding.save'), id: id.optional(), binding: bindingSchema }).strict(),
  z.object({ type: z.literal('binding.remove'), id }).strict(),
  z.object({ type: z.literal('common.save'), projectId: id, ruleIds: z.array(id) }).strict(),
]);
export const journalHeadings = ['Task', '実際に使ったもの', '良かった点', '困った点', '改善の種', '根拠・確かさ', '日付', 'Project', 'Branch', 'Type'] as const;
export const journalTemplate = journalHeadings.map(h => `## ${h}\n`).join('\n');
export function parseJournal(raw: string) {
  const sections: Record<string, string> = {};
  const fragments: { heading: string; body: string }[] = [];
  let heading = '', lines: string[] = [], fence = '';
  const flush = () => {
    const body = lines.join('\n');
    fragments.push({ heading, body });
    if ((journalHeadings as readonly string[]).includes(heading)) sections[heading] = [sections[heading], body].filter(v => v !== undefined).join('\n');
    lines = [];
  };
  for (const line of raw.split(/\r?\n/)) {
    const code = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (code) { if (!fence) fence = code[1]; else if (code[1][0] === fence[0] && code[1].length >= fence.length) fence = ''; }
    const match = !fence && !code && line.match(/^## ([^\r\n]+)$/);
    if (match) { flush(); heading = match[1]; } else lines.push(line);
  }
  flush();
  const insights = fragments.filter(f => ['良かった点', '困った点', '改善の種'].includes(f.heading))
    .flatMap(f => f.body.split(/\n\s*\n/).filter(s => s.trim()).map(body => ({ heading: f.heading, body })));
  return { raw, sections, fragments, insights };
}

export interface Stamp { id: string; revision: number; createdAt: string; updatedAt: string }
export type Asset = z.infer<typeof assetSchema> & Stamp & { deletedAt?: string };
export interface AssetDeletionPreview {
  asset: Pick<Asset, 'id' | 'name' | 'kind' | 'scope' | 'revision'>;
  bindings: { id: string; revision: number; scope: string; sourceId: string; sourceName: string; targetId: string; targetName: string; stageId?: string; stageName?: string; purpose: Binding['purpose']; direction: 'outgoing' | 'incoming' }[];
  projectCommons: { id: string; revision: number; projectId: string; projectName: string }[];
}
export type Binding = z.infer<typeof bindingSchema> & Stamp & { active: boolean; copiedFrom?: { id: string; revision: number } };
export type Change = z.infer<typeof changeSchema>;
export type Provenance = z.infer<typeof provenanceSchema>;
export interface Project extends Stamp { name: string; root: string }
export interface Common extends Stamp { projectId: string; ruleIds: string[] }
export interface Run extends Stamp {
  contextHandle: string; workflowId: string; workflowRevision: number; projectId?: string;
  snapshotId: string; stageId: string; status: 'active' | 'completed' | 'cancelled' | 'failed';
  version: number; runtime: string; instruction: string; target: string; lastActivity: string;
  subagentId?: string; subagentRoleId?: string; subagentModelId?: string; subagentContinuity?: 'new' | 'same';
}
export interface Resolution { assetId: string; revision: number; path: string[]; reason: string }
export interface Context {
  runId: string; workflow: Asset; stage: z.infer<typeof stageSchema>; stageRoleId: string;
  model?: Asset; roles: Asset[]; rules: Asset[]; skillCatalog: { id: string; name: string; description: string }[];
  subagent?: { id: string; roleId: string; modelId: string; continuity: 'new' | 'same'; instruction: string };
  resolution: Resolution[]; unavailable: { target: string; reason: string }[];
}
export interface Snapshot extends Stamp {
  runId: string; boundary: number; workflow: Asset; assets: Asset[]; bindings: Binding[];
  common: Common | null; project: Project | null; runtime: string; initialContext: Context;
}
export interface Delivery extends Stamp { runId: string; snapshotId: string; stageId: string; roleIds: string[]; target: string; assetRevision?: number; path: string[]; success: boolean; content: unknown; reason?: string; bytes: number }
export interface RunEvent extends Stamp { runId: string; type: string; data: unknown }
export interface Journal extends Stamp { raw: string; parsed: ReturnType<typeof parseJournal>; task: string; reviewStatus: 'pending' | 'processed' | 'rejected'; runId?: string; snapshotId?: string; projectId?: string; stageId?: string; workflowRevision?: number; assetRevisions?: { id: string; revision: number }[]; bindingRevisions?: { id: string; revision: number }[] }
export interface Insight extends Stamp { journalId: string; heading: string; body: string; status: 'pending' | 'processed' | 'rejected' }
export interface ReviewItem extends Stamp { journalId: string; journalTaskId: string; insightId: string; projectId?: string; heading: string; body: string; status: 'pending' | 'processed' | 'rejected'; lastDecision: 'none' | 'approved' | 'deferred' | 'rejected'; lastNote?: string; proposalIds: string[] }
export interface Proposal extends Stamp { title: string; observedContext: string; proposedChange: string; reason: string; evidenceJournalIds: string[]; reviewedJournalIds: string[]; affectedAssetIds: string[]; affectedBindingIds: string[]; affectedProjectIds: string[]; changes: Change[]; insightIds: string[] }
export interface Decision extends Stamp { proposalId: string; choice: 'approved' | 'deferred' | 'rejected'; note: string }
export interface History extends Stamp { entityId: string; kind: string; before: number | null; after: number; changeSetId: string; restoredFrom?: number }
export interface ChangeSet extends Stamp { operations: Change[]; provenanceId: string; historyIds: string[]; proposalId?: string; approvalId?: string; restoresChangeSetId?: string }
export interface RuntimeTarget extends Stamp { runtime: 'claude' | 'codex'; scope: string; path: string; enabled: boolean; platform: 'wsl' | 'windows' }
export interface Diagnostic extends Stamp { severity: 'info' | 'warning' | 'error'; code: string; target: string; message: string; evidence: unknown; resolvedAt?: string }
