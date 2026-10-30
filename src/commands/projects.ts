import type { Command } from 'commander';
import type { ContextFactory } from '../types.js';
import { read } from './shared.js';

export function registerProjectsCommands(program: Command, context: ContextFactory): void {
  program
    .command('projects')
    .description('Read the projects selected for this connection')
    .command('list')
    .description('List accessible projects')
    .action(async (_options: unknown, command: Command) => {
      await read(command, context, '/api/agent/projects', 'Loading projects');
    });
}
