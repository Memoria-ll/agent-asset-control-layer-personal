import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import { Core, normalizeRoot } from './core.ts';
import type { Asset, Diagnostic, RuntimeTarget, Stamp } from './schema.ts';

type Entry = Stamp & { targetId: string; assetId: string; path: string; hash: string; active: boolean };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

export function safeDirectory(path: string) {
  let current = parse(path).root;
  for (const part of path.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, part);
    if (existsSync(current)) {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`通常のディレクトリを指定してください: ${current}`);
    } else mkdirSync(current, { mode: 0o700 });
  }
}

export class RuntimeEntries {
  core: Core;
  constructor(core: Core) { this.core = core; }
  discover() {
    const roots: { root: string; platform: 'wsl' | 'windows' }[] = [{ root: homedir(), platform: 'wsl' }];
    if (existsSync('/mnt/c/Users')) {
      for (const user of readdirSync('/mnt/c/Users', { withFileTypes: true })) if (user.isDirectory() && !['Public', 'Default', 'Default User', 'All Users'].includes(user.name)) roots.push({ root: `/mnt/c/Users/${user.name}`, platform: 'windows' });
    }
    return roots.flatMap(({ root, platform }) => (['claude', 'codex'] as const).map(runtime => ({ runtime, path: join(root, `.${runtime}`), platform, exists: existsSync(join(root, `.${runtime}`)) })));
  }
  register(input: { runtime: 'claude' | 'codex'; scope: string; path: string; platform: 'wsl' | 'windows' }) {
    this.core.assertScope(input.scope);
    const path = normalizeRoot(input.path);
    const old = this.core.store.list<RuntimeTarget>('runtime-target').find(t => t.path === path && t.runtime === input.runtime);
    if (old && old.scope !== input.scope) throw new Error('この設定先は別の管理先に登録されています。');
    return this.core.store.put('runtime-target', { ...input, id: old?.id, path, enabled: true }, input.scope);
  }
  registerProject(projectId: string, root: string) {
    return (['claude', 'codex'] as const).map(runtime => this.register({ scope: projectId, path: join(root, `.${runtime}`), runtime, platform: root.startsWith('/mnt/') ? 'windows' : 'wsl' }));
  }
  body(asset: Asset, runtime: string, platform = 'wsl') {
    const operation = asset.kind === 'workflow' ? 'run_start' : 'skill_get';
    const input = asset.kind === 'workflow' ? `workflowId: ${asset.id}` : `assetId: ${asset.id}`;
    const launch = platform === 'windows' ? `wsl.exe --exec sh -lc 'aacl ensure'` : 'aacl ensure';
    const description = `${asset.name}をAACLから起動する`;
    return `---\nname: aacl-${asset.id}\ndescription: ${JSON.stringify(description)}\n${runtime === 'codex' ? 'disable-model-invocation: true\n' : ''}---\n\n<!-- aacl-entry:${asset.id} -->\n\nshellで ${launch} を実行してCoreの起動を確認する。\nMCPの aacl_${operation} に ${input} を渡す。\n${asset.kind === 'workflow' ? '現在開いているProject rootをrootへ渡し、operationIdに新しいUUIDを使う。返されたcontextHandleを、この会話の後続Run操作へ渡す。\n' : '取得したCanonical本文に従う。\n'}`;
  }
  sync() {
    const results: { targetId: string; assetId: string; ok: boolean; message?: string }[] = [];
    for (const target of this.core.store.list<RuntimeTarget>('runtime-target').filter(t => t.enabled)) {
      const assets = this.core.store.list<Asset>('asset').filter(a => (a.scope === 'global' || a.scope === target.scope) && (a.kind === 'workflow' || a.kind === 'skill' && a.useCase));
      const previous = this.core.store.list<Entry>('runtime-entry').filter(e => e.targetId === target.id && e.active);
      const ids = new Set([...assets.map(a => a.id), ...previous.map(e => e.assetId)]);
      for (const assetId of ids) {
        const prior = this.core.store.list<Diagnostic>('diagnostic').find(d => d.code === 'runtime-entry' && d.target === target.id && (d.evidence as { assetId?: string })?.assetId === assetId);
        try {
          const asset = assets.find(a => a.id === assetId), old = previous.find(e => e.assetId === assetId);
          const path = target.runtime === 'claude' ? join(target.path, 'commands', `aacl-${assetId}.md`) : join(target.path, 'skills', `aacl-${assetId}`, 'SKILL.md');
          safeDirectory(dirname(path));
          let existing: string | undefined;
          if (existsSync(path)) {
            if (lstatSync(path).isSymbolicLink()) throw new Error('入口がsymlinkのため更新できません。');
            existing = readFileSync(path, 'utf8');
          }
          const desired = asset ? this.body(asset, target.runtime, target.platform) : undefined;
          if (existing !== undefined && existing !== desired && (!old || hash(existing) !== old.hash)) throw new Error('既存ファイルがAACL生成後に変更されています。内容を確認してください。');
          if (asset) {
            if (existing !== desired) {
              const temp = `${path}.${process.pid}.tmp`;
              writeFileSync(temp, desired!, { mode: 0o600, flag: 'wx' });
              renameSync(temp, path);
            }
            if (!old || old.hash !== hash(desired!)) this.core.store.put('runtime-entry', { id: old?.id, targetId: target.id, assetId, path, hash: hash(desired!), active: true });
          } else if (old) {
            if (existing !== undefined) unlinkSync(path);
            this.core.store.put('runtime-entry', { ...old, active: false });
          }
          if (prior && !prior.resolvedAt) this.core.store.put('diagnostic', { ...prior, resolvedAt: new Date().toISOString() });
          results.push({ targetId: target.id, assetId, ok: true });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.core.store.put('diagnostic', { id: prior?.id, severity: 'error', code: 'runtime-entry', target: target.id, message, evidence: { assetId } });
          results.push({ targetId: target.id, assetId, ok: false, message });
        }
      }
    }
    return results;
  }
}
