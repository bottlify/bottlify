/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * DirectWrite's text analysis: a text cut into runs of one script, its bidi
 * levels, and where its lines may break.
 *
 * A script is a number DirectWrite hands back in DWRITE_SCRIPT_ANALYSIS and
 * takes again when it shapes the run: Windows numbers them in the order of
 * their ISO 15924 codes after Unknown, Common and Inherited (Wine's tests:
 * Arabic 3, Latin 49). Common characters - spaces, digits, punctuation - and
 * inherited ones - combining marks - belong to the run they stand in, the one
 * before them, or at the start, the one after.
 *
 * The bidi levels are the Unicode algorithm's for the strong and the number
 * classes and the explicit embeddings, without isolates or bracket pairs
 * (decision A238); the line breaks are UAX #14's for spaces, hyphens and
 * break-after characters, brackets, mandatory breaks and ideographs.
 */

/** Scripts by ISO 15924 code, numbered in Windows' order. */
const SCRIPT_CODES = ['Zzzz', 'Zyyy', 'Zinh', 'Arab', 'Armi', 'Armn', 'Avst', 'Bali', 'Bamu',
    'Batk', 'Beng', 'Bopo', 'Brah', 'Brai', 'Bugi', 'Buhd', 'Cakm', 'Cans', 'Cari', 'Cham',
    'Cher', 'Copt', 'Cprt', 'Cyrl', 'Deva', 'Dsrt', 'Egyp', 'Ethi', 'Geor', 'Glag', 'Goth',
    'Grek', 'Gujr', 'Guru', 'Hang', 'Hani', 'Hano', 'Hebr', 'Hira', 'Ital', 'Java', 'Kali',
    'Kana', 'Khar', 'Khmr', 'Knda', 'Kthi', 'Lana', 'Laoo', 'Latn', 'Lepc', 'Limb', 'Linb',
    'Lisu', 'Lyci', 'Lydi', 'Mand', 'Mlym', 'Mong', 'Mtei', 'Mymr', 'Nkoo', 'Ogam', 'Olck',
    'Orkh', 'Orya', 'Osma', 'Phag', 'Phnx', 'Rjng', 'Runr', 'Samr', 'Sarb', 'Saur', 'Shaw',
    'Sinh', 'Sund', 'Sylo', 'Syrc', 'Tagb', 'Tale', 'Talu', 'Taml', 'Tavt', 'Telu', 'Tfng',
    'Tglg', 'Thaa', 'Thai', 'Tibt', 'Ugar', 'Vaii', 'Xpeo', 'Xsux', 'Yiii'];

/** @type {Record<string, number>} */
export const SCRIPT = Object.freeze(Object.fromEntries(SCRIPT_CODES.map((code, i)=>[code, i])));

/** The script's ISO 15924 code. @param {number} script */
export const scriptCode = script=>SCRIPT_CODES[script] ?? 'Zzzz';

/**
 * Blocks of the Basic Multilingual Plane by script: [first, last, code].
 * What is in none of them is Common.
 */
