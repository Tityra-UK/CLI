import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { win32 } from 'node:path';

export interface StoredCredentials {
  issuer: string;
  resource: string;
  clientId: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: string;
  scopes: string[];
}
interface CredentialDocument {
  version: 1;
  profiles: Record<string, StoredCredentials>;
}

/** Windows stores only DPAPI ciphertext; POSIX uses the private file permissions below. */
export interface CredentialProtection {
  protect(plaintext: string): Promise<string>;
  unprotect(ciphertext: string): Promise<string>;
}
interface DpapiCommand {
  executable: string;
  args: string[];
}
type DpapiRunner = (command: DpapiCommand, input: string) => Promise<string>;
const MAX_DOCUMENT_BYTES = 131072;
const MAX_ENVELOPE_BYTES = 262144;
const ciphertextPattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** The script is fixed code: credential data travels through stdin, never PowerShell arguments. */
export function windowsDpapiCommand(
  operation: 'protect' | 'unprotect',
  systemRoot = process.env.SystemRoot || process.env.WINDIR,
): DpapiCommand {
  if (
    !systemRoot ||
    !/^[A-Za-z]:[\\/]/.test(systemRoot) ||
    /[\u0000-\u001f\u007f]/.test(systemRoot) ||
    !['protect', 'unprotect'].includes(operation)
  ) {
    throw new CredentialError('Windows user-bound credential protection is unavailable.');
  }
  const script = `$ErrorActionPreference = 'Stop'; try {
    Microsoft.PowerShell.Utility\\Add-Type -AssemblyName System.Security;
    $utf8 = [System.Text.UTF8Encoding]::new($false);
    [Console]::InputEncoding = $utf8;
    [Console]::OutputEncoding = $utf8;
    $text = [Console]::In.ReadToEnd();
    $entropy = $utf8.GetBytes('Tityra CLI credential store v1');
    ${
      operation === 'protect'
        ? `$data = $utf8.GetBytes($text);
    $result = [System.Security.Cryptography.ProtectedData]::Protect($data, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser);
    [Console]::Out.Write([Convert]::ToBase64String($result));`
        : `$data = [Convert]::FromBase64String($text);
    $result = [System.Security.Cryptography.ProtectedData]::Unprotect($data, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser);
    [Console]::Out.Write($utf8.GetString($result));`
    }
    exit 0;
  } catch { exit 1; }`;
  return {
    executable: win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-InputFormat',
      'Text',
      '-OutputFormat',
      'Text',
      '-Command',
      script,
    ],
  };
}

const runDpapi: DpapiRunner = (command, input) =>
  new Promise((resolve, reject) => {
    // execFile does not invoke cmd.exe. No exception, stderr or child arguments are exposed.
    const child = execFile(
      command.executable,
      command.args,
      {
        shell: false,
        windowsHide: true,
        cwd: win32.dirname(command.executable),
        env: {
          ...process.env,
          PSModulePath: win32.join(win32.dirname(command.executable), 'Modules'),
        },
        timeout: 10000,
        maxBuffer: MAX_ENVELOPE_BYTES,
        encoding: 'utf8',
      },
      (error, stdout) => {
        if (error)
          reject(
            new CredentialError(
              'Windows could not protect or decrypt these credentials for the current user.',
            ),
          );
        else resolve(stdout);
      },
    );
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(input, 'utf8');
  });

export class WindowsDpapiProtection implements CredentialProtection {
  constructor(private readonly options: { systemRoot?: string; run?: DpapiRunner } = {}) {}
  async protect(plaintext: string): Promise<string> {
    if (Buffer.byteLength(plaintext) > MAX_DOCUMENT_BYTES)
      throw new CredentialError('The credentials exceeded the size limit.');
    let value: string;
    try {
      value = await (this.options.run || runDpapi)(
        windowsDpapiCommand('protect', this.options.systemRoot),
        plaintext,
      );
    } catch {
      throw new CredentialError(
        'Windows could not protect credentials for the current user. Nothing was stored in plaintext.',
      );
    }
    if (!value || value.length > MAX_ENVELOPE_BYTES || !ciphertextPattern.test(value))
      throw new CredentialError('Windows returned an invalid encrypted credential response.');
    return value;
  }
  async unprotect(ciphertext: string): Promise<string> {
    if (
      !ciphertext ||
      ciphertext.length > MAX_ENVELOPE_BYTES ||
      !ciphertextPattern.test(ciphertext)
    )
      throw new CredentialError('The encrypted credentials are invalid.');
    let value: string;
    try {
      value = await (this.options.run || runDpapi)(
        windowsDpapiCommand('unprotect', this.options.systemRoot),
        ciphertext,
      );
    } catch {
      throw new CredentialError(
        'These credentials could not be decrypted by the current Windows user. Sign in again.',
      );
    }
    if (Buffer.byteLength(value) > MAX_DOCUMENT_BYTES)
      throw new CredentialError('The credentials exceeded the size limit.');
    return value;
  }
}

