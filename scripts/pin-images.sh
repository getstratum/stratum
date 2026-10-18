#!/usr/bin/env bash
# Base images are referenced by tag *and* digest (image:tag@sha256:...), so a
# build gets exactly the bytes that were reviewed, and Dependabot proposes
# each new digest or version as a pull request.
#
#   scripts/pin-images.sh          add the current digest to every image
#                                  reference that has none (needs docker buildx)
#   scripts/pin-images.sh --check  fail if any reference has no digest (CI)
#
# Files: the Dockerfiles' FROM lines and the compose file's image: lines.
set -euo pipefail
cd "$(dirname "$0")/.."

FILES=(
  gateway/Dockerfile
  control-plane/dashboard/Dockerfile
  deploy/gcp/mock-llm/Dockerfile
  deploy/compose/docker-compose.yml
)

# Prints "file:line:reference" for each reference without a digest.
unpinned() {
  local f
  for f in "${FILES[@]}"; do
    awk -v f="$f" '
      /^FROM[ \t]/ {
        ref = ""
        for (i = 2; i <= NF; i++) if ($i !~ /^--/) { ref = $i; break }
        if (ref != "scratch" && ref !~ /@sha256:[0-9a-f]{64}$/) print f ":" NR ":" ref
      }
      /^[ \t]*image:[ \t]/ {
        ref = $2; gsub(/"/, "", ref)
        if (ref !~ /@sha256:[0-9a-f]{64}$/) print f ":" NR ":" ref
      }' "$f"
  done
}

if [[ "${1:-}" == "--check" ]]; then
  missing="$(unpinned)"
  if [[ -n "$missing" ]]; then
    echo "image references without a digest (run scripts/pin-images.sh):" >&2
    echo "$missing" >&2
    exit 1
  fi
  echo "every base image is pinned by digest"
  exit 0
fi

command -v docker >/dev/null || { echo "needs docker (with buildx)" >&2; exit 1; }
unpinned | while IFS=: read -r f line ref; do
  digest="$(docker buildx imagetools inspect "$ref" --format '{{json .Manifest}}' | sed -n 's/.*"digest":"\(sha256:[0-9a-f]\{64\}\)".*/\1/p' | head -1)"
  [[ -n "$digest" ]] || { echo "no digest for $ref" >&2; exit 1; }
  # Only that line, only that reference.
  sed -i.bak "${line}s|${ref}|${ref}@${digest}|" "$f" && rm -f "$f.bak"
  echo "$f:$line  $ref@$digest"
done
