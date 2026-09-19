const choiceTokenStart = '{{choice.';
function walkModelChoiceTemplate(template, replace) {
    let result = '', cursor = 0;
    while (true) {
        const start = template.indexOf(choiceTokenStart, cursor);
        if (start < 0)
            return result + template.slice(cursor);
        const end = template.indexOf('}}', start + choiceTokenStart.length);
        if (end < 0)
            throw new Error(`Modelの選択肢テンプレートが閉じられていません: ${template.slice(start)}`);
        const token = template.slice(start, end + 2), name = template.slice(start + choiceTokenStart.length, end).trim();
        if (!name || name.includes('{') || name.includes('}'))
            throw new Error(`Modelの選択肢名が空、または不正です: ${token}`);
        result += template.slice(cursor, start) + replace(name, token);
        cursor = end + 2;
    }
}
export function modelChoiceTemplateNames(template) {
    const names = [];
    walkModelChoiceTemplate(template, name => { names.push(name); return ''; });
    return [...new Set(names)];
}
export function renderModelChoiceTemplate(template, selectedChoices) {
    return walkModelChoiceTemplate(template, name => {
        const value = selectedChoices[name];
        if (value === undefined)
            throw new Error(`Modelの選択肢「${name}」が選択されていません。`);
        return value;
    });
}
