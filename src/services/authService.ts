import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { CredentialStore, type StoredCredentials } from './credentialStore.js';

export const DEFAULT_BASE_URL = 'https://app.tityra.com';
export const DEFAULT_SCOPES = [
  'projects:read',
  'audits:read',
  'reports:read',
  'findings:read',
  'discussions:read',
  'billing:read',
] as const;
export class AuthError extends Error {
  constructor(
    message: string,
    readonly code = 'authentication_error',
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}
export interface AuthOptions {
  baseUrl?: string;
  /** Only set when the user explicitly selected a loopback --base-url. */
  allowLocalhost?: boolean;
  store?: CredentialStore;
  environmentToken?: string | null;
}
export interface AuthStatus {
  authenticated: boolean;
  source: 'environment' | 'stored' | 'none';
  issuer: string;
  scopes?: string[];
  expiresAt?: string;
}
interface Metadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  revocation_endpoint: string;
  scopes_supported: string[];
}
type JsonRecord = Record<string, unknown>;
const record = (v: unknown): v is JsonRecord =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const opaque = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 8192 &&
  /^[A-Za-z0-9._~+/-]+=*$/.test(value);
const loopback = (hostname: string) => ['127.0.0.1', 'localhost', '[::1]'].includes(hostname);

export function normalizeBaseUrl(value = DEFAULT_BASE_URL, allowLocalhost = false): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AuthError('The base URL must be an HTTPS origin.', 'invalid_base_url');
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && allowLocalhost && loopback(url.hostname)))
  ) {
    throw new AuthError(
      'Use an HTTPS origin, or explicitly select an HTTP loopback base URL for local development.',
      'invalid_base_url',
    );
  }
  return url.origin;
}

function endpoint(value: unknown, issuer: string): string {
  if (typeof value !== 'string')
    throw new AuthError('The authorisation server metadata is invalid.', 'invalid_metadata');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AuthError('The authorisation server metadata is invalid.', 'invalid_metadata');
  }
  if (url.origin !== issuer || url.username || url.password || url.hash)
    throw new AuthError(
      'OAuth endpoints must belong to the selected Tityra server.',
      'invalid_metadata',
    );
  return url.href;
}

async function jsonRequest(
  url: string,
  init: RequestInit = {},
  operation = 'authorisation',
): Promise<JsonRecord> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      redirect: 'error',
      credentials: 'omit',
      signal: init.signal || AbortSignal.timeout(15000),
    });
  } catch {
    throw new AuthError(
      `The ${operation} request could not be completed. No automatic retry was made.`,
      'network_error',
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new AuthError(
      `The Tityra server rejected the ${operation} request (HTTP ${response.status}).`,
      'oauth_request_failed',
      response.status,
    );
  }
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    await response.body?.cancel();
    throw new AuthError(
      'The Tityra server returned an invalid OAuth response.',
      'invalid_response',
    );
  }
  const reader = response.body?.getReader();
  if (!reader)
    throw new AuthError('The Tityra server returned an empty OAuth response.', 'invalid_response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) {
        await reader.cancel();
        throw new AuthError('The OAuth response exceeded the size limit.', 'invalid_response');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError(
      'The OAuth response could not be read. No automatic retry was made.',
      'network_error',
    );
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (record(value)) return value;
  } catch {
    /* never include response bodies in errors */
  }
  throw new AuthError('The Tityra server returned an invalid OAuth response.', 'invalid_response');
}

