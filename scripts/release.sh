#!/usr/bin/env bash
#
# Adopts what skema-lib hands down (SKEMA_LIB_VERSION, SKEMA_LANG_VERSION),
# verifies it, then derives and pushes the extension's own next version from
# conventional commits via git-cliff. See brain/release-chain.md, "Release
# job" - this is that job, implemented once per repo since the manifests
# differ.
#
# Never builds a VSIX: that happens in the tag pipeline the pushed tag starts.
#
#     scripts/release.sh --dry-run     # print what it would do, touch nothing
#     scripts/release.sh
#
# Environment:
#   SKEMA_LIB_VERSION=v0.1.1    pin @skema/collab-protocol, @skema/diagram, @skema/docs
#   SKEMA_LANG_VERSION=v0.2.2   pin @skema/model
#   RELEASE_TRIGGER_TOKEN       ask for the tag pipeline after pushing (CI only)
#
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

say() { printf '%s\n' "$*" >&2; }
run() {
  if [ "$DRY_RUN" = 1 ]; then say "  would run: $*"; else "$@"; fi
}

# --------------------------------------------------------------------------
# Where we are now
# --------------------------------------------------------------------------

if [ -n "${CI:-}" ]; then
  git fetch origin main --tags
  # A push pipeline races the next one: if main moved on while this pipeline
  # queued, the newer pipeline is the one that should release.
  if [ "${CI_PIPELINE_SOURCE:-}" = "push" ] && [ "$(git rev-parse origin/main)" != "${CI_COMMIT_SHA:-}" ]; then
    say "origin/main has moved past ${CI_COMMIT_SHA:-HEAD} - a newer pipeline releases instead"
    exit 0
  fi
  git checkout -q origin/main
fi

LAST_TAG=$(git tag -l 'v*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -n1 || true)

# --------------------------------------------------------------------------
# Adopt what skema-lib handed down
# --------------------------------------------------------------------------

if [ -n "${SKEMA_LIB_VERSION:-}${SKEMA_LANG_VERSION:-}" ]; then
  if [ "$DRY_RUN" = 1 ]; then
    say "  would run: node scripts/adopt-release.mjs"
    say "  would verify: npm ci && npm run typecheck && npm test && npm run build"
  else
    CHANGES=$(node scripts/adopt-release.mjs)

    # Ordinary checks are skipped on this pipeline (they would test the old
    # manifest), so this is the only verification a bad adoption gets.
    npm ci
    npm run typecheck
    npm test
    npm run build

    if [ -n "$CHANGES" ]; then
      say "Adopted:"
      say "$CHANGES"
      git config user.email "${GITLAB_USER_EMAIL:-ci@skema-language}"
      git config user.name "${GITLAB_USER_NAME:-skema release}"
      git add package.json package-lock.json
      while IFS= read -r line; do
        [ -n "$line" ] || continue
        git commit -m "fix(deps): $line"
      done <<<"$CHANGES"
    else
      say "Adoption pins already current - nothing to commit."
    fi
  fi
fi

# --------------------------------------------------------------------------
# Release the extension's own next version
# --------------------------------------------------------------------------

NEXT_TAG=$(git cliff --bumped-version 2>/dev/null)

if [ "$NEXT_TAG" = "${LAST_TAG:-}" ]; then
  say "Nothing to release (already at $NEXT_TAG)"
  exit 0
fi

say "Releasing $NEXT_TAG (was ${LAST_TAG:-none})"
VERSION="${NEXT_TAG#v}"

if [ "$DRY_RUN" = 1 ]; then
  say "  would set version -> $VERSION in package.json and package-lock.json"
else
  node --input-type=module -e "
    import { readFileSync, writeFileSync } from 'node:fs';
    for (const file of ['package.json', 'package-lock.json']) {
      const json = JSON.parse(readFileSync(file, 'utf8'));
      json.version = '$VERSION';
      if (json.packages?.['']) json.packages[''].version = '$VERSION';
      writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
    }
  "
fi

MSG="chore(release): $NEXT_TAG"
run git config user.email "${GITLAB_USER_EMAIL:-ci@skema-language}"
run git config user.name "${GITLAB_USER_NAME:-skema release}"
run git add package.json package-lock.json
run git commit -m "$MSG"
run git tag -a "$NEXT_TAG" -m "$MSG"

if [ "$DRY_RUN" = 1 ]; then
  say "  would push HEAD and $NEXT_TAG"
  exit 0
fi

if [ -n "${CI:-}" ]; then
  # The job token does the pushing - no personal or project access token.
  git remote set-url origin "https://gitlab-ci-token:${CI_JOB_TOKEN}@${CI_SERVER_HOST}/${CI_PROJECT_PATH}.git"
fi
git push origin "HEAD:${CI_DEFAULT_BRANCH:-main}"
git push origin "$NEXT_TAG"

say "Pushed $NEXT_TAG"

# A job-token push starts no pipeline, so the tag pipeline that builds the
# VSIX has to be asked for explicitly.
if [ -n "${CI:-}" ]; then
  if [ -z "${RELEASE_TRIGGER_TOKEN:-}" ]; then
    say "RELEASE_TRIGGER_TOKEN is not set - $NEXT_TAG is tagged, but nothing will publish it."
    exit 1
  fi
  say "Starting the tag pipeline for $NEXT_TAG"
  curl --fail --silent --show-error --output /dev/null \
    --form "token=${RELEASE_TRIGGER_TOKEN}" \
    --form "ref=$NEXT_TAG" \
    "${CI_API_V4_URL}/projects/${CI_PROJECT_ID}/trigger/pipeline"
fi
