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
  const fakeWindows = join(root, 'fake-windows'); mkdirSync(fakeWindows);
  const taskLog = join(root, 'scheduled-task.log');
  writeFileSync(join(fakeWindows, 'powershell.exe'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${taskLog}'\n`, { mode: 0o700 });
  const env = { ...process.env, PATH: `${fakeWindows}:${process.env.PATH ?? ''}`, WSL_DISTRO_NAME: 'AACL-test distro' };
  // Every child, including the installed launcher and restore, must use the fake Windows tools.
  const execute = (file: string, args: string[], cwd = root) => exec(file, args, { cwd, env, timeout: 15000 });
  const run = (args: string[], cwd = root) => execute(process.execPath, [cli, ...args, '--dir', dir, '--port', String(port)], cwd);
  const taskScripts = () => readFileSync(taskLog, 'utf8').trim().split('\n').map(line => {
    const encoded = line.match(/-EncodedCommand (\S+)/)?.[1];
    assert.ok(encoded, 'Windows operations must be captured by the fake PowerShell');
    return Buffer.from(encoded, 'base64').toString('utf16le');
  });
  t.after(async () => { try { await run(['stop']); } catch {} });
  const unrelated = join(root, 'unrelated'); mkdirSync(unrelated); writeFileSync(join(unrelated, 'keep.txt'), '保持する');
  assert.throws(() => prepareManagedDirectory(unrelated), /空のフォルダー/);
  const setup = await run(['setup']); assert.match(setup.stdout, /導入しました/); assert.match(setup.stdout, /自動起動: 有効/);
  const bin = join(dir, 'bin/aacl'); assert.ok(existsSync(bin));
  const health = JSON.parse((await execute(bin, ['health'])).stdout); assert.equal(health.dataDirectory, dir);
  const list = await (await fetch(`http://127.0.0.1:${port}/api/asset.list`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json() as { assets: { id: string; name: string; body: string }[] };
  assert.deepEqual(list.assets.map(a => a.name).sort(), ['journal', 'journal-review']);
  const installAgain = await fetch(`http://127.0.0.1:${port}/api/setup.skills`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operationId: randomUUID() }) });
  assert.deepEqual((await installAgain.json() as { installed: unknown[] }).installed, []);
  mkdirSync(project); const init = await run(['init'], project);
  const projectId = (JSON.parse(init.stdout) as { project: { id: string } }).project.id;
  const globalEntry = join(project, '.codex/skills', list.assets[0].name, 'SKILL.md'); assert.ok(!existsSync(globalEntry));
  const saved = await fetch(`http://127.0.0.1:${port}/api/asset.save`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operationId: randomUUID(), asset: { kind: 'skill', name: 'project-only', description: 'Project Skill', body: '本文', scope: projectId, useCase: true }, provenance: { origin: 'cli' } }) });
  assert.equal(saved.status, 200);
  const entry = join(project, '.codex/skills/project-only/SKILL.md'); assert.ok(existsSync(entry));
  await run(['backup', join(root, 'copy.sqlite')]);
  await run(['export', join(root, 'export')]); assert.ok(existsSync(join(root, 'export/records.json')));
  await run(['stop']);
  const restarted = JSON.parse((await run(['health'])).stdout); assert.notEqual(restarted.pid, health.pid);
  const restoreDir = join(root, 'restored');
  await execute(process.execPath, [cli, 'restore', join(root, 'copy.sqlite'), '--dir', restoreDir, '--port', String(await freePort())]);
  assert.ok(existsSync(join(restoreDir, 'aacl.sqlite'))); assert.ok(existsSync(join(restoreDir, 'bin/aacl')));
  const registrations = taskScripts();
  assert.equal(registrations.length, 2, 'setup and restore must both register through fake PowerShell');
  for (const script of registrations) {
    assert.match(script, /Register-ScheduledTask/);
    assert.ok(script.includes('"--distribution" "AACL-test distro"'));
  }
  assert.ok(registrations[1].includes(join(restoreDir, 'bin/aacl')));
  await assert.rejects(run(['uninstall']), /--yes/);
  await run(['uninstall', '--yes']);
  assert.equal(taskScripts().length, 3);
  assert.match(taskScripts()[2], /Unregister-ScheduledTask/);
  assert.equal(existsSync(dir), false); assert.ok(existsSync(entry)); assert.ok(!existsSync(globalEntry)); assert.equal(readFileSync(join(unrelated, 'keep.txt'), 'utf8'), '保持する');
});
