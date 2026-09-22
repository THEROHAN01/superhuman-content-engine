#!/usr/bin/env bash
#
# End-to-end demonstration against a *running* API.
#
# Walks one learning note through the whole engine - capture, normalize, classify, dedupe, atom,
# research, ideation, five platform-native drafts, quality gate, approval, scheduling, publication,
# analytics, weekly intelligence - printing the id produced at every hop so the provenance chain is
# visible as it is built. Then it replays the path and shows that nothing happened twice.
#
# It never publishes anything: PUBLISH_MODE stays dry_run and the publishing adapter is `mock`.
#
# Usage:
#   pnpm dev:api &                        # or: infra/scripts/start.sh --with-app
#   RESEARCH_PROVIDER=fixture pnpm dev:api
#   infra/scripts/demo.sh [api-base-url]
#
# The quality gate blocks drafts whose only evidence is synthetic, which is what the `mock`
# research provider produces by design. Run the API with RESEARCH_PROVIDER=fixture to see the path
# continue past the gate; with `mock` the demo stops at the gate and says so, which is the gate
# doing its job rather than a failure.
#
set -uo pipefail
API="${1:-http://localhost:8080}"
AUTH=()
[ -n "${CAPTURE_API_TOKEN:-}" ] && AUTH=(-H "authorization: Bearer ${CAPTURE_API_TOKEN}")

jqf() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval('d'+sys.argv[1]) if sys.argv[1] else d)" "$1" 2>/dev/null; }

post() { # path, json
  curl -sS -X POST "$API$1" -H 'content-type: application/json' "${AUTH[@]}" -d "${2:-{\}}"
}
get() { curl -sS "$API$1" "${AUTH[@]}"; }

step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
show() { printf '   %-22s %s\n' "$1" "$2"; }
die()  { printf '\n!! %s\n' "$1"; exit 1; }

NOTE='Today I learned why refresh-token rotation matters. A long-lived static refresh token cannot be distinguished from a stolen one, because both present the same credential. With rotation each refresh issues a new token and invalidates its predecessor, so a replayed old token proves theft and lets the server revoke the whole family. The trade-off is a rotation race when two requests refresh at once.'
SLOT="$(python3 -c 'import datetime;print((datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(days=1)).replace(microsecond=0).isoformat().replace("+00:00","Z"))')"
EXTERNAL_ID="demo-$(date +%s)"

step "0. the API is up and refuses to publish for real"
ready=$(get /health/ready) || die "the API is not reachable at $API"
show "publish mode" "$(printf '%s' "$ready" | jqf "['config']['publish_mode']")"
show "database" "$(printf '%s' "$ready" | jqf "['checks']['database']['ok']")"
[ "$(printf '%s' "$ready" | jqf "['config']['publish_mode']")" = "dry_run" ] ||
  die "PUBLISH_MODE is not dry_run - refusing to run a demo that could publish"

step "1-4. capture, normalize, classify, deduplicate"
captured=$(post /capture "$(python3 -c 'import json,sys;print(json.dumps({"text":sys.argv[1],"source":"manual","external_id":sys.argv[2]}))' "$NOTE" "$EXTERNAL_ID")")
LE=$(printf '%s' "$captured" | jqf "['id']")
[ -n "$LE" ] || die "capture failed: $captured"
show "learning event" "$LE"

processed=$(post "/learning-events/$LE/process")
ATOM=$(printf '%s' "$processed" | jqf "['content_atom_id']")
show "status" "$(printf '%s' "$processed" | jqf "['status']")"
show "topic" "$(printf '%s' "$processed" | jqf "['classification']['primary_topic']")"
show "duplicate of" "$(printf '%s' "$processed" | jqf "['duplicate_of']")"
show "content atom" "$ATOM"
[ "$ATOM" != "None" ] && [ -n "$ATOM" ] || die "no atom was created: $processed"

step "5-6. research enrichment and the canonical atom"
research=$(post "/content-atoms/$ATOM/research")
show "evidence" "$(printf '%s' "$research" | jqf "['evidence_status']")"
show "sources" "$(printf '%s' "$research" | jqf "['sources_total']")"
show "synthetic only" "$(printf '%s' "$research" | jqf "['synthetic_only']")"
built=$(post "/content-atoms/$ATOM/build")
show "atom status" "$(printf '%s' "$built" | jqf "['status']")"
show "unsupported claims" "$(printf '%s' "$built" | jqf "['unsupported_claims']")"

