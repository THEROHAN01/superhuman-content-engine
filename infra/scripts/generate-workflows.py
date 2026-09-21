import json, os, uuid, hashlib

OUT = 'n8n/workflows'
os.makedirs(OUT, exist_ok=True)

def nid(name):
    """Stable node id derived from its name, so exports diff cleanly."""
    return str(uuid.UUID(hashlib.sha1(name.encode()).hexdigest()[:32]))

def node(name, type_, tv, pos, params, extra=None):
    n = {"parameters": params, "id": nid(name), "name": name, "type": type_,
         "typeVersion": tv, "position": pos}
    if extra:
        n.update(extra)
    return n

def http(name, pos, url, method="GET", body=None, extra_params=None, extra=None):
    params = {
        "method": method,
        "url": url,
        "options": {"timeout": 15000, "response": {"response": {"neverError": False}}},
    }
    if body is not None:
        params.update({
            "sendBody": True,
            "specifyBody": "json",
            "jsonBody": body,
        })
    if extra_params:
        params.update(extra_params)
    node_extra = {"retryOnFail": True, "maxTries": 3, "waitBetweenTries": 2000,
                  "onError": "continueErrorOutput"}
    if extra:
        node_extra.update(extra)
    return node(name, "n8n-nodes-base.httpRequest", 4.2, pos, params, node_extra)

def conn(pairs):
    """pairs: list of (from, output_index, to)"""
    out = {}
    for src, idx, dst in pairs:
        entry = out.setdefault(src, {"main": []})
        while len(entry["main"]) <= idx:
            entry["main"].append([])
        entry["main"][idx].append({"node": dst, "type": "main", "index": 0})
    return out

def workflow(name, nodes, connections, settings=None, tags=None):
    wf = {
        "name": name,
        "nodes": nodes,
        "connections": connections,
        "active": False,
        "settings": settings or {"executionOrder": "v1", "saveManualExecutions": True,
                                 "callerPolicy": "workflowsFromSameOwner",
                                 "errorWorkflow": "system_error_handler_v1"},
        "tags": tags or [],
        "meta": {"templateId": "sce"},
    }
    with open(f"{OUT}/{name}.json", "w") as f:
        json.dump(wf, f, indent=2)
        f.write("\n")
    return wf

API = "={{ $env.SCE_API_BASE_URL }}"

# ---------------------------------------------------------------- 1. error handler
err_code = """// Normalize an n8n execution failure into the API's error-report contract.
const e = $json.execution ?? {};
const wf = $json.workflow ?? {};
const lastNode = e.lastNodeExecuted ?? null;
const message = (e.error?.message ?? 'workflow execution failed').slice(0, 4000);
return [{
  json: {
    workflow: wf.name ?? 'unknown_workflow',
    step: lastNode,
    kind: 'transient',
    code: 'E_N8N_EXECUTION_FAILED',
    message,
    correlation_id: e.id ? `cor_n8n_${e.id}` : undefined,
    details: { execution_url: e.url ?? null, mode: e.mode ?? null, retry_of: e.retryOf ?? null },
  },
}];"""
workflow("system_error_handler_v1", [
    node("Execution failed", "n8n-nodes-base.errorTrigger", 1, [0, 0], {}),
    node("Build error report", "n8n-nodes-base.code", 2, [220, 0], {"jsCode": err_code}),
    http("Record error", [460, 0], f"{API}/internal/errors", "POST",
         "={{ JSON.stringify($json) }}"),
    node("Reported", "n8n-nodes-base.noOp", 1, [700, -60], {}),
    node("Reporting failed", "n8n-nodes-base.noOp", 1, [700, 100], {}),
], conn([("Execution failed", 0, "Build error report"),
         ("Build error report", 0, "Record error"),
         ("Record error", 0, "Reported"),
         ("Record error", 1, "Reporting failed")]),
    settings={"executionOrder": "v1", "saveManualExecutions": True})

# ---------------------------------------------------------------- 2. learning capture
capture_code = """// Accept {text,...} from any caller; guarantee a correlation id exists before anything else.
const body = $json.body ?? $json;
const correlationId = body.correlation_id
  || $json.headers?.['x-correlation-id']
  || `cor_n8n_${$execution.id}`;
if (!body.text || String(body.text).trim().length < 10) {
  throw new Error('text is required and must be at least 10 characters');
}
return [{ json: {
  text: String(body.text),
  title: body.title,
  source: body.source ?? 'http',
  external_id: body.external_id,
  tags: body.tags ?? [],
  context: body.context ?? {},
  correlation_id: correlationId,
} }];"""
workflow("learning_capture_v1", [
    node("Capture webhook", "n8n-nodes-base.webhook", 2, [0, 0], {
        "httpMethod": "POST", "path": "sce/learning/capture",
        "responseMode": "responseNode", "options": {}}, {"webhookId": nid("sce/learning/capture")}),
    node("Normalize input", "n8n-nodes-base.code", 2, [220, 0], {"jsCode": capture_code}),
    http("POST /capture", [460, 0], f"{API}/capture", "POST", "={{ JSON.stringify($json) }}"),
    node("Respond", "n8n-nodes-base.respondToWebhook", 1.1, [720, -60], {
        "respondWith": "json",
        "responseBody": "={{ JSON.stringify($json) }}"}),
    node("Report failure", "n8n-nodes-base.executeWorkflow", 1.2, [720, 120], {
        "workflowId": "system_error_handler_v1",
        "workflowInputs": {"mappingMode": "defineBelow", "value": {}}}),
], conn([("Capture webhook", 0, "Normalize input"),
         ("Normalize input", 0, "POST /capture"),
         ("POST /capture", 0, "Respond"),
         ("POST /capture", 1, "Report failure")]))

