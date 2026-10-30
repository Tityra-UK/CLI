#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Command, CommanderError } from 'commander';
import { registerAuthCommands } from './commands/auth.js';
import { registerProjectsCommands } from './commands/projects.js';
import { registerAuditsCommands } from './commands/audits.js';
import { registerReportsCommands } from './commands/reports.js';
import { registerFindingsCommands } from './commands/findings.js';
import { registerDiscussionsCommands } from './commands/discussions.js';
import { createContext } from './services/contextService.js';
import { CliError } from './services/errors.js';
import { AuthError } from './services/authService.js';
import { CredentialError } from './services/credentialStore.js';
import { terminalText } from './services/outputService.js';
import { welcomeBanner } from './services/brandingService.js';
import { startWorkspace } from './services/workspaceService.js';

const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};
const program = new Command()
  .name('tityra')
  .description(
    'Your Tityra workspace, from the terminal.\nExplore projects, request audits, and work through findings.',
  )
  .version(metadata.version)
  .option('--json', 'Emit complete JSON results; write JSON errors to stderr')
  .option('--base-url <origin>', 'Tityra server origin (default: https://app.tityra.com)')
  .option('--config-dir <directory>', 'Override the private credential directory')
  .option('--timeout <ms>', 'API request timeout in milliseconds, up to 120000', '30000')
  .option('--no-color', 'Disable terminal colours')
  .showSuggestionAfterError(false)
  .exitOverride()
  .configureOutput({ writeErr: () => undefined, outputError: () => undefined })
  .addHelpText('before', () =>
    welcomeBanner(metadata.version, !process.argv.includes('--no-color')),
  )
  .addHelpText(
    'after',
    `
Get started:
  tityra
  tityra projects list
  tityra findings list <report-id> --json

Account changes require --input <file.json> and --yes.
Run tityra <command> --help for its available actions.
Documentation: https://tityra.com/connected-agents
`,
  );

for (const register of [
  registerAuthCommands,
  registerProjectsCommands,
  registerAuditsCommands,
  registerReportsCommands,
  registerFindingsCommands,
  registerDiscussionsCommands,
])
  register(program, createContext);

program.action(async (_options, command: Command) => startWorkspace(command, metadata.version));

try {
  await program.parseAsync();
} catch (error) {
  if (error instanceof CommanderError && error.exitCode === 0) process.exitCode = 0;
  else {
    const known =
      error instanceof CliError || error instanceof AuthError || error instanceof CredentialError;
    const code = known
      ? error.code
      : error instanceof CommanderError
        ? 'invalid_arguments'
        : 'unexpected_error';
    const message = known
      ? error.message
      : error instanceof CommanderError
        ? 'Invalid command or options. Run tityra --help for usage.'
        : 'The command could not be completed.';
    const status =
      error instanceof CliError || error instanceof AuthError ? error.status : undefined;
    process.exitCode =
      error instanceof CliError
        ? error.exitCode
        : error instanceof CommanderError
          ? 2
          : error instanceof AuthError
            ? 3
            : 1;
    if (process.argv.includes('--json'))
      process.stderr.write(
        JSON.stringify({ error: { code, message, ...(status ? { status } : {}) } }) + '\n',
      );
    else process.stderr.write(`Tityra: ${terminalText(message)}\n`);
  }
}
