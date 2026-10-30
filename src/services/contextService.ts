import { resolve } from 'node:path';
import type { Command } from 'commander';
import type { CommandContext, GlobalOptions } from '../types.js';
import { ApiClient } from './apiClient.js';
import { getAccessToken, normalizeBaseUrl } from './authService.js';
import { CredentialStore } from './credentialStore.js';
import { createOutput } from './outputService.js';
import { positiveInteger } from '../schema/writeSchema.js';

export function createContext(command: Command): CommandContext {
  const options = command.optsWithGlobals<GlobalOptions>();
  const auth = {
    baseUrl: normalizeBaseUrl(options.baseUrl, options.baseUrl !== undefined),
    allowLocalhost: options.baseUrl !== undefined,
    store: new CredentialStore(options.configDir ? resolve(options.configDir) : undefined),
  };
  const timeout = positiveInteger(options.timeout ?? '30000', '--timeout', 120000);
  return {
    api: new ApiClient(auth.baseUrl, () => getAccessToken(auth), timeout),
    auth,
    ...createOutput(options.json, options.color),
  };
}
