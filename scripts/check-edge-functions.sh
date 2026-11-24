#!/usr/bin/env bash
# Verify every Supabase Edge Function the way the deploy tool does: Deno resolves
# each entry point's module graph (and bundles it), requiring explicit file
# extensions on relative imports. This is the exact resolution step that made
# `supabase functions deploy --remote` fail with "Module not found .../authSecurity".
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! command -v deno >/dev/null 2>&1; then
  echo "deno is required to check Supabase Edge Functions (see .github/workflows/edge-functions.yml)." >&2
  exit 1
fi

roots=()
entrypoints=()
function_count=0

# Discover deployable functions from the filesystem, so a newly added function
# is checked automatically. Every directory except _shared must have an index.ts.
while IFS= read -r dir; do
  [ "$(basename "$dir")" = '_shared' ] && continue
  entry="$dir/index.ts"
  if [ ! -f "$entry" ]; then
    echo "Edge Function directory $dir has no index.ts entry point." >&2
    exit 1
  fi
  roots+=("$entry")
  entrypoints+=("$entry")
  function_count=$((function_count + 1))
done < <(find supabase/functions -mindepth 1 -maxdepth 1 -type d -print | sort)

if [ "$function_count" -eq 0 ]; then
  echo "No Edge Function entry points found under supabase/functions/." >&2
  exit 1
fi

# Also check shared helpers directly, including any not yet imported by a function.
while IFS= read -r helper; do
  roots+=("$helper")
done < <(find shared supabase/functions -type f \( -name '*.ts' -o -name '*.tsx' \) -print | sort)

echo "Deno-checking $function_count Edge Functions and ${#roots[@]} roots total:"
printf '  %s\n' "${roots[@]}"

# --no-config keeps Vite/tsconfig settings (paths, jsx, etc.) out of the Edge
# runtime graph; --no-lock avoids writing a Deno lockfile into the repo.
deno check --no-config --no-lock "${roots[@]}"
echo "All Edge Functions and shared modules type-check under Deno."

# Type-checking resolves imports; bundling proves each function can actually be
# turned into the single module the Supabase Edge Runtime uploads and boots.
bundle_dir="$(mktemp -d)"
trap 'rm -rf "$bundle_dir"' EXIT
for entry in "${entrypoints[@]}"; do
  name="$(basename "$(dirname "$entry")")"
  out="$bundle_dir/$name.js"
  deno bundle --no-config --no-lock -o "$out" "$entry"
  if [ ! -s "$out" ]; then
    echo "Bundling $entry produced an empty artifact." >&2
    exit 1
  fi
  echo "Bundled $name ($(wc -c < "$out") bytes)"
done
echo "All $function_count Edge Functions bundle successfully."
