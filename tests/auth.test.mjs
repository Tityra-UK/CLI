import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialStore } from '../dist/services/credentialStore.js';
import {
  authStatus,
  beginLoopbackAuthorization,
  DEFAULT_SCOPES,
  discoverAuthorizationServer,
  getAccessToken,
  login,
  logout,
  normalizeBaseUrl,
} from '../dist/services/authService.js';

const secret = (letter) => letter.repeat(43);
const code = secret('c');
async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'tityra-auth-'));
  const store = new CredentialStore(join(root, 'config'));
  const requests = [];
  let issuer;
  let metadata;
  const server = createServer(async (req, res) => {
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      requests.push({ path: req.url, method: req.method, headers: req.headers, body });
      if (req.url === '/.well-known/oauth-authorization-server') {
        const value = overrides.metadata ? overrides.metadata(metadata) : metadata;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(value));
        return;
      }
      if (req.url === '/register') {
        const input = JSON.parse(body);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            client_id: 'cli-fixture',
            token_endpoint_auth_method: 'none',
            redirect_uris: input.redirect_uris,
          }),
        );
        return;
      }
      if (overrides.handler && (await overrides.handler(req, res, body))) return;
      if (req.url === '/token') {
        const form = new URLSearchParams(body);
        if (form.get('grant_type') === 'authorization_code') {
          assert.equal(form.get('code'), code);
          assert.equal(form.get('resource'), issuer + '/mcp');
          const registration = JSON.parse(requests.find((r) => r.path === '/register').body);
          assert.equal(form.get('redirect_uri'), registration.redirect_uris[0]);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            access_token: secret('a'),
            refresh_token: secret('r'),
            token_type: 'Bearer',
            expires_in: 900,
            scope: (overrides.scopes || DEFAULT_SCOPES).join(' '),
            resource: issuer + '/mcp',
          }),
        );
        return;
      }
      if (req.url === '/revoke') {
        res.writeHead(200);
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    } catch {
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = 'http://127.0.0.1:' + server.address().port;
  metadata = {
    issuer,
    authorization_endpoint: issuer + '/authorize',
    token_endpoint: issuer + '/token',
    registration_endpoint: issuer + '/register',
    revocation_endpoint: issuer + '/revoke',
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [...DEFAULT_SCOPES, 'findings:challenge'],
  };
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    issuer,
    store,
    requests,
    options: { baseUrl: issuer, allowLocalhost: true, store, environmentToken: null },
    root,
  };
}
const saved = (issuer, changes = {}) => ({
  issuer,
  resource: issuer + '/mcp',
  clientId: 'cli-fixture',
  accessToken: secret('o'),
  refreshToken: secret('f'),
  expiresAt: new Date(Date.now() - 1000).toISOString(),
  scopes: [...DEFAULT_SCOPES],
  ...changes,
});
const callbackUrl = (authorization, changes = {}) => {
  const url = new URL(authorization);
  const callback = new URL(url.searchParams.get('redirect_uri'));
  for (const [key, value] of Object.entries({
    code,
    state: url.searchParams.get('state'),
    iss: url.origin,
    ...changes,
  }))
    callback.searchParams.set(key, value);
  return callback;
};

test('base URLs require HTTPS and loopback HTTP requires explicit opt-in', () => {
  assert.equal(normalizeBaseUrl(), 'https://app.tityra.com');
  assert.equal(normalizeBaseUrl('http://127.0.0.1:1234', true), 'http://127.0.0.1:1234');
  for (const url of [
    'http://127.0.0.1:1234',
    'http://evil.example',
    'https://user:pass@app.tityra.com',
    'https://app.tityra.com/path',
    'https://app.tityra.com?token=x',
    'file:///tmp',
  ])
    assert.throws(() => normalizeBaseUrl(url), /HTTPS/);
  assert.throws(() => normalizeBaseUrl('http://127.0.0.1.evil.example', true), /HTTPS/);
});

