import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

export function prepareManagedDirectory(directory: string) {
  const path = resolve(directory), marker = join(path, '.aacl-managed');
  if (path === '/' || path === homedir() || path === process.cwd()) throw new Error('アプリ専用の保存先を指定してください。');
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('AACL管理フォルダーにsymlinkは使えません。');
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (existsSync(marker)) {
    if (lstatSync(marker).isSymbolicLink() || readFileSync(marker, 'utf8') !== '1\n') throw new Error('AACL管理フォルダーを確認できません。');
  } else {
    if (readdirSync(path).length) throw new Error('空のフォルダーか、既存のAACL管理フォルダーを指定してください。');
    try { writeFileSync(marker, '1\n', { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || readFileSync(marker, 'utf8') !== '1\n') throw error; }
  }
  for (const file of ['aacl.sqlite', 'aacl.sqlite-wal', 'aacl.sqlite-shm', 'service.log']) {
    const target = join(path, file);
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error(`管理ファイルにsymlinkは使えません: ${file}`);
  }
  return path;
}
