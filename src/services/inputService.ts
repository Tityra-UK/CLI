import { constants } from 'node:fs';
import { open, stat as inspect } from 'node:fs/promises';
import { CliError, usage } from './errors.js';
import { validateWrite, type WriteKind } from '../schema/writeSchema.js';

const limit = 64 * 1024;
export async function writeInput(
  kind: WriteKind,
  options: { input?: string; yes?: boolean },
): Promise<Record<string, unknown>> {
  if (options.yes !== true)
    usage('This command changes your account. Review the input and pass --yes to confirm.');
  if (!options.input) usage('Provide --input <file.json> or --input - for piped JSON.');
  let bytes: Buffer;
  if (options.input === '-') {
    if (process.stdin.isTTY) usage('Pipe JSON to --input -, or provide an input file.');
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of process.stdin) {
      const part = Buffer.from(chunk);
      total += part.length;
      if (total > limit) usage('Input must not exceed 64 KiB.');
      chunks.push(part);
    }
    bytes = Buffer.concat(chunks, total);
  } else {
    let handle;
    try {
      const candidate = await inspect(options.input);
      if (!candidate.isFile() || candidate.size > limit)
        usage('Input must be a regular JSON file of at most 64 KiB.');
      // A preflight check avoids special files; nonblocking open also protects a
      // regular file replaced with a FIFO between that check and opening it.
      handle = await open(options.input, constants.O_RDONLY | (constants.O_NONBLOCK || 0));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > limit)
        usage('Input must be a regular JSON file of at most 64 KiB.');
      const buffer = Buffer.alloc(limit + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const result = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (!result.bytesRead) break;
        offset += result.bytesRead;
      }
      bytes = buffer.subarray(0, offset);
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError('input_unreadable', 'The input file could not be read.');
    } finally {
      await handle?.close();
    }
  }
  if (bytes.length > limit) usage('Input must not exceed 64 KiB.');
  let input: unknown;
  try {
    input = JSON.parse(bytes.toString('utf8'));
  } catch {
    usage('The input is not valid JSON.');
  }
  return validateWrite(kind, input);
}
