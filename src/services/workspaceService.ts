import prompts from 'prompts';
import type { Command } from 'commander';
import type { CommandContext, GlobalOptions } from '../types.js';
import { identifier } from '../schema/writeSchema.js';
import { loginInteractive } from '../commands/auth.js';
import { authStatus, type AuthOptions, type AuthStatus } from './authService.js';
import { welcomeBanner } from './brandingService.js';
import { createContext } from './contextService.js';
import { CliError } from './errors.js';
import { terminalText } from './outputService.js';

interface Choice {
  title: string;
  value: string;
  description?: string;
}
export interface WorkspaceEnvironment {
  interactive: boolean;
  choose(message: string, choices: Choice[]): Promise<string | undefined>;
  write(text: string): void;
  status(options: AuthOptions): Promise<AuthStatus>;
  login(options: AuthOptions, browser: boolean): Promise<unknown>;
  banner(version: string, color?: boolean): string;
}
type Item = Record<string, unknown>;
const record = (value: unknown): value is Item =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const back: Choice = { title: 'Back', value: 'back' };
const exit: Choice = { title: 'Exit', value: 'exit' };
class WorkspaceCancelled extends Error {}

function items(value: unknown, key: string): Item[] {
  if (!record(value) || !Array.isArray(value[key]) || !value[key].every(record)) {
    throw new CliError('invalid_response', 'Tityra returned an invalid workspace response.');
  }
  return value[key];
}

function id(value: unknown): string {
  if (typeof value !== 'string')
    throw new CliError('invalid_response', 'Tityra returned an invalid resource reference.');
  try {
    return identifier(value);
  } catch {
    throw new CliError('invalid_response', 'Tityra returned an invalid resource reference.');
  }
}

async function load(context: CommandContext, path: string): Promise<unknown> {
  return context.run('Loading your workspace', () => context.api.request(path));
}

async function signIn(
  context: CommandContext,
  environment: WorkspaceEnvironment,
): Promise<boolean> {
  if (
    (await environment.choose('Connect your Tityra account', [
      { title: 'Sign in with your browser', value: 'signin' },
      exit,
    ])) !== 'signin'
  )
    return false;
  try {
    await environment.login(context.auth, true);
    return true;
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (code === 'authorization_cancelled' || code === 'access_denied') return false;
    throw error;
  }
}

async function requestMenu(
  context: CommandContext,
  initial: Item,
  environment: WorkspaceEnvironment,
): Promise<void> {
  let request = initial;
  const auditId = id(request.id);
  for (;;) {
    const reportId =
      typeof request.reportId === 'string' && request.reportId ? request.reportId : undefined;
    const choices: Choice[] = [{ title: 'View status', value: 'status' }];
    if (reportId)
      choices.push(
        { title: 'Read report', value: 'report' },
        { title: 'View findings', value: 'findings' },
      );
    choices.push({ title: 'Payment status', value: 'payment' }, back);
    const action = await environment.choose(
      `Audit ${terminalText(request.id)} · ${terminalText(request.status)}`,
      choices,
    );
    if (!action || action === 'back') return;
    if (action === 'status') {
      const result = await load(context, `/api/agent/audits/${auditId}`);
      context.output(result);
      if (record(result) && record(result.request)) request = result.request;
    } else if (action === 'payment') {
      context.output(await load(context, `/api/agent/audits/${auditId}/payment`));
    } else if (reportId && (action === 'report' || action === 'findings')) {
      const suffix = action === 'findings' ? '/findings?page=1&pageSize=25' : '';
      context.output(await load(context, `/api/agent/reports/${id(reportId)}${suffix}`));
    }
  }
}

async function recentAudits(
  context: CommandContext,
  projectId: string,
  environment: WorkspaceEnvironment,
): Promise<void> {
  let page = 1;
  for (;;) {
    const query = new URLSearchParams({ projectId, page: String(page), pageSize: '25' });
    const result = await load(context, `/api/agent/audits?${query}`);
    const requests = items(result, 'requests');
    const choices: Choice[] = requests.map((request, index) => ({
      title: `${terminalText(request.packageName || request.id)} · ${terminalText(request.status)}`,
      value: `request:${index}`,
      description: terminalText(request.receivedAt || request.websiteUrl),
    }));
    if (!requests.length) environment.write('\nNo audit requests on this page.\n');
    if (
      record(result) &&
      record(result.pagination) &&
      result.pagination.hasMore === true &&
      page < 9999
    )
      choices.push({ title: 'Next page', value: 'next' });
    if (page > 1) choices.push({ title: 'Previous page', value: 'previous' });
    choices.push(back);
    const selected = await environment.choose(`Recent audits · page ${page}`, choices);
    if (!selected || selected === 'back') return;
    if (selected === 'next') {
      page++;
      continue;
    }
    if (selected === 'previous') {
      page--;
      continue;
    }
    const index = choices.findIndex((choice) => choice.value === selected);
    const request = requests[index];
    if (request) await requestMenu(context, request, environment);
  }
}

