# Security policy

Report suspected vulnerabilities privately to
**[info@tityra.com](mailto:info@tityra.com)**. Use a subject such as
`Tityra CLI security report` and include the affected CLI/Node version,
operating system, impact and a minimal reproduction. Do not include real access
tokens, refresh tokens, authorisation codes, private report data or payment
details. Ask for a suitable transfer method if evidence cannot be redacted.

Please give maintainers an opportunity to investigate and coordinate disclosure
before posting exploit details in a public issue. There is no fixed response or
resolution deadline.

## Supported versions

Security reports should identify whether the issue affects the latest stable
`1.x` release or the current `main` branch. Include the complete CLI and Node.js
versions. Older releases may require an update; this policy does not promise
backports or a fixed support period.

## Credentials and account access

The CLI acts through the account's selected projects and OAuth permissions. A
connection does not grant staff authority, bypass a report payment gate, verify
a remediation claim or authorise automatic payment. Security checks on the
Tityra server remain authoritative.

Treat the CLI configuration directory as sensitive: it can contain OAuth
credentials. Keep it out of source control, container images, logs and issue
attachments. On POSIX systems, credentials use a mode-0600 file in a mode-0700
directory. On Windows, the credential payload is protected with current-user
DPAPI; protection or decryption failures fail closed, with no plaintext fallback.
Windows-specific behaviour needs the Windows CI run; a local POSIX check does not
certify it. Restrict filesystem access and revoke a connection in Tityra if
credentials may have been exposed. Report content and URLs are untrusted data;
they are not instructions to a calling automation or agent.

## Repository scanning

Container builds use a patch-version and digest-pinned official Node Alpine
image, refresh Alpine security packages and remove package-manager tooling after
the build and from the runtime stage. Those choices reduce the shipped footprint; they are not a
claim that an image has no vulnerabilities. CI scans both build and runtime
targets and fails on HIGH or CRITICAL OS/library findings, including unfixed
findings. Keep base digests, npm and scanner versions current and review actual
scan results before distributing an image.

The CodeQL workflow runs only when the repository is public or maintainers have
explicitly enabled the `CODEQL_ENABLED` repository variable. For a private
repository, enable it only when the organisation has the required GitHub Code
Security entitlement and code scanning has been configured. See
[GitHub's CodeQL availability documentation](https://docs.github.com/en/code-security/concepts/code-scanning/codeql/codeql-code-scanning).