const SCRIPT_RANGES = /** @type {[number, number, string][]} */ ([
    [0x41, 0x5a, 'Latn'], [0x61, 0x7a, 'Latn'], [0xaa, 0xaa, 'Latn'], [0xba, 0xba, 'Latn'],
    [0xc0, 0xd6, 'Latn'], [0xd8, 0xf6, 'Latn'], [0xf8, 0x24f, 'Latn'], [0x250, 0x2af, 'Latn'],
    [0x300, 0x36f, 'Zinh'], [0x370, 0x3e1, 'Grek'], [0x3e2, 0x3ef, 'Copt'],
    [0x3f0, 0x3ff, 'Grek'], [0x400, 0x52f, 'Cyrl'],
    [0x531, 0x58f, 'Armn'], [0x591, 0x5ff, 'Hebr'], [0x600, 0x604, 'Zyyy'],
    [0x606, 0x60b, 'Arab'], [0x60c, 0x60c, 'Zyyy'], [0x60d, 0x61a, 'Arab'],
    [0x61b, 0x61b, 'Zyyy'], [0x61e, 0x61e, 'Arab'], [0x61f, 0x61f, 'Zyyy'],
    [0x620, 0x63f, 'Arab'], [0x640, 0x640, 'Zyyy'], [0x641, 0x64a, 'Arab'],
    [0x64b, 0x655, 'Zinh'], [0x656, 0x65f, 'Arab'], [0x660, 0x669, 'Zyyy'],
    [0x66a, 0x6ff, 'Arab'], [0x700, 0x74f, 'Syrc'], [0x750, 0x77f, 'Arab'],
    [0x780, 0x7bf, 'Thaa'], [0x7c0, 0x7ff, 'Nkoo'], [0x800, 0x83f, 'Samr'],
    [0x840, 0x85f, 'Mand'], [0x8a0, 0x8ff, 'Arab'], [0x900, 0x97f, 'Deva'],
    [0x980, 0x9ff, 'Beng'], [0xa00, 0xa7f, 'Guru'], [0xa80, 0xaff, 'Gujr'],
    [0xb00, 0xb7f, 'Orya'], [0xb80, 0xbff, 'Taml'], [0xc00, 0xc7f, 'Telu'],
    [0xc80, 0xcff, 'Knda'], [0xd00, 0xd7f, 'Mlym'], [0xd80, 0xdff, 'Sinh'],
    [0xe00, 0xe7f, 'Thai'], [0xe80, 0xeff, 'Laoo'], [0xf00, 0xfff, 'Tibt'],
    [0x1000, 0x109f, 'Mymr'], [0x10a0, 0x10ff, 'Geor'], [0x1100, 0x11ff, 'Hang'],
    [0x1200, 0x139f, 'Ethi'], [0x13a0, 0x13ff, 'Cher'], [0x1400, 0x167f, 'Cans'],
    [0x1680, 0x169f, 'Ogam'], [0x16a0, 0x16ff, 'Runr'], [0x1700, 0x171f, 'Tglg'],
    [0x1720, 0x173f, 'Hano'], [0x1740, 0x175f, 'Buhd'], [0x1760, 0x177f, 'Tagb'],
    [0x1780, 0x17ff, 'Khmr'], [0x1800, 0x18af, 'Mong'], [0x18b0, 0x18ff, 'Cans'],
    [0x1900, 0x194f, 'Limb'], [0x1950, 0x197f, 'Tale'], [0x1980, 0x19df, 'Talu'],
    [0x19e0, 0x19ff, 'Khmr'], [0x1a00, 0x1a1f, 'Bugi'], [0x1a20, 0x1aaf, 'Lana'],
    [0x1b00, 0x1b7f, 'Bali'], [0x1b80, 0x1bbf, 'Sund'], [0x1bc0, 0x1bff, 'Batk'],
    [0x1c00, 0x1c4f, 'Lepc'], [0x1c50, 0x1c7f, 'Olck'], [0x1d00, 0x1d7f, 'Latn'],
    [0x1d80, 0x1dbf, 'Latn'], [0x1dc0, 0x1dff, 'Zinh'], [0x1e00, 0x1eff, 'Latn'],
    [0x1f00, 0x1fff, 'Grek'], [0x200c, 0x200d, 'Zinh'], [0x2071, 0x2071, 'Latn'],
    [0x207f, 0x207f, 'Latn'], [0x2090, 0x209c, 'Latn'], [0x20d0, 0x20ff, 'Zinh'],
    [0x2c00, 0x2c5f, 'Glag'], [0x2c60, 0x2c7f, 'Latn'], [0x2c80, 0x2cff, 'Copt'],
    [0x2d00, 0x2d2f, 'Geor'], [0x2d30, 0x2d7f, 'Tfng'], [0x2d80, 0x2ddf, 'Ethi'],
    [0x2de0, 0x2dff, 'Cyrl'], [0x2e80, 0x2fdf, 'Hani'], [0x3005, 0x3005, 'Hani'],
    [0x3007, 0x3007, 'Hani'], [0x3021, 0x3029, 'Hani'], [0x302a, 0x302d, 'Zinh'],
    [0x3038, 0x303b, 'Hani'], [0x3041, 0x3096, 'Hira'], [0x3099, 0x309a, 'Zinh'],
    [0x309d, 0x309f, 'Hira'], [0x30a1, 0x30fa, 'Kana'], [0x30fd, 0x30ff, 'Kana'],
    [0x3105, 0x312f, 'Bopo'], [0x3131, 0x318e, 'Hang'], [0x31a0, 0x31bf, 'Bopo'],
    [0x31f0, 0x31ff, 'Kana'], [0x3400, 0x4dbf, 'Hani'], [0x4e00, 0x9fff, 'Hani'],
    [0xa000, 0xa4cf, 'Yiii'], [0xa4d0, 0xa4ff, 'Lisu'], [0xa500, 0xa63f, 'Vaii'],
    [0xa640, 0xa69f, 'Cyrl'], [0xa6a0, 0xa6ff, 'Bamu'], [0xa720, 0xa721, 'Zyyy'],
    [0xa722, 0xa7ff, 'Latn'], [0xa800, 0xa82f, 'Sylo'], [0xa840, 0xa87f, 'Phag'],
    [0xa880, 0xa8df, 'Saur'], [0xa8e0, 0xa8ff, 'Deva'], [0xa900, 0xa92f, 'Kali'],
    [0xa930, 0xa95f, 'Rjng'], [0xa960, 0xa97f, 'Hang'], [0xa980, 0xa9df, 'Java'],
    [0xaa00, 0xaa5f, 'Cham'], [0xaa60, 0xaa7f, 'Mymr'], [0xaa80, 0xaadf, 'Tavt'],
    [0xab00, 0xab2f, 'Ethi'], [0xabc0, 0xabff, 'Mtei'], [0xac00, 0xd7ff, 'Hang'],
    [0xf900, 0xfaff, 'Hani'], [0xfb00, 0xfb06, 'Latn'], [0xfb13, 0xfb17, 'Armn'],
    [0xfb1d, 0xfb4f, 'Hebr'], [0xfb50, 0xfdff, 'Arab'], [0xfe00, 0xfe0f, 'Zinh'],
    [0xfe20, 0xfe2f, 'Zinh'], [0xfe70, 0xfefe, 'Arab'], [0xff21, 0xff3a, 'Latn'],
    [0xff41, 0xff5a, 'Latn'], [0xff66, 0xff6f, 'Kana'], [0xff71, 0xff9d, 'Kana'],
    [0xffa0, 0xffdc, 'Hang'],
]);