export async function discoverAuthorizationServer(
  baseUrl = DEFAULT_BASE_URL,
  allowLocalhost = false,
): Promise<Metadata> {
  const issuer = normalizeBaseUrl(baseUrl, allowLocalhost);
  const metadata = await jsonRequest(
    issuer + '/.well-known/oauth-authorization-server',
    {},
    'discovery',
  );
  if (
    metadata.issuer !== issuer ||
    !Array.isArray(metadata.code_challenge_methods_supported) ||
    !metadata.code_challenge_methods_supported.includes('S256') ||
    !Array.isArray(metadata.token_endpoint_auth_methods_supported) ||
    !metadata.token_endpoint_auth_methods_supported.includes('none') ||
    !Array.isArray(metadata.scopes_supported) ||
    metadata.scopes_supported.length > 64 ||
    metadata.scopes_supported.some(
      (v) => typeof v !== 'string' || !/^[a-z][a-z0-9:_-]{0,99}$/.test(v),
    )
  ) {
    throw new AuthError(
      'This server does not advertise the required public-client PKCE flow.',
      'invalid_metadata',
    );
  }
  return {
    issuer,
    authorization_endpoint: endpoint(metadata.authorization_endpoint, issuer),
    token_endpoint: endpoint(metadata.token_endpoint, issuer),
    registration_endpoint: endpoint(metadata.registration_endpoint, issuer),
    revocation_endpoint: endpoint(metadata.revocation_endpoint, issuer),
    scopes_supported: metadata.scopes_supported as string[],
  };
}

export interface LoopbackAuthorization {
  redirectUri: string;
  code: Promise<string>;
  close: () => void;
}

/** Bind only IPv4 loopback, use an OS-assigned port, and validate issuer and state before consuming a callback. */
export async function beginLoopbackAuthorization(options: {
  state: string;
  issuer: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<LoopbackAuthorization> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(options.state))
    throw new AuthError('Invalid authorisation state.', 'invalid_state');
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  void code.catch(() => undefined); // A callback may fail before the caller starts awaiting it.
  let finished = false;
  let redirectUri = '';
  const server = createServer((request, response) => {
    const reply = (status: number, message: string) => {
      response.writeHead(status, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(message);
    };
    if (
      !redirectUri ||
      request.method !== 'GET' ||
      request.headers.host !== new URL(redirectUri).host ||
      !request.url?.startsWith('/') ||
      request.url.startsWith('//')
    ) {
      reply(400, 'Invalid callback request.');
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url, redirectUri);
    } catch {
      reply(400, 'Invalid callback URL.');
      return;
    }
    if (
      url.origin !== new URL(redirectUri).origin ||
      url.pathname !== '/oauth/callback' ||
      url.hash
    ) {
      reply(404, 'Not found.');
      return;
    }
    for (const key of url.searchParams.keys())
      if (url.searchParams.getAll(key).length !== 1) {
        reply(400, 'Duplicate callback parameters.');
        return;
      }
    const state = url.searchParams.get('state') || '';
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(state) ||
      !timingSafeEqual(Buffer.from(state), Buffer.from(options.state)) ||
      url.searchParams.get('iss') !== options.issuer
    ) {
      reply(400, 'Callback state or issuer did not match.');
      return;
    }
    if (finished) {
      reply(410, 'This callback has already been used.');
      return;
    }
    if (url.searchParams.has('error')) {
      reply(200, 'Authorisation was not completed. Return to your terminal.');
      finish(
        new AuthError(
          'Authorisation was denied or cancelled. No credentials were saved.',
          'access_denied',
        ),
      );
      return;
    }
    const value = url.searchParams.get('code');
    if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
      reply(400, 'Invalid authorisation code.');
      return;
    }
    reply(
      200,
      'Tityra authorisation received. You can close this window and return to your terminal.',
    );
    finish(undefined, value);
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  const abort = () =>
    finish(new AuthError('Authorisation was cancelled.', 'authorization_cancelled'));
  function finish(error?: Error, value?: string) {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    server.close();
    server.closeIdleConnections();
    if (error) rejectCode(error);
    else resolveCode(value!);
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', () =>
      reject(
        new AuthError('The local OAuth callback listener could not be started.', 'callback_error'),
      ),
    );
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new AuthError(
      'The local OAuth callback listener could not be started.',
      'callback_error',
    );
  }
  redirectUri = `http://127.0.0.1:${address.port}/oauth/callback`;
  const timer = setTimeout(
    () =>
      finish(
        new AuthError('Authorisation timed out. Run login to try again.', 'authorization_timeout'),
      ),
    options.timeoutMs ?? 180000,
  );
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  return { redirectUri, code, close: abort };
}