export class CredentialError extends Error {
  readonly code = 'credentials_error';
  constructor(message: string) {
    super(message);
    this.name = 'CredentialError';
  }
}

export function defaultConfigDirectory(): string {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || process.env.APPDATA;
    return join(base && isAbsolute(base) ? base : join(homedir(), 'AppData', 'Local'), 'tityra');
  }
  if (process.platform === 'darwin')
    return join(homedir(), 'Library', 'Application Support', 'tityra');
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && !isAbsolute(xdg))
    throw new CredentialError('XDG_CONFIG_HOME must be an absolute path.');
  return join(xdg || join(homedir(), '.config'), 'tityra');
}

const noFollow = constants.O_NOFOLLOW || 0;
const own = (stat: { uid: number }) =>
  typeof process.getuid !== 'function' || stat.uid === process.getuid();
const privateMode = (stat: { mode: number }) =>
  process.platform === 'win32' || (stat.mode & 0o077) === 0;
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const windowsSharingViolation = (error: unknown, platform = process.platform) =>
  platform === 'win32' && ['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code || '');

interface LockWaitDependencies {
  platform: NodeJS.Platform;
  now(): number;
  pause(milliseconds: number): Promise<void>;
}

/** Retry contention only; a caller receives a handle only after exclusive open succeeds. */
export async function acquireCredentialFileLock<T>(
  openExclusive: () => Promise<T>,
  inspectExisting: () => Promise<void>,
  dependencies: Partial<LockWaitDependencies> = {},
): Promise<T> {
  const platform = dependencies.platform || process.platform;
  const now = dependencies.now || Date.now;
  const pause =
    dependencies.pause ||
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = now() + 30000;
  const checkDeadline = () => {
    if (now() >= deadline)
      throw new CredentialError(
        'Another Tityra process is using credentials. Retry when it finishes.',
      );
  };
  for (;;) {
    checkDeadline();
    try {
      return await openExclusive();
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'EEXIST' &&
        !windowsSharingViolation(error, platform)
      ) {
        throw new CredentialError('The credentials lock could not be acquired safely.');
      }
    }
    // Windows can report a sharing/delete-pending file as EPERM or EACCES.
    // Inspect it as usual, but never interpret a failed open as owning the lock.
    await inspectExisting();
    checkDeadline();
    await pause(25);
  }
}

function validate(value: unknown, issuer?: string): StoredCredentials {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CredentialError('The saved credentials are invalid. Sign in again.');
  const v = value as Partial<StoredCredentials>;
  let origin: string;
  try {
    origin = new URL(v.issuer || '').origin;
  } catch {
    throw new CredentialError('The saved credentials are invalid. Sign in again.');
  }
  if (
    origin !== v.issuer ||
    (issuer !== undefined && issuer !== v.issuer) ||
    v.resource !== origin + '/mcp' ||
    typeof v.clientId !== 'string' ||
    !/^[A-Za-z0-9._~-]{1,200}$/.test(v.clientId) ||
    typeof v.accessToken !== 'string' ||
    !/^[A-Za-z0-9._~+/-]+=*$/.test(v.accessToken) ||
    v.accessToken.length > 8192 ||
    (v.refreshToken !== undefined &&
      (typeof v.refreshToken !== 'string' ||
        !/^[A-Za-z0-9._~+/-]+=*$/.test(v.refreshToken) ||
        v.refreshToken.length > 8192)) ||
    typeof v.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(v.expiresAt)) ||
    !Array.isArray(v.scopes) ||
    v.scopes.length > 64 ||
    v.scopes.some((s) => typeof s !== 'string' || !/^[a-z][a-z0-9:_-]{0,99}$/.test(s))
  ) {
    throw new CredentialError('The saved credentials are invalid. Sign in again.');
  }
  return {
    issuer: v.issuer,
    resource: v.resource,
    clientId: v.clientId,
    accessToken: v.accessToken,
    ...(v.refreshToken === undefined ? {} : { refreshToken: v.refreshToken }),
    expiresAt: v.expiresAt,
    scopes: [...v.scopes],
  } as StoredCredentials;
}

