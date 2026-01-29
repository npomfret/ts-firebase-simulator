# Release Process

This document explains how to create and publish new releases of ts-firebase-simulator.

## Version Strategy

This project follows [Semantic Versioning](https://semver.org/):

- **Patch** (0.10.0 → 0.10.1): Bug fixes, internal improvements, no API changes
- **Minor** (0.10.0 → 0.11.0): New features, backward-compatible API additions
- **Major** (0.10.0 → 1.0.0): Breaking changes to the public API

## Pre-Release Checklist

Before creating a release, ensure:

1. ✅ All tests pass
   ```bash
   npm test
   ```

2. ✅ Code builds successfully
   ```bash
   npm run build
   ```

3. ✅ CHANGELOG.md is updated with the changes for this release
   - Move items from `[Unreleased]` to the new version section
   - Add the release date
   - Add comparison links at the bottom

4. ✅ All changes are committed to git
   ```bash
   git status  # Should show clean working directory
   ```

## Release Commands

The package includes convenient scripts that handle versioning, tagging, and publishing:

### Patch Release (Bug Fixes)

For bug fixes and internal improvements:

```bash
npm run release:patch
```

**What it does:**
1. Bumps version from 0.10.0 → 0.10.1
2. Updates `package.json` and `package-lock.json`
3. Creates a git commit: `0.10.1`
4. Creates a git tag: `v0.10.1`
5. Publishes to npm
6. Pushes commits and tags to GitHub

### Minor Release (New Features)

For new backward-compatible features:

```bash
npm run release:minor
```

**What it does:**
1. Bumps version from 0.10.0 → 0.11.0
2. Same steps as patch release

### Major Release (Breaking Changes)

For breaking changes to the public API:

```bash
npm run release:major
```

**What it does:**
1. Bumps version from 0.10.0 → 1.0.0
2. Same steps as patch release

## Manual Release Process

If you need more control, you can run the steps manually:

```bash
# 1. Update version in package.json and create git tag
npm version patch  # or: minor, major

# 2. Build the package
npm run build

# 3. Publish to npm
npm publish

# 4. Push to GitHub (including tags)
git push && git push --tags
```

## Post-Release Steps

After a successful release:

1. **Verify npm publication**
   - Check https://www.npmjs.com/package/ts-firebase-simulator
   - Verify the new version is listed
   - Check that files are included correctly

2. **Create GitHub Release** (optional)
   - Go to https://github.com/npomfret/ts-firebase-simulator/releases
   - Click "Draft a new release"
   - Select the version tag (e.g., `v0.10.1`)
   - Copy changelog entries for the release notes
   - Publish release

3. **Update CHANGELOG.md for next version**
   - Add a new `[Unreleased]` section at the top
   - Update comparison links

## Example: Complete Release Flow

Here's a complete example for releasing a bug fix (0.10.0 → 0.10.1):

```bash
# 1. Ensure you're on main with latest changes
git checkout main
git pull

# 2. Run tests
npm test

# 3. Build
npm run build

# 4. Update CHANGELOG.md
# - Move items from [Unreleased] to [0.10.1]
# - Add release date: ## [0.10.1] - 2026-01-29
# - Update comparison links at bottom

# 5. Commit changelog
git add CHANGELOG.md
git commit -m "docs: update changelog for 0.10.1"

# 6. Release (version bump, tag, publish)
npm run release:patch

# 7. Verify on npm
open https://www.npmjs.com/package/ts-firebase-simulator
```

## Troubleshooting

### "npm ERR! 403 Forbidden"

You need to be logged in to npm and have publish permissions:

```bash
npm login
npm whoami  # Should show your npm username
```

### "git push failed"

Make sure you have push access to the repository and your local branch is up to date:

```bash
git pull --rebase
git push && git push --tags
```

### "Build failed"

Fix any TypeScript errors before releasing:

```bash
npm run build:check  # TypeScript compilation check
```

### Dry Run

To see what would be published without actually publishing:

```bash
npm pack --dry-run
```

This shows the list of files that would be included in the package.

## Files Included in Package

The `files` field in `package.json` controls what gets published:

```json
"files": [
  "dist",
  "README.md"
]
```

Only the built `dist/` directory and README are published. Source files (`src/`) are not included.

## npm Scripts Reference

| Script | Command | Purpose |
|--------|---------|---------|
| `release:patch` | `npm version patch && npm publish` | Bug fix release (0.0.X) |
| `release:minor` | `npm version minor && npm publish` | Feature release (0.X.0) |
| `release:major` | `npm version major && npm publish` | Breaking change release (X.0.0) |
| `build` | `npm run build:check && tsup` | Build the package |
| `build:check` | `tsc --noEmit` | Type check without emitting |
| `test` | `vitest run` | Run all tests |
