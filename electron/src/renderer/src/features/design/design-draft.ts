import { sanitizeInstruct } from '@/lib/api/generate';
import type { HistoryItem, InstructVocabulary, Profile } from '@/lib/api/types';
import {
  buildDesignInstruct,
  instructToVdStates,
  mergeDescribedAttrs,
} from '@shared/utils/voiceInstruct';
import { pickDesignSeed } from '@shared/utils/seed';
export const STORAGE = 'voicestudio.design.v1';
export const DESIGN_DRAFT_EVENT = 'voicestudio:design-draft';

export interface DesignDraft {
  text: string;
  attrs: Record<string, string>;
  seed: number;
  profileId: string | null;
  /** What the user wrote; free-form engines receive it as written (#2389). */
  description: string;
  /** Details the description mapper filled in, kept apart from explicit picks. */
  describedAttrs: Record<string, string>;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

export function readDraft(): DesignDraft {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE) || '{}');
    return {
      text: typeof value.text === 'string' ? value.text : '',
      attrs: mergeDescribedAttrs(value.attrs),
      seed: Number.isInteger(value.seed) ? value.seed : pickDesignSeed(false, null),
      profileId: typeof value.profileId === 'string' ? value.profileId : null,
      description: typeof value.description === 'string' ? value.description : '',
      describedAttrs: stringRecord(value.describedAttrs),
    };
  } catch {
    return {
      text: '',
      attrs: mergeDescribedAttrs(),
      seed: pickDesignSeed(false, null),
      profileId: null,
      description: '',
      describedAttrs: {},
    };
  }
}

export function writeDraft(draft: DesignDraft) {
  try {
    localStorage.setItem(STORAGE, JSON.stringify(draft));
  } catch {
    /* The mounted workspace can still receive the in-memory draft. */
  }
  window.dispatchEvent(new CustomEvent<DesignDraft>(DESIGN_DRAFT_EVENT, { detail: draft }));
}

/**
 * Replace the design recipe (saved profile, preset, personality or demo). The
 * description belonged to the previous voice, so it is dropped too: a
 * free-form engine would otherwise receive both as contradictory directions.
 */
export function replaceRecipe(current: DesignDraft, recipe: Partial<DesignDraft>): DesignDraft {
  return { ...current, description: '', describedAttrs: {}, ...recipe };
}

/**
 * Drop the details the mapper derived from a description, keeping explicit
 * picks. Free-form engines read the description itself, so re-sending its
 * tag mapping would repeat or contradict it.
 */
export function withoutDescribedAttrs(draft: DesignDraft): DesignDraft {
  const described = Object.entries(draft.describedAttrs);
  if (!described.length) return draft;
  const attrs = { ...draft.attrs };
  for (const [category, value] of described) {
    if (attrs[category] === value) attrs[category] = 'Auto';
  }
  return { ...draft, attrs: mergeDescribedAttrs(attrs), describedAttrs: {} };
}

/**
 * The instruct a design take sends. OmniVoice only accepts its tag set, so the
 * picked details are all it gets; free-form engines read the description as
 * written, with any picked details appended as extra cues (#2389).
 */
export function designInstruct(
  attrs: Record<string, string>,
  description: string,
  vocabulary: InstructVocabulary,
): string {
  const tags = buildDesignInstruct(attrs, '').instruct;
  if (vocabulary !== 'freeform') return tags;
  return [description.trim(), tags].filter(Boolean).join(', ');
}

/** Rebuild the Voice Design workspace from a generation-history recipe. */
export function designDraftFromTake(item: HistoryItem): DesignDraft {
  const instruct = item.instruct ?? '';
  // A free-form take holds prose the tag set cannot express; rebuilding only
  // its tags would silently change the voice on the next render.
  const freeform = sanitizeInstruct(instruct).unsupported.length > 0;
  return {
    text: item.text,
    attrs: mergeDescribedAttrs(freeform ? {} : instructToVdStates(instruct)),
    seed: item.seed ?? pickDesignSeed(false, null),
    profileId: item.profile_id,
    description: freeform ? instruct : '',
    describedAttrs: {},
  };
}

/** Restore a saved design recipe without leaking values from the previous voice. */
export function restoreDesignProfile(
  profile: Profile,
  fallbackSeed: number,
): Pick<DesignDraft, 'attrs' | 'seed' | 'profileId'> & { language: string } {
  const editedAttrs = instructToVdStates(profile.instruct ?? '');
  let attrs = editedAttrs;
  if (profile.vd_states) {
    try {
      const parsed = JSON.parse(profile.vd_states);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // vd_states is the saved source of truth for explicit controls. Keep
        // any values that are only represented in the descriptive prompt.
        attrs = { ...editedAttrs, ...(parsed as Record<string, string>) };
      }
    } catch {
      /* The complete instruct-derived fallback remains usable. */
    }
  }
  return {
    attrs: mergeDescribedAttrs(attrs),
    seed: profile.seed ?? fallbackSeed,
    profileId: profile.id,
    language: profile.language || 'Auto',
  };
}
