import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runWorkspace } from '../dist/services/workspaceService.js';
import { CliError } from '../dist/services/errors.js';

test('the real bare CLI returns only local status with piped stdio and optional --json', async (t) => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'tityra-workspace-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith('TITYRA_') && key !== 'NODE_OPTIONS',
    ),
  );
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  // Port 1 is not a usable Fetch destination. A network-based startup would fail
  // instead of returning the expected local status; no fixture API is needed.
  const baseUrl = 'http://127.0.0.1:1';
  for (const token of [undefined, 'fixture-workspace-token-never-print']) {
    for (const flags of [[], ['--json']]) {
      const result = spawnSync(
        process.execPath,
        [
          cli,
          '--base-url',
          baseUrl,
          '--config-dir',
          join(directory, 'config'),
          '--timeout',
          '1000',
          ...flags,
        ],
        {
          env: { ...environment, ...(token ? { TITYRA_ACCESS_TOKEN: token } : {}) },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 5000,
        },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.deepEqual(JSON.parse(result.stdout), {
        authenticated: Boolean(token),
        source: token ? 'environment' : 'none',
        issuer: baseUrl,
      });
      assert.doesNotMatch(
        result.stdout,
        /fixture-workspace-token|Select a project|Sign in with your browser/,
      );
    }
  }
});

const issuer = 'https://app.example';
const project = { id: 'project-1', name: 'Example project', website: 'https://example.com' };

function fixture({
  authenticated = true,
  source = 'stored',
  interactive = true,
  json = false,
  choices = [],
  respond,
  loginError,
} = {}) {
  let status = { authenticated, source, issuer };
  const calls = { paths: [], output: [], prompts: [], text: [], logins: 0, banners: 0 };
  const context = {
    auth: { baseUrl: issuer },
    api: {
      async request(path, method = 'GET') {
        calls.paths.push(path);
        assert.equal(method, 'GET', 'Workspace navigation never writes account data');
        return respond ? respond(path, calls.paths.length) : { projects: [project] };
      },
    },
    output(value) {
      calls.output.push(value);
    },
    async run(_label, work) {
      return work();
    },
  };
  const environment = {
    interactive,
    async status() {
      return status;
    },
    async login() {
      calls.logins++;
      if (loginError) throw loginError;
      status = { authenticated: true, source: 'stored', issuer };
    },
    banner() {
      calls.banners++;
      return 'TITYRA\n';
    },
    write(value) {
      calls.text.push(value);
    },
    async choose(message, options) {
      calls.prompts.push({ message, options });
      assert.ok(choices.length, `Unexpected prompt: ${message}`);
      const choice = choices.shift();
      if (choice !== undefined)
        assert.ok(
          options.some((option) => option.value === choice),
          `Missing choice ${choice}: ${message}`,
        );
      return choice;
    },
  };
  return { calls, run: () => runWorkspace(context, '1.0.0', { json }, environment) };
}

test('non-TTY and JSON startup only return local status without network, banner, login or prompts', async () => {
  for (const settings of [{ interactive: false }, { interactive: true, json: true }]) {
    const f = fixture({ ...settings, authenticated: false, source: 'none' });
    await f.run();
    assert.deepEqual(f.calls.output, [{ authenticated: false, source: 'none', issuer }]);
    assert.deepEqual(f.calls.paths, []);
    assert.deepEqual(f.calls.prompts, []);
    assert.equal(f.calls.logins, 0);
    assert.equal(f.calls.banners, 0);
  }
});

test('signed-out startup offers sign-in and validates the new session before opening a project', async () => {
  const f = fixture({
    authenticated: false,
    source: 'none',
    choices: ['signin', 'project:0', 'exit'],
  });
  await f.run();
  assert.equal(f.calls.logins, 1);
  assert.equal(f.calls.banners, 1);
  assert.deepEqual(f.calls.paths, ['/api/agent/projects']);
});

test('signed-out exit and cancelled browser consent leave without API calls', async () => {
  for (const settings of [
    { choices: ['exit'] },
    { choices: ['signin'], loginError: { code: 'authorization_cancelled' } },
    { choices: ['signin'], loginError: { code: 'access_denied' } },
  ]) {
    const f = fixture({ authenticated: false, source: 'none', ...settings });
    await f.run();
    assert.deepEqual(f.calls.paths, []);
  }
});

test('a revoked or unrefreshable stored session offers renewal then validates projects again', async () => {
  for (const failure of [
    new CliError('http_401', 'Expired', 3, 401),
    new CliError('reauthorization_required', 'Reconnect', 3),
  ]) {
    const f = fixture({
      choices: ['signin', 'exit'],
      respond(_path, count) {
        if (count === 1) throw failure;
        return { projects: [project] };
      },
    });
    await f.run();
    assert.equal(f.calls.logins, 1);
    assert.deepEqual(f.calls.paths, ['/api/agent/projects', '/api/agent/projects']);
  }
});

test('environment-token rejection cannot be overridden by browser login', async () => {
  const f = fixture({
    source: 'environment',
    respond() {
      throw new CliError('http_401', 'Expired', 3, 401);
    },
  });
  await assert.rejects(f.run(), { code: 'environment_token_rejected', exitCode: 3 });
  assert.equal(f.calls.logins, 0);
  assert.deepEqual(f.calls.prompts, []);
});

