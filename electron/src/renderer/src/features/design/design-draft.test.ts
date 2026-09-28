import { beforeEach, describe, expect, it } from 'vitest';
import type { HistoryItem, Profile } from '@/lib/api/types';
import {
  designDraftFromTake,
  designInstruct,
  readDraft,
  replaceRecipe,
  restoreDesignProfile,
  STORAGE,
  withoutDescribedAttrs,
} from './design-draft';

const profile = {
  id: 'designed-voice',
  name: 'Narrator',
  kind: 'design',
  ref_audio_path: 'preview.wav',
  ref_text: null,
  instruct: 'female, low pitch',
  language: 'French',
  seed: 42,
  personality: null,
  vd_states: JSON.stringify({ Gender: 'male' }),
  created_at: 1,
  is_locked: false,
} satisfies Profile;

describe('designed voice drafts', () => {
  beforeEach(() => localStorage.clear());

  it('persists the selected profile identity with the draft', () => {
    localStorage.setItem(
      STORAGE,
      JSON.stringify({ text: 'Hello', attrs: { Gender: 'female' }, seed: 7, profileId: 'voice' }),
    );
    expect(readDraft()).toMatchObject({ text: 'Hello', seed: 7, profileId: 'voice' });
  });

  it('restores profile language, seed and a complete recipe without stale values', () => {
    const restored = restoreDesignProfile(profile, 9);
    expect(restored).toMatchObject({
      profileId: 'designed-voice',
      language: 'French',
      seed: 42,
      attrs: { Gender: 'male', Pitch: 'low pitch', Age: 'Auto' },
    });

    expect(
      restoreDesignProfile({ ...profile, vd_states: '{broken', seed: null, language: null }, 9),
    ).toMatchObject({
      language: 'Auto',
      seed: 9,
      attrs: { Gender: 'female', Pitch: 'low pitch' },
    });
  });
});

describe('designInstruct', () => {
  const attrs = { Gender: 'female', Age: 'elderly' };
  const description = ' raspy old female, scottish accent ';

  it('sends OmniVoice only its tag set', () => {
    expect(designInstruct(attrs, description, 'tags')).toBe('female, elderly');
  });

  it('sends a free-form engine the description as written (#2389)', () => {
    expect(designInstruct({}, description, 'freeform')).toBe('raspy old female, scottish accent');
    expect(designInstruct(attrs, description, 'freeform')).toBe(
      'raspy old female, scottish accent, female, elderly',
    );
    expect(designInstruct(attrs, '  ', 'freeform')).toBe('female, elderly');
  });
});

describe('free-form design drafts (#2389)', () => {
  const take = {
    id: 'take',
    text: 'Hello',
    mode: 'design',
    language: null,
    instruct: 'raspy old female, scottish accent',
    profile_id: null,
    audio_path: 'take.wav',
    duration_seconds: 1,
    generation_time: 1,
    seed: 3,
    starred: null,
    created_at: 1,
  } satisfies HistoryItem;

  it('restores a free-form take as its description instead of its tags', () => {
    expect(designDraftFromTake(take)).toMatchObject({
      description: 'raspy old female, scottish accent',
      attrs: { Gender: 'Auto', Age: 'Auto' },
    });
    expect(designDraftFromTake({ ...take, instruct: 'female, elderly' })).toMatchObject({
      description: '',
      attrs: { Gender: 'female', Age: 'elderly' },
    });
  });

  it('drops the previous description when the recipe is replaced', () => {
    const draft = { ...readDraft(), description: 'raspy', describedAttrs: { Gender: 'female' } };
    expect(replaceRecipe(draft, { attrs: { Gender: 'male' } })).toMatchObject({
      description: '',
      describedAttrs: {},
      attrs: { Gender: 'male' },
    });
  });

  it('keeps explicit picks and drops details mapped from the description', () => {
    const draft = {
      ...readDraft(),
      attrs: { ...readDraft().attrs, Gender: 'female', Age: 'elderly', Pitch: 'low pitch' },
      describedAttrs: { Gender: 'female', Age: 'elderly', Pitch: 'Auto' },
    };
    expect(withoutDescribedAttrs(draft)).toMatchObject({
      attrs: { Gender: 'Auto', Age: 'Auto', Pitch: 'low pitch' },
      describedAttrs: {},
    });
    const clean = { ...draft, describedAttrs: {} };
    expect(withoutDescribedAttrs(clean)).toBe(clean);
  });

  it('reads drafts saved before descriptions were persisted', () => {
    localStorage.setItem(STORAGE, JSON.stringify({ text: 'Hi', describedAttrs: ['bad'] }));
    expect(readDraft()).toMatchObject({ description: '', describedAttrs: {} });
  });
});