# ---------------------------------------------------------------- 3. health check (scheduled)
workflow("system_health_check_v1", [
    node("Every 15 minutes", "n8n-nodes-base.scheduleTrigger", 1.2, [0, 0],
         {"rule": {"interval": [{"field": "minutes", "minutesInterval": 15}]}}),
    http("GET /health/ready", [240, 0], f"{API}/health/ready"),
    node("Healthy?", "n8n-nodes-base.if", 2, [480, 0], {
        "conditions": {"options": {"caseSensitive": True, "version": 2},
                       "combinator": "and",
                       "conditions": [{"id": "ready", "operator": {"type": "string", "operation": "equals"},
                                       "leftValue": "={{ $json.status }}", "rightValue": "ready"}]}}),
    node("Healthy", "n8n-nodes-base.noOp", 1, [720, -80], {}),
    http("Report degraded", [720, 120], f"{API}/internal/errors", "POST",
         '={{ JSON.stringify({workflow: "system_health_check_v1", step: "health", kind: "transient", '
         'code: "E_HEALTH_DEGRADED", message: "readiness probe reported " + ($json.status ?? "unreachable"), '
         'details: $json.checks ?? {}}) }}'),
    node("Degradation recorded", "n8n-nodes-base.noOp", 1, [980, 40], {}),
    node("Could not record degradation", "n8n-nodes-base.noOp", 1, [980, 200], {}),
], conn([("Every 15 minutes", 0, "GET /health/ready"),
         ("GET /health/ready", 0, "Healthy?"),
         ("GET /health/ready", 1, "Report degraded"),
         ("Healthy?", 0, "Healthy"),
         ("Healthy?", 1, "Report degraded"),
         ("Report degraded", 0, "Degradation recorded"),
         ("Report degraded", 1, "Could not record degradation")]))

# ---------------------------------------------------------------- 4. test webhook
workflow("test_webhook_v1", [
    node("Test webhook", "n8n-nodes-base.webhook", 2, [0, 0], {
        "httpMethod": "POST", "path": "sce/test/echo", "responseMode": "responseNode",
        "options": {}}, {"webhookId": nid("sce/test/echo")}),
    node("Echo with correlation id", "n8n-nodes-base.code", 2, [240, 0], {"jsCode":
        "// Smoke test: proves the webhook path works and that correlation ids are threaded.\n"
        "const correlationId = $json.body?.correlation_id || `cor_n8n_${$execution.id}`;\n"
        "return [{ json: { ok: true, received: $json.body ?? null, correlation_id: correlationId } }];"}),
    node("Respond", "n8n-nodes-base.respondToWebhook", 1.1, [480, 0], {
        "respondWith": "json", "responseBody": "={{ JSON.stringify($json) }}"}),
], conn([("Test webhook", 0, "Echo with correlation id"),
         ("Echo with correlation id", 0, "Respond")]))

# ---------------------------------------------------------------- 5. database connectivity
workflow("test_db_connectivity_v1", [
    node("Run manually", "n8n-nodes-base.manualTrigger", 1, [0, 0], {}),
    node("Count learning events", "n8n-nodes-base.postgres", 2.4, [240, 0], {
        "operation": "executeQuery",
        "query": "SELECT count(*)::int AS learning_events, now() AS checked_at FROM learning_events",
        "options": {}},
        {"credentials": {"postgres": {"id": "sce_postgres_local", "name": "sce_postgres_local"}},
         "retryOnFail": True, "maxTries": 3, "waitBetweenTries": 2000,
         "onError": "continueErrorOutput"}),
    node("Connected", "n8n-nodes-base.noOp", 1, [480, -60], {}),
    node("Connection failed", "n8n-nodes-base.noOp", 1, [480, 100], {}),
], conn([("Run manually", 0, "Count learning events"),
         ("Count learning events", 0, "Connected"),
         ("Count learning events", 1, "Connection failed")]))

# ---------------------------------------------------------------- 6. http connectivity
workflow("test_http_connectivity_v1", [
    node("Run manually", "n8n-nodes-base.manualTrigger", 1, [0, 0], {}),
    http("GET /health/live", [240, 0], f"{API}/health/live"),
    node("API reachable", "n8n-nodes-base.noOp", 1, [480, -60], {}),
    node("API unreachable", "n8n-nodes-base.noOp", 1, [480, 100], {}),
], conn([("Run manually", 0, "GET /health/live"),
         ("GET /health/live", 0, "API reachable"),
         ("GET /health/live", 1, "API unreachable")]))

print("generated:", sorted(os.listdir(OUT)))
