import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CredentialStore,
  WindowsDpapiProtection,
  windowsDpapiCommand,
  acquireCredentialFileLock,
  CredentialError,
} from '../dist/services/credentialStore.js';
import { randomBytes } from 'node:crypto';

const profile = (issuer = 'https://app.tityra.com') => ({
  issuer,
  resource: issuer + '/mcp',
  clientId: 'cli-client',
  accessToken: 'access-secret',
  refreshToken: 'refresh-secret',
  expiresAt: new Date(Date.now() + 900000).toISOString(),
  scopes: ['projects:read'],
});

test('Windows sharing errors retry inspection until an exclusive open succeeds', async () => {
  const failures = ['EPERM', 'EACCES', 'EEXIST'];
  const handle = Symbol('exclusive file handle');
  let attempts = 0;
  let inspected = 0;
  let paused = 0;
  const result = await acquireCredentialFileLock(
    async () => {
      const code = failures[attempts++];
      if (code) throw Object.assign(new Error('simulated contention'), { code });
      return handle;
    },
    async () => {
      inspected++;
    },
    {
      platform: 'win32',
      now: () => 0,
      pause: async () => {
        paused++;
      },
    },
  );
  assert.equal(result, handle);
  assert.equal(attempts, 4);
  assert.equal(inspected, 3);
  assert.equal(paused, 3);
});

test('permanent Windows denial and disappearing locks remain bounded without granting ownership', async () => {
  for (const code of ['EPERM', 'EACCES', 'EEXIST']) {
    let clock = 0;
    let attempts = 0;
    let inspected = 0;
    await assert.rejects(
      acquireCredentialFileLock(
        async () => {
          attempts++;
          throw Object.assign(new Error('simulated unavailable lock'), { code });
        },
        async () => {
          inspected++;
        },
        {
          platform: 'win32',
          now: () => clock,
          pause: async () => {
            clock += 15000;
          },
        },
      ),
      /Another Tityra process/,
    );
    assert.equal(attempts, 2);
    assert.equal(inspected, 2);
    assert.equal(clock, 30000);
  }
});

test('POSIX permission errors and unsafe existing locks are never accepted as contention ownership', async () => {
  let inspections = 0;
  await assert.rejects(
    acquireCredentialFileLock(
      async () => {
        throw Object.assign(new Error('simulated denied permission'), { code: 'EPERM' });
      },
      async () => {
        inspections++;
      },
      { platform: 'linux' },
    ),
    /could not be acquired safely/,
  );
  assert.equal(inspections, 0);
  await assert.rejects(
    acquireCredentialFileLock(
      async () => {
        throw Object.assign(new Error('simulated sharing violation'), { code: 'EACCES' });
      },
      async () => {
        throw new CredentialError('The credentials lock is unsafe.');
      },
      { platform: 'win32' },
    ),
    /lock is unsafe/,
  );
});
async function fixture(t) {
  const root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'tityra-credentials-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return {
    root,
    directory: join(root, 'config'),
    store: new CredentialStore(join(root, 'config')),
  };
}

test('credentials use private permissions, atomic replacement and issuer-bound profiles', async (t) => {
  const { store, directory } = await fixture(t);
  assert.equal(await store.read('https://app.tityra.com'), undefined);
  await store.write(profile());
  const other = profile('https://other.example');
  await store.write(other);
  assert.deepEqual(await store.read(other.issuer), other);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(store.path)).mode & 0o777, 0o600);
  }
  await store.write({ ...profile(), accessToken: 'new-access' });
  assert.equal((await store.read('https://app.tityra.com')).accessToken, 'new-access');
  await store.remove('https://app.tityra.com');
  assert.equal(await store.read('https://app.tityra.com'), undefined);
  assert.deepEqual(await store.read(other.issuer), other);
  assert.deepEqual(await fs.readdir(directory), ['credentials.json']);
});

