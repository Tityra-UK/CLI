import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { appendFile, open, readFile } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const versionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const validVersion = (value) =>
  typeof value === 'string' && versionPattern.test(value) && !/[\r\n]/.test(value);
const validIntegrity = (value) => /^sha512-[A-Za-z0-9+/]{86}==$/.test(value || '');
const maxCompressedBytes = 8 * 1024 * 1024;
const maxTarBytes = 32 * 1024 * 1024;
const integrity = (bytes) => 'sha512-' + createHash('sha512').update(bytes).digest('base64');
function rawTar(bytes) {
  try {
    return gunzipSync(bytes, { maxOutputLength: maxTarBytes });
  } catch {
    throw new Error('A compressed archive is corrupt or exceeds the verification limit.');
  }
}

async function boundedResponse(response, maximum) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The registry returned an empty response.');
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new Error('The registry response exceeded the verification limit.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

async function localArchive(path) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxCompressedBytes)
      throw new Error(
        'The local tarball exceeded the verification limit or is not a regular file.',
      );
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) throw new Error('The local tarball changed during verification.');
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

export async function registryPublishDecision(
  pkg,
  artifact,
  fetchRegistry = fetch,
  { localTarball, verifyOnly = false } = {},
) {
  if (
    pkg.name !== '@tityra/cli' ||
    !validVersion(pkg.version) ||
    artifact.name !== pkg.name ||
    artifact.version !== pkg.version ||
    artifact.filename !== `tityra-cli-${pkg.version}.tgz` ||
    !validIntegrity(artifact.integrity)
  ) {
    throw new Error('Invalid package or tarball metadata; refusing publication.');
  }
  if (
    localTarball !== undefined &&
    (!Buffer.isBuffer(localTarball) ||
      localTarball.length > maxCompressedBytes ||
      integrity(localTarball) !== artifact.integrity)
  )
    throw new Error('The packed tarball failed its local integrity check.');
  const localTar = localTarball === undefined ? undefined : rawTar(localTarball);
  const url = `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}`;
  const response = await fetchRegistry(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
    headers: { Accept: 'application/json' },
  });
  if (response.status === 404) {
    await response.body?.cancel();
    if (verifyOnly)
      throw new Error(
        'Verification requires an already published version; publication is disabled.',
      );
    return true;
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(`Registry lookup failed (HTTP ${response.status}); refusing publication.`);
  }
  const published = JSON.parse((await boundedResponse(response, 1024 * 1024)).toString('utf8'));
  if (
    published?.name !== pkg.name ||
    published?.version !== pkg.version ||
    !validIntegrity(published?.dist?.integrity)
  ) {
    throw new Error(
      'The published version does not match this exact tarball; refusing publication.',
    );
  }
  if (published.dist.integrity === artifact.integrity) return false;
  if (!localTarball)
    throw new Error(
      'The published version does not match this exact tarball; refusing publication.',
    );
  const tarballUrl = `https://registry.npmjs.org/${pkg.name}/-/cli-${pkg.version}.tgz`;
  if (published.dist.tarball !== tarballUrl)
    throw new Error('The registry tarball URL is not the canonical package URL.');
  const download = await fetchRegistry(tarballUrl, {
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
    headers: { Accept: 'application/octet-stream', 'Accept-Encoding': 'identity' },
  });
  if (
    download.status !== 200 ||
    download.url !== tarballUrl ||
    ![null, 'identity'].includes(download.headers.get('content-encoding'))
  ) {
    await download.body?.cancel();
    throw new Error('The registry tarball response could not be verified.');
  }
  const remoteTarball = await boundedResponse(download, maxCompressedBytes);
  if (integrity(remoteTarball) !== published.dist.integrity)
    throw new Error('The registry tarball failed its integrity check.');
  const remoteTar = rawTar(remoteTarball);
  // Exact TAR equality preserves every file, path, mode, header, order and end marker.
  // Nothing is extracted, executed or normalised to make an existing version match.
  if (!localTar.equals(remoteTar))
    throw new Error('The published TAR bytes differ from this package; refusing publication.');
  console.log('Authenticated TAR bytes match exactly; only gzip compression differs.');
  return false;
}

async function main() {
  const args = process.argv.slice(2);
  const verifyOnly = args.includes('--verify-only');
  const [manifestPath, directory, packagePath] = args.filter((arg) => arg !== '--verify-only');
  if (!manifestPath || !directory || /[\r\n]/.test(directory))
    throw new Error('Provide the pack manifest and artifact directory.');
  if (packagePath && (!isAbsolute(packagePath) || basename(packagePath) !== 'package.json'))
    throw new Error('The source package path must be an absolute package.json path.');
  const pkg = JSON.parse(
    await readFile(packagePath || new URL('../package.json', import.meta.url), 'utf8'),
  );
  const artifacts = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!Array.isArray(artifacts) || artifacts.length !== 1)
    throw new Error('Expected exactly one packed artifact.');
  const artifact = artifacts[0];
  // Validate the filename before resolving or reading any path from pack metadata.
  if (artifact.filename !== `tityra-cli-${pkg.version}.tgz` || !validVersion(pkg.version))
    throw new Error('Unexpected tarball filename.');
  const tarball = resolve(directory, artifact.filename);
  const bytes = await localArchive(tarball);
  const publish = await registryPublishDecision(pkg, artifact, fetch, {
    localTarball: bytes,
    verifyOnly,
  });
  if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required.');
  await appendFile(process.env.GITHUB_OUTPUT, `publish=${publish}\ntarball=${tarball}\n`);
  console.log(
    publish
      ? 'Exact version is not published; this tarball is ready for publication.'
      : 'Published package bytes verified; publication will be skipped.',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
