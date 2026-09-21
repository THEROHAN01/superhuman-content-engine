#!/usr/bin/env bash
# PreToolUse guard for Bash. Blocks irreversible or policy-violating commands.
#
# Design note: only *executable* text is inspected. Heredoc bodies are data (documentation,
# generated files), so writing a doc that mentions a dangerous command is allowed while running
# that command is not.
set -uo pipefail

cmd="$(cat | python3 -c 'import json,sys;print(json.load(sys.stdin).get("tool_input",{}).get("command",""))' 2>/dev/null)"
[ -z "$cmd" ] && exit 0

cmd="$(printf '%s' "$cmd" | python3 -c '
import re, sys
text = sys.stdin.read()
out, terminator = [], None
for line in text.splitlines():
    if terminator is not None:
        if line.strip() == terminator:
            terminator = None
        continue
    m = re.search(r"<<-?\s*[\x27\"]?([A-Za-z_][A-Za-z0-9_]*)[\x27\"]?", line)
    if m:
        terminator = m.group(1)
    out.append(line)
print("\n".join(out))
')"
[ -z "${cmd//[[:space:]]/}" ] && exit 0

block() { echo "BLOCKED: $1" >&2; exit 2; }
at_stmt='(^|[;&|(]|&&)[[:space:]]*'

# History rewrite on a shared branch
grep -qE 'git +push[^|;&]*(--force(-with-lease)?|[[:space:]]-f([[:space:]]|$))' <<<"$cmd" && \
  grep -qE '(main|master|origin/(main|master))' <<<"$cmd" && \
  block "force-pushing to a shared branch. Push to the feature branch normally."

# Bypassing the repository's own checks
grep -qE "git +commit[^|;&]*--no-verify" <<<"$cmd" && \
  block "committing with --no-verify skips the repo checks. Run 'pnpm verify' and fix the failures."

# Destroying local data volumes outside the documented script
grep -qE "${at_stmt}(sudo +)?docker +compose[^|;&]*down[^|;&]*(-v|--volumes)" <<<"$cmd" && \
  ! grep -q 'infra/scripts/reset.sh' <<<"$cmd" && \
  block "that command deletes the Postgres/n8n/Ollama volumes. Use infra/scripts/reset.sh, which warns and confirms first."

grep -qE "${at_stmt}(sudo +)?rm +-[a-zA-Z]*r[a-zA-Z]* +/( |$)" <<<"$cmd" && block "recursive delete of the filesystem root."

grep -qE '\b(dropdb|DROP +DATABASE)\b' <<<"$cmd" && ! grep -qiE '(test|check|tmp|_ci)' <<<"$cmd" && \
  block "dropping a non-test database. Test databases must be named *_test/*_check."

# Real publishing during development
grep -qE "${at_stmt}([A-Z_]+=[^[:space:]]*[[:space:]]+)*PUBLISH_MODE=live[[:space:]]" <<<"$cmd" && \
  block "live publish mode sends real social content. Development runs in dry_run/mock (CLAUDE.md rule 2)."

# Wrong package manager
grep -qE "${at_stmt}(npm|yarn) +(install|add|i)([[:space:]]|$)" <<<"$cmd" && \
  block "this workspace uses pnpm. Use the pnpm equivalent."

exit 0
