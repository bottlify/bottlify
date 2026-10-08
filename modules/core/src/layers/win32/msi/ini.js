/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * An INI file as the IniFile and RemoveIniFile tables change it: a key set
 * or added only where it is missing, a tag added to or taken from a key's
 * comma-separated list, a key taken out. Sections and keys are matched
 * without regard to case, as the profile calls match them; the file keeps
 * the CRLF line ends Windows writes.
 */

/** IniFile and RemoveIniFile's Action column. */
export const INI_ACTION = Object.freeze({
    ADD_LINE: 0, CREATE_LINE: 1, REMOVE_LINE: 2, ADD_TAG: 3, REMOVE_TAG: 4,
});

/**
 * The file's lines, where a section starts and ends, and where a key is in it.
 *
 * @param {string} text @param {string} section @param {string} key
 */
function locate(text, section, key){
    const lines = text === '' ? [] : text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
    const wanted = `[${section.toLowerCase()}]`;
    const header = lines.findIndex(line=>line.trim().toLowerCase() === wanted);
    if (header < 0)
    {
        return { lines, header, end: lines.length, at: -1 };
    }
    let end = header + 1;
    while (end < lines.length && !lines[end].trim().startsWith('['))
    {
        end++;
    }
    let at = -1;
    for (let line = header + 1; line < end && at < 0; line++)
    {
        const equals = lines[line].indexOf('=');
        if (equals > 0 && lines[line].slice(0, equals).trim().toLowerCase() === key.toLowerCase())
        {
            at = line;
        }
    }
    return { lines, header, end, at };
}

/** @param {string[]} lines */
const joined = lines=>(lines.length === 0 ? '' : `${lines.join('\r\n')}\r\n`);

/**
 * The lines with one key taken out, and its section with it when that was
 * the section's last line -- a removal leaves no empty heading behind
 * (roadmap/decisions.md, A36).
 *
 * @param {string[]} lines @param {number} header @param {number} at
 */
const without = (lines, header, at)=>{
    lines.splice(at, 1);
    const rest = lines.slice(header + 1).findIndex(line=>line.trim().startsWith('['));
    const end = rest < 0 ? lines.length : header + 1 + rest;
    if (lines.slice(header + 1, end).every(line=>line.trim() === ''))
    {
        lines.splice(header, end - header);
    }
    return joined(lines);
};

/** @param {string} line the value after its key's `=` */
const valueOf = line=>line.slice(line.indexOf('=') + 1);

/** @param {string} value @returns {string[]} the tags of a comma-separated value */
const tagsOf = value=>value.split(',').map(tag=>tag.trim()).filter(tag=>tag !== '');

/**
 * The file with one key set: the section made if missing, the key replaced
 * where it is or added at the section's end.
 *
 * @param {string} text @param {string} section @param {string} key @param {string} value
 */
export function setIniValue(text, section, key, value){
    return editIni(text, section, key, value, INI_ACTION.ADD_LINE);
}

/**
 * The file as one IniFile or RemoveIniFile action leaves it.
 *
 * @param {string} text @param {string} section @param {string} key
 * @param {string} value @param {number} action  An INI_ACTION.
 * @returns {string}
 */
export function editIni(text, section, key, value, action){
    const { lines, header, end, at } = locate(text, section, key);
    const line = `${key}=`;
    switch (action)
    {
        case INI_ACTION.ADD_LINE:
        case INI_ACTION.CREATE_LINE:
            if (at >= 0)
            {
                if (action === INI_ACTION.ADD_LINE)
                {
                    lines[at] = `${line}${value}`;
                }
                return joined(lines);
            }
            if (header < 0)
            {
                lines.push(`[${section}]`, `${line}${value}`);
                return joined(lines);
            }
            lines.splice(end, 0, `${line}${value}`);
            return joined(lines);
        case INI_ACTION.ADD_TAG:
        {
            if (at < 0)
            {
                return editIni(text, section, key, value, INI_ACTION.ADD_LINE);
            }
            const tags = tagsOf(valueOf(lines[at]));
            if (!tags.some(tag=>tag.toLowerCase() === value.toLowerCase()))
            {
                tags.push(value);
            }
            lines[at] = `${line}${tags.join(',')}`;
            return joined(lines);
        }
        case INI_ACTION.REMOVE_LINE:
            return at >= 0 ? without(lines, header, at) : joined(lines);
        case INI_ACTION.REMOVE_TAG:
        {
            if (at < 0)
            {
                return joined(lines);
            }
            const tags = tagsOf(valueOf(lines[at]))
                .filter(tag=>tag.toLowerCase() !== value.toLowerCase());
            if (tags.length === 0)
            {
                return without(lines, header, at);
            }
            lines[at] = `${line}${tags.join(',')}`;
            return joined(lines);
        }
        default:
            return joined(lines);
    }
}

/**
 * What undoes an IniFile row's action when its component is removed: the
 * line a line action put there goes, a tag a tag action added comes out.
 *
 * @param {number} action @returns {number}
 */
export const undoIniAction = action=>(action === INI_ACTION.ADD_TAG ? INI_ACTION.REMOVE_TAG
    : INI_ACTION.REMOVE_LINE);
