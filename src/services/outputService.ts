import { stripVTControlCharacters } from 'node:util';
import { Chalk } from 'chalk';
import ora from 'ora';

export function terminalText(value: unknown): string {
  let text: string;
  try {
    text =
      value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
  } catch {
    text = '[unprintable value]';
  }
  return stripVTControlCharacters(text).replace(
    /[\x00-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069]/g,
    ' ',
  );
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const humanJson = (value: unknown): string =>
  stripVTControlCharacters(JSON.stringify(value, null, 2) ?? 'null').replace(
    /[\u2028-\u202e\u2066-\u2069]/g,
    ' ',
  );
export function createOutput(json = false, color = true) {
  const paint = new Chalk({
    level: color && process.stdout.isTTY && !('NO_COLOR' in process.env) ? 1 : 0,
  });
  return {
    output(data: unknown) {
      if (json) {
        process.stdout.write(JSON.stringify(data) + '\n');
        return;
      }
      const value = record(data) ? data : null;
      const candidates: unknown[] | undefined = value
        ? ['projects', 'requests', 'findings', 'threads']
            .map((key) => value[key])
            .find(Array.isArray)
        : undefined;
      if (!candidates || !candidates.every(record)) {
        process.stdout.write(humanJson(data) + '\n');
        return;
      }
      const rows = candidates;
      if (!rows.length) {
        process.stdout.write(paint.dim('No results.\n'));
        return;
      }
      const keys = [
        'id',
        'threadId',
        'title',
        'name',
        'status',
        'severity',
        'pricingStatus',
      ].filter((key) => rows.some((row) => row[key] !== undefined));
      if (!keys.length) {
        process.stdout.write(humanJson(data) + '\n');
        return;
      }
      const widths = keys.map((key) =>
        rows.reduce(
          (width, row) => Math.min(60, Math.max(width, [...terminalText(row[key])].length)),
          key.length,
        ),
      );
      const rowText = (row: Record<string, unknown>) =>
        keys
          .map((key, index) => {
            const width = widths[index]!;
            const value = [...terminalText(row[key])];
            return (
              value.length > width ? value.slice(0, width - 1).join('') + '…' : value.join('')
            ).padEnd(width);
          })
          .join('  ')
          .trimEnd();
      process.stdout.write(
        paint.bold(
          rowText(
            Object.fromEntries(
              keys.map((key) => [key, key === 'pricingStatus' ? 'PRICING' : key.toUpperCase()]),
            ),
          ),
        ) + '\n',
      );
      for (const row of rows) process.stdout.write(rowText(row) + '\n');
      if (value?.pagination && typeof value.pagination === 'object') {
        const pagination = value.pagination as Record<string, unknown>;
        process.stdout.write(
          paint.dim(
            `\nPage ${terminalText(pagination.page)}: ${terminalText(pagination.total)} total${pagination.hasMore ? ', more available' : ''}\n`,
          ),
        );
      }
      process.stdout.write(paint.dim('Use --json for complete records and revision fields.\n'));
    },
    async run<T>(label: string, work: () => Promise<T>): Promise<T> {
      const spinner =
        !json && process.stderr.isTTY && !process.env.CI
          ? ora({ text: label, stream: process.stderr, color: 'red' }).start()
          : undefined;
      try {
        const result = await work();
        spinner?.stop();
        return result;
      } catch (error) {
        spinner?.stop();
        throw error;
      }
    },
  };
}