function tokenCredentials(
  value: JsonRecord,
  issuer: string,
  clientId: string,
  scopes: string[],
): StoredCredentials {
  if (
    !opaque(value.access_token) ||
    !opaque(value.refresh_token) ||
    value.token_type !== 'Bearer' ||
    typeof value.expires_in !== 'number' ||
    !Number.isSafeInteger(value.expires_in) ||
    value.expires_in < 1 ||
    value.expires_in > 86400 ||
    typeof value.scope !== 'string' ||
    value.resource !== issuer + '/mcp'
  )
    throw new AuthError(
      'The server returned invalid token credentials. Sign in again.',
      'invalid_response',
    );
  const granted = [...new Set(value.scope.split(/\s+/).filter(Boolean))];
  if (granted.length !== scopes.length || granted.some((scope) => !scopes.includes(scope)))
    throw new AuthError(
      'The granted permissions did not match the authorisation request.',
      'invalid_scope',
    );
  return {
    issuer,
    resource: issuer + '/mcp',
    clientId,
    accessToken: value.access_token,
    refreshToken: value.refresh_token,
    expiresAt: new Date(Date.now() + value.expires_in * 1000).toISOString(),
    scopes: granted,
  };
}
const postForm = (body: URLSearchParams): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
  body,
});

export async function login(
  options: AuthOptions & {
    scopes?: readonly string[];
    onAuthorize?: (url: string) => void | Promise<void>;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<{ issuer: string; scopes: string[]; expiresAt: string }> {
  const metadata = await discoverAuthorizationServer(options.baseUrl, options.allowLocalhost);
  const scopes = [...new Set(options.scopes || DEFAULT_SCOPES)];
  if (!scopes.length || scopes.some((scope) => !metadata.scopes_supported.includes(scope)))
    throw new AuthError('Request one or more supported OAuth permissions.', 'invalid_scope');
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(32).toString('base64url');
  const callback = await beginLoopbackAuthorization({
    state,
    issuer: metadata.issuer,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
  try {
    const client = await jsonRequest(
      metadata.registration_endpoint,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          client_name: 'Tityra CLI',
          application_type: 'native',
          redirect_uris: [callback.redirectUri],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
        }),
      },
      'client registration',
    );
    if (
      typeof client.client_id !== 'string' ||
      !/^[A-Za-z0-9._~-]{1,200}$/.test(client.client_id) ||
      client.token_endpoint_auth_method !== 'none' ||
      !Array.isArray(client.redirect_uris) ||
      client.redirect_uris.length !== 1 ||
      client.redirect_uris[0] !== callback.redirectUri
    )
      throw new AuthError(
        'The server returned invalid client registration metadata.',
        'invalid_response',
      );
    const url = new URL(metadata.authorization_endpoint);
    for (const [key, value] of Object.entries({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: callback.redirectUri,
      scope: scopes.join(' '),
      resource: metadata.issuer + '/mcp',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      state,
    }))
      url.searchParams.set(key, value);
    if (options.onAuthorize) await options.onAuthorize(url.href);
    else
      process.stderr.write(`Open this URL in your browser to authorise Tityra CLI:\n${url.href}\n`);
    const code = await callback.code;
    const tokens = await jsonRequest(
      metadata.token_endpoint,
      postForm(
        new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: client.client_id,
          code,
          redirect_uri: callback.redirectUri,
          code_verifier: verifier,
          resource: metadata.issuer + '/mcp',
        }),
      ),
      'token exchange',
    );
    const credentials = tokenCredentials(tokens, metadata.issuer, client.client_id, scopes);
    await (options.store || new CredentialStore()).write(credentials);
    return {
      issuer: credentials.issuer,
      scopes: credentials.scopes,
      expiresAt: credentials.expiresAt,
    };
  } finally {
    callback.close();
  }
}

function environmentToken(options: AuthOptions): string | undefined {
  const token =
    options.environmentToken === null
      ? undefined
      : (options.environmentToken ?? process.env.TITYRA_ACCESS_TOKEN);
  if (token === undefined) return undefined;
  if (!opaque(token))
    throw new AuthError(
      'TITYRA_ACCESS_TOKEN is empty or contains invalid characters.',
      'invalid_environment_token',
    );
  return token;
}

