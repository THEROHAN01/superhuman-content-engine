import { atomV1 } from './atom.v1.js';
import { classifyV1 } from './classify.v1.js';

/**
 * Every shipped prompt version. Versions are immutable once committed; a change means a new file
 * and a new entry here (see .claude/skills/prompt-version).
 */
export const PROMPT_REGISTRY = {
  'classify.v1': classifyV1,
  'atom.v1': atomV1,
} as const;

export type PromptVersion = keyof typeof PROMPT_REGISTRY;

/** The version each stage uses today. Bumping this is a deliberate, reviewable change. */
export const DEFAULT_PROMPT_VERSIONS = {
  classify: 'classify.v1',
  atom: 'atom.v1',
} as const;
