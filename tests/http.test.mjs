import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { ApiClient } from '../dist/services/apiClient.js';

const TOKEN = 'fixture-access-token-do-not-print';

async function server(t, handler) {
  const instance = createServer(handler);
  instance.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(async () => {
    instance.closeAllConnections();
    await new Promise((resolve) => instance.close(resolve));
  });
  return `http://127.0.0.1:${instance.address().port}`;
}

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(data));
}

test('account requests carry the bearer header and JSON body without changing the supplied idempotency key', async (t) => {
  const expected = {
    idempotencyKey: '10000000-0000-4000-8000-000000000001',
    expectedReportRevision: 2,
  };
  let calls = 0;
  const origin = await server(t, async (request, response) => {
    calls++;
    assert.equal(request.url, '/api/agent/reports/report-1/checkout');
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(request.headers.accept, 'application/json');
    assert.equal(request.headers['content-type'], 'application/json');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), expected);
    json(response, 201, { saved: true });
  });
  const client = new ApiClient(origin, async () => TOKEN);
  assert.deepEqual(await client.request('/api/agent/reports/report-1/checkout', 'POST', expected), {
    saved: true,
  });
  assert.equal(calls, 1);
});

test('invalid destinations are rejected before requesting credentials or making a request', async (t) => {
  let requests = 0;
  let credentials = 0;
  const origin = await server(t, (_request, response) => {
    requests++;
    json(response, 200, {});
  });
  const client = new ApiClient(origin, async () => {
    credentials++;
    return TOKEN;
  });
  for (const path of [
    'https://example.com/api/agent/projects',
    '//example.com/api/agent/projects',
    '/api/projects',
    '/api/agent/projects#secret',
    '/api/agent/../settings',
    '/api/agent/%2e%2e/settings',
    '/api/agent/./projects',
    '/api/agent/reports/%2Foutside',
    '/api/agent/reports/%5Coutside',
  ]) {
    await assert.rejects(client.request(path), { code: 'invalid_destination' });
  }
  assert.equal(requests, 0);
  assert.equal(credentials, 0);
});

test('redirects are refused and neither credentials nor the untrusted redirect location enter the error', async (t) => {
  let redirectedRequests = 0;
  const destination = await server(t, (_request, response) => {
    redirectedRequests++;
    json(response, 200, {});
  });
  const origin = await server(t, (_request, response) => {
    response.writeHead(302, { Location: `${destination}/stolen?token=${TOKEN}` });
    response.end();
  });
  const client = new ApiClient(origin, async () => TOKEN);
  await assert.rejects(client.request('/api/agent/projects'), (error) => {
    assert.equal(error.code, 'connection_failed');
    assert.doesNotMatch(String(error), /fixture-access-token|stolen|127\.0\.0\.1/);
    return true;
  });
  assert.equal(redirectedRequests, 0);
});

test('HTTP errors use stable safe messages instead of server error bodies', async (t) => {
  const statuses = [
    [400, 1],
    [401, 3],
    [402, 1],
    [403, 4],
    [404, 1],
    [409, 5],
    [429, 1],
    [500, 1],
  ];
  let status = 400;
  const origin = await server(t, (_request, response) =>
    json(response, status, {
      error: `Bearer ${TOKEN}`,
      stack: '/private/customer/report.json',
      redirectUrl: 'https://attacker.example/steal',
    }),
  );
  const client = new ApiClient(origin, async () => TOKEN);
  for (const [httpStatus, exitCode] of statuses) {
    status = httpStatus;
    await assert.rejects(client.request('/api/agent/projects'), (error) => {
      assert.equal(error.code, `http_${httpStatus}`);
      assert.equal(error.exitCode, exitCode);
      assert.equal(error.status, httpStatus);
      assert.doesNotMatch(
        JSON.stringify(error) + String(error),
        /fixture-access-token|private\/customer|attacker\.example/,
      );
      return true;
    });
  }
});

