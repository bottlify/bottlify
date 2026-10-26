/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The Japanese conversions of the `_mbc*` family: JIS X 0208 codes and their
 * Shift-JIS pairs, hiragana and katakana, the half-width bytes of code page
 * 932 and their full-width pairs. Each is a fact of the two encodings, and
 * the kana ones are taken from Unicode here rather than written out: Shift-JIS
 * lays hiragana (0x829f..0x82f1) and katakana (0x8340..0x8396, skipping
 * 0x837f) in Unicode's order, and a half-width katakana byte 0xa1..0xdf is
 * U+FF61 on, whose compatibility form (NFKC) is the full-width character.
 * Under any page but 932 each conversion answers its argument unchanged and
 * each test answers zero, as msvcrt does.
 */

/** The page the conversions are of. */
export const SHIFT_JIS = 932;

const HIRAGANA_FIRST = 0x829f;
const HIRAGANA_LAST = 0x82f1;
const KATAKANA_FIRST = 0x8340;
/** ヶ, the last katakana; ン (0x8393) is the last with a hiragana twin. */
const KATAKANA_LAST = 0x8396;
const KATAKANA_WITH_HIRAGANA = 0x8393;
/** Shift-JIS has no character with the trail byte 0x7f. */
const NO_TRAIL = 0x7f;

/**
 * ASCII 0x20..0x7e as full-width characters of JIS X 0208's first row. The
 * backslash is the yen sign and the tilde the macron, as JIS-Roman reads
 * those two bytes; the quotes are the closing ones.
 */
const FULL_WIDTH_ASCII = [
    0x8140, 0x8149, 0x8168, 0x8194, 0x8190, 0x8193, 0x8195, 0x8166,
    0x8169, 0x816a, 0x8196, 0x817b, 0x8143, 0x817c, 0x8144, 0x815e,
    0x824f, 0x8250, 0x8251, 0x8252, 0x8253, 0x8254, 0x8255, 0x8256,
    0x8257, 0x8258, 0x8146, 0x8147, 0x8183, 0x8181, 0x8184, 0x8148,
    0x8197, ...Array.from({ length: 26 }, (_, at)=>0x8260 + at),
    0x816d, 0x818f, 0x816e, 0x814f, 0x8151,
    0x814d, ...Array.from({ length: 26 }, (_, at)=>0x8281 + at),
    0x816f, 0x8162, 0x8170, 0x8150,
];

/** The half-width bytes that are punctuation, not kana, and their full-width pairs. */
const HALF_WIDTH_SIGNS = new Map([[0xa1, 0x8142], [0xa2, 0x8175], [0xa3, 0x8176],
    [0xa4, 0x8141], [0xa5, 0x8145], [0xb0, 0x815b], [0xde, 0x814a], [0xdf, 0x814b]]);

/**
 * Katakana half-width has no form of: the small wa and ka and ke written as
 * their large ones, and the archaic wi and we as i and e.
 */
const NO_HALF_WIDTH = new Map([['ヮ', 'ワ'], ['ヵ', 'カ'], ['ヶ', 'ケ'], ['ヰ', 'イ'], ['ヱ', 'エ']]);

/** @param {number} code  A katakana's Shift-JIS pair. */
const katakanaIndex = code=>code - KATAKANA_FIRST - (code > NO_TRAIL + 0x8300 ? 1 : 0);

/** @param {number} index  From ァ (U+30A1). */
const katakanaCode = index=>KATAKANA_FIRST + index + (index >= NO_TRAIL - 0x40 ? 1 : 0);

/** @param {number} code */
const isKatakanaCode = code=>code >= KATAKANA_FIRST && code <= KATAKANA_LAST
    && (code & 0xff) !== NO_TRAIL;

/** @param {number} code */
const isHiraganaCode = code=>code >= HIRAGANA_FIRST && code <= HIRAGANA_LAST;

/** Each half-width byte by the full-width character it stands for. */
const halfWidthOf = new Map(Array.from({ length: 0xdf - 0xa1 + 1 }, (_, at)=>
    [String.fromCharCode(0xff61 + at).normalize('NFKC'), 0xa1 + at]));

/**
 * The Shift-JIS pair of a JIS X 0208 code: zero for one outside the 94 by 94
 * square, both bytes 0x21..0x7e.
 *
 * @param {number} jis
 */
