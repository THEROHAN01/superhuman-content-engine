# Build Plan (source of truth)

Extracted verbatim from `superhuman_content_engine_complete_claude_build_plan.pdf` (42 pages,
2026-09-21). This file is the product specification for the repository. Where the spec and the
repository disagree, investigate before changing either, and record the decision in
`docs/decisions.md`.

---

SUPERHUMAN CONTENT ENGINE
 Complete Claude Build Plan
 Atomic task checklist + milestone prompts + review loop + acceptance tests
Purpose
Give Claude one controlled task at a time, force verification, inspect the result, fix defects,
and only then move to the next task. The end goal is a production-shaped personal content
automation system - not a pile of untested AI workflows.
Core stack: Docker Compose | n8n | PostgreSQL | Redis | Ollama | Postiz | Telegram | Notion | GitHub | GitHub Actions
Recommended initial operating mode: local/self-hosted development, test/sandbox social accounts, and human approval before any
real publishing.

1. How to Use This Document
There are 18 milestones and hundreds of atomic tasks. Do not hand Claude the entire list at once. Use the
controller prompt, then delegate one milestone. After implementation, run the review prompt. Only after
PASS do you delegate the next milestone.
 LOOP
YOU -> "Start Milestone 01"
CLAUDE -> inspect -> implement -> test -> self-review -> report
YOU -> "Run the milestone review"
CLAUDE -> audit -> fix -> re-test -> PASS / FAIL
YOU -> "Start Milestone 02"
...
YOU -> "Start Milestone 18"
CLAUDE -> full end-to-end verification -> final audit
Rules that apply to every milestone:
 - [ ] Inspect the current repository before changing files.
 - [ ] Do not assume that a file, dependency, API, credential, or service exists.
 - [ ] Do not jump into future milestones.
 - [ ] Preserve working functionality and existing conventions unless there is a documented reason to change them.
 - [ ] Use real executable tests wherever practical; never replace testing with a statement that something 'should
 work'.
- [ ] Keep all secrets out of source control and out of generated logs.
 - [ ] Make repeated workflow runs safe through idempotency and deduplication.
 - [ ] Document every environment variable and external dependency.
 - [ ] Prefer small modules/workflows with explicit inputs and outputs.
 - [ ] Do not publish real content during development unless explicitly instructed.
 - [ ] Record source/provenance from original learning event to generated content.
 - [ ] Update README and milestone documentation before declaring the milestone complete.

2. Target Architecture
 ROHAN
learn / solve / build / capture
|
v
LEARNING INBOX
Notion or Telegram intake
|
v
n8n ORCHESTRATOR
validate -> enrich -> generate
-> quality gate -> approval
|
+----------+----------+
| |
v v
Content Database Source Database
| |
+----------+----------+
|
v
APPROVAL QUEUE
Telegram
|
v
POSTIZ
schedule / publish
X / LinkedIn / IG

|
v
ANALYTICS
|
v
WEEKLY INTELLIGENCE
|
+------> next content / learning ideas
Target repository:
 superhuman-content-engine/
├── apps/
│ ├── api/ # optional internal HTTP API
│ ├── bot/ # optional Telegram helper
│ └── workers/ # optional background jobs
├── infra/
│ ├── docker-compose.yml
│ ├── .env.example
│ └── scripts/
├── n8n/
│ ├── workflows/
│ ├── credentials/ # examples only, never secrets
│ └── README.md
├── packages/
│ ├── schemas/
│ ├── prompts/
│ ├── adapters/
│ └── utils/
├── docs/
├── tests/
├── data/
└── README.md
Claude may adapt this structure after repository reconnaissance. The structure is a target, not a reason to
restructure a healthy existing repository.

01. Milestone 01 - Repository reconnaissance
and technical design
Objective: Know exactly what exists, what must be built, and what will be preserved.
Task count: 15 atomic tasks
Implementation checklist
 - [ ] List the repository root and every relevant source/config/test file.
 - [ ] Identify the language, package manager, runtime versions, build system, and current scripts.
 - [ ] Inspect existing Docker, Compose, environment, CI/CD, database, and deployment files.
 - [ ] Inspect Git history for architectural intent and recent changes.
 - [ ] Search for existing Notion, Telegram, social, AI, database, queue, or automation integrations.
 - [ ] Search for TODO/FIXME markers and unfinished features.
 - [ ] Identify any existing content schema, prompt files, or content pipeline code.
 - [ ] Document external dependencies and which ones require credentials.
 - [ ] Identify what can be reused instead of recreated.
 - [ ] Create docs/reconnaissance.md containing current-state architecture.
 - [ ] Create docs/architecture.md with target-state architecture.
 - [ ] Create an explicit list of files that Claude expects to create or modify in later milestones.
 - [ ] Create a risk register with at least dependency, credential, rate-limit, duplication, and failure-mode risks.
 - [ ] Define local-development assumptions and sandbox/test-account policy.
 - [ ] Do not modify application behavior during this milestone.

Acceptance criteria
 - [ ] Repository inventory is documented.
 - [ ] Current architecture and target architecture are documented.
 - [ ] External dependencies and credential requirements are documented.
 - [ ] No application feature was changed unnecessarily.
 - [ ] Claude can explain the next milestone without guessing.

Claude completion report must include
 - [ ] STATUS: COMPLETE or BLOCKED
 - [ ] What was built
 - [ ] Files created
 - [ ] Files modified
 - [ ] Tests/commands run and results
 - [ ] Manual verification evidence
 - [ ] Known limitations
 - [ ] Security/secrets review
 - [ ] Git diff summary
 - [ ] Recommended next milestone

02. Milestone 02 - Docker and local
infrastructure
Objective: Create a reproducible local runtime for the automation stack.
Task count: 19 atomic tasks
Implementation checklist
 - [ ] Choose supported container images/versions for PostgreSQL, Redis, n8n, and Ollama.
 - [ ] Create infra/docker-compose.yml.
 - [ ] Create named persistent volumes for stateful services.
 - [ ] Create an isolated Docker network.
 - [ ] Add service health checks where supported.
 - [ ] Expose only the ports required for local development.
 - [ ] Create .env.example with placeholders for all required settings.
 - [ ] Create infra/scripts/start.sh or equivalent startup script.
 - [ ] Create infra/scripts/stop.sh.
 - [ ] Create infra/scripts/reset.sh with an explicit warning about data destruction.
 - [ ] Configure timezone consistently.
 - [ ] Configure PostgreSQL initialization settings.
 - [ ] Configure n8n persistence.
 - [ ] Configure Ollama persistence/model storage.
 - [ ] Document first-run commands.
 - [ ] Start the complete stack from a clean state.
 - [ ] Verify service health individually.
 - [ ] Verify restart persistence.
 - [ ] Do not add cloud deployment yet.

Acceptance criteria
 - [ ] All core services start from documented commands.
 - [ ] Data survives a normal restart.
 - [ ] Reset behavior is explicit and safe.
 - [ ] No real credentials are committed.
 - [ ] Health checks and ports are documented.

Claude completion report must include
 - [ ] STATUS: COMPLETE or BLOCKED
 - [ ] What was built
 - [ ] Files created
 - [ ] Files modified
 - [ ] Tests/commands run and results
 - [ ] Manual verification evidence
 - [ ] Known limitations
 - [ ] Security/secrets review
 - [ ] Git diff summary
 - [ ] Recommended next milestone

03. Milestone 03 - Database and shared
schemas
Objective: Create durable internal state and stable contracts between workflows.
Task count: 21 atomic tasks
Implementation checklist
 - [ ] Choose the database access approach already consistent with the repository.
 - [ ] Create migration strategy.
 - [ ] Define learning_events table/model.
 - [ ] Define content_atoms table/model.
 - [ ] Define content_items table/model.
 - [ ] Define sources/source_documents table/model.
 - [ ] Define approvals table/model.
 - [ ] Define publications table/model.
 - [ ] Define analytics_events table/model.
 - [ ] Define workflow_runs/error_events table/model where useful.
 - [ ] Add created_at and updated_at timestamps.
 - [ ] Add stable primary keys.
 - [ ] Add status fields/enums where workflow state matters.
 - [ ] Add unique constraints for external IDs and idempotency keys.
 - [ ] Add indexes for status, scheduled time, source ID, topic, and publication lookup paths.
 - [ ] Create seed/example records.
 - [ ] Define JSON schemas or typed interfaces for key workflow payloads.
 - [ ] Write tests for schema validation and database constraints.
 - [ ] Run migrations against an empty database.
 - [ ] Run migrations against the already-running development database.
 - [ ] Verify duplicate keys are rejected as designed.

Acceptance criteria
 - [ ] Migrations are reproducible.
 - [ ] Core tables exist.
 - [ ] Constraints prevent obvious duplication.
 - [ ] Seed/test data can be created and removed safely.
 - [ ] Shared payload schemas are versioned or clearly defined.

Claude completion report must include
 - [ ] STATUS: COMPLETE or BLOCKED
 - [ ] What was built
 - [ ] Files created
 - [ ] Files modified
 - [ ] Tests/commands run and results
 - [ ] Manual verification evidence
 - [ ] Known limitations
 - [ ] Security/secrets review
 - [ ] Git diff summary
 - [ ] Recommended next milestone

