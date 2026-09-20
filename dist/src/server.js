import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { localhostHostValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { ZodError } from 'zod';
import { Store } from './store.js';
import { ConflictError, Core } from './core.js';
import { Operations } from './operations.js';
import { prepareManagedDirectory } from './managed-directory.js';
async function body(request) {
    let length = 0;
    const chunks = [];
    for await (const chunk of request) {
        const buffer = Buffer.from(chunk);
        length += buffer.length;
        if (length > 2 * 1024 * 1024)
            throw new Error('入力は2MiB以内にしてください。');
        chunks.push(buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function json(response, status, data) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(data));
}
export async function serve(directory, port = 4318) {
    const dataDirectory = prepareManagedDirectory(directory);
    const store = new Store(join(dataDirectory, 'aacl.sqlite')), core = new Core(store), operations = new Operations(core);
    const mcp = createMcpHandler(() => {
        const server = new McpServer({ name: 'aacl', version: '0.1.0' }, { instructions: '共通の利用案内と操作例はaacl_bootstrap_getで取得してください。各ツールのdescriptionには操作条件と入力例だけを記載しています。' });
        for (const [name, op] of operations.entries) {
            if (!op.mcpVisible)
                continue;
            server.registerTool(`aacl_${name.replaceAll('.', '_')}`, {
                description: op.description, inputSchema: op.schema,
                annotations: { readOnlyHint: !op.write && !name.startsWith('data.'), destructiveHint: name.endsWith('restore') || name.endsWith('remove'), idempotentHint: op.write, openWorldHint: false },
            }, async (args) => {
                try {
                    return { content: [{ type: 'text', text: JSON.stringify(await op.execute(args)) }] };
                }
                catch (error) {
                    const message = errorMessage(error), code = error instanceof ConflictError ? error.code : 'INVALID_REQUEST';
                    return { isError: true, structuredContent: { error: { code, message } }, content: [{ type: 'text', text: message }] };
                }
            });
        }
        return server;
    });
    const mcpHandler = toNodeHandler(mcp), validateHost = localhostHostValidation();
    const packageRoot = fileURLToPath(new URL(existsSync(new URL('../../package.json', import.meta.url)) ? '../../' : '../', import.meta.url));
    const staticFiles = new Map([
        ['/', { path: join(packageRoot, 'web/index.html'), type: 'text/html; charset=utf-8' }],
        ['/styles.css', { path: join(packageRoot, 'web/styles.css'), type: 'text/css; charset=utf-8' }],
        ['/i18n.js', { path: join(packageRoot, 'dist/web/i18n.js'), type: 'text/javascript; charset=utf-8' }],
        ['/view-model.js', { path: join(packageRoot, 'dist/web/view-model.js'), type: 'text/javascript; charset=utf-8' }],
        ['/app.js', { path: join(packageRoot, 'dist/web/app.js'), type: 'text/javascript; charset=utf-8' }],
    ]);
    const server = createServer(async (request, response) => {
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Referrer-Policy', 'no-referrer');
        response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
        if (!validateHost(request, response))
            return;
        const expectedOrigin = `http://${request.headers.host}`;
        if (request.headers.origin && request.headers.origin !== expectedOrigin) {
            json(response, 403, { error: '同じlocalhostから操作してください。' });
            return;
        }
        const path = new URL(request.url ?? '/', expectedOrigin).pathname;
        try {
            if (path === '/health' && request.method === 'GET') {
                json(response, 200, { service: 'aacl', schemaVersion: 1, dataDirectory, pid: process.pid });
                return;
            }
            if (path === '/mcp') {
                if (request.method !== 'POST') {
                    response.setHeader('Allow', 'POST');
                    json(response, 405, { error: 'POSTを使用してください。' });
                    return;
                }
                await mcpHandler(request, response, await body(request));
                return;
            }
            if (path.startsWith('/api/') && request.method === 'POST') {
                if (!request.headers['content-type']?.startsWith('application/json')) {
                    json(response, 415, { error: 'application/jsonを指定してください。' });
                    return;
                }
                const name = path.slice(5), input = await body(request);
                if (name === 'service.stop') {
                    json(response, 200, { stopped: true });
                    setImmediate(() => { void close(); });
                    return;
                }
                if (!operations.entries.has(name)) {
                    json(response, 404, { error: '操作が見つかりません。' });
                    return;
                }
                json(response, 200, await operations.execute(name, input));
                return;
            }
            const file = staticFiles.get(path);
            if (file && request.method === 'GET') {
                const content = readFileSync(file.path);
                response.writeHead(200, { 'Content-Type': file.type, 'Cache-Control': 'no-cache' });
                response.end(content);
                return;
            }
            json(response, 404, { error: 'ページが見つかりません。' });
        }
        catch (error) {
            if (!response.headersSent) {
                const conflict = error instanceof ConflictError;
                json(response, conflict ? 409 : 400, { code: conflict ? error.code : 'INVALID_REQUEST', error: errorMessage(error) });
            }
            else
                response.end();
        }
    });
    const timer = setInterval(() => { try {
        store.atomic(() => core.expireRuns());
    }
    catch (e) {
        process.stderr.write(`${errorMessage(e)}\n`);
    } }, 60000);
    timer.unref();
    let closed = false;
    const close = async () => {
        if (closed)
            return;
        closed = true;
        clearInterval(timer);
        await mcp.close();
        await new Promise((res, rej) => server.close(error => error ? rej(error) : res()));
        store.close();
    };
    try {
        await new Promise((res, rej) => { server.once('error', rej); server.listen(port, '127.0.0.1', res); });
    }
    catch (error) {
        clearInterval(timer);
        store.close();
        await mcp.close();
        throw error;
    }
    const address = server.address();
    return { server, core, operations, close, port: typeof address === 'object' && address ? address.port : port };
}
export function errorMessage(error) {
    return error instanceof ZodError ? error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('\n') : error instanceof Error ? error.message : String(error);
}