step "7. content ideas"
ideas=$(post "/content-atoms/$ATOM/ideas" '{"queue":2}')
IDEA=$(printf '%s' "$ideas" | jqf "['ideas'][0]['id']")
printf '%s' "$ideas" | python3 -c '
import json,sys
for idea in json.load(sys.stdin)["ideas"]:
    print("   %-20s %-5s %s" % (idea["angle"], idea["score"], idea["title"][:60]))'

step "8-12. one draft per platform-native format"
generated=$(post "/content-ideas/$IDEA/generate" '{"formats":["x_post","x_thread","linkedin_post","reel_script","carousel"]}')
printf '%s' "$generated" | python3 -c '
import json,sys
d = json.load(sys.stdin)
print("   %-22s %s" % ("generated now", len(d["generated"])))
print("   %-22s %s" % ("already existed", len(d["skipped"])))
for f in d["failures"]: print("   FAILED %s" % f)'

# Read the live drafts back rather than trusting the generate response: on a re-run nothing is
# generated again, and the drafts that already exist are the ones to work with.
listed=$(get "/content-ideas/$IDEA/items")
printf '%s' "$listed" | python3 -c '
import json,sys
for item in json.load(sys.stdin)["items"]:
    print("   %-16s %s  v%s  %-12s %s unit(s)" % (item["format"], item["id"], item["version"], item["status"], len(item["draft"]["units"])))'