/** A code point's script, by number. @param {number} code */
export function scriptOf(code){
    let low = 0;
    let high = SCRIPT_RANGES.length - 1;
    while (low <= high)
    {
        const middle = (low + high) >> 1;
        const [first, last, script] = SCRIPT_RANGES[middle];
        if (code < first)
        {
            high = middle - 1;
        }
        else if (code > last)
        {
            low = middle + 1;
        }
        else
        {
            return SCRIPT[script];
        }
    }
    return SCRIPT.Zyyy;
}

/** DWRITE_SCRIPT_SHAPES: what a run's glyphs look like. */
export const SHAPES = Object.freeze({ DEFAULT: 0, NO_VISUAL: 1 });

/**
 * Characters drawn as nothing: controls, format characters, the line and
 * paragraph separators. @param {number} code
 */
export const isInvisible = code=>code < 0x20 || (code >= 0x7f && code < 0xa0)
    || code === 0xad || (code >= 0x200b && code <= 0x200f) || (code >= 0x2028 && code <= 0x202e)
    || (code >= 0x2060 && code <= 0x206f) || code === 0xfeff
    || (code >= 0x1d173 && code <= 0x1d17a) || (code >= 0xe0000 && code <= 0xe007f);

/** The code points of UTF-16 text, each with where it starts and its length. @param {string} text */
export function codePoints(text){
    /** @type {{ code: number, at: number, units: number }[]} */
    const out = [];
    for (let at = 0; at < text.length;)
    {
        const code = text.codePointAt(at) ?? 0;
        const units = code > 0xffff ? 2 : 1;
        out.push({ code, at, units });
        at += units;
    }
    return out;
}

