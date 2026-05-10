# Setup EmmyLua Check Action

GitHub Action for downloading `emmylua_check` from [EmmyLua Analyzer Rust](https://github.com/EmmyLuaLs/emmylua-analyzer-rust) on Ubuntu runners and adding it to `PATH`.

Supports `ubuntu-latest` and `ubuntu-slim`.

## Usage

```yaml
name: EmmyLua Check

on: [push, pull_request]

jobs:
  check:
    runs-on: ubuntu-slim
    steps:
      - uses: actions/checkout@v4
      - uses: owner/emmylua_check_action@v1
      - run: emmylua_check --config .emmyrc.json .
```

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `version` | `latest` | EmmyLua Analyzer Rust release tag. |
| `repository` | `EmmyLuaLs/emmylua-analyzer-rust` | Repository that publishes `emmylua_check` assets. |
| `asset` | auto | Ubuntu release asset name override. |
| `token` | empty | Token used for GitHub release API requests. |

## Outputs

| Output | Description |
| --- | --- |
| `version` | Resolved release tag. |
| `asset` | Downloaded release asset name. |
| `path` | Installed `emmylua_check` path. |

## Notes

This action only installs `emmylua_check`. Run `emmylua_check` in a later step with the arguments you want.