04. Milestone 04 - Learning Inbox and capture
API
Objective: Capture daily learning with minimum friction.
Task count: 16 atomic tasks
Implementation checklist
 - [ ] Define the minimal learning-event input contract.
 - [ ] Implement a POST/webhook intake or an existing Notion integration.
 - [ ] Implement optional Telegram intake command.
 - [ ] Validate required fields.
 - [ ] Trim/normalize input.
 - [ ] Generate a unique learning event ID.
 - [ ] Store original raw input unchanged.
 - [ ] Store capture source and timestamp.
 - [ ] Return a human-readable confirmation.
 - [ ] Implement GET/retrieval for a learning event.
 - [ ] Implement update/status support if needed.
 - [ ] Reject malformed requests with useful error messages.
 - [ ] Add authentication for non-local endpoints where applicable.
 - [ ] Add request correlation ID.
 - [ ] Add automated tests for valid and invalid payloads.
 - [ ] Perform an end-to-end capture smoke test.

Acceptance criteria
 - [ ] A short note creates exactly one learning event.
 - [ ] Original text is preserved.
 - [ ] Malformed inputs fail safely.
 - [ ] Repeated requests can be detected or deduplicated.
 - [ ] Retrieval returns the stored event and metadata.

Claude completion report must include
 - [ ] STATUS: COMPLETE or BLOCKED
 - [ ] What was built
 - [ ] Files created
 - [ ] Files modified
 - [ ] Tests/commands run and results
 - [ ] Manual verification evidence
 - [ ] Known limitations
 - [ ] Security/secrets review
 - [ ] Git diff summary
 - [ ] Recommended next milestone

05. Milestone 05 - n8n orchestration
foundation
Objective: Make n8n a version-controlled and observable orchestration layer.
Task count: 16 atomic tasks
Implementation checklist
 - [ ] Verify n8n persistent storage.
 - [ ] Create workflow naming convention such as domain_action_v1.
 - [ ] Create webhook naming convention.
 - [ ] Define credential naming convention.
 - [ ] Create shared environment variable documentation.
 - [ ] Create an error-handling workflow.
 - [ ] Configure execution retention appropriate for local use.
 - [ ] Create a test webhook workflow.
 - [ ] Create a database connectivity test workflow.
 - [ ] Create an HTTP connectivity test workflow.
 - [ ] Export workflows into the repository.
 - [ ] Document how to import/export workflows safely.
 - [ ] Document which credentials must be recreated manually.
 - [ ] Create a workflow catalog in docs/workflows.md.
 - [ ] Add correlation IDs to important workflow inputs.
 - [ ] Run a restart test and verify workflows remain available.

Acceptance criteria
 - [ ] n8n survives restart.
 - [ ] At least one test workflow executes successfully.
 - [ ] Workflow exports are stored in version control.
 - [ ] Credential values are not stored in Git.
 - [ ] Error workflow is reachable from a test failure.

Claude completion report must include
 - [ ] STATUS: COMPLETE or BLOCKED
 - [ ] What was built
 - [ ] Files created
 - [ ] Files modified
 - [ ] Tests/commands run and results
 - [ ] Manual verification evidence
 - [ ] Known limitations
 - [ ] Security/secrets review
 - [ ] Git diff summary
 - [ ] Recommended next milestone

06. Milestone 06 - Learning normalization,
classification, deduplication
Objective: Turn raw learning notes into structured, searchable learning records.
Task count: 16 atomic tasks
Implementation checklist
 - [ ] Define allowed topic taxonomy.
 - [ ] Define learning event status flow.
 - [ ] Create normalization step.
 - [ ] Strip accidental whitespace/formatting noise while preserving meaning.
 - [ ] Extract title when absent.
 - [ ] Classify primary topic.
 - [ ] Classify secondary topics.
 - [ ] Identify whether the event is DSA, core engineering, project work, book/research, or other.
 - [ ] Extract technical entities such as Redis, PostgreSQL, JWT, WebSockets, etc.
 - [ ] Estimate whether the event is content-worthy without deciding publication automatically.
 - [ ] Compute a deterministic content hash from the normalized source.
 - [ ] Use the hash to detect duplicates.
 - [ ] Keep duplicate references rather than destroying provenance.
 - [ ] Create Content Atom shell when a new event qualifies.
 - [ ] Write fixtures for different learning-note shapes.
 - [ ] Run workflow multiple times to verify idempotency.

Acceptance criteria
 - [ ] Learning events become structured records.
 - [ ] Duplicates do not create duplicate atoms.
 - [ ] Classification is visible and editable.
 - [ ] Original data remains available.
 - [ ] n8n workflow produces deterministic status transitions.

Claude completion report must include
 - [ ] STATUS: COMPLETE or BLOCKED
 - [ ] What was built
 - [ ] Files created
 - [ ] Files modified
 - [ ] Tests/commands run and results
 - [ ] Manual verification evidence
 - [ ] Known limitations
 - [ ] Security/secrets review
 - [ ] Git diff summary
 - [ ] Recommended next milestone

07. Milestone 07 - Research and evidence
enrichment
Objective: Add reliable source evidence to technical content before generation.
Task count: 17 atomic tasks
Implementation checklist
 - [ ] Define when research is required.
 - [ ] Define source-quality hierarchy: official docs, RFCs, papers, source code, reputable engineering sources.
 - [ ] Create a source-record schema.
 - [ ] Create search query generation step.
 - [ ] Create source retrieval step using the available research/search interface.
 - [ ] Normalize URLs.
 - [ ] Deduplicate sources by canonical URL.
 - [ ] Store source title, URL, source type, retrieved timestamp, and relevant excerpt/summary.
 - [ ] Link sources to the learning event/content atom.
 - [ ] Mark claims as supported, unsupported, or needs-review where feasible.
 - [ ] Prevent a failed search from appearing as successful evidence.
 - [ ] Add timeout/error handling.
 - [ ] Add retry policy for transient research failures.
 - [ ] Create a fixture for a topic with good documentation.
 - [ ] Create a fixture for a topic where evidence is insufficient.
 - [ ] Verify no fabricated URLs are emitted.
 - [ ] Document source handling and limitations.

Acceptance criteria
 - [ ] Technical ideas can receive traceable sources.
 - [ ] Unsupported claims are visible.
 - [ ] Source URLs are deduplicated.
 - [ ] Research failure does not silently become a PASS.

Claude completion report must include
 - [ ] STATUS: COMPLETE or BLOCKED
 - [ ] What was built
 - [ ] Files created
 - [ ] Files modified
 - [ ] Tests/commands run and results
 - [ ] Manual verification evidence
 - [ ] Known limitations
 - [ ] Security/secrets review
 - [ ] Git diff summary
 - [ ] Recommended next milestone

08. Milestone 08 - Canonical Content Atom
Objective: Create the single structured object from which all content formats are derived.
Task count: 21 atomic tasks
Implementation checklist
 - [ ] Define Content Atom version 1 schema.
 - [ ] Include source learning event ID.
 - [ ] Include topic and subtopics.
 - [ ] Include problem/question.
 - [ ] Include core insight.
 - [ ] Include first-principles explanation.
 - [ ] Include example.
 - [ ] Include implementation details where available.
 - [ ] Include mistake/failure mode where available.
 - [ ] Include mental model.
 - [ ] Include personal observation.
 - [ ] Include evidence/source links.
 - [ ] Include content-angle candidates.
 - [ ] Include confidence/evidence status.
 - [ ] Preserve raw source reference.
 - [ ] Add created/updated/version fields.
 - [ ] Create transformation workflow from Learning Event to Content Atom.
 - [ ] Validate atom against schema.
 - [ ] Store failed transformations with error state.
 - [ ] Create fixture Content Atoms.
 - [ ] Document the data lifecycle.

Acceptance criteria
 - [ ] One learning event produces one canonical atom.
 - [ ] All later formats can reference the same atom.
 - [ ] Raw learning provenance is preserved.
 - [ ] Schema validation blocks malformed atoms.

Claude completion report must include
 - [ ] STATUS: COMPLETE or BLOCKED
 - [ ] What was built
 - [ ] Files created
 - [ ] Files modified
 - [ ] Tests/commands run and results
 - [ ] Manual verification evidence
 - [ ] Known limitations
 - [ ] Security/secrets review
 - [ ] Git diff summary
 - [ ] Recommended next milestone

09. Milestone 09 - Content ideation engine
Objective: Generate useful, distinct content opportunities from each Content Atom.
Task count: 17 atomic tasks
Implementation checklist
 - [ ] Define content angle taxonomy: insight, misconception, mental model, implementation lesson, failure mode,
 project story, checklist, comparison.
- [ ] Create ideation prompt version 1.
 - [ ] Generate multiple candidates per atom.
 - [ ] Require each idea to state the source atom.
 - [ ] Generate a concise angle title.
 - [ ] Generate why the idea is useful/interesting.
 - [ ] Generate suggested audience.
 - [ ] Generate recommended platform(s).
 - [ ] Generate content format.
 - [ ] Generate hook candidate.
 - [ ] Generate evidence requirement.
 - [ ] Create duplicate/near-duplicate detection.
 - [ ] Filter ideas that add no new information.
 - [ ] Store rejected ideas with reason where useful.
 - [ ] Route strongest ideas to the content queue.
 - [ ] Create test fixtures for repetitive/low-value ideas.
 - [ ] Verify the same atom can be reprocessed without unbounded duplicate growth.

Acceptance criteria
 - [ ] Distinct ideas are produced.
 - [ ] Duplicate ideas are suppressed.
 - [ ] Every idea traces back to a Content Atom.
 - [ ] Low-value outputs are filtered or flagged.

