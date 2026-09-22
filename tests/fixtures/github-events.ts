/**
 * GitHub webhook fixtures, trimmed to the fields the engine reads. Each names the outcome it must
 * produce, so the significance filter's behavior is defined by examples rather than by prose.
 */
export interface GithubFixture {
  name: string;
  eventType: string;
  payload: Record<string, unknown>;
  expect: { status: 'captured' | 'filtered'; reasonMatches?: RegExp };
}

const repository = {
  full_name: 'therohan01/superhuman-content-engine',
  html_url: 'https://github.com/therohan01/superhuman-content-engine',
};

const pr = (overrides: Record<string, unknown> = {}, action = 'closed') => ({
  action,
  number: 12,
  repository,
  pull_request: {
    id: 100 + Number(overrides['id'] ?? 0),
    number: 12,
    title: 'Claim the publication slot before calling the provider',
    body: `The publishing path had a check-then-send race: two workers could both see "no publication" and both call Postiz.

We now insert the publication row behind a unique idempotency key before the provider call, because a retry after a timeout cannot otherwise tell "sent" from "never sent". The trade-off is a claimed row to reconcile after a crash, which is strictly better than an untracked post.`,
    html_url: 'https://github.com/therohan01/superhuman-content-engine/pull/12',
    merged: true,
    merged_at: '2026-09-22T08:00:00Z',
    merge_commit_sha: 'abc123',
    additions: 180,
    deletions: 24,
    changed_files: 6,
    labels: [],
    base: { ref: 'main' },
    head: { ref: 'feat/publish-idempotency' },
    user: { login: 'therohan01' },
    ...overrides,
  },
});

export const GITHUB_FIXTURES: GithubFixture[] = [
  {
    name: 'merged PR with a real explanation',
    eventType: 'pull_request',
    payload: pr(),
    expect: { status: 'captured', reasonMatches: /explains a decision|substantive/ },
  },
  {
    name: 'PR that is open, not merged',
    eventType: 'pull_request',
    payload: pr({ merged: false }, 'opened'),
    expect: { status: 'filtered', reasonMatches: /not a merge/ },
  },
  {
    name: 'PR closed without merging',
    eventType: 'pull_request',
    payload: pr({ merged: false }),
    expect: { status: 'filtered', reasonMatches: /not a merge/ },
  },
  {
    name: 'dependency bump',
    eventType: 'pull_request',
    payload: pr({
      id: 1,
      title: 'chore(deps): bump vitest from 3.0.4 to 3.0.5',
      body: 'Automated dependency update.',
    }),
    expect: { status: 'filtered', reasonMatches: /routine maintenance/ },
  },
  {
    name: 'merge with no description',
    eventType: 'pull_request',
    payload: pr({ id: 2, title: 'Add retry to the analytics worker', body: '' }),
    expect: { status: 'filtered', reasonMatches: /too short/ },
  },
  {
    name: 'one-line typo fix',
    eventType: 'pull_request',
    payload: pr({
      id: 3,
      title: 'Fix the wording in the approval card',
      body: 'The approval card said "Reject" where it meant "Request change", which confused me twice this week. This corrects the label and the accompanying help text so the buttons match what they do.',
      additions: 2,
      deletions: 2,
      changed_files: 1,
    }),
    expect: { status: 'filtered', reasonMatches: /single-file change/ },
  },
  {
    name: 'trivial-looking title rescued by an explicit label',
    eventType: 'pull_request',
    payload: pr({
      id: 4,
      title: 'chore: rework the retry policy',
      labels: [{ name: 'architecture' }],
    }),
    expect: { status: 'captured', reasonMatches: /labelled/ },
  },
  {
    name: 'published release with notes',
    eventType: 'release',
    payload: {
      action: 'published',
      repository,
      release: {
        id: 900,
        tag_name: 'v0.2.0',
        name: 'v0.2.0 - publishing safety',
        body: 'Publishing now claims its slot in the database before calling the provider, so concurrent retries cannot create two posts. Approval can also be withdrawn before scheduling.',
        html_url: 'https://github.com/therohan01/superhuman-content-engine/releases/tag/v0.2.0',
        draft: false,
        prerelease: false,
        published_at: '2026-09-22T09:00:00Z',
      },
    },
    expect: { status: 'captured', reasonMatches: /release with substantive notes/ },
  },
  {
    name: 'release with empty notes',
    eventType: 'release',
    payload: {
      action: 'published',
      repository,
      release: {
        id: 901,
        tag_name: 'v0.2.1',
        name: null,
        body: '',
        html_url: 'https://github.com/therohan01/superhuman-content-engine/releases/tag/v0.2.1',
        draft: false,
        published_at: '2026-09-22T10:00:00Z',
      },
    },
    expect: { status: 'filtered', reasonMatches: /no substantive notes/ },
  },
  {
    name: 'draft release',
    eventType: 'release',
    payload: {
      action: 'created',
      repository,
      release: {
        id: 902,
        tag_name: 'v0.3.0',
        body: 'Long enough notes to be interesting, but this release is only a draft so far and has not been published yet.',
        html_url: 'https://github.com/therohan01/superhuman-content-engine/releases/tag/v0.3.0',
        draft: true,
      },
    },
    expect: { status: 'filtered', reasonMatches: /not a publication/ },
  },
  {
    name: 'unhandled event type',
    eventType: 'issues',
    payload: { action: 'opened', issue: { id: 1 } },
    expect: { status: 'filtered', reasonMatches: /not handled/ },
  },
];
