/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * How CompareString orders text and LCMapString's LCMAP_SORTKEY writes it:
 * Windows' word sort, by its levels.
 *
 * A character weighs in at three levels, compared one after the other over
 * the whole string: what it is (its primary weight), its diacritics, its
 * case, width and kana. The primary weights run in Windows' order -- the
 * punctuation in code order, then the mathematical signs, then the digits by
 * value, then the letters, script by script, each with its accented and
 * compatibility forms; an accent is a diacritic weight and a capital a case
 * weight on its base letter, so "a" < "A" < "b" and "á" falls between "a"
 * and "b". NUL, and the characters Unicode gives no weight, count for
 * nothing. A word sort leaves the hyphen and the apostrophe out of the three
 * levels and compares them only when everything else is equal (SORT_STRINGSORT
 * makes them punctuation, first among it); NORM_IGNORESYMBOLS leaves all
 * punctuation and signs out, NORM_IGNORENONSPACE the diacritics,
 * NORM_IGNORECASE the case, NORM_IGNOREWIDTH and NORM_IGNOREKANATYPE those
 * parts of the third level.
 *
 * A sort key is the levels' weights in order, each level closed by a 0x01
 * byte and the key by a 0x00: every weight byte is 2 or more, so comparing
 * two keys byte by byte orders them as CompareString does.
 */

export const NORM_IGNORECASE = 0x00000001;
export const NORM_IGNORENONSPACE = 0x00000002;
export const NORM_IGNORESYMBOLS = 0x00000004;
export const LINGUISTIC_IGNORECASE = 0x00000010;
export const LINGUISTIC_IGNOREDIACRITIC = 0x00000020;
export const SORT_STRINGSORT = 0x00001000;
export const SORT_DIGITSASNUMBERS = 0x00000008;
export const NORM_IGNOREKANATYPE = 0x00010000;
export const NORM_IGNOREWIDTH = 0x00020000;

/** The primary weights' bands. */
const CONTROL = 1 << 16;
const PUNCTUATION = 2 << 16;
const SIGN = 3 << 16;
const DIGIT = 4 << 16;
const LETTER = 5 << 16;

/** ASCII's punctuation, in Windows' order; a word sort leaves out the first two. */
const ASCII_PUNCTUATION = '\'-\t\n\v\f\r !"#$%&()*,./:;?@[\\]^_`{|}~';
/** The signs after the punctuation. */
const ASCII_SIGNS = '+<=>';

/**
 * Case, width and kana: the third level's parts, in Windows' order -- a
 * small letter before a capital, a halfwidth form before the plain one
 * before a wide or compatibility one, katakana before hiragana.
 */
const UPPER = 0x40;
const HIRAGANA = 0x20;
const WIDE = 0x08;
const PLAIN = 0x04;

/** The letters a base letter stands for where Unicode gives it no decomposition. */
const EXPANSIONS = new Map([
    ['æ', 'ae'], ['Æ', 'AE'], ['œ', 'oe'], ['Œ', 'OE'], ['ß', 'ss'], ['ĳ', 'ij'], ['Ĳ', 'IJ'],
]);

/** Letters that are a base letter with a mark Unicode does not decompose. */
/** @type {ReadonlyMap<string, [string, number]>} */
const STROKED = new Map([
    ['ø', ['o', 0x0338]], ['Ø', ['O', 0x0338]], ['đ', ['d', 0x0335]], ['Đ', ['D', 0x0335]],
    ['ł', ['l', 0x0337]], ['Ł', ['L', 0x0337]], ['ħ', ['h', 0x0335]], ['Ħ', ['H', 0x0335]],
    ['ŧ', ['t', 0x0335]], ['Ŧ', ['T', 0x0335]], ['ı', ['i', 0x02ff]],
]);

