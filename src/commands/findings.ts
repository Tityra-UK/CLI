import type { Command } from 'commander';
import type { ContextFactory } from '../types.js';
import { identifier, statuses } from '../schema/writeSchema.js';
import { usage } from '../services/errors.js';
import {
  pageQuery,
  pagination,
  read,
  withQuery,
  write,
  writeOptions,
  type PageOptions,
} from './shared.js';

interface FindingOptions extends PageOptions {
  severity?: string;
  status?: string;
}

export function registerFindingsCommands(program: Command, context: ContextFactory): void {
  const findings = program
    .command('findings')
    .description('Read findings and submit customer feedback or remediation');
  pagination(
    findings
      .command('list <report-id>')
      .description('Read findings with optional severity and remediation filters')
      .option('--severity <severity>', 'critical, high, medium, low or info')
      .option('--status <status>', 'Customer remediation status'),
  ).action(async (reportId: string, options: FindingOptions, command: Command) => {
    const target = identifier(reportId);
    const query = pageQuery(options);
    if (options.severity !== undefined) {
      if (!['critical', 'high', 'medium', 'low', 'info'].includes(options.severity))
        usage('severity must be critical, high, medium, low or info.');
      query.set('severity', options.severity);
    }
    if (options.status !== undefined) {
      if (!statuses.includes(options.status))
        usage(`status must be one of ${statuses.join(', ')}.`);
      query.set('status', options.status);
    }
    await read(
      command,
      context,
      withQuery(`/api/agent/reports/${target}/findings`, query),
      'Loading findings',
    );
  });
  writeOptions(
    findings
      .command('challenge <report-id> <finding-id>')
      .description(
        'Mark a finding as incorrect with the customer’s reason; this does not edit report evidence',
      ),
  ).action(async (reportId: string, findingId: string, _options: unknown, command: Command) => {
    await write(
      command,
      context,
      'challenge',
      `/api/agent/reports/${identifier(reportId)}/findings/${identifier(findingId, true)}/challenge`,
    );
  });
  writeOptions(
    findings
      .command('remediate <report-id> <finding-id>')
      .description('Record customer-reported progress without verifying a fix'),
  ).action(async (reportId: string, findingId: string, _options: unknown, command: Command) => {
    await write(
      command,
      context,
      'remediation',
      `/api/agent/reports/${identifier(reportId)}/findings/${identifier(findingId, true)}/remediation`,
      'PATCH',
    );
  });
}
