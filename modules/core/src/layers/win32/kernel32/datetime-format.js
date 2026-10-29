/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The pictures GetDateFormat and GetTimeFormat render.
 *
 * A picture is letters and text. Text in single quotes is written as it
 * stands, two quotes in a row being one, and a quote left open runs to the
 * end. A date's letters are d, M, y and g, a time's h, H, m, s and t; any
 * other character, letters among them, is copied. A run of one letter is one
 * field, its length saying how it is written; a run longer than the longest
 * form is that form.
 *
 * Two of Windows' rules are not printf's. A month written out in full takes
 * its genitive form -- in a language that declines it -- when the nearest
 * date field before or after it is the day's number. And a time field a
 * flag leaves out takes the text before it with it, and the text after it up
 * to the first space.
 */

/** GetTimeFormat's flags. */
export const TIME_NOMINUTESORSECONDS = 0x1;
export const TIME_NOSECONDS = 0x2;
export const TIME_NOTIMEMARKER = 0x4;
export const TIME_FORCE24HOURFORMAT = 0x8;

/**
 * @typedef {Object} CalendarNames
 * @property {readonly string[]} days         Sunday first.
 * @property {readonly string[]} shortDays
 * @property {readonly string[]} months       January first.
 * @property {readonly string[]} shortMonths
 * @property {readonly string[] | null} genitive  The months as a date names them.
 * @property {string} am @property {string} pm @property {string} era
 */

/**
 * @typedef {Object} When
 * @property {number} year @property {number} month @property {number} day
 * @property {number} weekday  Sunday 0. @property {number} hour
 * @property {number} minute @property {number} second
 */

/**
 * @typedef {{ text: string } | { letter: string, count: number }} Item
 */

/**
 * A picture's fields and text.
 *
 * @param {string} picture @param {string} letters  The field letters.
 * @returns {Item[]}
 */
function parse(picture, letters){
    /** @type {Item[]} */
    const items = [];
    const text = (/** @type {string} */ value)=>{
        const last = items[items.length - 1];
        if (last !== undefined && 'text' in last)
        {
            last.text += value;
        }
        else
        {
            items.push({ text: value });
        }
    };
    for (let at = 0; at < picture.length;)
    {
        const character = picture[at];
        if (character === '\'')
        {
            at++;
            let quoted = '';
            while (at < picture.length)
            {
                if (picture[at] === '\'')
                {
                    if (picture[at + 1] === '\'')
                    {
                        quoted += '\'';
                        at += 2;
                        continue;
                    }
                    at++;
                    break;
                }
                quoted += picture[at++];
            }
            text(quoted);
            continue;
        }
        if (letters.includes(character))
        {
            let count = 1;
            while (picture[at + count] === character)
            {
                count++;
            }
            items.push({ letter: character, count });
            at += count;
            continue;
        }
        text(character);
        at++;
    }
    return items;
}

/** @param {number} value @param {number} width */
const pad = (value, width)=>String(value).padStart(width, '0');

/**
 * A date picture, rendered.
 *
 * @param {string} picture @param {When} when @param {CalendarNames} names
 */
export function renderDate(picture, when, names){
    const items = parse(picture, 'dMyg');
    /** @type {Item[]} */
    const fields = items.filter(item=>'letter' in item);
    /** Whether the nearest date field on either side of the item is the day's number. */
    const nearDay = (/** @type {Item} */ item)=>{
        const at = fields.indexOf(item);
        return [fields[at - 1], fields[at + 1]].some(field=>field !== undefined
            && 'letter' in field && field.letter === 'd' && field.count <= 2);
    };
    return items.map(item=>{
        if ('text' in item)
        {
            return item.text;
        }
        const { letter, count } = item;
        switch (letter)
        {
            case 'd':
                return count === 1 ? String(when.day) : count === 2 ? pad(when.day, 2)
                    : count === 3 ? names.shortDays[when.weekday] : names.days[when.weekday];
            case 'M':
                if (count >= 4)
                {
                    return names.genitive !== null && nearDay(item)
                        ? names.genitive[when.month - 1] : names.months[when.month - 1];
                }
                return count === 1 ? String(when.month) : count === 2 ? pad(when.month, 2)
                    : names.shortMonths[when.month - 1];
            case 'y':
                return count === 1 ? String(when.year % 100) : count === 2 ? pad(when.year % 100, 2)
                    : pad(when.year, 4);
            default:
                return names.era;
        }
    }).join('');
}

/**
 * A time picture, rendered, the fields its flags leave out taken out with
 * their text.
 *
 * @param {string} picture @param {When} when @param {CalendarNames} names
 * @param {number} flags
 */
export function renderTime(picture, when, names, flags){
    const items = parse(picture, 'hHmst');
    const dropped = (/** @type {Item} */ item)=>'letter' in item
        && ((item.letter === 's' && (flags & (TIME_NOSECONDS | TIME_NOMINUTESORSECONDS)) !== 0)
            || (item.letter === 'm' && (flags & TIME_NOMINUTESORSECONDS) !== 0)
            || (item.letter === 't' && (flags & TIME_NOTIMEMARKER) !== 0));
    /** @type {(string | null)[]} */
    const out = items.map(item=>('text' in item ? item.text : ''));
    items.forEach((item, at)=>{
        if (!dropped(item))
        {
            return;
        }
        if (at > 0 && 'text' in items[at - 1])
        {
            out[at - 1] = null;
        }
        const next = items[at + 1];
        if (next !== undefined && 'text' in next && out[at + 1] !== null)
        {
            const space = next.text.indexOf(' ');
            out[at + 1] = space === -1 ? null : next.text.slice(space);
        }
    });
    const twelve = when.hour % 12 === 0 ? 12 : when.hour % 12;
    const force24 = (flags & TIME_FORCE24HOURFORMAT) !== 0;
    const marker = when.hour < 12 ? names.am : names.pm;
    return items.map((item, at)=>{
        if ('text' in item)
        {
            return out[at] ?? '';
        }
        if (dropped(item))
        {
            return '';
        }
        const width = Math.min(item.count, 2);
        switch (item.letter)
        {
            case 'h':
                return pad(force24 ? when.hour : twelve, width);
            case 'H':
                return pad(when.hour, width);
            case 'm':
                return pad(when.minute, width);
            case 's':
                return pad(when.second, width);
            default:
                return width === 1 ? marker.slice(0, 1) : marker;
        }
    }).join('');
}
