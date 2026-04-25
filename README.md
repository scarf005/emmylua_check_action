# EmmyLua Check Action

GitHub Action for running `emmylua_check` from [EmmyLua Analyzer Rust](https://github.com/EmmyLuaLs/emmylua-analyzer-rust).

The action downloads the matching release asset for the current runner, runs `emmylua_check`, and converts diagnostics to GitHub annotations. Diagnostic severity comes from your EmmyLua config, so `error` diagnostics become workflow errors, `warning` diagnostics become warnings, and `information` or `hint` diagnostics become notices.

## Usage

```yaml
name: EmmyLua Check

on: [push, pull_request]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: owner/emmylua_check_action@v1
        with:
          workspace: .
```

Pass raw `emmylua_check` arguments with `args` when you need the full CLI surface:

```yaml
- uses: owner/emmylua_check_action@v1
  with:
    args: --config .emmyrc.json --warnings-as-errors src tests
```

Use a JSON string array when an argument contains whitespace or shell-sensitive characters:

```yaml
- uses: owner/emmylua_check_action@v1
  with:
    args: '["--ignore", "generated files/**", "src"]'
```

## Configuration

Use `.emmyrc.json`, `.emmyrc.lua`, or `.luarc.json` in the workspace, or pass config files explicitly:

```yaml
- uses: owner/emmylua_check_action@v1
  with:
    config: .emmyrc.json
    workspace: |
      src
      tests
```

Example `.emmyrc.json` severity configuration:

```json
{
  "diagnostics": {
    "severity": {
      "undefined-global": "error",
      "assign-type-mismatch": "warning"
    }
  }
}
```

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `version` | `latest` | EmmyLua Analyzer Rust release tag. |
| `repository` | `EmmyLuaLs/emmylua-analyzer-rust` | Repository that publishes `emmylua_check` assets. |
| `asset` | auto | Release asset name override. |
| `working-directory` | `.` | Directory where `emmylua_check` runs. |
| `args` | empty | Arguments passed to `emmylua_check`. Replaces `workspace`, `config`, `ignore`, `warnings-as-errors`, and `verbose` inputs when set. |
| `workspace` | `.` | Newline-separated workspace paths. |
| `config` | empty | Newline-separated config file paths passed with `--config`. |
| `ignore` | empty | Comma-separated ignore globs passed with `--ignore`. |
| `warnings-as-errors` | `false` | Pass `--warnings-as-errors` to `emmylua_check`. |
| `annotate` | `true` | Emit GitHub annotations. |
| `verbose` | `false` | Pass `--verbose` to `emmylua_check`. |
| `token` | empty | Token used for GitHub release API requests. |

## Outputs

| Output | Description |
| --- | --- |
| `version` | Resolved release tag. |
| `asset` | Downloaded release asset name. |
| `diagnostics` | Total diagnostic count. |
| `errors` | Error diagnostic count. |
| `warnings` | Warning diagnostic count. |

## Release Assets

By default, this action selects one of the upstream `emmylua_check-*` assets for the current runner OS and architecture. Use `asset` only when running on a custom platform or when you need a specific upstream asset.

Set `token: ${{ github.token }}` if unauthenticated GitHub API limits are a problem.

## Testing

Run the local integration tests with Node:

```sh
npm test
```

The tests download a pinned `emmylua_check` release and run the action against clean and failing Lua fixtures. They also simulate a minimal `PATH` so Linux `.tar.gz` extraction does not depend on the host `tar` command, which keeps the action compatible with `ubuntu-slim`.
