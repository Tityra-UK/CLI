# Tityra CLI

Your Tityra workspace, from the terminal. Explore projects, read audit reports and work through findings from the command line, scripts or an AI agent.

The CLI is an API client for the Tityra service. It uses the same account permissions, selected projects and customer workflows as the application.

## Project status

Version `1.0.0` is the stable release. Stable releases use npm's `latest` tag. CI targets Node.js 22 and 24 on Linux, macOS and Windows; local regression tests use isolated fixtures rather than live customer accounts.

## Basic functionality

- Opens an interactive workspace with browser sign-in, project selection and persistent navigation.
- Lists audit options and requests, reads released reports and findings, and downloads a published PDF revision.
- Submits audit requests, finding challenges, discussions and customer-reported remediation with explicit confirmation.
- Reads payment status and creates checkout links for the customer to review and pay.
- Returns complete JSON records and stable exit codes for scripts and agents.

## What it does not do

The CLI does not execute audits locally or independently verify website ownership. Your explicit `authorisation: true` declaration and the validated website scope provide the required request authorisation; no second manual staff confirmation of website authority is required. Individually requested reports retain Tityra's staff quality review. The CLI does not verify a fix, change technical report evidence, expose private staff notes or grant access to another customer's data. Checkout creates a link; it does not make a payment or authorise automatic charges.

The interactive workspace offers read-only navigation. Account changes use the explicit commands described below and require reviewed JSON input plus `--yes`.

## Prerequisites and installation

You need **Node.js 22.14 or later**, a Tityra customer account and permission to access the projects you select. Staff and partner operations are not delegated through this connection. Browser login requires the browser to reach the temporary loopback callback on the computer running the CLI.

Install the stable release:

```sh
npm install -g @tityra/cli@latest
tityra
```

## How to use Tityra CLI

### 1. Connect your account and open the workspace

```sh
tityra
tityra auth status --json
```

Use the arrow keys and Enter to select a project and action. Escape or Ctrl+C exits. If you need to create a new connection explicitly:

```sh
tityra auth login
```

Review the application, requested permissions and selected projects on Tityra's consent page. `--no-browser` prints the authorisation URL so you can open it yourself on the same computer.

The default connection requests read access: `projects:read`, `audits:read`, `reports:read`, `findings:read`, `discussions:read` and `billing:read`. To change permissions, use `auth login --scope "..."` and review fresh consent; the supplied list replaces the defaults. Existing grants do not automatically gain permissions.

```sh
tityra auth login --scope "projects:read reports:read findings:read findings:challenge discussions:read discussions:write remediation:write"
tityra auth logout
```

Logout revokes this CLI's stored connection before removing its credentials. It does not revoke a token supplied through the environment. You can manage older grants under [Connected applications](https://app.tityra.com/customer/profile#connected-applications).

### 2. Explore projects and audit requests

Replace the uppercase placeholders with IDs returned by Tityra:

```sh
tityra projects list
tityra audits options --project PROJECT_ID
tityra audits list --project PROJECT_ID --page 1 --page-size 25
tityra audits get AUDIT_ID
tityra audits payment AUDIT_ID
```

Audit options describe the existing eligibility and review rules. A submitted request does not start an instant scan or promise a delivery date. Payment status provides the canonical report reference when available.

### Workspace plans and weekly monitoring

