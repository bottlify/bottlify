/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What GetStringType answers for a UTF-16 unit: its CT_CTYPE1 class bits, its
 * CT_CTYPE2 bidirectional class and its CT_CTYPE3 text-processing bits.
 *
 * Windows reads them from a table of its own, which follows the Unicode
 * general categories; the categories here are the platform's (its RegExp
 * property escapes), and where Windows' table departs from the category -
 * which the conformance tests pin - it is written below as an exception.
 * The second and third types have no category of their own to follow: they
 * are derived from the Unicode properties a RegExp knows (scripts,
 * Diacritic, Ideographic, Alphabetic), which is what decisions.md A269 is
 * about.
 */

/** dwInfoType. */
export const CT_CTYPE1 = 1;
export const CT_CTYPE2 = 2;
export const CT_CTYPE3 = 4;

const C1_UPPER = 0x0001;
const C1_LOWER = 0x0002;
const C1_DIGIT = 0x0004;
const C1_SPACE = 0x0008;
const C1_PUNCT = 0x0010;
const C1_CNTRL = 0x0020;
const C1_BLANK = 0x0040;
const C1_XDIGIT = 0x0080;
const C1_ALPHA = 0x0100;
const C1_DEFINED = 0x0200;

const C2_LEFTTORIGHT = 1;
const C2_RIGHTTOLEFT = 2;
const C2_EUROPENUMBER = 3;
const C2_EUROPESEPARATOR = 4;
const C2_EUROPETERMINATOR = 5;
const C2_ARABICNUMBER = 6;
const C2_COMMONSEPARATOR = 7;
const C2_BLOCKSEPARATOR = 8;
const C2_SEGMENTSEPARATOR = 9;
const C2_WHITESPACE = 10;
const C2_OTHERNEUTRAL = 11;
const C2_NOTAPPLICABLE = 0;

const C3_NONSPACING = 0x0001;
const C3_DIACRITIC = 0x0002;
const C3_SYMBOL = 0x0008;
const C3_KATAKANA = 0x0010;
const C3_HIRAGANA = 0x0020;
const C3_HALFWIDTH = 0x0040;
const C3_FULLWIDTH = 0x0080;
const C3_IDEOGRAPH = 0x0100;
const C3_KASHIDA = 0x0200;
const C3_HIGHSURROGATE = 0x0800;
const C3_LOWSURROGATE = 0x1000;
const C3_ALPHA = 0x8000;

/** @param {string} pattern */
const is = pattern=>{
    const expression = new RegExp(`^${pattern}$`, 'u');
    return (/** @type {string} */ character)=>expression.test(character);
};

const unassigned = is('\\p{Cn}');
const uppercase = is('\\p{Lu}');
const lowercase = is('\\p{Ll}');
const titlecase = is('\\p{Lt}');
const letterLike = is('[\\p{Lm}\\p{Lo}\\p{Nl}]');
const decimal = is('\\p{Nd}');
const whiteSpace = is('\\p{White_Space}');
const separatorSpace = is('\\p{Zs}');
const control = is('[\\p{Cc}\\p{Cf}]');
const punctuation = is('\\p{P}');
const symbolOrNumber = is('[\\p{S}\\p{No}]');
const symbol = is('\\p{S}');
const nonspacing = is('[\\p{Mn}\\p{Me}]');
const diacritic = is('\\p{Diacritic}');
const katakana = is('\\p{Script=Katakana}');
const hiragana = is('\\p{Script=Hiragana}');
const ideograph = is('\\p{Ideographic}');
const alphabetic = is('\\p{Alphabetic}');
const rightToLeft = is('[\\p{Script=Hebrew}\\p{Script=Arabic}\\p{Script=Syriac}\\p{Script=Thaana}'
    + '\\p{Script=Nko}]');
const leftToRight = is('[\\p{L}\\p{Mc}]');

