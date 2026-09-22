import { operations, weeklyReports } from '@sce/db';
import type { TelegramAdapter } from '@sce/adapters';
import {
  newCorrelationId,
  newId,
  permanent,
  startOfIsoWeek,
  transient,
  type Result,
} from '@sce/utils';
import type { WeeklyReport, WeeklyReportBody } from '@sce/schemas';
import type { ServiceContext } from './context.js';

/**
 * Weekly intelligence.
 *
 * The report has to be *reproducible* and *honest*: every number comes from a query over stored
 * rows, unknown metrics stay unknown rather than being averaged as zero, and every signal carries
 * the basis it was drawn from plus a confidence that reflects how much data stood behind it.
 * Recommendations are suggestions - nothing here schedules or publishes anything.
 */
export const REPORT_VERSION = 'weekly.v1';

/** Below this many measured publications, a group's performance is not a signal. */
const MIN_MEASURED_FOR_SIGNAL = 2;

export interface ReportWindow {
  start: Date;
  end: Date;
  key: string;
}

/** ISO week key (2026-W39) for the week containing `at`, in the given timezone. */
export const isoWeekKey = (at: Date, timeZone: string): string => {
  const monday = startOfIsoWeek(at, timeZone);
  // ISO week number: Thursday of the same week decides the year.
  const thursday = new Date(monday.getTime() + 3 * 24 * 60 * 60 * 1000);
  const year = thursday.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  const firstMonday = new Date(
    firstThursday.getTime() - ((firstThursday.getUTCDay() + 6) % 7) * 86_400_000,
  );
  const week = Math.floor((thursday.getTime() - firstMonday.getTime()) / (7 * 86_400_000)) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
};

export const weekWindow = (at: Date, timeZone: string): ReportWindow => {
  const start = startOfIsoWeek(at, timeZone);
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  return { start, end, key: isoWeekKey(at, timeZone) };
};