test('login registers exact ephemeral callback and exchanges S256 PKCE after explicit authorisation', async (t) => {
  const f = await fixture(t);
  let challenge;
  const result = await login({
    ...f.options,
    onAuthorize: async (value) => {
      const url = new URL(value);
      assert.equal(url.searchParams.get('resource'), f.issuer + '/mcp');
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      challenge = url.searchParams.get('code_challenge');
      assert.equal(new URL(url.searchParams.get('redirect_uri')).hostname, '127.0.0.1');
      assert.equal((await fetch(callbackUrl(value, { state: secret('z') }))).status, 400);
      assert.equal((await fetch(callbackUrl(value, { iss: 'https://evil.example' }))).status, 400);
      assert.equal((await fetch(callbackUrl(value, { state: 'é'.repeat(43) }))).status, 400);
      assert.equal((await fetch(callbackUrl(value))).status, 200);
    },
  });
  const tokenForm = new URLSearchParams(f.requests.find((r) => r.path === '/token').body);
  const registration = JSON.parse(f.requests.find((r) => r.path === '/register').body);
  assert.equal(registration.client_name, 'Tityra CLI');
  assert.equal(registration.application_type, 'native');
  assert.deepEqual(registration.redirect_uris, [tokenForm.get('redirect_uri')]);
  assert.equal(
    createHash('sha256').update(tokenForm.get('code_verifier')).digest('base64url'),
    challenge,
  );
  assert.deepEqual(result.scopes, [...DEFAULT_SCOPES]);
  assert.equal((await f.store.read(f.issuer)).accessToken, secret('a'));
  assert.equal(JSON.stringify(result).includes(secret('a')), false);
  assert.equal(f.requests.find((r) => r.path === '/token').headers.authorization, undefined);
});

test('loopback rejects malformed URLs, duplicate state and wrong methods without consuming the legitimate callback', async (t) => {
  const listener = await beginLoopbackAuthorization({
    state: secret('s'),
    issuer: 'https://app.tityra.com',
    timeoutMs: 1000,
  });
  t.after(listener.close);
  const url = new URL(listener.redirectUri);
  url.searchParams.set('state', secret('s'));
  url.searchParams.set('iss', 'https://app.tityra.com');
  url.searchParams.set('code', code);
  const malformedStatus = await new Promise((resolve, reject) => {
    let reply = '';
    const socket = connect(Number(url.port), '127.0.0.1', () =>
      socket.write('GET /\\[ HTTP/1.1\r\nHost: ' + url.host + '\r\nConnection: close\r\n\r\n'),
    );
    socket.setTimeout(1000, () => socket.destroy(new Error('Callback test socket timed out')));
    socket.on('data', (chunk) => {
      reply += chunk;
    });
    socket.on('end', () => resolve(reply.split('\r\n')[0]));
    socket.on('error', reject);
  });
  assert.equal(malformedStatus, 'HTTP/1.1 400 Bad Request');
  assert.equal((await fetch(url, { method: 'POST' })).status, 400);
  const duplicate = new URL(url);
  duplicate.searchParams.append('state', secret('s'));
  assert.equal((await fetch(duplicate)).status, 400);
  assert.equal((await fetch(url)).status, 200);
  assert.equal(await listener.code, code);
});

test('denial and timeout save no credentials or token grants', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    login({
      ...f.options,
      onAuthorize: async (value) => {
        const url = callbackUrl(value, { error: 'access_denied' });
        url.searchParams.delete('code');
        await fetch(url);
      },
    }),
    { code: 'access_denied' },
  );
  assert.equal(await f.store.read(f.issuer), undefined);
  await assert.rejects(login({ ...f.options, timeoutMs: 25, onAuthorize: () => {} }), {
    code: 'authorization_timeout',
  });
  assert.equal(
    f.requests.some((r) => r.path === '/token'),
    false,
  );
});

test('discovery refuses issuer mismatch and foreign endpoints before sending credentials', async (t) => {
  const f = await fixture(t, {
    metadata: (metadata) => ({ ...metadata, token_endpoint: 'https://evil.example/token' }),
  });
  await assert.rejects(discoverAuthorizationServer(f.issuer, true), { code: 'invalid_metadata' });
  assert.equal(f.requests.length, 1);
  const g = await fixture(t, {
    metadata: (metadata) => ({ ...metadata, issuer: 'https://evil.example' }),
  });
  await assert.rejects(discoverAuthorizationServer(g.issuer, true), { code: 'invalid_metadata' });
});