/**
 * The text cut into runs of one script and one kind of shape, Common and
 * Inherited taken into the run beside them.
 *
 * @param {string} text
 * @returns {{ at: number, length: number, script: number, shapes: number }[]}
 */
export function itemize(text){
    const points = codePoints(text);
    /** @type {{ at: number, length: number, script: number, shapes: number }[]} */
    const runs = [];
    for (const { code, at, units } of points)
    {
        const own = scriptOf(code);
        const shapes = isInvisible(code) ? SHAPES.NO_VISUAL : SHAPES.DEFAULT;
        const last = runs[runs.length - 1];
        const neutral = own === SCRIPT.Zyyy || own === SCRIPT.Zinh;
        if (last && last.shapes === shapes && (neutral || last.script === own
            || last.script === SCRIPT.Zyyy))
        {
            if (!neutral)
            {
                last.script = own;
            }
            last.length += units;
            continue;
        }
        runs.push({ at, length: units, script: own === SCRIPT.Zinh ? SCRIPT.Zyyy : own, shapes });
    }
    return runs;
}

/** Bidi classes the levels are resolved from. */
const STRONG_RTL = new Set([SCRIPT.Arab, SCRIPT.Hebr, SCRIPT.Syrc, SCRIPT.Thaa, SCRIPT.Nkoo,
    SCRIPT.Samr, SCRIPT.Mand]);

/** Explicit embedding controls: LRE, RLE, PDF, LRO, RLO. */
const LRE = 0x202a;
const RLE = 0x202b;
const PDF = 0x202c;
const LRO = 0x202d;
const RLO = 0x202e;
/** The deepest embedding the algorithm allows. */
const MAX_DEPTH = 125;

/** @param {number} code @returns {'L' | 'R' | 'AL' | 'EN' | 'AN' | 'BN' | 'N'} */
function bidiClass(code){
    if (code >= 0x30 && code <= 0x39)
    {
        return 'EN';
    }
    if ((code >= 0x660 && code <= 0x669) || (code >= 0x6f0 && code <= 0x6f9))
    {
        return code >= 0x6f0 ? 'EN' : 'AN';
    }
    // Boundary neutrals: joiners, format characters and the controls themselves,
    // left out when the levels are resolved and given their neighbour's after.
    if ((code >= 0x200b && code <= 0x200d) || (code >= 0x2060 && code <= 0x2064)
        || code === 0xfeff || code === 0xad || (code >= LRE && code <= RLO))
    {
        return 'BN';
    }
    const script = scriptOf(code);
    if (STRONG_RTL.has(script))
    {
        return script === SCRIPT.Hebr ? 'R' : 'AL';
    }
    return script === SCRIPT.Zyyy || script === SCRIPT.Zinh ? 'N' : 'L';
}

/**
 * Each UTF-16 unit's explicit (embedding) and resolved bidi level, the
 * paragraph at `base` (0 left to right, 1 right to left).
 *
 * The explicit level is the embedding the controls open; a control stands at
 * the level it opens or, a PDF, closes. Strong characters resolve to their
 * direction's level above the embedding, numbers to the level above left to
 * right text, neutrals to the direction of the strong text around them where
 * both sides agree and the embedding's where they do not; a boundary neutral
 * takes the level of the character before it, the paragraph's at the start.
 *
 * @param {string} text @param {number} base
 * @returns {{ explicit: Uint8Array, resolved: Uint8Array }}
 */