async function projectWorkspace(
  context: CommandContext,
  projects: Item[],
  environment: WorkspaceEnvironment,
): Promise<void> {
  for (;;) {
    if (!projects.length) {
      environment.write(
        '\nNo projects are available to this connection. Review its selected projects in Tityra.\n',
      );
      const action = await environment.choose('Your connection', [
        { title: 'Connection status', value: 'status' },
        exit,
      ]);
      if (action === 'status') {
        context.output(await environment.status(context.auth));
        continue;
      }
      return;
    }
    const selected = await environment.choose('Select a project', [
      ...projects.map((project, index) => ({
        title: terminalText(project.name || project.id),
        description: terminalText(project.website),
        value: `project:${index}`,
      })),
      exit,
    ]);
    if (!selected || selected === 'exit') return;
    const project = projects.find((_project, index) => selected === `project:${index}`);
    if (!project) return;
    const projectId = id(project.id);
    environment.write(
      `\n${terminalText(project.name || project.id)}\n${terminalText(project.website)}\n`,
    );
    for (;;) {
      const action = await environment.choose('What would you like to do?', [
        { title: 'Recent audits', value: 'audits' },
        { title: 'Audit options', value: 'options' },
        { title: 'Switch project', value: 'switch' },
        { title: 'Connection status', value: 'status' },
        exit,
      ]);
      if (!action || action === 'exit') return;
      if (action === 'switch') break;
      if (action === 'status') context.output(await environment.status(context.auth));
      else if (action === 'options')
        context.output(
          await load(context, `/api/agent/audits/options?${new URLSearchParams({ projectId })}`),
        );
      else if (action === 'audits') await recentAudits(context, projectId, environment);
    }
  }
}

/** The injectable boundary keeps prompts and OAuth out of automation and tests. */
export async function runWorkspace(
  context: CommandContext,
  version: string,
  options: Pick<GlobalOptions, 'json' | 'color'>,
  environment: WorkspaceEnvironment,
): Promise<void> {
  let status = await environment.status(context.auth);
  if (!environment.interactive || options.json) {
    context.output(status);
    return;
  }
  const choose = environment.choose.bind(environment);
  environment = {
    ...environment,
    async choose(message, choices) {
      const selected = await choose(message, choices);
      if (selected === undefined) throw new WorkspaceCancelled();
      return selected;
    },
  };
  try {
    environment.write(environment.banner(version, options.color));
    if (!status.authenticated) {
      if (!(await signIn(context, environment))) return;
      status = await environment.status(context.auth);
    }
    for (;;) {
      try {
        const projects = items(await load(context, '/api/agent/projects'), 'projects');
        await projectWorkspace(context, projects, environment);
        return;
      } catch (error) {
        const failure = error as { code?: string; status?: number };
        if (failure?.status !== 401 && failure?.code !== 'reauthorization_required') throw error;
        if (status.source === 'environment') {
          throw new CliError(
            'environment_token_rejected',
            'TITYRA_ACCESS_TOKEN was rejected. Replace or remove it before using browser sign-in; login cannot override an environment token.',
            3,
            failure.status,
          );
        }
        environment.write('\nYour connection needs to be renewed.\n');
        if (!(await signIn(context, environment))) return;
        status = await environment.status(context.auth);
      }
    }
  } catch (error) {
    if (!(error instanceof WorkspaceCancelled)) throw error;
  }
}

export async function startWorkspace(command: Command, version: string): Promise<void> {
  const options = command.optsWithGlobals<GlobalOptions>();
  await runWorkspace(createContext(command), version, options, {
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    status: authStatus,
    login: loginInteractive,
    banner: welcomeBanner,
    write: (text) => {
      process.stdout.write(text);
    },
    async choose(message, choices) {
      let cancelled = false;
      const answer = await prompts(
        { type: 'select', name: 'choice', message, choices },
        {
          onCancel: () => {
            cancelled = true;
            return false;
          },
        },
      );
      return cancelled || typeof answer.choice !== 'string' ? undefined : answer.choice;
    },
  });
}
