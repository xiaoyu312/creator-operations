import { createServer, type IncomingMessage } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createDemoApplication } from './application.ts';
import { DomainError } from '../domain/errors.ts';
import { apiError } from '../http/router.ts';

const MAX_BODY_BYTES = 6 * 1024 * 1024;

async function readBody(request: IncomingMessage): Promise<unknown> {
  if (request.method !== 'POST') return undefined;
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
    throw new DomainError('VALIDATION_ERROR', '写入请求必须使用 application/json。');
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_BODY_BYTES) throw new DomainError('VALIDATION_ERROR', '请求正文不能超过 6 MiB。');
    chunks.push(buffer);
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected object');
    return body;
  } catch {
    throw new DomainError('VALIDATION_ERROR', '请求正文必须是有效的 JSON 对象。');
  }
}

/** Only an explicit invocation of this entry point opens a loopback listener. */
export async function startDemo() {
  const app = createDemoApplication();
  const server = createServer(async (request, response) => {
    try {
      const result = await app.dispatch({
        method: request.method ?? 'GET',
        url: request.url ?? '/',
        headers: request.headers,
        body: await readBody(request),
      });
      response.writeHead(result.status, result.headers);
      response.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body));
    } catch (error) {
      const result = apiError(error);
      response.writeHead(result.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(result.body));
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(app.config.port, app.config.host, () => { server.off('error', reject); resolve(); });
  });
  const stop = () => server.close();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.stdout.write(`Synthetic demo API: http://${app.config.host}:${app.config.port}/api (memory only)\n`);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startDemo().catch(() => {
    process.stderr.write('Local synthetic API did not start. Check demo mode and port configuration.\n');
    process.exitCode = 1;
  });
}
