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

/** A detail the user picks is theirs, even when it matches what the mapper chose. */
export function claimDetail(
  described: Record<string, string>,
  category: string,
): Record<string, string> {
  const next = { ...described };
  delete next[category];
  return next;
}

/**
 * The instruct a design take sends. OmniVoice only accepts its tag set, so the
 * details are all it gets; free-form engines read the description as written,
 * with only the details the user picked appended as extra cues (#2389). Details
 * mapped from the description stay in the draft for OmniVoice but would only
 * repeat or contradict the description here.
 */
export function designInstruct(
  draft: Pick<DesignDraft, 'attrs' | 'description' | 'describedAttrs'>,
  vocabulary: InstructVocabulary,
): string {
  if (vocabulary !== 'freeform') return buildDesignInstruct(draft.attrs, '').instruct;
  const picked = Object.fromEntries(
    Object.entries(draft.attrs).map(([category, value]) => [
      category,
      draft.describedAttrs[category] === value ? 'Auto' : value,
    ]),
  );
  const tags = buildDesignInstruct(picked, '').instruct;
  return [draft.description.trim(), tags].filter(Boolean).join(', ');
}

/** Rebuild the Voice Design workspace from a generation-history recipe. */
export function designDraftFromTake(item: HistoryItem): DesignDraft {
  const instruct = item.instruct ?? '';
  const attrs = mergeDescribedAttrs(instructToVdStates(instruct));
  // A free-form take holds prose the tag set cannot express; rebuilding only
  // its tags would silently change the voice on the next render. Its tags are
  // still restored, as details derived from the description, for OmniVoice.
  const freeform = sanitizeInstruct(instruct).unsupported.length > 0;
  return {
    text: item.text,
    attrs,
    seed: item.seed ?? pickDesignSeed(false, null),
    profileId: item.profile_id,
    description: freeform ? instruct : '',
    describedAttrs: freeform ? attrs : {},
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