Claude completion report must include
 - [ ] STATUS: COMPLETE or BLOCKED
 - [ ] What was built
 - [ ] Files created
 - [ ] Files modified
 - [ ] Tests/commands run and results
 - [ ] Manual verification evidence
 - [ ] Known limitations
 - [ ] Security/secrets review
 - [ ] Git diff summary
 - [ ] Recommended next milestone

10. Milestone 10 - Platform-specific content
generators
Objective: Convert one approved content idea into native formats for X, LinkedIn, Reel, and Carousel.
Task count: 20 atomic tasks
Implementation checklist
 - [ ] Create brand voice rules file.
 - [ ] Create examples file with approved writing samples.
 - [ ] Create banned-phrases file.
 - [ ] Define platform constraints/configuration separately from prompts.
 - [ ] Create X short-post prompt.
 - [ ] Create X thread prompt.
 - [ ] Create LinkedIn post prompt.
 - [ ] Create Reel script prompt.
 - [ ] Create Carousel prompt.
 - [ ] Generate hook separately before body where helpful.
 - [ ] Preserve factual claims and evidence references.
 - [ ] Generate source attribution fields.
 - [ ] Store generated content as a versioned content item.
 - [ ] Store generator prompt version.
 - [ ] Store parent content idea ID.
 - [ ] Validate output schema.
 - [ ] Validate platform-specific length/structure constraints.
 - [ ] Create regeneration path.
 - [ ] Create deterministic fixture tests where possible.
 - [ ] Compare outputs from the same source to confirm they are genuinely platform-native.

Acceptance criteria
 - [ ] All target formats can be generated.
 - [ ] Outputs have provenance and prompt version.
 - [ ] Formats are not copy/paste variants of one another.
 - [ ] Malformed outputs fail validation.

Claude completion report must include
 - [ ] STATUS: COMPLETE or BLOCKED
 - [ ] What was built
 - [ ] Files created
 - [ ] Files modified
 - [ ] Tests/commands run and results
 - [ ] Manual verification evidence
 - [ ] Known limitations
 - [ ] Security/secrets review
 - [ ] Git diff summary
 - [ ] Recommended next milestone

11. Milestone 11 - Automated content quality
gate
Objective: Keep weak, generic, or unsupported content out of the approval queue.
Task count: 17 atomic tasks
Implementation checklist
 - [ ] Define quality dimensions.
 - [ ] Check factual-claim support.
 - [ ] Check evidence presence when required.
 - [ ] Check source traceability.
 - [ ] Check generic AI language.
 - [ ] Check excessive hype/clickbait.
 - [ ] Check repetition against existing content.
 - [ ] Check platform constraints.
 - [ ] Check whether the draft actually teaches something.
 - [ ] Check specificity and examples.
 - [ ] Check whether personal claims are presented as personal experience.
 - [ ] Return PASS, NEEDS_REVIEW, or REJECT.
 - [ ] Return machine-readable reasons.
 - [ ] Do not silently alter factual claims during the gate.
 - [ ] Add quality-gate fixtures: high quality, hallucinated, duplicate, generic, overlong, unsupported.
 - [ ] Make gating idempotent.
 - [ ] Store gate version and timestamp.

Acceptance criteria
 - [ ] Known bad fixtures are correctly flagged.
 - [ ] Known good fixtures can pass.
 - [ ] Reasons are visible to the approval layer.
 - [ ] Quality-gate version is stored.

Claude completion report must include
 - [ ] STATUS: COMPLETE or BLOCKED
 - [ ] What was built
 - [ ] Files created
 - [ ] Files modified
 - [ ] Tests/commands run and results
 - [ ] Manual verification evidence
 - [ ] Known limitations
 - [ ] Security/secrets review
 - [ ] Git diff summary
 - [ ] Recommended next milestone

12. Milestone 12 - Human approval with
Telegram
Objective: Create a mobile approval loop before anything reaches publishing.
Task count: 18 atomic tasks
Implementation checklist
 - [ ] Create Telegram bot/token setup documentation.
 - [ ] Implement inbound command parsing.
 - [ ] Define approval actions: approve, reject, regenerate, edit/request-change, schedule-review.
 - [ ] Create content preview message.
 - [ ] Include platform and source references in preview.
 - [ ] Include quality-gate result.
 - [ ] Include content ID.
 - [ ] Generate stable action IDs.
 - [ ] Protect actions against duplicate callback delivery.
 - [ ] Store every approval decision.
 - [ ] Link decision to content version.
 - [ ] Implement regenerate action.
 - [ ] Regeneration must create a new version, not overwrite history.
 - [ ] Reject action must block publishing.
 - [ ] Approve action must move content to publishable state.
 - [ ] Handle expired/unknown action IDs safely.
 - [ ] Create test bot/sandbox mode.
 - [ ] Run approve/reject/regenerate end-to-end tests.

Acceptance criteria
 - [ ] Only approved content can enter publishable state.
 - [ ] Every decision is stored.
 - [ ] Duplicate Telegram actions do not cause duplicate transitions.
 - [ ] Regeneration preserves history.

Claude completion report must include
 - [ ] STATUS: COMPLETE or BLOCKED
 - [ ] What was built
 - [ ] Files created
 - [ ] Files modified
 - [ ] Tests/commands run and results
 - [ ] Manual verification evidence
 - [ ] Known limitations
 - [ ] Security/secrets review
 - [ ] Git diff summary
 - [ ] Recommended next milestone

13. Milestone 13 - Publishing and scheduling
adapter
Objective: Schedule approved content through a publishing layer without coupling the entire system to it.
Task count: 19 atomic tasks
Implementation checklist
 - [ ] Define publishing adapter interface.
 - [ ] Define post payload contract.
 - [ ] Define schedule request contract.
 - [ ] Configure Postiz sandbox/test setup where available.
 - [ ] Implement authentication using environment variables.
 - [ ] Implement create/schedule operation.
 - [ ] Capture external publication ID.
 - [ ] Capture target platform and scheduled timestamp.
 - [ ] Create deterministic idempotency key.
 - [ ] Before publishing, verify content status is APPROVED.
 - [ ] Prevent duplicate submissions.
 - [ ] Handle provider timeouts.
 - [ ] Handle provider rate limits.
 - [ ] Handle partial failures.
 - [ ] Store provider response metadata without storing secrets.
 - [ ] Create cancellation/unschedule operation where supported.
 - [ ] Create test content and schedule it.
 - [ ] Verify re-running the same workflow does not create a duplicate.
 - [ ] Document provider-specific limitations.

Acceptance criteria
 - [ ] Approved test content can be scheduled.
 - [ ] Unapproved content is blocked.
 - [ ] Repeated execution is idempotent.
 - [ ] External ID is stored.
 - [ ] Provider errors produce recoverable workflow states.

Claude completion report must include
 - [ ] STATUS: COMPLETE or BLOCKED
 - [ ] What was built
 - [ ] Files created
 - [ ] Files modified
 - [ ] Tests/commands run and results
 - [ ] Manual verification evidence
 - [ ] Known limitations
 - [ ] Security/secrets review
 - [ ] Git diff summary
 - [ ] Recommended next milestone

14. Milestone 14 - GitHub -> content
opportunities
Objective: Turn meaningful engineering progress into content opportunities automatically.
Task count: 15 atomic tasks
Implementation checklist
 - [ ] Define which GitHub events matter: PR, release, merge, labeled milestone, or manually marked change.
 - [ ] Create webhook/event ingestion.
 - [ ] Verify signature/authenticity where supported.
 - [ ] Capture repository, ref, commit/PR/release ID, title, URL, timestamp.
 - [ ] Filter out trivial changes such as formatting-only commits if appropriate.
 - [ ] Extract changed-file summary.
 - [ ] Extract problem/goal from PR description where present.
 - [ ] Extract engineering decision/lesson candidates.
 - [ ] Generate content opportunity only for meaningful changes.
 - [ ] Link opportunity to GitHub URL.
 - [ ] Store source event ID.
 - [ ] Deduplicate repeated webhook delivery.
 - [ ] Create manual override to force a content opportunity.
 - [ ] Create tests for meaningful and trivial changes.
 - [ ] Run a test PR/release event.

Acceptance criteria
 - [ ] Meaningful engineering events produce opportunities.
 - [ ] Duplicate webhook deliveries do not duplicate opportunities.
 - [ ] Every opportunity links back to GitHub.
 - [ ] Trivial changes are filtered or explicitly ignored.

Claude completion report must include
 - [ ] STATUS: COMPLETE or BLOCKED
 - [ ] What was built
 - [ ] Files created
 - [ ] Files modified
 - [ ] Tests/commands run and results
 - [ ] Manual verification evidence
 - [ ] Known limitations
 - [ ] Security/secrets review
 - [ ] Git diff summary
 - [ ] Recommended next milestone

15. Milestone 15 - Analytics collection and
normalization
Objective: Connect published content to performance data.
Task count: 16 atomic tasks
Implementation checklist
 - [ ] Define normalized analytics schema.
 - [ ] Define immutable publication record.
 - [ ] Store platform, post ID, topic, format, hook, published timestamp.
 - [ ] Identify available platform metrics.
 - [ ] Build provider-specific metric adapters.
 - [ ] Normalize common fields such as impressions/reach, reactions, comments, shares, saves/bookmarks, profile
 actions, clicks where available.