export function bidiLevels(text, base){
    const points = codePoints(text);
    const classes = points.map(point=>bidiClass(point.code));
    /** @type {number[]} */
    const stack = [base];
    const embedding = points.map(({ code })=>{
        const current = stack[stack.length - 1];
        if (code === LRE || code === LRO || code === RLE || code === RLO)
        {
            const rtl = code === RLE || code === RLO;
            const next = rtl ? (current + 1) | 1 : (current + 2) & ~1;
            if (next <= MAX_DEPTH)
            {
                stack.push(next);
                return next;
            }
            return current;
        }
        if (code === PDF && stack.length > 1)
        {
            stack.pop();
        }
        return current;
    });
    // W2: a European number after Arabic letters is an Arabic number; W7:
    // after left to right text (or at the start of a left to right
    // embedding) it is left to right text.
    let lastStrong = '';
    classes.forEach((kind, i)=>{
        if (kind === 'L' || kind === 'R' || kind === 'AL')
        {
            lastStrong = kind;
        }
        else if (kind === 'EN')
        {
            const strong = lastStrong || (embedding[i] % 2 ? 'R' : 'L');
            classes[i] = strong === 'AL' ? 'AN' : strong === 'L' ? 'L' : 'EN';
        }
    });
    // N1: numbers count as right to left text for the neutrals beside them.
    /** @param {string} kind */
    const direction = kind=>(kind === 'L' ? 'L' : kind === 'N' ? 'N' : 'R');
    /**
     * The nearest class that is not a neutral, a step at a time, or null at
     * the text's end.
     *
     * @param {number} i @param {number} step
     */
    const nearest = (i, step)=>{
        let at = i + step;
        while (at >= 0 && at < classes.length && (classes[at] === 'N' || classes[at] === 'BN'))
        {
            at += step;
        }
        return at >= 0 && at < classes.length ? classes[at] : null;
    };
    const explicit = new Uint8Array(text.length);
    const resolved = new Uint8Array(text.length);
    let previous = base;
    points.forEach(({ at, units }, i)=>{
        const kind = classes[i];
        const e = embedding[i];
        const odd = e % 2 === 1;
        let level;
        if (kind === 'BN')
        {
            level = previous;
        }
        else if (kind === 'L')
        {
            level = odd ? e + 1 : e;
        }
        else if (kind === 'R' || kind === 'AL')
        {
            level = odd ? e : e + 1;
        }
        else if (kind === 'EN' || kind === 'AN')
        {
            level = odd ? e + 1 : e + 2;
        }
        else
        {
            const own = odd ? 'R' : 'L';
            const left = direction(nearest(i, -1) ?? own);
            const right = direction(nearest(i, 1) ?? own);
            const side = left === right ? left : own;
            level = side === 'R' ? (odd ? e : e + 1) : (odd ? e + 1 : e);
        }
        previous = level;
        explicit.fill(e, at, at + units);
        resolved.fill(level, at, at + units);
    });
    return { explicit, resolved };
}

/** DWRITE_BREAK_CONDITION. */
export const BREAK = Object.freeze({ NEUTRAL: 0, CAN_BREAK: 1, MAY_NOT_BREAK: 2,
    MUST_BREAK: 3 });

/** @param {number} code */
const isSpace = code=>code === 0x20 || code === 0x09 || code === 0x3000
    || (code >= 0x2000 && code <= 0x200a && code !== 0x2007) || code === 0x205f;
/** Unicode's White_Space property: what a breakpoint marks as white space. @param {number} code */
const isWhiteSpace = code=>(code >= 0x09 && code <= 0x0d) || code === 0x20 || code === 0x85
    || code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a)
    || code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f
    || code === 0x3000;
/** @param {number} code */
const isMandatory = code=>code === 0x0a || code === 0x0b || code === 0x0c || code === 0x0d
    || code === 0x85 || code === 0x2028 || code === 0x2029;
/** Ideographs and kana, between which a line may break anywhere. @param {number} code */
const isIdeographic = code=>(code >= 0x2e80 && code <= 0x9fff) || (code >= 0xac00
    && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00
    && code <= 0xffef);
/** Glue that never breaks: no-break spaces, the word joiner. @param {number} code */
const isGlue = code=>code === 0xa0 || code === 0x202f || code === 0x2060 || code === 0xfeff
    || code === 0x2007 || code === 0x200d;
/** Hyphens and break-after marks (UAX #14's HY and BA): a line may break after them. */
const BREAK_AFTER = new Set([0x2d, 0xad, 0x58a, 0x5be, 0xf0b, 0x1361, 0x17d8, 0x17da, 0x2010,
    0x2012, 0x2013, 0x200b, 0x2027, 0x1680, 0x2cfa, 0x2cfb]);
