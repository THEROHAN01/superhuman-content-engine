import type { ContentFormat } from './enums.js';

/**
 * Platform limits live here, never inside prompt text, so validation and generation cannot drift.
 * Values are the platform's documented limits for standard (non-premium) accounts; where a limit
 * is a style choice rather than a hard platform rule it is marked as such.
 */
export interface FormatConstraints {
  /** Hard character limit for a single unit (post, tweet, slide body). */
  maxChars: number;
  /** Style floor: content shorter than this is almost never worth publishing. */
  minChars: number;
  /** Number of units: thread tweets or carousel slides. 1 for single posts. */
  minUnits: number;
  maxUnits: number;
  /** Hook length budget (first line), style rule. */
  maxHookChars: number;
  hardLimitSource: 'platform' | 'style';
}

export const PLATFORM_CONSTRAINTS: Record<ContentFormat, FormatConstraints> = {
  // X standard accounts: 280 characters per post.
  x_post: {
    maxChars: 280,
    minChars: 80,
    minUnits: 1,
    maxUnits: 1,
    maxHookChars: 120,
    hardLimitSource: 'platform',
  },
  x_thread: {
    maxChars: 280,
    minChars: 60,
    minUnits: 3,
    maxUnits: 12,
    maxHookChars: 120,
    hardLimitSource: 'platform',
  },
  // LinkedIn post body limit is 3000 characters.
  linkedin_post: {
    maxChars: 3000,
    minChars: 400,
    minUnits: 1,
    maxUnits: 1,
    maxHookChars: 200,
    hardLimitSource: 'platform',
  },
  // Reel scripts are bounded by spoken duration, not by a platform character limit.
  reel_script: {
    maxChars: 1800,
    minChars: 300,
    minUnits: 3,
    maxUnits: 9,
    maxHookChars: 120,
    hardLimitSource: 'style',
  },
  // Carousel slides: 10 images max per Instagram post; text length is a legibility choice.
  carousel: {
    maxChars: 420,
    minChars: 40,
    minUnits: 5,
    maxUnits: 10,
    maxHookChars: 90,
    hardLimitSource: 'platform',
  },
};

export const constraintsFor = (format: ContentFormat): FormatConstraints =>
  PLATFORM_CONSTRAINTS[format];
