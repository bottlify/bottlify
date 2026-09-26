/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The INF file: sections of lines, each a key and comma-separated fields.
 *
 * The syntax is the one setupapi's own parser accepts, which is looser and
 * odder than any written description of it; what is implemented here is what
 * it is observed to do (Wine's setupapi parser tests pin it down):
 *
 * - `[name]` opens a section, the name everything up to the first `]` --
 *   spaces, `[`, `;` and control characters included -- and the rest of the
 *   line ignored; sections of the same name are one section.
 * - `;` outside quotes starts a comment. Ctrl-Z ends the file.
 * - `"` quotes, `""` inside quotes is one quote character, and a quote left
 *   open ends with its line. Quoting keeps `,`, `=`, `;` and spaces.
 * - A backslash followed by nothing but spaces, backslashes and a comment
 *   joins the next line on, the spaces around the join dropped.
 * - The first `=` before any `,` ends the key; a line with no `=` and one
 *   field has that field for its key too, and one with several has none.
 * - `%name%` is replaced by the [Strings] entry of that name, or by the
 *   directory a numeric DIRID stands for; `%%` is a percent sign, and a name
 *   nothing defines is left as it was.
 */

import { decodeAnsi } from '../kernel32/locale.js';

/** Errors an INF can fail to load with. */
export const INF_ERROR = Object.freeze({
    ERROR_EXPECTED_SECTION_NAME: 0xe0000000,
    ERROR_BAD_SECTION_NAME_LINE: 0xe0000001,
    ERROR_SECTION_NAME_TOO_LONG: 0xe0000002,
    ERROR_WRONG_INF_STYLE: 0xe0000100,
});

/** The styles an INF can have. */
export const INF_STYLE_OLDNT = 1;
export const INF_STYLE_WIN4 = 2;

/** The longest section name the loader accepts. */
const MAX_SECTION_NAME = 255;

/** A [Strings] value is kept to this many characters. */
const MAX_STRING_VALUE = 511;

/** The signatures that make an INF a Windows one. */
const WIN4_SIGNATURES = new Set(['$chicago$', '$windows nt$', '$windows 95$']);

/**
 * @typedef {Object} InfLine
 * @property {string | null} key     Substituted; null for a line with none.
 * @property {string[]} fields        The values after the key, substituted.
 * @property {number} line            Where it starts in the file, 1-based.
 *
 * @typedef {Object} InfSection
 * @property {string} name
 * @property {InfLine[]} lines
 *
 * @typedef {Object} Inf
 * @property {Map<string, InfSection>} sections  By lower-cased name, in file order.
 * @property {number} style  INF_STYLE_WIN4 or INF_STYLE_OLDNT.
 * @property {(name: string) => InfSection | null} section
 * @property {(section: string, key: string) => string | null} value
 *           A line's first field, found by key -- the [Version] entries.
 */

/** @param {string} c */
const isSpace = c=>c === ' ' || c === '\t' || c === '\r';

/**
 * The INF's text: UTF-16 after a byte-order mark, the ANSI page otherwise, as
 * the paths and names a program passes alongside it are read.
 *
 * @param {Uint8Array} bytes
 */
export function infText(bytes){
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe)
    {
        let text = '';
        for (let at = 2; at + 1 < bytes.length; at += 2)
        {
            text += String.fromCharCode(bytes[at] | (bytes[at + 1] << 8));
        }
        return text;
    }
    return decodeAnsi(bytes);
}

/**
 * Splits one entry into its key and fields, joining continued lines.
 *
 * @param {string[]} lines @param {number} index  The entry's first line.
 * @returns {{ key: string | null, fields: string[], next: number }}
 */
function tokenize(lines, index){
    /** @type {string[]} */
    const fields = [];
    /** @type {string | null} */
    let key = null;
    let sawComma = false;
    let current = '';
    let pending = '';
    let row = index;
    let line = lines[row];
    let at = 0;
    while (at < line.length && isSpace(line[at]))
    {
        at++;
    }
    for (;;)
    {
        if (at >= line.length)
        {
            break;
        }
        const c = line[at];
        if (c === ';')
        {
            break;
        }
        if (c === '"')
        {
            current += pending;
            pending = '';
            at++;
            // Quoted: everything literal up to the closing quote or the end
            // of the line, `""` standing for one quote.
            while (at < line.length)
            {
                if (line[at] === '"')
                {
                    if (line[at + 1] === '"')
                    {
                        current += '"';
                        at += 2;
                        continue;
                    }
                    break;
                }
                current += line[at++];
            }
            if (at >= line.length)
            {
                break;
            }
            at++;
            continue;
        }
        if (isSpace(c))
        {
            if (current !== '')
            {
                pending += c;
            }
            at++;
            continue;
        }
        if (c === '\\')
        {
            let ahead = at + 1;
            while (ahead < line.length && (isSpace(line[ahead]) || line[ahead] === '\\'))
            {
                ahead++;
            }
            if (ahead >= line.length || line[ahead] === ';')
            {
                pending = '';
                if (row + 1 >= lines.length)
                {
                    break;
                }
                line = lines[++row];
                at = 0;
                while (at < line.length && isSpace(line[at]))
                {
                    at++;
                }
                continue;
            }
        }
        if (c === '=' && key === null && !sawComma)
        {
            key = current;
            current = '';
            pending = '';
            at++;
            continue;
        }
        if (c === ',')
        {
            fields.push(current);
            sawComma = true;
            current = '';
            pending = '';
            at++;
            continue;
        }
        current += pending + c;
        pending = '';
        at++;
    }
    fields.push(current);
    return { key, fields, next: row + 1 };
}