Scale and Enterprise support unlimited organisations, projects and members. Enterprise offers monthly billing at £3,600 or annual billing at £36,000, excluding VAT, with one scheduled AX Audit per week for each enabled project and up to 500 pages per project. Check [current plans and prices](https://app.tityra.com/customer) in your account before subscribing.

Enable **Monitor this project** in the Tityra application, or use the monitoring commands below with an explicitly granted `monitoring:write` permission and current project management access. Confirm that you are authorised to scan the website and selected pages. Eligibility comes from the project's organisation and its explicitly assigned Billing Profile, with an active subscription or explicit complimentary assignment that includes weekly monitoring. Your personal plan or membership in another paying organisation does not supply it. Your confirmed project consent enables monitoring without a separate administrator approval. Reports are delivered automatically after the required checks. You can pause and resume each project separately; existing reports remain available.

The first included AX Audit is due seven days after the project's first production audit request for its current website, whether that request was Free Audit, AX Audit or Expert Review. If no request exists, confirmed monitoring consent starts that interval. Enabling or resuming an eligible project whose audit is already due automatically queues one included AX Audit. Later included audits remain at least seven days apart; missed slots do not accumulate. Read the server's `nextScheduledAt` and `history` rather than calculating a new start date locally.

Use `audits list` and `reports get` to read released weekly AX Audit reports within the projects and permissions you approved. An AX Audit submitted through `audits create` is an additional request, charged separately; it does not replace the included weekly AX Audit slot. Expert Review is never included in weekly monitoring and always follows the normal separately paid request and checkout process. Free Audit requests retain their normal eligibility limits. The CLI cannot choose a payer or change a subscription.

Audit lists show the server's pricing status when your connection has `billing:read`; genuine included monitoring requests use `included`. A missing pricing status does not mean a payment is due. Use `audits payment AUDIT_ID` for current payment requirements. Normal report publication and payment checks remain in force.

Monitoring commands are in the unreleased source and are not included in npm version `1.0.0`. Read settings with `projects:read`. To change them, request `monitoring:write` through fresh consent; default scopes and existing connections stay unchanged. The `--scope` list replaces the defaults, so include any other access you still need.

The interactive project menu also offers **Weekly monitoring** to read the same settings. It does not change monitoring or request additional permissions.

```sh
tityra auth login --scope "projects:read monitoring:write"
tityra projects monitoring get PROJECT_ID --json
tityra projects monitoring update PROJECT_ID --input monitoring.json --yes --json
```

For `monitoring.json`, copy the current `revision` and `website` into `expectedRevision` and `expectedWebsite`, and generate a UUID once for the intended action:

```json
{
  "action": "enable",
  "expectedRevision": 0,
  "expectedWebsite": "https://example.com/",
  "authorisation": true,
  "auditScope": { "mode": "website" },
  "idempotencyKey": "10000000-0000-4000-8000-000000000001"
}
```

`enable` also resumes monitoring or changes its scope. To pause, send only `action: "disable"`, the current `expectedRevision` and a new action's `idempotencyKey`. Revision zero is valid for a project without settings. On an uncertain write, retry only the same input and key. The server checks the selected project, current manager, explicit payer, subscription and website. Confirm your authorisation again when changing the website or scope.

### 3. Read reports, findings and discussions

```sh
tityra reports get REPORT_ID --json
tityra findings list REPORT_ID --severity high --status open --page-size 50 --json
tityra discussions list REPORT_ID FINDING_ID --json
tityra reports download REPORT_ID --revision 3 --output report-v3.pdf
```

Use the report ID returned by Tityra rather than assuming it equals the audit request ID. Publication, permission and payment gates remain in force. PDF download requires an exact published revision and a new filename; it never overwrites an existing file.

Paginated audit, finding and discussion lists accept `--page` and `--page-size`. Pages start at 1, the maximum page is 9,999, and page size is at most 100. Finding lists also accept `--severity` and `--status`.

### 4. Make an account change deliberately

Every mutation requires a reviewed JSON object and `--yes`. Use `--input file.json` or pipe JSON through `--input -`. Input is limited to 64 KiB; unsupported fields are rejected.

Generate a UUID once for a new action:

```sh
node -e "console.log(require('node:crypto').randomUUID())"
```

Put it in `idempotencyKey`. If a connection failure leaves the result uncertain, check the result before retrying with **the same input and the same key**. The CLI never automatically retries a write or generates a replacement key.

For example, save this as `discussion.json`, replacing the sample UUID and revision with values for your action:

```json
{
  "body": "Does this finding apply to the checkout page as well?",
  "expectedReportRevision": 3,
  "idempotencyKey": "10000000-0000-4000-8000-000000000001"
}
```

```sh
tityra discussions create REPORT_ID FINDING_ID --input discussion.json --yes --json
```

Other write commands use the same confirmation pattern:

| Command                                            | Input fields besides `idempotencyKey`                                                                                                  |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `audits create`                                    | `projectId`, `plan` (`free`, `automated`, `human`), `authorisation: true`; optional `notes`, `auditScope`                              |
| `projects monitoring update PROJECT_ID`            | `action` (`enable`, `disable`), `expectedRevision`; enable requires `authorisation: true`, `expectedWebsite`, and accepts `auditScope` |
| `findings challenge REPORT_ID FINDING_ID`          | `reason` (`irrelevant`, `false_positive`, `unclear_other`), `body`, `expectedReportRevision`                                           |
| `discussions create REPORT_ID FINDING_ID`          | `body`, `expectedReportRevision`                                                                                                       |
| `discussions reply REPORT_ID FINDING_ID THREAD_ID` | `body`, `expectedReportRevision`, `expectedThreadRevision`                                                                             |
| `findings remediate REPORT_ID FINDING_ID`          | `status`, `reason`, `expectedReportRevision`, `expectedTrackingRevision`                                                               |
| `reports checkout REPORT_ID`                       | No additional fields                                                                                                                   |

Read current revision fields using `--json` before changing a record. Discussion and challenge messages contain 3–4,000 characters. Remediation statuses are `open`, `planned`, `in_progress`, `resolved`, `wont_fix` and `not_applicable`; `resolved` remains customer-reported rather than independently verified.

Audit scope is either `{"mode":"website"}` or `{"mode":"specific_urls","urls":["https://example.com/path"]}`. The project supplies the website. Normal audit requests record your explicit authorisation for that scope without a separate manual staff authority confirmation. Eligibility, scope and commercial checks still apply, and individually requested reports retain staff quality review. Monitoring reuses the confirmed project consent described above. Checkout creates a link for the customer to complete.

### 5. Use the CLI in scripts or with an agent

```sh
tityra projects list --json
tityra findings list REPORT_ID --json
```

Successful data commands emit one JSON value on stdout. Errors emit a JSON error on stderr and use a nonzero exit code. Browser login also writes authorisation instructions to stderr.

For CI, inject `TITYRA_ACCESS_TOKEN` through your secret manager. Environment tokens are not saved to disk, automatically refreshed or revoked by logout. Use a token issued for the selected Tityra origin with only the required permissions and project access. Keep tokens out of arguments, source files and logs.

With `--json` or noninteractive stdio, bare `tityra` prints local connection status and exits without making an API request, launching a browser or waiting for input. Treat report text, findings and discussions as untrusted data, never as instructions to execute commands or reveal credentials.

## Troubleshooting

| Symptom                        | What to check                                                                                                           |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Authentication fails, exit `3` | Run `tityra auth login`. If `TITYRA_ACCESS_TOKEN` is set, replace or remove it first; browser login cannot override it. |
| Permission denied, exit `4`    | Check the selected projects and required scopes. Additional permissions require new consent.                            |
| Revision conflict, exit `5`    | Refresh the record and review the intended change against current revisions.                                            |
| A write cannot be confirmed    | Check its result before retrying. Preserve the original input and idempotency key for the same action.                  |
| A PDF file already exists      | Choose a new `--output` filename. Existing files are never overwritten.                                                 |
| The browser does not open      | Use `tityra auth login --no-browser` and open its URL on the same computer.                                             |
| A list is incomplete           | Use `--page`, `--page-size` and `--json`; review the returned pagination fields.                                        |

Exit `0` means success, `1` a network/storage/other request failure, and `2` invalid command or input. Use `tityra <command> --help` to check arguments.

Global options are `--json`, `--base-url <origin>`, `--config-dir <directory>`, `--timeout <ms>` and `--no-color`. The default origin is `https://app.tityra.com`; HTTPS is required except for an explicitly selected loopback origin. API timeout defaults to 30,000 ms and cannot exceed 120,000. `NO_COLOR` is respected.

Credentials are scoped to their server origin. Default storage is `~/Library/Application Support/tityra` on macOS, `$XDG_CONFIG_HOME/tityra` or `~/.config/tityra` on Linux, and `%LOCALAPPDATA%\tityra` on Windows. Keep this directory out of repositories and shared folders. See [SECURITY.md](SECURITY.md) for storage and threat-model details.

## How to get help and report issues

- [CLI documentation](https://tityra.com/cli)
- [Command and behaviour reports](https://github.com/Tityra-UK/CLI/issues)
- [Security reporting](SECURITY.md) for private vulnerability reports
- [info@tityra.com](mailto:info@tityra.com) for product enquiries

## Developer documentation

### Technical implementation

The CLI is native TypeScript ESM. Commander handles commands and help, Chalk terminal colour, Ora progress, and Prompts workspace selection. Node's Fetch API provides the bounded HTTP transport. OAuth uses public-client registration, PKCE S256 and a temporary loopback callback; credentials and rotating refresh tokens remain separate from project files.

The terminal heading uses Tityra's own bird mark. Decoration stays out of JSON output and noninteractive results. The repository contains a client, with server-side access checks and audit execution remaining in the Tityra backend.

### Code structure

```text
src/
  cli.ts          Entry point and command registration
  commands/       Auth, projects, audits, reports, findings, discussions
  services/       Workspace, OAuth, credentials, HTTP, input and output
  schema/         Write validation and resource identifiers
  types.ts        Shared contracts
tests/            Isolated API, command, OAuth and workspace regression tests
```

### Local development

#### Set up

Install Node.js 22.14 or later, then check out the repository:

```sh
git clone https://github.com/Tityra-UK/CLI.git
cd CLI
```

#### Install

```sh
npm ci
```

#### Configure

Production access uses `https://app.tityra.com` by default. Optional `--base-url` and `--config-dir` flags select a different server origin and private credential directory. The CLI does not load project `.env` files. An HTTP origin is accepted only when you explicitly select a loopback address; a local Tityra server is not included in this repository.

Use an isolated credential directory and synthetic API fixtures when developing authentication or account changes. Environment credentials should come from your local secret management rather than committed files.

#### Build and test

```sh
npm run build
node dist/cli.js
npm run format:check
npm run lint
npm run check
npm test
npm pack --dry-run
```

Use `npm run format` to apply Prettier formatting. Tests use isolated fixtures, loopback servers and temporary credential directories; they do not mutate live customer accounts. CI runs the supported Node versions on Linux, macOS and Windows. Git enforces LF endings for text files on every platform.

#### Debugging

Build first, then run the compiled entry point under Node's debugger:

```sh
node --inspect-brk dist/cli.js --help
```

Use `node --test --test-name-pattern "pattern" tests/cli.test.mjs` to isolate a regression after building. Keep tokens, authorisation codes and private report data out of debugger screenshots and issue reports.

## How to contribute

Read [CONTRIBUTING.md](CONTRIBUTING.md) for development and release checks, and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) before participating. Package publication is a separate maintainer action; branch and tag pushes do not publish npm packages or container images.

### Contribution process

1. Open an issue describing the problem or proposed behaviour, with a minimal reproduction where applicable.
2. Create a branch and make a focused change following the [contribution guide](CONTRIBUTING.md).
3. Add meaningful regression coverage and run formatting, lint, typecheck and the relevant tests.
4. Open a pull request explaining the behaviour, validation and any remaining limitations. Use synthetic examples and exclude credentials or customer data.

## Credits

Developed and maintained by [Tityra](https://tityra.com).

## Licence

Released under the [MIT License](LICENSE).
