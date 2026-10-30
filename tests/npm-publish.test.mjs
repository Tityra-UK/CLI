import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { registryPublishDecision } from '../scripts/prepare-npm-publish.mjs';

const pkg = { name: '@tityra/cli', version: '1.0.0' };
const artifact = {
  ...pkg,
  filename: 'tityra-cli-1.0.0.tgz',
  integrity: 'sha512-' + Buffer.alloc(64, 1).toString('base64'),
};
const response = (status, body) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });

const sri = (bytes) => 'sha512-' + createHash('sha512').update(bytes).digest('base64');
const canonicalTarball = 'https://registry.npmjs.org/@tityra/cli/-/cli-1.0.0.tgz';
function archive(entries = [{ name: 'package/dist/cli.js', mode: 0o755, body: 'safe' }]) {
  const parts = [];
  for (const { name, mode = 0o755, body = 'safe', mtime = 499162500 } of entries) {
    const content = Buffer.from(body);
    const header = Buffer.alloc(512);
    header.write(name);
    for (const [offset, size, value] of [
      [100, 8, mode],
      [108, 8, 0],
      [116, 8, 0],
      [124, 12, content.length],
      [136, 12, mtime],
    ])
      header.write(value.toString(8).padStart(size - 1, '0') + '\0', offset, size);
    header.fill(32, 148, 156);
    header.write('0', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    header.write(
      [...header]
        .reduce((sum, byte) => sum + byte, 0)
        .toString(8)
        .padStart(6, '0') + '\0 ',
      148,
      8,
    );
    parts.push(header, content, Buffer.alloc((512 - (content.length % 512)) % 512));
  }
  return Buffer.concat([...parts, Buffer.alloc(1024)]);
}
function gzipFixture({
  localRaw = archive(),
  remoteRaw = localRaw,
  remoteBytes,
  remoteIntegrity,
  tarball = canonicalTarball,
  headers = {},
  downloadStatus = 200,
  finalUrl = canonicalTarball,
} = {}) {
  const local = gzipSync(localRaw, { level: 1 });
  const remote = remoteBytes || gzipSync(remoteRaw, { level: 9 });
  const metadata = { ...artifact, integrity: sri(local) };
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1)
      return response(200, {
        ...pkg,
        dist: { integrity: remoteIntegrity || sri(remote), tarball },
      });
    const downloaded = new Response(remote, { status: downloadStatus, headers });
    Object.defineProperty(downloaded, 'url', { value: finalUrl });
    return downloaded;
  };
  return {
    calls,
    run: () => registryPublishDecision(pkg, metadata, fetcher, { localTarball: local }),
  };
}

test('only an exact-version 404 allows publishing and the registry lookup cannot redirect', async () => {
  const decision = await registryPublishDecision(pkg, artifact, async (url, options) => {
    assert.equal(url, 'https://registry.npmjs.org/%40tityra%2Fcli/1.0.0');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return response(404);
  });
  assert.equal(decision, true);
});

test('an already published version is skipped only when name, version and integrity all match', async () => {
  assert.equal(
    await registryPublishDecision(pkg, artifact, async () =>
      response(200, { ...pkg, dist: { integrity: artifact.integrity } }),
    ),
    false,
  );
  for (const published of [
    { ...pkg, dist: { integrity: 'different' } },
    { ...pkg },
    { ...pkg, version: '1.0.1', dist: { integrity: artifact.integrity } },
  ]) {
    await assert.rejects(
      registryPublishDecision(pkg, artifact, async () => response(200, published)),
      /does not match/,
    );
  }
});

test('registry failures, redirects and invalid JSON never become permission to publish', async () => {
  for (const status of [301, 401, 403, 429, 500]) {
    await assert.rejects(
      registryPublishDecision(pkg, artifact, async () => response(status)),
      /Registry lookup failed/,
    );
  }
  await assert.rejects(
    registryPublishDecision(pkg, artifact, async () => {
      throw new Error('network failure');
    }),
    /network failure/,
  );
  await assert.rejects(
    registryPublishDecision(
      pkg,
      artifact,
      async () => new Response('invalid JSON', { status: 200 }),
    ),
  );
});

test('unsafe filenames and unexpected package metadata fail before any registry request', async () => {
  let calls = 0;
  for (const invalid of [
    { ...artifact, filename: '../package.tgz' },
    { ...artifact, filename: 'other.tgz' },
    { ...artifact, name: '@other/cli' },
    { ...artifact, version: '9.0.0' },
    { ...artifact, integrity: 'invalid' },
  ]) {
    await assert.rejects(
      registryPublishDecision(pkg, invalid, async () => {
        calls++;
        return response(404);
      }),
      /Invalid package/,
    );
  }
  assert.equal(calls, 0);
  const version = pkg.version + '\n';
  await assert.rejects(
    registryPublishDecision(
      { ...pkg, version },
      { ...artifact, version, filename: `tityra-cli-${version}.tgz` },
      async () => {
        calls++;
        return response(404);
      },
    ),
    /Invalid package/,
  );
  assert.equal(calls, 0);
});

