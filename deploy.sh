#!/usr/bin/env bash
# One-time: create the public GitHub repo, push, and turn on GitHub Pages.
# After this, every daily pipeline run pushes new clips and the site updates by itself.
set -e
cd "$(dirname "$0")"
USER=$(gh api user -q .login)
if ! git remote get-url origin >/dev/null 2>&1; then
  gh repo create cs-reels --public --source . --remote origin --push \
    --description "Reels-style feed of core CS clips, refreshed daily"
else
  git push -u origin main
fi
gh api -X POST "repos/$USER/cs-reels/pages" -f build_type=workflow >/dev/null 2>&1 || true
sleep 3
gh workflow run pages.yml -R "$USER/cs-reels" || true
echo
echo "Deploying... in ~1 minute your app will be at:"
echo "  https://$USER.github.io/cs-reels/"
echo "Watch progress: gh run watch -R $USER/cs-reels"
