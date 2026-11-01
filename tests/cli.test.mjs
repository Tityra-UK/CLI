import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const TOKEN = 'fixture-cli-access-token-never-print';
const KEY = '10000000-0000-4000-8000-000000000001';

async function fixture(t, handler) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'tityra-cli-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const requests = [];
  const instance = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const recorded = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: body ? JSON.parse(body) : undefined,
    };
    requests.push(recorded);
    if (handler) return handler(recorded, response);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({ projects: [{ id: 'project-fixture', name: 'Fixture project' }] }),
    );
  });
  instance.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(async () => {
    instance.closeAllConnections();
    await new Promise((resolve) => instance.close(resolve));
  });
  return { directory, requests, origin: `http://127.0.0.1:${instance.address().port}` };
}

async function run(context, args, input = '', extraEnvironment = {}, json = true) {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith('TITYRA_') && key !== 'NODE_OPTIONS',
    ),
  );
  const child = spawn(
    process.execPath,
    [
      CLI,
      ...(json ? ['--json'] : []),
      '--base-url',
      context.origin,
      '--config-dir',
      join(context.directory, 'config'),
      ...args,
    ],
    {
      cwd: context.directory,
      env: { ...environment, TITYRA_ACCESS_TOKEN: TOKEN, ...extraEnvironment },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10_000,
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (value) => {
    stdout += value;
  });
  child.stderr.on('data', (value) => {
    stderr += value;
  });
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  const [code, signal] = await once(child, 'close');
  assert.equal(signal, null, `CLI was interrupted: ${stderr}`);
  return { code, stdout, stderr };
}

function safeError(result, exitCode = 2) {
  assert.equal(result.code, exitCode, result.stderr);
  assert.equal(result.stdout, '');
  const error = JSON.parse(result.stderr);
  assert.equal(typeof error, 'object');
  assert.doesNotMatch(result.stderr, /fixture-cli-access-token|Bearer\s|\n\s+at\s/);
  return error;
}

test('projects list produces exactly one JSON value on stdout and uses the authenticated account route', async (t) => {
  const context = await fixture(t);
  const result = await run(context, ['projects', 'list']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(JSON.stringify(JSON.parse(result.stdout)), /project-fixture/);
  assert.doesNotMatch(result.stdout, /fixture-cli-access-token/);
  assert.equal(context.requests.length, 1);
  assert.equal(context.requests[0].url, '/api/agent/projects');
  assert.equal(context.requests[0].headers.authorization, `Bearer ${TOKEN}`);
});

test('unknown commands and flags fail as JSON errors without contacting the server', async (t) => {
  const context = await fixture(t);
  for (const args of [
    ['projects', 'list', '--unknown-flag'],
    ['missing-command'],
    ['projects', 'missing-action'],
  ]) {
    safeError(await run(context, args));
  }
  assert.equal(context.requests.length, 0);
});

test('writes require both explicit --yes and valid --input before any request', async (t) => {
  const context = await fixture(t);
  const input = join(context.directory, 'request.json');
  await writeFile(
    input,
    JSON.stringify({
      projectId: 'project-fixture',
      plan: 'free',
      authorisation: true,
      idempotencyKey: KEY,
    }),
  );
  safeError(await run(context, ['audits', 'create', '--input', input]));
  safeError(await run(context, ['audits', 'create', '--yes']));
  safeError(
    await run(context, [
      'audits',
      'create',
      '--yes',
      '--input',
      join(context.directory, 'missing.json'),
    ]),
    1,
  );
  await writeFile(input, '{malformed');
  safeError(await run(context, ['audits', 'create', '--yes', '--input', input]));
  safeError(await run(context, ['audits', 'create', '--yes', '--input', '-'], '[]'));
  assert.equal(context.requests.length, 0);
});

test(
  'special file input is rejected without waiting for a FIFO writer or making an API request',
  { skip: process.platform === 'win32' },
  async (t) => {
    const context = await fixture(t);
    const input = join(context.directory, 'request.fifo');
    execFileSync('mkfifo', [input]);
    safeError(await run(context, ['audits', 'create', '--yes', '--input', input]));
    assert.equal(context.requests.length, 0);
  },
);

test('oversized file and stdin inputs fail before making an account request', async (t) => {
  const context = await fixture(t);
  const input = join(context.directory, 'oversized.json');
  const content = JSON.stringify({ notes: 'x'.repeat(64 * 1024) });
  await writeFile(input, content);
  safeError(await run(context, ['audits', 'create', '--yes', '--input', input]));
  safeError(await run(context, ['audits', 'create', '--yes', '--input', '-'], content));
  assert.equal(context.requests.length, 0);
});

test('human output falls back to complete JSON for malformed list rows instead of crashing', async (t) => {
  const body = { projects: [null, 17, ['unexpected'], { id: 'project-fixture', name: 'Fixture' }] };
  const context = await fixture(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  const result = await run(context, ['projects', 'list'], '', {}, false);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), body);
});

