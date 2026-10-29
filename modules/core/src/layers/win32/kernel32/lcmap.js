/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * LCMapString's mappings of text to text: case, the two kana, the two
 * widths, and the NORM_IGNORE* flags read as mappings -- symbols taken out,
 * diacritics taken off. The sort key is the collation's (`collation.js`).
 *
 * Case is one character for one, as Windows' tables have it: a letter whose
 * other case is longer than a character keeps its own (ß stays ß in upper
 * case). The widths are the halfwidth and fullwidth forms Unicode pairs, an
 * ASCII character with its fullwidth twin and a katakana with the halfwidth
 * one and its sound mark; the compatibility forms of letters and digits --
 * mathematical alphanumerics, the CJK compatibility ideographs -- become
 * what they stand for under LCMAP_FULLWIDTH.
 */

export const LCMAP_LOWERCASE = 0x00000100;
export const LCMAP_UPPERCASE = 0x00000200;
export const LCMAP_TITLECASE = 0x00000300;
export const LCMAP_SORTKEY = 0x00000400;
export const LCMAP_BYTEREV = 0x00000800;
export const LCMAP_HIRAGANA = 0x00100000;
export const LCMAP_KATAKANA = 0x00200000;
export const LCMAP_HALFWIDTH = 0x00400000;
export const LCMAP_FULLWIDTH = 0x00800000;
export const LCMAP_LINGUISTIC_CASING = 0x01000000;
export const LCMAP_SIMPLIFIED_CHINESE = 0x02000000;
export const LCMAP_TRADITIONAL_CHINESE = 0x04000000;
const NORM_IGNORECASE = 0x00000001;
const NORM_IGNORENONSPACE = 0x00000002;
const NORM_IGNORESYMBOLS = 0x00000004;
const SORT_STRINGSORT = 0x00001000;

/** The flags a sort key takes besides LCMAP_SORTKEY: the comparison's. */
const SORT_KEY_FLAGS = NORM_IGNORECASE | NORM_IGNORENONSPACE | NORM_IGNORESYMBOLS | 0x10 | 0x20
    | SORT_STRINGSORT | 0x10000 | 0x20000 | 0x08000000 | 0x00000008;

/** The halfwidth katakana and punctuation, by the fullwidth character each stands for. */
const HALFWIDTH = new Map();
for (let code = 0xff61; code <= 0xff9f; code++)
{
    const full = String.fromCharCode(code).normalize('NFKC');
    if (full.length === 1 && !HALFWIDTH.has(full))
    {
        HALFWIDTH.set(full, String.fromCharCode(code));
    }
}

/** @param {number} code */
const isKatakana = code=>(code >= 0x30a1 && code <= 0x30f6) || code === 0x30fd || code === 0x30fe;
/** @param {number} code */
const isHiragana = code=>(code >= 0x3041 && code <= 0x3096) || code === 0x309d || code === 0x309e;

/** Where LCMAP_FULLWIDTH reads a compatibility form as what it stands for. @param {number} code */
const isCompatibilityForm = code=>(code >= 0xff61 && code <= 0xffdc)
    || (code >= 0xf900 && code <= 0xfaff) || (code >= 0x1d400 && code <= 0x1d7ff)
    || (code >= 0x1ee00 && code <= 0x1eeff) || (code >= 0x2f800 && code <= 0x2fa1f);

/**
 * Whether a flag combination is one LCMapString takes: a mapping of each
 * kind at most, the sort key with the comparison's flags alone, and the
 * NORM_IGNORE* mappings with nothing but each other.
 *
 * @param {number} flags
 */
export function validMapFlags(flags){
    if ((flags & LCMAP_SORTKEY) !== 0)
    {
        return (flags & ~(LCMAP_SORTKEY | SORT_KEY_FLAGS)) === 0;
    }
    const kana = flags & (LCMAP_HIRAGANA | LCMAP_KATAKANA);
    const width = flags & (LCMAP_HALFWIDTH | LCMAP_FULLWIDTH);
    const chinese = flags & (LCMAP_SIMPLIFIED_CHINESE | LCMAP_TRADITIONAL_CHINESE);
    const casing = flags & LCMAP_TITLECASE;
    const ignoring = flags & (NORM_IGNORENONSPACE | NORM_IGNORESYMBOLS);
    if (flags === 0 || kana === (LCMAP_HIRAGANA | LCMAP_KATAKANA)
        || width === (LCMAP_HALFWIDTH | LCMAP_FULLWIDTH)
        || chinese === (LCMAP_SIMPLIFIED_CHINESE | LCMAP_TRADITIONAL_CHINESE)
        || ((casing !== 0 || kana !== 0 || width !== 0) && (ignoring !== 0 || chinese !== 0))
        || (casing !== 0 && (flags & SORT_STRINGSORT) !== 0)
        || ((kana !== 0 || width !== 0) && chinese !== 0))
    {
        return false;
    }
    return (flags & ~(LCMAP_TITLECASE | LCMAP_BYTEREV | LCMAP_HIRAGANA | LCMAP_KATAKANA
        | LCMAP_HALFWIDTH | LCMAP_FULLWIDTH | LCMAP_LINGUISTIC_CASING | LCMAP_SIMPLIFIED_CHINESE
        | LCMAP_TRADITIONAL_CHINESE | NORM_IGNORENONSPACE | NORM_IGNORESYMBOLS | NORM_IGNORECASE
        | 0x40000000)) === 0;
}

