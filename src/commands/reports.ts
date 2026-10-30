import { lstat, open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import type { ContextFactory } from '../types.js';
import { identifier, positiveInteger } from '../schema/writeSchema.js';
import { CliError, usage } from '../services/errors.js';
import { AuthError } from '../services/authService.js';
import { CredentialError } from '../services/credentialStore.js';
import { read, write, writeOptions } from './shared.js';

interface DownloadOptions {
  revision?: string;
  output?: string;
}

export function registerReportsCommands(program: Command, context: ContextFactory): void {
  const reports = program
    .command('reports')
    .description('Read released reports and download a published PDF revision');
  reports
    .command('get <report-id>')
    .description('Read an accessible released report')
    .action(async (id: string, _options: unknown, command: Command) => {
      await read(command, context, `/api/agent/reports/${identifier(id)}`, 'Loading report');
    });
  reports
    .command('download <report-id>')
    .description(
      'Save an exact PDF revision to a new private file; existing files are never overwritten',
    )
    .option('--revision <number>', 'Exact published report revision')
    .option('--output <file>', 'New destination PDF file')
    .action(async (id: string, options: DownloadOptions, command: Command) => {
      const reportId = identifier(id);
      if (!options.revision || !options.output)
        usage('Provide --revision <number> and --output <new-file.pdf>.');
      const revision = positiveInteger(options.revision, 'revision');
      const destination = resolve(options.output);
      const ctx = context(command);
      let handle;
      let created: { ino: number; dev: number } | undefined;
      let saved = false;
      try {
        handle = await open(destination, 'wx', 0o600);
        created = await handle.stat();
        const bytes = await ctx.run('Downloading report PDF', () =>
          ctx.api.request(
            `/api/agent/reports/${reportId}/pdf?revision=${revision}`,
            'GET',
            undefined,
            true,
          ),
        );
        if (!(bytes instanceof Uint8Array))
          throw new CliError('invalid_response', 'Tityra did not return a PDF document.');
        await handle.writeFile(bytes);
        await handle.sync();
        saved = true;
      } catch (error) {
        if (
          error instanceof CliError ||
          error instanceof AuthError ||
          error instanceof CredentialError
        )
          throw error;
        if ((error as NodeJS.ErrnoException).code === 'EEXIST')
          throw new CliError(
            'output_exists',
            'The output file already exists. Choose a new filename.',
          );
        throw new CliError(
          'download_failed',
          'The PDF could not be saved. Check the destination directory and available disk space.',
        );
      } finally {
        await handle?.close().catch(() => undefined);
        if (!saved && created) {
          const current = await lstat(destination).catch(() => undefined);
          if (current?.ino === created.ino && current.dev === created.dev)
            await unlink(destination).catch(() => undefined);
        }
      }
      ctx.output({ saved: true, reportId: id, revision, path: destination });
    });
  writeOptions(
    reports
      .command('checkout <report-id>')
      .description('Create a checkout link for the customer to review and pay'),
  ).action(async (id: string, _options: unknown, command: Command) => {
    await write(command, context, 'checkout', `/api/agent/reports/${identifier(id)}/checkout`);
  });
}
