export const journalSkillKeys = ['journal', 'journal-review'] as const;
export type JournalSkillKey = typeof journalSkillKeys[number];

export const journalSkillNames: Record<JournalSkillKey, string> = {
  journal: 'journal',
  'journal-review': 'journal-review',
};

export const journalSkillUseCases: Record<JournalSkillKey, boolean> = {
  journal: false,
  'journal-review': true,
};

export function journalSkillKey(asset: { kind: string; metadata?: Record<string, unknown> }): JournalSkillKey | undefined {
  if (asset.kind !== 'skill') return undefined;
  const key = asset.metadata?.aaclUtility;
  return typeof key === 'string' && (journalSkillKeys as readonly string[]).includes(key) ? key as JournalSkillKey : undefined;
}
