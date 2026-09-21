#!/usr/bin/env bash
# Export workflows from the running n8n into n8n/workflows/, stripping credential values and
# volatile fields so the JSON diffs cleanly in review.
set -euo pipefail
cd "$(dirname "$0")/.."
target="../n8n/workflows"

echo "==> exporting workflows from the n8n container"
docker compose exec -T n8n n8n export:workflow --all --pretty --output=/tmp/sce-export.json >/dev/null
docker compose exec -T n8n cat /tmp/sce-export.json > /tmp/sce-export.json

python3 - "$target" <<'PY'
import json, re, sys, pathlib

target = pathlib.Path(sys.argv[1])
target.mkdir(parents=True, exist_ok=True)
workflows = json.load(open('/tmp/sce-export.json'))
VOLATILE = {'versionId', 'updatedAt', 'createdAt', 'pinData', 'staticData', 'triggerCount', 'shared'}
SECRET = re.compile(r'(accessToken|apiKey|password|oauthTokenData|secret|token)$', re.I)

def scrub(value):
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            if k in VOLATILE:
                continue
            if k == 'credentials' and isinstance(v, dict):
                # keep the reference, never the contents
                out[k] = {ct: {'id': c.get('id'), 'name': c.get('name')} for ct, c in v.items()}
                continue
            if SECRET.search(k) and isinstance(v, str):
                out[k] = ''
                continue
            out[k] = scrub(v)
        return out
    if isinstance(value, list):
        return [scrub(v) for v in value]
    return value

for wf in workflows:
    clean = scrub(wf)
    clean.pop('id', None)
    name = clean.get('name', 'unnamed')
    path = target / f'{name}.json'
    path.write_text(json.dumps(clean, indent=2) + '\n')
    print(f'  {path}')
PY

echo "==> review the diff before committing: git diff n8n/workflows"
