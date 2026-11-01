# Changelog

## Unreleased

- Clarify that audit requests use explicit authorisation and validated scope without a second manual staff authority confirmation, while retaining report quality and commercial checks.
- Add selected-project monitoring reads and confirmed enable, pause, resume and scope changes.
- Require a new explicit `monitoring:write` grant for changes, preserving revision checks and stable retry keys.
- Explain that confirmed website and scope authorisation enables monitoring without separate administrator approval.
- Expose monitoring settings in the interactive project menu without adding write permissions.
- Show server-provided pricing status, including genuine included weekly audits, in audit tables.
- Clarify the first-request schedule, automatic admission of overdue audits and organisation Billing Profile eligibility.
- Clarify Scale and Enterprise workspace plans, monthly and annual Enterprise pricing and
  per-project weekly AX Audit monitoring in the package documentation.
- Specify that Expert Review always follows the separately paid request and checkout flow.
- Explain that AX Audit and Expert Review requests submitted with `audits create` are separately priced;
  billing assignment and subscription changes stay in the Tityra application.

## 1.0.0

- Stable `@tityra/cli` release, version `1.0.0`, distributed through npm's `latest` tag.
- TypeScript/ESM tooling for Node.js 22.14 and later.
- Interactive workspace with session checks, project selection and Tityra's bird mark.
- Scoped OAuth/PKCE login, credential protection and rotating refresh tokens.
- Commands for audits, reports, finding challenges, discussions and remediation,
  with JSON output, explicit mutation confirmation and revision safeguards.
- Repository policies, cross-platform checks and a non-root container build.
- Explicit maintainer-triggered npm publishing through OIDC trusted publishing.
- Authenticated release archive verification that preserves every TAR byte,
  including file modes, with read-only verification of existing release tags.
