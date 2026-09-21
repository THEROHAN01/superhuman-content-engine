# Files expected to be created or modified per milestone

Planning artifact from Milestone 01. Deviations are fine when justified; record them in the
milestone report.

| Milestone                    | Creates                                                                                                                                              | Modifies               |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| 01 reconnaissance            | `docs/reconnaissance.md`, `docs/architecture.md`, `docs/file-plan.md`, `docs/risk-register.md`, `docs/decisions.md`, workspace scaffold, `README.md` | -                      |
| 02 infrastructure            | `infra/docker-compose.yml`, `infra/.env.example`, `infra/scripts/*.sh`, `docs/environment.md`, `docs/runbook.md`                                     | `README.md`            |
| 03 database + schemas        | `packages/db/migrations/*.sql`, `packages/db/src/*`, `packages/schemas/src/*`, DB tests                                                              | `docs/architecture.md` |
| 04 capture API               | `apps/api/src/*`, `packages/core/src/capture.ts`, tests                                                                                              | `docs/environment.md`  |
| 05 n8n foundation            | `n8n/workflows/*.json`, `n8n/credentials/*.example.json`, `docs/workflows.md`, `infra/scripts/n8n-*.sh`                                              | compose                |
| 06 normalize/classify/dedupe | `packages/core/src/{normalize,classify,dedupe}.ts`, fixtures, tests                                                                                  | schemas, migrations    |
| 07 research                  | `packages/adapters/src/research/*`, `packages/core/src/research.ts`, `docs/external-apis.md`                                                         | schemas                |
| 08 content atom              | `packages/core/src/atom.ts`, `packages/schemas/src/content-atom.ts`, fixtures                                                                        | migrations             |
| 09 ideation                  | `packages/prompts/src/ideation.v1.ts`, `packages/core/src/ideation.ts`                                                                               | schemas                |
| 10 generators                | `packages/prompts/src/*` (voice, banned phrases, per-platform), `packages/core/src/generate.ts`                                                      | schemas                |
| 11 quality gate              | `packages/core/src/quality-gate.ts`, `packages/prompts/src/quality-gate.v1.ts`, fixtures                                                             | schemas                |
| 12 approval                  | `apps/bot/src/*`, `apps/api/src/routes/telegram.ts`, `packages/core/src/approval.ts`, telegram adapter                                               | migrations             |
| 13 publishing                | `packages/adapters/src/publishing/*`, `packages/core/src/publish.ts`, publish route                                                                  | migrations, docs       |
| 14 GitHub events             | `apps/api/src/routes/github.ts`, `packages/core/src/github-opportunity.ts`                                                                           | migrations             |
| 15 analytics                 | `packages/core/src/analytics.ts`, `apps/workers/src/jobs/collect-analytics.ts`                                                                       | migrations             |
| 16 weekly intelligence       | `packages/core/src/weekly-report.ts`, `apps/workers/src/jobs/weekly-report.ts`                                                                       | migrations             |
| 17 reliability               | health routes, retry hardening, `docs/runbook.md`, backup/restore scripts                                                                            | many                   |
| 18 launch                    | `tests/e2e/*.test.ts`, `docs/{setup,troubleshooting,demo,launch-checklist}.md`, release tag                                                          | README, docs           |
