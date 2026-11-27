/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The code pages beyond the machine's own ANSI and OEM ones (`locale.js`):
 * other Windows ANSI pages, a few OEM, Mac and ISO ones, and the four East
 * Asian double-byte pages.
 *
 * No table ships for them. Every one is an encoding the platform's
 * TextDecoder already carries (the WHATWG Encoding Standard's, which for
 * these are the Windows pages: its shift_jis is code page 932, gbk 936, its
 * euc-kr the unified Hangul code 949), so a page is read out of the decoder
 * the first time a program names it -- each byte, and for a lead byte each
 * pair -- and the reverse table is built from that on the first encode, both
 * once for the run (`codePages`). A platform without one of these decoders
 * does not carry that page.
 *
 * What the pages do beyond their tables is Windows': a lead byte whose trail
 * is not one -- or that ends the input -- is the default character and the
 * byte after it is read again on its own; a byte the page leaves undefined is
 * the default character too, and either fails a conversion asked for with
 * MB_ERR_INVALID_CHARS. A character the page lacks is written as its best
 * fit, the letter it decomposes to when the page has that, unless
 * WC_NO_BEST_FIT_CHARS forbids it; otherwise the default character.
 */

import { decoderFor } from '../../../system/text.js';

/** @typedef {ReturnType<typeof decoderFor>} Decoder */

/** Windows' code page identifiers and the decoder that reads each. */
const DECODERS = new Map([
    [874, 'windows-874'], [1250, 'windows-1250'], [1251, 'windows-1251'],
    [1253, 'windows-1253'], [1254, 'windows-1254'], [1255, 'windows-1255'],
    [1256, 'windows-1256'], [1257, 'windows-1257'], [1258, 'windows-1258'],
    [866, 'ibm866'], [20866, 'koi8-r'], [21866, 'koi8-u'], [10000, 'macintosh'],
    [10007, 'x-mac-cyrillic'], [28592, 'iso-8859-2'], [28593, 'iso-8859-3'],
    [28594, 'iso-8859-4'], [28595, 'iso-8859-5'], [28596, 'iso-8859-6'],
    [28597, 'iso-8859-7'], [28598, 'iso-8859-8'], [28603, 'iso-8859-13'],
    [28605, 'iso-8859-15'], [932, 'shift_jis'], [936, 'gbk'], [949, 'euc-kr'],
    [950, 'big5'],
]);

/** GetCPInfoEx's CodePageName for each. */
const NAMES = new Map([
    [874, '874   (ANSI/OEM - Thai)'],
    [1250, '1250  (ANSI - Central Europe)'],
    [1251, '1251  (ANSI - Cyrillic)'],
    [1253, '1253  (ANSI - Greek)'],
    [1254, '1254  (ANSI - Turkish)'],
    [1255, '1255  (ANSI - Hebrew)'],
    [1256, '1256  (ANSI - Arabic)'],
    [1257, '1257  (ANSI - Baltic)'],
    [1258, '1258  (ANSI/OEM - Viet Nam)'],
    [866, '866   (OEM - Russian)'],
    [20866, '20866 (Russian - KOI8)'],
    [21866, '21866 (Ukrainian - KOI8-U)'],
    [10000, '10000 (MAC - Roman)'],
    [10007, '10007 (MAC - Cyrillic)'],
    [28592, '28592 (ISO 8859-2 Central Europe)'],
    [28593, '28593 (ISO 8859-3 Latin 3)'],
    [28594, '28594 (ISO 8859-4 Baltic)'],
    [28595, '28595 (ISO 8859-5 Cyrillic)'],
    [28596, '28596 (ISO 8859-6 Arabic)'],
    [28597, '28597 (ISO 8859-7 Greek)'],
    [28598, '28598 (ISO 8859-8 Hebrew: Visual Ordering)'],
    [28603, '28603 (ISO 8859-13 Estonian)'],
    [28605, '28605 (ISO 8859-15 Latin 9)'],
    [932, '932   (ANSI/OEM - Japanese Shift-JIS)'],
    [936, '936   (ANSI/OEM - Simplified Chinese GBK)'],
    [949, '949   (ANSI/OEM - Korean)'],
    [950, '950   (ANSI/OEM - Traditional Chinese Big5)'],
]);

