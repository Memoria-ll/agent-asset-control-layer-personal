#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, rmSync, writeFileSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { serve, errorMessage } from './server.ts';
import { restoreBackup } from './maintenance.ts';
import { prepareManagedDirectory } from './managed-directory.ts';
import { WindowsAutostart } from './autostart.ts';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { dir: { type: 'string' }, port: { type: 'string', default: '4318' }, yes: { type: 'boolean', default: false } } });
const directory = resolve(values.dir ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local/share'), 'aacl'));
const port = Number(values.port), url = `http://127.0.0.1:${port}`;
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('portは1〜65535で指定してください。');
const command = positionals[0] ?? 'help';

async function health() {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(700) });
    if (!response.ok) throw new Error('portを別のServiceが使用しています。');
    const result = await response.json() as { service: string; dataDirectory: string };
    if (result.service !== 'aacl' || result.dataDirectory !== directory) throw new Error('このportは別のServiceまたは別のAACL管理フォルダーで使用中です。');
    return result;
  } catch (error) { if (error instanceof TypeError || (error instanceof Error && error.name === 'TimeoutError')) return null; throw error; }
}
async function ensure() {
  if (await health()) return;
  prepareManagedDirectory(directory);
  const log = openSync(join(directory, 'service.log'), 'a', 0o600);
  const entry = existsSync(join(directory, 'app/dist/src/cli.js')) ? join(directory, 'app/dist/src/cli.js') : fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [entry, 'serve', '--dir', directory, '--port', String(port)], { detached: true, stdio: ['ignore', log, log] });
  child.unref(); closeSync(log);
  for (let i = 0; i < 40; i++) { await delay(150); if (await health()) return; }
  throw new Error(`Serviceを起動できません。${join(directory, 'service.log')}を確認してください。`);
}
async function stopRunningService() {
  if (!(await health())) return;
  await api('service.stop');
  for (let i = 0; i < 40; i++) {
    if (!(await health())) return;
    await delay(100);
  }
  throw new Error('Serviceを停止できません。');
}
async function api(name: string, input: object = {}) {
  await ensure();
  const response = await fetch(`${url}/api/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const result = await response.json() as { error?: string };
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result;
}
function print(data: unknown) { process.stdout.write(`${typeof data === 'string' ? data : JSON.stringify(data, null, 2)}\n`); }
function installApplication(target: string, replace = false) {
  prepareManagedDirectory(target);
  const root = fileURLToPath(new URL('../../', import.meta.url)), app = join(target, 'app');
  if (existsSync(app)) {
    if (!replace) throw new Error('この管理フォルダーにはアプリが導入済みです。');
    rmSync(app, { recursive: true, force: true });
  }
  mkdirSync(app, { recursive: true, mode: 0o700 });
  for (const path of ['dist', 'web', 'package.json']) cpSync(join(root, path), join(app, path), { recursive: true, dereference: false });
  const dependencies = [join(root, 'node_modules'), dirname(root)].find(path => basename(path) === 'node_modules' && existsSync(path));
  if (!dependencies) throw new Error('依存パッケージを確認できません。');
  const ownPackage = join(dependencies, JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name as string);
  cpSync(dependencies, join(app, 'node_modules'), { recursive: true, dereference: false, filter: source => resolve(source) !== resolve(ownPackage) });
  if (existsSync(join(root, 'package-lock.json'))) cpSync(join(root, 'package-lock.json'), join(app, 'package-lock.json'));
  writeFileSync(join(target, '.aacl-managed'), '1\n', { mode: 0o600 });
  mkdirSync(join(target, 'bin'), { recursive: true });
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  writeFileSync(join(target, 'bin/aacl'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(app, 'dist/src/cli.js'))} --dir ${quote(target)} --port ${port} "$@"\n`, { mode: 0o700 });
}

