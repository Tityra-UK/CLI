## Tityra CLI

Read a website audit in your terminal. You can look up a project, see the evidence behind a finding and ask your audit team a question. Scripts can read the same results as JSON.

Project status: Actively maintained.

### Basic functionality

Tityra CLI is for people who already use Tityra to manage website audits. Choose a project from your account to see its audit requests, read the evidence for a finding or download a published report. If you manage findings, you can also start a discussion or record progress on a fix. For the API and source layout, see the [developer documentation](#developer-documentation).

### What Tityra CLI does not do

The CLI cannot scan a website locally or verify that a fix works. Tityra runs the audits. You buy credits and approve spending in the Tityra app.

## Prerequisites

You need a terminal, Node.js 22.14 or later with npm, and a Tityra customer account with access to a project. Have a browser available on the computer where you run the CLI.

## How to use Tityra CLI

### Install, sign in and choose a project

1. Install the CLI with `npm install -g @tityra/cli`.
2. Run `tityra` in your terminal. On your first visit, it offers to open Tityra in your browser.
3. Sign in, select the projects you want to work with and review the permissions.
4. Return to your terminal. Use the arrow keys and Enter to choose a project and browse its audits. To use individual commands, leave the menu and run `tityra projects list` to find your project ID.

### Find a report and save its PDF

1. Replace `PROJECT_ID` with your project ID to list its audit requests.

   ```sh
   tityra audits list --project PROJECT_ID --json
   ```

2. Choose a released audit. Run `tityra audits get AUDIT_ID --json` using its request ID and copy the `reportId` from the result. Read the report to find its revision.

   ```sh
   tityra reports get REPORT_ID --json
   ```

3. Use the published revision number and a new filename. For example, to save revision 3:

   ```sh
   tityra reports download REPORT_ID --revision 3 --output report-v3.pdf
   ```

### Review findings and discussions

1. List open findings with high severity. Use `--page 2` to read the next page.

   ```sh
   tityra findings list REPORT_ID --severity high --status open --json
   ```

2. Copy a finding ID from the results to read that finding in one request. If you already have both IDs, you can start here.

   ```sh
   tityra findings get REPORT_ID FINDING_ID --json
   ```

3. Read the finding's discussion using the same IDs.

   ```sh
   tityra discussions list REPORT_ID FINDING_ID --json
   ```

### Ask a question about a finding

1. The default connection is read-only. To post a question, sign in again and approve discussion writes. An explicit scope list replaces the defaults. This example keeps the default read permissions.

   ```sh
   tityra auth login --scope "projects:read audits:read reports:read findings:read discussions:read billing:read discussions:write"
   ```

2. Save the following as `question.json`. Enter your question and the current report revision. Replace `NEW_UUID` with the output of `node -p "crypto.randomUUID()"` to identify this post.

   ```json
   {
     "body": "Does this finding also apply to the checkout page?",
     "expectedReportRevision": 3,
     "idempotencyKey": "NEW_UUID"
   }
   ```

3. Review the file and post it. If the connection drops, check the discussion before retrying with the same file and key.

   ```sh
   tityra discussions create REPORT_ID FINDING_ID --input question.json --yes
   ```

### Review a report with an agent

1. Install the report review skill for your agent with `npx skills add Tityra-UK/CLI --skill tityra-report-review`.
2. Give your agent the published report ID and ask it to summarise the open findings. It uses the CLI connection you approved. [Browse the available skills](https://github.com/Tityra-UK/CLI/tree/main/skills).

## Troubleshooting

| Problem                    | What to do                                                                                                                              |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| The browser doesn't open   | Run `tityra auth login --no-browser` and open the printed URL on the same computer.                                                     |
| Sign-in expired            | Run `tityra auth login` and complete organisation sign-in if prompted. If you set `TITYRA_ACCESS_TOKEN`, replace or unset it first.     |
| A project is missing       | Run `tityra projects list`. Check your account's project access in Tityra and select the project at sign-in.                            |
| The report is still locked | Check the request in Tityra for spending approval or report release. For a legacy report payment, run `tityra audits payment AUDIT_ID`. |
| A revision conflict occurs | Read the record again and review your change against its current revision.                                                              |

## How to get help and report issues

Use `tityra --help` for the command list or `tityra findings list --help` for a command's options. See the [CLI guide](https://tityra.com/cli) for monitoring, scripting and other workflows.

[Report a CLI bug](https://github.com/Tityra-UK/CLI/issues) or [email Tityra](mailto:info@tityra.com) with a product question. For a security issue, use the [private reporting instructions](https://github.com/Tityra-UK/CLI/blob/main/SECURITY.md).

## Developer documentation

### Technical implementation

The CLI is written in TypeScript and runs on Node.js. Commander parses commands. Browser sign-in uses OAuth with PKCE and returns to a temporary local address. The HTTP client sends requests to Tityra with the permissions granted at sign-in.

### Code structure

- `src/cli.ts` registers the commands in `src/commands/`.
- `src/services/` contains the interactive menu, HTTP client and browser sign-in.
- `src/schema/` validates inputs for commands that change an account record.
- `tests/` covers commands, sign-in and the interactive workspace with isolated fixtures.

### Local development

#### Set up

Install Node.js 22.14 or later and clone the repository.

```sh
git clone https://github.com/Tityra-UK/CLI.git
cd CLI
```

#### Install

Run `npm ci` from the repository root to install the locked dependencies.

#### Configure

The default server is `https://app.tityra.com`. The test suite provides its own fixtures. To try a development server, pass its origin with `--base-url` and use a separate directory for its credentials with `--config-dir`.

#### Build and test

```sh
npm run build
node dist/cli.js --help
npm test
```

#### Debugging

If a command still shows old behaviour after editing `src/`, run `npm run build`. To pause at startup, run `node --inspect-brk dist/cli.js` followed by the command and arguments you want to inspect.

## How to contribute

Bug reports, documentation fixes and pull requests are welcome. Use a small example that another contributor can reproduce.

### Contribution process

1. Read the [contribution guide](https://github.com/Tityra-UK/CLI/blob/main/CONTRIBUTING.md) and [code of conduct](https://github.com/Tityra-UK/CLI/blob/main/CODE_OF_CONDUCT.md).
2. Open an issue describing the change. For a code fix, add a regression test and run the checks in the contribution guide.
3. Submit a pull request with your change and the checks you ran.

## License

[MIT licence](https://github.com/Tityra-UK/CLI/blob/main/LICENSE).

<!-- markdownlint-configure-file {"MD041": { "level": 2 }} -->
