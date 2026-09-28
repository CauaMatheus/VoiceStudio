import type { HistoryItem, InstructVocabulary, Profile } from '@/lib/api/types';
import {
  applyVdState,
  buildDesignInstruct,
  instructToVdStates,
  mergeDescribedAttrs,
} from '@shared/utils/voiceInstruct';
import { pickDesignSeed } from '@shared/utils/seed';
export const STORAGE = 'voicestudio.design.v1';
export const DESIGN_DRAFT_EVENT = 'voicestudio:design-draft';

export interface DesignDraft {
  text: string;
  /** Effective details: the description mapping with the user's picks on top. */
  attrs: Record<string, string>;
  seed: number;
  profileId: string | null;
  /** What the user wrote; free-form engines receive it as written (#2389). */
  description: string;
  /** Details chosen explicitly; each holds until the description says otherwise. */
  picks: Record<string, DesignPick>;
  /** The details the current description maps to. */
  mapped: Record<string, string>;
}

export interface DesignPick {
  value: string;
  /** The description in effect when the detail was picked. */
  description: string;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function pickRecord(value: unknown): Record<string, DesignPick> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, DesignPick] =>
        typeof entry[1]?.value === 'string' && typeof entry[1]?.description === 'string',
    ),
  );
}

/** With no description behind them, every set detail was chosen explicitly. */
function explicitDetails(attrs: Record<string, string>): Record<string, DesignPick> {
  return Object.fromEntries(
    Object.entries(attrs)
      .filter(([, value]) => value !== 'Auto')
      .map(([category, value]) => [category, { value, description: '' }]),
  );
}

export function readDraft(): DesignDraft {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE) || '{}');
    const attrs = mergeDescribedAttrs(value.attrs);
    return {
      text: typeof value.text === 'string' ? value.text : '',
      attrs,
      seed: Number.isInteger(value.seed) ? value.seed : pickDesignSeed(false, null),
      profileId: typeof value.profileId === 'string' ? value.profileId : null,
      description: typeof value.description === 'string' ? value.description : '',
      // Drafts saved before descriptions were persisted only held picks.
      picks: value.picks === undefined ? explicitDetails(attrs) : pickRecord(value.picks),
      mapped: stringRecord(value.mapped),
    };
  } catch {
    return {
      text: '',
      attrs: mergeDescribedAttrs(),
      seed: pickDesignSeed(false, null),
      profileId: null,
      description: '',
      picks: {},
      mapped: {},
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
 * description belonged to the previous voice, so it is dropped: a free-form
 * engine would otherwise receive both as contradictory directions. The new
 * recipe's details are explicit choices.
 */
export function replaceRecipe(current: DesignDraft, recipe: Partial<DesignDraft>): DesignDraft {
  const next = { ...current, ...recipe, description: '', mapped: {} };
  return { ...next, picks: explicitDetails(next.attrs) };
}

/**
 * Apply the mapping of `described`, which the caller has checked is still the
 * current description. The most recent intent wins per detail: a pick holds
 * until the description changes what it says about that detail (or about its
 * exclusive counterpart). A pick made while `described` was already in effect
 * is newer than it, so a mapping that lands late never undoes it.
 */
export function applyDescription(
  current: DesignDraft,
  mapping: Record<string, string>,
  described: string,
): DesignDraft {
  const mapped = mergeDescribedAttrs(mapping);
  const restated = (category: string) => mapped[category] !== (current.mapped[category] ?? 'Auto');
  let attrs = mapped;
  const picks: Record<string, DesignPick> = {};
  for (const [category, pick] of Object.entries(current.picks)) {
    const older = pick.description !== described;
    if (older && restated(category)) continue;
    const { vdStates, clearedCategory } = applyVdState(attrs, category, pick.value);
    if (older && clearedCategory && restated(clearedCategory)) continue;
    attrs = vdStates;
    picks[category] = pick;
  }
  return { ...current, attrs, picks, mapped };
}

/** Record an explicit pick; one that clears an exclusive category drops that pick. */
export function pickDetail(
  current: DesignDraft,
  category: string,
  value: string,
): { draft: DesignDraft; clearedCategory: string | null } {
  const { vdStates, clearedCategory } = applyVdState(current.attrs, category, value);
  const picks = {
    ...current.picks,
    [category]: { value, description: current.description.trim() },
  };
  if (clearedCategory) delete picks[clearedCategory];
  return { draft: { ...current, attrs: vdStates, picks }, clearedCategory };
}

/**
 * The instruct a design take sends. OmniVoice only accepts its tag set, so the
 * effective details are all it gets. Free-form engines read the description as
 * written, with only the user's picks appended as extra cues: details mapped
 * from the description would repeat or contradict it (#2389).
 */
export function designInstruct(
  draft: Pick<DesignDraft, 'attrs' | 'description' | 'picks'>,
  vocabulary: InstructVocabulary,
): string {
  if (vocabulary !== 'freeform') return buildDesignInstruct(draft.attrs, '').instruct;
  const picked = Object.fromEntries(
    Object.entries(draft.picks).map(([category, pick]) => [category, pick.value]),
  );
  const tags = buildDesignInstruct(picked, '').instruct;
  return [draft.description.trim(), tags].filter(Boolean).join(', ');
}

/**
 * Rebuild the Voice Design workspace from a generation-history recipe. The
 * saved instruct comes back as the description, so a free-form engine
 * receives it unchanged, and its recognised tags as details, so OmniVoice
 * does too. History keeps only the combined instruct, so which of its tags
 * were picks is not recoverable.
 */
export function designDraftFromTake(item: HistoryItem): DesignDraft {
  const description = item.instruct ?? '';
  const mapped = mergeDescribedAttrs(instructToVdStates(description));
  return {
    text: item.text,
    attrs: mapped,
    seed: item.seed ?? pickDesignSeed(false, null),
    profileId: item.profile_id,
    description,
    picks: {},
    mapped,
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
