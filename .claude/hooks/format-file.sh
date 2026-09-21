#!/usr/bin/env bash
# PostToolUse: format the file Claude just wrote, so diffs stay clean and lint stays green.
set -uo pipefail
path="$(cat | python3 -c 'import json,sys;print(json.load(sys.stdin).get("tool_input",{}).get("file_path",""))' 2>/dev/null)"
[ -z "$path" ] || [ ! -f "$path" ] && exit 0
case "$path" in
  *.ts|*.tsx|*.js|*.mjs|*.json|*.md|*.yml|*.yaml)
    cd "$CLAUDE_PROJECT_DIR" || exit 0
    [ -x node_modules/.bin/prettier ] || exit 0
    node_modules/.bin/prettier --write --log-level warn "$path" >/dev/null 2>&1
    ;;
esac
exit 0
