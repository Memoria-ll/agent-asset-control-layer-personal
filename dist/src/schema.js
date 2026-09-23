import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { modelChoiceTemplateNames } from './model-template.js';
import { journalSkillKey } from './canonical-assets.js';
export const text = z.string().trim().min(1);
export const id = z.uuid();
export const scope = z.union([z.literal('global'), id]);
export const revision = z.int().positive();
function withoutTaskType(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return value;
    const { taskType: _taskType, ...rest } = value;
    return rest;
}
function legacyChoiceOptionId(assetId, choiceName, index, value) {
    const hex = [...createHash('sha256').update(`${assetId}\0${choiceName}\0${index}\0${value}`).digest('hex').slice(0, 32)];
    hex[12] = '8';
    hex[16] = ((Number.parseInt(hex[16], 16) & 3) | 8).toString(16);
    const valueId = hex.join('');
    return `${valueId.slice(0, 8)}-${valueId.slice(8, 12)}-${valueId.slice(12, 16)}-${valueId.slice(16, 20)}-${valueId.slice(20)}`;
}
export function normalizeAssetRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return value;
    const record = value;
    const normalized = { ...record };
    const oldTaskType = typeof record.taskType === 'string' ? record.taskType : '';
    const oldDescription = typeof record.description === 'string' ? record.description : '';
    delete normalized.taskType;
    if (record.kind === 'model' && Array.isArray(normalized.choices))
        normalized.choices = normalized.choices.map(choice => {
            if (!choice || typeof choice !== 'object' || Array.isArray(choice))
                return choice;
            const item = choice, options = Array.isArray(item.options) ? item.options : [];
            if (Array.isArray(item.optionIds))
                return item;
            return {
                ...item,
                optionIds: options.map((option, index) => typeof option === 'string' && typeof record.id === 'string'
                    ? legacyChoiceOptionId(record.id, typeof item.name === 'string' ? item.name : '', index, option)
                    : randomUUID()),
            };
        });
    if (Array.isArray(normalized.stages)) {
        const completionConditions = new Map(normalized.stages.map(stage => {
            const value = withoutTaskType(stage);
            const item = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
            return [typeof item.id === 'string' ? item.id : '', typeof item.completion_condition === 'string' ? item.completion_condition : ''];
        }));
        normalized.stages = normalized.stages.map(stage => {
            const value = withoutTaskType(stage);
            const item = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
            const { completion_condition: _completionCondition, ...current } = item;
            return current;
        });
        if (Array.isArray(normalized.transitions))
            normalized.transitions = normalized.transitions.map(transition => {
                if (!transition || typeof transition !== 'object' || Array.isArray(transition))
                    return transition;
                const item = transition;
                const { type: oldType, ...current } = item;
                if (typeof current.condition === 'string' && current.condition.trim())
                    return current;
                if (typeof oldType !== 'string')
                    return current;
                const from = typeof current.from === 'string' ? current.from : '';
                const previous = completionConditions.get(from) ?? '';
                const condition = oldType === 'complete' || oldType === 'next'
                    ? previous || '現在の工程の成果を次の工程へ渡せる'
                    : oldType === 'retry'
                        ? '現在の成果では次へ進めず、同じ工程で再作業が必要'
                        : '前の工程へ戻して修正が必要';
                return { ...current, condition };
            });
    }
    if (record.kind === 'skill') {
        normalized.description = oldTaskType.trim() || oldDescription;
        normalized.explanation = typeof record.explanation === 'string' ? record.explanation : oldDescription;
        if (record.implicitInvocation === undefined)
            normalized.implicitInvocation = false;
    }
    else {
        delete normalized.explanation;
    }
    return normalized;
}
export const stageSchema = z.preprocess(withoutTaskType, z.object({
    id: text, name: text,
    additionalInstructions: z.string().default(''), description: z.string().default(''),
}).strict());
export const transitionSchema = z.object({
    id: text, from: text, to: text, condition: text, label: text,
}).strict();
export const modelChoiceSchema = z.preprocess(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return value;
    const item = value;
    return Array.isArray(item.options) && !Array.isArray(item.optionIds)
        ? { ...item, optionIds: item.options.map(() => randomUUID()) }
        : value;
}, z.object({
    name: text,
    options: z.array(text).min(1),
    optionIds: z.array(id).min(1),
}).strict().superRefine((choice, ctx) => {
    if (choice.options.length !== choice.optionIds.length)
        ctx.addIssue({ code: 'custom', message: `Modelの選択肢「${choice.name}」の値とIDの数が一致しません。` });
    if (new Set(choice.optionIds).size !== choice.optionIds.length)
        ctx.addIssue({ code: 'custom', message: `Modelの選択肢「${choice.name}」のIDは重複できません。` });
}));
const assetInputSchema = z.object({
    kind: z.enum(['workflow', 'skill', 'role', 'rule', 'model']),
    name: text, description: text, body: z.string().default(''),
    responsibilities: z.string().default(''), scope: scope.default('global'),
    explanation: z.string().optional(), useCase: z.boolean().default(false),
    implicitInvocation: z.boolean().default(false),
    modelName: z.string().default(''), invocationMethod: z.string().default(''),
    choices: z.array(modelChoiceSchema).default([]),
    metadata: z.record(z.string(), z.unknown()).default({}),
    supportingFiles: z.record(z.string(), z.string()).default({}),
    stages: z.array(stageSchema).default([]),
    transitions: z.array(transitionSchema).default([]),
    entryStage: z.string().default(''),
}).strict();
export const assetPatchSchema = z.object({
    kind: z.enum(['workflow', 'skill', 'role', 'rule', 'model']).optional(),
    name: text.optional(), description: text.optional(), body: z.string().optional(),
    responsibilities: z.string().optional(), scope: scope.optional(),
    explanation: z.string().optional(), useCase: z.boolean().optional(),
    implicitInvocation: z.boolean().optional(),
    modelName: z.string().optional(), invocationMethod: z.string().optional(),
    choices: z.array(modelChoiceSchema).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    supportingFiles: z.record(z.string(), z.string()).optional(),
    stages: z.array(stageSchema).optional(), transitions: z.array(transitionSchema).optional(),
    entryStage: z.string().optional(),
}).strict().superRefine((value, ctx) => {
    if (Object.keys(value).length === 0)
        ctx.addIssue({ code: 'custom', message: '更新するAsset fieldを1件以上指定してください。' });
});
export const assetSchema = z.preprocess(normalizeAssetRecord, assetInputSchema).superRefine((a, ctx) => {
    const fail = (message) => ctx.addIssue({ code: 'custom', message });
    if (a.kind === 'skill' && !a.body.trim())
        fail('Skillの本文は必須です。');
    if (a.kind === 'skill' && !(a.explanation ?? '').trim())
        fail('Skillの説明は必須です。');
    if (a.kind === 'model' && !a.modelName.trim())
        fail('Model名は必須です。');
    if (a.kind === 'model' && !a.invocationMethod.trim())
        fail('呼び出し方は必須です。');
    if (a.kind === 'model') {
        const choiceNames = a.choices.map(choice => choice.name);
        if (new Set(choiceNames).size !== choiceNames.length)
            fail('Modelの選択肢名は重複できません。');
        for (const choice of a.choices)
            if (new Set(choice.options).size !== choice.options.length)
                fail(`Modelの選択肢「${choice.name}」の値は重複できません。`);
        if (new Set(a.choices.flatMap(choice => choice.optionIds)).size !== a.choices.reduce((count, choice) => count + choice.optionIds.length, 0))
            fail('Modelの選択肢IDは重複できません。');
        const knownChoices = new Set(choiceNames);
        for (const [field, template] of [['modelName', a.modelName], ['invocationMethod', a.invocationMethod]]) {
            try {
                for (const name of modelChoiceTemplateNames(template))
                    if (!knownChoices.has(name))
                        fail(`${field}の選択肢テンプレート「${name}」は定義されていません。`);
            }
            catch (error) {
                fail(error instanceof Error ? error.message : String(error));
            }
        }
    }
    if (a.kind !== 'skill' && a.useCase)
        fail('直接起動を設定できるのはSkillです。');
    if (a.kind !== 'skill' && a.implicitInvocation)
        fail('自動発火を設定できるのはSkillです。');
    if (journalSkillKey(a) && a.implicitInvocation)
        fail('標準のJournal Skillは自動発火を有効にできません。');
    if (a.kind === 'workflow') {
        const stages = new Set(a.stages.map(s => s.id));
        if (!stages.size || stages.size !== a.stages.length)
            fail('Stageは1件以上で、IDは重複できません。');
        if (stages.has('completed') || !stages.has(a.entryStage))
            fail('開始Stageを指定してください。completedは終端用の予約語です。');
        if (new Set(a.transitions.map(t => t.id)).size !== a.transitions.length)
            fail('遷移IDは重複できません。');
        for (const t of a.transitions) {
            if (!stages.has(t.from) || (!stages.has(t.to) && t.to !== 'completed'))
                fail('遷移先・遷移元が存在しません。');
        }
    }
    for (const path of Object.keys(a.supportingFiles)) {
        const error = supportingFilePathError(path);
        if (error)
            fail(error);
    }
    if (Object.keys(a.metadata).some(k => /^(model|capability|password|secret|token|credential)/i.test(k)))
        fail('Model・Capability・認証情報はmetadataの管理対象外です。');
    const content = JSON.stringify(a);
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,})\b/.test(content))
        fail('認証情報をAssetへ保存できません。');
});
export function supportingFilePathError(path) {
    if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.includes('\\') || path.includes('\0'))
        return '補助ファイルには安全な相対名を指定してください。';
    if (path.split('/').some(part => part === '..' || part === '.' || !part))
        return '補助ファイルには安全な相対名を指定してください。';
    if (path === 'SKILL.md')
        return `補助ファイルの予約パスは使用できません: ${path}`;
    return undefined;
}
export const bindingSchema = z.object({
    scope: scope.default('global'), sourceId: id, stageId: text.optional(), targetId: id,
    purpose: z.enum(['reference', 'entry-role', 'stage-role', 'stage-model']).default('reference'),
    selectedChoices: z.record(z.string(), text).default({}),
    selectedChoiceIds: z.record(z.string(), id).default({}),
    choiceConditions: z.array(z.record(z.string(), text)).default([]),
    choiceConditionIds: z.array(z.record(z.string(), id)).default([]),
}).strict();
export const provenanceSchema = z.object({
    origin: z.enum(['ui', 'ai', 'cli', 'restore', 'proposal', 'init']),
    reason: z.string().default(''), userRequest: z.string().default(''),
    sources: z.array(z.object({ type: text, reference: text }).strict()).default([]),
    proposedBy: z.string().default(''), decision: z.string().default(''),
}).strict().superRefine((p, ctx) => {
    if (p.origin === 'ai' && (!p.reason.trim() || !p.userRequest.trim()))
        ctx.addIssue({ code: 'custom', message: 'AIによる変更には依頼と変更理由が必要です。' });
});
export const changeSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('asset.delete'), id, expectedRevision: revision, expectedBindingRevisions: z.array(z.object({ id, revision }).strict()), expectedProjectCommonRevisions: z.array(z.object({ id, revision }).strict()), confirmed: z.literal(true) }).strict(),
    z.object({ type: z.literal('asset.save'), id: id.optional(), expectedRevision: revision.optional(), asset: assetSchema }).strict(),
    z.object({ type: z.literal('asset.update'), id, expectedRevision: revision, asset: assetPatchSchema }).strict(),
    z.object({ type: z.literal('asset.create'), id, asset: assetSchema }).strict(),
    z.object({ type: z.literal('binding.save'), id: id.optional(), expectedRevision: revision.optional(), binding: bindingSchema }).strict(),
    z.object({ type: z.literal('binding.remove'), id, expectedRevision: revision }).strict(),
    z.object({ type: z.literal('common.save'), projectId: id, expectedRevision: revision, ruleIds: z.array(id) }).strict(),
]);
export const journalHeadings = ['Task', '実際に使ったもの', '良かった点', '困った点', '改善の種', '根拠・確かさ', '日付', 'Project', 'Branch', 'Type'];
export const journalTemplate = [
    '## Task',
    '',
    '## 実際に使ったもの',
    'tools: []',
    'skills: []',
    'rules: []',
    '',
    '## 良かった点',
    '',
    '## 困った点',
    '',
    '## 改善の種',
    '',
    '## 根拠・確かさ',
    '',
    '## 日付',
    '',
    '## Project',
    '',
    '## Branch',
    '',
    '## Type',
].join('\n');
export function parseJournal(raw) {
    const sections = {};
    const fragments = [];
    let heading = '', lines = [], fence = '';
    const flush = () => {
        const body = lines.join('\n');
        fragments.push({ heading, body });
        if (journalHeadings.includes(heading))
            sections[heading] = [sections[heading], body].filter(v => v !== undefined).join('\n');
        lines = [];
    };
    for (const line of raw.split(/\r?\n/)) {
        const code = line.match(/^\s{0,3}(`{3,}|~{3,})/);
        if (code) {
            if (!fence)
                fence = code[1];
            else if (code[1][0] === fence[0] && code[1].length >= fence.length)
                fence = '';
        }
        const match = !fence && !code && line.match(/^## ([^\r\n]+)$/);
        if (match) {
            flush();
            heading = match[1];
        }
        else
            lines.push(line);
    }
    flush();
    const insights = fragments.filter(f => ['良かった点', '困った点', '改善の種'].includes(f.heading))
        .flatMap(f => f.body.split(/\n\s*\n/).filter(s => s.trim()).map(body => ({ heading: f.heading, body })));
    return { raw, sections, fragments, insights };
}