/** Opening punctuation (OP): no break after, none before after a letter or number. */
const OPENING = new Set([0x28, 0x5b, 0x7b, 0xa1, 0xbf, 0x2045, 0x207d, 0x208d, 0x3008, 0x300a,
    0x300c, 0x300e, 0x3010, 0x3014, 0x3016, 0x3018, 0x301a, 0x301d, 0xff08, 0xff3b, 0xff5b,
    0xff5f, 0xff62]);
/** Closing punctuation (CL, CP): no break before. */
const CLOSING = new Set([0x29, 0x5d, 0x7d, 0x2046, 0x207e, 0x208e, 0x3001, 0x3002, 0x3009,
    0x300b, 0x300d, 0x300f, 0x3011, 0x3015, 0x3017, 0x3019, 0x301b, 0x301e, 0x301f, 0xff09,
    0xff0c, 0xff0e, 0xff3d, 0xff5d, 0xff60, 0xff61, 0xff63]);
/** A letter or a number that is not an ideograph (UAX #14's AL and NU). @param {number} code */
const isAlphanumeric = code=>!isIdeographic(code) && (scriptOf(code) !== SCRIPT.Zyyy
    || (code >= 0x30 && code <= 0x39));

/**
 * Each UTF-16 unit's DWRITE_LINE_BREAKPOINT byte: the break condition before
 * and after it, whether it is white space, whether it is a soft hyphen. No
 * line breaks before the text's first character.
 *
 * @param {string} text
 * @returns {Uint8Array}
 */
export function lineBreakpoints(text){
    const points = codePoints(text);
    const out = new Uint8Array(text.length);
    /** @type {number[]} */
    const after = points.map(({ code }, i)=>{
        const next = points[i + 1]?.code;
        if (isMandatory(code))
        {
            return code === 0x0d && next === 0x0a ? BREAK.MAY_NOT_BREAK : BREAK.MUST_BREAK;
        }
        if (next === undefined)
        {
            return BREAK.CAN_BREAK;
        }
        if (isGlue(code) || isGlue(next) || isMandatory(next) || isSpace(next)
            || scriptOf(next) === SCRIPT.Zinh || CLOSING.has(next) || OPENING.has(code)
            || (OPENING.has(next) && isAlphanumeric(code)))
        {
            return BREAK.MAY_NOT_BREAK;
        }
        if (isSpace(code) || BREAK_AFTER.has(code))
        {
            return BREAK.CAN_BREAK;
        }
        if (isIdeographic(code) || isIdeographic(next) || OPENING.has(next))
        {
            return BREAK.CAN_BREAK;
        }
        return BREAK.MAY_NOT_BREAK;
    });
    points.forEach(({ code, at, units }, i)=>{
        const before = i === 0 ? BREAK.MAY_NOT_BREAK : after[i - 1];
        const byte = before | after[i] << 2 | (isWhiteSpace(code) ? 0x10 : 0)
            | (code === 0xad ? 0x20 : 0);
        out.fill(byte, at, at + units);
        if (units === 2)
        {
            // Within a surrogate pair no line breaks.
            out[at] = before | BREAK.MAY_NOT_BREAK << 2;
            out[at + 1] = BREAK.MAY_NOT_BREAK | after[i] << 2;
        }
    });
    return out;
}

/** Characters a right to left run draws mirrored. */
const MIRRORS = new Map([[0x28, 0x29], [0x29, 0x28], [0x3c, 0x3e], [0x3e, 0x3c], [0x5b, 0x5d],
    [0x5d, 0x5b], [0x7b, 0x7d], [0x7d, 0x7b], [0xab, 0xbb], [0xbb, 0xab], [0x2039, 0x203a],
    [0x203a, 0x2039], [0x2045, 0x2046], [0x2046, 0x2045], [0x207d, 0x207e], [0x207e, 0x207d],
    [0x2264, 0x2265], [0x2265, 0x2264]]);

/** A character as a right to left run draws it. @param {number} code */
export const mirrored = code=>MIRRORS.get(code) ?? code;