/**
 * The lead bytes of the double-byte pages, as CPINFO's LeadByte ranges. They
 * are the page's whatever the platform's decoder makes of each pair: one
 * that lacks a pair reads it as the default character.
 */
const LEAD_RANGES = new Map([
    [932, [0x81, 0x9f, 0xe0, 0xfc]], [936, [0x81, 0xfe]], [949, [0x81, 0xfe]], [950, [0x81, 0xfe]],
]);

/**
 * Decoders do not agree on a page's holes: the platform's may fill one with
 * a private-use character, or with the ISO page's letter, where Windows has
 * nothing. A single byte read as private use is taken as a hole, and so are
 * these (Microsoft's own tables leave them undefined); a hole in 0x80..0x9f
 * is the C1 control of that number, as Windows reads it, whatever the
 * decoder says.
 */
const HOLES = new Map([[1253, [0xaa]]]);

/** @param {number} code */
const isPrivateUse = code=>code >= 0xe000 && code <= 0xf8ff;

/** A byte's entry when it is no character of its own: undefined, or a lead byte. */
const UNDEFINED = 0xffff;
const LEAD = 0xfffe;
/** The default character, as a byte and as a character. */
const DEFAULT = 0x3f;
/** WideCharToMultiByte's flag against best fit. */
const WC_NO_BEST_FIT_CHARS = 0x400;

/**
 * @typedef {Object} CodePage
 * @property {number} id
 * @property {string} name                 GetCPInfoEx's CodePageName.
 * @property {number} maxCharSize          1, or 2 for a double-byte page.
 * @property {number[]} leadRanges         CPINFO's LeadByte: first, last, ...
 * @property {(byte: number) => boolean} isLead
 * @property {(bytes: Uint8Array, strict: boolean) => string | null} decode
 *           Null when `strict` and a byte is no character.
 * @property {(text: string, flags: number, fallback: number[] | null) => Encoded} encode
 */

/**
 * @typedef {Object} Encoded
 * @property {Uint8Array} bytes
 * @property {(room: number) => number} fit   How much of a buffer of this
 *           size is written: never half a double-byte character.
 * @property {(written: number) => boolean} usedDefault  Whether the default
 *           character is among the first `written` bytes.
 */

/**
 * The code pages this machine carries, their tables the run's
 * (`run-tables.js`): a page's bytes read out of the decoder, each byte's
 * character and for a double-byte page each pair's (`codepage/<id>`), made the
 * first time a program names the page; and the reverse, a code unit's bytes
 * (`codepage/<id>/reverse`), made from that on the first encode.
 *
 * @param {import('../common/run-tables.js').RunTables} tables
 * @returns {(id: number) => CodePage | null}  a page, or null where it is not carried
 */
export function codePages(tables){
    /** @type {Map<number, CodePage | null>} */
    const pages = new Map();
    return id=>{
        if (!pages.has(id))
        {
            pages.set(id, build(id, tables));
        }
        return /** @type {CodePage | null} */ (pages.get(id));
    };
}

/** @param {number} id @returns {Decoder | null} */
const decoderOf = id=>{
    const label = DECODERS.get(id);
    if (label === undefined)
    {
        return null;
    }
    try
    {
        return decoderFor(label, { fatal: true });
    }
    catch (e){
        void e;
        return null;
    }
};

/**
 * A page's forward table: each byte's character, LEAD for a lead byte, at
 * 0..0xff; for a double-byte page each pair's at 0x100 + (lead << 8 | trail).
 * UNDEFINED where there is none.
 *
 * @param {number} id @param {Decoder} decoder @param {Set<number>} leads
 */
