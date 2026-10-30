# Contributing to Tityra CLI

Use an [issue](https://github.com/Tityra-UK/CLI/issues) to describe a
reproducible bug or a proposed improvement. Security reports belong in the
private channel described in [SECURITY.md](SECURITY.md). Follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Development

Use Node.js **22.14 or later** and npm. The source is TypeScript with native ESM
imports and the executable is built at `dist/cli.js`. Install the locked
development dependencies and run the checks from the repository root:

```sh
npm ci
npm run format:check
npm run lint
npm run check
npm test
npm pack --dry-run
```

`format:check` checks Prettier formatting, `lint` runs both ESLint (`lint:code`)
and Markdown checks (`lint:docs`), and `check` runs the TypeScript checker. Use `npm run format` to apply
the repository's formatting. `test` builds the CLI and runs the Node test suite.
`npm run build` rebuilds `dist/` when you need
to run the executable directly. Reuse Commander for commands and Chalk/Ora for
terminal presentation and Prompts for interactive input; explain a concrete need before adding another runtime
dependency.

Temporary scoped dependency overrides pin `markdownlint`'s `re2js` to `2.9.1`
and `micromark-extension-math`'s `katex` to `0.18.2` for security fixes. Revisit
these after upstream dependency ranges include the fixes. Remove them only
after updating the lockfile, checking `npm audit` and rerunning the normal
validation; do not widen an override to unrelated runtime dependencies.

Keep changes focused, add meaningful coverage for changed behaviour and describe
what you verified in the pull request. Exercise authentication and API behaviour
with isolated fixtures or loopback servers. Do not use a colleague's account or
mutate live audits, discussions, remediation or payment records in tests.

Do not commit `dist/`, credentials, local configuration, `.env` files or
tarballs. Inspect the `npm pack --dry-run` file list before proposing a release.
New CLI commands should preserve the existing server-side project, permission,
review, revision and payment boundaries. Error messages and diagnostics must not
reveal credentials or private API responses.

## Container development

Build and check the image locally when Docker is running:

```sh
docker build -t tityra-cli:local .
docker run --rm tityra-cli:local --help
```

For API commands, inject an already-issued scoped token from your environment:

```sh
docker run --rm --env TITYRA_ACCESS_TOKEN tityra-cli:local projects list --json
```

Do not put tokens in Dockerfiles or build arguments. Browser OAuth uses an
ephemeral loopback callback; run `tityra auth login` on the host for interactive
use. The default container network does not expose that callback to a host
browser. The image runs as the unprivileged `node` user.

## Releases

Publishing is a separate maintainer action. Ordinary branch or tag pushes do
not publish packages or container images. The release-triggered `publish.yml`
workflow follows the build-then-publish pattern of the supplied reference:
publishing a non-draft GitHub Release runs validation and tests before an npm
publish job. Publishing uses OIDC trusted publishing without a long-lived npm
token.

Before using that workflow, maintainers must:

1. Establish ownership of the `@tityra/cli` package and configure its npm
   trusted publisher for organisation **Tityra-UK**, repository **CLI**,
   workflow filename **publish.yml**, environment **npm-protected**,
   allowing direct publish.
2. Configure the GitHub **npm-protected** environment with the intended
   reviewers and deployment/ref protections. Merely naming an environment in
   YAML does not configure those protections. Protect the release tags as
   appropriate.
3. Update `package.json`, its lockfile and [CHANGELOG.md](CHANGELOG.md),
   complete the local checks and merge the intended release commit into `main`.
4. Create a matching `v<package-version>` tag on that reviewed commit, then
   publish a non-draft GitHub Release for that tag. Publishing the release can
   publish the package after the checks and environment protections complete.

The workflow derives the **next** npm distribution tag for every `0.x` version,
SemVer prerelease or GitHub prerelease; stable `1.x` and later releases use
**latest**. For version `1.0.0`, the Git tag is `v1.0.0` and the npm
tag is `latest`. The workflow validates the package version, release tag and
ancestry from `main` before publishing. It does not create Git tags, GitHub
releases or credentials, or bootstrap npm package ownership.

The first package may require a maintainer to bootstrap npm ownership through a
manual public publish and npm's browser approval before trusted publishing can
be configured. Use the pinned `npm@11.21.1` client. Build the reviewed version,
set `dist/cli.js` to mode `0755`, then pack with `--ignore-scripts`.
Inspect and test the exact tarball, then publish that same tarball with the
appropriate distribution tag. Confirm its registry integrity before creating
the GitHub Release.

The publish job packs once with the same pinned npm client and reads the exact
version from the public npm registry. Only HTTP 404 allows a new publication.
An existing version is skipped only when its name and version match and its
compressed integrity matches, or when both compressed archives pass their own
SHA-512 checks and their complete uncompressed TAR bytes match exactly.
Downloads and decompression are bounded; paths, modes, headers and file order
are never ignored or normalised. Different gzip implementations can encode
identical TAR bytes differently. Any other mismatch, failed request or registry
status fails the job. This lets the initial GitHub Release follow a verified
manual bootstrap without publishing the same version twice.

To verify an existing published tag after a verification-tooling fix, run the
read-only recovery workflow from `main`:

```sh
gh workflow run verify-release.yml --repo Tityra-UK/CLI --ref main -f release_tag=v1.0.0
```

It builds the immutable tag source and checks the published archive with the
current verifier. It cannot publish a package, change distribution tags or
move the Git tag; an unpublished version fails verification.

The publishing runner uses a pinned npm version that supports trusted
publishing. Provenance is enabled for a public repository and explicitly
disabled while this repository is private, because npm does not support
provenance from private GitHub repositories. See the
[npm trusted-publishing guide](https://docs.npmjs.com/trusted-publishers/).

## Licence

Contributions are provided under the [MIT License](LICENSE). Retain applicable
copyright and attribution notices when adapting existing material.
