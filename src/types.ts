import type { Command } from 'commander';
import type { ApiClient } from './services/apiClient.js';
import type { CredentialStore } from './services/credentialStore.js';

export interface GlobalOptions {
  json?: boolean;
  baseUrl?: string;
  configDir?: string;
  timeout?: string;
  color?: boolean;
}
export interface CommandContext {
  api: ApiClient;
  auth: { baseUrl: string; allowLocalhost: boolean; store: CredentialStore };
  output(data: unknown): void;
  run<T>(label: string, work: () => Promise<T>): Promise<T>;
}
export type ContextFactory = (command: Command) => CommandContext;
