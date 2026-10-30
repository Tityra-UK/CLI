import type { Command } from 'commander';
import type { ContextFactory } from '../types.js';
import { writeInput } from '../services/inputService.js';
import { positiveInteger, type WriteKind } from '../schema/writeSchema.js';

export interface PageOptions {
  page?: string;
  pageSize?: string;
}
export interface WriteOptions {
  input?: string;
  yes?: boolean;
}

export function pagination(command: Command): Command {
  return command
    .option('--page <number>', 'Page number, starting at 1')
    .option('--page-size <number>', 'Results per page, from 1 to 100');
}

export function pageQuery(options: PageOptions): URLSearchParams {
  const query = new URLSearchParams();
  if (options.page !== undefined)
    query.set('page', String(positiveInteger(options.page, 'page', 9999)));
  if (options.pageSize !== undefined)
    query.set('pageSize', String(positiveInteger(options.pageSize, 'page-size', 100)));
  return query;
}

export function withQuery(path: string, query: URLSearchParams): string {
  return query.size ? `${path}?${query}` : path;
}

export function writeOptions(command: Command): Command {
  return command
    .option('--input <file>', 'JSON input file, or - for stdin')
    .option('--yes', 'Confirm this account change after reviewing the input');
}

export async function read(
  command: Command,
  factory: ContextFactory,
  path: string,
  label: string,
): Promise<void> {
  const context = factory(command);
  context.output(await context.run(label, () => context.api.request(path)));
}

export async function write(
  command: Command,
  factory: ContextFactory,
  kind: WriteKind,
  path: string,
  method = 'POST',
): Promise<void> {
  const body = await writeInput(kind, command.opts<WriteOptions>());
  const context = factory(command);
  context.output(
    await context.run('Submitting your confirmed request', () =>
      context.api.request(path, method, body),
    ),
  );
}
