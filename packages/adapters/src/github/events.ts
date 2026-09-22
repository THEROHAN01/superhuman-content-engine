import { z } from 'zod';

/**
 * GitHub event parsing.
 *
 * Only the events that can plausibly represent finished engineering work are modelled: a merged
 * pull request and a published release. Everything else is ignored explicitly rather than
 * half-handled - an unrecognised event must not silently become a content opportunity.
 */
export const pullRequestEvent = z.object({
  action: z.string(),
  number: z.number(),
  pull_request: z.object({
    id: z.number(),
    number: z.number(),
    title: z.string(),
    body: z.string().nullable().optional(),
    html_url: z.string(),
    merged: z.boolean().optional(),
    merged_at: z.string().nullable().optional(),
    merge_commit_sha: z.string().nullable().optional(),
    additions: z.number().optional(),
    deletions: z.number().optional(),
    changed_files: z.number().optional(),
    labels: z.array(z.object({ name: z.string() })).optional(),
    base: z.object({ ref: z.string() }).optional(),
    head: z.object({ ref: z.string() }).optional(),
    user: z.object({ login: z.string() }).optional(),
  }),
  repository: z.object({ full_name: z.string(), html_url: z.string().optional() }),
});

export const releaseEvent = z.object({
  action: z.string(),
  release: z.object({
    id: z.number(),
    tag_name: z.string(),
    name: z.string().nullable().optional(),
    body: z.string().nullable().optional(),
    html_url: z.string(),
    draft: z.boolean().optional(),
    prerelease: z.boolean().optional(),
    published_at: z.string().nullable().optional(),
  }),
  repository: z.object({ full_name: z.string(), html_url: z.string().optional() }),
});

export type GithubEventKind = 'pull_request_merged' | 'release_published';

export interface EngineeringEvent {
  kind: GithubEventKind;
  /** Stable provider-side id: the PR or release id, prefixed by kind. */
  externalId: string;
  repository: string;
  title: string;
  body: string;
  url: string;
  ref: string | null;
  sha: string | null;
  occurredAt: string | null;
  author: string | null;
  labels: string[];
  stats: { additions: number | null; deletions: number | null; changedFiles: number | null };
}

export type ParseOutcome =
  { matched: true; event: EngineeringEvent } | { matched: false; reason: string };

export const parseGithubEvent = (eventType: string, payload: unknown): ParseOutcome => {
  if (eventType === 'pull_request') {
    const parsed = pullRequestEvent.safeParse(payload);
    if (!parsed.success)
      return { matched: false, reason: 'pull_request payload failed validation' };

    const { action, pull_request: pr, repository } = parsed.data;
    // Only a *merged* PR represents work that actually landed. A closed-unmerged PR is abandoned
    // work, and an opened one is unfinished.
    if (action !== 'closed' || pr.merged !== true) {
      return { matched: false, reason: `pull_request action '${action}' is not a merge` };
    }

    return {
      matched: true,
      event: {
        kind: 'pull_request_merged',
        externalId: `pr:${pr.id}`,
        repository: repository.full_name,
        title: pr.title,
        body: pr.body ?? '',
        url: pr.html_url,
        ref: pr.base?.ref ?? null,
        sha: pr.merge_commit_sha ?? null,
        occurredAt: pr.merged_at ?? null,
        author: pr.user?.login ?? null,
        labels: (pr.labels ?? []).map((label) => label.name),
        stats: {
          additions: pr.additions ?? null,
          deletions: pr.deletions ?? null,
          changedFiles: pr.changed_files ?? null,
        },
      },
    };
  }

  if (eventType === 'release') {
    const parsed = releaseEvent.safeParse(payload);
    if (!parsed.success) return { matched: false, reason: 'release payload failed validation' };

    const { action, release, repository } = parsed.data;
    if (action !== 'published' || release.draft === true) {
      return { matched: false, reason: `release action '${action}' is not a publication` };
    }

    return {
      matched: true,
      event: {
        kind: 'release_published',
        externalId: `release:${release.id}`,
        repository: repository.full_name,
        title: release.name?.trim() || release.tag_name,
        body: release.body ?? '',
        url: release.html_url,
        ref: release.tag_name,
        sha: null,
        occurredAt: release.published_at ?? null,
        author: null,
        labels: release.prerelease === true ? ['prerelease'] : [],
        stats: { additions: null, deletions: null, changedFiles: null },
      },
    };
  }

  return { matched: false, reason: `event type '${eventType}' is not handled` };
};