test('human output safely formats object cells and removes directional terminal controls', async (t) => {
  let body = { projects: [{ id: 'project-fixture', name: { toString: null } }] };
  const context = await fixture(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  const table = await run(context, ['projects', 'list'], '', {}, false);
  assert.equal(table.code, 0, table.stderr);
  assert.match(table.stdout, /toString/);
  body = { projects: [{ description: 'Untrusted \u202ehidden\u2066 direction' }] };
  const fallback = await run(context, ['projects', 'list'], '', {}, false);
  assert.equal(fallback.code, 0, fallback.stderr);
  assert.doesNotMatch(fallback.stdout, /[\u001b\u202e\u2066]/);
});

test('human table sizing handles a large bounded response without an argument-count overflow', async (t) => {
  const context = await fixture(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({ projects: Array.from({ length: 150_000 }, () => ({ id: 'x' })) }),
    );
  });
  const result = await run(context, ['projects', 'list'], '', {}, false);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /ID/);
  assert.equal(result.stdout.split('\n').filter((line) => line === 'x').length, 150_000);
});

test('audit creation preserves the caller-supplied UUID and body for file and stdin inputs', async (t) => {
  const context = await fixture(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ submitted: true, requestId: 'request-fixture' }));
  });
  const body = {
    projectId: 'project-fixture',
    plan: 'free',
    authorisation: true,
    idempotencyKey: KEY,
    auditScope: { mode: 'website' },
  };
  const input = join(context.directory, 'request.json');
  await writeFile(input, JSON.stringify(body));
  for (const [path, stdin] of [
    [input, ''],
    ['-', JSON.stringify(body)],
  ]) {
    const result = await run(context, ['audits', 'create', '--yes', '--input', path], stdin);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.match(JSON.stringify(JSON.parse(result.stdout)), /request-fixture/);
  }
  assert.equal(context.requests.length, 2);
  for (const request of context.requests) {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/api/agent/audits');
    assert.deepEqual(request.body, body);
  }
});

test('missing or invalid write idempotency keys are rejected instead of generated', async (t) => {
  const context = await fixture(t);
  for (const idempotencyKey of [
    undefined,
    '',
    'not-a-uuid',
    '10000000-0000-1000-8000-000000000001',
  ]) {
    const body = {
      projectId: 'project-fixture',
      plan: 'free',
      authorisation: true,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    };
    safeError(
      await run(context, ['audits', 'create', '--yes', '--input', '-'], JSON.stringify(body)),
    );
  }
  assert.equal(context.requests.length, 0);
});

test('write input cannot omit concurrency guards or supply staff-only fields', async (t) => {
  const context = await fixture(t);
  const cases = [
    {
      args: ['audits', 'create'],
      body: {
        projectId: 'project-fixture',
        plan: 'free',
        authorisation: false,
        idempotencyKey: KEY,
      },
    },
    {
      args: ['findings', 'challenge', 'report-fixture', 'finding-fixture'],
      body: {
        reason: 'false_positive',
        body: 'Already present.',
        expectedReportRevision: 0,
        idempotencyKey: KEY,
      },
    },
    {
      args: ['findings', 'remediate', 'report-fixture', 'finding-fixture'],
      body: {
        status: 'resolved',
        reason: 'Customer-reported implementation.',
        expectedReportRevision: 2,
        idempotencyKey: KEY,
      },
    },
    {
      args: ['discussions', 'reply', 'report-fixture', 'finding-fixture', 'thread-fixture'],
      body: { body: 'The template was updated.', expectedReportRevision: 2, idempotencyKey: KEY },
    },
    {
      args: ['discussions', 'create', 'report-fixture', 'finding-fixture'],
      body: {
        body: 'Please clarify the page scope.',
        expectedReportRevision: 2,
        privateStaffNote: 'Not a customer-editable field.',
        idempotencyKey: KEY,
      },
    },
  ];
  for (const item of cases) {
    safeError(
      await run(context, [...item.args, '--yes', '--input', '-'], JSON.stringify(item.body)),
    );
  }
  assert.equal(context.requests.length, 0);
});

test('API permission errors use JSON stderr, mapped exit status and no untrusted error details', async (t) => {
  const context = await fixture(t, (_request, response) => {
    response.writeHead(403, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        error: TOKEN,
        stack: '/private/customer/notes',
        redirectUrl: 'https://attacker.example',
      }),
    );
  });
  const result = await run(context, ['projects', 'list']);
  safeError(result, 4);
  assert.doesNotMatch(result.stderr, /private\/customer|attacker\.example/);
  assert.equal(context.requests.length, 1);
});

