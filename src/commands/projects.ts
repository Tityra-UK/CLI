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
    .description('Read or change weekly website content audit monitoring for a selected project');
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
      .description('Pause weekly monitoring; approve recurring credit spending in Tityra')
      .addHelpText(
        'after',
        '\nRequires an explicitly granted monitoring:write permission and current project management access.\nRead settings first; include the current expectedRevision and keep the same input and idempotencyKey when retrying an uncertain write.\nUse action disable to pause. Enabling or resuming paid monitoring requires explicit recurring organisation credit approval in Tityra.\nmonitoring:write does not grant financial authority. Confirm website scope and the recurring credit budget in the application.\nEach scheduled audit consumes organisation credits, including on Enterprise. Insufficient credits pause new runs. Read nextScheduledAt and history for the current server state.\nThe CLI cannot select a payer or change a subscription.\n',
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
