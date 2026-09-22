import type { EngineeringEvent } from './events.js';

/**
 * Significance filtering.
 *
 * Most merged pull requests are not worth writing about. This filter is deliberately conservative
 * in one direction: it would rather let a borderline change through (a human still approves
 * everything downstream) than silently drop work that mattered. Its judgement is always explained.
 */
export interface Significance {
  significant: boolean;
  reason: string;
  /** 0-1, used for ordering rather than gating. */
  score: number;
}

const TRIVIAL_TITLE = /^(chore|style|ci|build|docs?|typo|bump|deps?|revert)(\(.+\))?[:!]/i;
const TRIVIAL_PHRASES =
  /\b(bump|update) (dependency|dependencies|lockfile|version)\b|^merge (branch|pull request)/i;
const MEANINGFUL_LABELS =
  /^(feature|enhancement|architecture|performance|security|refactor|postmortem|content)$/i;
const EXPLANATORY =
  /\b(because|why|root cause|trade-?off|decided|instead of|turned out|the problem was)\b/i;

export const assessSignificance = (event: EngineeringEvent): Significance => {
  // An explicit label always wins - it is the manual override that needs no API call.
  if (event.labels.some((label) => MEANINGFUL_LABELS.test(label))) {
    return { significant: true, reason: `labelled '${event.labels.join(', ')}'`, score: 0.9 };
  }

  if (event.kind === 'release_published') {
    // A release with notes is a summary of finished work; an empty one says nothing.
    const hasNotes = event.body.trim().length >= 80;
    return hasNotes
      ? { significant: true, reason: 'release with substantive notes', score: 0.8 }
      : { significant: false, reason: 'release has no substantive notes to draw on', score: 0.2 };
  }

  if (TRIVIAL_TITLE.test(event.title) || TRIVIAL_PHRASES.test(event.title)) {
    return {
      significant: false,
      reason: `title looks like routine maintenance: "${event.title}"`,
      score: 0.1,
    };
  }

  const body = event.body.trim();
  if (body.length < 120) {
    return {
      significant: false,
      reason: 'description is too short to explain what was learned',
      score: 0.2,
    };
  }

  const changed = event.stats.changedFiles ?? 0;
  const churn = (event.stats.additions ?? 0) + (event.stats.deletions ?? 0);
  if (changed === 1 && churn > 0 && churn < 10) {
    return {
      significant: false,
      reason: 'single-file change of fewer than ten lines',
      score: 0.15,
    };
  }

  const explains = EXPLANATORY.test(body);
  return {
    significant: true,
    reason: explains
      ? 'description explains a decision or a cause'
      : 'substantive change with a real description',
    score: explains ? 0.75 : 0.55,
  };
};

/**
 * Turns the event into the text a learning event stores.
 * It quotes GitHub verbatim - nothing is summarized here, because summarizing before storage
 * would lose the original wording the rest of the pipeline treats as source material.
 */
export const toLearningText = (event: EngineeringEvent): string => {
  const lines = [
    event.kind === 'release_published'
      ? `Released ${event.title} in ${event.repository}.`
      : `Merged "${event.title}" in ${event.repository}.`,
  ];

  if (event.body.trim().length > 0) {
    lines.push('', event.body.trim());
  }
  if (event.stats.changedFiles !== null) {
    lines.push(
      '',
      `Changed ${event.stats.changedFiles} file(s), +${event.stats.additions ?? 0}/-${event.stats.deletions ?? 0}.`,
    );
  }
  lines.push('', `Source: ${event.url}`);

  return lines.join('\n');
};