test('different gzip compression may skip publication only for authenticated identical raw TAR bytes', async () => {
  const fixture = gzipFixture();
  assert.equal(await fixture.run(), false);
  assert.equal(fixture.calls.length, 2);
  assert.equal(fixture.calls[1].url, canonicalTarball);
  assert.equal(fixture.calls[1].options.redirect, 'error');
  assert.equal(fixture.calls[1].options.headers['Accept-Encoding'], 'identity');
  assert.ok(fixture.calls[1].options.signal instanceof AbortSignal);
});

test('changed file bytes, path, executable mode, TAR header or file count always fail', async () => {
  for (const entries of [
    [{ name: 'package/dist/cli.js', body: 'evil' }],
    [{ name: 'package/other.js' }],
    [{ name: 'package/dist/cli.js', mode: 0o644 }],
    [{ name: 'package/dist/cli.js', mtime: 1 }],
    [{ name: 'package/dist/cli.js' }, { name: 'package/extra.js' }],
  ])
    await assert.rejects(gzipFixture({ remoteRaw: archive(entries) }).run(), /TAR bytes differ/);
});

test('fallback rejects untrusted URLs, redirects, altered response URLs and HTTP content decoding', async () => {
  for (const tarball of [
    'https://attacker.example/package.tgz',
    canonicalTarball + '?token=anything',
    canonicalTarball.replace('https:', 'http:'),
  ]) {
    const fixture = gzipFixture({ tarball });
    await assert.rejects(fixture.run(), /canonical package URL/);
    assert.equal(fixture.calls.length, 1);
  }
  for (const settings of [
    { downloadStatus: 302 },
    { finalUrl: 'https://attacker.example/package.tgz' },
    { headers: { 'Content-Encoding': 'gzip' } },
  ])
    await assert.rejects(gzipFixture(settings).run(), /response could not be verified/);
});

test('fallback authenticates both compressed archives and refuses corruption before comparing TAR bytes', async () => {
  await assert.rejects(
    gzipFixture({ remoteIntegrity: artifact.integrity }).run(),
    /registry tarball failed its integrity/,
  );
  await assert.rejects(
    gzipFixture({ remoteBytes: Buffer.from('not gzip') }).run(),
    /compressed archive is corrupt/,
  );
  let calls = 0;
  await assert.rejects(
    registryPublishDecision(
      pkg,
      artifact,
      async () => {
        calls++;
        return response(404);
      },
      { localTarball: Buffer.from('tampered') },
    ),
    /local integrity/,
  );
  assert.equal(calls, 0);
});

test('fallback bounds streamed compressed data and expanded archive data', async () => {
  await assert.rejects(
    gzipFixture({ remoteBytes: Buffer.alloc(8 * 1024 * 1024 + 1) }).run(),
    /response exceeded/,
  );
  await assert.rejects(
    gzipFixture({ remoteRaw: Buffer.alloc(33 * 1024 * 1024) }).run(),
    /compressed archive is corrupt or exceeds/,
  );
  const huge = Buffer.alloc(8 * 1024 * 1024 + 1);
  await assert.rejects(
    registryPublishDecision(pkg, { ...artifact, integrity: sri(huge) }, async () => response(404), {
      localTarball: huge,
    }),
    /local integrity/,
  );
});

test('verification-only mode refuses an unpublished version rather than permitting publication', async () => {
  await assert.rejects(
    registryPublishDecision(pkg, artifact, async () => response(404), { verifyOnly: true }),
    /publication is disabled/,
  );
});

test('local corrupt or expanded archives fail before even an equal-SRI or unpublished registry lookup', async () => {
  for (const bytes of [
    Buffer.from('not a gzip archive'),
    gzipSync(Buffer.alloc(33 * 1024 * 1024)),
  ]) {
    for (const status of [200, 404]) {
      let calls = 0;
      await assert.rejects(
        registryPublishDecision(
          pkg,
          { ...artifact, integrity: sri(bytes) },
          async () => {
            calls++;
            return response(
              status,
              status === 200 ? { ...pkg, dist: { integrity: sri(bytes) } } : undefined,
            );
          },
          { localTarball: bytes },
        ),
        /compressed archive is corrupt or exceeds/,
      );
      assert.equal(calls, 0);
    }
  }
});

test('oversized manifest JSON is bounded before parsing', async () => {
  await assert.rejects(
    registryPublishDecision(
      pkg,
      artifact,
      async () => new Response('x'.repeat(1024 * 1024 + 1), { status: 200 }),
    ),
    /response exceeded/,
  );
});
