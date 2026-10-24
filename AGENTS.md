# Agent instructions

## Changesets

Every change that affects the bot (features, fixes, behaviour changes, dependency updates that matter to users) needs a changeset. CI turns these into the version bump, `CHANGELOG.md` and the GitHub release, and nothing is released or deployed without one.

Add it in the same pull request as the change:

```sh
bun run changeset add --patch huubhuub -m "Fix voice notes being transcribed twice"
```

- Pick the bump: `--patch` for fixes and small changes, `--minor` for new features, `--major` for breaking changes (config, environment variables, data formats).
- Write the message for someone reading the changelog: one or two sentences on what changed for the user, not how the code changed.
- This creates `.changeset/<random-name>.md`. Commit it with the change; edit the file if the message needs more detail.
- Changes with nothing to release (docs, tests, CI, refactors) can skip it. If in doubt, add one.
- Never edit `CHANGELOG.md` or the `version` in `package.json` by hand; the release pull request does that.
- Renovate pull requests get theirs automatically (`.github/workflows/dependency-changesets.yml`): a patch bump when the update ships in the Docker image, an empty changeset otherwise. Don't add another; a pull request that already has a changeset is left alone.
