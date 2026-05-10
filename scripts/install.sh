#!/usr/bin/env bash
set -euo pipefail

input() {
  local name="$1"
  local fallback="${2:-}"
  local env_name="INPUT_${name^^}"
  env_name="${env_name//-/_}"
  printf '%s' "${!env_name:-$fallback}"
}

error() {
  printf '::error::%s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || error "Required command not found: $1"
}

set_output() {
  local name="$1"
  local value="$2"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf '%s=%s\n' "$name" "$value" >>"$GITHUB_OUTPUT"
  fi
}

api_header_args() {
  printf '%s\0%s\0' -H 'Accept: application/vnd.github+json'
  printf '%s\0%s\0' -H 'User-Agent: emmylua-check-action'
  if [[ -n "$token" ]]; then
    printf '%s\0%s\0' -H "Authorization: Bearer $token"
  fi
}

download_header_args() {
  printf '%s\0%s\0' -H 'User-Agent: emmylua-check-action'
  if [[ -n "$token" ]]; then
    printf '%s\0%s\0' -H "Authorization: Bearer $token"
  fi
}

select_default_asset() {
  local machine
  machine="$(uname -m)"

  case "$machine" in
    x86_64|amd64)
      printf '%s\n' 'emmylua_check-linux-x64-glibc.2.17.tar.gz' 'emmylua_check-linux-x64.tar.gz'
      ;;
    aarch64|arm64)
      printf '%s\n' 'emmylua_check-linux-aarch64-glibc.2.17.tar.gz' 'emmylua_check-linux-arm64-glibc.2.17.tar.gz'
      ;;
    *)
      error "Unsupported Ubuntu runner architecture: $machine"
      ;;
  esac
}

[[ "$(uname -s)" == Linux ]] || error 'This action only supports Ubuntu/Linux runners.'

require_command curl
require_command jq
require_command tar
require_command sha256sum
require_command find

version="$(input version latest)"
repository="$(input repository EmmyLuaLs/emmylua-analyzer-rust)"
asset="$(input asset)"
token="$(input token)"
temp_root="$(mktemp -d "${RUNNER_TEMP:-/tmp}/emmylua-check-action-XXXXXX")"
release_json="$temp_root/release.json"
archive="$temp_root/archive.tar.gz"
install_dir="$temp_root/bin"

if [[ "$version" == latest ]]; then
  release_url="https://api.github.com/repos/$repository/releases/latest"
else
  release_url="https://api.github.com/repos/$repository/releases/tags/$version"
fi

mapfile -d '' -t api_headers < <(api_header_args)
curl -fsSL "${api_headers[@]}" "$release_url" -o "$release_json"

resolved_version="$(jq -er '.tag_name' "$release_json")"

if [[ -z "$asset" ]]; then
  while IFS= read -r candidate; do
    if jq -e --arg name "$candidate" '.assets[] | select(.name == $name)' "$release_json" >/dev/null; then
      asset="$candidate"
      break
    fi
  done < <(select_default_asset)
fi

[[ -n "$asset" ]] || error 'No matching emmylua_check release asset found for this Ubuntu runner.'

download_url="$(jq -er --arg name "$asset" '.assets[] | select(.name == $name) | .browser_download_url' "$release_json")"
digest="$(jq -r --arg name "$asset" '.assets[] | select(.name == $name) | .digest // empty' "$release_json")"

printf 'Downloading %s@%s (%s)\n' "$repository" "$resolved_version" "$asset"
mapfile -d '' -t download_headers < <(download_header_args)
curl -fL "${download_headers[@]}" "$download_url" -o "$archive"

if [[ "$digest" == sha256:* ]]; then
  expected_sha="${digest#sha256:}"
  read -r actual_sha _ < <(sha256sum "$archive")
  [[ "${actual_sha,,}" == "${expected_sha,,}" ]] || error "SHA256 mismatch for $asset"
fi

mkdir -p "$install_dir"
tar -xzf "$archive" -C "$install_dir"

binary="$(find "$install_dir" -type f -name emmylua_check -print -quit)"
[[ -n "$binary" ]] || error 'emmylua_check binary was not found in the release asset.'
chmod +x "$binary"
binary_dir="$(dirname "$binary")"
real_binary="$binary.real"
mv "$binary" "$real_binary"
{
  printf '#!/usr/bin/env bash\nset -euo pipefail\nreal_binary=%q\n' "$real_binary"
  cat <<'WRAPPER'

output_format=text
expect_value=
workspaces=()

for arg in "$@"; do
  if [[ -n "$expect_value" ]]; then
    if [[ "$expect_value" == output_format ]]; then
      output_format="$arg"
    fi
    expect_value=
    continue
  fi

  case "$arg" in
    --output-format=*) output_format="${arg#*=}" ;;
    -f=*) output_format="${arg#*=}" ;;
    --output-format|-f) expect_value=output_format ;;
    --config|-c|--ignore|-i|--output) expect_value=skip ;;
    --config=*|--ignore=*|--output=*|--warnings-as-errors|--verbose|-h|--help|-V|--version) ;;
    -*) ;;
    *) workspaces+=("$arg") ;;
  esac
done

if [[ "$output_format" != text || -z "${GITHUB_ACTIONS:-}" ]]; then
  exec "$real_binary" "$@"
fi

if [[ "${#workspaces[@]}" -eq 0 ]]; then
  workspaces=(.)
fi

rewrite_location() {
  local line="$1"
  local prefix file line_number column workspace candidate display

  if [[ "$line" =~ ^([[:space:]]*--\>[[:space:]]*)([^:]*):([0-9]+):([0-9]+)$ ]]; then
    prefix="${BASH_REMATCH[1]}"
    file="${BASH_REMATCH[2]}"
    line_number="${BASH_REMATCH[3]}"
    column="${BASH_REMATCH[4]}"

    if [[ -n "$file" && "$file" != /* ]]; then
      for workspace in "${workspaces[@]}"; do
        candidate="$workspace/$file"
        if [[ -e "$candidate" ]]; then
          if [[ -n "${GITHUB_WORKSPACE:-}" ]]; then
            display="$(realpath --relative-to="$GITHUB_WORKSPACE" "$candidate" 2>/dev/null || realpath "$candidate")"
          else
            display="$(realpath --relative-to="$PWD" "$candidate" 2>/dev/null || printf '%s' "$candidate")"
          fi
          printf '%s%s:%s:%s\n' "$prefix" "$display" "$line_number" "$column"
          return
        fi
      done
    fi
  fi

  printf '%s\n' "$line"
}

set +e
"$real_binary" "$@" 2>&1 | while IFS= read -r line || [[ -n "$line" ]]; do
  rewrite_location "$line"
done
code="${PIPESTATUS[0]}"
set -e
exit "$code"
WRAPPER
} >"$binary"
chmod +x "$binary"

if [[ -n "${GITHUB_PATH:-}" ]]; then
  printf '%s\n' "$binary_dir" >>"$GITHUB_PATH"
fi

if [[ -n "${GITHUB_ACTIONS:-}" && -n "${GITHUB_ACTION_PATH:-}" ]]; then
  printf '::add-matcher::%s/matcher.json\n' "$GITHUB_ACTION_PATH"
fi

set_output version "$resolved_version"
set_output asset "$asset"
set_output path "$binary"

printf 'Installed emmylua_check to %s\n' "$binary"