test('read commands map positional IDs and project filters to the documented account endpoints', async (t) => {
  const context = await fixture(t);
  const cases = [
    {
      args: ['projects', 'monitoring', 'get', 'project-fixture'],
      path: '/api/agent/projects/project-fixture/monitoring',
    },
    {
      args: ['audits', 'options', '--project', 'project-fixture'],
      path: '/api/agent/audits/options',
      project: 'project-fixture',
    },
    {
      args: ['audits', 'list', '--project', 'project-fixture'],
      path: '/api/agent/audits',
      project: 'project-fixture',
    },
    { args: ['audits', 'get', 'audit-fixture'], path: '/api/agent/audits/audit-fixture' },
    {
      args: ['audits', 'payment', 'audit-fixture'],
      path: '/api/agent/audits/audit-fixture/payment',
    },
    { args: ['reports', 'get', 'report-fixture'], path: '/api/agent/reports/report-fixture' },
    {
      args: ['findings', 'list', 'report-fixture'],
      path: '/api/agent/reports/report-fixture/findings',
    },
    {
      args: ['discussions', 'list', 'report-fixture', 'FND:metadata.v2'],
      path: '/api/agent/reports/report-fixture/findings/FND%3Ametadata.v2/discussions',
    },
  ];
  for (const item of cases) {
    const result = await run(context, item.args);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    JSON.parse(result.stdout);
    const request = context.requests.at(-1);
    const url = new URL(request.url, context.origin);
    assert.equal(request.method, 'GET');
    assert.equal(url.pathname, item.path);
    if (item.project) assert.equal(url.searchParams.get('projectId'), item.project);
  }
  assert.equal(context.requests.length, cases.length);
});

test('monitoring, finding, discussion and checkout mutations preserve their exact method, revisions and stable body', async (t) => {
  const context = await fixture(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ saved: true }));
  });
  const report = 'report-fixture';
  const finding = 'FND:metadata.v2';
  const base = '/api/agent/reports/report-fixture/findings/FND%3Ametadata.v2';
  const cases = [
    {
      args: ['projects', 'monitoring', 'update', 'project-fixture'],
      method: 'PATCH',
      path: '/api/agent/projects/project-fixture/monitoring',
      body: {
        action: 'enable',
        expectedRevision: 0,
        expectedWebsite: 'https://example.test/',
        authorisation: true,
        auditScope: { mode: 'website' },
        idempotencyKey: KEY,
      },
    },
    {
      args: ['projects', 'monitoring', 'update', 'project-fixture'],
      method: 'PATCH',
      path: '/api/agent/projects/project-fixture/monitoring',
      body: { action: 'disable', expectedRevision: 3, idempotencyKey: KEY },
    },
    {
      args: ['reports', 'checkout', report],
      method: 'POST',
      path: '/api/agent/reports/report-fixture/checkout',
      body: { idempotencyKey: KEY },
    },
    {
      args: ['findings', 'challenge', report, finding],
      method: 'POST',
      path: `${base}/challenge`,
      body: {
        reason: 'false_positive',
        body: 'The published page already contains this metadata.',
        expectedReportRevision: 2,
        idempotencyKey: KEY,
      },
    },
    {
      args: ['findings', 'remediate', report, finding],
      method: 'PATCH',
      path: `${base}/remediation`,
      body: {
        status: 'in_progress',
        reason: 'Implementation underway',
        expectedReportRevision: 2,
        expectedTrackingRevision: 3,
        idempotencyKey: KEY,
      },
    },
    {
      args: ['discussions', 'create', report, finding],
      method: 'POST',
      path: `${base}/discussions`,
      body: {
        body: 'Does this also apply to archived pages?',
        expectedReportRevision: 2,
        idempotencyKey: KEY,
      },
    },
    {
      args: ['discussions', 'reply', report, finding, 'thread-fixture'],
      method: 'POST',
      path: `${base}/discussions/thread-fixture/replies`,
      body: {
        body: 'The archived pages use the same template.',
        expectedReportRevision: 2,
        expectedThreadRevision: 3,
        idempotencyKey: KEY,
      },
    },
  ];
  for (const item of cases) {
    const result = await run(
      context,
      [...item.args, '--yes', '--input', '-'],
      JSON.stringify(item.body),
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    JSON.parse(result.stdout);
    const request = context.requests.at(-1);
    assert.equal(request.method, item.method);
    assert.equal(request.url, item.path);
    assert.deepEqual(request.body, item.body);
  }
  assert.equal(context.requests.length, cases.length);
});

