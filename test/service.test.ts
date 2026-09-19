import { test } from 'node:test';
import { request } from 'node:http';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { serve } from '../src/server.ts';
import type { Asset, Run } from '../src/schema.ts';

test('C02 C17 C32 C33: real HTTP / typed MCP / loopback / two concurrent chat Handles / static UI', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'aacl-http-'));
  const app = await serve(directory, 0);
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.port}`;
  const api = async <T>(name: string, input: object) => {
    const response = await fetch(`${base}/api/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    assert.equal(response.status, 200, await response.clone().text()); return response.json() as Promise<T>;
  };
  const rpc = async (method: string, params: object, name?: string, extraHeaders: Record<string, string> = {}) => {
    return fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method, ...(name ? { 'Mcp-Name': name } : {}), ...extraHeaders }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'aacl-integration-test', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} } } }) });
  };
  const legacyRpc = (method: string, params: object, protocolVersion?: string) => fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(protocolVersion ? { 'MCP-Protocol-Version': protocolVersion } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }) });
  const legacyResult = async <T>(response: Response) => {
    const body = await response.text(), message = response.headers.get('content-type')?.includes('text/event-stream') ? body.match(/^data: (.+)$/m)?.[1] ?? '' : body;
    return JSON.parse(message) as T;
  };
  const tool = async <T>(name: string, input: object): Promise<T> => {
    const response = await rpc('tools/call', { name, arguments: input }, name);
    assert.equal(response.status, 200, await response.clone().text());
    const json = await response.json() as { result?: { content?: { text: string }[]; isError?: boolean }; error?: unknown };
    assert.ok(!json.error, JSON.stringify(json)); assert.ok(!json.result?.isError, JSON.stringify(json));
    return JSON.parse(json.result!.content![0].text) as T;
  };
  assert.equal((app.server.address() as { address: string }).address, '127.0.0.1');
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.match(await (await fetch(base)).text(), /lang="ja"/);
  for (const file of ['/app.js', '/view-model.js', '/styles.css']) assert.equal((await fetch(base + file)).status, 200);
  assert.equal((await fetch(`${base}/api/asset.list`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' }, body: '{}' })).status, 403);
  assert.equal(await new Promise<number | undefined>((resolve, reject) => { const req = request(`${base}/health`, { headers: { Host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end(); }), 403);
  assert.equal((await fetch(`${base}/api/asset.list`, { method: 'POST', body: '{}' })).status, 415);
  assert.equal((await fetch(`${base}/mcp`)).status, 405);
  const initialized = await legacyRpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'legacy-client', version: '1' } });
  assert.equal(initialized.status, 200, await initialized.clone().text()); assert.equal(initialized.headers.get('mcp-session-id'), null);
  const legacyInit = await legacyResult<{ result: { protocolVersion: string } }>(initialized); assert.equal(legacyInit.result.protocolVersion, '2024-11-05');
  const legacyListed = await legacyRpc('tools/list', {}, '2024-11-05'); assert.equal(legacyListed.status, 200, await legacyListed.clone().text());
  assert.ok((await legacyResult<{ result: { tools: unknown[] } }>(legacyListed)).result.tools.length >= 40);
  const listed = await rpc('tools/list', {});
  assert.equal(listed.status, 200, await listed.clone().text());
  const tools = (await listed.json() as { result: { tools: { name: string; inputSchema: { required?: string[] } }[] } }).result.tools;
  assert.ok(tools.length >= 40);
  assert.ok(tools.find(t => t.name === 'aacl_context_get')?.inputSchema.required?.includes('contextHandle'));
  assert.ok(!tools.some(t => /sql|dispatch|execute_action/.test(t.name)));
  const badHeader = await rpc('tools/list', {}, undefined, { 'Mcp-Method': 'tools/call' }); assert.equal(badHeader.status, 400);
  const workflowId = randomUUID(), roleId = randomUUID();
  const created = await api<{ entities: Asset[] }>('changeset.apply', { operationId: randomUUID(), provenance: { origin: 'ui' }, changes: [
    { type: 'asset.create', id: workflowId, asset: { kind: 'workflow', name: 'HTTP Workflow', description: '結合試験', entryStage: 'start', stages: [{ id: 'start', name: '作業' }], transitions: [{ id: 'end', from: 'start', to: 'completed', condition: '作業を報告できる', label: '完了' }] } },
    { type: 'asset.create', id: roleId, asset: { kind: 'role', name: 'HTTP担当Role', description: '工程の責務を担う', responsibilities: '作業結果を報告する。' } },
    { type: 'binding.save', binding: { sourceId: workflowId, targetId: roleId, stageId: 'start', purpose: 'stage-role' } },
  ] });
  assert.equal(created.entities[0].id, workflowId);
  const [a, b] = await Promise.all(['claude', 'codex'].map(runtime => tool<{ run: Run; contextHandle: string; context: { stageRoleId: string } }>('aacl_run_start', { operationId: randomUUID(), workflowId, instruction: runtime, runtime })));
  assert.equal(a.context.stageRoleId, roleId);
  assert.notEqual(a.contextHandle, b.contextHandle);
  const [contextA, contextB] = await Promise.all([a, b].map(r => tool<{ runId: string }>('aacl_context_get', { contextHandle: r.contextHandle })));
  assert.equal(contextA.runId, a.run.id); assert.equal(contextB.runId, b.run.id);
  await tool('aacl_run_transition', { operationId: randomUUID(), contextHandle: a.contextHandle, version: 1, transitionId: 'end', report: '確認済み' });
  const other = await tool<{ run: Run }>('aacl_run_get', { contextHandle: b.contextHandle }); assert.equal(other.run.status, 'active');
  const before = app.core.asset(created.entities[0].id).revision;
  await tool('aacl_asset_get', { assetId: created.entities[0].id });
  assert.equal(app.core.asset(created.entities[0].id).revision, before);
});