/**
 * Windows' table where it is not the category: modifier letters among the
 * superscripts read as lower case, and Thai and Mongolian marks as letters
 * (kernel32's locale.c test_GetStringTypeW pins each).
 *
 * @type {[number, number, number][]}  first, last, the bits added
 */
const C1_EXCEPTIONS = [
    [0x2071, 0x2071, C1_LOWER], [0x207f, 0x207f, C1_LOWER], [0x2090, 0x209c, C1_LOWER],
    [0x0e31, 0x0e31, C1_ALPHA], [0x0e34, 0x0e3a, C1_ALPHA], [0x0e47, 0x0e4e, C1_ALPHA],
    [0x1885, 0x1886, C1_ALPHA],
];

/** @param {number} code @param {string} character */
const ctype1 = (code, character)=>{
    if (unassigned(character))
    {
        return 0;
    }
    let type = C1_DEFINED;
    if (uppercase(character))
    {
        type |= C1_UPPER | C1_ALPHA;
    }
    else if (lowercase(character))
    {
        type |= C1_LOWER | C1_ALPHA;
    }
    else if (titlecase(character))
    {
        type |= C1_UPPER | C1_LOWER | C1_ALPHA;
    }
    else if (letterLike(character))
    {
        type |= C1_ALPHA;
    }
    if (decimal(character))
    {
        type |= C1_DIGIT;
    }
    if ((code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x46)
        || (code >= 0x61 && code <= 0x66))
    {
        type |= C1_XDIGIT;
    }
    if (whiteSpace(character))
    {
        type |= C1_SPACE;
    }
    if (code === 0x09 || code === 0xfeff || separatorSpace(character))
    {
        type |= C1_BLANK;
    }
    if (control(character))
    {
        type |= C1_CNTRL;
    }
    if (punctuation(character))
    {
        type |= C1_PUNCT;
    }
    // In the first 256 the symbols, the other numbers and the soft hyphen
    // are punctuation too, as the C runtime of the era classed them; the
    // superscript digits are digits besides.
    if (code < 0x100 && (symbolOrNumber(character) || code === 0xad))
    {
        type |= C1_PUNCT;
        if (code === 0xb2 || code === 0xb3 || code === 0xb9)
        {
            type |= C1_DIGIT;
        }
    }
    for (const [first, last, bits] of C1_EXCEPTIONS)
    {
        if (code >= first && code <= last)
        {
            type |= bits;
        }
    }
    return type;
};

/** @param {number} code @param {string} character */
const ctype2 = (code, character)=>{
    if (unassigned(character))
    {
        return C2_NOTAPPLICABLE;
    }
    if (code >= 0x30 && code <= 0x39 || code === 0xb2 || code === 0xb3 || code === 0xb9
        || (code >= 0xff10 && code <= 0xff19))
    {
        return C2_EUROPENUMBER;
    }
    if ((code >= 0x660 && code <= 0x669) || (code >= 0x6f0 && code <= 0x6f9))
    {
        return C2_ARABICNUMBER;
    }
    if (code === 0x2b || code === 0x2d)
    {
        return C2_EUROPESEPARATOR;
    }
    if (code === 0x23 || code === 0x24 || code === 0x25 || code === 0xa2 || code === 0xa3
        || code === 0xa4 || code === 0xa5 || code === 0xb0 || code === 0xb1)
    {
        return C2_EUROPETERMINATOR;
    }
    if (code === 0x2c || code === 0x2e || code === 0x2f || code === 0x3a || code === 0xa0)
    {
        return C2_COMMONSEPARATOR;
    }
    if (code === 0x0a || code === 0x0d || (code >= 0x1c && code <= 0x1e) || code === 0x85
        || code === 0x2029)
    {
        return C2_BLOCKSEPARATOR;
    }
    if (code === 0x09 || code === 0x0b || code === 0x1f)
    {
        return C2_SEGMENTSEPARATOR;
    }
    if (code === 0x0c || separatorSpace(character) || code === 0x2028)
    {
        return C2_WHITESPACE;
    }
    if (rightToLeft(character) && !nonspacing(character))
    {
        return C2_RIGHTTOLEFT;
    }
    if (leftToRight(character))
    {
        return C2_LEFTTORIGHT;
    }
    return C2_OTHERNEUTRAL;
};