/** User-owned credentials only. No project configuration or .env files are read. */
export class CredentialStore {
  readonly directory: string;
  readonly path: string;
  private readonly locked: boolean;
  private readonly protection?: CredentialProtection;
  constructor(
    options?: string | { directory?: string; protection?: CredentialProtection },
    locked = false,
  ) {
    const directory =
      typeof options === 'string' ? options : options?.directory || defaultConfigDirectory();
    if (!isAbsolute(directory))
      throw new CredentialError('The credentials directory must be an absolute path.');
    this.directory = resolve(directory);
    if (this.directory === parse(this.directory).root)
      throw new CredentialError('Choose a dedicated credentials directory.');
    this.path = join(this.directory, 'credentials.json');
    this.locked = locked;
    this.protection =
      (typeof options === 'object' ? options.protection : undefined) ||
      (process.platform === 'win32' ? new WindowsDpapiProtection() : undefined);
  }

  private async prepare(create: boolean): Promise<boolean> {
    try {
      // Check every path component before use: recursive mkdir must not traverse symlinks.
      const pending: string[] = [];
      for (let current = this.directory; current !== dirname(current); current = dirname(current))
        pending.unshift(current);
      for (const component of pending) {
        let stat;
        try {
          stat = await fs.lstat(component);
        } catch (error) {
          if (!absent(error))
            throw new CredentialError('The credentials directory could not be inspected.');
          if (!create) return false;
          try {
            await fs.mkdir(component, { mode: 0o700 });
          } catch (mkdirError) {
            if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST')
              throw new CredentialError('The credentials directory could not be created.');
          }
          stat = await fs.lstat(component);
        }
        if (stat.isSymbolicLink() || !stat.isDirectory())
          throw new CredentialError('Credentials paths must not contain symbolic links.');
        if (component === this.directory) {
          if (!own(stat))
            throw new CredentialError('The credentials directory must belong to the current user.');
          if (create) await fs.chmod(component, 0o700);
          else if (!privateMode(stat))
            throw new CredentialError(
              'The credentials directory must have private permissions (0700).',
            );
        }
      }
      return true;
    } catch (error) {
      if (error instanceof CredentialError) throw error;
      throw new CredentialError('The credentials directory could not be used safely.');
    }
  }

