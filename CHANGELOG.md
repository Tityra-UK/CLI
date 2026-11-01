# Changelog

## Unreleased

- Clarify Scale and Enterprise workspace plans, annual Enterprise pricing and
  per-project weekly AX Audit monitoring in the package documentation.
- Specify that Expert Review always follows the separately paid request and checkout flow.
- Explain that `audits create` submits an additional, separately priced request;
  monitoring consent, billing assignment and subscription changes stay in Tityra.

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