test('credential writes across independent stores are serialized without losing profiles', async (t) => {
  const { directory } = await fixture(t);
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      new CredentialStore(directory).write(profile(`https://account-${i}.example`)),
    ),
  );
  for (let i = 0; i < 8; i++)
    assert.ok(await new CredentialStore(directory).read(`https://account-${i}.example`));
  let active = 0;
  await Promise.all(
    [1, 2, 3].map(() =>
      new CredentialStore(directory).withLock('https://app.tityra.com', async () => {
        active++;
        assert.equal(active, 1);
        await new Promise((resolve) => setTimeout(resolve, 15));
        active--;
      }),
    ),
  );
});

test('credentials reject symlink files, directories and ancestor directories', async (t) => {
  const { root, store, directory } = await fixture(t);
  await fs.mkdir(directory, { mode: 0o700 });
  const target = join(root, 'target');
  await fs.writeFile(target, 'untouched', { mode: 0o600 });
  await fs.symlink(target, store.path);
  await assert.rejects(store.read('https://app.tityra.com'), /safely/);
  await assert.rejects(store.write(profile()), /safely/);
  assert.equal(await fs.readFile(target, 'utf8'), 'untouched');
  const link = join(root, 'link');
  await fs.symlink(directory, link);
  await assert.rejects(new CredentialStore(link).write(profile()), /symbolic links/);
  await assert.rejects(new CredentialStore(join(link, 'child')).write(profile()), /symbolic links/);
});

test('credentials reject hard links, permissive files, malformed records and cross-issuer resources', async (t) => {
  const { store, directory, root } = await fixture(t);
  await store.write(profile());
  await fs.link(store.path, join(root, 'hardlink'));
  await assert.rejects(store.read('https://app.tityra.com'), /private/);
  await fs.unlink(join(root, 'hardlink'));
  if (process.platform !== 'win32') {
    await fs.chmod(store.path, 0o644);
    await assert.rejects(store.read('https://app.tityra.com'), /private/);
    await fs.chmod(store.path, 0o600);
    await fs.chmod(directory, 0o755);
    await assert.rejects(store.read('https://app.tityra.com'), /0700/);
    await fs.chmod(directory, 0o700);
  }
  await fs.writeFile(store.path, '{"accessToken":"do-not-echo-this"');
  await assert.rejects(
    store.read('https://app.tityra.com'),
    (error) => !error.message.includes('do-not-echo-this') && /invalid/.test(error.message),
  );
  await assert.rejects(
    store.write({ ...profile(), resource: 'https://evil.example/mcp' }),
    /invalid/,
  );
  await assert.rejects(store.write({ ...profile(), accessToken: 'secret\nheader' }), /invalid/);
});

test('unsafe locks and relative config paths are refused', async (t) => {
  const { root, directory, store } = await fixture(t);
  assert.throws(() => new CredentialStore('.tityra'), /absolute/);
  await fs.mkdir(directory, { mode: 0o700 });
  const target = join(root, 'target-lock');
  await fs.writeFile(target, 'untouched', { mode: 0o600 });
  await fs.symlink(target, join(directory, 'credentials.lock'));
  await assert.rejects(store.write(profile()), /unsafe/);
  assert.equal(await fs.readFile(target, 'utf8'), 'untouched');
});

test('Windows DPAPI uses fixed CurrentUser scripts with credentials on stdin only', async () => {
  const input = 'secret\'\";$(not-code)\n' + profile().refreshToken;
  const calls = [];
  const ciphertext = randomBytes(64).toString('base64');
  const protection = new WindowsDpapiProtection({
    systemRoot: 'C:\\Windows',
    run: async (command, value) => {
      calls.push({ command, value });
      return command.args.at(-1).includes('::Protect(') ? ciphertext : input;
    },
  });
  assert.equal(await protection.protect(input), ciphertext);
  assert.equal(await protection.unprotect(ciphertext), input);
  for (const { command } of calls) {
    assert.equal(
      command.executable,
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    );
    assert.ok(command.args.includes('-NoProfile'));
    assert.ok(command.args.includes('-NonInteractive'));
    assert.equal(
      command.args.some((argument) => argument.includes(input)),
      false,
    );
    assert.match(command.args.at(-1), /DataProtectionScope\]::CurrentUser/);
    assert.match(command.args.at(-1), /Microsoft\.PowerShell\.Utility\\Add-Type/);
    assert.doesNotMatch(command.args.at(-1), /LocalMachine|Invoke-Expression/);
  }
  assert.equal(calls[0].value, input);
  assert.equal(calls[1].value, ciphertext);
  assert.throws(() => windowsDpapiCommand('protect', '\\\\untrusted\\share'), /unavailable/);
  assert.throws(() => windowsDpapiCommand('protect', '.\\Windows'), /unavailable/);
});

