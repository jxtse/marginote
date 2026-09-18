# Releasing Marginote

Run these commands from the repository root unless a step says otherwise. Local checks
do not require an account or external model calls; publication needs npm maintainer
credentials and write access to `jxtse/marginote`.

## The release bundle

Marginote develops as a workspace but ships as a single package, because the onboarding promise
is `npx marginote <folder>` and that has to work with one install.

```bash
npm run build:release   # tsc + vite + esbuild, then stage packages/cli
npm run check:release   # refuses to publish something that will not run
npm run verify          # full pre-release gate: types, tests, build, release checks
npm run test:e2e        # Chromium, Firefox, and WebKit against the disposable demo
```

`build:release` bundles both binaries with their dependencies and copies the web client and
Discover index, integration plugins and user documentation beside them. The Discover
source lives in `packages/server/data/registry.json`; the packaged copy remains at
`registry/index.json`. The published package therefore has **no runtime npm dependencies**
— nothing to resolve on the user's machine.

`check:release` is not a formality. It verifies the bundles exist, start, are executable,
report the package version, carry exactly one shebang each, declare the expected licence,
and contain no unresolvable workspace ranges in `dependencies`.
Both of those failures were real, and both only appear once the tarball is installed.

## Verifying it the way a user would

The test suite does not prove the *package* works. This does:

```bash
cd packages/cli && npm pack
mkdir -p /tmp/smoke/vault && cd /tmp/smoke && npm init -y
npm install /path/to/marginote-<version>.tgz
printf '# Hi\n\nhello\n' > vault/hi.md
./node_modules/.bin/marginote vault --port 4321
```

CI does this on every push, along with a Docker build and run, Windows filesystem tests, and
Chromium, Firefox, and WebKit browser smoke tests.

## Prepare a release

Update `packages/cli/package.json`, its workspace version in `package-lock.json`, the
changelog and both READMEs. Run the checks above, including native compatibility checks
when agent integration changes. Commit and push the reviewed changes, then require all
CI jobs to pass on that exact commit before tagging it. Always specify
`--repo jxtse/marginote` with `gh`; a checkout can also have the upstream Quire remote.

## Publishing the verified artifact

Prepare release notes in `/tmp/marginote-release-notes.md`. Replace `VERSION` with the
actual version and publish the same tarball that passed installation checks:

```bash
npm whoami
npm publish /path/to/marginote-VERSION.tgz --access public --tag latest
git tag -a vVERSION -m 'Marginote VERSION'
git push origin vVERSION
gh release create vVERSION /path/to/marginote-VERSION.tgz --repo jxtse/marginote --verify-tag --title 'vVERSION' --notes-file /tmp/marginote-release-notes.md --latest
```

Publishing from `packages/cli` runs the `prepublishOnly` check. Publishing an already
packed tarball requires running `check:release` and the installation check before packing.
Use `--tag beta` and a GitHub prerelease for beta versions; keep `latest` on the stable
release. Never reuse an npm version or move a published tag.

An accepted upload can precede public availability while npm processes the package.
Wait for `npm view marginote@VERSION` to show the new version; do not repeat the upload
merely because an early availability check returns 404. Compare `dist.integrity` with
the packed artifact, verify the dist-tags, and test a fresh install from npm. Confirm
the GitHub tag points to the tested commit and the release is public. If a distribution
channel is still pending, state that on the release page and provide the working path.

## What needs an account

These operations require the maintainer's account:

1. **npm** — use `npm login` and complete any separate browser authentication challenge
   requested during publication. The package is `marginote`; its binaries are `marginote`
   and `marginote-mcp`.
2. **GitHub settings** — the public repository already lives at `jxtse/marginote`.
   Enable private vulnerability reporting and require the CI workflow before merging to
   `main`. These settings require an owner in the GitHub UI.

Nothing else requires a signup. Docker Hub is not needed: the image builds from source, and
GHCR publishing can be added later if you want a pre-built image.
