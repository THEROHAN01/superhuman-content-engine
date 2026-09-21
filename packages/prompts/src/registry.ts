import { atomV1 } from './atom.v1.js';
import { ideationV1 } from './ideation.v1.js';
import {
  carouselV1,
  hookV1,
  linkedinPostV1,
  reelScriptV1,
  xPostV1,
  xThreadV1,
} from './generate.v1.js';
import { classifyV1 } from './classify.v1.js';

/**
 * Every shipped prompt version. Versions are immutable once committed; a change means a new file
 * and a new entry here (see .claude/skills/prompt-version).
 */
export const PROMPT_REGISTRY = {
  'classify.v1': classifyV1,
  'atom.v1': atomV1,
  'ideation.v1': ideationV1,
  'x-post.v1': xPostV1,
  'x-thread.v1': xThreadV1,
  'linkedin-post.v1': linkedinPostV1,
  'reel-script.v1': reelScriptV1,
  'carousel.v1': carouselV1,
  'hook.v1': hookV1,
} as const;

export type PromptVersion = keyof typeof PROMPT_REGISTRY;

/** The version each stage uses today. Bumping this is a deliberate, reviewable change. */
export const DEFAULT_PROMPT_VERSIONS = {
  classify: 'classify.v1',
  atom: 'atom.v1',
  ideation: 'ideation.v1',
  x_post: 'x-post.v1',
  x_thread: 'x-thread.v1',
  linkedin_post: 'linkedin-post.v1',
  reel_script: 'reel-script.v1',
  carousel: 'carousel.v1',
} as const;