/**
 * @typedef {Object} Weights
 * @property {number[]} primary
 * @property {number[]} diacritic  One a primary weight.
 * @property {number[]} tertiary   One a primary weight.
 * @property {number[]} special    A word sort's hyphens and apostrophes: where, and which.
 */

/** @param {string} character */
const isLetter = character=>/\p{L}/u.test(character);
/** @param {string} character */
const isMark = character=>/\p{M}/u.test(character);
/** @param {string} character */
const isIgnorable = character=>/[\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u.test(character)
    && !/[‎‏]/.test(character);

/**
 * A script's band, from its letters' code points: Latin first, then Greek,
 * Cyrillic and the rest in Unicode's order.
 *
 * @param {number} code
 */
const scriptRank = code=>{
    if (code < 0x0370 || (code >= 0x1e00 && code < 0x1f00) || (code >= 0xff21 && code <= 0xff5a))
    {
        return 0;
    }
    if (code < 0x0400 || (code >= 0x1f00 && code < 0x2000))
    {
        return 1;
    }
    return 2 + (code >> 8);
};

/** @param {number} code */
const isHiragana = code=>(code >= 0x3041 && code <= 0x3096) || code === 0x309d || code === 0x309e;

/**
 * The width part of a compatibility form's third level: a halfwidth form
 * below the plain character, any other form above it.
 *
 * @param {string} character
 */
const widthOf = character=>{
    const code = /** @type {number} */ (character.codePointAt(0));
    return code >= 0xff61 && code <= 0xffdc ? 0 : WIDE;
};

/** @param {number} code */
const toHiragana = code=>((code >= 0x30a1 && code <= 0x30f6) || code === 0x30fd || code === 0x30fe
    ? code - 0x60 : code);

/**
 * A string's weights.
 *
 * @param {string} text @param {number} flags
 * @returns {Weights}
 */
export function weigh(text, flags){
    const stringSort = (flags & SORT_STRINGSORT) !== 0;
    const ignoreSymbols = (flags & NORM_IGNORESYMBOLS) !== 0;
    const ignoreMarks = (flags & (NORM_IGNORENONSPACE | LINGUISTIC_IGNOREDIACRITIC)) !== 0;
    const ignoreCase = (flags & (NORM_IGNORECASE | LINGUISTIC_IGNORECASE)) !== 0;
    /** @type {Weights} */
    const weights = { primary: [], diacritic: [], tertiary: [], special: [] };
    /** @param {number} primary @param {number} diacritic @param {number} tertiary */
    const push = (primary, diacritic, tertiary)=>{
        weights.primary.push(primary);
        weights.diacritic.push(ignoreMarks ? 2 : diacritic);
        let third = tertiary;
        if (ignoreCase)
        {
            third &= ~UPPER;
        }
        if ((flags & NORM_IGNOREWIDTH) !== 0)
        {
            third = third & ~(WIDE | PLAIN) | PLAIN;
        }
        if ((flags & NORM_IGNOREKANATYPE) !== 0)
        {
            third &= ~HIRAGANA;
        }
        weights.tertiary.push(2 + third);
    };
    /** A combining mark after its letter: a diacritic weight added to the letter's. */
    const addMark = (/** @type {number} */ mark)=>{
        const last = weights.diacritic.length - 1;
        if (last >= 0 && !ignoreMarks)
        {
            weights.diacritic[last] = Math.min(255, weights.diacritic[last] + markWeight(mark));
        }
    };

    const characters = [...text];
    for (let index = 0; index < characters.length; index++)
    {
        const character = characters[index];
        const code = /** @type {number} */ (character.codePointAt(0));
        if (code === 0 || isIgnorable(character))
        {
            continue;
        }
        const ascii = code < 0x80 ? ASCII_PUNCTUATION.indexOf(character) : -1;
        if (ascii !== -1 && ascii < 2 && !stringSort)
        {
            if (!ignoreSymbols)
            {
                weights.special.push(weights.primary.length, ascii + 2);
            }
            continue;
        }
        if (ascii !== -1)
        {
            if (!ignoreSymbols)
            {
                push(PUNCTUATION + ascii, 2, PLAIN);
            }
            continue;
        }
        const sign = code < 0x80 ? ASCII_SIGNS.indexOf(character) : -1;
        if (sign !== -1)
        {
            if (!ignoreSymbols)
            {
                push(SIGN + sign, 2, PLAIN);
            }
            continue;
        }
        if (code < 0x20 || (code >= 0x7f && code < 0xa0))
        {
            push(CONTROL + code, 2, PLAIN);
            continue;
        }
        if (isMark(character))
        {
            addMark(code);
            continue;
        }
        const digit = digitValue(character);
        if (digit !== null && (flags & SORT_DIGITSASNUMBERS) !== 0)
        {
            // A run of digits is one number: its length without leading
            // zeros first, so a longer number is the larger, then its digits.
            const run = [digit];
            while (index + 1 < characters.length && digitValue(characters[index + 1]) !== null)
            {
                run.push(/** @type {number} */ (digitValue(characters[++index])));
            }
            const significant = run.slice(Math.max(0, run.findIndex(value=>value !== 0)));
            push(DIGIT + 0x100 + (run.every(value=>value === 0) ? 0 : significant.length), 2,
                PLAIN);
            for (const value of run.every(each=>each === 0) ? [0] : significant)
            {
                push(DIGIT + value, 2, PLAIN);
            }
            continue;
        }
        if (digit !== null)
        {
            push(DIGIT + digit, 2, character === String(digit) ? PLAIN : widthOf(character));
            continue;
        }
        if (!isLetter(character))
        {
            if (!ignoreSymbols)
            {
                push((/\p{S}/u.test(character) ? SIGN : PUNCTUATION) + 0x100 + code, 2, PLAIN);
            }
            continue;
        }
        letter(character, code, push, addMark);
    }
    return weights;
}

/**
 * A letter's weights: its base letter's primary weight, its marks as
 * diacritics, its case, width and kana as the third level.
 *
 * @param {string} character @param {number} code
 * @param {(primary: number, diacritic: number, tertiary: number) => void} push
 * @param {(mark: number) => void} addMark
 */
function letter(character, code, push, addMark){
    const expanded = EXPANSIONS.get(character);
    if (expanded !== undefined)
    {
        for (const part of expanded)
        {
            letter(part, /** @type {number} */ (part.codePointAt(0)), push, addMark);
        }
        return;
    }
    const stroked = STROKED.get(character);
    let width = PLAIN;
    let base;
    /** @type {number[]} */
    let marks;
    if (stroked !== undefined)
    {
        base = stroked[0];
        marks = [stroked[1]];
    }
    else
    {
        let decomposed = character.normalize('NFD');
        if ([...decomposed].length === 1 && decomposed === character)
        {
            const compatible = character.normalize('NFKD');
            if (compatible !== character && [...compatible].length >= 1)
            {
                width = widthOf(character);
                decomposed = compatible;
            }
        }
        const parts = [...decomposed];
        base = parts[0];
        marks = parts.slice(1).filter(isMark).map(mark=>/** @type {number} */ (mark.codePointAt(0)));
    }
    const baseCode = /** @type {number} */ (base.codePointAt(0));
    const kana = toHiragana(baseCode);
    const lower = String.fromCodePoint(kana).toLowerCase();
    const lowerCode = /** @type {number} */ (lower.codePointAt(0));
    const upper = base !== base.toLowerCase() ? UPPER : 0;
    push(LETTER + scriptRank(lowerCode) * 0x10000 + lowerCode, 2,
        upper | width | (kana === baseCode && isHiragana(baseCode) ? HIRAGANA : 0));
    for (const mark of marks)
    {
        addMark(mark);
    }
    void code;
}

/** The commonest marks, in the order Windows weighs them; the rest follow by code. */
const MARK_ORDER = [0x0301, 0x0300, 0x0303, 0x0309, 0x0308, 0x0306, 0x0302, 0x030c, 0x030a,
    0x0304, 0x0307, 0x0328, 0x0327, 0x030b];

/** A combining mark's diacritic weight: its place among the marks. @param {number} mark */
const markWeight = mark=>{
    if (mark === 0x02ff)
    {
        // The dotless i: a mark below every other, its own capital's dot among them.
        return 1;
    }
    const ranked = MARK_ORDER.indexOf(mark);
    if (ranked !== -1)
    {
        return ranked + 2;
    }
    return mark >= 0x0300 && mark < 0x0370 ? mark - 0x0300 + 16
        : 128 + (mark & 0x7f);
};

/**
 * A digit's value, for the characters Unicode counts as decimal digits and
 * the superscripts among Latin-1's.
 *
 * @param {string} character
 * @returns {number | null}
 */
function digitValue(character){
    if (!/[\p{Nd}²³¹]/u.test(character))
    {
        return null;
    }
    const plain = character.normalize('NFKD');
    if (/^[0-9]$/.test(plain))
    {
        return Number(plain);
    }
    let start = /** @type {number} */ (character.codePointAt(0));
    while (/\p{Nd}/u.test(String.fromCodePoint(start - 1)))
    {
        start--;
    }
    return (/** @type {number} */ (character.codePointAt(0)) - start) % 10;
}

/**
 * Whether NORM_IGNORESYMBOLS leaves a character out: punctuation, signs and
 * spaces, the hyphen and the apostrophe among them.
 *
 * @param {string} character
 */
export function isSymbol(character){
    const code = /** @type {number} */ (character.codePointAt(0));
    if (code < 0x80)
    {
        return ASCII_PUNCTUATION.includes(character) || ASCII_SIGNS.includes(character);
    }
    return /[\p{P}\p{S}\p{Z}]/u.test(character);
}

/** @param {number[]} left @param {number[]} right */
const compareLists = (left, right)=>{
    const length = Math.min(left.length, right.length);
    for (let at = 0; at < length; at++)
    {
        if (left[at] !== right[at])
        {
            return left[at] < right[at] ? -1 : 1;
        }
    }
    return Math.sign(left.length - right.length);
};

/**
 * Two strings' order, -1, 0 or 1: the levels one after the other, the
 * hyphens and apostrophes of a word sort last.
 *
 * @param {string} left @param {string} right @param {number} flags
 */
export function compareText(left, right, flags){
    const a = weigh(left, flags);
    const b = weigh(right, flags);
    return compareLists(a.primary, b.primary) || compareLists(a.diacritic, b.diacritic)
        || compareLists(a.tertiary, b.tertiary) || compareLists(a.special, b.special);
}

/**
 * A string's sort key.
 *
 * @param {string} text @param {number} flags
 * @returns {Uint8Array}
 */
export function sortKey(text, flags){
    const { primary, diacritic, tertiary, special } = weigh(text, flags);
    /** @type {number[]} */
    const out = [];
    for (const weight of primary)
    {
        // Seven bits a byte, each lifted past the separators.
        out.push(2 + (weight >> 14 & 0x7f), 2 + (weight >> 7 & 0x7f), 2 + (weight & 0x7f));
    }
    out.push(1);
    out.push(...trimmed(diacritic), 1);
    out.push(...trimmed(tertiary), 1);
    for (let at = 0; at < special.length; at += 2)
    {
        out.push(2 + (special[at] >> 7 & 0x7f), 2 + (special[at] & 0x7f), special[at + 1]);
    }
    out.push(0);
    return Uint8Array.from(out);
}

/** A level's weights without the plain ones at its end, which sort as none. @param {number[]} level */
const trimmed = level=>{
    let end = level.length;
    while (end > 0 && level[end - 1] === 2)
    {
        end--;
    }
    return level.slice(0, end);
};
