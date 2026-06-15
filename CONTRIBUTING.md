# Contributing

How work flows on Jarvis: branches, commits, pull requests, and CI. This is a solo
project, but the flow is kept disciplined so `main` is always releasable and every
change is gated by CI.

## Branches

Three long-lived ideas:

- `main` - always green and releasable. Never commit to it directly.
- `dev` - integration branch. Feature branches merge here first.
- `feat/*`, `fix/*`, ... - short-lived working branches off `dev`.

Work targets `dev`; `dev` is merged into `main` for releases.

Branch names follow `<type>/<short-slug>`, where `<type>` matches the commit
convention below: `feat/link-expiry`, `fix/reconnect-loop`, `docs/readme-setup`,
`chore/bump-baileys`.

Create one with:

    git checkout dev
    git pull
    git checkout -b feat/link-expiry

## Commits

[Conventional Commits](https://www.conventionalcommits.org). Each message starts
with a type:

- `feat:` a new capability (command, trigger, adapter)
- `fix:` a bug fix
- `docs:` documentation only
- `test:` tests only
- `refactor:` behavior-preserving code change
- `chore:` housekeeping (config, scripts)
- `ci:` workflow / CI changes
- `deps:` dependency updates

Use the imperative mood (`add link expiry`, not `added`). An optional scope is fine:
`feat(link): add one-time code expiry`.

Because PRs are squash-merged, the PR title becomes the single commit on `dev`, so
the **title** is what must follow the convention. The individual commits on your
feature branch are collapsed into it.

## Pull requests

Push the feature branch and open a PR against `dev` (not `main`). Fill in the
template. The merge button stays disabled until CI is green.

Keep the title short (under 70 chars) and in the commit convention, because it
becomes the squash commit message.

Approving your own PR is not possible on GitHub (you are the author), and that is
fine here: merge is gated by **CI passing**, not by a review approval. Read the
green check on the PR, then merge with **Squash and merge**.

## CI

Every PR runs `.github/workflows/ci.yml`: install on Node 24 and run the suite
(`npm test`, `node:test` against an in-memory database). A red check blocks merge.
Fix the root cause; do not bypass with `--no-verify` or by merging past it.

## Releases

When `dev` has enough accepted changes to ship, open a PR from `dev` to `main` and
squash-merge it. Tag the commit if you want a version marker.

## Things not to do

- Do not commit to `main` or `dev` directly; go through a feature branch + PR.
- Do not commit real secrets. `.env` and `data/` are gitignored; only
  `.env.example` is committed, and it must hold no real values.
- Do not force-push `main` or `dev`. On your own feature branch,
  `git push --force-with-lease` after a rebase is fine; never plain `--force`.
