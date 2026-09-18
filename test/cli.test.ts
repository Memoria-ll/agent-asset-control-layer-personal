import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { prepareManagedDirectory } from '../src/managed-directory.ts';

const exec = promisify(execFile);
async function freePort() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

test('C16 C25 C26 C33: CLI setup / custom directory / auto-start / init / backup / restore / scoped uninstall', { timeout: 30000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'aacl-cli-')), dir = join(root, "managed folder's app"), project = join(root, 'project'), port = await freePort();
  const cli = resolve('dist/src/cli.js');
  const run = (args: string[], cwd = root) => exec(process.execPath, [cli, ...args, '--dir', dir, '--port', String(port)], { cwd, timeout: 15000 });
  t.after(async () => { try { await run(['stop']); } catch {} });
  const unrelated = join(root, 'unrelated'); mkdirSync(unrelated); writeFileSync(join(unrelated, 'keep.txt'), '保持する');
  assert.throws(() => prepareManagedDirectory(unrelated), /空のフォルダー/);
  const setup = await run(['setup']); assert.match(setup.stdout, /導入しました/);
  const bin = join(dir, 'bin/aacl'); assert.ok(existsSync(bin));
  const health = JSON.parse((await exec(bin, ['health'], { cwd: root })).stdout); assert.equal(health.dataDirectory, dir);
  const list = await (await fetch(`http://127.0.0.1:${port}/api/asset.list`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json() as { assets: { id: string; name: string; body: string }[] };
  assert.deepEqual(list.assets.map(a => a.name).sort(), ['journal', 'journal-review']);
  const installAgain = await fetch(`http://127.0.0.1:${port}/api/setup.skills`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operationId: randomUUID() }) });
  assert.deepEqual((await installAgain.json() as { installed: unknown[] }).installed, []);
  mkdirSync(project); const init = await run(['init'], project); assert.ok(JSON.parse(init.stdout).project.id);
  const entry = join(project, '.codex/skills', `aacl-${list.assets[0].id}`, 'SKILL.md'); assert.ok(existsSync(entry));
  await run(['backup', join(root, 'copy.sqlite')]);
  await run(['export', join(root, 'export')]); assert.ok(existsSync(join(root, 'export/records.json')));
  await run(['stop']);
  const restarted = JSON.parse((await run(['health'])).stdout); assert.notEqual(restarted.pid, health.pid);
  const restoreDir = join(root, 'restored');
  await exec(process.execPath, [cli, 'restore', join(root, 'copy.sqlite'), '--dir', restoreDir, '--port', String(await freePort())], { cwd: root, timeout: 15000 });
  assert.ok(existsSync(join(restoreDir, 'aacl.sqlite'))); assert.ok(existsSync(join(restoreDir, 'bin/aacl')));
  await assert.rejects(run(['uninstall']), /--yes/);
  await run(['uninstall', '--yes']);
  assert.equal(existsSync(dir), false); assert.ok(existsSync(entry)); assert.equal(readFileSync(join(unrelated, 'keep.txt'), 'utf8'), '保持する');
});
