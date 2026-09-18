import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
function runPowerShell(script) {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { encoding: 'utf8', windowsHide: true });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', ...(result.error ? { error: result.error } : {}) };
}
function powerShellString(value) { return `'${value.replaceAll("'", "''")}'`; }
function checkedPowerShell(body) {
    return `$ErrorActionPreference = 'Stop'\ntry {\n${body}\n} catch { [Console]::Error.WriteLine($_); exit 1 }\nexit 0`;
}
export function quoteWindowsArgument(value) {
    let result = '"', slashes = 0;
    for (const character of value) {
        if (character === '\\') {
            slashes++;
            continue;
        }
        if (character === '"')
            result += `${'\\'.repeat(slashes * 2 + 1)}"`;
        else
            result += `${'\\'.repeat(slashes)}${character}`;
        slashes = 0;
    }
    return `${result}${'\\'.repeat(slashes * 2)}"`;
}
export class WindowsAutostart {
    taskName;
    directory;
    distroName;
    execute;
    constructor(directory, distroName = process.env.WSL_DISTRO_NAME, execute = runPowerShell) {
        this.directory = resolve(directory);
        this.distroName = distroName;
        this.execute = execute;
        this.taskName = `AACL-${createHash('sha256').update(this.directory).digest('hex').slice(0, 12)}`;
    }
    get available() { return Boolean(this.distroName); }
    invoke(script, expected = [0]) {
        const result = this.execute(script);
        if (result.error || !expected.includes(result.status ?? -1)) {
            const detail = result.error?.message ?? [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n');
            throw new Error(`Windows自動起動を操作できません${detail ? `: ${detail}` : '。PowerShellとタスクスケジューラを確認してください。'}`);
        }
        return result.status;
    }
    enable() {
        if (!this.distroName)
            throw new Error('Windows自動起動はWSL内から設定してください。');
        const executable = join(this.directory, 'bin/aacl');
        const argumentsLine = ['--distribution', this.distroName, '--exec', executable, 'ensure'].map(quoteWindowsArgument).join(' ');
        const name = powerShellString(this.taskName), args = powerShellString(argumentsLine);
        const script = checkedPowerShell(`$action = New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\\wsl.exe') -Argument ${args}\n` +
            `$account = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name\n` +
            `$trigger = New-ScheduledTaskTrigger -AtLogOn -User $account\n` +
            `$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable\n` +
            `$principal = New-ScheduledTaskPrincipal -UserId $account -LogonType Interactive -RunLevel Limited\n` +
            `Register-ScheduledTask -TaskName ${name} -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Start the AACL service in WSL when this Windows user signs in.' -Force | Out-Null`);
        this.invoke(script);
        return this.taskName;
    }
    disable() {
        const name = powerShellString(this.taskName);
        const script = checkedPowerShell(`$task = Get-ScheduledTask -TaskName ${name} -ErrorAction SilentlyContinue\n` +
            `if ($null -ne $task) { Unregister-ScheduledTask -TaskName ${name} -Confirm:$false }`);
        this.invoke(script);
    }
    status() {
        const name = powerShellString(this.taskName);
        const script = `$task = Get-ScheduledTask -TaskName ${name} -ErrorAction SilentlyContinue\n` +
            `if ($null -eq $task -or $task.State -eq 'Disabled') { exit 3 }\n` +
            `exit 0`;
        return this.invoke(script, [0, 3]) === 0;
    }
}