function forwardTable(id, decoder, leads){
    const table = new Uint16Array(leads.size === 0 ? 0x100 : 0x10100).fill(UNDEFINED);
    const pairs = table.subarray(0x100);
    const one = new Uint8Array(1);
    const two = new Uint8Array(2);
    /** @param {Uint8Array} bytes */
    const read = bytes=>{
        try
        {
            const text = decoder.decode(bytes);
            return text.length === 1 ? text.charCodeAt(0) : UNDEFINED;
        }
        catch (e){
            void e;
            return UNDEFINED;
        }
    };
    for (let byte = 0; byte < 256; byte++)
    {
        if (leads.has(byte))
        {
            table[byte] = LEAD;
            two[0] = byte;
            for (let trail = 0x40; trail < 0x100; trail++)
            {
                two[1] = trail;
                pairs[byte << 8 | trail] = read(two);
            }
            continue;
        }
        one[0] = byte;
        const code = read(one);
        table[byte] = isPrivateUse(code) || HOLES.get(id)?.includes(byte) ? UNDEFINED
            : code === UNDEFINED && byte >= 0x80 && byte <= 0x9f ? byte : code;
    }
    return table;
}

/**
 * A page's reverse table from its forward one: a code unit's byte, or its
 * lead << 8 | trail, the first that reads as it; UNDEFINED where none does.
 *
 * @param {Uint16Array} forward
 */
function reverseTable(forward){
    const table = new Uint16Array(0x10000).fill(UNDEFINED);
    for (let byte = 0; byte < 256; byte++)
    {
        const code = forward[byte];
        if (code < LEAD && table[code] === UNDEFINED)
        {
            table[code] = byte;
        }
    }
    for (let pair = 0; pair < forward.length - 0x100; pair++)
    {
        const code = forward[0x100 + pair];
        if (code < LEAD && table[code] === UNDEFINED)
        {
            table[code] = pair;
        }
    }
    return table;
}

/**
 * @param {number} id @param {import('../common/run-tables.js').RunTables} tables
 * @returns {CodePage | null}
 */
function build(id, tables){
    if (decoderOf(id) === null)
    {
        return null;
    }
    const leadRanges = LEAD_RANGES.get(id) ?? [];
    const leads = new Set();
    for (let at = 0; at < leadRanges.length; at += 2)
    {
        for (let byte = leadRanges[at]; byte <= leadRanges[at + 1]; byte++)
        {
            leads.add(byte);
        }
    }
    const forward = tables.table(`codepage/${id}`, Uint16Array,
        ()=>forwardTable(id, /** @type {Decoder} */ (decoderOf(id)), leads));
    const reverse = tables.table(`codepage/${id}/reverse`, Uint16Array,
        ()=>forward.read(reverseTable));
    const double = leads.size !== 0;

    /** @type {(text: string, flags: number, fallback: number[] | null) => Encoded} */
    const encode = (text, flags, fallback)=>reverse.read(table=>{
        const substitute = fallback ?? [DEFAULT];
        /** @type {number[]} */
        const out = [];
        /** Offsets inside a double-byte character. @type {Set<number>} */
        const inside = new Set();
        let firstDefault = -1;
        for (let at = 0; at < text.length; at++)
        {
            const code = text.charCodeAt(at);
            let mapped = table[code];
            if (mapped === UNDEFINED && (flags & WC_NO_BEST_FIT_CHARS) === 0)
            {
                mapped = bestFit(text[at], unit=>table[unit]) ?? UNDEFINED;
            }
            const sequence = mapped === UNDEFINED ? substitute
                : mapped > 0xff ? [mapped >> 8, mapped & 0xff] : [mapped];
            if (mapped === UNDEFINED && firstDefault === -1)
            {
                firstDefault = out.length;
            }
            if (sequence.length === 2)
            {
                inside.add(out.length + 1);
            }
            out.push(...sequence);
        }
        return {
            bytes: Uint8Array.from(out),
            fit: (/** @type {number} */ room)=>(inside.has(room) ? room - 1 : room),
            usedDefault: (/** @type {number} */ written)=>firstDefault !== -1 && firstDefault < written,
        };
    });

    return {
        id,
        name: NAMES.get(id) ?? String(id),
        maxCharSize: double ? 2 : 1,
        leadRanges,
        isLead: byte=>leads.has(byte & 0xff),
        decode: (bytes, strict)=>forward.read(table=>{
            /** @type {number[]} */
            const units = [];
            for (let at = 0; at < bytes.length; at++)
            {
                const code = table[bytes[at]];
                if (code === LEAD)
                {
                    const pair = at + 1 < bytes.length
                        ? table[0x100 + (bytes[at] << 8 | bytes[at + 1])] : UNDEFINED;
                    if (pair !== UNDEFINED)
                    {
                        units.push(pair);
                        at++;
                        continue;
                    }
                }
                if (code >= LEAD)
                {
                    if (strict)
                    {
                        return null;
                    }
                    units.push(DEFAULT);
                    continue;
                }
                units.push(code);
            }
            let text = '';
            for (let at = 0; at < units.length; at += 4096)
            {
                text += String.fromCharCode(...units.slice(at, at + 4096));
            }
            return text;
        }),
        encode,
    };
}

