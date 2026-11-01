import type { Command } from 'commander';
import type { ContextFactory } from '../types.js';
import { identifier } from '../schema/writeSchema.js';
import { read, write, writeOptions } from './shared.js';

export function registerProjectsCommands(program: Command, context: ContextFactory): void {
  const projects = program
    .command('projects')
    .description('Read selected projects and manage authorised weekly monitoring');
  projects
    .command('list')
    .description('List accessible projects')
    .action(async (_options: unknown, command: Command) => {
      await read(command, context, '/api/agent/projects', 'Loading projects');
    });
  const monitoring = projects
    .command('monitoring')
    .description('Read or change weekly AX Audit monitoring for a selected project');
  monitoring
    .command('get <project-id>')
    .description('Read current monitoring settings, scope, revision and report history')
    .action(async (id: string, _options: unknown, command: Command) => {
      await read(
        command,
        context,
        `/api/agent/projects/${identifier(id)}/monitoring`,
        'Loading project monitoring',
      );
    });
  writeOptions(
    monitoring
      .command('update <project-id>')
      .description('Enable, pause, resume or update the scope of weekly AX Audit monitoring')
      .addHelpText(
        'after',
        '\nRequires an explicitly granted monitoring:write permission and current project management access.\nRead settings first; include the current expectedRevision and keep the same input and idempotencyKey when retrying an uncertain write.\nUse action enable with authorisation: true and the returned website as expectedWebsite. Use action disable to pause.\nEnabling monitoring records your website and scope authorisation without a separate administrator approval. Confirm that authorisation again after changing the website or scope. The CLI cannot select a payer or change a subscription.\n',
      ),
  ).action(async (id: string, _options: unknown, command: Command) => {
    await write(
      command,
      context,
      'monitoring',
      `/api/agent/projects/${identifier(id)}/monitoring`,
      'PATCH',
    );
  });
}
