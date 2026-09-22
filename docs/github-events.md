# GitHub to content opportunities

Merged pull requests and published releases enter the pipeline as **learning events**, exactly
like a hand-written note. That is the whole design: no parallel path, no separate content type,
and the same human approval before anything is published.

```
GitHub webhook -> signature check -> delivery recorded -> significance filter
   -> learning_events (source: github, external_id: pr:<id> | release:<id>)
   -> the normal pipeline (normalize, classify, atom, research, ideas, drafts, gate, approval)
```

## Events handled

| Event          | Condition                             | Ignored otherwise                                              |
| -------------- | ------------------------------------- | -------------------------------------------------------------- |
| `pull_request` | `action=closed` **and** `merged=true` | opened, closed-unmerged, edited - abandoned or unfinished work |
| `release`      | `action=published` and not a draft    | drafts and created-but-unpublished                             |

Anything else is explicitly reported as "not handled" rather than partially processed.

## Significance filter

Most merges are not worth writing about. The filter errs towards letting borderline work through -
a human approves everything downstream anyway - and it always explains itself.

| Outcome         | Rule                                                                                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **significant** | a meaningful label (`feature`, `architecture`, `performance`, `security`, `refactor`, `postmortem`, `content`) - the no-API-call manual override      |
| **significant** | a release whose notes are substantive (80+ characters)                                                                                                |
| **significant** | a merged PR with a description of 120+ characters that is not routine maintenance; scored higher when the description explains a cause or a trade-off |
| filtered        | title matching `chore/style/ci/build/docs/typo/bump/deps/revert`, or a dependency bump / merge commit                                                 |
| filtered        | description under 120 characters - nothing to learn from                                                                                              |
| filtered        | single-file change of fewer than ten lines                                                                                                            |
| filtered        | release with empty notes                                                                                                                              |

Every filtered event returns its reason, and `POST /github/opportunities/force` re-submits it with
the filter bypassed (recorded as `significance.forced = true` on the learning event).

## Deduplication - two independent layers

| Layer    | Key                                                                                     | Catches                                                                        |
| -------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| delivery | `webhook_deliveries (provider, delivery_id)`                                            | GitHub redelivering after a timeout                                            |
| event    | `learning_events (source, external_id)` where external id is `pr:<id>` / `release:<id>` | the same PR arriving through different deliveries, or being edited and re-sent |

A redelivered webhook returns `duplicate_delivery`; a re-sent PR returns `duplicate`. Neither
creates a second opportunity.

## Security

- The signature is verified against the **raw** request bytes (`rawBodyPlugin` keeps them), because
  re-serialized JSON would not match what GitHub signed. HMAC-SHA256, constant-time comparison.
- Missing, malformed and mismatched signatures are distinguished in the response and logged, but
  none of them is processed.
- With no `GITHUB_WEBHOOK_SECRET` configured, the endpoint returns 503 rather than accepting
  unauthenticated events - an unauthenticated event would let anyone inject content.
- The manual force endpoint sits behind the operator bearer token, not the GitHub signature.

## What gets stored

The learning text quotes GitHub verbatim (title, description, change stats, URL) - nothing is
summarized before storage, because the rest of the pipeline treats the original wording as source
material. Provenance lives in `context`: repository, URL, ref, SHA, author, merge time, stats, and
the significance verdict that let it through.

`captured_at` is the **merge or release time**, not the ingest time, so weekly reporting attributes
the work to when it happened.