/** Coarse class of an opening line, so hooks can be compared without reading each one. */
export const classifyHook = (hook: string): string => {
  const text = hook.trim().toLowerCase();
  if (text.startsWith('mistake') || /\bi (broke|lost|shipped|got .* wrong)\b/.test(text))
    return 'confession';
  if (text.endsWith('?')) return 'question';
  if (/^\d|\b\d+(%|x|ms|s)\b/.test(text)) return 'number';
  if (/\b(never|always|stop|don't|do not)\b/.test(text)) return 'imperative';
  if (/\b(because|why|turns out|the reason)\b/.test(text)) return 'mechanism';
  return 'statement';
};

interface GroupAccumulator {
  published: number;
  impressions: number | null;
  engagements: number | null;
  measured: number;
}

const emptyGroup = (): GroupAccumulator => ({
  published: 0,
  impressions: null,
  engagements: null,
  measured: 0,
});

/** Adds a known value to a possibly-unknown running total without inventing a zero. */
const addKnown = (total: number | null, value: number | null): number | null =>
  value === null ? total : (total ?? 0) + value;

const summarize = (groups: Map<string, GroupAccumulator>): WeeklyReportBody['by_topic'] =>
  [...groups.entries()]
    .map(([key, group]) => ({
      key,
      published: group.published,
      impressions: group.impressions,
      engagements: group.engagements,
      engagement_rate:
        group.impressions !== null && group.impressions > 0 && group.engagements !== null
          ? Number((group.engagements / group.impressions).toFixed(5))
          : null,
      measured: group.measured,
    }))
    .sort((a, b) => b.published - a.published || a.key.localeCompare(b.key));

export interface GenerateReportOptions {
  /** Any instant inside the week to report on; defaults to now. */
  at?: Date;
  timeZone?: string;
}

export interface GenerateReportResult {
  report: WeeklyReport;
  /** False when a report for this week and version already existed and was refreshed. */
  inserted: boolean;
}

export const generateWeeklyReport = async (
  ctx: ServiceContext,
  options: GenerateReportOptions = {},
): Promise<Result<GenerateReportResult>> => {
  const timeZone = options.timeZone ?? ctx.env.TZ;
  const window = weekWindow(options.at ?? ctx.clock(), timeZone);
  const correlationId = newCorrelationId();
  const params = [window.start.toISOString(), window.end.toISOString()];

  const runId = await operations.startWorkflowRun(ctx.db, {
    workflow: 'weekly_report_v1',
    correlationId,
    subjectId: window.key,
    input: { period: window.key, timezone: timeZone },
  });

  try {
    // ------------------------------------------------------------------ counts
    const counts = await ctx.db.query<{
      learning_events: number;
      learning_events_duplicate: number;
      content_atoms: number;
      content_ideas: number;
      drafts_generated: number;
      drafts_gated_pass: number;
      drafts_rejected_by_gate: number;
      approved: number;
      rejected_by_human: number;
      published: number;
      publications_failed: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM learning_events WHERE captured_at >= $1 AND captured_at < $2 AND status <> 'duplicate') AS learning_events,
         (SELECT count(*)::int FROM learning_events WHERE captured_at >= $1 AND captured_at < $2 AND status = 'duplicate') AS learning_events_duplicate,
         (SELECT count(*)::int FROM content_atoms WHERE created_at >= $1 AND created_at < $2) AS content_atoms,
         (SELECT count(*)::int FROM content_ideas WHERE created_at >= $1 AND created_at < $2) AS content_ideas,
         (SELECT count(*)::int FROM content_items WHERE created_at >= $1 AND created_at < $2) AS drafts_generated,
         (SELECT count(*)::int FROM content_items WHERE created_at >= $1 AND created_at < $2
            AND quality_gate->>'verdict' = 'pass') AS drafts_gated_pass,
         (SELECT count(*)::int FROM content_items WHERE created_at >= $1 AND created_at < $2
            AND quality_gate->>'verdict' = 'reject') AS drafts_rejected_by_gate,
         (SELECT count(*)::int FROM approvals WHERE decided_at >= $1 AND decided_at < $2 AND action = 'approve') AS approved,
         (SELECT count(*)::int FROM approvals WHERE decided_at >= $1 AND decided_at < $2 AND action = 'reject') AS rejected_by_human,
         (SELECT count(*)::int FROM publications WHERE published_at >= $1 AND published_at < $2 AND status = 'published') AS published,
         (SELECT count(*)::int FROM publications WHERE updated_at >= $1 AND updated_at < $2 AND status IN ('failed','retry_pending')) AS publications_failed`,
      params,
    );

    // ------------------------------------------------------------------ performance
    const performance = await ctx.db.query<{
      publication_id: string;
      topic: string;
      format: string;
      platform: string;
      hook: string;
      metrics: Record<string, number | null> | null;
    }>(
      `SELECT DISTINCT ON (p.id)
         p.id AS publication_id,
         ca.primary_topic AS topic,
         ci.format,
         p.platform,
         ci.draft->>'hook' AS hook,
         ae.metrics
       FROM publications p
       JOIN content_items ci ON ci.id = p.content_item_id
       JOIN content_atoms ca ON ca.id = ci.content_atom_id
       LEFT JOIN analytics_events ae ON ae.publication_id = p.id
       WHERE p.published_at >= $1 AND p.published_at < $2 AND p.status = 'published'
       ORDER BY p.id, ae.collected_at DESC NULLS LAST`,
      params,
    );

    const byTopic = new Map<string, GroupAccumulator>();
    const byFormat = new Map<string, GroupAccumulator>();
    const byPlatform = new Map<string, GroupAccumulator>();
    const byHook = new Map<string, GroupAccumulator>();

    for (const row of performance.rows) {
      const metrics = row.metrics ?? null;
      const impressions = (metrics?.['impressions'] ?? metrics?.['reach'] ?? null) as number | null;
      const engagementParts = [
        metrics?.['reactions'],
        metrics?.['comments'],
        metrics?.['shares'],
      ].filter((value): value is number => typeof value === 'number');
      const engagements =
        engagementParts.length > 0 ? engagementParts.reduce((a, b) => a + b, 0) : null;
      const measured = impressions !== null && impressions > 0 ? 1 : 0;

      for (const [map, key] of [
        [byTopic, row.topic],
        [byFormat, row.format],
        [byPlatform, row.platform],
        [byHook, classifyHook(row.hook ?? '')],
      ] as Array<[Map<string, GroupAccumulator>, string]>) {
        const group = map.get(key) ?? emptyGroup();
        group.published += 1;
        group.impressions = addKnown(group.impressions, impressions);
        group.engagements = addKnown(group.engagements, engagements);
        group.measured += measured;
        map.set(key, group);
      }
    }

    // ------------------------------------------------------------------ capture to publish
    const latency = await ctx.db.query<{ median_hours: string | null }>(
      `SELECT percentile_cont(0.5) WITHIN GROUP (
                ORDER BY EXTRACT(EPOCH FROM (p.published_at - le.captured_at)) / 3600.0
              ) AS median_hours
       FROM publications p
       JOIN learning_events le ON le.id = p.learning_event_id
       WHERE p.published_at >= $1 AND p.published_at < $2 AND p.status = 'published'`,
      params,
    );

    // ------------------------------------------------------------------ failures and backlog
    const failures = await ctx.db.query<{ kind: string; detail: string; count: number }>(
      `SELECT code AS kind, left(message, 300) AS detail, count(*)::int AS count
       FROM error_events
       WHERE occurred_at >= $1 AND occurred_at < $2
       GROUP BY code, left(message, 300)
       ORDER BY count DESC
       LIMIT 10`,
      params,
    );

    const backlog = await ctx.db.query<{
      content_item_id: string;
      format: string;
      waiting_hours: number;
      gate_verdict: string | null;
    }>(
      `SELECT id AS content_item_id,
              format,
              EXTRACT(EPOCH FROM (now() - updated_at)) / 3600.0 AS waiting_hours,
              quality_gate->>'verdict' AS gate_verdict
       FROM content_items
       WHERE status IN ('pending_approval', 'gated')
       ORDER BY updated_at
       LIMIT 20`,
    );

    // ------------------------------------------------------------------ signals
    const signals: WeeklyReportBody['signals'] = [];
    const rankable = summarize(byTopic).filter(
      (group) => group.measured >= MIN_MEASURED_FOR_SIGNAL && group.engagement_rate !== null,
    );

    if (rankable.length >= 2) {
      const sorted = [...rankable].sort(
        (a, b) => (b.engagement_rate ?? 0) - (a.engagement_rate ?? 0),
      );
      const best = sorted[0]!;
      const worst = sorted[sorted.length - 1]!;
      signals.push({
        kind: 'strongest',
        statement: `${best.key} posts drew the most engagement per impression this week`,
        basis: `${best.published} post(s), ${best.measured} with known impressions, rate ${best.engagement_rate}`,
        // Small samples are stated as low confidence rather than dressed up as a finding.
        confidence: best.measured >= 5 ? 'medium' : 'low',
      });
      signals.push({
        kind: 'weakest',
        statement: `${worst.key} posts drew the least engagement per impression this week`,
        basis: `${worst.published} post(s), ${worst.measured} with known impressions, rate ${worst.engagement_rate}`,
        confidence: worst.measured >= 5 ? 'medium' : 'low',
      });
    } else if (performance.rows.length > 0) {
      const measuredTotal = summarize(byTopic).reduce((sum, group) => sum + group.measured, 0);
      signals.push({
        kind: 'note',
        statement: 'not enough measured publications to compare topics this week',
        // Precise about *why*: groups may have metrics and still be too thin to rank, and saying
        // "no usable metrics" when some exist would be exactly the overclaiming this report avoids.
        basis:
          `${performance.rows.length} publication(s), ${measuredTotal} with known impressions; ` +
          `${rankable.length} topic group(s) reached the ${MIN_MEASURED_FOR_SIGNAL}-publication minimum`,
        confidence: 'low',
      });
    }

    const unmeasured = performance.rows.filter((row) => !row.metrics).length;
    if (unmeasured > 0) {
      signals.push({
        kind: 'note',
        statement: `${unmeasured} published item(s) have no analytics yet`,
        basis: 'metrics missing, which is different from metrics of zero',
        confidence: 'high',
      });
    }

    // ------------------------------------------------------------------ suggestions
    const opportunities = await ctx.db.query<{
      title: string;
      rationale: string;
      atom_title: string;
    }>(
      `SELECT ci.title, ci.rationale, ca.title AS atom_title
       FROM content_ideas ci
       JOIN content_atoms ca ON ca.id = ci.content_atom_id
       WHERE ci.status IN ('proposed', 'queued')
       ORDER BY ci.score DESC NULLS LAST, ci.created_at DESC
       LIMIT 5`,
    );

    const gaps = await ctx.db.query<{ topic: string; captured: number; published: number }>(
      `SELECT ca.primary_topic AS topic,
              count(*)::int AS captured,
              count(p.id)::int AS published
       FROM content_atoms ca
       LEFT JOIN content_items ci ON ci.content_atom_id = ca.id
       LEFT JOIN publications p ON p.content_item_id = ci.id AND p.status = 'published'
       -- $1 is cast explicitly: an untyped parameter cannot take part in interval arithmetic.
       WHERE ca.created_at >= $1::timestamptz - interval '28 days'
       GROUP BY ca.primary_topic
       ORDER BY (count(*) - count(p.id)) DESC
       LIMIT 5`,
      [window.start.toISOString()],
    );

    const body: WeeklyReportBody = {
      counts: counts.rows[0]!,
      capture_to_publish_hours:
        latency.rows[0]?.median_hours === null || latency.rows[0]?.median_hours === undefined
          ? null
          : Number(Number(latency.rows[0].median_hours).toFixed(2)),
      by_topic: summarize(byTopic),
      by_format: summarize(byFormat),
      by_platform: summarize(byPlatform),
      by_hook_class: summarize(byHook),
      signals,
      failures: failures.rows,
      approval_backlog: backlog.rows.map((row) => ({
        content_item_id: row.content_item_id,
        format: row.format,
        waiting_hours: Number(Number(row.waiting_hours).toFixed(1)),
        gate_verdict: row.gate_verdict,
      })),
      content_opportunities: opportunities.rows.map((row) => ({
        title: row.title,
        why: row.rationale.slice(0, 500),
        source: row.atom_title.slice(0, 200),
      })),
      learning_suggestions: gaps.rows
        .filter((row) => row.captured > row.published)
        .map((row) => ({
          topic: row.topic,
          why: `${row.captured} atom(s) captured in the last 4 weeks, ${row.published} published - unused material`,
        })),
    };

    const { report, inserted } = await weeklyReports.upsertWeeklyReport(ctx.db, {
      id: newId('weeklyReport'),
      period_start: window.start.toISOString(),
      period_end: window.end.toISOString(),
      timezone: timeZone,
      period_key: window.key,
      generator_version: REPORT_VERSION,
      body,
      correlation_id: correlationId,
    });

    ctx.logger.info(
      { period: window.key, inserted, published: body.counts.published, signals: signals.length },
      'weekly report generated',
    );
    await operations.finishWorkflowRun(ctx.db, runId, 'succeeded', {
      period: window.key,
      inserted,
    });

    return { ok: true, value: { report, inserted } };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown report failure';
    await operations.recordError(ctx.db, {
      workflow: 'weekly_report_v1',
      step: 'generate',
      kind: 'transient',
      code: 'E_REPORT_FAILED',
      message,
      correlationId,
      subjectId: window.key,
    });
    await operations.finishWorkflowRun(ctx.db, runId, 'failed', { code: 'E_REPORT_FAILED' });
    // Transient in both the stored row and the return value: a report is derived entirely from
    // stored data, so a failure here is a database or deployment problem worth retrying, and the
    // two records of it must agree.
    return { ok: false, error: transient('E_REPORT_FAILED', message) };
  }
};

/** Renders the report for Telegram. Plain text: it has to be readable on a phone. */
export const renderWeeklyReport = (report: WeeklyReport): string => {
  const { body } = report;
  const line = (label: string, value: string | number | null): string =>
    `${label}: ${value === null ? 'unknown' : value}`;

  const groups = (title: string, rows: WeeklyReportBody['by_topic']): string[] =>
    rows.length === 0
      ? []
      : [
          `\n${title}`,
          ...rows
            .slice(0, 5)
            .map(
              (row) =>
                `  ${row.key}: ${row.published} published, ` +
                `${row.impressions === null ? 'impressions unknown' : `${row.impressions} impressions`}` +
                `${row.engagement_rate === null ? '' : `, rate ${row.engagement_rate}`}`,
            ),
        ];

  return [
    `Weekly intelligence - ${report.period_key} (${report.timezone})`,
    '',
    line('Learning events', body.counts.learning_events),
    line('Duplicates', body.counts.learning_events_duplicate),
    line('Atoms', body.counts.content_atoms),
    line('Ideas', body.counts.content_ideas),
    line('Drafts', body.counts.drafts_generated),
    line('Gate rejected', body.counts.drafts_rejected_by_gate),
    line('Approved', body.counts.approved),
    line('Published', body.counts.published),
    line('Capture to publish (median hours)', body.capture_to_publish_hours),
    ...groups('By topic', body.by_topic),
    ...groups('By format', body.by_format),
    ...groups('By hook', body.by_hook_class),
    ...(body.signals.length > 0
      ? ['\nSignals', ...body.signals.map((s) => `  [${s.confidence}] ${s.statement} (${s.basis})`)]
      : []),
    ...(body.failures.length > 0
      ? [
          '\nFailures',
          ...body.failures.slice(0, 5).map((f) => `  ${f.kind} x${f.count}: ${f.detail}`),
        ]
      : []),
    ...(body.approval_backlog.length > 0
      ? [
          '\nAwaiting approval',
          ...body.approval_backlog
            .slice(0, 5)
            .map(
              (item) => `  ${item.content_item_id} (${item.format}) waiting ${item.waiting_hours}h`,
            ),
        ]
      : []),
    ...(body.content_opportunities.length > 0
      ? [
          '\nNext week - content',
          ...body.content_opportunities.map((o) => `  ${o.title} - ${o.why}`),
        ]
      : []),
    ...(body.learning_suggestions.length > 0
      ? [
          '\nNext week - learning',
          ...body.learning_suggestions.map((s) => `  ${s.topic}: ${s.why}`),
        ]
      : []),
    '',
    'These are suggestions. Nothing here schedules or publishes anything.',
  ].join('\n');
};

export const deliverWeeklyReport = async (
  ctx: ServiceContext,
  reportId: string,
  options: { telegram: TelegramAdapter; chatId: string },
): Promise<Result<WeeklyReport>> => {
  const report = await weeklyReports.findWeeklyReport(ctx.db, reportId);
  if (!report)
    return { ok: false, error: permanent('E_REPORT_NOT_FOUND', `no weekly report ${reportId}`) };

  if (report.status === 'delivered') return { ok: true, value: report };

  const sent = await options.telegram.send({
    chatId: options.chatId,
    text: renderWeeklyReport(report).slice(0, 4000),
    buttons: [],
    correlationId: report.correlation_id,
  });

  if (!sent.ok) {
    await weeklyReports.markReportDelivered(ctx.db, report.id, {
      delivered: false,
      error: `${sent.error.code}: ${sent.error.message}`,
    });
    await operations.recordError(ctx.db, {
      workflow: 'weekly_report_v1',
      step: 'deliver',
      kind: sent.error.kind,
      code: sent.error.code,
      message: sent.error.message,
      correlationId: report.correlation_id,
      subjectId: report.id,
    });
    return { ok: false, error: sent.error };
  }

  const delivered = await weeklyReports.markReportDelivered(ctx.db, report.id, { delivered: true });
  return { ok: true, value: delivered ?? report };
};

export const listWeeklyReports = async (ctx: ServiceContext, limit = 20) =>
  weeklyReports.listWeeklyReports(ctx.db, limit);

export const findWeeklyReport = async (ctx: ServiceContext, id: string) =>
  weeklyReports.findWeeklyReport(ctx.db, id);
