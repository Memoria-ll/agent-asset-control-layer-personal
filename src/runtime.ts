import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { Core, normalizeRoot } from './core.ts';
import { supportingFilePathError } from './schema.ts';
import type { Asset, Diagnostic, RuntimeFile, RuntimeTarget, Stamp } from './schema.ts';

type Entry = Stamp & { targetId: string; assetId: string; path: string; hash: string; active: boolean; implicitInvocation?: boolean };
const codexPolicyRelativePath = 'agents/openai.yaml';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const fileMode = (path: string) => path.toLowerCase().endsWith('.sh') ? 0o700 : 0o600;
const runtimeSlug = (name: string) => name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function synthesizeCodexPolicy(source: string | undefined, implicitInvocation = false) {
  let parsed: unknown = {};
  try {
    if (source?.trim()) parsed = parseYaml(source);
  } catch (error) {
    throw new Error(`agents/openai.yamlのYAMLを解釈できません: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) throw new Error('agents/openai.yamlのYAMLルートはマッピングで指定してください。');
  if (parsed.policy !== undefined && !isRecord(parsed.policy)) throw new Error('agents/openai.yamlのpolicyはマッピングで指定してください。');
  const policy = isRecord(parsed.policy) ? parsed.policy : {};
  return stringifyYaml({ ...parsed, policy: { ...policy, allow_implicit_invocation: implicitInvocation } }, { lineWidth: 0 });
}

function runtimeNames(assets: Asset[]) {
  const names = new Map(assets.map(asset => [asset.id, runtimeSlug(asset.name)]));
  const counts = new Map<string, number>();
  for (const name of names.values()) {
    const key = name.slice(0, 64).replace(/-+$/g, '');
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Map(assets.map(asset => {
    const name = names.get(asset.id)!;
    const key = name.slice(0, 64).replace(/-+$/g, '');
    const suffix = key && counts.get(key)! > 1 ? `-${asset.id}` : '';
    const stem = name.slice(0, 64 - suffix.length).replace(/-+$/g, '');
    return [asset.id, `${stem}${suffix}`];
  }));
}

function removeEmptyCodexSkillDirectory(runtime: string, path: string) {
  if (runtime !== 'codex' || !path.endsWith('/SKILL.md')) return;
  const directory = dirname(path), agents = join(directory, 'agents');
  if (existsSync(agents) && readdirSync(agents).length === 0) rmdirSync(agents);
  if (existsSync(directory) && readdirSync(directory).length === 0) rmdirSync(directory);
}

function supportRoot(runtime: RuntimeTarget['runtime'], entryPath: string) {
  return runtime === 'claude' ? join(dirname(entryPath), parse(entryPath).name) : dirname(entryPath);
}

function assertWithin(root: string, path: string) {
  const child = relative(root, path);
  if (!child || child === '..' || child.startsWith(`..${path.includes('\\') ? '\\' : '/'}`) || isAbsolute(child)) throw new Error(`Runtime配置先の外側へ補助ファイルを配置できません: ${path}`);
}

function cleanupEmptyDirectories(path: string, stop: string) {
  let current = path;
  while (current !== stop && existsSync(current)) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory() || readdirSync(current).length > 0) return;
    rmdirSync(current);
    current = dirname(current);
  }
}

function safeExistingDirectory(path: string) {
  let current = parse(path).root;
  for (const part of path.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, part);
    let stat;
    try { stat = lstatSync(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`通常のディレクトリを指定してください: ${current}`);
  }
}

function readRegularFile(path: string) {
  let stat;
  try { stat = lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`Runtime補助ファイルがsymlinkのため操作できません: ${path}`);
  if (!stat.isFile()) throw new Error(`Runtime補助ファイルが通常ファイルではありません: ${path}`);
  return readFileSync(path, 'utf8');
}

function writeOwnedFile(path: string, content: string) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, content, { mode: fileMode(path), flag: 'wx' });
    renameSync(temporary, path);
    chmodSync(path, fileMode(path));
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

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
  body(asset: Asset, runtime: string, entryName = runtimeSlug(asset.name)) {
    const operation = asset.kind === 'workflow' ? 'run_start' : 'skill_get';
    const input = asset.kind === 'workflow' ? `workflowId: ${asset.id}` : `assetId: ${asset.id}`;
    const implicitInvocation = asset.kind === 'skill' && asset.implicitInvocation === true;
    // Codex requires a description even for entries that can only be invoked explicitly.
    const description = implicitInvocation ? asset.description : `${asset.name}をAACLから起動する`;
    const frontmatter = `---\nname: ${entryName}\n`
      + (runtime === 'codex' || implicitInvocation ? `description: ${JSON.stringify(description)}\n` : '')
      + (runtime === 'claude' ? `disable-model-invocation: ${!implicitInvocation}\n` : '')
      + '---';
    return `${frontmatter}\n\n<!-- aacl-entry:${asset.id} -->\n\nMCPの aacl_${operation} に ${input} を渡す。\n${asset.kind === 'workflow' ? '現在開いているProject rootをrootへ渡し、operationIdに新しいUUIDを使う。返されたnextExecutionのexecutorを確認し、実施主体がcontextHandleでaacl_context_getを呼び出してからStageを実施する。遷移後も返されたnextExecutionに従い、Skill・Rule本文をオーケストレーターへ転送しない。\n' : '取得したCanonical本文に従う。\n'}`;
  }
  policy(runtime: string, implicitInvocation = false, source?: string) {
    return runtime === 'codex' ? synthesizeCodexPolicy(source, implicitInvocation) : undefined;
  }
  private syncSupportingFiles(target: RuntimeTarget, asset: Asset | undefined, oldEntry: Entry | undefined, entryPath: string | undefined, previous: RuntimeFile[], implicitInvocation = false, legacyPolicy?: string) {
    const oldRoot = oldEntry ? supportRoot(target.runtime, oldEntry.path) : undefined;
    const currentRoot = asset && entryPath ? supportRoot(target.runtime, entryPath) : undefined;
    const desired = new Map<string, string>();
    if (asset && currentRoot) {
      for (const [relativePath, content] of Object.entries(asset.supportingFiles)) {
        const error = supportingFilePathError(relativePath);
        if (error) throw new Error(error);
        const path = join(currentRoot, relativePath);
        assertWithin(currentRoot, path);
        if (target.runtime !== 'codex' || relativePath !== codexPolicyRelativePath) desired.set(relativePath, content);
      }
      if (target.runtime === 'codex') desired.set(codexPolicyRelativePath, this.policy(target.runtime, implicitInvocation, asset.supportingFiles[codexPolicyRelativePath])!);
      if (desired.size) safeDirectory(currentRoot);
    }
    const paths = new Set([...previous.map(file => file.relativePath), ...desired.keys()]);
    for (const relativePath of paths) {
      const prior = previous.find(file => file.relativePath === relativePath);
      const content = desired.get(relativePath);
      const currentPath = content === undefined || !currentRoot ? undefined : join(currentRoot, relativePath);
      const oldPath = target.runtime === 'codex' && relativePath === codexPolicyRelativePath && oldEntry
        ? join(oldRoot!, relativePath)
        : prior?.path;
      if (currentPath && currentRoot) assertWithin(currentRoot, currentPath);
      if (oldPath && oldRoot) assertWithin(oldRoot, oldPath);
      let oldContent: string | undefined;
      if (oldPath && oldPath !== currentPath) {
        safeExistingDirectory(dirname(oldPath));
        oldContent = readRegularFile(oldPath);
        if (oldContent !== undefined && (!oldRoot || (!prior && oldContent !== legacyPolicy) || (prior && hash(oldContent) !== prior.hash))) throw new Error(`以前のRuntime補助ファイルがAACL生成後に変更されています。内容を確認してください: ${oldPath}`);
      }
      if (content !== undefined && currentPath && asset) {
        safeDirectory(dirname(currentPath));
        const existing = readRegularFile(currentPath);
        const acceptsLegacyPolicy = target.runtime === 'codex' && relativePath === codexPolicyRelativePath && existing === legacyPolicy;
        if (existing !== undefined && (!prior || prior.path !== currentPath) && !acceptsLegacyPolicy) throw new Error(`Runtime補助ファイルが既存ファイルと衝突しています: ${currentPath}`);
        if (existing !== undefined && prior && hash(existing) !== prior.hash) throw new Error(`Runtime補助ファイルがAACL生成後に変更されています。内容を確認してください: ${currentPath}`);
        if (existing !== content) writeOwnedFile(currentPath, content);
        else chmodSync(currentPath, fileMode(currentPath));
        if (oldContent !== undefined && oldPath && oldRoot) {
          unlinkSync(oldPath);
          cleanupEmptyDirectories(dirname(oldPath), dirname(oldRoot));
        }
        if (!prior || prior.path !== currentPath || prior.assetRevision !== asset.revision || prior.hash !== hash(content) || prior.executable !== (fileMode(currentPath) === 0o700) || !prior.active) {
          this.core.store.put('runtime-file', { id: prior?.id, targetId: target.id, assetId: asset.id, assetRevision: asset.revision, relativePath, path: currentPath, hash: hash(content), active: true, executable: fileMode(currentPath) === 0o700 });
        }
      } else if (prior) {
        if (oldPath) {
          safeExistingDirectory(dirname(oldPath));
          const oldContent = readRegularFile(oldPath);
          if (oldContent !== undefined) {
            if (!oldRoot || hash(oldContent) !== prior.hash) throw new Error(`Runtime補助ファイルがAACL生成後に変更されています。内容を確認してください: ${oldPath}`);
            unlinkSync(oldPath);
            cleanupEmptyDirectories(dirname(oldPath), dirname(oldRoot));
          }
        }
        if (prior.active) this.core.store.put('runtime-file', { ...prior, active: false });
      }
    }
  }
  sync(assetIds?: Iterable<string>) {
    const requested = assetIds === undefined ? undefined : new Set(assetIds);
    const allAssets = this.core.store.list<Asset>('asset');
    const results: { targetId: string; assetId: string; ok: boolean; message?: string }[] = [];
    for (const target of this.core.store.list<RuntimeTarget>('runtime-target').filter(t => t.enabled)) {
      const boundSkillIds = new Set(this.core.bindings(target.scope).filter(b => b.purpose === 'reference').map(b => b.targetId).filter(assetId => allAssets.some(a => a.id === assetId && a.kind === 'skill')));
      const assets = allAssets.filter(a => !a.deletedAt && a.scope === target.scope && (a.kind === 'workflow' || a.kind === 'skill' && (a.useCase || a.implicitInvocation === true || boundSkillIds.has(a.id))));
      const names = runtimeNames(assets);
      const previous = this.core.store.list<Entry>('runtime-entry').filter(e => e.targetId === target.id && e.active);
      const previousFiles = this.core.store.list<RuntimeFile>('runtime-file').filter(file => file.targetId === target.id);
      const ids = new Set([...assets.map(a => a.id), ...previous.map(e => e.assetId), ...previousFiles.map(file => file.assetId)]);
      if (requested) {
        ids.clear();
        for (const asset of assets) {
          const old = previous.find(entry => entry.assetId === asset.id);
          const entryName = names.get(asset.id);
          const path = entryName ? target.runtime === 'claude' ? join(target.path, 'commands', `${entryName}.md`) : join(target.path, 'skills', entryName, 'SKILL.md') : undefined;
          const desired = entryName ? this.body(asset, target.runtime, entryName) : undefined;
          const implicitInvocation = asset.kind === 'skill' && asset.implicitInvocation === true;
          if (requested.has(asset.id) || (old && path && (old.path !== path || old.hash !== hash(desired!) || old.implicitInvocation !== implicitInvocation))) ids.add(asset.id);
        }
        for (const entry of previous) if (requested.has(entry.assetId)) ids.add(entry.assetId);
        for (const file of previousFiles) if (requested.has(file.assetId)) ids.add(file.assetId);
      }
      for (const assetId of ids) {
        let phase: 'runtime-entry' | 'runtime-file' = 'runtime-entry';
        const prior = this.core.store.list<Diagnostic>('diagnostic').find(d => d.code === 'runtime-entry' && d.target === target.id && (d.evidence as { assetId?: string })?.assetId === assetId);
        const priorFile = this.core.store.list<Diagnostic>('diagnostic').find(d => d.code === 'runtime-file' && d.target === target.id && (d.evidence as { assetId?: string })?.assetId === assetId);
        try {
          const asset = assets.find(a => a.id === assetId), old = previous.find(e => e.assetId === assetId);
          const entryName = asset ? names.get(assetId)! : undefined;
          if (asset && !entryName) throw new Error('Asset名からRuntime入口名を作れません。英小文字・数字を含む名前にしてください。');
          const path = asset ? target.runtime === 'claude' ? join(target.path, 'commands', `${entryName}.md`) : join(target.path, 'skills', entryName!, 'SKILL.md') : old?.path;
          if (!path) throw new Error('以前のRuntime入口の配置先を取得できません。');
          safeDirectory(dirname(path));
          let existing: string | undefined;
          if (existsSync(path)) {
            if (lstatSync(path).isSymbolicLink()) throw new Error('入口がsymlinkのため更新できません。');
            existing = readFileSync(path, 'utf8');
          }
          const desired = asset ? this.body(asset, target.runtime, entryName) : undefined;
          const oldImplicitInvocation = old?.implicitInvocation === true;
          let oldPathExists = false;
          if (asset && old && old.path !== path && existsSync(old.path)) {
            safeDirectory(dirname(old.path));
            if (lstatSync(old.path).isSymbolicLink()) throw new Error('以前の入口がsymlinkのため移動できません。');
            if (hash(readFileSync(old.path, 'utf8')) !== old.hash) throw new Error('以前の入口がAACL生成後に変更されています。内容を確認してください。');
            oldPathExists = true;
          }
          if (existing !== undefined && existing !== desired && (!old || old.path !== path || hash(existing) !== old.hash)) throw new Error('既存ファイルがAACL生成後に変更されています。内容を確認してください。');
          if (asset) {
            if (existing !== desired) writeOwnedFile(path, desired!);
            if (oldPathExists) {
              if (lstatSync(old!.path).isSymbolicLink() || hash(readFileSync(old!.path, 'utf8')) !== old!.hash) throw new Error('以前の入口がAACL生成後に変更されています。内容を確認してください。');
              unlinkSync(old!.path);
              removeEmptyCodexSkillDirectory(target.runtime, old!.path);
            }
            const implicitInvocation = asset.kind === 'skill' && asset.implicitInvocation === true;
            if (!old || old.path !== path || old.hash !== hash(desired!) || old.implicitInvocation !== implicitInvocation) this.core.store.put('runtime-entry', { id: old?.id, targetId: target.id, assetId, path, hash: hash(desired!), active: true, implicitInvocation });
          } else if (old) {
            if (existing !== undefined) unlinkSync(path);
            removeEmptyCodexSkillDirectory(target.runtime, path);
            this.core.store.put('runtime-entry', { ...old, active: false });
          }
          phase = 'runtime-file';
          const implicitInvocation = asset ? asset.kind === 'skill' && asset.implicitInvocation === true : oldImplicitInvocation;
          const legacyPolicy = target.runtime === 'codex' ? this.policy(target.runtime, oldImplicitInvocation) : undefined;
          this.syncSupportingFiles(target, asset, old, asset ? path : old?.path, previousFiles.filter(file => file.assetId === assetId), implicitInvocation, legacyPolicy);
          if (prior && !prior.resolvedAt) this.core.store.put('diagnostic', { ...prior, resolvedAt: new Date().toISOString() });
          if (priorFile && !priorFile.resolvedAt) this.core.store.put('diagnostic', { ...priorFile, resolvedAt: new Date().toISOString() });
          results.push({ targetId: target.id, assetId, ok: true });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const diagnostic = phase === 'runtime-entry' ? prior : priorFile;
          this.core.store.put('diagnostic', { id: diagnostic?.id, severity: 'error', code: phase, target: target.id, message, evidence: { assetId } });
          results.push({ targetId: target.id, assetId, ok: false, message });
        }
      }
    }
    return {
      successCount: results.filter(result => result.ok).length,
      failureCount: results.filter(result => !result.ok).length,
      targetIds: [...new Set(results.map(result => result.targetId))],
    };
  }
}
