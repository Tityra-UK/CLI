import { usage } from '../services/errors.js';

export type WriteKind = 'audit' | 'challenge' | 'discussion' | 'reply' | 'remediation' | 'checkout';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const statuses = [
  'open',
  'planned',
  'in_progress',
  'resolved',
  'wont_fix',
  'not_applicable',
];
export function identifier(value: string, finding = false): string {
  if (
    !(finding ? /^[a-zA-Z0-9_.:-]{1,100}$/ : /^[a-zA-Z0-9_-]{1,100}$/).test(value) ||
    value === '.' ||
    value === '..'
  )
    usage('Provide a valid resource ID, not a URL or path.');
  return encodeURIComponent(value);
}
export function positiveInteger(
  value: string,
  name: string,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < 1 || n > max)
    usage(`${name} must be an integer from 1 to ${max}.`);
  return n;
}
export function validateWrite(kind: WriteKind, input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    usage('--input must contain a JSON object.');
  const body = input as Record<string, unknown>;
  const fields: Record<WriteKind, string[]> = {
    audit: ['projectId', 'plan', 'idempotencyKey', 'authorisation', 'notes', 'auditScope'],
    challenge: ['reason', 'body', 'expectedReportRevision', 'idempotencyKey'],
    discussion: ['body', 'expectedReportRevision', 'idempotencyKey'],
    reply: ['body', 'expectedReportRevision', 'expectedThreadRevision', 'idempotencyKey'],
    remediation: [
      'status',
      'reason',
      'expectedReportRevision',
      'expectedTrackingRevision',
      'idempotencyKey',
    ],
    checkout: ['idempotencyKey'],
  };
  if (Object.keys(body).some((key) => !fields[kind].includes(key)))
    usage('Input contains an unsupported field. Use the documented request body.');
  if (typeof body.idempotencyKey !== 'string' || !uuid.test(body.idempotencyKey))
    usage(
      'Provide a UUIDv4 idempotencyKey in --input. Keep it unchanged when retrying the same action.',
    );
  const text = (key: string, min: number, max: number) => {
    if (typeof body[key] !== 'string' || body[key].length < min || body[key].length > max)
      usage(`${key} must contain ${min}–${max} characters.`);
  };
  const revision = (key: string) => {
    if (!Number.isSafeInteger(body[key]) || Number(body[key]) < 1)
      usage(`${key} must be a positive integer from the current server response.`);
  };
  if (kind === 'audit') {
    if (typeof body.projectId !== 'string') usage('projectId is required.');
    identifier(body.projectId);
    if (!['free', 'automated', 'human'].includes(String(body.plan)))
      usage('plan must be free, automated or human.');
    if (typeof body.plan !== 'string' || body.authorisation !== true)
      usage('Audit requests require a plan and explicit authorisation: true.');
    if (body.notes !== undefined) text('notes', 0, 20000);
    if (body.auditScope !== undefined) {
      if (!body.auditScope || typeof body.auditScope !== 'object' || Array.isArray(body.auditScope))
        usage('auditScope must be an object.');
      const scope = body.auditScope as Record<string, unknown>;
      if (scope.mode === 'website') {
        if (Object.keys(scope).length !== 1) usage('Website auditScope accepts only mode.');
      } else if (scope.mode === 'specific_urls') {
        if (
          Object.keys(scope).some((k) => !['mode', 'urls'].includes(k)) ||
          !Array.isArray(scope.urls) ||
          scope.urls.length < 1 ||
          scope.urls.length > 500 ||
          scope.urls.some((url) => typeof url !== 'string' || !url.length || url.length > 2000)
        )
          usage('specific_urls requires 1–500 URL strings.');
      } else usage('auditScope.mode must be website or specific_urls.');
    }
  } else if (kind !== 'checkout') {
    revision('expectedReportRevision');
    if (kind === 'remediation') {
      revision('expectedTrackingRevision');
      text('reason', 0, 4000);
      if (typeof body.status !== 'string' || !statuses.includes(body.status))
        usage(`status must be one of ${statuses.join(', ')}.`);
    } else {
      text('body', 3, 4000);
      if (kind === 'reply') revision('expectedThreadRevision');
      if (
        kind === 'challenge' &&
        (typeof body.reason !== 'string' ||
          !['irrelevant', 'false_positive', 'unclear_other'].includes(body.reason))
      )
        usage('reason must be irrelevant, false_positive or unclear_other.');
    }
  }
  return body;
}