- [ ] Store raw provider payload separately if needed.
 - [ ] Record retrieval timestamp.
 - [ ] Handle missing metrics without zeroing unknown values incorrectly.
 - [ ] Create scheduled analytics collection workflow.
 - [ ] Implement retry/backoff.
 - [ ] Prevent duplicate analytics records for the same retrieval.
 - [ ] Calculate derived metrics only when denominators exist.
 - [ ] Link analytics back to content item and source atom.
 - [ ] Create test fixtures.
 - [ ] Verify analytics collection survives provider failure.

Acceptance criteria
 - [ ] Published content can receive analytics records.
 - [ ] Unknown metrics remain unknown, not falsely zero.
 - [ ] Provider-specific data is traceable.
 - [ ] Repeated collection is safe.

Claude completion report must include
 - [ ] STATUS: COMPLETE or BLOCKED
 - [ ] What was built
 - [ ] Files created
 - [ ] Files modified
 - [ ] Tests/commands run and results
 - [ ] Manual verification evidence
 - [ ] Known limitations
 - [ ] Security/secrets review
 - [ ] Git diff summary
 - [ ] Recommended next milestone

16. Milestone 16 - Weekly content intelligence
Objective: Turn accumulated learning, publishing, and analytics data into useful weekly decisions.
Task count: 19 atomic tasks
Implementation checklist
 - [ ] Define weekly reporting window and timezone.
 - [ ] Calculate learning events.
 - [ ] Calculate content ideas created.
 - [ ] Calculate drafts generated.
 - [ ] Calculate approved/published items.
 - [ ] Calculate time from learning capture to publish when timestamps exist.
 - [ ] Group performance by topic.
 - [ ] Group performance by format.
 - [ ] Group performance by platform.
 - [ ] Group performance by hook class where structured.
 - [ ] Identify strongest and weakest signals without overclaiming causality.
 - [ ] Surface publishing failures.
 - [ ] Surface approval backlog.
 - [ ] Generate 3-5 content opportunities for the next week.
 - [ ] Generate 3-5 learning-topic suggestions from content gaps and demonstrated interest.
 - [ ] Store weekly report.
 - [ ] Send report through Telegram or another channel.
 - [ ] Create seeded test data for a fake week.
 - [ ] Verify report totals against underlying data.

Acceptance criteria
 - [ ] Weekly report is reproducible.
 - [ ] Numbers reconcile with source records.
 - [ ] Recommendations remain suggestions, not automatic publishing decisions.
 - [ ] Historical reports remain accessible.

Claude completion report must include
 - [ ] STATUS: COMPLETE or BLOCKED
 - [ ] What was built
 - [ ] Files created
 - [ ] Files modified
 - [ ] Tests/commands run and results
 - [ ] Manual verification evidence
 - [ ] Known limitations
 - [ ] Security/secrets review
 - [ ] Git diff summary
 - [ ] Recommended next milestone

17. Milestone 17 - Reliability, security,
observability
Objective: Make the system safe to run repeatedly and diagnose when something breaks.
Task count: 24 atomic tasks
Implementation checklist
 - [ ] Audit every secret and credential path.
 - [ ] Confirm secrets are absent from Git history and logs where possible.
 - [ ] Add input validation at every external boundary.
 - [ ] Add timeouts to external HTTP calls.
 - [ ] Add retry policy with backoff for transient failures.
 - [ ] Define permanent vs retryable failure states.
 - [ ] Add dead-letter/error state for failed content/publishing operations.
 - [ ] Add correlation IDs across workflows.
 - [ ] Add structured logs for key transitions.
 - [ ] Add execution/run records for critical workflows.
 - [ ] Add service health checks.
 - [ ] Add system health workflow.
 - [ ] Add failure notification path.
 - [ ] Define database backup procedure.
 - [ ] Define restore test procedure.
 - [ ] Test service restart.
 - [ ] Test database restart.
 - [ ] Test Redis restart.
 - [ ] Test provider outage.
 - [ ] Test malformed input.
 - [ ] Test duplicate webhook.
 - [ ] Test duplicate approval.
 - [ ] Test duplicate publish request.
 - [ ] Document incident/recovery procedures.

Acceptance criteria
 - [ ] Failures are visible and diagnosable.
 - [ ] Retries do not create duplicates.
 - [ ] Secrets are handled safely.
 - [ ] State survives service restarts.
 - [ ] Recovery procedure is documented and tested.

Claude completion report must include
 - [ ] STATUS: COMPLETE or BLOCKED
 - [ ] What was built
 - [ ] Files created
 - [ ] Files modified
 - [ ] Tests/commands run and results
 - [ ] Manual verification evidence
 - [ ] Known limitations
 - [ ] Security/secrets review
 - [ ] Git diff summary
 - [ ] Recommended next milestone

18. Milestone 18 - End-to-end launch and final
audit
Objective: Prove the complete system with realistic test data and leave the repository usable by another
engineer.
Task count: 38 atomic tasks
Implementation checklist
 - [ ] Create a representative learning event.
 - [ ] Run learning normalization.
 - [ ] Run classification.
 - [ ] Run deduplication.
 - [ ] Create Content Atom.
 - [ ] Run research enrichment.
 - [ ] Generate content ideas.
 - [ ] Generate X short post.
 - [ ] Generate X thread.
 - [ ] Generate LinkedIn post.
 - [ ] Generate Reel script.
 - [ ] Generate Carousel.
 - [ ] Run quality gate.
 - [ ] Send to Telegram approval.
 - [ ] Approve one version.
 - [ ] Reject one version.
 - [ ] Regenerate one version.
 - [ ] Schedule approved test content.
 - [ ] Verify publication record.
 - [ ] Run analytics collection using test/mock data where real metrics are unavailable.
 - [ ] Generate weekly intelligence.
 - [ ] Verify all records link back to the original learning event.
 - [ ] Run duplicate execution of the complete path.
 - [ ] Verify duplicate execution does not publish duplicates.
 - [ ] Run failure injection for at least one dependency.
 - [ ] Verify recovery.
 - [ ] Run full tests.
 - [ ] Run lint/type checks where applicable.
 - [ ] Review Git diff.
 - [ ] Remove debug code and temporary data.
 - [ ] Update README.
 - [ ] Update architecture docs.
 - [ ] Update setup guide.
 - [ ] Update workflow catalog.
 - [ ] Update troubleshooting guide.
 - [ ] Create demo script.
 - [ ] Create final launch checklist.
 - [ ] Tag/version the first stable release.

Acceptance criteria
 - [ ] Complete learning-to-analytics path is demonstrable.
 - [ ] Duplicate path is safe.

- [ ] Failure path is demonstrable.
 - [ ] Documentation is sufficient for a clean setup.
 - [ ] Repository contains no accidental secrets or debug artifacts.
 - [ ] Final audit report is PASS.

Claude completion report must include
 - [ ] STATUS: COMPLETE or BLOCKED
 - [ ] What was built
 - [ ] Files created
 - [ ] Files modified
 - [ ] Tests/commands run and results
 - [ ] Manual verification evidence
 - [ ] Known limitations
 - [ ] Security/secrets review
 - [ ] Git diff summary
 - [ ] Recommended next milestone

20. Master Claude Controller Prompt
Paste this once at the beginning of the Claude coding session. Then use the milestone prompts from the next
section.
 You are the lead staff engineer building the Superhuman Content Engine in this repository.
MISSION
Complete the project described in the build plan. The system converts real learning and engineering work into structured
knowledge, research-backed content opportunities, platform-native drafts, human-approved scheduled posts, analytics, and
weekly intelligence.
EXECUTION CONTRACT
- Work on exactly one milestone at a time.
- Inspect the repository before modifying it.
- Preserve existing useful work.
- Do not jump ahead.
- Do not invent APIs, credentials, or unsupported integrations.
- Never commit secrets.
- Never publish real social content during development unless explicitly instructed.
- Prefer small, testable changes.
- Every external boundary needs validation, timeout, error handling, and clear failure states.
- Every workflow that can be retried must be idempotent.
- Preserve provenance from learning event -> source -> content atom -> idea -> draft -> publication -> analytics.
DEFINITION OF DONE
A milestone is complete only when:
1. All atomic tasks for the milestone are addressed.
2. Acceptance criteria pass.
3. Tests or executable verification have been run.
4. Failures have been investigated and either fixed or explicitly reported as blockers.
5. Documentation is updated.
6. Git diff has been reviewed.
7. No secrets are exposed.
8. The repository remains runnable.
AFTER IMPLEMENTATION
Perform a senior-engineer self-review. Inspect your own diff. Look for:
- incorrect assumptions
- missing validation
- duplicate execution
- race conditions
- security issues
- brittle API handling
- missing migrations
- silent error swallowing
- missing observability
- incomplete documentation
- unnecessary complexity
Then fix everything that belongs to the current milestone.
FINAL RESPONSE FORMAT
STATUS:
OBJECTIVE:
WHAT I BUILT:
TASKS COMPLETED:
FILES CREATED:
FILES MODIFIED:
TESTS RUN:
TEST RESULTS:
MANUAL VERIFICATION:
SECURITY REVIEW:
KNOWN LIMITATIONS:
GIT DIFF SUMMARY:
ACCEPTANCE CRITERIA:
RECOMMENDED NEXT MILESTONE:
If blocked, stop and report the exact blocker and evidence. Do not silently skip work.

21. The Review Loop Prompt
Run this after each milestone before delegating the next one.
 REVIEW THE LAST MILESTONE.
