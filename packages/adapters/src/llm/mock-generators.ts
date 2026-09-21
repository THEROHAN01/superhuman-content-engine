import type { LlmRequest } from './types.js';
import { extractField, extractNote, sentences } from './mock-knowledge.js';

/**
 * Deterministic format-native drafts for the mock provider.
 *
 * The point of these handlers is that the five formats come out genuinely *different* - different
 * structure, different unit counts, different emphasis - while all being built only from the
 * atom's own sentences. A mock that returned the same text five times would make the "formats are
 * not copy/paste variants" acceptance criterion meaningless.
 */
type Unit = { index: number; text: string; note: string | null };

const section = (body: string, label: string): string | null => {
  const match = new RegExp(`^${label}: (.+)$`, 'mi').exec(body);
  return match?.[1]?.trim() ?? null;
};

const clamp = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const boundary = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf(', '), cut.lastIndexOf(' '));
  return `${cut.slice(0, boundary > max * 0.5 ? boundary : max - 1).trimEnd()}...`.slice(0, max);
};

interface Material {
  problem: string;
  insight: string;
  principles: string;
  example: string | null;
  implementation: string | null;
  failure: string | null;
  model: string | null;
  personal: string | null;
  hook: string;
  angle: string;
}

const material = (request: LlmRequest): Material => {
  const body = extractNote(request.user);
  const insight = section(body, 'Core insight') ?? sentences(body)[0] ?? body;
  return {
    problem: section(body, 'Problem') ?? insight,
    insight,
    principles: section(body, 'First principles') ?? insight,
    example: section(body, 'Example'),
    implementation: section(body, 'Implementation'),
    failure: section(body, 'Failure mode'),
    model: section(body, 'Mental model'),
    personal: section(body, 'Personal observation'),
    hook: extractField(request.user, 'Suggested hook') ?? insight,
    angle: extractField(request.user, 'Idea angle') ?? 'insight',
  };
};

const unit = (index: number, text: string, max: number, note: string | null = null): Unit => ({
  index,
  text: clamp(text.trim(), max),
  note,
});

const normalizeKey = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * Clamps first, then drops repeats.
 *
 * Deduplicating before clamping is not enough: two different long sentences can truncate to the
 * same 280-character prefix, which would put the same post in a thread twice.
 */
const distinctUnits = (
  candidates: Array<string | null | undefined>,
  max: number,
  minimum: number,
  filler: string,
): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const text = clamp(candidate.trim(), max);
    const key = normalizeKey(text);
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }

  // The format needs a minimum number of units; pad from the strongest material rather than
  // inventing new claims, and number the padding so it never duplicates.
  let padding = 1;
  while (result.length < minimum) {
    const text = clamp(`${filler} (${padding})`, max);
    const key = normalizeKey(text);
    padding++;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }

  return result;
};

export const generatorMockHandlers = (): Record<string, (request: LlmRequest) => unknown> => ({
  /** One post: the mechanism, then the trade-off. */
  'x-post.v1': (request) => {
    const m = material(request);
    const text = [m.insight, m.principles].filter(Boolean).join('\n\n');
    return {
      hook: clamp(m.hook, 120),
      units: [unit(0, text, 280)],
      hashtags: [],
      call_to_action: null,
    };
  },

  /** A thread: failure or problem first, then mechanism, then the fix. */
  'x-thread.v1': (request) => {
    const m = material(request);
    const beats = distinctUnits(
      [m.failure ?? m.problem, m.insight, m.principles, m.implementation, m.example, m.model],
      280,
      3,
      m.insight,
    );

    return {
      hook: clamp(m.failure ?? m.hook, 120),
      units: beats.slice(0, 6).map((beat, index) => unit(index, beat, 280)),
      hashtags: [],
      call_to_action: null,
    };
  },

  /** One longer post: situation, mechanism, transferable principle. */
  'linkedin-post.v1': (request) => {
    const m = material(request);
    const paragraphs = [
      m.personal ?? m.problem,
      m.insight,
      m.principles,
      m.example ?? m.implementation ?? null,
      m.model ? `The general shape: ${m.model}` : null,
    ].filter((p): p is string => Boolean(p));

    return {
      hook: clamp(m.hook, 200),
      units: [unit(0, paragraphs.join('\n\n'), 3000)],
      hashtags: [],
      call_to_action: null,
    };
  },

  /** Time-coded spoken beats with on-screen notes. */
  'reel-script.v1': (request) => {
    const m = material(request);
    const times = ['0-3s', '3-10s', '10-20s', '20-30s'];
    const notes = [
      'hook on screen, large text',
      'show the failing setup',
      'diagram of the mechanism',
      'show the fix',
    ];
    const texts = distinctUnits(
      [m.failure ?? m.hook, m.problem, m.principles, m.implementation ?? m.insight],
      560,
      3,
      m.insight,
    );

    return {
      hook: clamp(m.failure ?? m.hook, 120),
      units: texts
        .slice(0, 4)
        .map((text, index) =>
          unit(
            index,
            `[${times[index] ?? '30-40s'}] ${text}`,
            600,
            notes[index] ?? 'supporting visual',
          ),
        ),
      hashtags: [],
      call_to_action: null,
    };
  },

  /** Slides: one idea each, readable alone. */
  'carousel.v1': (request) => {
    const m = material(request);
    const notes = [
      'title slide, minimal text',
      'the failure, illustrated',
      'mechanism diagram',
      'code or config snippet',
      'closing principle',
    ];
    const texts = distinctUnits(
      [m.problem, m.failure, m.principles, m.implementation ?? m.example, m.model ?? m.insight],
      420,
      5,
      m.insight,
    );

    return {
      hook: clamp(m.hook, 90),
      units: texts
        .slice(0, 5)
        .map((text, index) => unit(index, text, 420, notes[index] ?? 'supporting visual')),
      hashtags: [],
      call_to_action: null,
    };
  },

  'hook.v1': (request) => {
    const m = material(request);
    return {
      hooks: [m.failure ?? m.insight, m.problem, m.principles]
        .filter((h): h is string => Boolean(h))
        .map((h) => clamp(h, 120)),
    };
  },
});