test('refresh rotation is serialized and concurrent callers reuse the one new access token', async (t) => {
  const f = await fixture(t);
  await f.store.write(saved(f.issuer));
  const values = await Promise.all([1, 2, 3].map(() => getAccessToken(f.options)));
  assert.deepEqual(values, [secret('a'), secret('a'), secret('a')]);
  const refreshes = f.requests.filter((r) => r.path === '/token');
  assert.equal(refreshes.length, 1);
  const form = new URLSearchParams(refreshes[0].body);
  assert.equal(form.get('refresh_token'), secret('f'));
  assert.equal(form.get('resource'), f.issuer + '/mcp');
  assert.equal((await f.store.read(f.issuer)).refreshToken, secret('r'));
});

test('uncertain refresh is not retried or replayed and error bodies never leak', async (t) => {
  const f = await fixture(t, {
    handler: async (req, res) => {
      if (req.url !== '/token') return false;
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error_description: 'sensitive-server-response' }));
      return true;
    },
  });
  await f.store.write(saved(f.issuer));
  await assert.rejects(
    getAccessToken(f.options),
    (error) =>
      error.code === 'oauth_request_failed' && !error.message.includes('sensitive-server-response'),
  );
  assert.equal((await f.store.read(f.issuer)).refreshToken, undefined);
  await assert.rejects(getAccessToken(f.options), { code: 'reauthorization_required' });
  assert.equal(f.requests.filter((r) => r.path === '/token').length, 1);
});

for (const status of [400, 401]) {
  test(`rejected refresh HTTP ${status} requires new authorisation without retaining or replaying the old token`, async (t) => {
    const f = await fixture(t, {
      handler: async (req, res) => {
        if (req.url !== '/token') return false;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ error: 'invalid_grant', error_description: 'private-grant-details' }),
        );
        return true;
      },
    });
    await f.store.write(saved(f.issuer));
    await assert.rejects(
      getAccessToken(f.options),
      (error) =>
        error.code === 'reauthorization_required' &&
        error.status === status &&
        !error.message.includes('private-grant-details'),
    );
    assert.equal((await f.store.read(f.issuer)).refreshToken, undefined);
    await assert.rejects(getAccessToken(f.options), { code: 'reauthorization_required' });
    assert.equal(f.requests.filter((r) => r.path === '/token').length, 1);
  });
}

test('CI token bypasses disk and discovery and auth status never exposes it', async (t) => {
  const f = await fixture(t);
  const options = { ...f.options, environmentToken: 'ci-secret' };
  assert.equal(await getAccessToken(options), 'ci-secret');
  const status = await authStatus(options);
  assert.deepEqual(status, { authenticated: true, source: 'environment', issuer: f.issuer });
  assert.equal(f.requests.length, 0);
  await assert.rejects(getAccessToken({ ...options, environmentToken: 'bad\nsecret' }), {
    code: 'invalid_environment_token',
  });
  await assert.rejects(fs.stat(f.store.directory), { code: 'ENOENT' });
});

test('logout revokes only saved CLI grant and preserves other issuer and environment tokens', async (t) => {
  const f = await fixture(t);
  await f.store.write(saved(f.issuer));
  await f.store.write(saved('https://other.example'));
  assert.deepEqual(await logout({ ...f.options, environmentToken: 'external-ci-token' }), {
    revoked: true,
  });
  const form = new URLSearchParams(f.requests.find((r) => r.path === '/revoke').body);
  assert.equal(form.get('token'), secret('f'));
  assert.equal(form.get('client_id'), 'cli-fixture');
  assert.equal(await f.store.read(f.issuer), undefined);
  assert.ok(await f.store.read('https://other.example'));
  assert.deepEqual(await logout(f.options), { revoked: false });
});

test('failed logout retains saved credentials and status stays secret-free', async (t) => {
  const f = await fixture(t, {
    handler: async (req, res) => {
      if (req.url !== '/revoke') return false;
      res.writeHead(500);
      res.end('secret');
      return true;
    },
  });
  await f.store.write(saved(f.issuer));
  await assert.rejects(logout(f.options), /retained/);
  assert.ok(await f.store.read(f.issuer));
  const status = await authStatus(f.options);
  assert.equal(status.source, 'stored');
  assert.equal(status.authenticated, true);
  assert.equal(JSON.stringify(status).includes(secret('f')), false);
});
