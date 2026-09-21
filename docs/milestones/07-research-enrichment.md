# Milestone 07 - Research and evidence enrichment

**STATUS: COMPLETE**

**OBJECTIVE:** Add reliable source evidence to technical content before generation.

## WHAT I BUILT

An evidence layer that can attach traceable sources to an atom, rank them by source quality,
deduplicate them by canonical URL, and - most importantly - refuse to let a failed or synthetic
search look like real evidence.

## TASKS COMPLETED

| #   | Atomic task                                          | Result                                                                                                                                                                               |
| --- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Define when research is required                     | `isResearchRequired`: technical kinds (`core_engineering`, `book_research`, `dsa`) or any atom naming a technology                                                                   |
| 2   | Source-quality hierarchy                             | `SOURCE_TYPE_RANK`: official docs > RFC > paper > source code > engineering blog > book > video > other                                                                              |
| 3   | Source-record schema                                 | `source_documents` table + `sourceDocument` zod contract                                                                                                                             |
| 4   | Search query generation                              | `buildQueries` - deterministic, entity-aware, capped at a search-engine-friendly length                                                                                              |
| 5   | Source retrieval                                     | `ResearchAdapter` with `mock` (default), `searxng`, `disabled`, `failing`                                                                                                            |
| 6   | Normalize URLs                                       | `canonicalizeUrl`: https, no `www.`, no fragment, tracking params stripped, params sorted, trailing slash removed                                                                    |
| 7   | Deduplicate by canonical URL                         | unique index `(content_atom_id, canonical_url)` + in-run dedup                                                                                                                       |
| 8   | Store title, URL, type, retrieved timestamp, excerpt | all stored, plus provider and relevance                                                                                                                                              |
| 9   | Link sources to the event/atom                       | both foreign keys, `ON DELETE RESTRICT`                                                                                                                                              |
| 10  | Mark claims supported / unsupported / needs-review   | atom `evidence_status`: `supported`, `partially_supported`, `needs_review`, `unsupported`, `research_failed`, `not_required`                                                         |
| 11  | Prevent a failed search from appearing as evidence   | failure sets `research_failed` and writes `error_events`; "disabled" (succeeds, no results) is a different state from "failed" - both tested                                         |
| 12  | Timeout and error handling                           | `AbortSignal.timeout`, typed transient/permanent failures, `Retry-After` honoured                                                                                                    |
| 13  | Retry policy                                         | `withRetry` with bounded attempts and backoff; retries only transient failures                                                                                                       |
| 14  | Fixture: topic with good documentation               | scripted RFC + official-docs hits -> `supported`                                                                                                                                     |
| 15  | Fixture: insufficient evidence                       | single source -> `partially_supported`; none -> `unsupported`; provider down -> `research_failed`                                                                                    |
| 16  | Verify no fabricated URLs                            | malformed, `javascript:` and credential-bearing URLs are dropped, never repaired; the mock provider only emits RFC 2606 reserved `example.com` hosts and marks results `[synthetic]` |
| 17  | Document source handling and limitations             | `docs/external-apis.md`, this report                                                                                                                                                 |

## FILES CREATED

`packages/utils/src/url.ts` + `url.test.ts`;
`packages/adapters/src/research/{types,source-type,mock,searxng,index}.ts` + `research.test.ts`;
`packages/db/src/repositories/source-documents.ts`;
`packages/core/src/research.ts` + `research.test.ts`.

## FILES MODIFIED

`packages/adapters/src/index.ts`, `packages/utils/src/index.ts`, `packages/db/src/index.ts`,
`packages/core/src/index.ts`, `apps/api/src/routes/pipeline.ts`, `apps/api/src/app.ts`,
`docs/external-apis.md`.

## TESTS RUN

```
TEST_DATABASE_URL=... pnpm verify                  # 284 tests
bash /tmp/live-research.sh                         # live failure-path drill
```

## TEST RESULTS

284 passed. New coverage: 5 URL canonicalization tests, 20 research-adapter tests (source typing,
determinism, synthetic-only hosts, SearxNG JSON mapping, 403/429/5xx/timeout classification,
`Retry-After`), 16 enrichment tests (ranking, dedup, idempotency, synthetic handling, failure,
disabled, not-required, retry, unknown atom).

**Live verification improved the implementation twice.** The first live run produced search
queries containing an entire 120-character derived title including its truncation ellipsis;
queries are now capped at the leading 8 keywords, with a test asserting the bound. The
failure-path drill confirmed the `research_failed` state end to end.

## MANUAL VERIFICATION

```
$ curl -X POST .../content-atoms/ca_.../research            # mock provider
{"evidence_status":"needs_review","sources_added":4,"sources_total":4,"synthetic_only":true,
 "sources":[{"url":"https://docs.example.com/auth/...","provider":"mock","relevance":0.89}, ...]}

$ # same call again
{"evidence_status":"needs_review","sources_added":0,"sources_total":4}      # idempotent

$ # RESEARCH_PROVIDER=failing
{"evidence_status":"research_failed","sources_added":0,"sources_total":0}
psql -> atom evidence: research_failed | error: E_RESEARCH_UNREACHABLE: research provider...
psql -> error rows: 3        (one per attempted query)
psql -> sources stored: 0    (a failed search stores nothing)
```

## SECURITY REVIEW

- Only `http(s)` URLs are stored; `javascript:`, `file:` and credential-bearing URLs are rejected
  by `canonicalizeUrl` (tested).
- Tracking parameters are stripped before storage, so no identifiers ride along in the corpus.
- Provider error bodies are truncated in failure details; no response body is logged wholesale.
- The research endpoint is behind the same bearer auth as the rest of the pipeline.
- No outbound request is made unless a real provider is configured - the default `mock` provider
  performs no network I/O at all.

## KNOWN LIMITATIONS

1. The SearxNG contract is **assumed**, not verified against a live instance (no instance and no
   credentials here). It is marked as such in `docs/external-apis.md`, defaults are mock, and the
   adapter is covered by fake-`fetch` tests. A 403 (JSON API not enabled) is classified permanent,
   which is the most likely first failure an operator will hit.
2. Evidence is attached at the source level; per-claim support marking (`claims[]` on the atom) is
   populated in Milestone 08, when the atom body with its claims is actually built.
3. Snippets come from the search provider; no page fetching or excerpt extraction is performed, so
   an excerpt is only as good as the result snippet. Fetching pages would add an SSRF surface that
   needs its own allow-listing design.
4. Relevance is a deterministic heuristic (source type + snippet substance), not semantic
   similarity.

## ACCEPTANCE CRITERIA

| Criterion                                        | Evidence                                                                                                                                        |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Technical ideas can receive traceable sources    | live run attached 4 sources with URL, type, provider and relevance, linked to the atom and the learning event                                   |
| Unsupported claims are visible                   | `evidence_status` distinguishes supported / partially_supported / needs_review / unsupported / research_failed / not_required                   |
| Source URLs are deduplicated                     | canonical-URL unique index + in-run dedup; re-running research added 0 sources (live and tested)                                                |
| Research failure does not silently become a PASS | provider down -> `research_failed`, 3 error rows, 0 sources stored, workflow run marked failed - and "disabled" is a separate, successful state |

## RECOMMENDED NEXT MILESTONE

08 - Canonical Content Atom.
