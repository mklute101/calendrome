#!/bin/sh
# Netlify build-ignore check. Exit 0 = skip the build, non-zero = build.
#
# Deploy previews must diff the whole PR against its merge-base with
# main: `HEAD^ HEAD` only sees the branch tip, so a multi-commit PR
# whose most recent push was e2e-only would cancel the preview even
# though earlier commits touched the site. Production diffs against the
# last commit Netlify actually built (CACHED_COMMIT_REF), falling back
# to HEAD^ on a cold cache. Any git failure falls through to "build" —
# a wasted build is cheap, a silently stale site is not.

# Intentionally unquoted below: one path per word.
PATHS="website/ netlify.toml scripts/extract-docs.mjs scripts/netlify-ignore.sh src/ vite.playground.config.ts package.json package-lock.json"

if [ "$PULL_REQUEST" = "true" ]; then
  git fetch origin main || exit 1
  BASE=$(git merge-base HEAD origin/main) || exit 1
  git diff --quiet "$BASE" HEAD -- $PATHS
else
  git diff --quiet "${CACHED_COMMIT_REF:-HEAD^}" "${COMMIT_REF:-HEAD}" -- $PATHS
fi