/**
 * Parses an INF's text.
 *
 * @param {string} source
 * @param {{ dirid?: (id: number) => string | null }} [options]
 *        What a numeric `%N%` stands for, when no [Strings] entry says.
 * @returns {{ inf: Inf } | { error: number, line: number }}
 */
export function parseInf(source, options = {}){
    const end = source.indexOf('\x1a');
    const text = (end >= 0 ? source.slice(0, end) : source).replace(/\0/g, ' ');
    const lines = text.split('\n');

    /** @type {Map<string, InfSection>} */
    const sections = new Map();
    /** @type {{ key: string | null, fields: string[], line: number }[][]} */
    const raw = [];
    /** @type {InfSection | null} */
    let current = null;
    /** @type {number | null} */
    let firstStray = null;

    for (let row = 0; row < lines.length;)
    {
        const line = lines[row];
        let at = 0;
        while (at < line.length && isSpace(line[at]))
        {
            at++;
        }
        if (at >= line.length || line[at] === ';')
        {
            row++;
            continue;
        }
        if (line[at] === '[')
        {
            const close = line.indexOf(']', at + 1);
            if (close < 0)
            {
                return { error: INF_ERROR.ERROR_BAD_SECTION_NAME_LINE, line: row + 1 };
            }
            const name = line.slice(at + 1, close);
            if (name.length > MAX_SECTION_NAME)
            {
                return { error: INF_ERROR.ERROR_SECTION_NAME_TOO_LONG, line: row + 1 };
            }
            const lower = name.toLowerCase();
            current = sections.get(lower) ?? null;
            if (!current)
            {
                current = { name, lines: [] };
                sections.set(lower, current);
                raw.push([]);
            }
            row++;
            continue;
        }
        const entry = tokenize(lines, row);
        if (current)
        {
            raw[[...sections.values()].indexOf(current)].push(
                { key: entry.key, fields: entry.fields, line: row + 1 });
        }
        else
        {
            firstStray ??= row + 1;
        }
        row = entry.next;
    }

    /** @type {Map<string, string>} */
    const strings = new Map();
    const stringsAt = [...sections.keys()].indexOf('strings');
    if (stringsAt >= 0)
    {
        for (const entry of raw[stringsAt])
        {
            if (entry.key !== null)
            {
                strings.set(entry.key.toLowerCase(), entry.fields[0].slice(0, MAX_STRING_VALUE));
            }
        }
    }

    /** @param {string} value */
    const substitute = value=>{
        if (!value.includes('%'))
        {
            return value;
        }
        let out = '';
        for (let at = 0; at < value.length;)
        {
            const c = value[at];
            if (c !== '%')
            {
                out += c;
                at++;
                continue;
            }
            if (value[at + 1] === '%')
            {
                out += '%';
                at += 2;
                continue;
            }
            const close = value.indexOf('%', at + 1);
            if (close < 0)
            {
                out += value.slice(at);
                break;
            }
            const name = value.slice(at + 1, close);
            const known = strings.get(name.toLowerCase());
            if (known !== undefined)
            {
                out += known;
                at = close + 1;
                continue;
            }
            const directory = /^\d+$/.test(name) ? options.dirid?.(Number(name)) ?? null : null;
            if (directory !== null)
            {
                // A directory a DIRID stands for merges its trailing
                // separator with the one that follows it; a [Strings] value
                // is taken exactly as written.
                out += directory.endsWith('\\') && value[close + 1] === '\\'
                    ? directory.slice(0, -1) : directory;
                at = close + 1;
                continue;
            }
            out += value.slice(at, close + 1);
            at = close + 1;
        }
        return out;
    };

    let index = 0;
    for (const section of sections.values())
    {
        section.lines = raw[index++].map(entry=>{
            const fields = entry.fields.map(substitute);
            /** @type {string | null} */
            let key = entry.key === null ? null : substitute(entry.key);
            if (entry.key === null && fields.length === 1)
            {
                key = fields[0];
            }
            return { key, fields, line: entry.line };
        });
    }

    /** @param {string} name */
    const section = name=>sections.get(name.toLowerCase()) ?? null;
    /** @param {string} name @param {string} key */
    const value = (name, key)=>{
        const lower = key.toLowerCase();
        return section(name)?.lines.find(line=>line.key?.toLowerCase() === lower)?.fields[0]
            ?? null;
    };
    const signature = value('Version', 'Signature');
    const style = signature !== null && WIN4_SIGNATURES.has(signature.toLowerCase())
        ? INF_STYLE_WIN4 : INF_STYLE_OLDNT;
    // Lines before the first section are an error in a Windows INF, unless
    // the file has a [Strings] section. Whether the style is the one asked
    // for is the opener's question.
    if (style === INF_STYLE_WIN4 && firstStray !== null && stringsAt < 0)
    {
        return { error: INF_ERROR.ERROR_EXPECTED_SECTION_NAME, line: firstStray };
    }
    return { inf: { sections, style, section, value } };
}