test('forbidden and unavailable resources never trigger a browser-login loop', async () => {
  for (const status of [403, 429, 500]) {
    const failure = new CliError(`http_${status}`, 'Unavailable', 1, status);
    const f = fixture({
      respond() {
        throw failure;
      },
    });
    await assert.rejects(f.run(), (error) => error === failure);
    assert.equal(f.calls.logins, 0);
    assert.deepEqual(f.calls.prompts, []);
  }
});

test('recent audits use the report ID returned by status for report and finding reads', async () => {
  const f = fixture({
    choices: [
      'project:0',
      'audits',
      'request:0',
      'status',
      'report',
      'findings',
      'payment',
      'back',
      'back',
      'exit',
    ],
    respond(path) {
      if (path === '/api/agent/projects') return { projects: [project] };
      if (path.startsWith('/api/agent/audits?'))
        return { requests: [{ id: 'audit-1', status: 'review' }] };
      if (path === '/api/agent/audits/audit-1')
        return { request: { id: 'audit-1', status: 'completed', reportId: 'report-distinct' } };
      return { read: true };
    },
  });
  await f.run();
  assert.deepEqual(f.calls.paths, [
    '/api/agent/projects',
    '/api/agent/audits?projectId=project-1&page=1&pageSize=25',
    '/api/agent/audits/audit-1',
    '/api/agent/reports/report-distinct',
    '/api/agent/reports/report-distinct/findings?page=1&pageSize=25',
    '/api/agent/audits/audit-1/payment',
    '/api/agent/audits?projectId=project-1&page=1&pageSize=25',
  ]);
  const firstAuditMenu = f.calls.prompts.find((prompt) => prompt.message.startsWith('Audit '));
  assert.equal(firstAuditMenu.message, 'Audit audit-1: review');
  assert.equal(
    firstAuditMenu.options.some((option) => option.value === 'report'),
    false,
  );
});

test('recent audit choices preserve included pricing only when returned by the server', async () => {
  const f = fixture({
    choices: ['project:0', 'audits', 'back', 'exit'],
    respond(path) {
      if (path === '/api/agent/projects') return { projects: [project] };
      return {
        requests: [
          {
            id: 'audit-weekly',
            packageName: 'Customer · title',
            plan: 'automated',
            status: 'queued',
            pricingStatus: 'included',
          },
          {
            id: 'audit-extra',
            plan: 'automated',
            status: 'queued',
            pricingStatus: 'quote_required',
          },
          { id: 'audit-redacted', plan: 'automated', status: 'queued' },
        ],
      };
    },
  });
  await f.run();
  const menu = f.calls.prompts.find((prompt) => prompt.message.startsWith('Recent audits'));
  assert.equal(menu.message, 'Recent audits: page 1');
  assert.equal(menu.options[0].title, 'Customer · title: queued');
  assert.equal(menu.options[1].title, 'audit-extra: queued');
  assert.equal(menu.options[0].description, 'Pricing: included');
  assert.equal(menu.options[1].description, 'Pricing: quote_required');
  assert.equal(menu.options[2].description, '');
  assert.equal(f.calls.logins, 0);
});

test('project switching, options and local connection status keep the workspace open', async () => {
  const f = fixture({
    choices: ['project:0', 'options', 'switch', 'project:1', 'options', 'status', 'exit'],
    respond(path) {
      return path === '/api/agent/projects'
        ? { projects: [project, { ...project, id: 'project-2' }] }
        : { available: true };
    },
  });
  await f.run();
  assert.deepEqual(f.calls.paths, [
    '/api/agent/projects',
    '/api/agent/audits/options?projectId=project-1',
    '/api/agent/audits/options?projectId=project-2',
  ]);
  assert.equal(f.calls.output.at(-1).source, 'stored');
});

test('weekly monitoring reads only the selected project and preserves the server schedule without new consent', async () => {
  const monitoring = {
    projectId: 'project-2',
    revision: 3,
    enabled: true,
    status: 'active',
    canManage: false,
    nextScheduledAt: '2026-11-04T10:15:00.000Z',
    history: [{ cycleId: 'cycle-1', requestId: 'audit-1', status: 'queued' }],
  };
  const f = fixture({
    choices: ['project:1', 'monitoring', 'exit'],
    respond(path) {
      if (path === '/api/agent/projects')
        return { projects: [project, { ...project, id: 'project-2' }] };
      assert.equal(path, '/api/agent/projects/project-2/monitoring');
      return monitoring;
    },
  });
  await f.run();
  assert.deepEqual(f.calls.paths, [
    '/api/agent/projects',
    '/api/agent/projects/project-2/monitoring',
  ]);
  assert.deepEqual(f.calls.output, [monitoring]);
  assert.equal(f.calls.logins, 0);
});

test('server menu text is sanitized and invalid project references never become API paths', async () => {
  const f = fixture({
    choices: ['project:0'],
    respond() {
      return {
        projects: [
          {
            id: '../outside',
            name: '\u001b[31mspoof\u202e',
            website: 'https://example.com\nInjected',
          },
        ],
      };
    },
  });
  await assert.rejects(f.run(), { code: 'invalid_response' });
  assert.deepEqual(f.calls.paths, ['/api/agent/projects']);
  assert.doesNotMatch(JSON.stringify(f.calls.prompts), /\\u001b|\\u202e|\\nInjected/);
});

test('cancelling any nested prompt cleanly exits the entire workspace', async () => {
  const f = fixture({
    choices: ['project:0', 'audits', undefined],
    respond(path) {
      return path === '/api/agent/projects' ? { projects: [project] } : { requests: [] };
    },
  });
  await f.run();
  assert.equal(f.calls.prompts.length, 3);
  assert.equal(f.calls.logins, 0);
});
