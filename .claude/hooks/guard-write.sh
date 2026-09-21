#!/usr/bin/env bash
# PreToolUse guard for Write|Edit|NotebookEdit.
# Blocks: writing secret-bearing files, editing already-committed migrations, committing .env.
# Contract: reads the tool call as JSON on stdin; exit 2 blocks the call and shows stderr to Claude.
set -uo pipefail

payload="$(cat)"
path="$(printf '%s' "$payload" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("tool_input",{}).get("file_path",""))' 2>/dev/null)"
content="$(printf '%s' "$payload" | python3 -c 'import json,sys;d=json.load(sys.stdin);i=d.get("tool_input",{});print(i.get("content") or i.get("new_string") or "")' 2>/dev/null)"

[ -z "$path" ] && exit 0
rel="${path#"$CLAUDE_PROJECT_DIR/"}"

# 1. Never create real secret files inside the repo.
case "$(basename "$path")" in
  .env|.env.local|.env.production|.env.*.local)
    echo "BLOCKED: $rel holds real secrets and must never live in the repository. Put placeholders in infra/.env.example and document the variable in docs/environment.md instead." >&2
    exit 2 ;;
esac
case "$path" in
  *.pem|*.key|*id_rsa*|*service-account*.json)
    echo "BLOCKED: $rel looks like a credential file. Secrets are supplied through the environment only (see CLAUDE.md section 9)." >&2
    exit 2 ;;
esac

# 2. Committed migrations are immutable (forward-only migration policy).
if [[ "$rel" == packages/db/migrations/*.sql ]]; then
  if git -C "$CLAUDE_PROJECT_DIR" ls-files --error-unmatch "$rel" >/dev/null 2>&1; then
    echo "BLOCKED: $rel is already committed. Migrations are forward-only — add packages/db/migrations/<next-number>_<description>.sql instead (see .claude/skills/db-migration)." >&2
    exit 2
  fi
fi

# 3. No hardcoded secret-looking literals in source.
if [ -n "$content" ]; then
  if printf '%s' "$content" | grep -qE '(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY-----|[0-9]{8,10}:AA[A-Za-z0-9_-]{30,})'; then
    echo "BLOCKED: $rel contains what looks like a real credential. Use process.env + infra/.env.example placeholders." >&2
    exit 2
  fi
fi

# 4. n8n workflow exports must not carry credential values.
if [[ "$rel" == n8n/workflows/*.json ]] && printf '%s' "$content" | grep -qE '"(accessToken|apiKey|password|oauthTokenData)"[[:space:]]*:[[:space:]]*"[^"]{8,}"'; then
  echo "BLOCKED: $rel embeds credential values. Export workflows with infra/scripts/n8n-export.sh, which strips them." >&2
  exit 2
fi

exit 0
