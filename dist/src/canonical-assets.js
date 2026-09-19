export const journalSkillKeys = ['journal', 'journal-review'];
export const journalSkillNames = {
    journal: 'journal',
    'journal-review': 'journal-review',
};
export const journalSkillUseCases = {
    journal: false,
    'journal-review': true,
};
export function journalSkillKey(asset) {
    if (asset.kind !== 'skill')
        return undefined;
    const key = asset.metadata?.aaclUtility;
    return typeof key === 'string' && journalSkillKeys.includes(key) ? key : undefined;
}
