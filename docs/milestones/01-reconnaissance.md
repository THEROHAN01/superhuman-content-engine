# Milestone 01 - Repository reconnaissance and technical design

**STATUS: COMPLETE**

**OBJECTIVE:** Know exactly what exists, what must be built, and what will be preserved.

## WHAT I BUILT

A documented current-state audit, the target architecture, the risk register, the decision log and
the per-milestone file plan - plus the empty repository's toolchain scaffold (pnpm workspace,
TypeScript, eslint, prettier, vitest, tsup) so later milestones have a verifiable `pnpm verify`
gate from the first line of application code.

## TASKS COMPLETED

| # | Atomic task | Result |
| --- | --- | --- |
| 1 | List repository root and all source/config/test files | done - repository was empty (`git log` had no commits, `ls -a` showed only `.git`) |
| 2 | Identify language, package manager, runtime, build system, scripts | done - none existed; chosen and recorded in `docs/reconnaissance.md` section 2 |
| 3 | Inspect Docker/Compose/env/CI/database/deployment files | done - none existed; host capabilities audited instead (section 3) |
| 4 | Inspect Git history for architectural intent | done - no commits existed before this session |
| 5 | Search for existing integrations | done - none |
| 6 | Search for TODO/FIXME markers | done - none (empty tree) |
| 7 | Identify existing content schema / prompts / pipeline code | done - none |
| 8 | Document external dependencies and credential needs | done - `docs/reconnaissance.md` section 5 |
| 9 | Identify what can be reused | done - section 6 (nothing in-repo; host PostgreSQL 16 and Redis 7 reused for real tests) |
| 10 | Create `docs/reconnaissance.md` | done |
| 11 | Create `docs/architecture.md` | done |
| 12 | List files expected in later milestones | done - `docs/file-plan.md` |
| 13 | Risk register incl. dependency, credential, rate-limit, duplication, failure-mode | done - `docs/risk-register.md` (13 risks, all five categories present) |
| 14 | Define local-dev assumptions and sandbox/test-account policy | done - `docs/reconnaissance.md` section 7 + ADR-004/005/006 |
| 15 | Do not modify application behavior | done - there is no application behavior yet; only scaffolding and docs were added |

## FILES CREATED

`CLAUDE.md`, `.gitignore`, `README.md`, `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`,
`tsconfig.json`, `eslint.config.js`, `.prettierrc.json`, `.prettierignore`, `vitest.config.ts`,
`tsup.config.ts`, `tests/workspace.test.ts`,
`docs/{build-plan,reconnaissance,architecture,file-plan,risk-register,decisions}.md`,
`docs/milestones/README.md`, `docs/milestones/01-reconnaissance.md`,
`.claude/{settings.json,skills/*,hooks/*,agents/*,commands/*}`,
package skeletons for `apps/{api,workers,bot}` and `packages/{utils,schemas,db,prompts,adapters,core}`.

## FILES MODIFIED

`.claude/hooks/guard-bash.sh` - rewritten after testing showed it blocked heredoc *documentation*
that merely mentioned a dangerous command; it now strips heredoc bodies and anchors patterns to
statement position.

## TESTS RUN

```
pnpm typecheck      # tsc --noEmit
pnpm lint           # prettier --check . && eslint .
pnpm test           # vitest run
pnpm verify         # all three
python3 /tmp/hooktest.py   # 11-case hook matrix + 2 heredoc cases
```

## TEST RESULTS

- `pnpm verify`: PASS - Test Files 1 passed (1), Tests 6 passed (6).
- Hook matrix: 13/13 expected outcomes (blocks: `.env` write, credential literal, wrong package
  manager, volume wipe, live publish, force-push to main; allows: clean source, new migration,
  `pnpm test`, normal push, clean commit, documentation mentioning dangerous strings).

## MANUAL VERIFICATION

```
$ node -v && pnpm -v            -> v22.22.2 / 10.33.0
$ psql -tAc 'select version()'  -> PostgreSQL 16.13 on x86_64-pc-linux-gnu
$ redis-server --version        -> v=7.0.15
$ docker ps                     -> cannot connect to /var/run/docker.sock (daemon not running)
```

## SECURITY REVIEW

- `.gitignore` excludes `.env*` (except `*.env.example`), `*.pem`, `*.key`, `secrets/`,
  `n8n/credentials/*.json`.
- A tracked-file credential scan runs as a test (`tests/workspace.test.ts`) - currently zero hits.
- Three Claude hooks block secret-bearing writes, credential literals, and staged `.env` files.
- No credentials exist in this environment, so nothing could be leaked yet.

## KNOWN LIMITATIONS

1. No Docker daemon here, so compose-based start-up cannot be demonstrated in this environment
   (risk R7). Milestone 02 validates compose statically and documents the operator-run check.
2. No external credentials, so all provider integrations will be mock-first (risk R1).
3. The scaffold has no application code yet; `packages/*/src` are empty until Milestone 03.

## GIT DIFF SUMMARY

Two commits: the Claude control layer (`0e1ec74`), then this milestone's docs plus scaffold.
No application behavior existed to change.

## ACCEPTANCE CRITERIA

| Criterion | Evidence |
| --- | --- |
| Repository inventory is documented | `docs/reconnaissance.md` sections 1-3 |
| Current and target architecture documented | `docs/reconnaissance.md`, `docs/architecture.md` |
| External dependencies and credential requirements documented | `docs/reconnaissance.md` section 5 |
| No application feature changed unnecessarily | no application existed; diff is docs + scaffold only |
| Next milestone explainable without guessing | `docs/file-plan.md` row 02 lists the exact files and `docs/build-plan.md` holds its 19 atomic tasks |

## RECOMMENDED NEXT MILESTONE

02 - Docker and local infrastructure.