  private async document(): Promise<CredentialDocument> {
    const empty = (): CredentialDocument => ({
      version: 1,
      profiles: Object.create(null) as Record<string, StoredCredentials>,
    });
    if (!(await this.prepare(false))) return empty();
    let handle;
    try {
      const destination = await fs.lstat(this.path);
      if (destination.isSymbolicLink() || !destination.isFile())
        throw new CredentialError('The credentials file could not be opened safely.');
      handle = await fs.open(this.path, constants.O_RDONLY | noFollow);
    } catch (error) {
      if (absent(error)) return empty();
      throw new CredentialError('The credentials file could not be opened safely.');
    }
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        !own(stat) ||
        !privateMode(stat) ||
        stat.size > MAX_ENVELOPE_BYTES
      )
        throw new CredentialError(
          'The credentials file must be a private, user-owned regular file (0600).',
        );
      let serialized = await handle.readFile('utf8');
      let value: unknown = JSON.parse(serialized);
      if (this.protection) {
        const envelope = value as {
          version?: unknown;
          protection?: unknown;
          data?: unknown;
        } | null;
        if (
          !envelope ||
          envelope.version !== 1 ||
          envelope.protection !== 'windows-dpapi-current-user' ||
          typeof envelope.data !== 'string'
        )
          throw new CredentialError(
            'Windows credentials must use current-user encryption. Remove the old CLI credentials and authorise again.',
          );
        serialized = await this.protection.unprotect(envelope.data);
        value = JSON.parse(serialized) as unknown;
      }
      if (Buffer.byteLength(serialized) > MAX_DOCUMENT_BYTES)
        throw new CredentialError('The credentials exceeded the size limit.');
      if (
        !value ||
        typeof value !== 'object' ||
        (value as CredentialDocument).version !== 1 ||
        !(value as CredentialDocument).profiles ||
        typeof (value as CredentialDocument).profiles !== 'object' ||
        Array.isArray((value as CredentialDocument).profiles)
      )
        throw new Error('invalid');
      const result = empty();
      for (const [issuer, profile] of Object.entries((value as CredentialDocument).profiles))
        result.profiles[issuer] = validate(profile, issuer);
      return result;
    } catch (error) {
      if (error instanceof CredentialError) throw error;
      throw new CredentialError('The saved credentials are invalid. Sign in again.');
    } finally {
      await handle.close();
    }
  }

  async read(issuer: string): Promise<StoredCredentials | undefined> {
    const document = await this.document();
    return Object.hasOwn(document.profiles, issuer)
      ? validate(document.profiles[issuer], issuer)
      : undefined;
  }

  private async save(document: CredentialDocument): Promise<void> {
    await this.prepare(true);
    let serialized = JSON.stringify(document);
    if (Buffer.byteLength(serialized) > MAX_DOCUMENT_BYTES)
      throw new CredentialError('The credentials exceeded the size limit.');
    if (this.protection)
      serialized = JSON.stringify({
        version: 1,
        protection: 'windows-dpapi-current-user',
        data: await this.protection.protect(serialized),
      });
    if (Buffer.byteLength(serialized) > MAX_ENVELOPE_BYTES)
      throw new CredentialError('The encrypted credentials exceeded the size limit.');
    // Refuse a malicious destination even though atomic rename would replace the link itself.
    try {
      const stat = await fs.lstat(this.path);
      if (
        stat.isSymbolicLink() ||
        !stat.isFile() ||
        stat.nlink !== 1 ||
        !own(stat) ||
        !privateMode(stat)
      )
        throw new CredentialError('The credentials file cannot be replaced safely.');
    } catch (error) {
      if (!absent(error))
        throw error instanceof CredentialError
          ? error
          : new CredentialError('The credentials file could not be inspected safely.');
    }
    const temporary = join(this.directory, '.credentials-' + randomBytes(16).toString('hex'));
    let handle;
    try {
      handle = await fs.open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
        0o600,
      );
      await handle.writeFile(serialized + '\n');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporary, this.path);
      if (process.platform !== 'win32') {
        const directoryHandle = await fs.open(
          this.directory,
          constants.O_RDONLY | (constants.O_DIRECTORY || 0) | noFollow,
        );
        try {
          await directoryHandle.sync();
        } finally {
          await directoryHandle.close();
        }
      }
    } catch (error) {
      if (error instanceof CredentialError) throw error;
      throw new CredentialError('The credentials could not be saved safely.');
    } finally {
      await handle?.close();
      await fs.unlink(temporary).catch(() => undefined);
    }
  }

  async write(credentials: StoredCredentials): Promise<void> {
    const safe = validate(credentials);
    if (!this.locked) return this.withLock(safe.issuer, (store) => store.write(safe));
    const document = await this.document();
    document.profiles[safe.issuer] = safe;
    await this.save(document);
  }

  async remove(issuer: string): Promise<void> {
    if (!this.locked) return this.withLock(issuer, (store) => store.remove(issuer));
    const document = await this.document();
    if (!Object.hasOwn(document.profiles, issuer)) return;
    delete document.profiles[issuer];
    await this.save(document);
  }

  /** A single file lock also serializes writes to different issuer profiles. */
  async withLock<T>(_issuer: string, action: (store: CredentialStore) => Promise<T>): Promise<T> {
    if (this.locked) return action(this);
    await this.prepare(true);
    const path = join(this.directory, 'credentials.lock');
    const handle = await acquireCredentialFileLock(
      () =>
        fs.open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600),
      async () => {
        const stat = await fs.lstat(path).catch((statError) => {
          if (absent(statError) || windowsSharingViolation(statError)) return undefined;
          throw new CredentialError('The credentials lock could not be inspected safely.');
        });
        if (!stat) return;
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.nlink !== 1 ||
          !own(stat) ||
          !privateMode(stat)
        )
          throw new CredentialError('The credentials lock is unsafe.');
        // Never steal a live lock. A crashed owner's old lock can be reclaimed.
        if (Date.now() - stat.mtimeMs > 30000 && stat.size < 1024) {
          let pid = 0;
          try {
            pid = Number(JSON.parse(await fs.readFile(path, 'utf8')).pid);
          } catch {
            /* malformed locks are left for explicit repair */
          }
          if (Number.isSafeInteger(pid) && pid > 0) {
            try {
              process.kill(pid, 0);
            } catch (pidError) {
              if ((pidError as NodeJS.ErrnoException).code === 'ESRCH') {
                const current = await fs.lstat(path).catch((statError) => {
                  if (absent(statError) || windowsSharingViolation(statError)) return undefined;
                  throw new CredentialError('The credentials lock could not be inspected safely.');
                });
                if (current?.ino === stat.ino && current.dev === stat.dev) {
                  await fs.unlink(path).catch((unlinkError) => {
                    if (!absent(unlinkError) && !windowsSharingViolation(unlinkError))
                      throw new CredentialError(
                        'The stale credentials lock could not be removed safely.',
                      );
                  });
                }
              }
            }
          }
        }
      },
    );
    const acquired = await handle.stat();
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid }));
      await handle.sync();
      return await action(
        new CredentialStore({ directory: this.directory, protection: this.protection }, true),
      );
    } finally {
      await handle.close();
      const current = await fs.lstat(path).catch(() => undefined);
      if (current?.ino === acquired.ino && current.dev === acquired.dev) await fs.unlink(path);
    }
  }
}
