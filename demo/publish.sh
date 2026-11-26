#!/bin/sh
# demo/publish.sh <PR branch> <file>…: puts demo videos on the `demos` branch, under <PR branch>/,
# and prints the Markdown for the PR description. GitHub has no API to attach a video to a PR, and videos
# don't belong in the code's history, so they live on their own branch, which has no common history with main.
set -eu
[ $# -ge 2 ] || { echo "Usage: demo/publish.sh <PR branch> <file>…" >&2; exit 1; }
branch=$1; shift
# The remote PRs are pushed to: `fork` if there is one, else `origin`.
remote=origin
git remote | grep -qx fork && remote=fork
repo=$(gh repo view "$(git remote get-url "$remote")" --json nameWithOwner -q .nameWithOwner)
work=$(mktemp -d)
trap 'git worktree remove --force "$work" 2>/dev/null || true; rm -rf "$work"' EXIT
if git fetch -q "$remote" demos 2>/dev/null; then
  git worktree add -q --detach "$work" FETCH_HEAD
else
  git worktree add -q --orphan "$work"
fi
mkdir -p "$work/$branch"
cp "$@" "$work/$branch/"
git -C "$work" add -A
git -C "$work" commit -q -m "Demo for $branch" || echo "The demo for $branch is unchanged" >&2
git -C "$work" push -q "$remote" HEAD:refs/heads/demos
echo "## Demo"
for file in "$@"; do
  name=$(basename "$file")
  url="https://github.com/$repo/raw/demos/$branch/$name"
  case $name in
    *.gif) echo "![${name%.gif}]($url)" ;;
    *) echo "[${name} (full quality)]($url)" ;;
  esac
done