export function jisToShiftJis(jis){
    const high = jis >>> 8;
    const low = jis & 0xff;
    if (high < 0x21 || high > 0x7e || low < 0x21 || low > 0x7e)
    {
        return 0;
    }
    // Two rows of the square share a lead byte: the odd row the trail bytes
    // 0x40..0x9e (skipping 0x7f), the even row 0x9f..0xfc.
    let trail = high & 1 ? low + 0x1f : low + 0x7e;
    if (high & 1 && trail >= NO_TRAIL)
    {
        trail++;
    }
    let lead = (high - 0x21 >> 1) + 0x81;
    if (lead > 0x9f)
    {
        lead += 0x40;
    }
    return lead << 8 | trail;
}

/**
 * The JIS X 0208 code of a Shift-JIS pair: zero for one whose bytes are not a
 * lead and a trail of page 932, or that falls outside the square.
 *
 * @param {number} code
 */
export function shiftJisToJis(code){
    const lead = code >>> 8;
    const trail = code & 0xff;
    if (lead > 0xff || !(lead >= 0x81 && lead <= 0x9f || lead >= 0xe0 && lead <= 0xfc)
        || !(trail >= 0x40 && trail <= 0xfc && trail !== NO_TRAIL))
    {
        return 0;
    }
    const pair = lead - (lead >= 0xa0 ? 0xc1 : 0x81);
    const high = trail >= 0x9f ? pair * 2 + 0x22 : pair * 2 + 0x21;
    const low = trail >= 0x9f ? trail - 0x7e : trail - (trail > NO_TRAIL ? 0x20 : 0x1f);
    return high > 0x7e ? 0 : high << 8 | low;
}

/** A katakana as its hiragana; anything else as itself. @param {number} code */
export function toHiragana(code){
    return isKatakanaCode(code) && code <= KATAKANA_WITH_HIRAGANA
        ? HIRAGANA_FIRST + katakanaIndex(code) : code;
}

/** A hiragana as its katakana; anything else as itself. @param {number} code */
export function toKatakana(code){
    return isHiraganaCode(code) ? katakanaCode(code - HIRAGANA_FIRST) : code;
}

/** Whether a pair is a full-width katakana. @param {number} code */
export function isKatakana(code){
    return isKatakanaCode(code);
}

/**
 * A single byte as its full-width pair: ASCII from the space to the tilde,
 * and the half-width kana and signs; any other code as itself.
 *
 * @param {number} code
 */
export function toFullWidth(code){
    if (code >= 0x20 && code <= 0x7e)
    {
        return FULL_WIDTH_ASCII[code - 0x20];
    }
    if (code >= 0xa1 && code <= 0xdf)
    {
        const sign = HALF_WIDTH_SIGNS.get(code);
        if (sign !== undefined)
        {
            return sign;
        }
        const katakana = String.fromCharCode(0xff61 + code - 0xa1).normalize('NFKC');
        return katakanaCode(katakana.charCodeAt(0) - 0x30a1);
    }
    return code;
}

/** Each full-width pair by the single byte it narrows to. */
const narrowOf = new Map([
    ...FULL_WIDTH_ASCII.map((pair, at)=>/** @type {[number, number]} */ ([pair, 0x20 + at])),
    ...[...HALF_WIDTH_SIGNS].map(([byte, pair])=>/** @type {[number, number]} */ ([pair, byte])),
]);

/**
 * A full-width pair as its single byte: the inverse of `toFullWidth`, and a
 * katakana with a voicing mark, or a hiragana, as the half-width katakana it
 * is written with, the mark dropped. A pair with no single byte is itself.
 *
 * @param {number} code
 */
export function toHalfWidth(code){
    const narrow = narrowOf.get(code);
    if (narrow !== undefined)
    {
        return narrow;
    }
    const katakana = toKatakana(code);
    if (!isKatakanaCode(katakana))
    {
        return code;
    }
    const character = String.fromCharCode(0x30a1 + katakanaIndex(katakana));
    const base = NO_HALF_WIDTH.get(character) ?? character.normalize('NFD')[0];
    return halfWidthOf.get(base) ?? code;
}

/**
 * Which JIS level a pair is in, as `_ismbcl0`, `_ismbcl1` and `_ismbcl2` ask:
 * 0 for the symbols and kana before the kanji (0x8140..0x889e), 1 for the
 * first level of kanji (0x889f..0x9872), 2 for the second (0x989f..0xeaa4);
 * -1 for a pair that is no legal character, or outside them.
 *
 * @param {number} code
 */
export function jisLevel(code){
    if (shiftJisToJis(code) === 0)
    {
        return -1;
    }
    return code <= 0x889e ? 0 : code <= 0x9872 ? 1 : code >= 0x989f && code <= 0xeaa4 ? 2 : -1;
}
