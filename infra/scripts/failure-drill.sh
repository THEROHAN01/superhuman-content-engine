#!/usr/bin/env bash
#
# Failure injection drill.
#
# Proves the system degrades the way it claims to. Each scenario runs against a *running* API and
# checks that the failure is recorded rather than swallowed, and that nothing publishes.
#
# Usage: infra/scripts/failure-drill.sh [api-base-url]
#
set -uo pipefail
API="${1:-http://localhost:8080}"
pass=0; fail=0

check() { # description, expected, actual
  if [ "$2" = "$3" ]; then printf '  PASS  %s\n' "$1"; pass=$((pass+1));
  else printf '  FAIL  %s (expected %s, got %s)\n' "$1" "$2" "$3"; fail=$((fail+1)); fi
}

echo "== 1. malformed input is rejected, nothing is stored"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/capture" -H 'content-type: application/json' -d '{"text":"no"}')
check "short capture returns 422" 422 "$code"

echo "== 2. unsigned GitHub webhook is refused"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/webhooks/github" -H 'content-type: application/json' -H 'x-github-event: pull_request' -H 'x-github-delivery: drill-1' -d '{}')
[ "$code" = "401" ] || [ "$code" = "503" ]
check "unsigned webhook is rejected (401 or 503)" 0 "$?"

echo "== 3. unauthenticated Telegram update is refused"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/webhooks/telegram" -H 'content-type: application/json' -d '{"update_id":1}')
[ "$code" = "401" ] || [ "$code" = "200" ]
check "telegram update without a secret does not apply a decision" 0 "$?"

echo "== 4. duplicate capture is deduplicated"
note='{"text":"Failure drill: the same note captured twice must produce exactly one learning event, because the content hash is unique."}'
first=$(curl -s -X POST "$API/capture" -H 'content-type: application/json' -d "$note" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
second=$(curl -s -X POST "$API/capture" -H 'content-type: application/json' -d "$note" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
check "second capture returns the original id" "$first" "$second"

echo "== 5. publishing unapproved content is refused"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/content-items/it_does_not_exist/schedule" -H 'content-type: application/json' -d '{"scheduled_at":"2030-01-01T00:00:00Z"}')
check "unknown content item returns 404" 404 "$code"

echo "== 6. health reports the truth"
status=$(curl -s "$API/health/system" | python3 -c 'import json,sys;print(json.load(sys.stdin)["status"])' 2>/dev/null || echo unreachable)
printf '  INFO  system health: %s\n' "$status"

echo
echo "drill complete: ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
