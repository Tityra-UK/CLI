import { CliError } from './errors.js';

export async function boundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new CliError(
          'response_too_large',
          'The server response exceeded the CLI size limit.',
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

export class ApiClient {
  constructor(
    private baseUrl: string,
    private token: () => Promise<string>,
    private timeoutMs = 30_000,
  ) {}

  async request(
    path: string,
    method = 'GET',
    body?: Record<string, unknown>,
    pdf = false,
  ): Promise<unknown> {
    let destination: URL;
    try {
      destination = new URL(path, this.baseUrl);
    } catch {
      throw new CliError('invalid_destination', 'Choose a Tityra account API endpoint.');
    }
    const pathname = path.split('?')[0];
    if (
      !path.startsWith('/api/agent/') ||
      path.includes('#') ||
      destination.origin !== this.baseUrl ||
      destination.pathname !== pathname ||
      !destination.pathname.startsWith('/api/agent/') ||
      /%(?:2f|5c)/i.test(destination.pathname)
    ) {
      throw new CliError('invalid_destination', 'Choose a Tityra account API endpoint.');
    }
    const token = await this.token();
    let response: Response;
    try {
      response = await fetch(destination, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          Accept: pdf ? 'application/pdf' : 'application/json',
          Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new CliError(
        'connection_failed',
        method === 'GET'
          ? 'Could not reach Tityra. Check your connection and try again.'
          : 'The write could not be confirmed. Check its result before retrying with the SAME input and idempotency key.',
      );
    }
    let bytes: Uint8Array;
    try {
      bytes = await boundedBody(response, pdf && response.ok ? 32 * 1024 * 1024 : 8 * 1024 * 1024);
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError(
        'incomplete_response',
        'The response was interrupted. For writes, retry only with the same input and idempotency key.',
      );
    }
    if (pdf && response.ok) {
      if (
        !response.headers.get('content-type')?.startsWith('application/pdf') ||
        !Buffer.from(bytes).subarray(0, 5).equals(Buffer.from('%PDF-'))
      ) {
        throw new CliError('invalid_response', 'Tityra did not return a PDF document.');
      }
      return bytes;
    }
    if (!response.ok) {
      const message =
        response.status === 401
          ? 'Your session expired or was revoked. Run tityra auth login.'
          : response.status === 403
            ? 'Your connection does not have permission for this project or action. Review its scopes and project access.'
            : response.status === 402
              ? 'Payment is required before this report is available.'
              : response.status === 409
                ? 'The report or discussion changed. Read the latest revision and review your input before retrying.'
                : response.status === 429
                  ? 'Tityra rate limited this request. Wait before retrying; preserve the idempotency key for writes.'
                  : response.status === 404
                    ? 'This resource was not found or is not available to your connection.'
                    : response.status >= 500
                      ? 'Tityra could not complete the request. For writes, verify the outcome before retrying with the same key.'
                      : 'Tityra rejected the request. Check the command input against the documented API fields.';
      throw new CliError(
        `http_${response.status}`,
        message,
        response.status === 401 ? 3 : response.status === 403 ? 4 : response.status === 409 ? 5 : 1,
        response.status,
      );
    }
    let data: unknown;
    try {
      data = JSON.parse(Buffer.from(bytes).toString('utf8'));
    } catch {
      throw new CliError(
        'invalid_response',
        `Tityra returned an unreadable response (HTTP ${response.status}).`,
      );
    }
    return data;
  }
}
