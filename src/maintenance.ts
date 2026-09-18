import { backup, DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, writeFileSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Core, normalizeRoot } from './core.ts';
import { safeDirectory } from './runtime.ts';
import type { Asset, Journal } from './schema.ts';

export function exportData(core: Core, destination: string) {
  const directory = normalizeRoot(destination);
  if (existsSync(directory)) throw new Error('Exportには新しい出力先ディレクトリを指定してください。');
  safeDirectory(directory);
  const write = (name: string, content: string) => writeFileSync(join(directory, name), content, { flag: 'wx', mode: 0o600 });
  for (const a of core.store.list<Asset>('asset')) {
    const { body, ...metadata } = a;
    write(`asset-${a.id}.md`, `---\n${Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n\n${body}\n`);
  }
  for (const j of core.store.list<Journal>('journal')) {
    const { raw, parsed: _parsed, ...metadata } = j;
    write(`journal-${j.id}.md`, `---\n${Object.entries(metadata).filter(([, v]) => v !== undefined).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n\n${raw}\n`);
  }
  write('records.json', JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), records: core.store.db.prepare('SELECT kind,scope,data FROM records').all().map(r => ({ ...r, data: JSON.parse(r.data as string) })), revisions: core.store.db.prepare('SELECT * FROM revisions').all().map(r => ({ ...r, data: JSON.parse(r.data as string) })) }, null, 2));
  return { directory };
}

export async function backupData(core: Core, destination: string) {
  const path = normalizeRoot(destination);
  if (resolve(path) === resolve(core.store.db.location() ?? '')) throw new Error('稼働中DBは出力先に指定できません。');
  const fd = openSync(path, 'wx', 0o600);
  closeSync(fd);
  try { await backup(core.store.db, path); } catch (error) { unlinkSync(path); throw error; }
  return { path, schemaVersion: 1 };
}

export async function restoreBackup(source: string, destinationDirectory: string) {
  const sourcePath = normalizeRoot(source), directory = normalizeRoot(destinationDirectory);
  if (existsSync(directory)) throw new Error('復元先には新しいAACL管理フォルダーを指定してください。');
  const db = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
    if (version !== 1 || db.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok') throw new Error('Backupの整合性またはschema versionが不適合です。');
    for (const table of ['records', 'revisions', 'operations']) if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) throw new Error('AACLのBackupではありません。');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    await backup(db, join(directory, 'aacl.sqlite'));
    writeFileSync(join(directory, '.aacl-managed'), '1\n', { mode: 0o600 });
  } finally { db.close(); }
  return { directory };
}