export async function getAccessToken(options: AuthOptions = {}): Promise<string> {
  const issuer = normalizeBaseUrl(options.baseUrl, options.allowLocalhost);
  const environment = environmentToken(options);
  if (environment) return environment;
  const store = options.store || new CredentialStore();
  return store.withLock(issuer, async (locked) => {
    const saved = await locked.read(issuer);
    if (!saved)
      throw new AuthError(
        'Sign in with tityra auth login, or set TITYRA_ACCESS_TOKEN for CI.',
        'not_authenticated',
      );
    if (Date.parse(saved.expiresAt) > Date.now() + 30000) return saved.accessToken;
    if (!saved.refreshToken)
      throw new AuthError(
        'This connection cannot be refreshed safely. Run tityra auth login again.',
        'reauthorization_required',
      );
    const metadata = await discoverAuthorizationServer(issuer, options.allowLocalhost);
    const refreshToken = saved.refreshToken;
    // Persist before sending: after a lost response, replaying this rotating token could revoke the grant family.
    const pending = { ...saved };
    delete pending.refreshToken;
    await locked.write(pending);
    let tokens: JsonRecord;
    try {
      tokens = await jsonRequest(
        metadata.token_endpoint,
        postForm(
          new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: saved.clientId,
            refresh_token: refreshToken,
            resource: saved.resource,
          }),
        ),
        'token refresh',
      );
    } catch (error) {
      if (
        error instanceof AuthError &&
        error.code === 'oauth_request_failed' &&
        (error.status === 400 || error.status === 401)
      ) {
        throw new AuthError(
          'This connection expired or was revoked. Run tityra auth login again.',
          'reauthorization_required',
          error.status,
        );
      }
      throw error;
    }
    const refreshed = tokenCredentials(tokens, issuer, saved.clientId, saved.scopes);
    await locked.write(refreshed);
    return refreshed.accessToken;
  });
}

export async function authStatus(options: AuthOptions = {}): Promise<AuthStatus> {
  const issuer = normalizeBaseUrl(options.baseUrl, options.allowLocalhost);
  if (environmentToken(options)) return { authenticated: true, source: 'environment', issuer };
  const saved = await (options.store || new CredentialStore()).read(issuer);
  if (!saved) return { authenticated: false, source: 'none', issuer };
  return {
    authenticated: Date.parse(saved.expiresAt) > Date.now() || Boolean(saved.refreshToken),
    source: 'stored',
    issuer,
    scopes: saved.scopes,
    expiresAt: saved.expiresAt,
  };
}

/** Revoke only this issuer's persisted CLI grant; environment credentials are never revoked. */
export async function logout(options: AuthOptions = {}): Promise<{ revoked: boolean }> {
  const issuer = normalizeBaseUrl(options.baseUrl, options.allowLocalhost);
  const store = options.store || new CredentialStore();
  return store.withLock(issuer, async (locked) => {
    const saved = await locked.read(issuer);
    if (!saved) return { revoked: false };
    const metadata = await discoverAuthorizationServer(issuer, options.allowLocalhost);
    let response: Response;
    try {
      response = await fetch(metadata.revocation_endpoint, {
        ...postForm(
          new URLSearchParams({
            client_id: saved.clientId,
            token: saved.refreshToken || saved.accessToken,
            token_type_hint: saved.refreshToken ? 'refresh_token' : 'access_token',
          }),
        ),
        redirect: 'error',
        credentials: 'omit',
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new AuthError(
        'The connection could not be revoked. Credentials were retained so you can retry logout.',
        'network_error',
      );
    }
    await response.body?.cancel();
    if (!response.ok)
      throw new AuthError(
        'The server did not confirm revocation. Credentials were retained so you can retry logout.',
        'oauth_request_failed',
        response.status,
      );
    await locked.remove(issuer);
    return { revoked: true };
  });
}