ITEMS=$(printf '%s' "$listed" | python3 -c '
import json,sys
ORDER = ["x_post", "x_thread", "linkedin_post", "reel_script", "carousel"]
live = {}
for item in json.load(sys.stdin)["items"]:
    if item["status"] == "superseded":
        continue
    best = live.get(item["format"])
    if best is None or item["version"] > best["version"]:
        live[item["format"]] = item
print(" ".join(live[f]["id"] for f in ORDER if f in live))')
[ -n "$ITEMS" ] || die "no drafts exist for this idea: $generated"

step "13. quality gate"
# An item is actionable only if it passed the gate *and* is still waiting for a decision. On a
# re-run against the same database most drafts have already been decided, which is not a failure.
ACTIONABLE=""
for item in $ITEMS; do
  gate=$(post "/content-items/$item/gate")
  verdict=$(printf '%s' "$gate" | jqf "['verdict']")
  status=$(printf '%s' "$gate" | jqf "['status']")
  printf '   %-28s %-8s %-10s score %s\n' "$item" "$verdict" "$status" \
    "$(printf '%s' "$gate" | jqf "['score']")"
  printf '%s' "$gate" | python3 -c '
import json,sys
for r in json.load(sys.stdin)["reasons"]:
    print("       %-6s %s: %s" % (r["severity"], r["code"], r["detail"][:70]))'
  [ "$verdict" = "pass" ] && [ "$status" = "gated" ] && ACTIONABLE="$ACTIONABLE $item"
done

PUB=""
APPROVE_ID=$(echo $ACTIONABLE | awk '{print $1}')

if [ -z "$APPROVE_ID" ]; then
  step "14-19. approval and publication"
  cat <<'NOTE_ALREADY'
   No draft is waiting for a decision. Either the gate blocked them all - which is the
   expected outcome with RESEARCH_PROVIDER=mock, whose evidence is synthetic and cannot
   support public claims - or this note has already been walked end to end in this
   database. The existing chain is shown below; `infra/scripts/reset.sh --force` gives a
   clean database to demo against.
NOTE_ALREADY
  for item in $ITEMS; do
    found=$(get "/content-items/$item/publications" | jqf "['publications'][0]['id'] if d['count'] else ''")
    [ -n "$found" ] && { PUB="$found"; APPROVE_ID="$item"; break; }
  done
  [ -n "$PUB" ] || { step "done"; echo "   Nothing was published - and nothing was meant to be."; exit 0; }
  show "existing item" "$APPROVE_ID"
  show "existing publication" "$PUB"
else
  step "14-17. approval: send the card, approve one, reject one, regenerate one"
  REJECT_ID=$(echo $ACTIONABLE | awk '{print $2}')
  REGEN_ID=$(echo $ACTIONABLE | awk '{print $3}')
  for item in $APPROVE_ID $REJECT_ID $REGEN_ID; do
    card=$(post "/content-items/$item/request-approval")
    show "card sent" "$item -> $(printf '%s' "$card" | jqf "['status']")"
  done
  show "approve" "$(post "/content-items/$APPROVE_ID/decide" '{"action":"approve","decided_by":"demo"}' | jqf "['status']")"
  [ -n "$REJECT_ID" ] && show "reject" "$(post "/content-items/$REJECT_ID/decide" '{"action":"reject","decided_by":"demo","note":"off-voice"}' | jqf "['status']")"
  [ -n "$REGEN_ID" ] && show "regenerate" "$(post "/content-items/$REGEN_ID/decide" '{"action":"regenerate","decided_by":"demo"}' | jqf "['regenerated_item_id']")"

  step "18-19. schedule and record the publication"
  scheduled=$(post "/content-items/$APPROVE_ID/schedule" "{\"scheduled_at\":\"$SLOT\"}")
  PUB=$(printf '%s' "$scheduled" | jqf "['publication_id']")
  [ -n "$PUB" ] || die "scheduling failed: $scheduled"
  show "publication" "$PUB"
  show "status" "$(printf '%s' "$scheduled" | jqf "['status']")"
  show "dry run" "$(printf '%s' "$scheduled" | jqf "['dry_run']")"
  show "external id" "$(printf '%s' "$scheduled" | jqf "['external_id']")"
  show "marked published" "$(post "/publications/$PUB/mark-published" | jqf "['status']")"
fi

step "20. analytics"
metrics=$(post "/publications/$PUB/collect-analytics" '{"window":"24h"}')
show "analytics event" "$(printf '%s' "$metrics" | jqf "['analytics_event_id']")"
show "simulated" "$(printf '%s' "$metrics" | jqf "['simulated']")"
# A metric this platform does not report stays null. Unknown is not zero.
printf '%s' "$metrics" | python3 -c '
import json,sys
d = json.load(sys.stdin)
for k, v in d["metrics"].items():
    print("   %-22s %s" % (k, "unknown" if v is None else v))
for k, v in d["derived"].items():
    print("   %-22s %s" % ("derived " + k, "unknown" if v is None else v))'

step "21. weekly intelligence"
report=$(post /reports/weekly '{}')
show "report" "$(printf '%s' "$report" | jqf "['report_id']")"
show "week" "$(printf '%s' "$report" | jqf "['period_key']")"
printf '%s' "$report" | python3 -c '
import json,sys
d = json.load(sys.stdin)
for k, v in d["counts"].items(): print("   %-26s %s" % (k, v))
for sig in d["signals"]: print("   signal  [%s] %s" % (sig["confidence"], sig["statement"]))'

step "22. every record links back to the original learning event"
show "learning event" "$LE"
show "atom" "$ATOM"
show "item" "$APPROVE_ID"
show "publication" "$PUB"
get "/content-items/$APPROVE_ID/analytics" | python3 -c '
import json,sys
for e in json.load(sys.stdin)["events"]:
    print("   analytics %s -> learning event %s" % (e["id"], e["learning_event_id"]))'

step "23-24. replay the whole path: nothing may happen twice"
replay=$(post /capture "$(python3 -c 'import json,sys;print(json.dumps({"text":sys.argv[1],"source":"manual","external_id":sys.argv[2]}))' "$NOTE" "$EXTERNAL_ID")")
show "same event?" "$(printf '%s' "$replay" | jqf "['id']") (duplicate=$(printf '%s' "$replay" | jqf "['duplicate']"))"
show "re-process" "$(post "/learning-events/$LE/process" | jqf "['unchanged']") (unchanged)"
show "re-research" "$(post "/content-atoms/$ATOM/research" | jqf "['sources_added']") source(s) added"
show "re-gate" "$(post "/content-items/$APPROVE_ID/gate" | jqf "['unchanged']") (unchanged)"
show "re-schedule" "$(post "/content-items/$APPROVE_ID/schedule" "{\"scheduled_at\":\"$SLOT\"}" | jqf "['error']['code'] if 'error' in d else d['publication_id']")"
show "re-collect" "$(post "/publications/$PUB/collect-analytics" '{"window":"24h"}' | jqf "['inserted']") (inserted)"
show "publications" "$(get "/content-items/$APPROVE_ID/publications" | jqf "['count']")"

step "done"
cat <<INFO
   Nothing was published: every publication above is a dry run against the mock provider.
   Inspect the chain in SQL with:

     psql "\$DATABASE_URL" -c "SELECT id, status FROM learning_events WHERE id = '$LE'"
     psql "\$DATABASE_URL" -c "SELECT id, status, dry_run FROM publications WHERE learning_event_id = '$LE'"
INFO
