# vercel-ai-middleware

### Commands

```sh
# Build
npm run build

# Checks any esm/cjs module resolutions issues for node10, node16, and bundler
npm run check-exports

# Format
npm run format

# Lint
npm run lint
```

## Release flow

We use [changeset](https://github.com/changesets/changesets) to manage our release workflow:

**For Contributors:**

- Run `⁠npm run changeset` in your PR to document your changes and specify the release type (patch/minor/major)

**For Releases:**

1. Create a release PR by running `⁠npm run version`
   - This automatically updates `⁠package.json` version numbers based on accumulated changes
   - Updates ⁠`CHANGELOG.md` with all changes
2. Merge the release PR
3. GitHub Actions will automatically:
   - Create a new release and tag
   - Publish the package to npm

** TODO:**

- Add ⁠NPM_TOKEN for npm publishing in github action