Act as a senior staff engineer reviewing the actual repository state, not your previous explanation.
1. Re-read the milestone objective and atomic tasks.
2. Inspect the current diff.
3. Run relevant tests again.
4. Inspect failure paths.
5. Check idempotency and duplicate execution.
6. Check secrets and logging.
7. Check database integrity and migrations if touched.
8. Check external API handling if touched.
9. Check documentation.
10. Verify every acceptance criterion explicitly.
Return:
- PASS or FAIL
- each acceptance criterion with evidence
- issues found
- fixes made
- tests after fixes
- remaining risks
- whether the repository is ready for the next milestone
Do not implement the next milestone.
22. Exact Milestone Delegation Prompts
Use one prompt at a time. Each prompt deliberately tells Claude to stop after that milestone.
Milestone 01 prompt
 START MILESTONE 01: Repository reconnaissance and technical design
OBJECTIVE
Know exactly what exists, what must be built, and what will be preserved.
BEFORE IMPLEMENTING
- Inspect the current repository and identify what is already complete.
- Read relevant docs and existing tests.
- Do not assume the target architecture is already correct.
- Preserve useful existing code.
ATOMIC TASKS
1. List the repository root and every relevant source/config/test file.
2. Identify the language, package manager, runtime versions, build system, and current scripts.
3. Inspect existing Docker, Compose, environment, CI/CD, database, and deployment files.
4. Inspect Git history for architectural intent and recent changes.
5. Search for existing Notion, Telegram, social, AI, database, queue, or automation integrations.
6. Search for TODO/FIXME markers and unfinished features.
7. Identify any existing content schema, prompt files, or content pipeline code.
8. Document external dependencies and which ones require credentials.
9. Identify what can be reused instead of recreated.
10. Create docs/reconnaissance.md containing current-state architecture.
11. Create docs/architecture.md with target-state architecture.
12. Create an explicit list of files that Claude expects to create or modify in later milestones.
13. Create a risk register with at least dependency, credential, rate-limit, duplication, and failure-mode risks.
14. Define local-development assumptions and sandbox/test-account policy.
15. Do not modify application behavior during this milestone.
ACCEPTANCE CRITERIA
- Repository inventory is documented.
- Current architecture and target architecture are documented.
- External dependencies and credential requirements are documented.
- No application feature was changed unnecessarily.

- Claude can explain the next milestone without guessing.
CONSTRAINTS
- Work only on this milestone.
- Do not implement future milestones.
- Keep changes small and testable.
- Use sandbox/test credentials only.
- Do not publish real social content.
- Keep secrets out of source control.
- Add/update tests.
- Update documentation.
- Make retryable operations idempotent.
FINISH
Run the senior-engineer self-review.
Run all relevant tests.
Review the Git diff.
Fix issues belonging to this milestone.
Return the required completion report.
Stop after this milestone.
Milestone 02 prompt
 START MILESTONE 02: Docker and local infrastructure
OBJECTIVE
Create a reproducible local runtime for the automation stack.
BEFORE IMPLEMENTING
- Inspect the current repository and identify what is already complete.
- Read relevant docs and existing tests.
- Do not assume the target architecture is already correct.
- Preserve useful existing code.
ATOMIC TASKS
1. Choose supported container images/versions for PostgreSQL, Redis, n8n, and Ollama.
2. Create infra/docker-compose.yml.
3. Create named persistent volumes for stateful services.
4. Create an isolated Docker network.
5. Add service health checks where supported.
6. Expose only the ports required for local development.
7. Create .env.example with placeholders for all required settings.
8. Create infra/scripts/start.sh or equivalent startup script.
9. Create infra/scripts/stop.sh.
10. Create infra/scripts/reset.sh with an explicit warning about data destruction.
11. Configure timezone consistently.
12. Configure PostgreSQL initialization settings.
13. Configure n8n persistence.
14. Configure Ollama persistence/model storage.
15. Document first-run commands.
16. Start the complete stack from a clean state.
17. Verify service health individually.
18. Verify restart persistence.
19. Do not add cloud deployment yet.
ACCEPTANCE CRITERIA
- All core services start from documented commands.
- Data survives a normal restart.
- Reset behavior is explicit and safe.
- No real credentials are committed.
- Health checks and ports are documented.
CONSTRAINTS
- Work only on this milestone.
- Do not implement future milestones.
- Keep changes small and testable.
- Use sandbox/test credentials only.
- Do not publish real social content.
- Keep secrets out of source control.
- Add/update tests.

- Update documentation.
- Make retryable operations idempotent.
FINISH
Run the senior-engineer self-review.
Run all relevant tests.
Review the Git diff.
Fix issues belonging to this milestone.
Return the required completion report.
Stop after this milestone.
Milestone 03 prompt
 START MILESTONE 03: Database and shared schemas
OBJECTIVE
Create durable internal state and stable contracts between workflows.
BEFORE IMPLEMENTING
- Inspect the current repository and identify what is already complete.
- Read relevant docs and existing tests.
- Do not assume the target architecture is already correct.
- Preserve useful existing code.
ATOMIC TASKS
1. Choose the database access approach already consistent with the repository.
2. Create migration strategy.
3. Define learning_events table/model.
4. Define content_atoms table/model.
5. Define content_items table/model.
6. Define sources/source_documents table/model.
7. Define approvals table/model.
8. Define publications table/model.
9. Define analytics_events table/model.
10. Define workflow_runs/error_events table/model where useful.
11. Add created_at and updated_at timestamps.
12. Add stable primary keys.
13. Add status fields/enums where workflow state matters.
14. Add unique constraints for external IDs and idempotency keys.
15. Add indexes for status, scheduled time, source ID, topic, and publication lookup paths.
16. Create seed/example records.
17. Define JSON schemas or typed interfaces for key workflow payloads.
18. Write tests for schema validation and database constraints.
19. Run migrations against an empty database.
20. Run migrations against the already-running development database.
21. Verify duplicate keys are rejected as designed.
ACCEPTANCE CRITERIA
- Migrations are reproducible.
- Core tables exist.
- Constraints prevent obvious duplication.
- Seed/test data can be created and removed safely.
- Shared payload schemas are versioned or clearly defined.
CONSTRAINTS
- Work only on this milestone.
- Do not implement future milestones.
- Keep changes small and testable.
- Use sandbox/test credentials only.
- Do not publish real social content.
- Keep secrets out of source control.
- Add/update tests.
- Update documentation.
- Make retryable operations idempotent.
FINISH
Run the senior-engineer self-review.
Run all relevant tests.
Review the Git diff.
Fix issues belonging to this milestone.

Return the required completion report.
Stop after this milestone.
Milestone 04 prompt
 START MILESTONE 04: Learning Inbox and capture API
OBJECTIVE
Capture daily learning with minimum friction.
BEFORE IMPLEMENTING
- Inspect the current repository and identify what is already complete.
- Read relevant docs and existing tests.
- Do not assume the target architecture is already correct.
- Preserve useful existing code.
ATOMIC TASKS
1. Define the minimal learning-event input contract.
2. Implement a POST/webhook intake or an existing Notion integration.
3. Implement optional Telegram intake command.
4. Validate required fields.
5. Trim/normalize input.
6. Generate a unique learning event ID.
7. Store original raw input unchanged.
8. Store capture source and timestamp.
9. Return a human-readable confirmation.
10. Implement GET/retrieval for a learning event.
11. Implement update/status support if needed.
12. Reject malformed requests with useful error messages.
13. Add authentication for non-local endpoints where applicable.
14. Add request correlation ID.
15. Add automated tests for valid and invalid payloads.
16. Perform an end-to-end capture smoke test.
ACCEPTANCE CRITERIA
- A short note creates exactly one learning event.
- Original text is preserved.
- Malformed inputs fail safely.
- Repeated requests can be detected or deduplicated.
- Retrieval returns the stored event and metadata.
CONSTRAINTS
- Work only on this milestone.
- Do not implement future milestones.
- Keep changes small and testable.
- Use sandbox/test credentials only.
- Do not publish real social content.
- Keep secrets out of source control.
- Add/update tests.
- Update documentation.
- Make retryable operations idempotent.
FINISH
Run the senior-engineer self-review.
Run all relevant tests.
Review the Git diff.
Fix issues belonging to this milestone.
Return the required completion report.
Stop after this milestone.
Milestone 05 prompt
 START MILESTONE 05: n8n orchestration foundation
OBJECTIVE
Make n8n a version-controlled and observable orchestration layer.
BEFORE IMPLEMENTING
- Inspect the current repository and identify what is already complete.
- Read relevant docs and existing tests.

- Do not assume the target architecture is already correct.
- Preserve useful existing code.
ATOMIC TASKS
1. Verify n8n persistent storage.
2. Create workflow naming convention such as domain_action_v1.
3. Create webhook naming convention.
4. Define credential naming convention.
5. Create shared environment variable documentation.
6. Create an error-handling workflow.
7. Configure execution retention appropriate for local use.
8. Create a test webhook workflow.
9. Create a database connectivity test workflow.
10. Create an HTTP connectivity test workflow.
11. Export workflows into the repository.
12. Document how to import/export workflows safely.
13. Document which credentials must be recreated manually.
14. Create a workflow catalog in docs/workflows.md.
15. Add correlation IDs to important workflow inputs.
16. Run a restart test and verify workflows remain available.
ACCEPTANCE CRITERIA
- n8n survives restart.
- At least one test workflow executes successfully.
- Workflow exports are stored in version control.
- Credential values are not stored in Git.
- Error workflow is reachable from a test failure.
CONSTRAINTS
- Work only on this milestone.
- Do not implement future milestones.
- Keep changes small and testable.
- Use sandbox/test credentials only.
- Do not publish real social content.
- Keep secrets out of source control.
- Add/update tests.
- Update documentation.
- Make retryable operations idempotent.
FINISH
Run the senior-engineer self-review.
Run all relevant tests.
Review the Git diff.
Fix issues belonging to this milestone.
Return the required completion report.
Stop after this milestone.
Milestone 06 prompt
 START MILESTONE 06: Learning normalization, classification, deduplication
