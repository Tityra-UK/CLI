import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Command } from 'commander';
import { registerProjectsCommands } from '../dist/commands/projects.js';
import { validateWrite } from '../dist/schema/writeSchema.js';
import { ApiClient } from '../dist/services/apiClient.js';
import { DEFAULT_SCOPES } from '../dist/services/authService.js';

const input = {
  action: 'disable',
  expectedRevision: 1,
  idempotencyKey: '10000000-0000-4000-8000-000000000001',
};

function command(api) {
  const output = [];
  const program = new Command().exitOverride();
  registerProjectsCommands(program, () => ({
    api,
    output: (value) => output.push(value),
    run: (_label, work) => work(),
  }));
  return { output, run: (args) => program.parseAsync(args, { from: 'user' }) };
}

async function inputFile(t, body = input) {
  const directory = await mkdtemp(join(tmpdir(), 'tityra-monitoring-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'monitoring.json');
  await writeFile(file, JSON.stringify(body));
  return file;
}

test('monitoring reads use the selected project API path and preserve the complete view', async () => {
  const calls = [];
  const view = { projectId: 'project-1', revision: 0, status: 'disabled', history: [] };
  const cli = command({ request: async (...args) => (calls.push(args), view) });
  await cli.run(['projects', 'monitoring', 'get', 'project-1']);
  assert.deepEqual(calls, [['/api/agent/projects/project-1/monitoring']]);
  assert.deepEqual(cli.output, [view]);
  await assert.rejects(cli.run(['projects', 'monitoring', 'get', '../other']));
  assert.equal(calls.length, 1);
});

test('confirmed monitoring pauses PATCH only the exact reviewed revision and action key', async (t) => {
  const file = await inputFile(t);
  const calls = [];
  const view = { revision: 2, status: 'paused' };
  const cli = command({ request: async (...args) => (calls.push(args), view) });
  await assert.rejects(cli.run(['projects', 'monitoring', 'update', 'project-1', '--input', file]));
  assert.equal(calls.length, 0);
  await cli.run(['projects', 'monitoring', 'update', 'project-1', '--input', file, '--yes']);
  assert.deepEqual(calls, [['/api/agent/projects/project-1/monitoring', 'PATCH', input]]);
  assert.deepEqual(cli.output, [view]);
});

test('monitoring input rejects approval, enablement and unsupported fields before transport', () => {
  for (const change of [
    { action: 'approve' },
    { action: 'enable', authorityReference: 'not a staff review' },
    { billingAccountId: 'other-payer' },
    { pageLimit: 5000 },
    { plan: 'human' },
    { expectedRevision: -1 },
    { expectedRevision: 1.5 },
    { expectedRevision: '1' },
    { authorisation: false },
    { authorisation: undefined },
    { expectedWebsite: undefined },
    { auditScope: undefined },
    { expectedWebsite: 'file:///private/account' },
    { expectedWebsite: 'https://user:secret@example.test/' },
    { idempotencyKey: '' },
    { auditScope: { mode: 'website', urls: ['https://example.test/'] } },
    { auditScope: { mode: 'specific_urls', urls: [] } },
    { action: { toString: () => 'disable' } },
  ]) {
    assert.throws(
      () => validateWrite('monitoring', { ...input, ...change }),
      undefined,
      JSON.stringify(change),
    );
  }
  assert.equal(validateWrite('monitoring', input), input);
});

test('legacy monitoring enablement directs the customer to recurring credit approval without transport', async (t) => {
  const file = await inputFile(t, {
    ...input,
    action: 'enable',
    authorisation: true,
    expectedWebsite: 'https://example.test/',
    auditScope: { mode: 'website' },
  });
  let calls = 0;
  const cli = command({ request: async () => calls++ });
  await assert.rejects(
    cli.run(['projects', 'monitoring', 'update', 'project-1', '--input', file, '--yes']),
    (error) => {
      assert.equal(error.code, 'invalid_arguments');
      assert.equal(error.exitCode, 2);
      assert.match(error.message, /Enable or resume monitoring in Tityra/);
      assert.match(error.message, /recurring organisation credit budget/);
      return true;
    },
  );
  assert.equal(calls, 0);
});

test('pause input retains revision zero and rejects hidden scope or consent changes', () => {
  const pause = { action: 'disable', expectedRevision: 0, idempotencyKey: input.idempotencyKey };
  assert.equal(validateWrite('monitoring', pause), pause);
  for (const change of [
    { authorisation: true },
    { expectedWebsite: 'https://example.test/' },
    { auditScope: { mode: 'website' } },
  ])
    assert.throws(() => validateWrite('monitoring', { ...pause, ...change }));
  assert.equal(DEFAULT_SCOPES.includes('monitoring:write'), false);
});

test('uncertain monitoring writes never retry automatically and an explicit retry retains identical bytes', async (t) => {
  const file = await inputFile(t);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url: String(url), ...options });
    if (requests.length === 1) throw new Error('Isolated transport interruption');
    return Response.json({ revision: 1, status: 'active' });
  });
  const cli = command(new ApiClient('https://app.tityra.com', async () => 'fixture-secret'));
  const args = ['projects', 'monitoring', 'update', 'project-1', '--input', file, '--yes'];
  await assert.rejects(cli.run(args), (error) => {
    assert.equal(error.code, 'connection_failed');
    assert.match(error.message, /SAME input and idempotency key/);
    assert.doesNotMatch(error.message, /fixture-secret/);
    return true;
  });
  assert.equal(requests.length, 1);
  await cli.run(args);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body, requests[1].body);
  assert.deepEqual(JSON.parse(requests[1].body), input);
  assert.equal(requests[1].method, 'PATCH');
  assert.equal(requests[1].headers.Authorization, 'Bearer fixture-secret');
  assert.equal(requests[1].redirect, 'error');
});

test('monitoring entitlement and revision errors stay safe and never retry the write', async (t) => {
  let status = 402;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return Response.json({ error: 'private provider details' }, { status });
  });
  const api = new ApiClient('https://app.tityra.com', async () => 'fixture-secret');
  await assert.rejects(
    api.request('/api/agent/projects/project-1/monitoring', 'PATCH', input),
    (error) => {
      assert.equal(error.code, 'http_402');
      assert.match(error.message, /organisation credit budget and current access/);
      assert.doesNotMatch(error.message, /subscription/);
      assert.doesNotMatch(error.message, /private provider details/);
      return true;
    },
  );
  status = 409;
  await assert.rejects(
    api.request('/api/agent/projects/project-1/monitoring', 'PATCH', input),
    (error) => {
      assert.equal(error.exitCode, 5);
      assert.match(error.message, /latest revision/);
      return true;
    },
  );
  assert.equal(calls, 2);
});
