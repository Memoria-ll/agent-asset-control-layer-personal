import { test, expect } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { serve } from '../src/server.ts';

let app: Awaited<ReturnType<typeof serve>>;
test.beforeAll(async () => { app = await serve(mkdtempSync(join(tmpdir(), 'aacl-ui-')), 0); });
test.afterAll(async () => { await app.close(); });

function contrastRatio(foreground: string, background: string) {
  const luminance = (cssColor: string) => {
    const channels = cssColor.match(/[\d.]+/g);
    if (!channels || channels.length < 3) throw new Error('Invalid computed color: ' + cssColor);
    const linear = channels.slice(0, 3).map(Number).map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
  };
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light! + 0.05) / (dark! + 0.05);
}

test('UI defaults to English and switches the rendered interface to Japanese', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${app.port}`);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('link', { name: 'Asset Library', exact: true })).toBeVisible();
  await page.locator('#language-select').selectOption('ja');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  await expect(page.getByRole('link', { name: '資産ライブラリ', exact: true })).toBeVisible();
  await page.locator('#language-select').selectOption('en');
  await expect(page.getByRole('link', { name: 'Asset Library', exact: true })).toBeVisible();
});

test('UI toggles Deep Ocean dark mode beside the language selector and persists it', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${app.port}`);
  const toggle = page.locator('#theme-toggle');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#101c24');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('#theme-toggle')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#theme-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('C33: Chromium UI assigns existing and new Roles from Workflow editor, runs a Workflow, records and reviews Journal', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', e => { if (e.type() === 'error') errors.push(e.text()); });
  await page.addInitScript(() => localStorage.setItem('aacl-language', 'ja'));
  await page.goto(`http://127.0.0.1:${app.port}`);
  await expect(page.getByRole('heading', { name: '開発方法を、育てる。' })).toBeVisible();
  await page.screenshot({ path: '/tmp/aacl-empty.png', fullPage: true });
  await page.getByRole('button', { name: '最初の資産を作成' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('名前', { exact: true }).fill('検証手順');
  await dialog.getByLabel('コメント', { exact: true }).fill('実際のデータ経路で結果を確かめる');
  await dialog.getByLabel('説明（Runtime YAML）', { exact: true }).fill('実データを使う検証手順を選ぶ');
  await dialog.getByLabel('本文（Markdown）').fill('変更に関係する検証を実行し、結果を記録する。');
  await dialog.getByRole('button', { name: '保存する', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('heading', { name: '検証手順', exact: true })).toBeVisible();
  await expect(page.locator('.asset-grid')).toBeVisible();
  await expect(page.locator('.asset-card')).toHaveCount(1);
  await expect(page.locator('.asset-drawer')).toBeVisible();
  await expect(page.locator('.asset-layout')).toHaveCount(0);
  await expect(page.locator('.asset-main-content')).toHaveCSS('overflow', 'hidden');
  await expect(page.locator('.asset-scroll')).toHaveCSS('overflow', 'hidden');
  await expect(page.locator('.asset-drawer > .detail')).toHaveCSS('overflow', 'auto');
  await page.locator('.asset-drawer').getByRole('button', { name: '×', exact: true }).click();
  await expect(page.locator('.asset-drawer')).toHaveCount(0);
  await page.locator('.asset-card').click();
  await expect(page.locator('.asset-drawer')).toBeVisible();
  await expect(page.getByText('実データを使う検証手順を選ぶ', { exact: true })).toBeVisible();
  await page.getByRole('switch').click();
  await expect(page.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('button', { name: '＋ 資産を作成' }).click();
  await dialog.getByRole('button', { name: 'Role', exact: true }).click();
  await dialog.getByLabel('名前', { exact: true }).fill('検証担当');
  await dialog.getByLabel('説明', { exact: true }).fill('結果を再現して確認する');
  await dialog.getByLabel('責務・判断観点・成果責任').fill('実際の挙動と完了条件を照合する。');
  await dialog.getByRole('button', { name: '保存する', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole('button', { name: '紐づける', exact: true }).click();
  await dialog.getByRole('searchbox', { name: '資産検索' }).fill('検証手順');
  await dialog.getByLabel('参照する資産').selectOption({ label: 'Skill / 検証手順' });
  await dialog.getByRole('button', { name: '紐づけを保存' }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole('button', { name: '＋ 資産を作成' }).click();
  await dialog.getByRole('button', { name: 'Model', exact: true }).click();
  await dialog.getByLabel('名前', { exact: true }).fill('実装Model');
  await dialog.getByLabel('説明', { exact: true }).fill('実装を担当するサブエージェント');
  await dialog.getByLabel('Model名', { exact: true }).fill('provider/implementer');
  await dialog.getByLabel('呼び出し方', { exact: true }).fill('Runtimeのsubagent呼び出し');
  await dialog.getByRole('button', { name: '＋ 選択肢を追加' }).click();
  await dialog.getByLabel('選択肢名').fill('実行系');
  await expect(dialog.getByRole('button', { name: '{{choice.実行系}}', exact: true })).toHaveCount(2);
  await dialog.getByLabel('Model名').fill('');
  await dialog.getByRole('button', { name: '{{choice.実行系}}', exact: true }).first().click();
  await expect(dialog.getByLabel('Model名')).toHaveValue('{{choice.実行系}}');
  await dialog.getByLabel('Model名').fill('provider/implementer');
  await dialog.getByLabel('選択値').fill('codex luna');
  await dialog.getByRole('button', { name: '＋ 選択値を追加' }).click();
  await dialog.getByLabel('選択値').nth(1).fill('codex sol');
  await dialog.getByRole('button', { name: '＋ 選択肢を追加' }).click();
  await dialog.getByLabel('選択肢名').nth(1).fill('effort');
  await dialog.getByLabel('選択値').nth(2).fill('low');
  await dialog.locator('.model-choice-editor-row').nth(1).getByRole('button', { name: '＋ 選択値を追加' }).click();
  await dialog.getByLabel('選択値').nth(3).fill('high');
  await dialog.getByRole('button', { name: '保存する', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('heading', { name: '実装Model', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '紐づける', exact: true }).click();
  await dialog.getByRole('searchbox', { name: '資産検索' }).fill('検証手順');
  await dialog.getByLabel('参照する資産').selectOption({ label: 'Skill / 検証手順' });
  await expect(dialog.getByRole('group', { name: '参照条件' })).toBeVisible();
  await dialog.getByLabel('実行系の条件').selectOption('codex sol');
  await dialog.getByLabel('effortの条件').selectOption('high');
  await dialog.getByRole('button', { name: '紐づけを保存' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText('適用条件: 実行系=codex sol AND effort=high', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '＋ 資産を作成' }).click();
  await dialog.getByRole('button', { name: 'Workflow', exact: true }).click();
  await dialog.getByLabel('名前', { exact: true }).fill('改善の確認');
  await dialog.getByLabel('説明', { exact: true }).fill('実装と確認の二工程で改善を確かめる');
  await dialog.getByRole('button', { name: '＋ 工程を追加' }).click();
  await dialog.getByLabel('工程名', { exact: true }).fill('実装');
  await expect(dialog.locator('.info-button')).toHaveCount(2);
  await dialog.locator('.info-button').first().hover();
  await expect(dialog.locator('.info-button').first()).toHaveCSS('opacity', '1');
  await expect(dialog.getByLabel('担当Role').first()).toHaveAttribute('translate', 'no');
  await expect(dialog.getByLabel('Model').first()).toHaveAttribute('translate', 'no');
  await dialog.locator('.stage-editor').nth(0).locator('.asset-picker:has(select[name=stageModel]) input').fill('実装Model');
  await dialog.getByLabel('Model').nth(0).selectOption({ label: '実装Model / provider/implementer · 実行系: codex luna / codex sol · effort: low / high（Global）' });
  await expect(dialog.locator('[name=modelChoice][data-choice-name="実行系"]')).toBeVisible();
  await dialog.locator('[name=modelChoice][data-choice-name="実行系"]').selectOption('codex sol');
  await dialog.locator('[name=modelChoice][data-choice-name="effort"]').selectOption('high');
  await expect(dialog.getByLabel('担当Role').nth(0)).toHaveAttribute('required', '');
  await dialog.getByLabel('追加指示（任意）').nth(0).fill('Roleの責務を土台にして、変更範囲を先に確認する。');
  await dialog.getByRole('button', { name: '＋ 工程を追加' }).click();
  await dialog.getByLabel('工程名', { exact: true }).nth(1).fill('確認');
  await dialog.locator('.stage-editor').nth(1).locator('.asset-picker:has(select[name=stageModel]) input').fill('実装Model');
  await dialog.getByLabel('Model').nth(1).selectOption({ label: '実装Model / provider/implementer · 実行系: codex luna / codex sol · effort: low / high（Global）' });
  await dialog.locator('[name=modelChoice][data-choice-name="実行系"]').nth(1).selectOption('codex luna');
  await dialog.locator('[name=modelChoice][data-choice-name="effort"]').nth(1).selectOption('low');
  await dialog.getByLabel('担当Role').nth(0).selectOption({ label: '検証担当（Global）' });
  const secondStage = dialog.locator('.stage-editor').nth(1);
  await secondStage.getByRole('button', { name: '＋ 新しいRole' }).click();
  await secondStage.getByLabel('新しいRole名').fill('レビュー担当');
  await secondStage.getByLabel('Roleの説明').fill('変更内容を独立して確認する');
  await secondStage.getByLabel('Roleの責務').fill('実際の動作と完了条件を照合する。');
  for (const [fromIndex, to, condition, label] of [[0, '確認', '実装とテストが完了した', '確認へ'], [1, '実装', '修正が必要', '戻す'], [0, '実装', '実装結果が不十分', 'やり直す'], [1, '完了', '検証結果を受け入れられる', '完了する']] as [number, string, string, string][]) {
    const stage = dialog.locator('.stage-editor').nth(fromIndex);
    await stage.getByRole('button', { name: '＋ 行き先を追加' }).click();
    const row = stage.locator('.transition-row').last();
    await row.getByLabel('行き先').selectOption({ label: to });
    await row.getByLabel('遷移条件').fill(condition);
    await row.getByLabel('表示名').fill(label);
  }
  await dialog.getByRole('button', { name: '保存する', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole('button', { name: '編集する', exact: true }).click();
  const editedStages = dialog.locator('.stage-editor');
  const firstRolePicker = editedStages.nth(0).locator('.asset-picker:has(select[name=stageRole])');
  await firstRolePicker.locator('input').fill('存在しない資産');
  await expect(firstRolePicker.locator('option', { hasText: 'レビュー担当（Global）' })).toHaveJSProperty('hidden', true);
  await firstRolePicker.locator('input').fill('');
  await expect(editedStages.nth(0).locator('.transition-row')).toHaveCount(2);
  await expect(editedStages.nth(1).locator('.transition-row')).toHaveCount(2);
  const firstStageEditor = editedStages.nth(0);
  const stageContent = firstStageEditor.locator('.stage-content');
  const stageTransitions = firstStageEditor.locator('.stage-transitions');
  await expect(dialog.getByRole('region', { name: '工程 1' })).toBeVisible();
  await expect(firstStageEditor.getByRole('region', { name: 'この工程からの遷移' })).toBeVisible();
  await expect(firstStageEditor.getByRole('group', { name: '遷移設定 1' })).toBeVisible();
  await expect(firstStageEditor.getByRole('group', { name: '遷移設定 2' })).toBeVisible();
  await firstStageEditor.locator('.transition-row').nth(0).getByRole('button', { name: '遷移設定 1を削除' }).click();
  await expect(firstStageEditor.getByRole('group', { name: '遷移設定 1' })).toBeVisible();
  await expect(firstStageEditor.locator('.transition-row').first().getByRole('button', { name: '遷移設定 1を削除' })).toBeVisible();
  await expect(firstStageEditor.getByRole('group', { name: '遷移設定 2' })).toHaveCount(0);
  await firstStageEditor.getByRole('button', { name: '＋ 行き先を追加' }).click();
  const restoredTransition = firstStageEditor.locator('.transition-row').last();
  await expect(firstStageEditor.getByRole('group', { name: '遷移設定 2' })).toBeVisible();
  await expect(restoredTransition.getByRole('button', { name: '遷移設定 2を削除' })).toBeVisible();
  await restoredTransition.getByLabel('遷移条件').fill('実装とテストが完了した');
  await restoredTransition.getByLabel('表示名').fill('確認へ');
  const colors = await firstStageEditor.evaluate(stage => {
    const panel = stage.querySelector<HTMLElement>('.stage-transitions')!;
    const heading = panel.querySelector<HTMLElement>('h4')!;
    const helper = panel.querySelector<HTMLElement>('p')!;
    const row = stage.querySelector<HTMLElement>('.transition-row')!;
    const legend = row.querySelector<HTMLElement>('legend')!;
    return {
      stageText: getComputedStyle(stage.querySelector<HTMLElement>('.stage-title')!).color,
      stageHelperText: getComputedStyle(stage.querySelector<HTMLElement>('.stage-content > .hint')!).color,
      stageBackground: getComputedStyle(stage).backgroundColor,
      stageBorder: getComputedStyle(stage).borderTopColor,
      panelText: getComputedStyle(heading).color,
      helperText: getComputedStyle(helper).color,
      panelBackground: getComputedStyle(panel).backgroundColor,
      panelBorder: getComputedStyle(panel).borderTopColor,
      rowText: getComputedStyle(legend).color,
      rowBackground: getComputedStyle(row).backgroundColor,
      rowBorder: getComputedStyle(row).borderTopColor
    };
  });
  expect(contrastRatio(colors.stageText, colors.stageBackground)).toBeGreaterThanOrEqual(4.5);
  expect(contrastRatio(colors.panelText, colors.panelBackground)).toBeGreaterThanOrEqual(4.5);
  expect(contrastRatio(colors.helperText, colors.panelBackground)).toBeGreaterThanOrEqual(4.5);
  expect(contrastRatio(colors.stageHelperText, colors.stageBackground)).toBeGreaterThanOrEqual(4.5);
  expect(contrastRatio(colors.rowText, colors.rowBackground)).toBeGreaterThanOrEqual(4.5);
  expect(contrastRatio(colors.stageBorder, colors.stageBackground)).toBeGreaterThanOrEqual(3);
  expect(contrastRatio(colors.panelBorder, colors.panelBackground)).toBeGreaterThanOrEqual(3);
  expect(contrastRatio(colors.panelBorder, colors.stageBackground)).toBeGreaterThanOrEqual(3);
  expect(contrastRatio(colors.rowBorder, colors.rowBackground)).toBeGreaterThanOrEqual(3);
  await expect(dialog.locator('[name=from]')).toHaveCount(0);
  const expectEditorToFit = async () => {
    const overflowing = await dialog.evaluate(root => {
      const modal = root as HTMLElement;
      const nodes = [modal, ...Array.from(modal.querySelectorAll<HTMLElement>('.stage-editor, .stage-content, .stage-transitions, .transition-row, .transition-fields'))];
      return nodes.filter(node => node.scrollWidth > node.clientWidth).map(node => node.className || node.tagName);
    });
    expect(overflowing).toEqual([]);
  };
  const standardViewport = page.viewportSize();
  expect(standardViewport?.width).toBe(1440);
  await expectEditorToFit();
  const wideContentBounds = await stageContent.boundingBox();
  const wideTransitionBounds = await stageTransitions.boundingBox();
  expect(wideContentBounds).not.toBeNull();
  expect(wideTransitionBounds).not.toBeNull();
  expect(wideTransitionBounds!.x).toBeGreaterThanOrEqual(wideContentBounds!.x + wideContentBounds!.width);
  expect(Math.abs(wideTransitionBounds!.y - wideContentBounds!.y)).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 1050, height: standardViewport!.height });
  await expectEditorToFit();
  const atBreakpointColumns = await firstStageEditor.evaluate(stage => getComputedStyle(stage).gridTemplateColumns.split(' ').length);
  expect(atBreakpointColumns).toBe(1);
  await page.setViewportSize({ width: 1051, height: standardViewport!.height });
  await expectEditorToFit();
  const aboveBreakpointContent = await stageContent.boundingBox();
  const aboveBreakpointTransitions = await stageTransitions.boundingBox();
  expect(aboveBreakpointContent).not.toBeNull();
  expect(aboveBreakpointTransitions).not.toBeNull();
  expect(aboveBreakpointTransitions!.x).toBeGreaterThanOrEqual(aboveBreakpointContent!.x + aboveBreakpointContent!.width);
  await page.setViewportSize({ width: 880, height: standardViewport!.height });
  await expect(firstStageEditor).toBeVisible();
  await expectEditorToFit();
  const narrowContentBounds = await stageContent.boundingBox();
  const narrowTransitionBounds = await stageTransitions.boundingBox();
  expect(narrowContentBounds).not.toBeNull();
  expect(narrowTransitionBounds).not.toBeNull();
  expect(narrowTransitionBounds!.y).toBeGreaterThanOrEqual(narrowContentBounds!.y + narrowContentBounds!.height);
  const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(horizontalOverflow).toBe(0);
  await page.setViewportSize(standardViewport!);
  await page.screenshot({ path: '/tmp/aacl-workflow-editor.png', fullPage: true });
  await dialog.getByRole('button', { name: '保存する', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('img', { name: '改善の確認の許可遷移' })).toBeVisible();
  await expect(page.locator('path.edge')).toHaveCount(4);
  await expect(page.locator('path.edge.loop')).toHaveCount(1);
  await expect(page.getByText('検証担当 経由')).toBeVisible();
  await expect(page.getByText('実装Model（サブエージェント実行）').first()).toBeVisible();
  await expect(page.locator('.detail .editor-row').nth(1).locator('p.hint').first()).toContainText('担当Role: レビュー担当');
  await expect(page.locator('.detail .editor-row').nth(0)).toContainText('Roleの責務を土台にして、変更範囲を先に確認する。');
  await page.screenshot({ path: '/tmp/aacl-workflow.png', fullPage: true });
  await page.getByRole('button', { name: 'Runを開始', exact: true }).click();
  await dialog.locator('.asset-picker:has(select[name=workflowId]) input').fill('改善の確認');
  await dialog.getByLabel('実行する依頼').fill('動作経路を確認する');
  await dialog.getByRole('button', { name: 'Runを開始', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText('担当Role: 検証担当')).toBeVisible();
  await expect(page.getByText('Roleの責務を土台にして、変更範囲を先に確認する。', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '確認へ', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '確認へ', exact: true }).click();
  await dialog.getByLabel('遷移判断の報告').fill('実装内容を確認した');
  await dialog.getByRole('button', { name: '選択した遷移を実行' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: '完了する', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '完了する', exact: true }).click();
  await dialog.getByLabel('遷移判断の報告').fill('検証結果を報告した');
  await dialog.getByRole('button', { name: '選択した遷移を実行' }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole('button', { name: 'Journalを記録', exact: true }).click();
  await dialog.getByLabel('Task（作業名）').fill('画面を通した実行検証');
  await dialog.getByLabel('Journal（Markdown）').fill('## 困った点\n改善候補の説明が不足した\n\n次回に保留する観測');
  await dialog.getByRole('button', { name: 'Journalを保存' }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole('link', { name: 'Journal Review', exact: true }).click();
  await page.locator('[data-record-list="review"] .record-panel').last().locator('summary').click();
  await expect(page.getByText('改善候補の説明が不足した', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '＋ 改善を提案' }).click();
  await dialog.getByLabel('提案名', { exact: true }).fill('報告を具体化');
  await dialog.getByLabel('観測した状況').fill('説明が不足');
  await dialog.getByLabel('変更の内容').fill('検証手順に報告の具体化を追加');
  await dialog.getByLabel('理由', { exact: true }).fill('結果を判断しやすくする');
  await dialog.locator('.asset-picker:has(select[name=assetId]) input').fill('検証手順');
  await dialog.getByLabel('変更する資産').selectOption({ label: 'Skill / 検証手順' });
  await dialog.getByLabel('更新後の本文・責務').fill('検証結果と具体的な根拠を報告する。');
  await dialog.locator('[name=journalIds]').check();
  await dialog.locator('[name=insightIds]').filter({}).last().check();
  await dialog.getByRole('button', { name: '提案を保存' }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole('button', { name: '承認', exact: true }).click();
  await dialog.getByLabel('判断の内容').fill('この変更を採用する');
  await dialog.getByRole('button', { name: '判断を記録' }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole('button', { name: '承認した変更を適用' }).click();
  await expect(page.getByText('適用済み', { exact: true })).toBeVisible();
  await page.locator('[data-record-list="review"] .record-panel').first().locator('summary').click();
  await expect(page.getByText('次回に保留する観測', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: '資産ライブラリ', exact: true }).click();
  await page.getByRole('searchbox').fill('検証手順');
  await page.locator('.asset-row').click();
  await expect(page.getByText('検証結果と具体的な根拠を報告する。', { exact: true })).toBeVisible();
  await page.getByText('検証担当 経由', { exact: true }).locator('xpath=ancestor::div[contains(@class, "relation")][1]').getByRole('button', { name: '参照元を編集' }).click();
  await expect(dialog.getByText('検証担当 → 参照先')).toBeVisible();
  await dialog.getByRole('button', { name: '紐づけを保存' }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole('button', { name: '変更履歴・復元' }).click();
  await expect(dialog.getByText('現在', { exact: true }).first()).toBeVisible();
  await dialog.getByRole('button', { name: '×', exact: true }).click();
  for (const nav of ['変更履歴', '診断', '設定・接続']) {
    await page.getByRole('link', { name: nav, exact: true }).click();
    await expect(page.getByRole('heading', { name: nav, exact: true })).toBeVisible();
  }
  const journalEnabled = page.getByLabel('タスク完了時のJournal記録を有効にする');
  await expect(journalEnabled).toBeChecked();
  await journalEnabled.uncheck();
  await page.getByRole('button', { name: '設定を保存', exact: true }).click();
  await expect(journalEnabled).not.toBeChecked();
  await journalEnabled.check();
  await page.getByRole('button', { name: '設定を保存', exact: true }).click();
  await expect(journalEnabled).toBeChecked();
  expect(errors).toEqual([]);
  const invalid = await page.request.post(`http://127.0.0.1:${app.port}/api/asset.save`, { data: { operationId: randomUUID(), asset: {}, provenance: { origin: 'ui' } } });
  expect(invalid.status()).toBe(400);
  await page.getByRole('link', { name: '資産ライブラリ', exact: true }).click();
  await page.getByRole('searchbox').fill('検証手順');
  await page.locator('.asset-row').click();
  await page.getByRole('button', { name: '削除する', exact: true }).click();
  await expect(dialog.getByText(/検証担当 → 検証手順/)).toBeVisible();
  await dialog.getByRole('button', { name: 'キャンセル', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('.asset-row')).toContainText('検証手順');
  await page.getByRole('button', { name: '削除する', exact: true }).click();
  await dialog.getByRole('checkbox', { name: 'このAssetの削除と一覧の参照解除を確定します' }).check();
  await dialog.getByRole('button', { name: '参照を解除して削除' }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole('searchbox').fill('検証手順');
  await expect(page.locator('.asset-row')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Asset Library loads summaries first and fetches the selected body on demand', async ({ page }) => {
  const response = await page.request.post(`http://127.0.0.1:${app.port}/api/asset.save`, {
    data: {
      operationId: randomUUID(),
      provenance: { origin: 'ui', userRequest: 'lazy asset detail' },
      asset: {
        kind: 'skill',
        name: 'Lazy detail skill',
        description: 'Summary description',
        explanation: 'Summary explanation',
        body: 'LAZY_DETAIL_BODY',
        supportingFiles: { 'guide.md': 'LAZY_DETAIL_FILE' },
        useCase: false,
      },
    },
  });
  expect(response.ok()).toBeTruthy();
  const asset = (await response.json()).entities[0];
  const assetListRequests: object[] = [];
  page.on('request', request => {
    if (request.url().endsWith('/api/asset.list')) assetListRequests.push(request.postDataJSON());
  });
  await page.goto(`http://127.0.0.1:${app.port}/#assets`);
  await expect(page.locator(`[href="#assets/${asset.id}"]`)).toBeVisible();
  expect(assetListRequests.length).toBeGreaterThan(0);
  expect(assetListRequests.at(-1)).not.toHaveProperty('includeBody');
  const detailResponse = page.waitForResponse(request => request.url().endsWith('/api/asset.get') && request.request().method() === 'POST');
  await page.locator(`[href="#assets/${asset.id}"]`).click();
  await detailResponse;
  await expect(page.getByText('LAZY_DETAIL_BODY', { exact: true })).toBeVisible();
  await page.getByText('guide.md', { exact: true }).click();
  await expect(page.getByText('LAZY_DETAIL_FILE', { exact: true })).toBeVisible();
});

test('Diagnostics identifies the concrete Asset behind a Runtime failure', async ({ page }) => {
  const assetResponse = await page.request.post(`http://127.0.0.1:${app.port}/api/asset.save`, {
    data: {
      operationId: randomUUID(),
      provenance: { origin: 'ui', userRequest: 'diagnostic asset display' },
      asset: {
        kind: 'skill',
        name: '診断対象Skill',
        description: 'Runtime診断の表示確認',
        explanation: 'Runtime診断の表示確認',
        body: '診断表示を確認する。',
        useCase: true,
      },
    },
  });
  expect(assetResponse.ok()).toBeTruthy();
  const asset = (await assetResponse.json()).entities[0];
  const runtimePath = join(mkdtempSync(join(tmpdir(), 'aacl-diagnostic-')), 'codex-target');
  writeFileSync(runtimePath, '既存ファイル');
  const runtimeResponse = await page.request.post(`http://127.0.0.1:${app.port}/api/runtime.register`, {
    data: { operationId: randomUUID(), runtime: 'codex', scope: 'global', path: runtimePath, platform: 'wsl' },
  });
  expect(runtimeResponse.ok()).toBeTruthy();

  await page.addInitScript(() => localStorage.setItem('aacl-language', 'ja'));
  await page.goto(`http://127.0.0.1:${app.port}/#diagnostics`);
  const diagnosticAsset = page.locator('.diagnostic-asset').filter({ hasText: asset.name });
  await expect(diagnosticAsset).toBeVisible();
  await expect(diagnosticAsset).toContainText('Skill');
  await expect(diagnosticAsset).toContainText(asset.id);
  await diagnosticAsset.click();
  await expect(page.getByRole('heading', { name: asset.name, exact: true })).toBeVisible();
});

test('Asset Library keeps the list position while opening and closing the detail drawer', async ({ page }) => {
  for (let index = 0; index < 30; index++) {
    const response = await page.request.post(`http://127.0.0.1:${app.port}/api/asset.save`, {
      data: {
        operationId: randomUUID(),
        provenance: { origin: 'ui', userRequest: 'drawer scroll regression' },
        asset: {
          kind: 'skill',
          name: `Drawer scroll test ${index}`,
          description: 'Drawer scroll regression asset',
          explanation: 'Drawer scroll regression asset',
          body: 'Drawer scroll regression body',
          scope: 'global',
          useCase: false,
          supportingFiles: {},
          stages: [],
          transitions: [],
          entryStage: '',
          metadata: {}
        }
      }
    });
    expect(response.ok()).toBeTruthy();
  }
  await page.goto(`http://127.0.0.1:${app.port}`);
  await page.locator('.asset-card').last().waitFor();
  const before = await page.locator('.asset-scroll').evaluate(node => {
    node.scrollTop = node.scrollHeight - node.clientHeight - 10;
    return node.scrollTop;
  });
  await page.locator('.asset-card').last().click();
  await expect(page.locator('.asset-drawer')).toBeVisible();
  const stageBounds = await page.locator('.asset-stage').boundingBox();
  const drawerBounds = await page.locator('.asset-drawer').boundingBox();
  expect(stageBounds).not.toBeNull();
  expect(drawerBounds).not.toBeNull();
  expect(drawerBounds!.y).toBeGreaterThanOrEqual(stageBounds!.y);
  expect(drawerBounds!.y + drawerBounds!.height).toBeLessThanOrEqual(stageBounds!.y + stageBounds!.height + 1);
  await expect(page.locator('.asset-scroll')).toHaveJSProperty('scrollTop', before);
  await page.locator('.asset-drawer').getByRole('button', { name: '×', exact: true }).click();
  await expect(page.locator('.asset-drawer')).toHaveCount(0);
  await expect(page.locator('.asset-scroll')).toHaveJSProperty('scrollTop', before);
});

test.describe('Display regressions', () => {
  let displayApp: Awaited<ReturnType<typeof serve>>;
  let origin: string;
  test.beforeEach(async () => {
    displayApp = await serve(mkdtempSync(join(tmpdir(), 'aacl-display-')), 0);
    origin = `http://127.0.0.1:${displayApp.port}`;
  });
  test.afterEach(async () => { await displayApp.close(); });

  test('late navigation responses cannot replace the current page or show stale errors', async ({ page }) => {
    await page.goto(origin);
    await expect(page.getByRole('heading', { name: 'Asset Library', exact: true })).toBeVisible();
    for (const status of [200, 500]) {
      let requestStarted!: () => void, release!: () => void, responseHandled!: () => void;
      const requested = new Promise<void>(resolve => { requestStarted = resolve; });
      const pending = new Promise<void>(resolve => { release = resolve; });
      const handled = new Promise<void>(resolve => { responseHandled = resolve; });
      await page.route('**/api/run.list', async route => {
        requestStarted();
        await pending;
        await route.fulfill({ status, json: status === 200 ? { runs: [] } : { error: 'STALE_RUN_ERROR' } });
        responseHandled();
      });
      await page.getByRole('link', { name: 'Workflow Run', exact: true }).click();
      await requested;
      await page.getByRole('link', { name: 'Asset Library', exact: true }).click();
      release();
      await handled;
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await expect(page).toHaveURL(/#assets$/);
      await expect(page.getByRole('heading', { name: 'Asset Library', exact: true })).toBeVisible();
      await expect(page.locator('#toast')).not.toContainText('STALE_RUN_ERROR');
      await page.unroute('**/api/run.list');
    }
  });

  test('Journal pages translate lazy content and update the displayed record count', async ({ page }) => {
    for (let index = 0; index < 25; index++) {
      const response = await page.request.post(`${origin}/api/journal.write`, {
        data: { operationId: randomUUID(), task: `Journal ${index}`, body: '## 改善の種\n利用者が保存した本文・管理・診断' },
      });
      expect(response.ok()).toBeTruthy();
    }
    await page.goto(`${origin}/#journals`);
    await expect(page.locator('.record-panel')).toHaveCount(20);
    await expect(page.locator('.record-intro')).toContainText('20 records shown');
    const first = page.locator('.record-panel').first();
    await first.locator('summary').first().click();
    await expect(first.getByRole('heading', { name: 'Insights', exact: true })).toBeVisible();
    await expect(first.getByText('利用者が保存した本文・管理・診断', { exact: true })).toBeVisible();
    await page.locator('[data-record-load-more]').scrollIntoViewIfNeeded();
    await expect(page.locator('.record-panel')).toHaveCount(25);
    await expect(page.locator('.record-intro')).toContainText('25 records shown');
    const last = page.locator('.record-panel').last();
    await expect(last.locator('summary')).toContainText('1 insights');
    await last.locator('summary').first().click();
    await expect(last.getByText('Original Journal', { exact: true })).toBeVisible();
  });

  test('rapid scope changes display bindings from the last selected Project', async ({ page }) => {
    const write = async (operation: string, input: object) => {
      const response = await page.request.post(`${origin}/api/${operation}`, { data: { ...input, operationId: randomUUID() } });
      expect(response.ok()).toBeTruthy();
      return response.json();
    };
    const provenance = { origin: 'ui', userRequest: 'scope display regression' };
    const role = (await write('asset.save', { provenance, asset: { kind: 'role', name: 'Scope role', description: 'Role', responsibilities: 'Check bindings' } })).entities[0];
    const projects: { id: string }[] = [];
    for (const name of ['Scope A', 'Scope B']) {
      const { project } = await write('project.init', { name, root: mkdtempSync(join(tmpdir(), 'aacl-scope-project-')) });
      projects.push(project);
      const rule = (await write('asset.save', { provenance, asset: { kind: 'rule', name: `${name} rule`, description: 'Rule', body: 'Check scope' } })).entities[0];
      await write('binding.save', { provenance, binding: { scope: project.id, sourceId: role.id, targetId: rule.id, purpose: 'reference' } });
    }
    await page.goto(origin);
    let requestStarted!: () => void, release!: () => void, responseHandled!: () => void;
    const requested = new Promise<void>(resolve => { requestStarted = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    const handled = new Promise<void>(resolve => { responseHandled = resolve; });
    await page.route('**/api/binding.list', async route => {
      if (route.request().postDataJSON().scope !== projects[0].id) { await route.continue(); return; }
      const response = await route.fetch();
      requestStarted();
      await pending;
      await route.fulfill({ response });
      responseHandled();
    });
    await page.locator('#scope-select').selectOption(projects[0].id);
    await requested;
    await page.locator('#scope-select').selectOption(projects[1].id);
    await expect(page.locator('.breadcrumb')).toContainText('Scope B');
    release();
    await handled;
    await page.locator(`.asset-card[href="#assets/${role.id}"]`).click();
    await expect(page.locator('.asset-drawer')).toContainText('Scope B rule');
    await expect(page.locator('.asset-drawer')).not.toContainText('Scope A rule');
    const summary = page.locator('.asset-drawer .scope-summary');
    await expect(summary.locator('dt')).toHaveText(['Asset stored in', 'Bindings used here']);
    await expect(summary.locator('dd')).toHaveText(['Global', 'Project / Scope B']);
    await expect(summary).toContainText('managed independently');
    await page.locator('.asset-drawer [data-action^="binding-edit:"]').click();
    await expect(page.locator('dialog .scope-summary dd')).toHaveText(['Global', 'Project / Scope B']);
    await page.locator('dialog [name=targetId]').selectOption({ label: 'Rule / Scope A rule' });
    await page.getByRole('button', { name: 'Save binding', exact: true }).click();
    await expect(page.locator('dialog')).not.toBeVisible();
    await expect(page.locator('.asset-drawer')).toContainText('Scope A rule');
    await page.locator('#language-select').selectOption('ja');
    await expect(summary.locator('dt')).toHaveText(['資産の保存先', '紐づけの管理先']);
    await expect(summary).toContainText('その後は自動同期されません');
    await page.locator('#scope-select').selectOption('global');
    await page.locator(`.asset-card[href="#assets/${role.id}"]`).click();
    await expect(summary.locator('dd')).toHaveText(['Global', 'Global']);
    await expect(page.locator('.asset-drawer')).not.toContainText('Scope A rule');
  });

  test('English Workflow editor translates added stages and renumbered transitions', async ({ page }) => {
    await page.goto(origin);
    await page.getByRole('button', { name: '+ Create asset', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Workflow', exact: true }).click();
    await dialog.locator('[data-action="stage-add"]').click();
    const stage = dialog.locator('.stage-editor');
    await expect(stage.getByLabel('Stage name', { exact: true })).toBeVisible();
    await stage.getByLabel('Stage name', { exact: true }).fill('工程名は翻訳しない');
    await stage.locator('[data-action="transition-add"]').click();
    await stage.locator('[data-action="transition-add"]').click();
    await expect(stage.locator('.transition-row').last()).toHaveAccessibleName('Transition 2');
    await stage.locator('.transition-remove').first().click();
    await expect(stage.locator('.transition-row')).toHaveAccessibleName('Transition 1');
    await expect(stage.locator('.transition-remove')).toHaveAccessibleName('Transition 1 — Delete');
    await expect(stage.getByLabel('Destination', { exact: true }).locator('option[value="completed"]')).toHaveText('Complete');
    await expect(stage.getByLabel('Stage name', { exact: true })).toHaveValue('工程名は翻訳しない');
  });

  test('Review loads distinguishable insight labels when opening a proposal', async ({ page }) => {
    const response = await page.request.post(`${origin}/api/journal.write`, {
      data: { operationId: randomUUID(), task: 'Proposal evidence task', body: '## 改善の種\n提案へ反映する内容\n\n別の改善内容' },
    });
    expect(response.ok()).toBeTruthy();
    const { insights } = await response.json();
    const detailRequests: string[] = [];
    page.on('request', request => {
      if (request.url().endsWith('/api/journal.get')) detailRequests.push(request.url());
    });
    await page.goto(`${origin}/#review`);
    await expect(page.locator('.record-panel')).toHaveCount(2);
    expect(detailRequests).toHaveLength(0);
    await page.locator('[data-action="proposal-new"]').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Proposal evidence task', { exact: true })).toBeVisible();
    await expect(dialog.locator(`[name="insightIds"][value="${insights[0].id}"]`)).toHaveAccessibleName('Proposal evidence task / 提案へ反映する内容');
    await expect(dialog.locator(`[name="insightIds"][value="${insights[1].id}"]`)).toHaveAccessibleName('Proposal evidence task / 別の改善内容');
    expect(detailRequests).toHaveLength(1);
  });

  test('long Project names keep the header and its controls inside the viewport', async ({ page }) => {
    const projectName = 'LongProjectName'.repeat(12);
    const response = await page.request.post(`${origin}/api/project.init`, {
      data: { operationId: randomUUID(), name: projectName, root: mkdtempSync(join(tmpdir(), 'aacl-display-project-')) },
    });
    expect(response.ok()).toBeTruthy();
    const { project } = await response.json();
    await page.goto(origin);
    await page.locator('#scope-select').selectOption(project.id);
    await expect(page.locator('.breadcrumb')).toContainText(projectName);
    for (const width of [880, 1149, 1150, 1151, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const bounds = await page.locator('.breadcrumb,#scope-select,#language-select,#theme-toggle').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().toJSON()));
      for (const boundsOfControl of bounds) {
        expect(boundsOfControl.left).toBeGreaterThanOrEqual(0);
        expect(boundsOfControl.right).toBeLessThanOrEqual(width);
        expect(boundsOfControl.top).toBeGreaterThanOrEqual(0);
        expect(boundsOfControl.bottom).toBeLessThan(90);
      }
      expect(bounds[0].right).toBeLessThan(bounds[1].left);
    }
    await expect(page.locator('.breadcrumb')).toHaveAttribute('title', projectName);
  });
});
