import type { Engine } from './harness.js';
import { request } from './harness.js';

/**
 * The documented end-to-end journey, as one function.
 *
 * Both the acceptance suite and the duplicate-execution suite drive exactly this path, so
 * "running it twice" means running the same code twice rather than an abbreviated imitation.
 */
export const NOTE = `Today I learned why refresh-token rotation matters. A long-lived static refresh token
cannot be distinguished from a stolen one, because both present the same credential. With
rotation each refresh issues a new token and invalidates its predecessor, so a replayed old token
proves theft and lets the server revoke the whole family. The trade-off is a rotation race when
two requests refresh at once.`;

/** Every format the build plan's first release must produce. */
export const FORMATS = ['x_post', 'x_thread', 'linkedin_post', 'reel_script', 'carousel'] as const;

export interface DraftRecord {
  id: string;
  format: string;
  platform: string;
  version: number;
  status: string;
  units: number;
  characters: number;
}

export interface GateRecord {
  content_item_id: string;
  verdict: string;
  score: number;
  status: string;
  gate_version: string;
  reasons: Array<{ code: string; severity: string }>;
}

export interface PathResult {
  learningEventId: string;
  atomId: string;
  ideaId: string;
  evidence: {
    evidence_status: string;
    synthetic_only: boolean;
    sources_total: number;
    sources: Array<{ provider: string; source_type: string; url: string }>;
  };
  classification: { kind: string; primary_topic: string; content_worthy: boolean };
  ideas: Array<{ id: string; angle: string; status: string; score: number }>;
  drafts: DraftRecord[];
  gates: GateRecord[];
  approvedId: string;
  approvedStatusAtDecision: string;
  rejectedId: string;
  regeneratedFrom: string;
  regeneratedId: string;
  publicationId: string;
  /** Status of the schedule call: 201 first time, 422 when the item has already gone out. */
  scheduleStatus: number;
  analyticsEventId: string;
  reportId: string;
  reportCounts: Record<string, number>;
}

/**
 * Drives the complete documented path. Returns every id it created so both the stage assertions
 * and the duplicate-execution suite can work from the same journey.
 */
export interface JourneyOptions {
  /**
   * Whether the human asks for a regeneration during this pass. A *replay* of the automated path
   * must not invent new human decisions, so the duplicate-execution suite turns this off.
   */
  regenerate?: boolean;
}