OBJECTIVE
Turn raw learning notes into structured, searchable learning records.
BEFORE IMPLEMENTING
- Inspect the current repository and identify what is already complete.
- Read relevant docs and existing tests.
- Do not assume the target architecture is already correct.
- Preserve useful existing code.
ATOMIC TASKS
1. Define allowed topic taxonomy.
2. Define learning event status flow.
3. Create normalization step.
4. Strip accidental whitespace/formatting noise while preserving meaning.
5. Extract title when absent.
6. Classify primary topic.
7. Classify secondary topics.
8. Identify whether the event is DSA, core engineering, project work, book/research, or other.
9. Extract technical entities such as Redis, PostgreSQL, JWT, WebSockets, etc.

10. Estimate whether the event is content-worthy without deciding publication automatically.
11. Compute a deterministic content hash from the normalized source.
12. Use the hash to detect duplicates.
13. Keep duplicate references rather than destroying provenance.
14. Create Content Atom shell when a new event qualifies.
15. Write fixtures for different learning-note shapes.
16. Run workflow multiple times to verify idempotency.
ACCEPTANCE CRITERIA
- Learning events become structured records.
- Duplicates do not create duplicate atoms.
- Classification is visible and editable.
- Original data remains available.
- n8n workflow produces deterministic status transitions.
CONSTRAINTS
- Work only on this milestone.
- Do not implement future milestones.
- Keep changes small and testable.
- Use sandbox/test credentials only.
- Do not publish real social content.
- Keep secrets out of source control.
- Add/update tests.
- Update documentation.
- Make retryable operations idempotent.
FINISH
Run the senior-engineer self-review.
Run all relevant tests.
Review the Git diff.
Fix issues belonging to this milestone.
Return the required completion report.
Stop after this milestone.
Milestone 07 prompt
 START MILESTONE 07: Research and evidence enrichment
OBJECTIVE
Add reliable source evidence to technical content before generation.
BEFORE IMPLEMENTING
- Inspect the current repository and identify what is already complete.
- Read relevant docs and existing tests.
- Do not assume the target architecture is already correct.
- Preserve useful existing code.
ATOMIC TASKS
1. Define when research is required.
2. Define source-quality hierarchy: official docs, RFCs, papers, source code, reputable engineering sources.
3. Create a source-record schema.
4. Create search query generation step.
5. Create source retrieval step using the available research/search interface.
6. Normalize URLs.
7. Deduplicate sources by canonical URL.
8. Store source title, URL, source type, retrieved timestamp, and relevant excerpt/summary.
9. Link sources to the learning event/content atom.
10. Mark claims as supported, unsupported, or needs-review where feasible.
11. Prevent a failed search from appearing as successful evidence.
12. Add timeout/error handling.
13. Add retry policy for transient research failures.
14. Create a fixture for a topic with good documentation.
15. Create a fixture for a topic where evidence is insufficient.
16. Verify no fabricated URLs are emitted.
17. Document source handling and limitations.
ACCEPTANCE CRITERIA
- Technical ideas can receive traceable sources.
- Unsupported claims are visible.
- Source URLs are deduplicated.

- Research failure does not silently become a PASS.
CONSTRAINTS
- Work only on this milestone.
- Do not implement future milestones.
- Keep changes small and testable.
- Use sandbox/test credentials only.
- Do not publish real social content.
- Keep secrets out of source control.
- Add/update tests.
- Update documentation.
- Make retryable operations idempotent.
FINISH
Run the senior-engineer self-review.
Run all relevant tests.
Review the Git diff.
Fix issues belonging to this milestone.
Return the required completion report.
Stop after this milestone.
Milestone 08 prompt
 START MILESTONE 08: Canonical Content Atom
OBJECTIVE
Create the single structured object from which all content formats are derived.
BEFORE IMPLEMENTING
- Inspect the current repository and identify what is already complete.
- Read relevant docs and existing tests.
- Do not assume the target architecture is already correct.
- Preserve useful existing code.
ATOMIC TASKS
1. Define Content Atom version 1 schema.
2. Include source learning event ID.
3. Include topic and subtopics.
4. Include problem/question.
5. Include core insight.
6. Include first-principles explanation.
7. Include example.
8. Include implementation details where available.
9. Include mistake/failure mode where available.
10. Include mental model.
11. Include personal observation.
12. Include evidence/source links.
13. Include content-angle candidates.
14. Include confidence/evidence status.
15. Preserve raw source reference.
16. Add created/updated/version fields.
17. Create transformation workflow from Learning Event to Content Atom.
18. Validate atom against schema.
19. Store failed transformations with error state.
20. Create fixture Content Atoms.
21. Document the data lifecycle.
ACCEPTANCE CRITERIA
- One learning event produces one canonical atom.
- All later formats can reference the same atom.
- Raw learning provenance is preserved.
- Schema validation blocks malformed atoms.
CONSTRAINTS
- Work only on this milestone.
- Do not implement future milestones.
- Keep changes small and testable.
- Use sandbox/test credentials only.
- Do not publish real social content.
- Keep secrets out of source control.

- Add/update tests.
- Update documentation.
- Make retryable operations idempotent.
FINISH
Run the senior-engineer self-review.
Run all relevant tests.
Review the Git diff.
Fix issues belonging to this milestone.
Return the required completion report.
Stop after this milestone.
Milestone 09 prompt
 START MILESTONE 09: Content ideation engine
OBJECTIVE
Generate useful, distinct content opportunities from each Content Atom.
BEFORE IMPLEMENTING
- Inspect the current repository and identify what is already complete.
- Read relevant docs and existing tests.
- Do not assume the target architecture is already correct.
- Preserve useful existing code.
ATOMIC TASKS
1. Define content angle taxonomy: insight, misconception, mental model, implementation lesson, failure mode, project story,
checklist, comparison.
2. Create ideation prompt version 1.
3. Generate multiple candidates per atom.
4. Require each idea to state the source atom.
5. Generate a concise angle title.
6. Generate why the idea is useful/interesting.
7. Generate suggested audience.
8. Generate recommended platform(s).
9. Generate content format.
10. Generate hook candidate.
11. Generate evidence requirement.
12. Create duplicate/near-duplicate detection.
13. Filter ideas that add no new information.
14. Store rejected ideas with reason where useful.
15. Route strongest ideas to the content queue.
16. Create test fixtures for repetitive/low-value ideas.
17. Verify the same atom can be reprocessed without unbounded duplicate growth.
ACCEPTANCE CRITERIA
- Distinct ideas are produced.
- Duplicate ideas are suppressed.
- Every idea traces back to a Content Atom.
- Low-value outputs are filtered or flagged.
CONSTRAINTS
- Work only on this milestone.
- Do not implement future milestones.
- Keep changes small and testable.
- Use sandbox/test credentials only.
- Do not publish real social content.
- Keep secrets out of source control.
- Add/update tests.
- Update documentation.
- Make retryable operations idempotent.
FINISH
Run the senior-engineer self-review.
Run all relevant tests.
Review the Git diff.
Fix issues belonging to this milestone.
Return the required completion report.
Stop after this milestone.

Milestone 10 prompt
 START MILESTONE 10: Platform-specific content generators
OBJECTIVE
Convert one approved content idea into native formats for X, LinkedIn, Reel, and Carousel.
BEFORE IMPLEMENTING
- Inspect the current repository and identify what is already complete.
- Read relevant docs and existing tests.
- Do not assume the target architecture is already correct.
- Preserve useful existing code.
ATOMIC TASKS
1. Create brand voice rules file.
2. Create examples file with approved writing samples.
3. Create banned-phrases file.
4. Define platform constraints/configuration separately from prompts.
5. Create X short-post prompt.
6. Create X thread prompt.
7. Create LinkedIn post prompt.
8. Create Reel script prompt.
9. Create Carousel prompt.
10. Generate hook separately before body where helpful.
11. Preserve factual claims and evidence references.
12. Generate source attribution fields.
13. Store generated content as a versioned content item.
14. Store generator prompt version.
15. Store parent content idea ID.
16. Validate output schema.
17. Validate platform-specific length/structure constraints.
18. Create regeneration path.
19. Create deterministic fixture tests where possible.
20. Compare outputs from the same source to confirm they are genuinely platform-native.
ACCEPTANCE CRITERIA
- All target formats can be generated.
- Outputs have provenance and prompt version.
- Formats are not copy/paste variants of one another.
- Malformed outputs fail validation.
CONSTRAINTS
- Work only on this milestone.
- Do not implement future milestones.
- Keep changes small and testable.
- Use sandbox/test credentials only.
- Do not publish real social content.
- Keep secrets out of source control.
- Add/update tests.
- Update documentation.
- Make retryable operations idempotent.
FINISH
Run the senior-engineer self-review.
Run all relevant tests.
Review the Git diff.
Fix issues belonging to this milestone.
Return the required completion report.
Stop after this milestone.
Milestone 11 prompt
 START MILESTONE 11: Automated content quality gate
