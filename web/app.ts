import type { Asset, AssetDeletionPreview, Binding, Change, ChangeSet, Common, Decision, Delivery, Diagnostic, History, Insight, Journal, Project, Proposal, Provenance, ReviewItem, Run, RunEvent, RuntimeTarget, Snapshot } from '../src/schema.ts';
import { relatedWorkflows, stageModelBindingChanges, stageRoleBindingChanges, workflowDiagram } from './view-model.ts';

const app = document.querySelector<HTMLDivElement>('#app')!;
const dialog = document.querySelector<HTMLDialogElement>('#dialog')!;
const kinds = { workflow: 'Workflow', skill: 'Skill', role: 'Role', rule: 'Rule', model: 'Model' };
const symbols = { workflow: '◇', skill: '✧', role: '◉', rule: '≡', model: 'M' };
const states: Record<string, string> = { active: '進行中', completed: '完了', cancelled: '中止', failed: '終了・失敗', pending: '保留', processed: '処理済み', rejected: '却下', approved: '承認', deferred: '保留' };
const reviewDecisionLabels: Record<string, string> = { approved: '処理済み', deferred: '保留', rejected: '却下' };
const typeLabels: Record<string, string> = { next: '次工程', return: '差し戻し', retry: '再試行', reject: '却下・差し戻し', complete: '完了' };
const navs = [['assets', '資産ライブラリ', 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z'], ['runs', 'Workflow Run', 'M5 5h5v5H5zM14 14h5v5h-5zM10 7h6v7'], ['journals', 'Journal', 'M5 4h14v16H5zM8 8h8M8 12h8M8 16h5'], ['review', 'Journal Review', 'M4 12a8 8 0 1 0 3-6M4 4v5h5M9 12l2 2 4-4'], ['history', '変更履歴', 'M4 12a8 8 0 1 0 3-6M4 4v5h5M12 7v5l3 2'], ['diagnostics', '診断', 'M3 12h4l3-7 4 14 3-7h4'], ['settings', '設定・接続', 'M4 7h16M4 17h16M8 4v6M16 14v6']];
let assets: Asset[] = [], projects: Project[] = [], bindings: Binding[] = [];
let selectedScope = 'global', filter = 'all', search = '', loading = false;
let screenData: Record<string, unknown> = {};
let toastTimer: ReturnType<typeof setTimeout>;
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const date = (value: string) => new Date(value).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' });
const name = (id: string) => assets.find(a => a.id === id)?.name ?? id;
const labelScope = (id: string) => id === 'global' ? 'Global' : projects.find(p => p.id === id)?.name ?? id;
const icon = (path: string) => `<svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;
const badge = (text: string, color = '') => `<span class="badge ${color}">${esc(text)}</span>`;
const status = (s: string) => badge(states[s] ?? s, ['completed', 'approved', 'processed', 'active'].includes(s) ? 'green' : ['failed', 'rejected'].includes(s) ? 'red' : 'amber');
const button = (action: string, label: string, cls = '') => `<button type="button" class="${cls}" data-action="${esc(action)}">${esc(label)}</button>`;
const empty = (title: string, description: string, action = '', compact = false) => `<div class="empty ${compact ? 'small' : ''}"><div class="empty-symbol" aria-hidden="true">◇</div><h2>${esc(title)}</h2><p>${esc(description)}</p>${action}</div>`;
const details = (title: string, data: unknown) => `<details><summary>${esc(title)}</summary><pre>${esc(JSON.stringify(data, null, 2))}</pre></details>`;
const opt = (value: string, label: string, selected?: string) => `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`;
const field = (label: string, key: string, value = '', required = true, type = 'text') => `<label>${esc(label)}<input name="${key}" type="${type}" value="${esc(value)}"${required ? ' required' : ''}></label>`;
const area = (label: string, key: string, value = '', required = true, code = false) => `<label>${esc(label)}<textarea name="${key}"${required ? ' required' : ''}${code ? ' class="code-input" spellcheck="false"' : ''}>${esc(value)}</textarea></label>`;
const select = (label: string, key: string, options: string, required = false) => `<label>${esc(label)}<select name="${key}"${required ? ' required' : ''}>${options}</select></label>`;
const formEnd = (label = '保存する') => `<p class="form-error" role="alert"></p><div class="form-footer">${button('close', 'キャンセル')}<button class="primary" type="submit">${esc(label)}</button></div>`;
const provenance = (request: string): Provenance => ({ origin: 'ui', userRequest: request, reason: '', sources: [], proposedBy: '', decision: '' });
const route = () => (location.hash.slice(1) || 'assets').split('/');
function notify(message: string) { const t = document.querySelector('#toast')!; t.textContent = message; t.classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('visible'), 5000); }
async function api<T>(operation: string, input: object = {}, write = false): Promise<T> {
  const response = await fetch(`/api/${operation}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(write ? { ...input, operationId: crypto.randomUUID() } : input) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  if (data.runtimeSync?.some((r: { ok: boolean }) => !r.ok)) notify('保存しました。Runtime入口の生成に失敗があります。診断を確認してください。');
  return data as T;
}
function modal(title: string, html: string, layout = '') { dialog.dataset.layout = layout; dialog.innerHTML = `<div class="dialog-head"><h2>${esc(title)}</h2>${button('close', '×', 'icon-button')}</div>${html}`; if (!dialog.open) dialog.showModal(); }
function pageHeading(title: string, description: string, action = '') { return `<header class="page-heading"><div><h1>${title}</h1><p>${description}</p></div>${action}</header>`; }
function shell(content: string) {
  const [page] = route();
  app.innerHTML = `<div class="shell"><aside class="sidebar"><a class="brand" href="#assets"><span class="brand-mark">Λ</span><div><div class="brand-name">AACL</div><small>AGENT ASSET CONTROL LAYER</small></div></a><div class="nav-label">ワークスペース</div><nav>${navs.slice(0, 4).map(([key, title, path]) => `<a href="#${key}" class="nav-item ${page === key ? 'active' : ''}"${page === key ? ' aria-current="page"' : ''}>${icon(path)}${title}</a>`).join('')}</nav><div class="nav-label">管理</div><nav>${navs.slice(4, 6).map(([key, title, path]) => `<a href="#${key}" class="nav-item ${page === key ? 'active' : ''}">${icon(path)}${title}</a>`).join('')}</nav><div class="sidebar-bottom"><a class="nav-item ${page === 'settings' ? 'active' : ''}" href="#settings">${icon(navs[6][2])}設定・接続</a><div class="connection"><span class="dot"></span>ローカルに接続済み</div></div></aside><main class="main"><div class="topbar"><div class="breadcrumb">ワークスペース &nbsp; / &nbsp; <span>${esc(labelScope(selectedScope))}</span></div><label class="scope-select"><span class="mono">SCOPE</span><select id="scope-select" aria-label="管理先">${opt('global', 'Global', selectedScope)}${projects.map(p => opt(p.id, p.name, selectedScope)).join('')}</select></label></div>${content}<div class="footer-note">AACL · あなたの開発方法を、あなたの手で。</div></main></div>`;
}
async function refresh() {
  if (loading) return;
  loading = true;
  try {
    const [a, p, b] = await Promise.all([api<{ assets: Asset[] }>('asset.list'), api<{ projects: Project[] }>('project.list'), api<{ bindings: Binding[] }>('binding.list', { scope: selectedScope })]);
    assets = a.assets; projects = p.projects; bindings = b.bindings;
    await render();
  } catch (error) { shell(`<div class="glass error-panel"><h2>読み込めませんでした</h2><p>${esc((error as Error).message)}</p>${button('refresh', '再読み込み')}</div>`); }
  finally { loading = false; }
}
function diagram(asset: Asset) {
  const d = workflowDiagram(asset);
  return `<div class="diagram"><svg width="${d.width}" height="${d.height}" viewBox="0 0 ${d.width} ${d.height}" role="img" aria-label="${esc(asset.name)}の許可遷移"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#819cab"/></marker></defs>${d.edges.map(e => `<path class="edge ${e.type}" d="${e.path}" marker-end="url(#arrow)"/><text class="edge-label" x="${e.labelX}" y="${e.labelY}" text-anchor="middle">${esc(e.label)} · ${typeLabels[e.type]}</text>`).join('')}${d.nodes.map((n, i) => `<rect class="${n.id === 'completed' ? 'end-node' : 'node'}" x="${n.x}" y="125" width="160" height="48" rx="13"/><text class="node-label" x="${n.x + 80}" y="154" text-anchor="middle">${esc(n.name.length > 13 ? n.name.slice(0, 13) + '…' : n.name)}</text><text class="node-number" x="${n.x + 80}" y="115" text-anchor="middle">${n.id === asset.entryStage ? '開始' : n.id === 'completed' ? '終端' : `STAGE ${i + 1}`}</text>`).join('')}</svg></div>`;
}
function bindingRows(asset: Asset, stageId?: string) {
  const direct = bindings.filter(b => b.sourceId === asset.id && b.stageId === stageId);
  const indirect = direct.flatMap(b => assets.find(a => a.id === b.targetId)?.kind === 'role' ? bindings.filter(v => v.sourceId === b.targetId).map(v => ({ binding: v, role: name(b.targetId) })) : []);
  return direct.map(b => `<div class="relation"><div><a href="#assets/${b.targetId}">${esc(name(b.targetId))}</a><small>${b.purpose === 'stage-role' ? '担当Role' : b.purpose === 'stage-model' ? 'StageのModel（サブエージェント）' : b.purpose === 'entry-role' ? '入口のRole' : '直接参照'}</small></div><div class="row">${button(`binding-edit:${b.id}`, '付け替え', 'small ghost')}${b.purpose === 'stage-role' || b.purpose === 'stage-model' ? '' : button(`binding-remove:${b.id}`, '解除', 'small ghost')}</div></div>`).join('') + indirect.map(({ binding: b, role }) => `<div class="relation"><div><a href="#assets/${b.targetId}">${esc(name(b.targetId))}</a><small>${esc(role)} 経由</small></div>${badge('Role経由')}</div>`).join('') + (direct.length ? '' : '<p class="hint">紐づけはありません。</p>');
}
function assetDetail(a: Asset) {
  const relationships = relatedWorkflows(a.id, assets, bindings);
  return `<article class="glass detail"><div class="detail-head"><div><div class="badge-row">${badge(kinds[a.kind])}${badge(labelScope(a.scope))}<span class="mono">rev. ${a.revision}</span></div><h2>${esc(a.name)}</h2><p>${esc(a.description)}</p></div><div class="row">${button(`asset-edit:${a.id}`, '編集する')}${button(`asset-delete:${a.id}`, '削除する', 'danger')}</div></div>${a.kind === 'skill' ? `<div class="row spread section"><div><h3>直接起動</h3><p class="hint">${a.useCase ? 'RuntimeからこのSkillを直接使えます。' : '必要なWorkflowから参照して使います。'}</p></div><button type="button" role="switch" aria-checked="${a.useCase}" data-action="usecase:${a.id}" class="${a.useCase ? 'primary' : ''}">${a.useCase ? '有効' : '無効'}</button></div>` : ''}${a.kind === 'model' ? `<section class="section"><div class="grid-two"><div><h3>Model名</h3><p class="body-panel prose">${esc(a.modelName)}</p></div><div><h3>呼び出し方</h3><p class="body-panel prose">${esc(a.invocationMethod)}</p></div></div><p class="hint">このModelをWorkflowのStageへ紐づけると、そのStageをサブエージェントで実行する指示になります。</p></section>` : ''}${a.kind === 'workflow' ? `${diagram(a)}<div class="section-header"><h3>工程、担当Role、完了条件</h3>${button(`run-new:${a.id}`, 'Runを開始', 'primary small')}</div>${a.stages.map(s => { const roleId = stageRoleId(a.id, s.id), modelId = stageModelId(a.id, s.id); return `<div class="editor-row"><div class="row-head"><strong>${esc(s.name)}</strong>${button(`binding-new:${a.id}:${s.id}`, '紐づける', 'small')}</div><p class="hint">担当Role: ${roleId ? `<a href="#assets/${roleId}">${esc(name(roleId))}</a>` : '未割当'}</p><p class="hint">Model: ${modelId ? `<a href="#assets/${modelId}">${esc(name(modelId))}</a>（サブエージェント実行）` : 'Runtimeの通常実行'}</p>${s.additionalInstructions ? `<p class="prose"><strong>追加指示</strong><br>${esc(s.additionalInstructions)}</p>` : ''}<p class="prose"><strong>完了条件</strong><br>${esc(s.completion_condition)}</p>${bindingRows(a, s.id)}</div>`; }).join('')}` : a.kind !== 'model' ? `<section class="section"><h3>${a.kind === 'role' ? '役割と責務' : '本文'}</h3><div class="body-panel prose">${esc(a.kind === 'role' ? a.responsibilities : a.body) || '<span class="muted">未記入</span>'}</div></section>` : ''}${a.kind === 'skill' && Object.keys(a.supportingFiles).length ? `<section class="section"><h3>補助ファイル</h3>${Object.entries(a.supportingFiles).map(([f, body]) => `<details><summary>${esc(f)}</summary><pre>${esc(body)}</pre></details>`).join('')}</section>` : ''}${a.kind !== 'rule' ? `<section class="section"><div class="section-header"><h3>${a.kind === 'workflow' ? 'Workflow全体の紐づけ' : '参照する資産'}</h3>${button(`binding-new:${a.id}`, '紐づける', 'small')}</div>${bindingRows(a)}</section>` : ''}<section class="section"><h3>関連するWorkflow / Stage</h3>${relationships.length ? relationships.map(r => `<div class="relation"><div><a href="#assets/${r.workflow.id}">${esc(r.workflow.name)}${r.stageId ? ` / ${esc(r.workflow.stages.find(s => s.id === r.stageId)?.name)}` : ''}</a><small>${r.via.length ? `${esc(r.via.join(' → '))} 経由` : '直接参照'}</small></div><div class="row">${badge(r.via.length ? '間接参照' : '直接参照')}${button(`binding-edit:${r.binding.id}`, '参照元を編集', 'small ghost')}${r.binding.purpose === 'stage-role' || r.binding.purpose === 'stage-model' ? '' : button(`binding-remove:${r.binding.id}`, '解除', 'small ghost')}</div>`).join('') : '<p class="hint">関連するWorkflowはありません。</p>'}</section><section class="section"><div class="row spread"><span class="mono">${esc(a.id)}</span>${button(`history-asset:${a.id}`, '変更履歴・復元', 'small ghost')}</div><p class="hint">最終更新 ${date(a.updatedAt)}${a.taskType ? ` · ${esc(a.taskType)}` : ''}</p></section></article>`;
}
function renderAssets() {
  const list = assets.filter(a => (a.scope === 'global' || a.scope === selectedScope) && (filter === 'all' || a.kind === filter) && `${a.name} ${a.description} ${a.kind === 'model' ? `${a.modelName} ${a.invocationMethod}` : ''}`.toLowerCase().includes(search.toLowerCase()));
  const selected = assets.find(a => a.id === route()[1]);
  const visible = selected && (selected.scope === 'global' || selected.scope === selectedScope) ? selected : list[0];
  const toolbar = `<div class="toolbar"><div class="filters">${[['all', 'すべて'], ...Object.entries(kinds)].map(([key, title]) => `<button class="filter ${filter === key ? 'active' : ''}" data-action="filter:${key}">${title}<span class="pill-count">${assets.filter(a => (a.scope === 'global' || a.scope === selectedScope) && (key === 'all' || a.kind === key)).length}</span></button>`).join('')}</div><input id="asset-search" class="search" type="search" aria-label="資産を検索" placeholder="名前・説明から検索" value="${esc(search)}"></div>`;
  shell(pageHeading('資産ライブラリ', '繰り返し使う方法・知識・役割・規則を、ひとつの場所に。', button('asset-new', '＋ 資産を作成', 'primary')) + toolbar + (!assets.length ? `<div class="glass">${empty('開発方法を、育てる。', 'あなたが繰り返し使う手順や判断基準を、最初の資産として保存しましょう。', button('asset-new', '最初の資産を作成', 'primary'))}</div><div class="onboarding"><article class="glass"><div class="step-label">01 / 保存する</div><h3>知識と役割を資産に</h3><p>Skill・Role・Ruleに、使いたい内容を記述します。</p></article><article class="glass"><div class="step-label">02 / 組み立てる</div><h3>Workflowで進め方を定義</h3><p>工程と完了条件を決め、使う資産を紐づけます。</p></article><article class="glass"><div class="step-label">03 / 振り返る</div><h3>Journalから改善へ</h3><p>実行で得た気づきを残し、次の開発に反映します。</p></article></div>` : `<div class="asset-layout"><div class="glass asset-list"><div class="list-caption"><span>利用できる資産</span><span class="mono">${list.length} 件</span></div>${list.map(a => `<a href="#assets/${a.id}" class="asset-row ${visible?.id === a.id ? 'selected' : ''}"><span class="type-icon ${a.kind}">${symbols[a.kind]}</span><span><strong>${esc(a.name)}</strong><small>${esc(a.description)}</small><span class="mono">${kinds[a.kind]} · r${a.revision}</span></span></a>`).join('') || empty('見つかりません', '検索語や種類を変更してください。', '', true)}</div>${visible ? assetDetail(visible) : `<div class="glass">${empty('資産を選択', '一覧から確認する資産を選んでください。')}</div>`}</div>`));
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
      shell(pageHeading(esc(name(run.workflowId)), `${esc(run.instruction)} · rev. ${run.workflowRevision}`, `<a href="#runs" class="badge">← Run一覧</a>`) + `<div class="glass card"><div class="row spread"><div class="badge-row">${status(run.status)}${badge(run.runtime)}${badge(labelScope(run.projectId ?? 'global'))}</div><span class="mono">${date(run.createdAt)}</span></div>${diagram(detail.snapshot.workflow)}<div class="row spread"><div><h3>現在の工程: ${esc(currentStage.name)}</h3><p class="hint">担当Role: ${esc(currentRoleName)}</p><p class="hint">Model: ${currentModel ? `${esc(currentModel.name)} / ${esc(currentModel.modelName)}（サブエージェント実行）` : 'Runtimeの通常実行'}</p><p>${esc(currentStage.completion_condition)}</p>${currentStage.additionalInstructions ? `<section class="section"><strong>追加指示</strong><p class="prose">${esc(currentStage.additionalInstructions)}</p></section>` : ''}</div>${run.status === 'active' ? button(`run-cancel:${run.id}`, 'Runを中止', 'danger small') : ''}</div><div class="row wrap">${transitions.map(t => button(`run-transition:${run.id}:${t.id}`, t.label, 'primary small')).join('')}${button(`journal-new:${run.id}`, 'Journalを記録')}</div><div class="statline"><span><strong>${detail.deliveries.length}</strong>提供記録</span><span><strong>${detail.deliveries.reduce((s, d) => s + d.bytes, 0).toLocaleString()}</strong>bytes 提供</span><span><strong>${detail.journals.length}</strong>Journal</span></div></div><div class="grid-two section"><article class="glass card"><h3>進行記録</h3><div class="timeline">${detail.events.map(e => `<article><small>${date(e.createdAt)}</small><strong>${esc(e.type)}</strong>${details('報告・根拠', e.data)}</article>`).join('')}</div></article><article class="glass card"><h3>Contextの提供</h3>${detail.deliveries.map(d => `<div class="relation"><div>${esc(d.target)}<small>${esc(d.stageId)} · ${d.bytes.toLocaleString()} bytes${d.assetRevision ? ` · rev. ${d.assetRevision}` : ''}</small></div>${badge(d.success ? '提供済み' : '取得失敗', d.success ? '' : 'red')}</div>`).join('')}${details('固定Snapshot・参照経路', detail.snapshot)}${details('提供内容・取得失敗の理由', detail.deliveries)}</article></div>`);
    } else shell(pageHeading('Workflow Run', '実行ごとに資産の版を固定し、進行と提供したContextを記録します。', button('run-new', '＋ Runを開始', 'primary')) + `<div class="glass">${data.runs.length ? `<table class="table"><thead><tr><th>Workflow / 依頼</th><th>状態</th><th>工程</th><th>Runtime</th><th>開始</th></tr></thead><tbody>${data.runs.map(r => `<tr><td><a href="#runs/${r.id}"><strong>${esc(name(r.workflowId))}</strong><p class="hint">${esc(r.instruction)}</p></a></td><td>${status(r.status)}</td><td>${esc(r.stageId)}</td><td>${esc(r.runtime)}</td><td class="mono">${date(r.createdAt)}</td></tr>`).join('')}</tbody></table>` : empty('まだ実行記録はありません', '使うWorkflowを明示して、最初のRunを開始します。', button('run-new', 'Workflowを選ぶ'))}</div>`);
  } else if (page === 'journals' || page === 'review') {
    const data = await api<{ journals: Journal[]; insights: Insight[]; reviewItems?: ReviewItem[] }>(page === 'review' ? 'review.pending' : 'journal.list', page === 'review' ? { ...(selectedScope !== 'global' ? { projectId: selectedScope } : {}), include: ['journalTask', 'insights', 'proposalRefs'], includeBodies: true } : {});
    const proposals = page === 'review' ? await api<{ proposals: Proposal[]; decisions: Decision[]; changeSets: ChangeSet[] }>('proposal.list', { includeChanges: true }) : { proposals: [], decisions: [], changeSets: [] };
    const journals = data.journals.filter(j => selectedScope === 'global' || j.projectId === selectedScope || !j.projectId);
    screenData = { ...data, ...proposals };
    shell(pageHeading(page === 'review' ? 'Journal Review' : 'Journal', page === 'review' ? '気づきを読み、具体的な改善を判断して、次の開発へ。' : 'どう進め、道具や指示がどう働いたかを残します。', page === 'review' ? button('proposal-new', '＋ 改善を提案', 'primary') : button('journal-new', '＋ Journalを記録', 'primary')) + (page === 'review' && proposals.proposals.length ? `<div class="stack">${proposals.proposals.map(p => {
      const d = proposals.decisions.find(d => d.proposalId === p.id), applied = proposals.changeSets.some(c => c.proposalId === p.id);
      return `<article class="glass card"><div class="row spread"><h2>${esc(p.title)}</h2>${applied ? badge('適用済み', 'green') : d ? status(d.choice) : badge('判断待ち', 'amber')}</div><p class="prose">${esc(p.proposedChange)}</p><p>理由: ${esc(p.reason)}</p><p class="hint">根拠Journal ${p.evidenceJournalIds.length}件 · 対象の気づき ${p.insightIds.length}件</p>${details('変更内容・影響する資産・管理先', p)}${applied ? '' : `<footer><div class="row">${button(`proposal-decide:${p.id}:approved`, '承認', 'small')}${button(`proposal-decide:${p.id}:deferred`, '保留', 'small')}${button(`proposal-decide:${p.id}:rejected`, '却下', 'small')}</div>${d?.choice === 'approved' ? button(`proposal-apply:${p.id}`, '承認した変更を適用', 'primary') : ''}</footer>`}</article>`;
    }).join('')}</div><div class="spacer"></div>` : '') + `<div class="stack">${journals.length ? journals.map(j => {
      const reviewCards = page === 'review' && data.reviewItems ? data.reviewItems.filter(item => item.journalId === j.id).map(item => `<div class="insight"><div class="row spread"><strong>${esc(item.heading)}</strong>${status(item.status)}</div><p>${esc(item.body)}</p><div class="insight-actions">${(['approved', 'deferred', 'rejected'] as const).filter(decision => decision !== item.lastDecision || item.status === 'pending').map(decision => button(`review-decide:${item.id}:${decision}`, reviewDecisionLabels[decision], 'small')).join('')}</div></div>`).join('') : data.insights.filter(i => i.journalId === j.id).map(i => `<div class="insight"><div class="row spread"><strong>${esc(i.heading)}</strong>${status(i.status)}</div><p>${esc(i.body)}</p><div class="insight-actions">${['pending', 'processed', 'rejected'].filter(s => s !== i.status).map(s => button(`insight:${i.id}:${s}`, states[s])).join('')}</div></div>`).join('');
      return `<article class="glass card"><div class="row spread"><div><span class="mono">${date(j.createdAt)}</span><h2>${esc(j.task || (j.runId ? 'Runの振り返り' : 'Journal'))}</h2></div>${badge(j.runId ? 'Runに関連' : 'Taskに関連')}</div>${reviewCards}${details('Journal原文', j.raw)}${j.runId ? `<p class="hint"><a href="#runs/${j.runId}">関連Run・Snapshot・実行記録を見る →</a></p>` : ''}</article>`;
    }).join('') : `<div class="glass">${empty(page === 'review' ? 'レビュー待ちの気づきはありません' : '気づきを、次の改善へ', '書き残したい発見や摩擦があるときに、Journalを記録してください。', button('journal-new', 'Journalを記録'))}</div>`}</div>`);
  } else if (page === 'history') {
    const data = await api<{ histories: History[]; changeSets: ChangeSet[]; provenance: (Provenance & { id: string })[] }>('history.get'); screenData = data;
    shell(pageHeading('変更履歴', '何を変えたかと、なぜ変えたかをたどります。') + `<div class="stack">${data.changeSets.length ? data.changeSets.map(c => {
      const p = data.provenance.find(p => p.id === c.provenanceId);
      return `<article class="glass card"><div class="row spread"><div><span class="mono">${date(c.createdAt)}</span><h3>${esc(p?.userRequest || p?.reason || (p?.origin === 'restore' ? '過去の内容を復元' : '資産・構成の更新'))}</h3></div>${badge(p?.origin ?? '')}</div>${data.histories.filter(h => h.changeSetId === c.id).map(h => `<div class="relation"><div>${esc(name(h.entityId))}<small>${h.before ? `rev. ${h.before} → ${h.after}` : `新規作成 · rev. ${h.after}`}${h.restoredFrom ? ` · 復元元 rev. ${h.restoredFrom}` : ''}</small></div>${h.kind === 'asset' ? button(`history-asset:${h.entityId}`, '差分・復元', 'small') : ''}</div>`).join('')}${details('変更内容', c)}${details('Provenance', p)}<footer><span class="mono">${c.id.slice(0, 8)}</span>${c.operations.length ? button(`changeset-restore:${c.id}`, '変更前の状態へ復元', 'small') : ''}</footer></article>`;
    }).join('') : `<div class="glass">${empty('変更はまだありません', '資産や紐づけを保存すると、履歴と変更理由を確認できます。')}</div>`}</div>`);
  } else if (page === 'diagnostics') {
    const data = await api<{ diagnostics: Diagnostic[]; costs: { runId: string; stageId: string; roleIds: string[]; target: string; bytes: number; deliveries: number; runtime: string }[] }>('diagnostics.get'); screenData = data;
    shell(pageHeading('診断', '参照の整合性、繰り返す遷移、実際のContext提供量を確認します。', button('refresh', '再診断')) + `<div class="glass card"><h2>整合性と実行の状態</h2>${data.diagnostics.length ? data.diagnostics.map(d => `<div class="insight"><div class="row">${badge(d.severity, d.severity === 'error' ? 'red' : 'amber')}<strong>${esc(d.code)}</strong></div><p>${esc(d.message)}</p>${details('対象と根拠', { target: d.target, evidence: d.evidence })}</div>`).join('') : '<div class="status-message">検出された問題はありません。</div>'}</div><div class="glass card section"><h2>Contextの提供量</h2><p>実際に提供した内容のUTF-8バイト数です。未取得のSkill本文は含みません。</p>${data.costs.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Run / Stage</th><th>対象</th><th>Role</th><th>Runtime</th><th>提供回数</th><th>bytes</th></tr></thead><tbody>${data.costs.map(c => `<tr><td><a href="#runs/${c.runId}" class="mono">${c.runId.slice(0, 8)}</a><p class="hint">${esc(c.stageId)}</p></td><td>${esc(assets.some(a => a.id === c.target) ? name(c.target) : c.target)}</td><td>${esc(c.roleIds.map(name).join(', ') || '—')}</td><td>${esc(c.runtime)}</td><td>${c.deliveries}</td><td class="mono">${c.bytes.toLocaleString()}</td></tr>`).join('')}</tbody></table></div>` : '<p class="hint">Workflow Runを開始すると提供量を確認できます。</p>'}</div>`);
  } else if (page === 'settings') {
    const [r, s, candidates] = await Promise.all([api<{ targets: RuntimeTarget[] }>('runtime.list'), api<{ timeoutHours: number }>('settings.get'), api<{ candidates: { runtime: string; path: string; platform: string; exists: boolean }[] }>('runtime.discover')]);
    const common = selectedScope !== 'global' ? (await api<{ common: Common }>('common.get', { projectId: selectedScope })).common : null;
    screenData = { ...r, common, ...candidates };
    shell(pageHeading('設定・接続', 'Project、Runtimeの入口、ローカルデータを管理します。') + `<div class="grid-two"><section class="glass card"><div class="section-header"><h2>Project</h2>${button('project-new', '＋ 登録', 'small')}</div>${projects.length ? projects.map(p => `<div class="relation"><div>${esc(p.name)}<small class="mono">${esc(p.root)}</small></div>${badge('登録済み')}</div>`).join('') : '<p>開いているProjectでaacl initを実行するか、rootを指定して登録します。</p>'}${common ? `<div class="section"><div class="section-header"><h3>Project Common</h3>${button('common-edit', 'Ruleを選ぶ', 'small')}</div>${common.ruleIds.map(id => `<div class="relation">${esc(name(id))}</div>`).join('') || '<p class="hint">共通Ruleは未登録です。</p>'}</div>` : '<p class="hint">管理先をProjectへ切り替えると、Project Commonを編集できます。</p>'}</section><section class="glass card"><h2>Runの非活動timeout</h2><p>Runに対する読み取りや操作がない場合の終了時間。</p><form data-form="settings" class="form-stack">${field('時間', 'timeoutHours', String(s.timeoutHours), true, 'number')}<div><button type="submit">設定を保存</button></div><p class="form-error"></p></form></section></div><section class="glass card section"><div class="section-header"><div><h2>Runtimeの入口</h2><p>登録した設定先へ、Workflowと直接起動Skillの入口を配置します。</p></div><div class="row">${button('journal-skills', 'Journal用Skillを導入', 'small')}${button('runtime-sync', '再同期', 'small')}${button('runtime-new', '＋ 設定先を追加', 'primary small')}</div></div>${r.targets.length ? `<table class="table"><thead><tr><th>Runtime</th><th>管理先</th><th>設定先</th><th>状態</th><th></th></tr></thead><tbody>${r.targets.map(t => `<tr><td>${t.runtime === 'claude' ? 'Claude Code' : 'Codex'}<p class="hint">${t.platform}</p></td><td>${esc(labelScope(t.scope))}</td><td class="mono">${esc(t.path)}</td><td>${badge(t.enabled ? '管理中' : '管理解除', t.enabled ? 'green' : '')}</td><td>${t.enabled ? button(`runtime-remove:${t.id}`, '管理解除', 'small ghost') : ''}</td></tr>`).join('')}</tbody></table>` : '<p>設定先を追加すると、利用できる入口を生成します。</p>'}<div class="section"><h3>MCP接続</h3><pre>codex mcp add aacl --url ${esc(location.origin)}/mcp\nclaude mcp add --transport http aacl ${esc(location.origin)}/mcp</pre><p class="hint">Serviceが停止している場合は、WSLで aacl ensure を実行します。</p></div></section><section class="glass card section"><h2>Export・Backup</h2><p>出力先を指定して保存します。復元はCLIの aacl restore で新しい管理フォルダーへ行います。</p><div class="row">${button('export', 'Markdown / JSONを出力')}${button('backup', 'Backupを保存')}</div></section>`);
  } else { location.hash = 'assets'; }
}

function roleOptions(selected = '') {
  return opt('', '担当Roleなし', selected) + assets.filter(a => a.kind === 'role' && (a.scope === 'global' || a.scope === selectedScope)).map(a => opt(a.id, `${a.name}（${labelScope(a.scope)}）`, selected)).join('');
}
function modelOptions(selected = '') {
  return opt('', 'Modelなし（通常実行）', selected) + assets.filter(a => a.kind === 'model' && (a.scope === 'global' || a.scope === selectedScope)).map(a => opt(a.id, `${a.name} / ${a.modelName}（${labelScope(a.scope)}）`, selected)).join('');
}
function stageRoleId(workflowId: string, stageId: string) {
  return bindings.find(b => b.sourceId === workflowId && b.stageId === stageId && b.purpose === 'stage-role')?.targetId ?? '';
}
function stageModelId(workflowId: string, stageId: string) {
  return bindings.find(b => b.sourceId === workflowId && b.stageId === stageId && b.purpose === 'stage-model')?.targetId ?? '';
}
function stageRow(s: { id: string; name: string; completion_condition: string; additionalInstructions?: string; description?: string; taskType?: string }, index: number, roleId = '', modelId = '', transitions: Asset['transitions'] = [], stages: { id: string; name: string }[] = []) {
  return `<section class="editor-row stage-editor" data-id="${esc(s.id)}" aria-labelledby="stage-heading-${esc(s.id)}"><div class="row-head"><h3 class="stage-title" id="stage-heading-${esc(s.id)}">工程 ${index + 1}</h3>${button('row-remove', '削除', 'small ghost')}</div><div class="stage-content"><div class="grid-two">${field('工程名', 'stageName', s.name)}${field('分類', 'stageType', s.taskType ?? '', false)}</div><div class="stage-role-row">${select('担当Role', 'stageRole', roleOptions(roleId), true)}${button(`role-create:${s.id}`, '＋ 新しいRole', 'small ghost')}</div><p class="hint">担当Roleの責務を工程の基本とし、必要なら追加指示で補います。</p><div>${select('Model', 'stageModel', modelOptions(modelId))}<p class="hint">Modelを指定すると、この工程をそのModelのサブエージェントで実行します。連続する同じRole・Modelの工程では同じサブエージェントを使います。</p></div><div class="new-role-fields" hidden><p class="hint">新しいRoleをGlobalで共有し、このStageの担当に設定します。</p>${field('新しいRole名', 'newRoleName', '', false)}${area('Roleの説明', 'newRoleDescription', '', false)}${area('Roleの責務', 'newRoleResponsibilities', '', false)}</div><div class="spacer"></div>${area('追加指示（任意）', 'additionalInstructions', s.additionalInstructions ?? '', false)}${area('完了条件', 'completion', s.completion_condition)}<input type="hidden" name="stageDescription" value="${esc(s.description ?? '')}"></div><section class="stage-transitions" aria-labelledby="transition-heading-${esc(s.id)}"><div class="stage-transitions-head"><div><h4 id="transition-heading-${esc(s.id)}">この工程からの遷移</h4><p>各行で行き先・種別・表示名を設定します。</p></div>${button('transition-add', '＋ 行き先を追加', 'small ghost')}</div><div class="stage-transition-list">${transitions.map((t, transitionIndex) => transitionRow(t, stages, transitionIndex)).join('') || '<p class="hint stage-transition-empty">行き先はまだありません。</p>'}</div></section></section>`;
}
function transitionRow(t: { id: string; from: string; to: string; type: string; label: string }, stages: { id: string; name: string }[], index: number) {
  return `<fieldset class="transition-row" data-id="${esc(t.id)}"><legend>遷移設定 ${index + 1}</legend><div class="transition-fields">${select('行き先', 'to', stages.map(s => opt(s.id, s.name || '未命名の工程', t.to)).join('') + opt('completed', '完了', t.to))}${select('種別', 'transitionType', Object.entries(typeLabels).map(([key, title]) => opt(key, title, t.type)).join(''))}${field('表示名', 'transitionLabel', t.label)}<button type="button" class="ghost transition-remove" data-action="row-remove" aria-label="遷移設定 ${index + 1}を削除">×</button></div></fieldset>`;
}
function assetEditor(a?: Asset, newKind: Asset['kind'] = 'skill') {
  const kind = a?.kind ?? newKind;
  modal(a ? '資産を編集' : '資産を作成', `<form data-form="asset" data-id="${a?.id ?? ''}" data-kind="${kind}" class="form-stack">${!a ? `<div class="filters">${Object.entries(kinds).map(([k, title]) => button(`new-kind:${k}`, title, `filter ${kind === k ? 'active' : ''}`)).join('')}</div>` : ''}<div class="grid-two">${field('名前', 'name', a?.name)}${select('管理先', 'scope', a ? opt(a.scope, labelScope(a.scope)) : opt('global', 'Global', selectedScope) + projects.map(p => opt(p.id, p.name, selectedScope)).join(''))}</div>${area('説明', 'description', a?.description)}${field('作業の分類', 'taskType', a?.taskType, false)}${kind === 'model' ? `<div class="grid-two">${field('Model名', 'modelName', a?.modelName)}${area('呼び出し方', 'invocationMethod', a?.invocationMethod)}</div><p class="hint">呼び出し方はRuntimeへ渡す自由記述です。認証情報は保存しないでください。</p>` : ''}${kind === 'workflow' ? `<section><div class="section-header"><h3>工程</h3>${button('stage-add', '＋ 工程を追加', 'small')}</div><div id="stage-rows">${(a?.stages ?? []).map((s, i) => stageRow(s, i, a ? stageRoleId(a.id, s.id) : '', a ? stageModelId(a.id, s.id) : '', (a?.transitions ?? []).filter(t => t.from === s.id), a?.stages ?? [])).join('')}</div><p class="hint">先頭の工程から開始します。各工程に担当Roleと完了条件を指定し、Modelは必要な工程だけ指定します。</p></section>` : kind !== 'model' ? area(kind === 'role' ? '責務・判断観点・成果責任' : '本文（Markdown）', 'body', kind === 'role' ? a?.responsibilities : a?.body, kind === 'skill', true) : ''}${kind === 'skill' ? `<label class="checkbox-label"><input type="checkbox" name="useCase"${a?.useCase ? ' checked' : ''}>Runtimeから直接起動できるSkillにする</label><section><div class="section-header"><h3>補助ファイル</h3>${button('file-add', '＋ 追加', 'small')}</div><div id="file-rows">${Object.entries(a?.supportingFiles ?? {}).map(([path, body]) => fileRow(path, body)).join('')}</div></section>` : ''}<p class="hint">認証情報は保存しないでください。</p>${formEnd()}</form>`, kind === 'workflow' ? 'workflow-editor' : '');
}
function fileRow(path = '', body = '') { return `<div class="editor-row file-editor"><div class="row-head"><strong>補助ファイル</strong>${button('row-remove', '削除', 'small ghost')}</div>${field('相対ファイル名', 'filePath', path)}<div class="spacer"></div>${area('内容', 'fileBody', body, false, true)}</div>`; }
function readStages(form: Element) { return [...form.querySelectorAll<HTMLElement>('.stage-editor')].map(row => ({ id: row.dataset.id!, name: (row.querySelector('[name=stageName]') as HTMLInputElement).value, completion_condition: (row.querySelector('[name=completion]') as HTMLTextAreaElement).value, additionalInstructions: (row.querySelector('[name=additionalInstructions]') as HTMLTextAreaElement).value, description: (row.querySelector('[name=stageDescription]') as HTMLInputElement).value, taskType: (row.querySelector('[name=stageType]') as HTMLInputElement).value })); }
function readTransitions(form: Element) { return [...form.querySelectorAll<HTMLElement>('.transition-row')].map(row => { const from = row.closest<HTMLElement>('.stage-editor')?.dataset.id; if (!from) throw new Error('遷移元の工程を確認できません。'); return { id: row.dataset.id!, from, to: (row.querySelector('[name=to]') as HTMLSelectElement).value, type: (row.querySelector('[name=transitionType]') as HTMLSelectElement).value as Asset['transitions'][number]['type'], label: (row.querySelector('[name=transitionLabel]') as HTMLInputElement).value }; }); }
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
  modal(existing ? '紐づけを付け替え' : '資産を紐づける', `<form data-form="binding" data-id="${existing?.id ?? ''}" data-source="${sourceId}" data-stage="${esc(stageId ?? '')}" class="form-stack"><p>${esc(a.name)}${stageId ? ` / ${esc(a.stages.find(s => s.id === stageId)?.name)}` : ''} → 参照先</p>${select('参照する資産', 'targetId', targets.map(t => opt(t.id, `${kinds[t.kind]} / ${t.name}`, existing?.targetId)).join(''))}${purpose}<p class="hint">管理先: ${esc(labelScope(selectedScope))}</p>${formEnd('紐づけを保存')}</form>`);
}
function journalEditor(run?: Run) {
  modal('Journalを記録', `<form data-form="journal" data-run="${run?.id ?? ''}" class="form-stack">${field('Task（作業名）', 'task', '', !run)}${area('Journal（Markdown）', 'body', '## Task\n\n## 実際に使ったもの\n\n## 良かった点\n\n## 困った点\n\n## 改善の種\n\n## 根拠・確かさ\n', true, true)}<p class="hint">書くことのない項目は省略できます。気づきは空行で区切ると個別に扱えます。</p>${formEnd('Journalを保存')}</form>`);
}

async function action(value: string, target: HTMLElement) {
  const [key, id, extra] = value.split(':');
  const a = assets.find(a => a.id === id);
  if (key === 'close') { dialog.close(); return; }
  if (key === 'refresh') { await refresh(); return; }
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
  if (key === 'stage-add') { const root = dialog.querySelector('#stage-rows')!; root.insertAdjacentHTML('beforeend', stageRow({ id: crypto.randomUUID(), name: '', completion_condition: '', additionalInstructions: '' }, root.children.length, '', '', [], readStages(dialog))); updateTransitionTargets(dialog); return; }
  if (key === 'role-create') {
    const row = target.closest<HTMLElement>('.stage-editor')!, panel = row.querySelector<HTMLElement>('.new-role-fields')!, role = row.querySelector<HTMLSelectElement>('[name=stageRole]')!;
    panel.hidden = !panel.hidden;
    role.disabled = !panel.hidden;
    target.textContent = panel.hidden ? '＋ 新しいRole' : '作成をやめる';
    if (!panel.hidden) { panel.dataset.previousRole = role.value; role.value = ''; row.querySelector<HTMLInputElement>('[name=newRoleName]')?.focus(); }
    else role.value = panel.dataset.previousRole ?? '';
    return;
  }
  if (key === 'file-add') { dialog.querySelector('#file-rows')!.insertAdjacentHTML('beforeend', fileRow()); return; }
  if (key === 'transition-add') {
    const stage = target.closest<HTMLElement>('.stage-editor'), stages = readStages(dialog);
    if (!stage || !stages.length) throw new Error('先に工程を追加してください。');
    const index = stages.findIndex(s => s.id === stage.dataset.id), next = stages[index + 1];
    const transition = { id: crypto.randomUUID(), from: stage.dataset.id!, to: next?.id ?? 'completed', type: next ? 'next' : 'complete', label: '' };
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
  if (key === 'binding-remove') { await api('binding.remove', { id, provenance: provenance('紐づけを解除') }, true); notify('紐づけを解除しました。'); await refresh(); return; }
  if (key === 'run-new') {
    const workflows = assets.filter(a => a.kind === 'workflow' && (a.scope === 'global' || a.scope === selectedScope));
    if (!workflows.length) { notify('先にWorkflowを作成してください。'); assetEditor(undefined, 'workflow'); return; }
    modal('Workflow Runを開始', `<form data-form="run" class="form-stack">${select('Workflow', 'workflowId', workflows.map(a => opt(a.id, a.name, id)).join(''))}${select('実行するRuntime', 'runtime', opt('claude', 'Claude Code') + opt('codex', 'Codex'))}${area('実行する依頼', 'instruction')}${field('対象', 'target', '', false)}<p class="hint">管理先: ${esc(labelScope(selectedScope))}。開始時点の資産と紐づけを使います。</p>${formEnd('Runを開始')}</form>`); return;
  }
  if (key === 'run-transition' || key === 'run-cancel') {
    modal(key === 'run-cancel' ? 'Runを中止' : '工程を進める', `<form data-form="${key}" data-run="${id}" data-transition="${esc(extra ?? '')}" class="form-stack">${area(key === 'run-cancel' ? '中止理由' : '完了報告', 'report')}${formEnd(key === 'run-cancel' ? '中止する' : '選択した遷移を実行')}</form>`); return;
  }
  if (key === 'journal-new') { const run = (screenData.runs as Run[] | undefined)?.find(r => r.id === id); journalEditor(run); return; }
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
  if (key === 'asset-restore') { await api('asset.restore', { assetId: id, revision: Number(extra) }, true); dialog.close(); notify('選択した版を新しいrevisionとして復元しました。'); await refresh(); return; }
  if (key === 'changeset-restore') { const c = (screenData.changeSets as ChangeSet[]).find(c => c.id === id)!; modal('変更前の状態へ復元', `<p>対象の変更前の内容を、新しいrevisionとして保存します。</p>${details('対象の変更', c)}<form data-form="changeset-restore" data-id="${id}">${formEnd('復元する')}</form>`); return; }
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
    const asset = { kind, name: get('name'), description: get('description'), scope: get('scope'), taskType: get('taskType'), modelName: kind === 'model' ? get('modelName') : old?.modelName ?? '', invocationMethod: kind === 'model' ? get('invocationMethod') : old?.invocationMethod ?? '', body: kind === 'role' || kind === 'workflow' || kind === 'model' ? old?.body ?? '' : get('body'), responsibilities: kind === 'role' ? get('body') : old?.responsibilities ?? '', useCase: kind === 'skill' && data.has('useCase'), supportingFiles: Object.fromEntries(files), stages, transitions, entryStage: old?.entryStage && stages.some(s => s.id === old.entryStage) ? old.entryStage : stages[0]?.id ?? '', metadata: old?.metadata ?? {} };
    if (kind === 'workflow') {
      const workflowId = old?.id ?? crypto.randomUUID(), newRoleChanges: Change[] = [];
      const assignments = [...form.querySelectorAll<HTMLElement>('.stage-editor')].map(row => {
        const stageId = row.dataset.id!, panel = row.querySelector<HTMLElement>('.new-role-fields')!;
        if (!panel.hidden) {
          const roleName = (row.querySelector('[name=newRoleName]') as HTMLInputElement).value.trim();
          const description = (row.querySelector('[name=newRoleDescription]') as HTMLTextAreaElement).value.trim();
          if (!roleName || !description) throw new Error('新しいRoleの名前と説明を入力してください。');
          const roleId = crypto.randomUUID();
          newRoleChanges.push({ type: 'asset.create', id: roleId, asset: { kind: 'role', name: roleName, description, body: '', responsibilities: (row.querySelector('[name=newRoleResponsibilities]') as HTMLTextAreaElement).value, scope: 'global', useCase: false, taskType: '', modelName: '', invocationMethod: '', metadata: {}, supportingFiles: {}, stages: [], transitions: [], entryStage: '' } });
          return { stageId, roleId, modelId: (row.querySelector('[name=stageModel]') as HTMLSelectElement).value };
        }
        return { stageId, roleId: (row.querySelector('[name=stageRole]') as HTMLSelectElement).value, modelId: (row.querySelector('[name=stageModel]') as HTMLSelectElement).value };
      });
      const roleChanges = stageRoleBindingChanges(workflowId, selectedScope, assignments, bindings);
      const modelChanges = stageModelBindingChanges(workflowId, selectedScope, assignments, bindings);
      const workflowChange: Change = old ? { type: 'asset.save', id: workflowId, asset } : { type: 'asset.create', id: workflowId, asset };
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
      const result = await api<{ entities: Asset[] }>('asset.save', { id: old?.id, asset, provenance: provenance(old ? '資産を編集' : '資産を作成') }, true);
      location.hash = `assets/${result.entities[0].id}`;
    }
  } else if (key === 'binding') await api('binding.save', { id: form.dataset.id || undefined, binding: { scope: selectedScope, sourceId: form.dataset.source, stageId: form.dataset.stage || undefined, targetId: get('targetId'), purpose: get('purpose') }, provenance: provenance('資産の紐づけを編集') }, true);
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
    await api('proposal.save', { title: get('title'), observedContext: get('observedContext'), proposedChange: get('proposedChange'), reason: get('reason'), evidenceJournalIds: ids, reviewedJournalIds: ids, affectedAssetIds: [id], affectedBindingIds: bindings.filter(b => b.sourceId === id || b.targetId === id).map(b => b.id), affectedProjectIds: a.scope === 'global' ? projects.map(p => p.id) : [a.scope], changes: [{ type: 'asset.save', id, asset: { ...payload, [a.kind === 'role' ? 'responsibilities' : 'body']: get('body') } }], insightIds: data.getAll('insightIds') }, true);
  } else if (key === 'review-decision') await api('review.decide', { reviewItemId: form.dataset.id, decision: form.dataset.decision, note: get('note') }, true);
  else if (key === 'decision') await api('proposal.decide', { proposalId: form.dataset.id, choice: form.dataset.choice, note: get('note') }, true);
  else if (key === 'changeset-restore') await api('changeset.restore', { changeSetId: form.dataset.id }, true);
  else if (key === 'project') await api('project.init', { name: get('name'), root: get('root') }, true);
  else if (key === 'common') await api('common.save', { projectId: selectedScope, ruleIds: data.getAll('ruleIds'), provenance: provenance('Project共通Ruleを編集') }, true);
  else if (key === 'runtime') await api('runtime.register', { runtime: get('runtime'), platform: get('platform'), path: get('path'), scope: selectedScope }, true);
  else if (key === 'settings') await api('settings.save', { timeoutHours: Number(get('timeoutHours')) }, true);
  else if (key === 'export' || key === 'backup') await api(`data.${key}`, key === 'backup' ? { path: get('path') } : { directory: get('path') });
  dialog.close(); notify(key === 'asset-delete' ? 'Assetを削除し、参照を解除しました。' : key === 'run' ? 'Runを開始しました。' : '保存しました。'); await refresh();
}

document.addEventListener('click', event => {
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
  if (input.id === 'scope-select') { selectedScope = input.value; location.hash = route()[0]; void refresh(); }
  if (input.name === 'stageName') {
    updateTransitionTargets(dialog);
  }
});
document.addEventListener('input', event => {
  const input = event.target as HTMLInputElement;
  if (input.id === 'asset-search') { const position = input.selectionStart; search = input.value; renderAssets(); const next = document.querySelector<HTMLInputElement>('#asset-search')!; next.focus(); next.setSelectionRange(position, position); }
});
function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
window.addEventListener('hashchange', () => { if (!loading) void render().catch(e => notify(errorMessage(e))); });
void refresh();
