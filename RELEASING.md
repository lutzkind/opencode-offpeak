# Releasing

## Current distribution

The current release is `v0.1.0`. Install it from GitHub:

```sh
opencode plugin add git+https://github.com/lutzkind/opencode-offpeak.git#v0.1.0
```

The npm package is not published yet. The package name and version must be checked
with `npm view opencode-offpeak version` before every first or retrying publish.

Trusted publishing requires Node.js 22.14 or later and npm 11.5.1 or later. See
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and the
[npm trust API requirements](https://api-docs.npmjs.com/) for current account and
package prerequisites.

## One-time npm bootstrap

npm trusted publishing cannot create its own initial package trust record: the package
must already exist, and npm requires an authenticated maintainer with 2FA to create a
trusted-publisher relationship. The first public version therefore needs a one-time
maintainer-authenticated publish of the reviewed `v0.1.0` contents.

From a clean checkout of the release tag, the npm maintainer should run:

```sh
git checkout v0.1.0
npm login --auth-type=web
npm whoami
npm ci
npm run lint
npm run typecheck
npm test
npm pack --dry-run
npm publish --access public
```

After `npm view opencode-offpeak version` returns `0.1.0`, configure the trusted
publisher from the same npm account:

```sh
npm trust github opencode-offpeak \
  --file publish.yml \
  --repository lutzkind/opencode-offpeak \
  --allow-publish
```

The trust configuration must name `.github/workflows/publish.yml` exactly and allow
direct `npm publish`. npm requires the maintainer's interactive 2FA for this account
change. Do not put an npm token in the repository or GitHub Actions secrets.

## Future releases

Publishing a GitHub release whose tag matches the package version starts
`.github/workflows/publish.yml`. It checks out the release tag, runs lint, typecheck,
tests, and a package dry run, verifies the `vX.Y.Z` tag matches `package.json`, then
publishes through GitHub Actions OIDC. npm generates provenance for this public
repository publish. The workflow has no long-lived npm credential.

The registry does not allow reusing a package version. A duplicate or mismatched
release fails before publication or is rejected by npm; investigate the registry and
tag state instead of changing or retrying a published version.

After a successful release, verify the public registry metadata and signatures:

```sh
npm view opencode-offpeak version dist.tarball dist.integrity
npm audit signatures opencode-offpeak
```

Then install that exact version in a clean OpenCode v2 configuration and verify both
the server and TUI entrypoints before announcing npm availability.
