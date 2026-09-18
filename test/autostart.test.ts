import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { quoteWindowsArgument, WindowsAutostart } from '../src/autostart.ts';

test('Windows autostart registers a per-install logon task that starts WSL through aacl ensure', () => {
  const scripts: string[] = [];
  let registered = false;
  const execute = (script: string) => {
    scripts.push(script);
    if (script.includes('Register-ScheduledTask')) { registered = true; return { status: 0, stdout: '', stderr: '' }; }
    if (script.includes('Unregister-ScheduledTask')) { registered = false; return { status: 0, stdout: '', stderr: '' }; }
    if (script.includes('Get-ScheduledTask')) return { status: registered ? 0 : 3, stdout: '', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const directory = join(tmpdir(), "AACL user's data");
  const autostart = new WindowsAutostart(directory, 'Ubuntu 24.04', execute);
  assert.equal(autostart.available, true);
  assert.equal(autostart.enable(), autostart.taskName);
  assert.match(scripts[0], /New-ScheduledTaskAction -Execute \(Join-Path \$env:WINDIR/);
  assert.ok(scripts[0].includes('"--distribution" "Ubuntu 24.04"'));
  assert.match(scripts[0], /New-ScheduledTaskTrigger -AtLogOn/);
  assert.match(scripts[0], /ensure/);
  assert.equal(autostart.status(), true);
  autostart.disable();
  assert.equal(autostart.status(), false);
  assert.match(scripts[2], /Unregister-ScheduledTask/);
});

test('Windows command arguments preserve spaces, quotes, and trailing backslashes', () => {
  assert.equal(quoteWindowsArgument('Ubuntu 24.04'), '"Ubuntu 24.04"');
  assert.equal(quoteWindowsArgument('C:\\Program Files\\AACL\\'), '"C:\\Program Files\\AACL\\\\"');
  assert.equal(quoteWindowsArgument('A"B'), '"A\\"B"');
});

test('Windows autostart is only enabled from a WSL distribution and reports registration errors', () => {
  const unavailable = new WindowsAutostart(join(tmpdir(), 'aacl-no-wsl'), '', () => ({ status: 0, stdout: '', stderr: '' }));
  assert.equal(unavailable.available, false);
  assert.throws(() => unavailable.enable(), /WSL内から設定/);
  const broken = new WindowsAutostart(join(tmpdir(), 'aacl-broken'), 'Ubuntu', () => ({ status: 1, stdout: '', stderr: 'Access denied' }));
  assert.throws(() => broken.enable(), /Access denied/);
});