OBJECTIVE
Keep weak, generic, or unsupported content out of the approval queue.
BEFORE IMPLEMENTING
- Inspect the current repository and identify what is already complete.
- Read relevant docs and existing tests.
- Do not assume the target architecture is already correct.

- Preserve useful existing code.
ATOMIC TASKS
1. Define quality dimensions.
2. Check factual-claim support.
3. Check evidence presence when required.
4. Check source traceability.
5. Check generic AI language.
6. Check excessive hype/clickbait.
7. Check repetition against existing content.
8. Check platform constraints.
9. Check whether the draft actually teaches something.
10. Check specificity and examples.
11. Check whether personal claims are presented as personal experience.
12. Return PASS, NEEDS_REVIEW, or REJECT.
13. Return machine-readable reasons.
14. Do not silently alter factual claims during the gate.
15. Add quality-gate fixtures: high quality, hallucinated, duplicate, generic, overlong, unsupported.
16. Make gating idempotent.
17. Store gate version and timestamp.
ACCEPTANCE CRITERIA
- Known bad fixtures are correctly flagged.
- Known good fixtures can pass.
- Reasons are visible to the approval layer.
- Quality-gate version is stored.
CONSTRAINTS
- Work only on this milestone.
- Do not implement future milestones.
- Keep changes small and testable.
- Use sandbox/test credentials only.
- Do not publish real social content.
- Keep secrets out of source control.
- Add/update tests.
- Update documentation.
- Make retryable operations idempotent.
FINISH
Run the senior-engineer self-review.
Run all relevant tests.
Review the Git diff.
Fix issues belonging to this milestone.
Return the required completion report.
Stop after this milestone.
Milestone 12 prompt
 START MILESTONE 12: Human approval with Telegram
OBJECTIVE
Create a mobile approval loop before anything reaches publishing.
BEFORE IMPLEMENTING
- Inspect the current repository and identify what is already complete.
- Read relevant docs and existing tests.
- Do not assume the target architecture is already correct.
- Preserve useful existing code.
ATOMIC TASKS
1. Create Telegram bot/token setup documentation.
2. Implement inbound command parsing.
3. Define approval actions: approve, reject, regenerate, edit/request-change, schedule-review.
4. Create content preview message.
5. Include platform and source references in preview.
6. Include quality-gate result.
7. Include content ID.
8. Generate stable action IDs.
9. Protect actions against duplicate callback delivery.
10. Store every approval decision.

11. Link decision to content version.
12. Implement regenerate action.
13. Regeneration must create a new version, not overwrite history.
14. Reject action must block publishing.
15. Approve action must move content to publishable state.
16. Handle expired/unknown action IDs safely.
17. Create test bot/sandbox mode.
18. Run approve/reject/regenerate end-to-end tests.
ACCEPTANCE CRITERIA
- Only approved content can enter publishable state.
- Every decision is stored.
- Duplicate Telegram actions do not cause duplicate transitions.
- Regeneration preserves history.
CONSTRAINTS
- Work only on this milestone.
- Do not implement future milestones.
- Keep changes small and testable.
- Use sandbox/test credentials only.
- Do not publish real social content.
- Keep secrets out of source control.
- Add/update tests.
- Update documentation.
- Make retryable operations idempotent.
FINISH
Run the senior-engineer self-review.
Run all relevant tests.
Review the Git diff.
Fix issues belonging to this milestone.
Return the required completion report.
Stop after this milestone.
Milestone 13 prompt
 START MILESTONE 13: Publishing and scheduling adapter
OBJECTIVE
Schedule approved content through a publishing layer without coupling the entire system to it.
BEFORE IMPLEMENTING
- Inspect the current repository and identify what is already complete.
- Read relevant docs and existing tests.
- Do not assume the target architecture is already correct.
- Preserve useful existing code.
ATOMIC TASKS
1. Define publishing adapter interface.
2. Define post payload contract.
3. Define schedule request contract.
4. Configure Postiz sandbox/test setup where available.
5. Implement authentication using environment variables.
6. Implement create/schedule operation.
7. Capture external publication ID.
8. Capture target platform and scheduled timestamp.
9. Create deterministic idempotency key.
10. Before publishing, verify content status is APPROVED.
11. Prevent duplicate submissions.
12. Handle provider timeouts.
13. Handle provider rate limits.
14. Handle partial failures.
15. Store provider response metadata without storing secrets.
16. Create cancellation/unschedule operation where supported.
17. Create test content and schedule it.
18. Verify re-running the same workflow does not create a duplicate.
19. Document provider-specific limitations.
ACCEPTANCE CRITERIA
- Approved test content can be scheduled.

- Unapproved content is blocked.
- Repeated execution is idempotent.
- External ID is stored.
- Provider errors produce recoverable workflow states.
CONSTRAINTS
- Work only on this milestone.
- Do not implement future milestones.
- Keep changes small and testable.
- Use sandbox/test credentials only.
- Do not publish real social content.
- Keep secrets out of source control.
- Add/update tests.
- Update documentation.
- Make retryable operations idempotent.
FINISH
Run the senior-engineer self-review.
Run all relevant tests.
Review the Git diff.
Fix issues belonging to this milestone.
Return the required completion report.
Stop after this milestone.
Milestone 14 prompt
 START MILESTONE 14: GitHub -> content opportunities
OBJECTIVE
Turn meaningful engineering progress into content opportunities automatically.
BEFORE IMPLEMENTING
- Inspect the current repository and identify what is already complete.
- Read relevant docs and existing tests.
- Do not assume the target architecture is already correct.
- Preserve useful existing code.
ATOMIC TASKS
1. Define which GitHub events matter: PR, release, merge, labeled milestone, or manually marked change.
2. Create webhook/event ingestion.
3. Verify signature/authenticity where supported.
4. Capture repository, ref, commit/PR/release ID, title, URL, timestamp.
5. Filter out trivial changes such as formatting-only commits if appropriate.
6. Extract changed-file summary.
7. Extract problem/goal from PR description where present.
8. Extract engineering decision/lesson candidates.
9. Generate content opportunity only for meaningful changes.
10. Link opportunity to GitHub URL.
11. Store source event ID.
12. Deduplicate repeated webhook delivery.
13. Create manual override to force a content opportunity.
14. Create tests for meaningful and trivial changes.
15. Run a test PR/release event.
ACCEPTANCE CRITERIA
- Meaningful engineering events produce opportunities.
- Duplicate webhook deliveries do not duplicate opportunities.
- Every opportunity links back to GitHub.
- Trivial changes are filtered or explicitly ignored.
CONSTRAINTS
- Work only on this milestone.
- Do not implement future milestones.
- Keep changes small and testable.
- Use sandbox/test credentials only.
- Do not publish real social content.
- Keep secrets out of source control.
- Add/update tests.
- Update documentation.
- Make retryable operations idempotent.

FINISH
Run the senior-engineer self-review.
Run all relevant tests.
Review the Git diff.
Fix issues belonging to this milestone.
Return the required completion report.
Stop after this milestone.
Milestone 15 prompt
 START MILESTONE 15: Analytics collection and normalization
OBJECTIVE
Connect published content to performance data.
BEFORE IMPLEMENTING
- Inspect the current repository and identify what is already complete.
- Read relevant docs and existing tests.
- Do not assume the target architecture is already correct.
- Preserve useful existing code.
ATOMIC TASKS
1. Define normalized analytics schema.
2. Define immutable publication record.
3. Store platform, post ID, topic, format, hook, published timestamp.
4. Identify available platform metrics.
5. Build provider-specific metric adapters.
6. Normalize common fields such as impressions/reach, reactions, comments, shares, saves/bookmarks, profile actions, clicks
where available.
7. Store raw provider payload separately if needed.
8. Record retrieval timestamp.
9. Handle missing metrics without zeroing unknown values incorrectly.
10. Create scheduled analytics collection workflow.
11. Implement retry/backoff.
12. Prevent duplicate analytics records for the same retrieval.
13. Calculate derived metrics only when denominators exist.
14. Link analytics back to content item and source atom.
15. Create test fixtures.
16. Verify analytics collection survives provider failure.
ACCEPTANCE CRITERIA
- Published content can receive analytics records.
- Unknown metrics remain unknown, not falsely zero.
- Provider-specific data is traceable.
- Repeated collection is safe.
CONSTRAINTS
- Work only on this milestone.
- Do not implement future milestones.
- Keep changes small and testable.
- Use sandbox/test credentials only.
- Do not publish real social content.
- Keep secrets out of source control.
- Add/update tests.
- Update documentation.
- Make retryable operations idempotent.
FINISH
Run the senior-engineer self-review.
Run all relevant tests.
Review the Git diff.
Fix issues belonging to this milestone.
Return the required completion report.
Stop after this milestone.
Milestone 16 prompt
 START MILESTONE 16: Weekly content intelligence