test('pagination and finding filters use the API query names and reject values outside its bounds', async (t) => {
  const context = await fixture(t);
  const result = await run(context, [
    'findings',
    'list',
    'report-fixture',
    '--page',
    '2',
    '--page-size',
    '100',
    '--severity',
    'high',
    '--status',
    'open',
  ]);
  assert.equal(result.code, 0, result.stderr);
  const query = new URL(context.requests[0].url, context.origin).searchParams;
  assert.deepEqual(Object.fromEntries(query), {
    page: '2',
    pageSize: '100',
    severity: 'high',
    status: 'open',
  });
  for (const flags of [
    ['--page', '0'],
    ['--page', '10000'],
    ['--page-size', '101'],
    ['--severity', 'urgent'],
    ['--status', 'verified'],
  ]) {
    safeError(await run(context, ['findings', 'list', 'report-fixture', ...flags]));
  }
  assert.equal(context.requests.length, 1);
});

test('path, query and dot-segment resource IDs cannot escape the account endpoint prefix', async (t) => {
  const context = await fixture(t);
  for (const id of [
    '.',
    '..',
    '../outside',
    'report/one',
    'report?x=1',
    'report#fragment',
    '%2e%2e',
  ]) {
    safeError(await run(context, ['reports', 'get', id]));
  }
  assert.equal(context.requests.length, 0);
});

test('PDF download saves the selected revision and never overwrites an existing file', async (t) => {
  const pdf = '%PDF-1.7\nsynthetic fixture\n%%EOF';
  const context = await fixture(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/pdf' });
    response.end(pdf);
  });
  const output = join(context.directory, 'report.pdf');
  const result = await run(context, [
    'reports',
    'download',
    'report-fixture',
    '--revision',
    '2',
    '--output',
    output,
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  JSON.parse(result.stdout);
  assert.equal(await readFile(output, 'utf8'), pdf);
  if (process.platform !== 'win32') assert.equal((await stat(output)).mode & 0o077, 0);
  const request = context.requests[0];
  assert.equal(
    new URL(request.url, context.origin).pathname,
    '/api/agent/reports/report-fixture/pdf',
  );
  assert.equal(new URL(request.url, context.origin).searchParams.get('revision'), '2');
  assert.equal(request.headers.accept, 'application/pdf');
  const second = await run(context, [
    'reports',
    'download',
    'report-fixture',
    '--revision',
    '2',
    '--output',
    output,
  ]);
  assert.notEqual(second.code, 0, second.stdout);
  assert.equal(second.stdout, '');
  JSON.parse(second.stderr);
  assert.equal(await readFile(output, 'utf8'), pdf);
});

test('a denied PDF download removes its newly created empty destination', async (t) => {
  const context = await fixture(t, (_request, response) => {
    response.writeHead(403, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'Not permitted' }));
  });
  const output = join(context.directory, 'denied.pdf');
  safeError(
    await run(context, [
      'reports',
      'download',
      'report-fixture',
      '--revision',
      '2',
      '--output',
      output,
    ]),
    4,
  );
  await assert.rejects(stat(output), { code: 'ENOENT' });
});

test('PDF authentication failure keeps its authentication exit code and removes the empty file', async (t) => {
  const context = await fixture(t);
  const output = join(context.directory, 'unauthenticated.pdf');
  const result = await run(
    context,
    ['reports', 'download', 'report-fixture', '--revision', '2', '--output', output],
    '',
    { TITYRA_ACCESS_TOKEN: undefined },
  );
  safeError(result, 3);
  assert.match(result.stderr, /not_authenticated/);
  await assert.rejects(stat(output), { code: 'ENOENT' });
  assert.equal(context.requests.length, 0);
});

test('PDF download requires a positive exact revision and output path before making a request', async (t) => {
  const context = await fixture(t);
  for (const flags of [
    [],
    ['--revision', '2'],
    ['--output', join(context.directory, 'report.pdf')],
    ['--revision', '0', '--output', join(context.directory, 'report.pdf')],
  ]) {
    safeError(await run(context, ['reports', 'download', 'report-fixture', ...flags]));
  }
  assert.equal(context.requests.length, 0);
});

test('environment authentication status is credential-free and logout does not revoke an unrelated environment grant', async (t) => {
  const context = await fixture(t);
  const status = await run(context, ['auth', 'status']);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(status.stderr, '');
  const statusBody = JSON.parse(status.stdout);
  assert.equal(statusBody.authenticated, true);
  assert.equal(statusBody.source, 'environment');
  assert.doesNotMatch(status.stdout, /fixture-cli-access-token/);
  const logout = await run(context, ['auth', 'logout']);
  assert.equal(logout.code, 0, logout.stderr);
  assert.equal(JSON.parse(logout.stdout).revoked, false);
  assert.equal(context.requests.length, 0);
});