/** SCRIPT_JUSTIFY: where a glyph takes the room justification adds. */
export const JUSTIFY = Object.freeze({ NONE: 0, ARABIC_BLANK: 1, CHARACTER: 2, BLANK: 4,
    ARABIC_NORMAL: 7, ARABIC_KASHIDA: 8, ARABIC_ALEF: 9, ARABIC_HA: 10, ARABIC_RA: 11,
    ARABIC_BA: 12, ARABIC_BARA: 13, ARABIC_SEEN: 14, ARABIC_SEEN_M: 15 });

/** Arabic letters that join only the letter before them (right-joining). */
const RIGHT_JOINING = new Set([0x622, 0x623, 0x624, 0x625, 0x627, 0x629, 0x62f, 0x630, 0x631,
    0x632, 0x648, 0x671, 0x672, 0x673, 0x675, 0x676, 0x677, 0x688, 0x689, 0x68a, 0x68b, 0x68c,
    0x68d, 0x68e, 0x68f, 0x690, 0x691, 0x692, 0x693, 0x694, 0x695, 0x696, 0x697, 0x698, 0x699,
    0x6c0, 0x6c3, 0x6c4, 0x6c5, 0x6c6, 0x6c7, 0x6c8, 0x6c9, 0x6ca, 0x6cb, 0x6cd, 0x6cf, 0x6d2,
    0x6d3, 0x6d5, 0x6ee, 0x6ef]);
/** @param {number} code */
const isArabicLetter = code=>(code >= 0x620 && code <= 0x64a) || (code >= 0x66e && code <= 0x6d3)
    || code === 0x6d5 || (code >= 0x6fa && code <= 0x6fc) || code === 0x6ff;
/** Joins the letter after it: dual-joining letters and the tatweel. @param {number} code */
const joinsAfter = code=>code === 0x640 || (isArabicLetter(code) && code !== 0x621
    && !RIGHT_JOINING.has(code));
/** Joins the letter before it. @param {number} code */
const joinsBefore = code=>code === 0x640 || (isArabicLetter(code) && code !== 0x621);
const ALEFS = new Set([0x622, 0x623, 0x625, 0x627, 0x671, 0x672, 0x673, 0x675]);
const HAS = new Set([0x629, 0x647, 0x6c0, 0x6c1, 0x6d5]);
const RAS = new Set([0x631, 0x632, 0x691, 0x692, 0x693, 0x694, 0x695, 0x696, 0x697, 0x698,
    0x699]);
const SEENS = new Set([0x633, 0x634, 0x635, 0x636, 0x69a, 0x69b, 0x69c, 0x69d, 0x69e, 0x6fa,
    0x6fb]);

/**
 * Each code point's justification class, Uniscribe's way: blanks take the
 * room in Latin text; in Arabic text the tatweel and the letters by their
 * joined shape - an alef, a heh or a reh ending a join, a seen beginning or
 * inside one - and a final letter otherwise.
 *
 * @param {number[]} codes @param {boolean} arabic  the run is of the Arabic script
 * @returns {number[]}
 */
export function justification(codes, arabic){
    return codes.map((code, i)=>{
        if (isSpace(code))
        {
            return arabic ? JUSTIFY.ARABIC_BLANK : JUSTIFY.BLANK;
        }
        if (!arabic)
        {
            return JUSTIFY.CHARACTER;
        }
        if (code === 0x640)
        {
            return JUSTIFY.ARABIC_KASHIDA;
        }
        if (!isArabicLetter(code))
        {
            return JUSTIFY.NONE;
        }
        const before = i > 0 && joinsAfter(codes[i - 1]) && joinsBefore(code);
        const after = i + 1 < codes.length && joinsAfter(code) && joinsBefore(codes[i + 1]);
        if (SEENS.has(code) && after)
        {
            return before ? JUSTIFY.ARABIC_SEEN_M : JUSTIFY.ARABIC_SEEN;
        }
        if (!before)
        {
            return JUSTIFY.NONE;
        }
        if (after)
        {
            return JUSTIFY.NONE;
        }
        return ALEFS.has(code) ? JUSTIFY.ARABIC_ALEF : HAS.has(code) ? JUSTIFY.ARABIC_HA
            : RAS.has(code) ? JUSTIFY.ARABIC_BARA : JUSTIFY.ARABIC_NORMAL;
    });
}
