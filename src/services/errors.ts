export class CliError extends Error {
  constructor(
    public code: string,
    message: string,
    public exitCode = 1,
    public status?: number,
  ) {
    super(message);
    this.name = 'CliError';
  }
}
export function usage(message: string): never {
  throw new CliError('invalid_arguments', message, 2);
}
