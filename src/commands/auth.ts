import { spawn } from 'node:child_process';
import type { Command } from 'commander';
import { authStatus, login, logout, type AuthOptions } from '../services/authService.js';
import { usage } from '../services/errors.js';
import type { ContextFactory } from '../types.js';

async function openBrowser(url: string): Promise<void> {
  const [executable, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
  await new Promise<void>((resolve) => {
    const child = spawn(executable as string, args as string[], {
      stdio: 'ignore',
      shell: false,
      windowsHide: true,
    });
    child.once('error', () => resolve());
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

export async function loginInteractive(
  auth: AuthOptions,
  browser = true,
  scopes?: readonly string[],
): ReturnType<typeof login> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    return await login({
      ...auth,
      scopes,
      signal: controller.signal,
      onAuthorize: async (url) => {
        process.stderr.write(
          `Authorise Tityra CLI in your browser:\n${url}\n\nWaiting for your approval…\n`,
        );
        if (browser && process.stderr.isTTY) await openBrowser(url);
      },
    });
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}

export function registerAuthCommands(program: Command, context: ContextFactory): void {
  const auth = program.command('auth').description('Sign in, inspect your connection, or sign out');
  auth
    .command('login')
    .description('Connect through your browser using OAuth and PKCE')
    .option('--scope <scopes>', 'Space-separated OAuth scopes (defaults to read access)')
    .option('--no-browser', 'Print the authorisation URL without opening a browser')
    .action(async (options: { scope?: string; browser: boolean }, command: Command) => {
      if (options.scope !== undefined && (!options.scope.trim() || options.scope.length > 2000))
        usage('Provide a non-empty, space-separated scope list.');
      const ctx = context(command);
      const result = await loginInteractive(
        ctx.auth,
        options.browser,
        options.scope?.trim().split(/\s+/),
      );
      ctx.output({ authenticated: true, ...result });
    });
  auth
    .command('status')
    .description('Show local connection status without exposing credentials')
    .action(async (_options, command: Command) => {
      const ctx = context(command);
      ctx.output(await authStatus(ctx.auth));
    });
  auth
    .command('logout')
    .description('Revoke this CLI connection and remove its stored credentials')
    .action(async (_options, command: Command) => {
      const ctx = context(command);
      ctx.output(await ctx.run('Revoking your CLI connection', () => logout(ctx.auth)));
    });
}