/**
 * A character in one case, one for one; with Turkish casing the dotted and
 * dotless i are their own pairs.
 *
 * @param {string} character @param {boolean} upper @param {boolean} turkish
 */
const caseOf = (character, upper, turkish)=>{
    if (turkish)
    {
        if (upper && character === 'i')
        {
            return 'İ';
        }
        if (!upper && character === 'I')
        {
            return 'ı';
        }
    }
    const changed = upper ? character.toUpperCase() : character.toLowerCase();
    if (changed.length === character.length)
    {
        return changed;
    }
    // A capital whose small letter carries a mark of its own, the dotted
    // capital I: the letter alone.
    return !upper && [...changed.normalize('NFD')][0].length === character.length
        ? [...changed][0] : character;
};

/**
 * @param {string} text @param {(character: string) => boolean} isSymbol
 *        The collation's punctuation and signs, which NORM_IGNORESYMBOLS takes out.
 * @param {number} flags @param {boolean} turkish  The locale is Turkish or Azeri.
 * @returns {string}
 */
export function mapText(text, flags, isSymbol, turkish){
    let out = text;
    if ((flags & (NORM_IGNORENONSPACE | NORM_IGNORESYMBOLS)) !== 0)
    {
        out = [...out].map(character=>{
            if ((flags & NORM_IGNORESYMBOLS) !== 0 && isSymbol(character))
            {
                return '';
            }
            if ((flags & NORM_IGNORENONSPACE) !== 0)
            {
                const decomposed = character.normalize('NFD');
                return /\p{M}/u.test(character) ? '' : decomposed.replace(/\p{M}/gu, '');
            }
            return character;
        }).join('');
    }
    if ((flags & LCMAP_FULLWIDTH) !== 0)
    {
        out = [...out].map(character=>{
            const code = /** @type {number} */ (character.codePointAt(0));
            if (code > 0x20 && code < 0x7f)
            {
                return String.fromCharCode(code + 0xfee0);
            }
            if (code === 0x20)
            {
                return '　';
            }
            return isCompatibilityForm(code) ? character.normalize('NFKC') : character;
        }).join('').replace(/[\u3040-\u30ff][\u3099\u309a]/g, pair=>pair.normalize('NFC'));
    }
    if ((flags & LCMAP_HIRAGANA) !== 0)
    {
        out = [...out].map(character=>{
            const code = /** @type {number} */ (character.codePointAt(0));
            return isKatakana(code) ? String.fromCharCode(code - 0x60) : character;
        }).join('');
    }
    if ((flags & LCMAP_KATAKANA) !== 0)
    {
        out = [...out].map(character=>{
            const code = /** @type {number} */ (character.codePointAt(0));
            return isHiragana(code) ? String.fromCharCode(code + 0x60) : character;
        }).join('');
    }
    if ((flags & LCMAP_HALFWIDTH) !== 0)
    {
        out = [...out].map(character=>{
            const code = /** @type {number} */ (character.codePointAt(0));
            if (code >= 0xff01 && code <= 0xff5e)
            {
                return String.fromCharCode(code - 0xfee0);
            }
            if (code === 0x3000)
            {
                return ' ';
            }
            const half = HALFWIDTH.get(character);
            if (half !== undefined)
            {
                return half;
            }
            const [base, mark] = character.normalize('NFD');
            const halfBase = HALFWIDTH.get(base);
            if (halfBase !== undefined && (mark === '゙' || mark === '゚'))
            {
                return halfBase + (mark === '゙' ? 'ﾞ' : 'ﾟ');
            }
            return character;
        }).join('');
    }
    const casing = flags & LCMAP_TITLECASE;
    const linguistic = turkish && (flags & LCMAP_LINGUISTIC_CASING) !== 0;
    if (casing === LCMAP_TITLECASE)
    {
        let start = true;
        out = [...out].map(character=>{
            const letter = /\p{L}/u.test(character);
            const mapped = letter ? caseOf(character, start, linguistic) : character;
            start = !letter && !/['’]/.test(character);
            return mapped;
        }).join('');
    }
    else if (casing !== 0)
    {
        out = [...out].map(character=>caseOf(character, casing === LCMAP_UPPERCASE, linguistic))
            .join('');
    }
    if ((flags & LCMAP_BYTEREV) !== 0)
    {
        out = Array.from(out, unit=>String.fromCharCode((unit.charCodeAt(0) & 0xff) << 8
            | unit.charCodeAt(0) >> 8)).join('');
    }
    return out;
}