async function main() {
  if (command === 'serve') {
    const app = await serve(directory, port);
    print(`AACL: ${url}\n管理フォルダー: ${directory}`);
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close().then(() => process.exit(0)); });
  } else if (command === 'ensure') { await ensure(); print(url); }
  else if (command === 'health') { await ensure(); print(await health()); }
  else if (command === 'init') print(await api('project.init', { root: process.cwd(), name: basename(process.cwd()), operationId: randomUUID() }));
  else if (command === 'diagnostics') print(await api('diagnostics.get'));
  else if (command === 'export') {
    if (!positionals[1]) throw new Error('出力先directoryを指定してください。');
    print(await api('data.export', { directory: resolve(positionals[1]) }));
  } else if (command === 'backup') {
    if (!positionals[1]) throw new Error('出力先fileを指定してください。');
    print(await api('data.backup', { path: resolve(positionals[1]) }));
  } else if (command === 'restore') {
    if (!positionals[1] || !values.dir) throw new Error('Backup fileと、新規復元先の--dirを指定してください。');
    print(await restoreBackup(resolve(positionals[1]), directory));
    installApplication(directory);
    const autostart = new WindowsAutostart(directory);
    if (autostart.available) autostart.enable();
    print(`復元しました: ${join(directory, 'bin/aacl')}`);
  } else if (command === 'setup') {
    const updating = existsSync(join(directory, 'app'));
    if (updating) await stopRunningService();
    installApplication(directory, updating);
    await ensure();
    await api('setup.skills', { operationId: randomUUID() });
    const autostart = new WindowsAutostart(directory);
    if (autostart.available) autostart.enable();
    print(`${updating ? '更新しました' : '導入しました'}: ${join(directory, 'bin/aacl')}\nPATHに${join(directory, 'bin')}を追加してください。\nWindowsログオン時の自動起動: ${autostart.available ? '有効' : 'WSL外のため未設定'}\nUI: ${url}\nMCP: ${url}/mcp`);
  } else if (command === 'autostart') {
    const autostart = new WindowsAutostart(directory);
    const action = positionals[1];
    if (action === 'enable') {
      if (!existsSync(join(directory, '.aacl-managed')) || !existsSync(join(directory, 'bin/aacl'))) throw new Error('先にaacl setupを実行してください。');
      print(`Windowsログオン時に自動起動します: ${autostart.enable()}`);
    } else if (action === 'disable') {
      autostart.disable(); print('Windowsログオン時の自動起動を解除しました。');
    } else if (action === 'status') {
      print(autostart.available ? `Windowsログオン時の自動起動: ${autostart.status() ? '有効' : '無効'}` : 'Windowsログオン時の自動起動: WSL外では確認できません');
    } else throw new Error('使い方: aacl autostart enable|disable|status');
  } else if (command === 'connect') {
    await ensure();
    print(`MCP: ${url}/mcp\nCodex: codex mcp add aacl --url ${url}/mcp\nClaude Code: claude mcp add --transport http aacl ${url}/mcp`);
  } else if (command === 'stop') {
    if (await health()) print(await api('service.stop'));
    else print('Serviceは停止しています。');
  } else if (command === 'uninstall') {
    if (!values.yes) throw new Error(`削除範囲: ${directory}\n確認後に--yesを付けて実行してください。Runtime入口は残ります。`);
    if ([homedir(), '/', process.cwd()].includes(directory) || !existsSync(join(directory, '.aacl-managed')) || lstatSync(directory).isSymbolicLink() || readFileSync(join(directory, '.aacl-managed'), 'utf8') !== '1\n') throw new Error('AACL管理フォルダーを確認できません。');
    if (new WindowsAutostart(directory).available) new WindowsAutostart(directory).disable();
    if (await health()) { await api('service.stop'); for (let i = 0; i < 40 && await health(); i++) await delay(100); if (await health()) throw new Error('Serviceを停止できません。'); }
    rmSync(directory, { recursive: true });
    print(`削除しました: ${directory}`);
  } else {
    print('AACL — 開発方法を育てる\n\naacl setup [--dir PATH]  アプリとデータの保存先へ導入\naacl serve              localhost Serviceを起動\naacl ensure             未起動ならバックグラウンドで起動\naacl autostart enable   Windowsログオン時の自動起動を有効化\naacl autostart disable  自動起動を解除\naacl autostart status   自動起動の状態を確認\naacl connect            起動してMCP接続方法を表示\naacl init               現在のProjectを登録\naacl health             接続確認\naacl diagnostics        診断\naacl export DIRECTORY   Markdown / JSONを出力\naacl backup FILE        SQLite Backup\naacl restore FILE --dir NEW_DIRECTORY  新規フォルダーへ復元\naacl stop               Service停止\naacl uninstall --yes    管理フォルダーを削除\n\n共通: --dir PATH --port 4318');
    if (command !== 'help') process.exitCode = 1;
  }
}
main().catch(error => { process.stderr.write(`${errorMessage(error)}\n`); process.exitCode = 1; });