/**
 * The spacing characters Windows' best fit writes for a combining accent, or
 * for a character with no decomposition to go by, where neither the rules
 * below nor a spacing form's own decomposition gives them: the tilde is the
 * ASCII one, though the spacing tilde (U+02DC) decomposes to it too, and the
 * ring is the degree sign (Wine's locale.c test_FoldStringA pins each).
 *
 * @type {ReadonlyMap<number, number>}
 */
const SPACING_FORMS = new Map([
    [0x0300, 0x60], [0x0302, 0x5e], [0x0303, 0x7e], [0x030a, 0xb0], [0x2044, 0x2f],
]);

/** A combining character or a space and one: a spacing accent's decomposition. */
const SPACED_MARK = /^ ?\p{M}$/u;

/**
 * Every character of the basic plane whose compatibility decomposition is a
 * combining mark (with a space before it, a spacing accent) or a single other
 * character: the forms a character with none in the page can be written as.
 * Built once, when first asked.
 *
 * @type {Map<string, number[]> | null}
 */
let compatibilityForms = null;
/** @param {string} character */
const formsOf = character=>{
    if (!compatibilityForms)
    {
        compatibilityForms = new Map();
        for (let code = 0xa0; code < 0x10000; code++)
        {
            if (code >= 0xd800 && code < 0xe000)
            {
                continue;
            }
            const decomposed = String.fromCharCode(code).normalize('NFKD');
            const key = SPACED_MARK.test(decomposed) ? decomposed.trim()
                : decomposed.length === 1 && decomposed.charCodeAt(0) !== code ? decomposed : null;
            if (key !== null)
            {
                compatibilityForms.set(key, [...compatibilityForms.get(key) ?? [], code]);
            }
        }
    }
    return compatibilityForms.get(character) ?? [];
};

/**
 * The character a page writes for one it lacks: the letter it decomposes
 * to, accent dropped, or the plain form of a compatibility one (a
 * full-width letter) -- when the page has that. A combining accent alone is
 * its spacing form, and a character the page has a compatibility form of is
 * that form (the micro sign for mu).
 *
 * @param {string} character
 * @param {(code: number) => number} lookup  A code unit's bytes in the page,
 *        UNDEFINED or -1 where the page has none.
 * @returns {number | null}
 */
export function bestFit(character, lookup){
    const found = (/** @type {number} */ code)=>{
        const mapped = lookup(code);
        return mapped !== UNDEFINED && mapped !== -1 ? mapped : null;
    };
    for (const form of /** @type {const} */ (['NFD', 'NFKD']))
    {
        const decomposed = character.normalize(form);
        if (decomposed === character)
        {
            continue;
        }
        const mapped = found(decomposed.charCodeAt(0));
        if (mapped !== null && /^\p{M}*$/u.test(decomposed.slice(1)))
        {
            return mapped;
        }
    }
    const spacing = SPACING_FORMS.get(character.charCodeAt(0));
    if (spacing !== undefined && found(spacing) !== null)
    {
        return found(spacing);
    }
    for (const code of formsOf(character))
    {
        const mapped = found(code);
        if (mapped !== null)
        {
            return mapped;
        }
    }
    return null;
}