test('encrypted store preserves protection through locks and never persists plaintext credentials', async (t) => {
  const { directory } = await fixture(t);
  const credentials = profile();
  // Simulate the user-bound OS boundary: another user's helper cannot decrypt the ciphertext.
  const encryptedValues = new Map();
  const protection = new WindowsDpapiProtection({
    systemRoot: 'C:\\Windows',
    run: async (command, input) => {
      if (command.args.at(-1).includes('::Protect(')) {
        const ciphertext = randomBytes(64).toString('base64');
        encryptedValues.set(ciphertext, input);
        return ciphertext;
      }
      if (!encryptedValues.has(input)) throw new Error('wrong user or tampered data');
      return encryptedValues.get(input);
    },
  });
  const store = new CredentialStore({ directory, protection });
  await store.write(credentials);
  const raw = await fs.readFile(store.path, 'utf8');
  assert.equal(raw.includes(credentials.accessToken), false);
  assert.equal(raw.includes(credentials.refreshToken), false);
  assert.equal(raw.includes(credentials.issuer), false);
  const envelope = JSON.parse(raw);
  assert.equal(envelope.protection, 'windows-dpapi-current-user');
  assert.deepEqual(await store.read(credentials.issuer), credentials);
  const otherUser = new CredentialStore({
    directory,
    protection: new WindowsDpapiProtection({
      systemRoot: 'C:\\Windows',
      run: async () => {
        throw new Error('cannot decrypt secret');
      },
    }),
  });
  await assert.rejects(otherUser.read(credentials.issuer), /current Windows user/);
  await store.remove(credentials.issuer);
  assert.equal(await store.read(credentials.issuer), undefined);
  assert.equal((await fs.readFile(store.path, 'utf8')).includes('profiles'), false);
});

test('DPAPI helper failure has no plaintext fallback or sensitive error output', async (t) => {
  const { directory } = await fixture(t);
  const protection = new WindowsDpapiProtection({
    systemRoot: 'C:\\Windows',
    run: async () => {
      throw new Error('sensitive-child-output');
    },
  });
  const store = new CredentialStore({ directory, protection });
  await assert.rejects(
    store.write(profile()),
    (error) =>
      /Nothing was stored in plaintext/.test(error.message) &&
      !error.message.includes('sensitive-child-output'),
  );
  await assert.rejects(fs.stat(store.path), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(directory), []);
  await fs.writeFile(
    store.path,
    JSON.stringify({ version: 1, profiles: { [profile().issuer]: profile() } }),
    { mode: 0o600 },
  );
  await assert.rejects(store.read(profile().issuer), /current-user encryption/);
  await assert.rejects(protection.unprotect('invalid;notbase64'), /invalid/);
});

test(
  'native Windows DPAPI roundtrip rejects ciphertext tampering',
  { skip: process.platform !== 'win32' },
  async () => {
    const protection = new WindowsDpapiProtection();
    const plaintext = JSON.stringify({
      secret: randomBytes(32).toString('base64url'),
      unicode: 'Tityra Doğu',
    });
    const ciphertext = await protection.protect(plaintext);
    assert.notEqual(ciphertext, plaintext);
    assert.equal(await protection.unprotect(ciphertext), plaintext);
    const tampered = Buffer.from(ciphertext, 'base64');
    tampered[Math.floor(tampered.length / 2)] ^= 1;
    await assert.rejects(
      protection.unprotect(tampered.toString('base64')),
      /could not be decrypted/,
    );
  },
);
