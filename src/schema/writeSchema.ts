import { usage } from '../services/errors.js';

export type WriteKind =
  'audit' | 'challenge' | 'discussion' | 'reply' | 'remediation' | 'checkout' | 'monitoring';
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
    monitoring: [
      'action',
      'expectedRevision',
      'idempotencyKey',
      'authorisation',
      'expectedWebsite',
      'auditScope',
    ],
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
  if (kind === 'monitoring') {
    if (!['enable', 'disable'].includes(String(body.action)))
      usage('Monitoring action must be enable or disable. Authority approval stays in Tityra.');
    if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0)
      usage(
        'expectedRevision must be a non-negative integer from the current monitoring response.',
      );
    if (body.action === 'enable') {
      if (body.authorisation !== true)
        usage('Enabling monitoring requires explicit authorisation: true.');
      text('expectedWebsite', 1, 2000);
      let website: URL;
      try {
        website = new URL(body.expectedWebsite as string);
      } catch {
        usage('expectedWebsite must be the website returned by the monitoring response.');
      }
      if (!['http:', 'https:'].includes(website.protocol) || website.username || website.password)
        usage('expectedWebsite must be an HTTP(S) website without credentials.');
      validateAuditScope(body.auditScope);
    } else if (
      body.authorisation !== undefined ||
      body.expectedWebsite !== undefined ||
      body.auditScope !== undefined
    )
      usage('Pausing monitoring accepts only action, expectedRevision and idempotencyKey.');
  } else if (kind === 'audit') {
    if (typeof body.projectId !== 'string') usage('projectId is required.');
    identifier(body.projectId);
    if (!['free', 'automated', 'human'].includes(String(body.plan)))
      usage('plan must be free, automated or human.');
    if (typeof body.plan !== 'string' || body.authorisation !== true)
      usage('Audit requests require a plan and explicit authorisation: true.');
    if (body.notes !== undefined) text('notes', 0, 20000);
    validateAuditScope(body.auditScope);
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

function validateAuditScope(value: unknown): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    usage('auditScope must be an object.');
  const scope = value as Record<string, unknown>;
  if (scope.mode === 'website') {
    if (Object.keys(scope).length !== 1) usage('Website auditScope accepts only mode.');
  } else if (scope.mode === 'specific_urls') {
    if (
      Object.keys(scope).some((key) => !['mode', 'urls'].includes(key)) ||
      !Array.isArray(scope.urls) ||
      scope.urls.length < 1 ||
      scope.urls.length > 500 ||
      scope.urls.some((url) => typeof url !== 'string' || !url.length || url.length > 2000)
    )
      usage('specific_urls requires 1–500 URL strings.');
  } else usage('auditScope.mode must be website or specific_urls.');
}
