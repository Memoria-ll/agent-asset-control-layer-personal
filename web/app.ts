import type { Asset, AssetDeletionPreview, Binding, Change, ChangeSet, Common, Decision, Delivery, Diagnostic, History, Insight, Journal, Project, Proposal, Provenance, ReviewItem, Run, RunEvent, RuntimeTarget, Snapshot } from '../src/schema.ts';
import { relatedWorkflows, stageModelBindingChanges, stageRoleBindingChanges, workflowDiagram } from './view-model.ts';
import { localizeHtml, type Language } from './i18n.ts';

const app = document.querySelector<HTMLDivElement>('#app')!;
const dialog = document.querySelector<HTMLDialogElement>('#dialog')!;
const kinds = { workflow: 'Workflow', skill: 'Skill', role: 'Role', rule: 'Rule', model: 'Model' };
const symbols = { workflow: '◇', skill: '✧', role: '◉', rule: '≡', model: 'M' };
const states: Record<string, string> = { active: '進行中', completed: '完了', cancelled: '中止', failed: '終了・失敗', pending: '保留', processed: '処理済み', rejected: '却下', approved: '承認', deferred: '保留' };
const reviewDecisionLabels: Record<string, string> = { approved: '処理済み', deferred: '保留', rejected: '却下' };
const navs = [['assets', '資産ライブラリ', 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z'], ['runs', 'Workflow Run', 'M5 5h5v5H5zM14 14h5v5h-5zM10 7h6v7'], ['journals', 'Journal', 'M5 4h14v16H5zM8 8h8M8 12h8M8 16h5'], ['review', 'Journal Review', 'M4 12a8 8 0 1 0 3-6M4 4v5h5M9 12l2 2 4-4'], ['history', '変更履歴', 'M4 12a8 8 0 1 0 3-6M4 4v5h5M12 7v5l3 2'], ['diagnostics', '診断', 'M3 12h4l3-7 4 14 3-7h4'], ['settings', '設定・接続', 'M4 7h16M4 17h16M8 4v6M16 14v6']];
let assets: Asset[] = [], projects: Project[] = [], bindings: Binding[] = [];
let selectedScope = 'global', filter = 'all', search = '', loading = false;
let assetScrollTop = 0;
let language: Language = localStorage.getItem('aacl-language') === 'ja' ? 'ja' : 'en';
let screenData: Record<string, unknown> = {};
let toastTimer: ReturnType<typeof setTimeout>;
const htmlText = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const esc = (value: unknown) => htmlText(value).replace(/[^\x00-\x7F]/gu, c => `&#x${c.codePointAt(0)!.toString(16)};`);
const date = (value: string) => new Date(value).toLocaleString(language === 'en' ? 'en-US' : 'ja-JP', { dateStyle: 'short', timeStyle: 'short' });
const name = (id: string) => assets.find(a => a.id === id)?.name ?? id;
const journalSkillKey = (asset: Asset) => asset.kind === 'skill' && (asset.metadata.aaclUtility === 'journal' || asset.metadata.aaclUtility === 'journal-review') ? asset.metadata.aaclUtility : undefined;
const labelScope = (id: string) => id === 'global' ? 'Global' : projects.find(p => p.id === id)?.name ?? id;
const icon = (path: string) => `<svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;
const badge = (text: string, color = '') => `<span class="badge ${color}">${htmlText(text)}</span>`;
const status = (s: string) => badge(states[s] ?? s, ['completed', 'approved', 'processed', 'active'].includes(s) ? 'green' : ['failed', 'rejected'].includes(s) ? 'red' : 'amber');
const button = (action: string, label: string, cls = '') => `<button type="button" class="${cls}" data-action="${esc(action)}">${htmlText(label)}</button>`;
const empty = (title: string, description: string, action = '', compact = false) => `<div class="empty ${compact ? 'small' : ''}"><div class="empty-symbol" aria-hidden="true">◇</div><h2>${htmlText(title)}</h2><p>${htmlText(description)}</p>${action}</div>`;
const details = (title: string, data: unknown) => `<details><summary>${htmlText(title)}</summary><pre>${esc(JSON.stringify(data, null, 2))}</pre></details>`;
const opt = (value: string, label: string, selected?: string) => `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${htmlText(label)}</option>`;
const info = (_label: string, explanation: string) => `<button type="button" class="info-button" aria-label="説明を表示" data-tooltip="${htmlText(explanation)}">i</button>`;
const field = (label: string, key: string, value = '', required = true, type = 'text', explanation = '') => `<label><span class="field-label">${htmlText(label)}${explanation ? info(label, explanation) : ''}</span><input aria-label="${htmlText(label)}" name="${key}" type="${type}" value="${esc(value)}" translate="no"${required ? ' required' : ''}></label>`;
const area = (label: string, key: string, value = '', required = true, code = false, explanation = '') => `<label><span class="field-label">${htmlText(label)}${explanation ? info(label, explanation) : ''}</span><textarea aria-label="${htmlText(label)}" name="${key}" translate="no"${required ? ' required' : ''}${code ? ' class="code-input" spellcheck="false"' : ''}>${esc(value)}</textarea></label>`;
const select = (label: string, key: string, options: string, required = false, explanation = '') => `<label><span class="field-label">${htmlText(label)}${explanation ? info(label, explanation) : ''}</span><select aria-label="${htmlText(label)}" name="${key}" translate="no"${required ? ' required' : ''}>${options}</select></label>`;
const formEnd = (label = '保存する') => `<p class="form-error" role="alert"></p><div class="form-footer">${button('close', 'キャンセル')}<button class="primary" type="submit">${htmlText(label)}</button></div>`;
const provenance = (request: string): Provenance => ({ origin: 'ui', userRequest: request, reason: '', sources: [], proposedBy: '', decision: '' });
const route = () => (location.hash.slice(1) || 'assets').split('/');
const recordPageSize = 20;
type JournalSummary = Omit<Journal, 'raw' | 'parsed'> & { insightCount?: number; pendingInsightCount?: number };
type ReviewSummary = Omit<ReviewItem, 'body'>;
type ChangeSetSummary = Omit<ChangeSet, 'operations'>;
let recordRouteKey = '';
let recordGeneration = 0;
let recordLoading = false;
let recordObserver: IntersectionObserver | undefined;
let journalListState: { journals: JournalSummary[]; insights: Omit<Insight, 'body'>[]; nextCursor: string | null } = { journals: [], insights: [], nextCursor: null };
let reviewListState: { reviewItems: ReviewSummary[]; journals: JournalSummary[]; insights: Omit<Insight, 'body'>[]; nextCursor: string | null } = { reviewItems: [], journals: [], insights: [], nextCursor: null };
let historyListState: { histories: History[]; changeSets: ChangeSetSummary[]; provenance: (Provenance & { id: string })[]; nextCursor: string | null } = { histories: [], changeSets: [], provenance: [], nextCursor: null };
function notify(message: string) { const t = document.querySelector('#toast')!; t.textContent = message; t.classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('visible'), 5000); }
async function api<T>(operation: string, input: object = {}, write = false): Promise<T> {
  const response = await fetch(`/api/${operation}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(write ? { ...input, operationId: crypto.randomUUID() } : input) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  if (data.runtimeSync?.failureCount > 0) notify('保存しました。Runtime入口の生成に失敗があります。診断を確認してください。');
  return data as T;
}
function modal(title: string, html: string, layout = '') { dialog.dataset.layout = layout; dialog.innerHTML = localizeHtml(`<div class="dialog-head"><h2>${htmlText(title)}</h2>${button('close', '×', 'icon-button')}</div>${html}`, language); if (!dialog.open) dialog.showModal(); }
function pageHeading(title: string, description: string, action = '') { return `<header class="page-heading"><div><h1>${title}</h1><p>${description}</p></div>${action}</header>`; }
function shell(content: string, contentClass = '') {
  const [page] = route();
  app.innerHTML = localizeHtml(`<div class="shell"><aside class="sidebar"><a class="brand" href="#assets"><span class="brand-mark">Λ</span><div><div class="brand-name">AACL</div><small>AGENT ASSET CONTROL LAYER</small></div></a><div class="nav-label">ワークスペース</div><nav>${navs.slice(0, 4).map(([key, title, path]) => `<a href="#${key}" class="nav-item ${page === key ? 'active' : ''}"${page === key ? ' aria-current="page"' : ''}>${icon(path)}${title}</a>`).join('')}</nav><div class="nav-label">管理</div><nav>${navs.slice(4, 6).map(([key, title, path]) => `<a href="#${key}" class="nav-item ${page === key ? 'active' : ''}">${icon(path)}${title}</a>`).join('')}</nav><div class="sidebar-bottom"><a class="nav-item ${page === 'settings' ? 'active' : ''}" href="#settings">${icon(navs[6][2])}設定・接続</a><div class="connection"><span class="dot"></span>ローカルに接続済み</div></div></aside><main class="main"><div class="topbar"><div class="breadcrumb">ワークスペース &nbsp; / &nbsp; <span>${esc(labelScope(selectedScope))}</span></div><div class="topbar-controls"><label class="scope-select"><span class="mono">SCOPE</span><select id="scope-select" aria-label="管理先" translate="no">${opt('global', 'Global', selectedScope)}${projects.map(p => opt(p.id, p.name, selectedScope)).join('')}</select></label><label class="language-select"><span class="mono">言語</span><select id="language-select" aria-label="言語" translate="no"><option value="en"${language === 'en' ? ' selected' : ''}>英語</option><option value="ja"${language === 'ja' ? ' selected' : ''}>日本語</option></select></label></div></div><div class="main-content ${contentClass}">${content}<div class="footer-note">AACL · あなたの開発方法を、あなたの手で。</div></div></main></div>`, language);
  document.documentElement.lang = language;
}
async function refresh() {
  if (loading) return;
  loading = true;
  recordObserver?.disconnect();
  recordObserver = undefined;
  recordRouteKey = '';
  recordGeneration += 1;
  try {
    const [a, p, b] = await Promise.all([api<{ assets: Asset[] }>('asset.list', { includeBody: true }), api<{ projects: Project[] }>('project.list'), api<{ bindings: Binding[] }>('binding.list', { scope: selectedScope })]);
    assets = a.assets; projects = p.projects; bindings = b.bindings;
    await render();
  } catch (error) { shell(`<div class="glass error-panel"><h2>読み込めませんでした</h2><p>${esc((error as Error).message)}</p>${button('refresh', '再読み込み')}</div>`); }
  finally { loading = false; }
}
function diagram(asset: Asset) {
  const d = workflowDiagram(asset);
  return `<div class="diagram"><svg width="${d.width}" height="${d.height}" viewBox="0 0 ${d.width} ${d.height}" role="img" aria-label="${esc(asset.name)}の許可遷移"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#819cab"/></marker></defs>${d.edges.map(e => `<path class="edge ${e.from === e.to ? 'loop' : e.to === 'completed' ? 'complete' : ''}" d="${e.path}" marker-end="url(#arrow)"/><text class="edge-label" x="${e.labelX}" y="${e.labelY}" text-anchor="middle">${esc(e.label)} · ${esc(e.condition)}</text>`).join('')}${d.nodes.map((n, i) => `<rect class="${n.id === 'completed' ? 'end-node' : 'node'}" x="${n.x}" y="125" width="160" height="48" rx="13"/><text class="node-label" x="${n.x + 80}" y="154" text-anchor="middle">${esc(n.name.length > 13 ? n.name.slice(0, 13) + '…' : n.name)}</text><text class="node-number" x="${n.x + 80}" y="115" text-anchor="middle">${n.id === asset.entryStage ? '開始' : n.id === 'completed' ? '終端' : `STAGE ${i + 1}`}</text>`).join('')}</svg></div>`;
}
function bindingRows(asset: Asset, stageId?: string) {
  const direct = bindings.filter(b => b.sourceId === asset.id && b.stageId === stageId);
  const indirect = direct.flatMap(b => assets.find(a => a.id === b.targetId)?.kind === 'role' ? bindings.filter(v => v.sourceId === b.targetId).map(v => ({ binding: v, role: name(b.targetId) })) : []);
  return direct.map(b => {
    const target = assets.find(a => a.id === b.targetId);
    const condition = asset.kind === 'model' && b.purpose === 'reference' && target ? `<small>適用条件: ${esc(choiceConditionSummary(asset, b.choiceConditions ?? []))}</small>` : '';
    return `<div class="relation"><div><a href="#assets/${b.targetId}">${esc(name(b.targetId))}</a><small>${b.purpose === 'stage-role' ? '担当Role' : b.purpose === 'stage-model' ? 'StageのModel（サブエージェント）' : b.purpose === 'entry-role' ? '入口のRole' : '直接参照'}</small>${condition}</div><div class="row">${button(`binding-edit:${b.id}`, '付け替え', 'small ghost')}${b.purpose === 'stage-role' || b.purpose === 'stage-model' ? '' : button(`binding-remove:${b.id}`, '解除', 'small ghost')}</div></div>`;
  }).join('') + indirect.map(({ binding: b, role }) => `<div class="relation"><div><a href="#assets/${b.targetId}">${esc(name(b.targetId))}</a><small>${esc(role)} 経由</small></div>${badge('Role経由')}</div>`).join('') + (direct.length ? '' : '<p class="hint">紐づけはありません。</p>');
}
function journalSkillPanel(a: Asset) {
  const utility = journalSkillKey(a);
  if (utility === 'journal') return `<section class="section"><h3>Journal記録</h3><p class="hint">このSkillは直接起動せず、設定・接続のJournal記録設定でON/OFFを切り替えます。</p></section><section class="section"><h3>Runtimeのdescription ${info('Runtimeのdescription', 'Runtime YAMLへ出力されるSkillの説明です。')}</h3><p class="body-panel prose">${esc(a.description)}</p></section>`;
  if (utility === 'journal-review') return `<div class="row spread section"><div><h3>直接起動</h3><p class="hint">Journal Reviewはユーザーが明示的に開始する直接起動Skillです。</p></div><button type="button" role="switch" aria-checked="${a.useCase}" data-action="usecase:${a.id}" class="${a.useCase ? 'primary' : ''}">${a.useCase ? '有効' : '無効'}</button></div><section class="section"><h3>Runtimeのdescription ${info('Runtimeのdescription', 'Runtime YAMLへ出力されるSkillの説明です。')}</h3><p class="body-panel prose">${esc(a.description)}</p></section>`;
  return `<div class="row spread section"><div><h3>直接起動</h3><p class="hint">${a.useCase ? 'RuntimeからこのSkillを直接使えます。' : '必要なWorkflowから参照して使います。'}</p></div><button type="button" role="switch" aria-checked="${a.useCase}" data-action="usecase:${a.id}" class="${a.useCase ? 'primary' : ''}">${a.useCase ? '有効' : '無効'}</button></div><section class="section"><h3>Runtimeのdescription ${info('Runtimeのdescription', 'Runtime YAMLへ出力されるSkillの説明です。')}</h3><p class="body-panel prose">${esc(a.description)}</p></section>`;
}
function protectedSkillDetail(a: Asset) {
  const relationships = relatedWorkflows(a.id, assets, bindings);
  return `<article class="glass detail"><div class="detail-head"><div><div class="badge-row">${badge(kinds[a.kind])}${badge(labelScope(a.scope))}<span class="mono">rev. ${a.revision}</span></div><h2>${esc(a.name)}</h2><p>${esc(a.explanation || a.description)}</p></div><div class="row">${button(`asset-edit:${a.id}`, '編集する')}</div></div>${journalSkillPanel(a)}<section class="section"><h3>本文</h3><div class="body-panel prose">${esc(a.body) || '<span class="muted">未記入</span>'}</div></section>${Object.keys(a.supportingFiles).length ? `<section class="section"><h3>補助ファイル</h3>${Object.entries(a.supportingFiles).map(([f, body]) => `<details><summary>${esc(f)}</summary><pre>${esc(body)}</pre></details>`).join('')}</section>` : ''}<section class="section"><div class="section-header"><h3>参照する資産</h3>${button(`binding-new:${a.id}`, '紐づける', 'small')}</div>${bindingRows(a)}</section><section class="section"><h3>関連するWorkflow / Stage</h3>${relationships.length ? relationships.map(r => `<div class="relation"><div><a href="#assets/${r.workflow.id}">${esc(r.workflow.name)}${r.stageId ? ` / ${esc(r.workflow.stages.find(s => s.id === r.stageId)?.name)}` : ''}</a><small>${r.via.length ? `${esc(r.via.join(' → '))} 経由` : '直接参照'}</small></div></div>`).join('') : '<p class="hint">関連するWorkflowはありません。</p>'}</section><section class="section"><div class="row spread"><span class="mono">${esc(a.id)}</span>${button(`history-asset:${a.id}`, '変更履歴・復元', 'small ghost')}</div><p class="hint">最終更新 ${date(a.updatedAt)}</p></section></article>`;
}
function assetDetail(a: Asset) {
  if (journalSkillKey(a)) return protectedSkillDetail(a);
  const relationships = relatedWorkflows(a.id, assets, bindings);
  const summary = a.kind === 'skill' ? a.explanation || a.description : a.description;
  return `<article class="glass detail"><div class="detail-head"><div><div class="badge-row">${badge(kinds[a.kind])}${badge(labelScope(a.scope))}<span class="mono">rev. ${a.revision}</span></div><h2>${esc(a.name)}</h2><p>${esc(summary)}</p></div><div class="row">${button(`asset-edit:${a.id}`, '編集する')}${button(`asset-delete:${a.id}`, '削除する', 'danger')}</div></div>${a.kind === 'skill' ? `<div class="row spread section"><div><h3>直接起動</h3><p class="hint">${a.useCase ? 'RuntimeからこのSkillを直接使えます。' : '必要なWorkflowから参照して使います。'}</p></div><button type="button" role="switch" aria-checked="${a.useCase}" data-action="usecase:${a.id}" class="${a.useCase ? 'primary' : ''}">${a.useCase ? '有効' : '無効'}</button></div><section class="section"><h3>Runtimeのdescription ${info('Runtimeのdescription', 'Runtime YAMLへ出力されるSkillの説明です。')}</h3><p class="body-panel prose">${esc(a.description)}</p></section>` : ''}${a.kind === 'model' ? `<section class="section"><div class="grid-two"><div><h3>Model名</h3><p class="body-panel prose">${esc(a.modelName)}</p></div><div><h3>呼び出し方</h3><p class="body-panel prose">${esc(a.invocationMethod)}</p></div></div>${a.choices?.length ? `<div class="section"><h3>選択肢</h3>${a.choices.map(choice => `<div class="relation"><strong>${esc(choice.name)}</strong><small>${choice.options.map(value => esc(value)).join(' / ')}</small></div>`).join('')}</div>` : ''}<p class="hint">このModelをWorkflowのStageへ紐づけると、そのStageをサブエージェントで実行する指示になります。</p></section>` : ''}${a.kind === 'workflow' ? `${diagram(a)}<div class="section-header"><h3>工程、担当Role、遷移条件</h3>${button(`run-new:${a.id}`, 'Runを開始', 'primary small')}</div>${a.stages.map(s => { const roleId = stageRoleId(a.id, s.id), modelId = stageModelId(a.id, s.id), model = assets.find(asset => asset.id === modelId), outgoing = a.transitions.filter(t => t.from === s.id); return `<div class="editor-row"><div class="row-head"><strong>${esc(s.name)}</strong>${button(`binding-new:${a.id}:${s.id}`, '紐づける', 'small')}</div><p class="hint">担当Role: ${roleId ? `<a href="#assets/${roleId}">${esc(name(roleId))}</a>` : '未割当'}</p><p class="hint">Model: ${modelId ? `<a href="#assets/${modelId}">${esc(name(modelId))}（サブエージェント実行）${modelChoiceSummary(model!) ? `<br>選択肢: ${esc(selectedChoiceSummary(model, stageModelSelections(a.id, s.id)))}` : ''}` : 'Runtimeの通常実行'}</p>${s.additionalInstructions ? `<p class="prose"><strong>追加指示</strong><br>${esc(s.additionalInstructions)}</p>` : ''}<p class="prose"><strong>遷移条件</strong><br>${outgoing.length ? outgoing.map(t => `${esc(t.label)}: ${esc(t.condition)}`).join('<br>') : '未設定'}</p>${bindingRows(a, s.id)}</div>`; }).join('')}` : a.kind !== 'model' ? `<section class="section"><h3>${a.kind === 'role' ? '役割と責務' : '本文'}</h3><div class="body-panel prose">${esc(a.kind === 'role' ? a.responsibilities : a.body) || '<span class="muted">未記入</span>'}</div></section>` : ''}${a.kind === 'skill' && Object.keys(a.supportingFiles).length ? `<section class="section"><h3>補助ファイル</h3>${Object.entries(a.supportingFiles).map(([f, body]) => `<details><summary>${esc(f)}</summary><pre>${esc(body)}</pre></details>`).join('')}</section>` : ''}${a.kind !== 'rule' ? `<section class="section"><div class="section-header"><h3>${a.kind === 'workflow' ? 'Workflow全体の紐づけ' : '参照する資産'}</h3>${button(`binding-new:${a.id}`, '紐づける', 'small')}</div>${bindingRows(a)}</section>` : ''}<section class="section"><h3>関連するWorkflow / Stage</h3>${relationships.length ? relationships.map(r => `<div class="relation"><div><a href="#assets/${r.workflow.id}">${esc(r.workflow.name)}${r.stageId ? ` / ${esc(r.workflow.stages.find(s => s.id === r.stageId)?.name)}` : ''}</a><small>${r.via.length ? `${esc(r.via.join(' → '))} 経由` : '直接参照'}</small></div><div class="row">${badge(r.via.length ? '間接参照' : '直接参照')}${button(`binding-edit:${r.binding.id}`, '参照元を編集', 'small ghost')}${r.binding.purpose === 'stage-role' || r.binding.purpose === 'stage-model' ? '' : button(`binding-remove:${r.binding.id}`, '解除', 'small ghost')}</div>`).join('') : '<p class="hint">関連するWorkflowはありません。</p>'}</section><section class="section"><div class="row spread"><span class="mono">${esc(a.id)}</span>${button(`history-asset:${a.id}`, '変更履歴・復元', 'small ghost')}</div><p class="hint">最終更新 ${date(a.updatedAt)}</p></section></article>`;
}
function assetDrawer(a: Asset) {
  return `<div class="asset-drawer-backdrop" data-action="asset-close" aria-hidden="true"></div><aside class="asset-drawer" aria-label="${esc(a.name)}の詳細"><div class="asset-drawer-head"><span>資産の詳細</span>${button('asset-close', '×', 'icon-button')}</div>${assetDetail(a)}</aside>`;
}
function renderAssets() {
  const currentScroll = document.querySelector<HTMLElement>('.asset-scroll');
  if (currentScroll) assetScrollTop = currentScroll.scrollTop;
  const list = assets.filter(a => (a.scope === 'global' || a.scope === selectedScope) && (filter === 'all' || a.kind === filter) && `${a.name} ${a.description} ${a.kind === 'skill' ? a.explanation : ''} ${a.kind === 'model' ? `${a.modelName} ${a.invocationMethod}` : ''}`.toLowerCase().includes(search.toLowerCase()));
  const selected = assets.find(a => a.id === route()[1]);
  const hasDrawer = Boolean(selected && (selected.scope === 'global' || selected.scope === selectedScope));
  const toolbar = `<div class="toolbar"><div class="filters">${[['all', 'すべて'], ...Object.entries(kinds)].map(([key, title]) => `<button class="filter ${filter === key ? 'active' : ''}" data-action="filter:${key}">${title}<span class="pill-count">${assets.filter(a => (a.scope === 'global' || a.scope === selectedScope) && (key === 'all' || a.kind === key)).length}</span></button>`).join('')}</div><input id="asset-search" class="search" type="search" aria-label="資産を検索" placeholder="名前・説明から検索" value="${esc(search)}" translate="no"></div>`;
  const cards = list.map(a => `<a href="#assets/${a.id}" class="asset-row asset-card ${selected?.id === a.id ? 'selected' : ''}" aria-label="${esc(a.name)}を表示"><div class="asset-card-top"><span class="type-icon ${a.kind}">${symbols[a.kind]}</span><span class="badge">${kinds[a.kind]}</span><span class="asset-card-scope">${esc(labelScope(a.scope))}</span></div><strong>${esc(a.name)}</strong><p>${esc(a.kind === 'skill' ? a.explanation || a.description : a.description) || '説明はありません。'}</p><div class="asset-card-meta"><span class="mono">rev. ${a.revision}</span><span class="asset-card-open">詳細を見る →</span></div></a>`).join('');
  const grid = `<div class="asset-stage"><div class="asset-scroll${hasDrawer ? ' drawer-open' : ''}"><div class="asset-grid" role="list" aria-label="利用できる資産">${cards || empty('見つかりません', '検索語や種類を変更してください。', '', true)}</div></div>${hasDrawer ? assetDrawer(selected!) : ''}</div>`;
  const emptyState = `<div class="asset-stage"><div class="asset-scroll"><div class="glass">${empty('開発方法を、育てる。', 'あなたが繰り返し使う手順や判断基準を、最初の資産として保存しましょう。', button('asset-new', '最初の資産を作成', 'primary'))}</div><div class="onboarding"><article class="glass"><div class="step-label">01 / 保存する</div><h3>知識と役割を資産に</h3><p>Skill・Role・Ruleに、使いたい内容を記述します。</p></article><article class="glass"><div class="step-label">02 / 組み立てる</div><h3>Workflowで進め方を定義</h3><p>工程と遷移条件を決め、使う資産を紐づけます。</p></article><article class="glass"><div class="step-label">03 / 振り返る</div><h3>Journalから改善へ</h3><p>実行で得た気づきを残し、次の開発に反映します。</p></article></div></div></div>`;
  shell(`<div class="asset-shell">${pageHeading('資産ライブラリ', '繰り返し使う方法・知識・役割・規則を、ひとつの場所に。', button('asset-new', '＋ 資産を作成', 'primary'))}${toolbar}${assets.length ? grid : emptyState}</div>`, 'asset-main-content');
  document.querySelector<HTMLElement>('.asset-scroll')?.scrollTo({ top: assetScrollTop });
}

function recordRoute(page: string) {
  const key = `${page}:${selectedScope}`;
  if (recordRouteKey === key) return;
  recordObserver?.disconnect();
  recordObserver = undefined;
  recordRouteKey = key;
  recordGeneration += 1;
  recordLoading = false;
  journalListState = { journals: [], insights: [], nextCursor: null };
  reviewListState = { reviewItems: [], journals: [], insights: [], nextCursor: null };
  historyListState = { histories: [], changeSets: [], provenance: [], nextCursor: null };
}
function loadMoreMarkup(page: 'journals' | 'review' | 'history', nextCursor: string | null) {
  return `<div class="record-load-more" data-record-load-more="${page}"${nextCursor ? '' : ' hidden'}><button type="button" class="ghost" data-action="record-load:${page}">過去を読み込む</button><span class="hint">${nextCursor ? 'スクロールすると過去の記録を読み込みます。' : ''}</span></div>`;
}
function setupRecordObserver(page: 'journals' | 'review' | 'history') {
  recordObserver?.disconnect();
  const sentinel = document.querySelector<HTMLElement>(`[data-record-load-more="${page}"]`);
  if (!sentinel || sentinel.hidden) return;
  recordObserver = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting)) void loadMoreRecords(page);
  }, { root: document.querySelector('.main-content'), rootMargin: '240px' });
  recordObserver.observe(sentinel);
}
function recordInsightsMarkup(insights: Insight[], review = false) {
  return insights.map(insight => `<div class="insight"><div class="row spread"><strong>${esc(insight.heading)}</strong>${status(insight.status)}</div><p>${esc(insight.body)}</p>${review ? '' : `<div class="insight-actions">${['pending', 'processed', 'rejected'].filter(value => value !== insight.status).map(value => button(`insight:${insight.id}:${value}`, states[value])).join('')}</div>`}</div>`).join('');
}
function journalRecordMarkup(journal: JournalSummary) {
  const insights = journalListState.insights.filter(insight => insight.journalId === journal.id);
  const pending = journal.pendingInsightCount ?? insights.filter(insight => insight.status === 'pending').length;
  return `<details class="glass record-panel" data-lazy-kind="journal" data-id="${esc(journal.id)}"><summary><span class="record-summary-title"><span class="mono">${date(journal.createdAt)}</span><strong>${esc(journal.task || (journal.runId ? 'Runの振り返り' : 'Journal'))}</strong></span><span class="record-summary-meta">${journal.insightCount ?? insights.length}件の気づき${pending ? ` · ${badge(`${pending}件レビュー待ち`, 'amber')}` : ''}<span class="record-chevron" aria-hidden="true">⌄</span></span></summary><div class="record-panel-body"><div class="loading">開くと本文を読み込みます。</div></div></details>`;
}
function reviewRecordMarkup(item: ReviewSummary) {
  const journal = reviewListState.journals.find(value => value.id === item.journalId);
  return `<details class="glass record-panel" data-lazy-kind="review" data-id="${esc(item.id)}"><summary><span class="record-summary-title"><span class="mono">${journal ? date(journal.createdAt) : ''}</span><strong>${esc(item.heading)}</strong><small>${esc(journal?.task || (journal?.runId ? 'Runの振り返り' : 'Journal'))}</small></span><span class="record-summary-meta">${status(item.status)}<span class="record-chevron" aria-hidden="true">⌄</span></span></summary><div class="record-panel-body"><div class="loading">開くと内容を読み込みます。</div></div></details>`;
}
function historyRecordMarkup(changeSet: ChangeSetSummary) {
  const provenance = historyListState.provenance.find(value => value.id === changeSet.provenanceId);
  const count = historyListState.histories.filter(history => history.changeSetId === changeSet.id).length;
  return `<details class="glass record-panel" data-lazy-kind="history" data-id="${esc(changeSet.id)}"><summary><span class="record-summary-title"><span class="mono">${date(changeSet.createdAt)}</span><strong>${esc(provenance?.userRequest || provenance?.reason || (provenance?.origin === 'restore' ? '過去の内容を復元' : '資産・構成の更新'))}</strong></span><span class="record-summary-meta">${count}件の変更${provenance ? ` · ${badge(provenance.origin)}` : ''}<span class="record-chevron" aria-hidden="true">⌄</span></span></summary><div class="record-panel-body"><div class="loading">開くと変更内容を読み込みます。</div></div></details>`;
}
function journalDetailMarkup(journal: Journal, insights: Insight[]) {
  return `<div class="record-detail-head"><div class="badge-row">${badge(journal.runId ? 'Runに関連' : 'Taskに関連')}${status(journal.reviewStatus)}</div><span class="mono">${date(journal.createdAt)}</span></div><section class="record-detail-section"><h3>気づき</h3>${insights.length ? recordInsightsMarkup(insights) : '<p class="hint">気づきはありません。</p>'}</section>${details('Journal原文', journal.raw)}${journal.runId ? `<p class="hint"><a href="#runs/${journal.runId}">関連Run・Snapshot・実行記録を見る →</a></p>` : ''}`;
}
function reviewDetailMarkup(item: ReviewItem, journal: Journal, insight: Insight) {
  const decisions = (['approved', 'deferred', 'rejected'] as const).filter(decision => decision !== item.lastDecision || item.status === 'pending');
  return `<div class="record-detail-head"><div><div class="badge-row">${status(item.status)}${badge(journal.task || 'Journal')}</div><p class="hint">${date(journal.createdAt)}</p></div></div><p class="prose">${esc(insight.body || item.body)}</p><div class="insight-actions">${decisions.map(decision => button(`review-decide:${item.id}:${decision}`, reviewDecisionLabels[decision], 'small')).join('')}</div>`;
}
function historyDetailMarkup(changeSet: ChangeSet, histories: History[], provenance: Provenance & { id: string }) {
  return `${histories.map(history => `<div class="relation"><div>${esc(name(history.entityId))}<small>${history.before ? `rev. ${history.before} → ${history.after}` : `新規作成 · rev. ${history.after}`}${history.restoredFrom ? ` · 復元元 rev. ${history.restoredFrom}` : ''}</small></div>${history.kind === 'asset' ? button(`history-asset:${history.entityId}`, '差分・復元', 'small') : ''}</div>`).join('')}${details('変更内容', changeSet)}${details('Provenance', provenance)}<footer><span class="mono">${changeSet.id.slice(0, 8)}</span>${changeSet.operations.length ? button(`changeset-restore:${changeSet.id}`, '変更前の状態へ復元', 'small') : ''}</footer>`;
}
async function loadRecordPanel(panel: HTMLElement) {
  const kind = panel.dataset.lazyKind, id = panel.dataset.id, generation = recordGeneration;
  if (!kind || !id || panel.dataset.loaded === 'true' || panel.dataset.loading === 'true') return;
  panel.dataset.loading = 'true';
  try {
    let html = '';
    if (kind === 'journal') {
      const data = await api<{ journal: Journal; insights: Insight[] }>('journal.get', { journalId: id });
      html = journalDetailMarkup(data.journal, data.insights);
    } else if (kind === 'review') {
      const data = await api<{ reviewItem: ReviewItem; journalTask: Journal; insight: Insight }>('review.item.get', { reviewItemId: id });
      html = reviewDetailMarkup(data.reviewItem, data.journalTask, data.insight);
    } else if (kind === 'history') {
      const data = await api<{ changeSets: ChangeSet[]; histories: History[]; provenance: (Provenance & { id: string })[] }>('history.get', { changeSetId: id, includeDetails: true });
      const changeSet = data.changeSets[0];
      if (!changeSet) throw new Error('変更履歴が見つかりません。');
      html = historyDetailMarkup(changeSet, data.histories, data.provenance[0]!);
    }
    if (generation === recordGeneration && panel.isConnected) {
      panel.querySelector<HTMLElement>('.record-panel-body')!.innerHTML = html;
      panel.dataset.loaded = 'true';
    }
  } catch (error) {
    if (generation === recordGeneration && panel.isConnected) panel.querySelector<HTMLElement>('.record-panel-body')!.innerHTML = `<p class="form-error" role="alert">${esc(errorMessage(error))}</p>`;
  } finally {
    delete panel.dataset.loading;
  }
}
async function loadMoreRecords(page: 'journals' | 'review' | 'history') {
  if (recordLoading || route()[0] !== page) return;
  const cursor = page === 'journals' ? journalListState.nextCursor : page === 'review' ? reviewListState.nextCursor : historyListState.nextCursor;
  if (!cursor) return;
  recordLoading = true;
  const generation = recordGeneration;
  const button = document.querySelector<HTMLButtonElement>(`[data-action="record-load:${page}"]`);
  if (button) { button.disabled = true; button.textContent = '読み込み中…'; }
  try {
    if (page === 'journals') {
      const data = await api<{ journals: JournalSummary[]; insights: Omit<Insight, 'body'>[]; nextCursor: string | null }>('journal.list', { limit: recordPageSize, cursor, ...(selectedScope !== 'global' ? { projectId: selectedScope } : {}) });
      if (generation !== recordGeneration) return;
      journalListState.journals.push(...data.journals); journalListState.insights.push(...data.insights); journalListState.nextCursor = data.nextCursor;
      screenData = { ...screenData, journals: journalListState.journals, insights: journalListState.insights };
      document.querySelector<HTMLElement>('[data-record-list="journals"]')?.insertAdjacentHTML('beforeend', data.journals.map(journalRecordMarkup).join(''));
    } else if (page === 'review') {
      const data = await api<{ reviewItems: ReviewSummary[]; journals: JournalSummary[]; insights: Omit<Insight, 'body'>[]; nextCursor: string | null }>('review.pending', { limit: recordPageSize, cursor, include: ['journalTask', 'insights'], includeBodies: false, ...(selectedScope !== 'global' ? { projectId: selectedScope } : {}) });
      if (generation !== recordGeneration) return;
      reviewListState.reviewItems.push(...data.reviewItems); reviewListState.journals.push(...data.journals); reviewListState.insights.push(...data.insights); reviewListState.nextCursor = data.nextCursor;
      screenData = { ...screenData, reviewItems: reviewListState.reviewItems, journals: reviewListState.journals, insights: reviewListState.insights };
      document.querySelector<HTMLElement>('[data-record-list="review"]')?.insertAdjacentHTML('beforeend', data.reviewItems.map(reviewRecordMarkup).join(''));
    } else {
      const data = await api<{ histories: History[]; changeSets: ChangeSetSummary[]; provenance: (Provenance & { id: string })[]; nextCursor: string | null }>('history.get', { limit: recordPageSize, cursor });
      if (generation !== recordGeneration) return;
      historyListState.histories.push(...data.histories); historyListState.changeSets.push(...data.changeSets); historyListState.provenance.push(...data.provenance); historyListState.nextCursor = data.nextCursor;
      screenData = { ...screenData, ...historyListState };
      document.querySelector<HTMLElement>('[data-record-list="history"]')?.insertAdjacentHTML('beforeend', data.changeSets.map(historyRecordMarkup).join(''));
    }
    const next = page === 'journals' ? journalListState.nextCursor : page === 'review' ? reviewListState.nextCursor : historyListState.nextCursor;
    const sentinel = document.querySelector<HTMLElement>(`[data-record-load-more="${page}"]`);
    if (sentinel) { sentinel.hidden = !next; sentinel.querySelector('button')!.textContent = '過去を読み込む'; sentinel.querySelector('.hint')!.textContent = next ? 'スクロールすると過去の記録を読み込みます。' : ''; }
    setupRecordObserver(page);
  } catch (error) { notify(errorMessage(error)); }
  finally { recordLoading = false; if (button) button.disabled = false; }
}
async function render() {
  const [page, selectedId] = route();
  if (page === 'assets') { renderAssets(); return; }
  if (page === 'runs') {
    const data = await api<{ runs: Run[] }>('run.list', selectedScope === 'global' ? {} : { projectId: selectedScope }); screenData = data;
    const run = data.runs.find(r => r.id === selectedId);
    if (run) {
      const detail = await api<{ run: Run; snapshot: Snapshot; deliveries: Delivery[]; events: RunEvent[]; journals: Journal[] }>('run.inspect', { contextHandle: run.contextHandle });
      screenData = { ...data, detail };
      const transitions = run.status === 'active' ? detail.snapshot.workflow.transitions.filter(t => t.from === run.stageId) : [];
      const currentStage = detail.snapshot.workflow.stages.find(s => s.id === run.stageId)!;
      const currentStageRole = detail.snapshot.bindings.find(b => b.sourceId === detail.snapshot.workflow.id && b.stageId === run.stageId && b.purpose === 'stage-role');
      const currentRoleName = detail.snapshot.assets.find(a => a.id === currentStageRole?.targetId)?.name ?? '未取得';
      const currentStageModel = detail.snapshot.bindings.find(b => b.sourceId === detail.snapshot.workflow.id && b.stageId === run.stageId && b.purpose === 'stage-model');
      const currentModel = detail.snapshot.assets.find(a => a.id === currentStageModel?.targetId);
      const currentModelSelections = currentStageModel?.selectedChoices ?? {};
      shell(pageHeading(esc(name(run.workflowId)), `${esc(run.instruction)} · rev. ${run.workflowRevision}`, `<a href="#runs" class="badge">← Run一覧</a>`) + `<div class="glass card"><div class="row spread"><div class="badge-row">${status(run.status)}${badge(run.runtime)}${badge(labelScope(run.projectId ?? 'global'))}</div><span class="mono">${date(run.createdAt)}</span></div>${diagram(detail.snapshot.workflow)}<div class="row spread"><div><h3>現在の工程: ${esc(currentStage.name)}</h3><p class="hint">担当Role: ${esc(currentRoleName)}</p><p class="hint">Model: ${currentModel ? `${esc(currentModel.name)} / ${esc(currentModel.modelName)}（サブエージェント実行）${currentModel.choices?.length ? `<br>選択肢: ${esc(selectedChoiceSummary(currentModel, currentModelSelections))}` : ''}` : 'Runtimeの通常実行'}</p>${currentStage.additionalInstructions ? `<section class="section"><strong>追加指示</strong><p class="prose">${esc(currentStage.additionalInstructions)}</p></section>` : ''}</div>${run.status === 'active' ? button(`run-cancel:${run.id}`, 'Runを中止', 'danger small') : ''}</div><div class="row wrap">${transitions.map(t => `<div class="transition-option">${button(`run-transition:${run.id}:${t.id}`, t.label, 'primary small')}<small>条件: ${esc(t.condition)}</small></div>`).join('')}${button(`journal-new:${run.id}`, 'Journalを記録')}</div><div class="statline"><span><strong>${detail.deliveries.length}</strong>提供記録</span><span><strong>${detail.deliveries.reduce((s, d) => s + d.bytes, 0).toLocaleString()}</strong>bytes 提供</span><span><strong>${detail.journals.length}</strong>Journal</span></div></div><div class="grid-two section"><article class="glass card"><h3>進行記録</h3><div class="timeline">${detail.events.map(e => `<article><small>${date(e.createdAt)}</small><strong>${esc(e.type)}</strong>${details('報告・根拠', e.data)}</article>`).join('')}</div></article><article class="glass card"><h3>Contextの提供</h3>${detail.deliveries.map(d => `<div class="relation"><div>${esc(d.target)}<small>${esc(d.stageId)} · ${d.bytes.toLocaleString()} bytes${d.assetRevision ? ` · rev. ${d.assetRevision}` : ''}</small></div>${badge(d.success ? '提供済み' : '取得失敗', d.success ? '' : 'red')}</div>`).join('')}${details('固定Snapshot・参照経路', detail.snapshot)}${details('提供内容・取得失敗の理由', detail.deliveries)}</article></div>`);
    } else shell(pageHeading('Workflow Run', '実行ごとに資産の版を固定し、進行と提供したContextを記録します。', button('run-new', '＋ Runを開始', 'primary')) + `<div class="glass">${data.runs.length ? `<table class="table"><thead><tr><th>Workflow / 依頼</th><th>状態</th><th>工程</th><th>Runtime</th><th>開始</th></tr></thead><tbody>${data.runs.map(r => `<tr><td><a href="#runs/${r.id}"><strong>${esc(name(r.workflowId))}</strong><p class="hint">${esc(r.instruction)}</p></a></td><td>${status(r.status)}</td><td>${esc(r.stageId)}</td><td>${esc(r.runtime)}</td><td class="mono">${date(r.createdAt)}</td></tr>`).join('')}</tbody></table>` : empty('まだ実行記録はありません', '使うWorkflowを明示して、最初のRunを開始します。', button('run-new', 'Workflowを選ぶ'))}</div>`);
  } else if (page === 'journals' || page === 'review') {
    recordRoute(page);
    if (page === 'journals') {
      const data = await api<{ journals: JournalSummary[]; insights: Omit<Insight, 'body'>[]; nextCursor: string | null }>('journal.list', { limit: recordPageSize, ...(selectedScope !== 'global' ? { projectId: selectedScope } : {}) });
      journalListState = data;
      screenData = { journals: data.journals, insights: data.insights };
      shell(pageHeading('Journal', 'タイトルを一覧し、必要な記録だけ開いて本文を読み込みます。', button('journal-new', '＋ Journalを記録', 'primary')) + `<div class="record-intro"><span>${data.journals.length}件を表示中</span><span class="hint">本文は開いた項目だけ読み込みます。</span></div><div class="stack record-list" data-record-list="journals">${data.journals.length ? data.journals.map(journalRecordMarkup).join('') : `<div class="glass">${empty('気づきを、次の改善へ', '書き残したい発見や摩擦があるときに、Journalを記録してください。', button('journal-new', 'Journalを記録'))}</div>`}</div>${loadMoreMarkup('journals', data.nextCursor)}`);
      setupRecordObserver('journals');
    } else {
      const [data, proposals] = await Promise.all([
        api<{ reviewItems: ReviewSummary[]; journals: JournalSummary[]; insights: Omit<Insight, 'body'>[]; nextCursor: string | null }>('review.pending', { ...(selectedScope !== 'global' ? { projectId: selectedScope } : {}), include: ['journalTask', 'insights'], includeBodies: false, limit: recordPageSize }),
        api<{ proposals: Proposal[]; decisions: Decision[]; changeSets: ChangeSetSummary[] }>('proposal.list', { includeChanges: false }),
      ]);
      reviewListState = data;
      screenData = { ...data, ...proposals };
      const proposalMarkup = proposals.proposals.length ? `<div class="stack">${proposals.proposals.map(p => {
        const d = proposals.decisions.find(d => d.proposalId === p.id), applied = proposals.changeSets.some(c => c.proposalId === p.id);
        return `<article class="glass card"><div class="row spread"><h2>${esc(p.title)}</h2>${applied ? badge('適用済み', 'green') : d ? status(d.choice) : badge('判断待ち', 'amber')}</div><p class="prose">${esc(p.proposedChange)}</p><p>理由: ${esc(p.reason)}</p><p class="hint">根拠Journal ${p.evidenceJournalIds.length}件 · 対象の気づき ${p.insightIds.length}件</p>${details('変更内容・影響する資産・管理先', p)}${applied ? '' : `<footer><div class="row">${button(`proposal-decide:${p.id}:approved`, '承認', 'small')}${button(`proposal-decide:${p.id}:deferred`, '保留', 'small')}${button(`proposal-decide:${p.id}:rejected`, '却下', 'small')}</div>${d?.choice === 'approved' ? button(`proposal-apply:${p.id}`, '承認した変更を適用', 'primary') : ''}</footer>`}</article>`;
      }).join('')}</div><div class="spacer"></div>` : '';
      shell(pageHeading('Journal Review', '気づきのタイトルを一覧し、必要な内容だけ開いて判断します。', button('proposal-new', '＋ 改善を提案', 'primary')) + proposalMarkup + `<div class="record-intro"><span>${data.reviewItems.length}件を表示中</span><span class="hint">本文・判断操作は開いた項目だけ読み込みます。</span></div><div class="stack record-list" data-record-list="review">${data.reviewItems.length ? data.reviewItems.map(reviewRecordMarkup).join('') : `<div class="glass">${empty('レビュー待ちの気づきはありません', 'Journalを記録すると、ここで改善の判断ができます。', button('journal-new', 'Journalを記録'))}</div>`}</div>${loadMoreMarkup('review', data.nextCursor)}`);
      setupRecordObserver('review');
    }
  } else if (page === 'history') {
    recordRoute(page);
    const data = await api<{ histories: History[]; changeSets: ChangeSetSummary[]; provenance: (Provenance & { id: string })[]; nextCursor: string | null }>('history.get', { limit: recordPageSize });
    historyListState = data; screenData = data;
    shell(pageHeading('変更履歴', '変更のタイトルを一覧し、必要なChange Setだけ開いて詳細を読み込みます。') + `<div class="record-intro"><span>${data.changeSets.length}件を表示中</span><span class="hint">変更内容とProvenanceは開いた項目だけ読み込みます。</span></div><div class="stack record-list" data-record-list="history">${data.changeSets.length ? data.changeSets.map(historyRecordMarkup).join('') : `<div class="glass">${empty('変更はまだありません', '資産や紐づけを保存すると、履歴と変更理由を確認できます。')}</div>`}</div>${loadMoreMarkup('history', data.nextCursor)}`);
    setupRecordObserver('history');
  } else if (page === 'diagnostics') {
    const data = await api<{ diagnostics: Diagnostic[]; costs: { runId: string; stageId: string; roleIds: string[]; target: string; bytes: number; deliveries: number; runtime: string }[] }>('diagnostics.get'); screenData = data;
    shell(pageHeading('診断', '参照の整合性、繰り返す遷移、実際のContext提供量を確認します。', button('refresh', '再診断')) + `<div class="glass card"><h2>整合性と実行の状態</h2>${data.diagnostics.length ? data.diagnostics.map(d => `<div class="insight"><div class="row">${badge(d.severity, d.severity === 'error' ? 'red' : 'amber')}<strong>${esc(d.code)}</strong></div><p>${esc(d.message)}</p>${details('対象と根拠', { target: d.target, evidence: d.evidence })}</div>`).join('') : '<div class="status-message">検出された問題はありません。</div>'}</div><div class="glass card section"><h2>Contextの提供量</h2><p>実際に提供した内容のUTF-8バイト数です。未取得のSkill本文は含みません。</p>${data.costs.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Run / Stage</th><th>対象</th><th>Role</th><th>Runtime</th><th>提供回数</th><th>bytes</th></tr></thead><tbody>${data.costs.map(c => `<tr><td><a href="#runs/${c.runId}" class="mono">${c.runId.slice(0, 8)}</a><p class="hint">${esc(c.stageId)}</p></td><td>${esc(assets.some(a => a.id === c.target) ? name(c.target) : c.target)}</td><td>${esc(c.roleIds.map(name).join(', ') || '—')}</td><td>${esc(c.runtime)}</td><td>${c.deliveries}</td><td class="mono">${c.bytes.toLocaleString()}</td></tr>`).join('')}</tbody></table></div>` : '<p class="hint">Workflow Runを開始すると提供量を確認できます。</p>'}</div>`);
  } else if (page === 'settings') {
    const [r, s, candidates] = await Promise.all([api<{ targets: RuntimeTarget[] }>('runtime.list'), api<{ timeoutHours: number; journalEnabled: boolean }>('settings.get'), api<{ candidates: { runtime: string; path: string; platform: string; exists: boolean }[] }>('runtime.discover')]);
    const common = selectedScope !== 'global' ? (await api<{ common: Common }>('common.get', { projectId: selectedScope })).common : null;
    screenData = { ...r, common, ...candidates };
    shell(pageHeading('設定・接続', 'Project、Runtimeの入口、ローカルデータを管理します。') + `<div class="grid-two"><section class="glass card"><div class="section-header"><h2>Project</h2>${button('project-new', '＋ 登録', 'small')}</div>${projects.length ? projects.map(p => `<div class="relation"><div>${esc(p.name)}<small class="mono">${esc(p.root)}</small></div>${badge('登録済み')}</div>`).join('') : '<p>開いているProjectでaacl initを実行するか、rootを指定して登録します。</p>'}${common ? `<div class="section"><div class="section-header"><h3>Project Common</h3>${button('common-edit', 'Ruleを選ぶ', 'small')}</div>${common.ruleIds.map(id => `<div class="relation">${esc(name(id))}</div>`).join('') || '<p class="hint">共通Ruleは未登録です。</p>'}</div>` : '<p class="hint">管理先をProjectへ切り替えると、Project Commonを編集できます。</p>'}</section><section class="glass card"><h2>Runの非活動timeout</h2><p>Runに対する読み取りや操作がない場合の終了時間。</p><form data-form="settings" class="form-stack">${field('時間', 'timeoutHours', String(s.timeoutHours), true, 'number')}<label class="checkbox-label"><input type="checkbox" name="journalEnabled"${s.journalEnabled ? ' checked' : ''}>タスク完了時のJournal記録を有効にする</label><p class="hint">OFFにすると、AI・UIからの新しいJournal記録を停止します。既存のJournal Reviewは確認できます。</p><div><button type="submit">設定を保存</button></div><p class="form-error"></p></form></section></div><section class="glass card section"><div class="section-header"><div><h2>Runtimeの入口</h2><p>登録した設定先へ、Workflowと直接起動Skillの入口を配置します。</p></div><div class="row">${button('journal-skills', 'Journal用Skillを導入', 'small')}${button('runtime-sync', '再同期', 'small')}${button('runtime-new', '＋ 設定先を追加', 'primary small')}</div></div>${r.targets.length ? `<table class="table"><thead><tr><th>Runtime</th><th>管理先</th><th>設定先</th><th>状態</th><th></th></tr></thead><tbody>${r.targets.map(t => `<tr><td>${t.runtime === 'claude' ? 'Claude Code' : 'Codex'}<p class="hint">${t.platform}</p></td><td>${esc(labelScope(t.scope))}</td><td class="mono">${esc(t.path)}</td><td>${badge(t.enabled ? '管理中' : '管理解除', t.enabled ? 'green' : '')}</td><td>${t.enabled ? button(`runtime-remove:${t.id}`, '管理解除', 'small ghost') : ''}</td></tr>`).join('')}</tbody></table>` : '<p>設定先を追加すると、利用できる入口を生成します。</p>'}<div class="section"><h3>MCP接続</h3><pre>codex mcp add aacl --url ${esc(location.origin)}/mcp\nclaude mcp add --transport http aacl ${esc(location.origin)}/mcp</pre><p class="hint">Serviceが停止している場合は、WSLで aacl ensure を実行します。</p></div></section><section class="glass card section"><h2>Export・Backup</h2><p>出力先を指定して保存します。復元はCLIの aacl restore で新しい管理フォルダーへ行います。</p><div class="row">${button('export', 'Markdown / JSONを出力')}${button('backup', 'Backupを保存')}</div></section>`);
  } else { location.hash = 'assets'; }
}

function roleOptions(selected = '') {
  return opt('', '担当Roleなし', selected) + assets.filter(a => a.kind === 'role' && (a.scope === 'global' || a.scope === selectedScope)).map(a => opt(a.id, `${a.name}（${labelScope(a.scope)}）`, selected)).join('');
}
function modelChoiceSummary(model: Asset) {
  return (model.choices ?? []).map(choice => `${choice.name}: ${choice.options.join(' / ')}`).join(' · ');
}
function selectedChoiceSummary(model: Asset | undefined, selected: Record<string, string> = {}) {
  if (!model) return '';
  return (model.choices ?? []).map(choice => `${choice.name}: ${selected[choice.name] ?? '未選択'}`).join(' · ');
}
function modelOptions(selected = '') {
  return opt('', 'Modelなし（通常実行）', selected) + assets.filter(a => a.kind === 'model' && (a.scope === 'global' || a.scope === selectedScope)).map(a => {
    const choices = modelChoiceSummary(a);
    return opt(a.id, `${a.name} / ${a.modelName}${choices ? ` · ${choices}` : ''}（${labelScope(a.scope)}）`, selected);
  }).join('');
}
function stageRoleId(workflowId: string, stageId: string) {
  return bindings.find(b => b.sourceId === workflowId && b.stageId === stageId && b.purpose === 'stage-role')?.targetId ?? '';
}
function stageModelId(workflowId: string, stageId: string) {
  return bindings.find(b => b.sourceId === workflowId && b.stageId === stageId && b.purpose === 'stage-model')?.targetId ?? '';
}
function stageModelSelections(workflowId: string, stageId: string) {
  return bindings.find(b => b.sourceId === workflowId && b.stageId === stageId && b.purpose === 'stage-model')?.selectedChoices ?? {};
}
function modelChoiceFields(modelId: string, selected: Record<string, string> = {}) {
  const model = assets.find(a => a.id === modelId && a.kind === 'model');
  if (!model?.choices?.length) return '';
  return `<fieldset class="model-choice-fields"><legend>Modelの選択肢</legend><p class="hint">このStageで使う値を選択してください。</p>${model.choices.map(choice => select(choice.name, 'modelChoice', choice.options.map(value => opt(value, value, selected[choice.name])).join(''), true).replace('<select ', `<select data-choice-name="${esc(choice.name)}" `)).join('')}</fieldset>`;
}
function readModelSelections(row: Element) {
  return Object.fromEntries([...row.querySelectorAll<HTMLSelectElement>('[name=modelChoice]')].map(input => [input.dataset.choiceName ?? '', input.value]).filter(([name, value]) => name && value));
}
function choiceConditionSummary(model: Asset | undefined, conditions: Record<string, string>[] = []) {
  if (!model || !conditions.length) return 'すべての選択状態';
  return conditions.map(condition => {
    const values = Object.entries(condition).map(([name, value]) => `${name}=${value}`);
    return values.length ? values.join(' AND ') : 'すべての選択状態';
  }).join(' OR ');
}
function modelChoiceConditionRow(model: Asset, condition: Record<string, string> = {}, index = 0) {
  return `<fieldset class="choice-condition-row" data-condition-index="${index}"><legend>組み合わせ ${index + 1}</legend><div class="grid-two">${(model.choices ?? []).map(choice => select(`${choice.name}の条件`, 'choiceCondition', opt('', '指定しない', condition[choice.name]) + choice.options.map(value => opt(value, value, condition[choice.name])).join('')).replace('<select ', `<select data-condition-name="${esc(choice.name)}" `)).join('')}</div>${button('choice-condition-remove', '削除', 'small ghost')}</fieldset>`;
}
function modelChoiceConditionFields(modelId: string, conditions: Record<string, string>[] = []) {
  const model = assets.find(a => a.id === modelId && a.kind === 'model');
  if (!model?.choices?.length) return '';
  const rows = conditions.length ? conditions : [{}];
  return `<fieldset class="model-choice-condition-fields"><legend>参照条件</legend><p class="hint">この参照を有効にする選択状態を指定します。空欄は任意、組み合わせ同士はORです。</p><div id="choice-condition-rows">${rows.map((condition, index) => modelChoiceConditionRow(model, condition, index)).join('')}</div>${button('choice-condition-add', '＋ 組み合わせを追加', 'small ghost')}</fieldset>`;
}
function readModelChoiceConditions(form: Element) {
  return [...form.querySelectorAll<HTMLElement>('.choice-condition-row')].map(row => Object.fromEntries([...row.querySelectorAll<HTMLSelectElement>('[name=choiceCondition]')].map(input => [input.dataset.conditionName ?? '', input.value]).filter(([name, value]) => name && value))).filter(condition => Object.keys(condition).length);
}
function updateChoiceConditionNumbers(form: Element) {
  form.querySelectorAll<HTMLElement>('.choice-condition-row').forEach((row, index) => {
    row.dataset.conditionIndex = String(index);
    row.querySelector('legend')!.textContent = `組み合わせ ${index + 1}`;
  });
}
function stageRow(s: { id: string; name: string; additionalInstructions?: string }, index: number, roleId = '', modelId = '', selectedChoices: Record<string, string> = {}, transitions: Asset['transitions'] = [], stages: { id: string; name: string }[] = []) {
  return `<section class="editor-row stage-editor" data-id="${esc(s.id)}" aria-labelledby="stage-heading-${esc(s.id)}"><div class="row-head"><h3 class="stage-title" id="stage-heading-${esc(s.id)}">工程 ${index + 1}</h3>${button('row-remove', '削除', 'small ghost')}</div><div class="stage-content"><div>${field('工程名', 'stageName', s.name)}</div><div class="stage-role-row">${select('担当Role', 'stageRole', roleOptions(roleId), true, 'この工程を担当するRoleです。Roleの責務が工程の基本指示になります。')}${button(`role-create:${s.id}`, '＋ 新しいRole', 'small ghost')}</div><p class="hint field-guidance">ⓘ にカーソルを合わせると説明を表示します。</p><div>${select('Model', 'stageModel', modelOptions(modelId), false, '指定すると、この工程をModelのサブエージェントで実行します。未指定ならRuntimeの通常実行です。')}<div class="model-choice-container">${modelChoiceFields(modelId, selectedChoices)}</div></div><div class="new-role-fields" hidden><p class="hint">新しいRoleをGlobalで共有し、このStageの担当に設定します。</p>${field('新しいRole名', 'newRoleName', '', false)}${area('Roleの説明', 'newRoleDescription', '', false)}${area('Roleの責務', 'newRoleResponsibilities', '', false)}</div><div class="spacer"></div>${area('追加指示（任意）', 'additionalInstructions', s.additionalInstructions ?? '', false)}</div><section class="stage-transitions" aria-labelledby="transition-heading-${esc(s.id)}"><div class="stage-transitions-head"><div><h4 id="transition-heading-${esc(s.id)}">この工程からの遷移</h4><p>各行で行き先・条件・表示名を設定します。</p></div>${button('transition-add', '＋ 行き先を追加', 'small ghost')}</div><div class="stage-transition-list">${transitions.map((t, transitionIndex) => transitionRow(t, stages, transitionIndex)).join('') || '<p class="hint stage-transition-empty">行き先はまだありません。</p>'}</div></section></section>`;
}
function transitionRow(t: { id: string; from: string; to: string; condition: string; label: string }, stages: { id: string; name: string }[], index: number) {
  return `<fieldset class="transition-row" data-id="${esc(t.id)}"><legend>遷移設定 ${index + 1}</legend><div class="transition-fields"><div class="transition-main-fields">${field('表示名', 'transitionLabel', t.label)}${select('行き先', 'to', stages.map(s => opt(s.id, s.name || '未命名の工程', t.to)).join('') + opt('completed', '完了', t.to))}<button type="button" class="ghost transition-remove" data-action="row-remove" aria-label="遷移設定 ${index + 1}を削除">×</button></div>${area('遷移条件', 'transitionCondition', t.condition)}</div></fieldset>`;
}
function modelChoiceEditorRow(choice: { name?: string; options?: string[] } = {}) {
  const options = choice.options?.length ? choice.options : [''];
  return `<fieldset class="editor-row model-choice-editor-row"><legend>Modelの選択肢</legend><div class="row-head">${field('選択肢名', 'choiceName', choice.name ?? '')}${button('choice-remove', '削除', 'small ghost')}</div><div class="model-option-rows">${options.map(option => `<div class="row model-option-row">${field('選択値', 'choiceOption', option)}${button('choice-option-remove', '×', 'small ghost')}</div>`).join('')}</div>${button('choice-option-add', '＋ 選択値を追加', 'small ghost')}</fieldset>`;
}
function readModelChoices(form: Element) {
  return [...form.querySelectorAll<HTMLElement>('.model-choice-editor-row')].map(row => ({
    name: (row.querySelector('[name=choiceName]') as HTMLInputElement).value,
    options: [...row.querySelectorAll<HTMLInputElement>('[name=choiceOption]')].map(input => input.value),
  }));
}
function modelTemplateAssist(target: 'modelName' | 'invocationMethod', choices: { name?: string }[] = []) {
  const tokens = choices.filter(choice => choice.name?.trim()).map(choice => {
    const token = `{{choice.${choice.name!.trim()}}}`;
    return `<button type="button" class="small ghost template-token" data-template-target="${target}" data-template="${esc(token)}">${htmlText(token)}</button>`;
  }).join('');
  return `<div class="template-assist" data-template-assist="${target}"><span class="template-assist-label">選択肢を挿入</span><div class="template-token-list">${tokens || '<small>選択肢を追加すると候補が表示されます。</small>'}</div></div>`;
}
function updateModelTemplateAssist(form: Element) {
  const choices = readModelChoices(form);
  for (const target of ['modelName', 'invocationMethod'] as const) {
    const assist = form.querySelector<HTMLElement>(`[data-template-assist="${target}"]`);
    if (assist) assist.outerHTML = localizeHtml(modelTemplateAssist(target, choices), language);
  }
}
function assetEditor(a?: Asset, newKind: Asset['kind'] = 'skill') {
  const kind = a?.kind ?? newKind;
  if (a && journalSkillKey(a)) {
    const useCase = journalSkillKey(a) === 'journal-review' ? `<label class="checkbox-label"><input type="checkbox" name="useCase"${a.useCase ? ' checked' : ''}>Runtimeから直接起動できるSkillにする</label>` : '<p class="hint">Journal Skillは直接起動せず、Journal記録設定でON/OFFを切り替えます。</p>';
    modal('資産を編集', `<form data-form="asset" data-id="${a.id}" data-kind="skill" class="form-stack"><div class="grid-two"><label><span class="field-label">名前</span><input aria-label="名前" name="name" type="text" value="${esc(a.name)}" readonly required></label><input type="hidden" name="scope" value="${esc(a.scope)}"></div>${area('コメント', 'explanation', a.explanation || a.description, true, false, 'AACL内でこのSkillを見分けるための短い補足です。Runtime YAMLのdescriptionとは別に管理します.')}${field('説明（Runtime YAML）', 'description', a.description, false, 'text', 'Runtime YAMLへ出力するSkillのdescriptionです。実行時にSkillの用途を伝えます。')}${area('本文（Markdown）', 'body', a.body, true, true)}${useCase}<section><div class="section-header"><h3>補助ファイル</h3>${button('file-add', '＋ 追加', 'small')}</div><div id="file-rows">${Object.entries(a.supportingFiles).map(([path, body]) => fileRow(path, body)).join('')}</div></section><p class="hint">JournalとJournal Reviewの標準Skillは、名前と削除状態を変更できません。</p>${formEnd()}</form>`); return;
  }
  const commonDescription = kind === 'skill' ? area('コメント', 'explanation', a?.explanation || a?.description, true, false, 'AACL内でこのSkillを見分けるための短い補足です。Runtime YAMLのdescriptionとは別に管理します。') : area('説明', 'description', a?.description);
  const runtimeDescription = kind === 'skill' ? field('説明（Runtime YAML）', 'description', a?.description, false, 'text', 'Runtime YAMLへ出力するSkillのdescriptionです。実行時にSkillの用途を伝えます。') : '';
  modal(a ? '資産を編集' : '資産を作成', `<form data-form="asset" data-id="${a?.id ?? ''}" data-kind="${kind}" class="form-stack">${!a ? `<div class="filters">${Object.entries(kinds).map(([k, title]) => button(`new-kind:${k}`, title, `filter ${kind === k ? 'active' : ''}`)).join('')}</div>` : ''}<div class="grid-two">${field('名前', 'name', a?.name)}${select('管理先', 'scope', a ? opt(a.scope, labelScope(a.scope)) : opt('global', 'Global', selectedScope) + projects.map(p => opt(p.id, p.name, selectedScope)).join(''))}</div>${commonDescription}${runtimeDescription}${kind === 'model' ? `<div class="grid-two model-template-fields"><div>${field('Model名', 'modelName', a?.modelName)}${modelTemplateAssist('modelName', a?.choices ?? [])}</div><div>${area('呼び出し方', 'invocationMethod', a?.invocationMethod)}${modelTemplateAssist('invocationMethod', a?.choices ?? [])}</div></div><section><div class="section-header"><div><h3>選択肢</h3><p class="hint">例: 実行系（codex luna / claude opes）、effort（low / medium / high）のように自由に追加できます。</p></div>${button('choice-add', '＋ 選択肢を追加', 'small')}</div><div id="model-choice-rows">${(a?.choices ?? []).map(choice => modelChoiceEditorRow(choice)).join('')}</div></section><p class="hint">呼び出し方では、選択肢を${'{{choice.name}}'}の形式で埋め込めます。認証情報は保存しないでください。</p>` : ''}${kind === 'workflow' ? `<section><div class="section-header"><h3>工程</h3>${button('stage-add', '＋ 工程を追加', 'small')}</div><div id="stage-rows">${(a?.stages ?? []).map((s, i) => stageRow(s, i, a ? stageRoleId(a.id, s.id) : '', a ? stageModelId(a.id, s.id) : '', a ? stageModelSelections(a.id, s.id) : {}, (a?.transitions ?? []).filter(t => t.from === s.id), a?.stages ?? [])).join('')}</div><p class="hint">先頭の工程から開始します。各工程に担当Roleと遷移条件を指定し、Modelは必要な工程だけ指定します。</p></section>` : kind !== 'model' ? area(kind === 'role' ? '責務・判断観点・成果責任' : '本文（Markdown）', 'body', kind === 'role' ? a?.responsibilities : a?.body, kind === 'skill', true) : ''}${kind === 'skill' ? `<label class="checkbox-label"><input type="checkbox" name="useCase"${a?.useCase ? ' checked' : ''}>Runtimeから直接起動できるSkillにする</label><section><div class="section-header"><h3>補助ファイル</h3>${button('file-add', '＋ 追加', 'small')}</div><div id="file-rows">${Object.entries(a?.supportingFiles ?? {}).map(([path, body]) => fileRow(path, body)).join('')}</div></section>` : ''}<p class="hint">認証情報は保存しないでください。</p>${formEnd()}</form>`, kind === 'workflow' ? 'workflow-editor' : '');
}
function fileRow(path = '', body = '') { return `<div class="editor-row file-editor"><div class="row-head"><strong>補助ファイル</strong>${button('row-remove', '削除', 'small ghost')}</div>${field('相対ファイル名', 'filePath', path)}<div class="spacer"></div>${area('内容', 'fileBody', body, false, true)}</div>`; }
function readStages(form: Element) { return [...form.querySelectorAll<HTMLElement>('.stage-editor')].map(row => ({ id: row.dataset.id!, name: (row.querySelector('[name=stageName]') as HTMLInputElement).value, additionalInstructions: (row.querySelector('[name=additionalInstructions]') as HTMLTextAreaElement).value, description: '' })); }
function readTransitions(form: Element) { return [...form.querySelectorAll<HTMLElement>('.transition-row')].map(row => { const from = row.closest<HTMLElement>('.stage-editor')?.dataset.id; if (!from) throw new Error('遷移元の工程を確認できません。'); return { id: row.dataset.id!, from, to: (row.querySelector('[name=to]') as HTMLSelectElement).value, condition: (row.querySelector('[name=transitionCondition]') as HTMLTextAreaElement).value, label: (row.querySelector('[name=transitionLabel]') as HTMLInputElement).value }; }); }
function updateTransitionTargets(form: Element) {
  const stages = readStages(form);
  for (const target of form.querySelectorAll<HTMLSelectElement>('.transition-row [name=to]')) {
    const selected = target.value;
    target.innerHTML = stages.map(s => opt(s.id, s.name || '未命名の工程', selected)).join('') + opt('completed', '完了', selected);
  }
}
function updateStageNumbers(form: Element) { form.querySelectorAll<HTMLElement>('.stage-editor .stage-title').forEach((label, index) => { label.textContent = `工程 ${index + 1}`; }); }
function updateTransitionNumbers(stage: HTMLElement) { stage.querySelectorAll<HTMLElement>('.transition-row').forEach((row, index) => { const label = `遷移設定 ${index + 1}`; row.querySelector<HTMLElement>('legend')!.textContent = label; row.querySelector<HTMLButtonElement>('.transition-remove')!.setAttribute('aria-label', `${label}を削除`); }); }
function updateTransitionEmptyState(stage: HTMLElement) {
  const list = stage.querySelector<HTMLElement>('.stage-transition-list')!;
  if (!list.querySelector('.transition-row')) list.innerHTML = '<p class="hint stage-transition-empty">行き先はまだありません。</p>';
}
function bindingEditor(sourceId: string, stageId?: string, existing?: Binding) {
  const a = assets.find(a => a.id === sourceId)!;
  const allowed: Record<Asset['kind'], string[]> = { workflow: ['role', 'skill', 'rule', 'model'], role: ['skill', 'rule'], skill: ['skill'], rule: [], model: ['skill', 'rule'] };
  const targets = assets.filter(v => v.id !== sourceId && (v.scope === 'global' || v.scope === selectedScope) && allowed[a.kind].includes(v.kind));
  const purpose = existing?.purpose === 'stage-role' || existing?.purpose === 'stage-model' ? `<input type="hidden" name="purpose" value="${existing.purpose}"><p class="hint">${existing.purpose === 'stage-role' ? '担当RoleはStageごとに必須です。' : 'Modelを指定したStageはサブエージェントで実行します。'}</p>` : select('使い方', 'purpose', opt('reference', '資産の参照', existing?.purpose) + (a.kind === 'workflow' ? opt(stageId ? 'stage-role' : 'entry-role', stageId ? '工程の担当Role' : '入口のRole', existing?.purpose) + (stageId ? opt('stage-model', '工程のModel', existing?.purpose) : '') : ''));
  const target = assets.find(asset => asset.id === existing?.targetId);
  const conditionFields = a.kind === 'model' && (existing?.purpose ?? 'reference') === 'reference' ? modelChoiceConditionFields(a.id, existing?.choiceConditions ?? []) : '';
  modal(existing ? '紐づけを付け替え' : '資産を紐づける', `<form data-form="binding" data-id="${existing?.id ?? ''}" data-source="${sourceId}" data-stage="${esc(stageId ?? '')}" class="form-stack"><p>${esc(a.name)}${stageId ? ` / ${esc(a.stages.find(s => s.id === stageId)?.name)}` : ''} → 参照先</p>${select('参照する資産', 'targetId', targets.map(t => opt(t.id, `${kinds[t.kind]} / ${t.name}${t.kind === 'model' && modelChoiceSummary(t) ? ` · ${modelChoiceSummary(t)}` : ''}`, existing?.targetId)).join(''))}${purpose}<div class="binding-model-choice-fields">${target?.kind === 'model' && existing?.purpose === 'stage-model' ? modelChoiceFields(target.id, existing.selectedChoices ?? {}) : ''}</div>${conditionFields}<p class="hint">管理先: ${esc(labelScope(selectedScope))}</p>${formEnd('紐づけを保存')}</form>`);
}
function journalEditor(run?: Run) {
  modal('Journalを記録', `<form data-form="journal" data-run="${run?.id ?? ''}" class="form-stack">${field('Task（作業名）', 'task', '', !run)}${area('Journal（Markdown）', 'body', '## Task\n\n## 実際に使ったもの\n\n## 良かった点\n\n## 困った点\n\n## 改善の種\n\n## 根拠・確かさ\n', true, true)}<p class="hint">書くことのない項目は省略できます。気づきは空行で区切ると個別に扱えます。</p>${formEnd('Journalを保存')}</form>`);
}

async function action(value: string, target: HTMLElement) {
  const [key, id, extra] = value.split(':');
  const a = assets.find(a => a.id === id);
  if (key === 'close') { dialog.close(); return; }
  if (key === 'asset-close') { location.hash = 'assets'; return; }
  if (key === 'refresh') { await refresh(); return; }
  if (key === 'record-load') { await loadMoreRecords(id as 'journals' | 'review' | 'history'); return; }
  if (key === 'filter') { filter = id; renderAssets(); return; }
  if (key === 'asset-new' || key === 'new-kind') { assetEditor(undefined, (id as Asset['kind']) || 'skill'); return; }
  if (key === 'asset-edit') { assetEditor(a); return; }
  if (key === 'asset-delete') {
    const preview = await api<AssetDeletionPreview>('asset.delete.preview', { assetId: id });
    const bindingItems = preview.bindings.map(b => `<li><strong>${b.direction === 'incoming' ? 'このAssetを参照' : 'このAssetから参照'}</strong> — ${esc(b.sourceName)}${b.stageName ? ` / ${esc(b.stageName)}` : ''} → ${esc(b.targetName)} <span class="mono">${esc(labelScope(b.scope))} · rev.${b.revision}</span></li>`).join('');
    const commonItems = preview.projectCommons.map(c => `<li>${esc(c.projectName)} のProject Common <span class="mono">rev.${c.revision}</span></li>`).join('');
    const hasReferences = preview.bindings.length > 0 || preview.projectCommons.length > 0;
    const expectedBindings = preview.bindings.map(({ id: bindingId, revision }) => ({ id: bindingId, revision }));
    const expectedProjectCommons = preview.projectCommons.map(({ id: commonId, revision }) => ({ id: commonId, revision }));
    modal('資産削除の確認', `<p><strong>${esc(preview.asset.name)}</strong>を削除状態にし、検索・利用対象から外します。過去revisionとRun Snapshotは保持します。</p>${hasReferences ? `<section class="section"><h3>同時に解除する参照</h3>${bindingItems ? `<h4>紐づけ</h4><ul>${bindingItems}</ul>` : ''}${commonItems ? `<h4>Project Common</h4><ul>${commonItems}</ul>` : ''}</section>` : '<p class="hint">このAssetを参照する紐づけとProject Commonはありません。</p>'}<form data-form="asset-delete" class="form-stack"><input type="hidden" name="assetId" value="${esc(preview.asset.id)}"><input type="hidden" name="expectedRevision" value="${preview.asset.revision}"><input type="hidden" name="expectedBindingRevisions" value="${esc(JSON.stringify(expectedBindings))}"><input type="hidden" name="expectedProjectCommonRevisions" value="${esc(JSON.stringify(expectedProjectCommons))}"><label class="checkbox-label"><input type="checkbox" name="confirm" required>このAssetの削除${hasReferences ? 'と一覧の参照解除' : ''}を確定します</label>${formEnd(hasReferences ? '参照を解除して削除' : 'このAssetを削除')}</form>`);
    return;
  }
  if (key === 'stage-add') { const root = dialog.querySelector('#stage-rows')!; root.insertAdjacentHTML('beforeend', stageRow({ id: crypto.randomUUID(), name: '', additionalInstructions: '' }, root.children.length, '', '', {}, [], readStages(dialog))); updateTransitionTargets(dialog); return; }
  if (key === 'role-create') {
    const row = target.closest<HTMLElement>('.stage-editor')!, panel = row.querySelector<HTMLElement>('.new-role-fields')!, role = row.querySelector<HTMLSelectElement>('[name=stageRole]')!;
    panel.hidden = !panel.hidden;
    role.disabled = !panel.hidden;
    target.textContent = panel.hidden ? '＋ 新しいRole' : '作成をやめる';
    if (!panel.hidden) { panel.dataset.previousRole = role.value; role.value = ''; row.querySelector<HTMLInputElement>('[name=newRoleName]')?.focus(); }
    else role.value = panel.dataset.previousRole ?? '';
    return;
  }
  if (key === 'choice-add') { dialog.querySelector('#model-choice-rows')!.insertAdjacentHTML('beforeend', localizeHtml(modelChoiceEditorRow(), language)); updateModelTemplateAssist(dialog); return; }
  if (key === 'choice-remove') { target.closest('.model-choice-editor-row')?.remove(); updateModelTemplateAssist(dialog); return; }
  if (key === 'choice-condition-add') {
    const model = assets.find(asset => asset.id === target.closest<HTMLFormElement>('form')?.dataset.source && asset.kind === 'model');
    const rows = dialog.querySelectorAll('.choice-condition-row').length;
    if (model) dialog.querySelector('#choice-condition-rows')!.insertAdjacentHTML('beforeend', modelChoiceConditionRow(model, {}, rows));
    return;
  }
  if (key === 'choice-condition-remove') {
    target.closest('.choice-condition-row')?.remove();
    updateChoiceConditionNumbers(dialog);
    return;
  }
  if (key === 'choice-option-add') { target.closest<HTMLElement>('.model-choice-editor-row')!.querySelector('.model-option-rows')!.insertAdjacentHTML('beforeend', `<div class="row model-option-row">${field('選択値', 'choiceOption')}${button('choice-option-remove', '×', 'small ghost')}</div>`); return; }
  if (key === 'choice-option-remove') {
    const row = target.closest<HTMLElement>('.model-choice-editor-row')!;
    const options = row.querySelectorAll('.model-option-row');
    if (options.length <= 1) throw new Error('選択肢には少なくとも1つの値が必要です。');
    target.closest('.model-option-row')?.remove(); return;
  }
  if (key === 'file-add') { dialog.querySelector('#file-rows')!.insertAdjacentHTML('beforeend', fileRow()); return; }
  if (key === 'transition-add') {
    const stage = target.closest<HTMLElement>('.stage-editor'), stages = readStages(dialog);
    if (!stage || !stages.length) throw new Error('先に工程を追加してください。');
    const index = stages.findIndex(s => s.id === stage.dataset.id), next = stages[index + 1];
    const transition = { id: crypto.randomUUID(), from: stage.dataset.id!, to: next?.id ?? 'completed', condition: '', label: '' };
    stage.querySelector('.stage-transition-empty')?.remove();
    stage.querySelector('.stage-transition-list')!.insertAdjacentHTML('beforeend', transitionRow(transition, stages, stage.querySelectorAll('.transition-row').length)); updateTransitionNumbers(stage);
    return;
  }
  if (key === 'row-remove') {
    const transition = target.closest<HTMLElement>('.transition-row');
    if (transition) { const stage = transition.closest<HTMLElement>('.stage-editor')!; transition.remove(); updateTransitionNumbers(stage); updateTransitionEmptyState(stage); return; }
    const stage = target.closest<HTMLElement>('.stage-editor');
    if (stage) {
      const stageId = stage.dataset.id!;
      for (const row of dialog.querySelectorAll<HTMLElement>('.transition-row')) if (row.closest('.stage-editor') === stage || (row.querySelector('[name=to]') as HTMLSelectElement).value === stageId) row.remove();
      stage.remove();
      updateStageNumbers(dialog);
      updateTransitionTargets(dialog);
      dialog.querySelectorAll<HTMLElement>('.stage-editor').forEach(stage => { updateTransitionNumbers(stage); updateTransitionEmptyState(stage); });
      return;
    }
    target.closest('.file-editor')?.remove();
    return;
  }
  if (key === 'usecase') { await api('skill.usecase', { assetId: id, enabled: !a!.useCase, provenance: provenance('直接起動設定を変更') }, true); await refresh(); return; }
  if (key === 'binding-new') { bindingEditor(id, extra); return; }
  if (key === 'binding-edit') { const b = bindings.find(b => b.id === id)!; bindingEditor(b.sourceId, b.stageId, b); return; }
  if (key === 'binding-remove') { const binding = bindings.find(value => value.id === id); if (!binding) throw new Error('紐づけを再取得してください。'); await api('binding.remove', { id, expectedRevision: binding.revision, provenance: provenance('紐づけを解除') }, true); notify('紐づけを解除しました。'); await refresh(); return; }
  if (key === 'run-new') {
    const workflows = assets.filter(a => a.kind === 'workflow' && (a.scope === 'global' || a.scope === selectedScope));
    if (!workflows.length) { notify('先にWorkflowを作成してください。'); assetEditor(undefined, 'workflow'); return; }
    modal('Workflow Runを開始', `<form data-form="run" class="form-stack">${select('Workflow', 'workflowId', workflows.map(a => opt(a.id, a.name, id)).join(''))}${select('実行するRuntime', 'runtime', opt('claude', 'Claude Code') + opt('codex', 'Codex'))}${area('実行する依頼', 'instruction')}${field('対象', 'target', '', false)}<p class="hint">管理先: ${esc(labelScope(selectedScope))}。開始時点の資産と紐づけを使います。</p>${formEnd('Runを開始')}</form>`); return;
  }
  if (key === 'run-transition' || key === 'run-cancel') {
    const selectedTransition = key === 'run-transition' ? ((screenData.detail as { snapshot?: Snapshot } | undefined)?.snapshot?.workflow.transitions.find(t => t.id === extra) ?? null) : null;
    modal(key === 'run-cancel' ? 'Runを中止' : '工程を進める', `<form data-form="${key}" data-run="${id}" data-transition="${esc(extra ?? '')}" class="form-stack">${selectedTransition ? `<p class="hint">遷移条件: ${esc(selectedTransition.condition)}</p>` : ''}${area(key === 'run-cancel' ? '中止理由' : '遷移判断の報告', 'report')}${formEnd(key === 'run-cancel' ? '中止する' : '選択した遷移を実行')}</form>`); return;
  }
  if (key === 'journal-new') { const settings = await api<{ journalEnabled: boolean }>('settings.get'); if (!settings.journalEnabled) { notify('Journal記録が無効です。設定・接続で有効にしてください。'); return; } const run = (screenData.runs as Run[] | undefined)?.find(r => r.id === id); journalEditor(run); return; }
  if (key === 'insight') { await api('insight.status', { insightId: id, status: extra }, true); notify('気づきの状態を更新しました。'); await refresh(); return; }
  if (key === 'review-decide') { modal('Review項目への判断', `<form data-form="review-decision" data-id="${id}" data-decision="${extra}" class="form-stack"><p>判断: ${states[extra]}</p>${area('判断の内容', 'note', '', false)}${formEnd('判断を記録')}</form>`); return; }
  if (key === 'proposal-new') {
    const journals = (screenData.journals as Journal[]) ?? [], insights = (screenData.insights as Insight[]) ?? [];
    if (!journals.length) throw new Error('提案の根拠となるJournalを先に記録してください。');
    modal('改善を提案', `<form data-form="proposal" class="form-stack">${field('提案名', 'title')}${area('観測した状況', 'observedContext')}${area('変更の内容', 'proposedChange')}${area('理由', 'reason')}${select('変更する資産', 'assetId', assets.map(a => opt(a.id, `${kinds[a.kind]} / ${a.name}`)).join(''))}${area('更新後の本文・責務', 'body', '', true, true)}<fieldset><h3>根拠Journal・レビュー対象</h3>${journals.map(j => `<label class="checkbox-label"><input type="checkbox" name="journalIds" value="${j.id}">${esc(j.task || date(j.createdAt))}</label>`).join('')}</fieldset><fieldset><h3>適用時に処理する気づき</h3>${insights.filter(i => i.status === 'pending').map(i => `<label class="checkbox-label"><input type="checkbox" name="insightIds" value="${i.id}">${esc(i.body.slice(0, 90))}</label>`).join('')}</fieldset><p class="hint">Workflow構成や複数資産の変更を含む提案は、接続中のAIから作成できます。</p>${formEnd('提案を保存')}</form>`); return;
  }
  if (key === 'proposal-decide') { modal('提案への判断', `<form data-form="decision" data-id="${id}" data-choice="${extra}" class="form-stack"><p>判断: ${states[extra]}</p>${area('判断の内容', 'note')}${formEnd('判断を記録')}</form>`); return; }
  if (key === 'proposal-apply') { await api('proposal.apply', { proposalId: id }, true); notify('変更を適用し、対象の気づきを処理済みにしました。'); await refresh(); return; }
  if (key === 'history-asset') {
    const data = await api<{ revisions: Asset[] }>('history.get', { entityId: id });
    const current = data.revisions[0];
    modal('資産の履歴と復元', `<p>${esc(current.name)} · 現在 rev. ${current.revision}</p><div class="stack">${data.revisions.map(r => `<div class="editor-row"><div class="row spread"><strong>rev. ${r.revision}</strong><span class="mono">${date(r.updatedAt)}</span>${r.revision !== current.revision ? button(`asset-restore:${id}:${r.revision}`, 'この版を復元', 'small') : badge('現在')}</div><div class="diff"><div><small>この版</small><pre>${esc(JSON.stringify(r, null, 2))}</pre></div><div><small>現在</small><pre>${esc(JSON.stringify(current, null, 2))}</pre></div></div></div>`).join('')}</div>`); return;
  }
  if (key === 'asset-restore') { await api('asset.restore', { assetId: id, revision: Number(extra), expectedRevision: a!.revision }, true); dialog.close(); notify('選択した版を新しいrevisionとして復元しました。'); await refresh(); return; }
  if (key === 'changeset-restore') {
    const loaded = await api<{ changeSets: ChangeSet[] }>('history.get', { changeSetId: id, includeDetails: true });
    const c = loaded.changeSets[0];
    if (!c) throw new Error('変更履歴が見つかりません。');
    modal('変更前の状態へ復元', `<p>対象の変更前の内容を、新しいrevisionとして保存します。</p>${details('対象の変更', c)}<form data-form="changeset-restore" data-id="${id}">${formEnd('復元する')}</form>`); return;
  }
  if (key === 'project-new') { modal('Projectを登録', `<form data-form="project" class="form-stack">${field('Project名', 'name')}${field('Project root（絶対パス）', 'root')}<p class="hint">Globalの紐づけをコピーし、Claude Code / Codexの入口を作成します。</p>${formEnd('Projectを登録')}</form>`); return; }
  if (key === 'common-edit') { const common = screenData.common as Common; modal('Project共通のRule', `<form data-form="common" class="form-stack">${assets.filter(a => a.kind === 'rule' && (a.scope === 'global' || a.scope === selectedScope)).map(a => `<label class="checkbox-label"><input type="checkbox" name="ruleIds" value="${a.id}"${common.ruleIds.includes(a.id) ? ' checked' : ''}>${esc(a.name)}</label>`).join('') || '<p>先にRuleを作成してください。</p>'}${formEnd()}</form>`); return; }
  if (key === 'runtime-new') {
    modal('Runtime設定先を追加', `<form data-form="runtime" class="form-stack">${select('Runtime', 'runtime', opt('claude', 'Claude Code') + opt('codex', 'Codex'))}${select('実行環境', 'platform', opt('wsl', 'WSL') + opt('windows', 'Windows'))}${field('設定先（.claude / .codex の絶対パス）', 'path')}<p class="hint">検出した標準設定先:</p><pre>${esc((screenData.candidates as { path: string }[]).map(c => c.path).join('\n'))}</pre><p class="hint">管理先: ${esc(labelScope(selectedScope))}</p>${formEnd('追加して入口を生成')}</form>`); return;
  }
  if (key === 'journal-skills') { await api('setup.skills', {}, true); notify('JournalとJournal ReviewのSkillを導入しました。'); await refresh(); return; }
  if (key === 'runtime-sync') { await api('runtime.sync', {}, true); notify('入口を同期しました。'); await refresh(); return; }
  if (key === 'runtime-remove') { await api('runtime.unregister', { targetId: id }, true); notify('管理を解除しました。生成済みファイルは残っています。'); await refresh(); return; }
  if (key === 'backup' || key === 'export') { modal(key === 'backup' ? 'Backupを保存' : 'データを出力', `<form data-form="${key}" class="form-stack">${field(key === 'backup' ? '新規出力fileの絶対パス' : '新規出力directoryの絶対パス', 'path')}${formEnd('指定先へ保存')}</form>`); }
}

async function submit(form: HTMLFormElement) {
  const data = new FormData(form), get = (key: string) => String(data.get(key) ?? ''), key = form.dataset.form;
  if (key === 'asset-delete') {
    if (!data.has('confirm')) throw new Error('削除を確認してください。');
    await api('asset.delete', { assetId: get('assetId'), expectedRevision: Number(get('expectedRevision')), expectedBindingRevisions: JSON.parse(get('expectedBindingRevisions')), expectedProjectCommonRevisions: JSON.parse(get('expectedProjectCommonRevisions')), confirmed: true, provenance: { ...provenance('Asset削除を確認'), decision: 'ユーザーが削除確認を確定' } }, true);
  } else if (key === 'asset') {
    const old = assets.find(a => a.id === form.dataset.id), kind = form.dataset.kind as Asset['kind'];
    const stages = readStages(form);
    const transitions = readTransitions(form);
    const files = [...form.querySelectorAll('.file-editor')].map(row => [(row.querySelector('[name=filePath]') as HTMLInputElement).value, (row.querySelector('[name=fileBody]') as HTMLTextAreaElement).value]);
    if (new Set(files.map(([name]) => name)).size !== files.length) throw new Error('補助ファイル名が重複しています。');
    const choices = kind === 'model' ? readModelChoices(form) : [];
    if (kind === 'model' && choices.some(choice => !choice.name.trim() || choice.options.some(option => !option.trim()))) throw new Error('Modelの選択肢名と選択値を入力してください。');
    const explanation = kind === 'skill' ? get('explanation') : '';
    const description = kind === 'skill' ? get('description').trim() || explanation : get('description');
    const asset = { kind, name: get('name'), description, explanation, scope: get('scope'), modelName: kind === 'model' ? get('modelName') : old?.modelName ?? '', invocationMethod: kind === 'model' ? get('invocationMethod') : old?.invocationMethod ?? '', choices, body: kind === 'role' || kind === 'workflow' || kind === 'model' ? old?.body ?? '' : get('body'), responsibilities: kind === 'role' ? get('body') : old?.responsibilities ?? '', useCase: kind === 'skill' && data.has('useCase'), supportingFiles: Object.fromEntries(files), stages, transitions, entryStage: old?.entryStage && stages.some(s => s.id === old.entryStage) ? old.entryStage : stages[0]?.id ?? '', metadata: old?.metadata ?? {} };
    if (kind === 'workflow') {
      const workflowId = old?.id ?? crypto.randomUUID(), newRoleChanges: Change[] = [];
      const assignments = [...form.querySelectorAll<HTMLElement>('.stage-editor')].map(row => {
        const stageId = row.dataset.id!, panel = row.querySelector<HTMLElement>('.new-role-fields')!;
        if (!panel.hidden) {
          const roleName = (row.querySelector('[name=newRoleName]') as HTMLInputElement).value.trim();
          const description = (row.querySelector('[name=newRoleDescription]') as HTMLTextAreaElement).value.trim();
          if (!roleName || !description) throw new Error('新しいRoleの名前と説明を入力してください。');
          const roleId = crypto.randomUUID();
          newRoleChanges.push({ type: 'asset.create', id: roleId, asset: { kind: 'role', name: roleName, description, explanation: '', body: '', responsibilities: (row.querySelector('[name=newRoleResponsibilities]') as HTMLTextAreaElement).value, scope: 'global', useCase: false, modelName: '', invocationMethod: '', choices: [], metadata: {}, supportingFiles: {}, stages: [], transitions: [], entryStage: '' } });
          return { stageId, roleId, modelId: (row.querySelector('[name=stageModel]') as HTMLSelectElement).value, selectedChoices: readModelSelections(row) };
        }
        return { stageId, roleId: (row.querySelector('[name=stageRole]') as HTMLSelectElement).value, modelId: (row.querySelector('[name=stageModel]') as HTMLSelectElement).value, selectedChoices: readModelSelections(row) };
      });
      const roleChanges = stageRoleBindingChanges(workflowId, selectedScope, assignments, bindings);
      const modelChanges = stageModelBindingChanges(workflowId, selectedScope, assignments, bindings);
      const workflowChange: Change = old ? { type: 'asset.save', id: workflowId, expectedRevision: old.revision, asset } : { type: 'asset.create', id: workflowId, asset };
      const changes: Change[] = [
        ...roleChanges.filter(change => change.type === 'binding.remove'),
        ...modelChanges.filter(change => change.type === 'binding.remove'),
        workflowChange,
        ...newRoleChanges,
        ...roleChanges.filter(change => change.type !== 'binding.remove'),
        ...modelChanges.filter(change => change.type !== 'binding.remove'),
      ];
      await api('changeset.apply', { changes, provenance: provenance(old ? 'Workflowを編集' : 'Workflowを作成') }, true);
      location.hash = `assets/${workflowId}`;
    } else {
      const result = await api<{ entities: Asset[] }>('asset.save', { id: old?.id, ...(old ? { expectedRevision: old.revision } : {}), asset, provenance: provenance(old ? '資産を編集' : '資産を作成') }, true);
      location.hash = `assets/${result.entities[0].id}`;
    }
  } else if (key === 'binding') { const existing = bindings.find(binding => binding.id === form.dataset.id); await api('binding.save', { id: form.dataset.id || undefined, ...(existing ? { expectedRevision: existing.revision } : {}), binding: { scope: selectedScope, sourceId: form.dataset.source, stageId: form.dataset.stage || undefined, targetId: get('targetId'), purpose: get('purpose'), selectedChoices: readModelSelections(form), choiceConditions: readModelChoiceConditions(form) }, provenance: provenance('資産の紐づけを編集') }, true); }
  else if (key === 'run') {
    const result = await api<{ run: Run }>('run.start', { workflowId: get('workflowId'), runtime: get('runtime'), instruction: get('instruction'), target: get('target'), ...(selectedScope !== 'global' ? { projectId: selectedScope } : {}) }, true);
    location.hash = `runs/${result.run.id}`;
  } else if (key === 'run-transition' || key === 'run-cancel') {
    const run = (screenData.runs as Run[]).find(r => r.id === form.dataset.run)!;
    const result = await api<{ outcome?: string }>(key === 'run-cancel' ? 'run.cancel' : 'run.transition', key === 'run-cancel' ? { contextHandle: run.contextHandle, reason: get('report') } : { contextHandle: run.contextHandle, version: run.version, transitionId: form.dataset.transition, report: get('report') }, true);
    if (result.outcome === 'stale') throw new Error('Runは別の操作で進んでいます。一覧を再読み込みしてください。');
  } else if (key === 'journal') {
    const run = (screenData.runs as Run[] | undefined)?.find(r => r.id === form.dataset.run);
    await api('journal.write', { body: get('body'), task: get('task') || undefined, ...(run ? run.status === 'active' ? { contextHandle: run.contextHandle } : { postRunId: run.id } : {}) }, true);
  } else if (key === 'proposal') {
    const a = assets.find(a => a.id === get('assetId'))!;
    if (!a) throw new Error('先に変更対象の資産を作成してください。');
    const { id, revision: _rev, createdAt: _created, updatedAt: _updated, ...payload } = a;
    const ids = data.getAll('journalIds');
    await api('proposal.save', { title: get('title'), observedContext: get('observedContext'), proposedChange: get('proposedChange'), reason: get('reason'), evidenceJournalIds: ids, reviewedJournalIds: ids, affectedAssetIds: [id], affectedBindingIds: bindings.filter(b => b.sourceId === id || b.targetId === id).map(b => b.id), affectedProjectIds: a.scope === 'global' ? projects.map(p => p.id) : [a.scope], changes: [{ type: 'asset.save', id, expectedRevision: a.revision, asset: { ...payload, [a.kind === 'role' ? 'responsibilities' : 'body']: get('body') } }], insightIds: data.getAll('insightIds') }, true);
  } else if (key === 'review-decision') await api('review.decide', { reviewItemId: form.dataset.id, decision: form.dataset.decision, note: get('note') }, true);
  else if (key === 'decision') await api('proposal.decide', { proposalId: form.dataset.id, choice: form.dataset.choice, note: get('note') }, true);
  else if (key === 'changeset-restore') await api('changeset.restore', { changeSetId: form.dataset.id }, true);
  else if (key === 'project') await api('project.init', { name: get('name'), root: get('root') }, true);
  else if (key === 'common') await api('common.save', { projectId: selectedScope, expectedRevision: (screenData.common as Common).revision, ruleIds: data.getAll('ruleIds'), provenance: provenance('Project共通Ruleを編集') }, true);
  else if (key === 'runtime') await api('runtime.register', { runtime: get('runtime'), platform: get('platform'), path: get('path'), scope: selectedScope }, true);
  else if (key === 'settings') await api('settings.save', { timeoutHours: Number(get('timeoutHours')), journalEnabled: data.has('journalEnabled') }, true);
  else if (key === 'export' || key === 'backup') await api(`data.${key}`, key === 'backup' ? { path: get('path') } : { directory: get('path') });
  dialog.close(); notify(key === 'asset-delete' ? 'Assetを削除し、参照を解除しました。' : key === 'run' ? 'Runを開始しました。' : '保存しました。'); await refresh();
}

document.addEventListener('toggle', event => {
  const panel = event.target instanceof HTMLDetailsElement ? event.target : null;
  if (panel?.open && panel.dataset.lazyKind) void loadRecordPanel(panel);
}, true);
document.addEventListener('click', event => {
  const templateButton = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-template]');
  if (templateButton) {
    const form = templateButton.closest('form') as HTMLFormElement | null;
    const input = form?.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${templateButton.dataset.templateTarget}"]`);
    if (!input) return;
    const token = templateButton.dataset.template ?? '', start = input.selectionStart ?? input.value.length, end = input.selectionEnd ?? start;
    input.setRangeText(token, start, end, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    return;
  }
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!target) return;
  const control = target as HTMLButtonElement;
  control.disabled = true;
  action(target.dataset.action!, target).catch(error => notify(errorMessage(error))).finally(() => { control.disabled = false; });
});
document.addEventListener('submit', event => {
  const form = event.target as HTMLFormElement;
  if (!form.dataset.form) return;
  event.preventDefault();
  const button = form.querySelector<HTMLButtonElement>('button[type=submit]')!, error = form.querySelector('.form-error')!;
  button.disabled = true; error.textContent = '';
  submit(form).catch(e => { error.textContent = errorMessage(e); }).finally(() => { button.disabled = false; });
});
document.addEventListener('change', event => {
  const input = event.target as HTMLInputElement;
  if (input.id === 'language-select') {
    language = input.value === 'ja' ? 'ja' : 'en';
    localStorage.setItem('aacl-language', language);
    document.documentElement.lang = language;
    void render().catch(e => notify(errorMessage(e)));
    return;
  }
  if (input.id === 'scope-select') { selectedScope = input.value; location.hash = route()[0]; void refresh(); }
  if (input.name === 'stageName') {
    updateTransitionTargets(dialog);
  }
  if (input.name === 'stageModel') {
    const row = input.closest<HTMLElement>('.stage-editor');
    if (row) row.querySelector<HTMLElement>('.model-choice-container')!.innerHTML = modelChoiceFields(input.value);
  }
  if (input.name === 'targetId' || input.name === 'purpose') {
    const form = input.closest<HTMLFormElement>('[data-form=binding]');
    const target = form ? assets.find(asset => asset.id === (form.querySelector('[name=targetId]') as HTMLSelectElement)?.value) : undefined;
    const purpose = form?.querySelector<HTMLSelectElement>('[name=purpose]')?.value;
    if (form) form.querySelector<HTMLElement>('.binding-model-choice-fields')!.innerHTML = target?.kind === 'model' && purpose === 'stage-model' ? modelChoiceFields(target.id) : '';
  }
});
document.addEventListener('input', event => {
  const input = event.target as HTMLInputElement;
  if (input.id === 'asset-search') { const position = input.selectionStart; search = input.value; renderAssets(); const next = document.querySelector<HTMLInputElement>('#asset-search')!; next.focus(); next.setSelectionRange(position, position); }
  if (input.name === 'choiceName') {
    const form = input.closest<HTMLFormElement>('[data-form=asset]');
    if (form?.dataset.kind === 'model') updateModelTemplateAssist(form);
  }
});
function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
window.addEventListener('hashchange', () => { if (!loading) void render().catch(e => notify(errorMessage(e))); });
void refresh();