test('unreadable JSON does not echo HTML or token-like response content', async (t) => {
  const origin = await server(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(`<html>${TOKEN}</html>`);
  });
  await assert.rejects(
    new ApiClient(origin, async () => TOKEN).request('/api/agent/projects'),
    (error) => {
      assert.equal(error.code, 'invalid_response');
      assert.doesNotMatch(String(error), /fixture-access-token|html/);
      return true;
    },
  );
});

test('non-JSON permission error bodies keep their safe HTTP error and exit status', async (t) => {
  const origin = await server(t, (_request, response) => {
    response.writeHead(401, { 'Content-Type': 'text/html' });
    response.end(`<html>${TOKEN}</html>`);
  });
  await assert.rejects(
    new ApiClient(origin, async () => TOKEN).request('/api/agent/projects'),
    (error) => {
      assert.equal(error.code, 'http_401');
      assert.equal(error.exitCode, 3);
      assert.doesNotMatch(String(error), /fixture-access-token|html/);
      return true;
    },
  );
});

test('JSON bodies over 8 MiB are rejected even without a declared Content-Length', async (t) => {
  const origin = await server(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('{"content":"');
    response.end('x'.repeat(8 * 1024 * 1024));
  });
  await assert.rejects(new ApiClient(origin, async () => TOKEN).request('/api/agent/projects'), {
    code: 'response_too_large',
  });
});

test('timeouts do not retry uncertain writes and tell callers to preserve their input and key', async (t) => {
  let calls = 0;
  const origin = await server(t, (_request, response) => {
    calls++;
    const timer = setTimeout(() => json(response, 200, { saved: true }), 1000);
    response.on('close', () => clearTimeout(timer));
  });
  await assert.rejects(
    new ApiClient(origin, async () => TOKEN, 250).request('/api/agent/audits', 'POST', {
      idempotencyKey: '10000000-0000-4000-8000-000000000001',
    }),
    (error) => {
      assert.equal(error.code, 'connection_failed');
      assert.match(error.message, /same input and idempotency key/i);
      assert.doesNotMatch(error.message, /fixture-access-token/);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test('PDF requests require both PDF media type and signature', async (t) => {
  let contentType = 'application/pdf';
  let content = '%PDF-1.7\nfixture';
  const origin = await server(t, (request, response) => {
    assert.equal(request.headers.accept, 'application/pdf');
    response.writeHead(200, { 'Content-Type': contentType });
    response.end(content);
  });
  const client = new ApiClient(origin, async () => TOKEN);
  assert.equal(
    Buffer.from(
      await client.request('/api/agent/reports/report-1/pdf?revision=2', 'GET', undefined, true),
    ).toString(),
    content,
  );
  contentType = 'text/html';
  await assert.rejects(
    client.request('/api/agent/reports/report-1/pdf?revision=2', 'GET', undefined, true),
    { code: 'invalid_response' },
  );
  contentType = 'application/pdf';
  content = 'not a PDF';
  await assert.rejects(
    client.request('/api/agent/reports/report-1/pdf?revision=2', 'GET', undefined, true),
    { code: 'invalid_response' },
  );
});

test('PDF responses over 32 MiB are rejected and PDF errors retain JSON permission semantics', async (t) => {
  let oversized = true;
  const origin = await server(t, (_request, response) => {
    if (!oversized) return json(response, 403, { error: TOKEN });
    response.writeHead(200, { 'Content-Type': 'application/pdf' });
    response.write('%PDF-1.7\n');
    response.end(Buffer.alloc(32 * 1024 * 1024));
  });
  const client = new ApiClient(origin, async () => TOKEN);
  await assert.rejects(
    client.request('/api/agent/reports/report-1/pdf?revision=2', 'GET', undefined, true),
    { code: 'response_too_large' },
  );
  oversized = false;
  await assert.rejects(
    client.request('/api/agent/reports/report-1/pdf?revision=2', 'GET', undefined, true),
    (error) => {
      assert.equal(error.code, 'http_403');
      assert.doesNotMatch(String(error), /fixture-access-token/);
      return true;
    },
  );
});