/** @param {number} code @param {string} character */
const ctype3 = (code, character)=>{
    if (code >= 0xd800 && code <= 0xdbff)
    {
        return C3_HIGHSURROGATE;
    }
    if (code >= 0xdc00 && code <= 0xdfff)
    {
        return C3_LOWSURROGATE;
    }
    if (unassigned(character))
    {
        return 0;
    }
    let type = 0;
    if (nonspacing(character))
    {
        type |= C3_NONSPACING;
    }
    if (diacritic(character))
    {
        type |= C3_DIACRITIC;
    }
    if (symbol(character))
    {
        type |= C3_SYMBOL;
    }
    if (katakana(character))
    {
        type |= C3_KATAKANA;
    }
    if (hiragana(character))
    {
        type |= C3_HIRAGANA;
    }
    if (ideograph(character))
    {
        type |= C3_IDEOGRAPH;
    }
    if (code === 0x640)
    {
        type |= C3_KASHIDA;
    }
    if (alphabetic(character))
    {
        type |= C3_ALPHA;
    }
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xff61 && code <= 0xffdc)
        || (code >= 0xffe8 && code <= 0xffee))
    {
        type |= C3_HALFWIDTH;
    }
    else if ((code >= 0xff01 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6)
        || (code >= 0x3000 && code <= 0x30ff) || ideograph(character)
        || (code >= 0xac00 && code <= 0xd7a3))
    {
        type |= C3_FULLWIDTH;
    }
    return type;
};

const derive = { [CT_CTYPE1]: ctype1, [CT_CTYPE2]: ctype2, [CT_CTYPE3]: ctype3 };

/** Whether GetStringType takes `infoType`: one of the three, exactly. @param {number} infoType */
export const isStringType = infoType=>infoType === CT_CTYPE1 || infoType === CT_CTYPE2
    || infoType === CT_CTYPE3;

/**
 * GetStringType's words for one info type, a unit's at its index: each fits
 * the WORD the call writes.
 *
 * @param {CT_CTYPE1 | CT_CTYPE2 | CT_CTYPE3} infoType
 */
const tableOf = infoType=>{
    const table = new Uint16Array(0x10000);
    const type = derive[infoType];
    for (let code = 0; code < 0x10000; code++)
    {
        table[code] = type(code, String.fromCharCode(code));
    }
    return table;
};

/**
 * GetStringType's answers from the run's tables (`run-tables.js`), one for
 * each info type, made when a call first asks for it.
 *
 * @param {import('../common/run-tables.js').RunTables} tables
 * @returns {(infoType: number, text: string) => Uint16Array | null}  the word
 *     for each unit of `text`, or null for an info type the call does not take
 */
export function stringTypes(tables){
    const of = {
        [CT_CTYPE1]: tables.table('ctype/1', Uint16Array, ()=>tableOf(CT_CTYPE1)),
        [CT_CTYPE2]: tables.table('ctype/2', Uint16Array, ()=>tableOf(CT_CTYPE2)),
        [CT_CTYPE3]: tables.table('ctype/4', Uint16Array, ()=>tableOf(CT_CTYPE3)),
    };
    return (infoType, text)=>{
        if (!isStringType(infoType))
        {
            return null;
        }
        return of[/** @type {CT_CTYPE1 | CT_CTYPE2 | CT_CTYPE3} */ (infoType)].read(table=>{
            const words = new Uint16Array(text.length);
            for (let at = 0; at < text.length; at++)
            {
                words[at] = table[text.charCodeAt(at)];
            }
            return words;
        });
    };
}