OBJECTIVE
Turn accumulated learning, publishing, and analytics data into useful weekly decisions.
BEFORE IMPLEMENTING
- Inspect the current repository and identify what is already complete.
- Read relevant docs and existing tests.
- Do not assume the target architecture is already correct.
- Preserve useful existing code.
ATOMIC TASKS
1. Define weekly reporting window and timezone.
2. Calculate learning events.
3. Calculate content ideas created.
4. Calculate drafts generated.
5. Calculate approved/published items.
6. Calculate time from learning capture to publish when timestamps exist.
7. Group performance by topic.
8. Group performance by format.
9. Group performance by platform.
10. Group performance by hook class where structured.
11. Identify strongest and weakest signals without overclaiming causality.
12. Surface publishing failures.
13. Surface approval backlog.
14. Generate 3-5 content opportunities for the next week.
15. Generate 3-5 learning-topic suggestions from content gaps and demonstrated interest.
16. Store weekly report.
17. Send report through Telegram or another channel.
18. Create seeded test data for a fake week.
19. Verify report totals against underlying data.
ACCEPTANCE CRITERIA
- Weekly report is reproducible.
- Numbers reconcile with source records.
- Recommendations remain suggestions, not automatic publishing decisions.
- Historical reports remain accessible.
CONSTRAINTS
- Work only on this milestone.
- Do not implement future milestones.
- Keep changes small and testable.
- Use sandbox/test credentials only.
- Do not publish real social content.
- Keep secrets out of source control.
- Add/update tests.
- Update documentation.
- Make retryable operations idempotent.
FINISH
Run the senior-engineer self-review.
Run all relevant tests.
Review the Git diff.
Fix issues belonging to this milestone.
Return the required completion report.
Stop after this milestone.
Milestone 17 prompt
 START MILESTONE 17: Reliability, security, observability
OBJECTIVE
Make the system safe to run repeatedly and diagnose when something breaks.
BEFORE IMPLEMENTING
- Inspect the current repository and identify what is already complete.
- Read relevant docs and existing tests.
- Do not assume the target architecture is already correct.
- Preserve useful existing code.
ATOMIC TASKS
1. Audit every secret and credential path.

2. Confirm secrets are absent from Git history and logs where possible.
3. Add input validation at every external boundary.
4. Add timeouts to external HTTP calls.
5. Add retry policy with backoff for transient failures.
6. Define permanent vs retryable failure states.
7. Add dead-letter/error state for failed content/publishing operations.
8. Add correlation IDs across workflows.
9. Add structured logs for key transitions.
10. Add execution/run records for critical workflows.
11. Add service health checks.
12. Add system health workflow.
13. Add failure notification path.
14. Define database backup procedure.
15. Define restore test procedure.
16. Test service restart.
17. Test database restart.
18. Test Redis restart.
19. Test provider outage.
20. Test malformed input.
21. Test duplicate webhook.
22. Test duplicate approval.
23. Test duplicate publish request.
24. Document incident/recovery procedures.
ACCEPTANCE CRITERIA
- Failures are visible and diagnosable.
- Retries do not create duplicates.
- Secrets are handled safely.
- State survives service restarts.
- Recovery procedure is documented and tested.
CONSTRAINTS
- Work only on this milestone.
- Do not implement future milestones.
- Keep changes small and testable.
- Use sandbox/test credentials only.
- Do not publish real social content.
- Keep secrets out of source control.
- Add/update tests.
- Update documentation.
- Make retryable operations idempotent.
FINISH
Run the senior-engineer self-review.
Run all relevant tests.
Review the Git diff.
Fix issues belonging to this milestone.
Return the required completion report.
Stop after this milestone.
Milestone 18 prompt
 START MILESTONE 18: End-to-end launch and final audit
OBJECTIVE
Prove the complete system with realistic test data and leave the repository usable by another engineer.
BEFORE IMPLEMENTING
- Inspect the current repository and identify what is already complete.
- Read relevant docs and existing tests.
- Do not assume the target architecture is already correct.
- Preserve useful existing code.
ATOMIC TASKS
1. Create a representative learning event.
2. Run learning normalization.
3. Run classification.
4. Run deduplication.
5. Create Content Atom.
6. Run research enrichment.

7. Generate content ideas.
8. Generate X short post.
9. Generate X thread.
10. Generate LinkedIn post.
11. Generate Reel script.
12. Generate Carousel.
13. Run quality gate.
14. Send to Telegram approval.
15. Approve one version.
16. Reject one version.
17. Regenerate one version.
18. Schedule approved test content.
19. Verify publication record.
20. Run analytics collection using test/mock data where real metrics are unavailable.
21. Generate weekly intelligence.
22. Verify all records link back to the original learning event.
23. Run duplicate execution of the complete path.
24. Verify duplicate execution does not publish duplicates.
25. Run failure injection for at least one dependency.
26. Verify recovery.
27. Run full tests.
28. Run lint/type checks where applicable.
29. Review Git diff.
30. Remove debug code and temporary data.
31. Update README.
32. Update architecture docs.
33. Update setup guide.
34. Update workflow catalog.
35. Update troubleshooting guide.
36. Create demo script.
37. Create final launch checklist.
38. Tag/version the first stable release.
ACCEPTANCE CRITERIA
- Complete learning-to-analytics path is demonstrable.
- Duplicate path is safe.
- Failure path is demonstrable.
- Documentation is sufficient for a clean setup.
- Repository contains no accidental secrets or debug artifacts.
- Final audit report is PASS.
CONSTRAINTS
- Work only on this milestone.
- Do not implement future milestones.
- Keep changes small and testable.
- Use sandbox/test credentials only.
- Do not publish real social content.
- Keep secrets out of source control.
- Add/update tests.
- Update documentation.
- Make retryable operations idempotent.
FINISH
Run the senior-engineer self-review.
Run all relevant tests.
Review the Git diff.
Fix issues belonging to this milestone.
Return the required completion report.
Stop after this milestone.

23. Human Operator Checklist
The system is automated, but the operator still controls learning quality, brand voice, and public reputation.
Daily
 - [ ] Capture at least one real learning event after meaningful learning/building.
 - [ ] Attach personal observations, mistakes, or implementation details when they materially improve the content.
 - [ ] Review the generated content queue.
 - [ ] Approve only content that you are comfortable attaching to your public engineering identity.
 - [ ] Reject generic or inaccurate drafts instead of accepting them because they are convenient.
 - [ ] Check source links on technical claims that matter.
 - [ ] Confirm scheduled content is distributed at the intended times.

Weekly
 - [ ] Review learning volume versus content volume.
 - [ ] Review which topics produced useful audience signals.
 - [ ] Review project/proof-of-work content opportunities.
 - [ ] Check publishing failures and approval backlog.
 - [ ] Choose the next week's primary learning themes.
 - [ ] Archive stale content ideas.
 - [ ] Review automation cost/compute/resource usage even if the stack is self-hosted.
 Do not optimize the system for the maximum number of posts. Optimize for turning real
engineering growth into durable public proof of work.
24. Project Completion Definition
The project is finished only when a clean end-to-end demonstration can be run from start to finish.
 INPUT
"Today I learned why refresh-token rotation matters."
SYSTEM
1. Capture learning event.
2. Normalize + classify.
3. Detect duplicates.
4. Build Content Atom.
5. Research and attach sources.
6. Generate content ideas.
7. Generate X / LinkedIn / Reel / Carousel drafts.
8. Run quality gate.
9. Send approval card.
10. Approve one version.
11. Schedule via publishing adapter.
12. Record external publication ID.
13. Collect or mock analytics.
14. Generate weekly intelligence.
15. Link every artifact back to the original learning event.
FAILURE TEST
Repeat steps or intentionally fail a dependency.
Expected: no duplicate publication, visible error, retry/recovery path.
FINAL DELIVERABLE
A documented, reproducible repository that another engineer can start, understand, test, and extend.
25. The One-by-One Prompt Loop You Actually
Run

STEP 1
Send Master Controller Prompt.
STEP 2
Send:
"Start Milestone 01."
STEP 3
Claude builds + tests + self-reviews + reports.
STEP 4
Send:
"Run the Review Loop Prompt."
STEP 5
Claude audits + fixes + returns PASS/FAIL.
STEP 6
If PASS:
"Start Milestone 02."
STEP 7
Repeat.
STEP 8
After every 3-4 milestones, perform a repository-wide sanity check:
"Review the system architecture across completed milestones only. Do not implement future work."
STEP 9
At Milestone 18:
Run the Final Acceptance Test, full test suite, security review, documentation review, and end-to-end demonstration.
This is intentionally sequential. The human acts as product owner/reviewer; Claude acts as the
implementation agent; the repository and tests are the source of truth.

Appendix A - Recommended First Build Scope
To keep the first implementation manageable, do not begin with every social network or advanced AI agent.
The first stable release should prove one complete path.
 Release 0.1
Learning Inbox
↓
Content Atom
↓
Research
↓
Idea
↓
X draft + LinkedIn draft + Reel script
↓
Quality gate
↓
Telegram approval
↓
Postiz sandbox/test scheduling
↓
Publication record
↓
Mock analytics
↓
Weekly report
Then add more network adapters, richer analytics, GitHub triggers, and deeper recommendation logic only
after the core path is reliable.
Appendix B - Suggested Tool Responsibility
Split
 NOTION
Human-facing notes / knowledge / manual planning
n8n
Orchestration / schedules / integrations / routing
POSTGRESQL
Durable system state / content provenance / analytics
REDIS
Queues / transient state / rate limiting / caching where required
OLLAMA
Local AI transformations and routine classification
POSTIZ
Social publishing/scheduling adapter
TELEGRAM
Mobile approval and control interface
GITHUB
Engineering source events / proof of work
GITHUB ACTIONS
Repository-side automation and scheduled technical tasks
