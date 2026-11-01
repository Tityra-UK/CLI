import type { Command } from 'commander';
import type { ContextFactory } from '../types.js';
import { identifier } from '../schema/writeSchema.js';
import {
  pageQuery,
  pagination,
  read,
  withQuery,
  write,
  writeOptions,
  type PageOptions,
} from './shared.js';

interface AuditOptions extends PageOptions {
  project: string;
}

export function registerAuditsCommands(program: Command, context: ContextFactory): void {
  const audits = program
    .command('audits')
    .description('Read audit eligibility, requests and payment status');
  audits
    .command('options')
    .description('Read available audit options for a selected project')
    .requiredOption('--project <project-id>', 'Selected project ID')
    .action(async (options: AuditOptions, command: Command) => {
      identifier(options.project);
      const query = new URLSearchParams({ projectId: options.project });
      await read(
        command,
        context,
        withQuery('/api/agent/audits/options', query),
        'Loading audit options',
      );
    });
  pagination(
    audits
      .command('list')
      .description('List audit requests for a selected project')
      .requiredOption('--project <project-id>', 'Selected project ID'),
  ).action(async (options: AuditOptions, command: Command) => {
    identifier(options.project);
    const query = pageQuery(options);
    query.set('projectId', options.project);
    await read(command, context, withQuery('/api/agent/audits', query), 'Loading audit requests');
  });
  audits
    .command('get <audit-id>')
    .description('Read an audit request and its current status')
    .action(async (id: string, _options: unknown, command: Command) => {
      await read(command, context, `/api/agent/audits/${identifier(id)}`, 'Loading audit request');
    });
  audits
    .command('payment <audit-id>')
    .description('Read payment requirements and status without making a payment')
    .action(async (id: string, _options: unknown, command: Command) => {
      await read(
        command,
        context,
        `/api/agent/audits/${identifier(id)}/payment`,
        'Loading payment status',
      );
    });
  writeOptions(
    audits
      .command('create')
      .description('Request an additional audit under the existing eligibility and authority rules')
      .addHelpText(
        'after',
        '\nWeekly monitoring includes AX Audit only. Additional AX Audits and Expert Review require a separate request and payment through the normal checkout.\nUse projects monitoring get/update for an explicitly authorised project, or manage monitoring in the Tityra application.\n',
      ),
  ).action(async (_options: unknown, command: Command) => {
    await write(command, context, 'audit', '/api/agent/audits');
  });
}