export const runFullPath = async (
  engine: Engine,
  note: string,
  externalId: string,
  options: JourneyOptions = {},
): Promise<PathResult> => {
  const wantsRegeneration = options.regenerate !== false;
  const { app, telegram } = engine;

  // 1-4. capture -> normalize -> classify -> dedupe (one call; the pipeline is one transaction
  // per event and reports each stage's outcome).
  const capture = await request<{ id: string; duplicate: boolean }>(
    app,
    'POST',
    '/capture',
    { text: note, source: 'telegram', external_id: externalId },
    [200, 201],
  );
  const learningEventId = capture.body.id;

  const processed = await request<{
    status: string;
    content_atom_id: string;
    duplicate_of: string | null;
    classification: { kind: string; primary_topic: string; content_worthy: boolean };
  }>(app, 'POST', `/learning-events/${learningEventId}/process`, {}, 200);
  const atomId = processed.body.content_atom_id;

  // 5-6. research enrichment, then the canonical atom body.
  const research = await request<PathResult['evidence']>(
    app,
    'POST',
    `/content-atoms/${atomId}/research`,
    {},
    200,
  );
  await request(app, 'POST', `/content-atoms/${atomId}/build`, {}, 200);

  // 7. ideation.
  const ideas = await request<{ ideas: PathResult['ideas'] }>(
    app,
    'POST',
    `/content-atoms/${atomId}/ideas`,
    { queue: 2 },
    200,
  );
  const ideaId = ideas.body.ideas[0]!.id;

  // 8-12. every platform-native format. On a replay nothing is generated again, so the live
  // drafts are read back from the idea: the same ids the first pass produced.
  await request<{ generated: DraftRecord[]; skipped: unknown[] }>(
    app,
    'POST',
    `/content-ideas/${ideaId}/generate`,
    { formats: [...FORMATS] },
    200,
  );

  const listed = await request<{
    items: Array<{
      id: string;
      format: string;
      platform: string;
      version: number;
      status: string;
      draft: { body: string; units: unknown[] };
    }>;
  }>(app, 'GET', `/content-ideas/${ideaId}/items`, undefined, 200);

  // The current draft for a format is its highest version that has not been superseded.
  const drafts: DraftRecord[] = FORMATS.map((format) => {
    const candidates = listed.body.items
      .filter((i) => i.format === format && i.status !== 'superseded')
      .sort((a, b) => b.version - a.version);
    const current = candidates[0];
    if (!current) throw new Error(`no live draft for format ${format}`);
    return {
      id: current.id,
      format: current.format,
      platform: current.platform,
      version: current.version,
      status: current.status,
      units: current.draft.units.length,
      characters: current.draft.body.length,
    };
  });

  // 13. quality gate on each draft.
  const gates: GateRecord[] = [];
  for (const draft of drafts) {
    const gate = await request<GateRecord>(app, 'POST', `/content-items/${draft.id}/gate`, {}, 200);
    gates.push(gate.body);
  }

  // 14-17. approval: the card goes out, then one approve (through the real Telegram callback
  // transport), one reject and one regenerate.
  const approvedId = drafts.find((d) => d.format === 'x_post')!.id;
  const rejectedId = drafts.find((d) => d.format === 'x_thread')!.id;
  const regeneratedFrom = drafts.find((d) => d.format === 'linkedin_post')!.id;

  // On a replay these items have already been decided, so the request is refused as out of state
  // (422) rather than sending a second card - which is exactly the behaviour under test.
  for (const id of [approvedId, rejectedId, ...(wantsRegeneration ? [regeneratedFrom] : [])]) {
    await request(app, 'POST', `/content-items/${id}/request-approval`, {}, [200, 422]);
  }

  // The approve decision is replayed as Telegram would deliver it: the button payload from the
  // card that was actually sent, through the webhook.
  const card = telegram.sent.find((c) => c.text.includes(approvedId));
  if (!card) throw new Error('no approval card was sent for the item under approval');
  const approveButton = card.buttons.flat().find((b) => b.label === 'Approve');
  if (!approveButton) throw new Error('the approval card carries no Approve button');

  const callback = await request<{ action: string; applied: boolean; status: string }>(
    app,
    'POST',
    '/webhooks/telegram',
    {
      update_id: Number(`${Date.now() % 1_000_000}`),
      callback_query: {
        id: `cbq-${approvedId}`,
        from: { id: 4242, username: 'rohan' },
        message: { message_id: 77, chat: { id: Number(card.chatId) } },
        data: approveButton.data,
      },
    },
    200,
  );

  await request(
    app,
    'POST',
    `/content-items/${rejectedId}/decide`,
    { action: 'reject', decided_by: 'rohan', note: 'thread repeats the post' },
    [200, 422],
  );

  const regenerate = wantsRegeneration
    ? await request<{ regenerated_item_id: string | null }>(
        app,
        'POST',
        `/content-items/${regeneratedFrom}/decide`,
        { action: 'regenerate', decided_by: 'rohan' },
        200,
      )
    : { body: { regenerated_item_id: null } };

  // 18-19. schedule the approved draft and confirm the slot went out. On a replay the item has
  // already gone out, and scheduling is refused (422 E_NOT_APPROVED) rather than queued a second
  // time - so the existing publication is read back instead.
  const scheduled = await request<{ publication_id?: string; error?: { code: string } }>(
    app,
    'POST',
    `/content-items/${approvedId}/schedule`,
    { scheduled_at: '2026-09-22T09:00:00.000Z' },
    [200, 201, 422],
  );

  let publicationId = scheduled.body.publication_id;
  if (!publicationId) {
    const existing = await request<{ publications: Array<{ id: string }> }>(
      app,
      'GET',
      `/content-items/${approvedId}/publications`,
      undefined,
      200,
    );
    publicationId = existing.body.publications[0]?.id;
    if (!publicationId) {
      throw new Error('scheduling was refused and no earlier publication exists');
    }
  }

  await request(app, 'POST', `/publications/${publicationId}/mark-published`, {}, [200, 422]);

  // 20. analytics.
  const analytics = await request<{ analytics_event_id: string }>(
    app,
    'POST',
    `/publications/${publicationId}/collect-analytics`,
    { window: '24h' },
    [200, 201],
  );

  // 21. weekly intelligence for the week that contains the publication.
  const report = await request<{ report_id: string; counts: Record<string, number> }>(
    app,
    'POST',
    '/reports/weekly',
    { at: '2026-09-25T09:00:00.000Z' },
    [200, 201],
  );

  return {
    learningEventId,
    atomId,
    ideaId,
    evidence: research.body,
    classification: processed.body.classification,
    ideas: ideas.body.ideas,
    drafts,
    gates,
    approvedId,
    approvedStatusAtDecision: callback.body.status,
    rejectedId,
    regeneratedFrom,
    regeneratedId: regenerate.body.regenerated_item_id ?? '',
    publicationId,
    scheduleStatus: scheduled.status,
    analyticsEventId: analytics.body.analytics_event_id,
    reportId: report.body.report_id,
    reportCounts: report.body.counts,
  };
};
