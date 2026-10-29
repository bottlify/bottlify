/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The printf format engine, shared by every function that renders one.
 *
 * It is deliberately free of guest memory: strings are fetched through a
 * callback, so the engine is a pure function of its format and its arguments
 * and can be tested without a machine underneath it.
 *
 * The part that is easy to get wrong is not the conversions but the *width* of
 * each argument. Under cdecl the variadic tail is a run of stack slots, and a
 * conversion consumes one, two, or none of them. A double is pushed as eight
 * bytes and `%I64d` takes eight; read either as four and every argument after
 * it is off by a slot, which prints plausible numbers that are somebody else's.
 * That is why the length modifier is parsed rather than skipped.
 *
 * A program's own diagnostics come through here. A formatter that is subtly
 * wrong does not fail -- it produces text that misleads whoever reads it, which
 * is worse than producing none.
 */

/** What msvcrt prints for a null pointer passed to %s. */
const NULL_STRING = '(null)';

/** How far a string argument is followed before we give up on a terminator. */
const MAX_STRING = 1 << 20;

/**
 * @typedef {Object} Spec
 * @property {boolean} leftAlign
 * @property {boolean} zeroPad
 * @property {boolean} plus       Print a sign even when the value is positive.
 * @property {boolean} space      A blank where that sign would have been.
 * @property {boolean} alt        The '#' flag: 0x on hex, a leading 0 on octal,
 *                                a point on a float that has no fraction.
 * @property {number} width       Negative is impossible; '*' with a negative
 *                                argument becomes left alignment instead.
 * @property {number} precision   -1 when the format gave none.
 * @property {boolean} wide       This conversion's string or char is UTF-16.
 * @property {boolean} narrow     ...or explicitly not, overriding the default.
 * @property {boolean} short      `h`: an integer is its low sixteen bits.
 * @property {boolean} familyWide The format belongs to the wprintf family,
 *                                where an unmodified %s is wide and %S is not.
 * @property {boolean} sixtyFour  The argument occupies two stack slots.
 * @property {string} conversion  Empty when the format ended mid-specifier.
 * @property {number} end         Index just past the specifier.
 */

/** @param {string} character */
const isDigit = character=>character >= '0' && character <= '9';

/** The integer conversions, which alone take `I`, `z` and `t` as a size. */
const INTEGERS = 'diouxX';

/**
 * @param {string} format
 * @param {number} start   Index of the character after the '%'.
 * @param {() => number} take  For a width or precision written as '*'.
 * @returns {Spec}
 */
function parseSpec(format, start, take){
    let i = start;
    let leftAlign = false;
    let zeroPad = false;
    let plus = false;
    let space = false;
    let alt = false;

    for (;;)
    {
        const flag = format[i];
        if (flag === '-')
        {
            leftAlign = true;
        }
        else if (flag === '0')
        {
            zeroPad = true;
        }
        else if (flag === '+')
        {
            plus = true;
        }
        else if (flag === ' ')
        {
            space = true;
        }
        else if (flag === '#')
        {
            alt = true;
        }
        else
        {
            break;
        }
        i++;
    }

    // A width given as '*' goes on taking the digits after it, as msvcrt
    // reads one: "%*1d" with 1 is a width of eleven.
    let width = 0;
    if (format[i] === '*')
    {
        // A negative width is how a caller asks for left alignment without
        // knowing it at compile time.
        const given = take() | 0;
        if (given < 0)
        {
            leftAlign = true;
            width = -given;
        }
        else
        {
            width = given;
        }
        i++;
    }
    while (isDigit(format[i]))
    {
        width = width * 10 + Number(format[i]);
        i++;
    }

    let precision = -1;
    if (format[i] === '.')
    {
        i++;
        if (format[i] === '*')
        {
            const given = take() | 0;
            // C says a negative precision is as if none were given at all.
            precision = given < 0 ? -1 : given;
            i++;
        }
        else
        {
            precision = 0;
            while (isDigit(format[i]))
            {
                precision = precision * 10 + Number(format[i]);
                i++;
            }
        }
    }

    // The length modifiers decide how many stack slots the argument occupies
    // and, for strings and characters, how wide its elements are; msvcrt
    // takes any run of them. On a 32-bit target `long` and `int` are the same
    // size, so `l` says nothing about the slot count -- but `ll`, `L`, `I64`
    // and `j` each say the argument is eight bytes, and reading four would
    // leave everything after it misaligned. `I` alone, `z` and `t` are a
    // size only before an integer conversion; anywhere else the letter is
    // itself the conversion msvcrt does not know. `F` and `N` are the far
    // and near of a pointer, which a flat address space has no use for.
    let sawH = false;
    let sawL = false;
    let sawW = false;
    let sixtyFour = false;
    for (;;)
    {
        const modifier = format[i];
        if (modifier === 'h')
        {
            sawH = true;
        }
        else if (modifier === 'l')
        {
            if (format[i + 1] === 'l')
            {
                sixtyFour = true;
                i++;
            }
            else
            {
                sawL = true;
            }
        }
        else if (modifier === 'w')
        {
            sawW = true;
        }
        else if (modifier === 'L' || modifier === 'j')
        {
            sixtyFour = true;
        }
        else if (modifier === 'F' || modifier === 'N')
        {
            // Far and near: nothing to a flat address.
        }
        else if (modifier === 'I' && format[i + 1] === '6' && format[i + 2] === '4')
        {
            sixtyFour = true;
            i += 2;
        }
        else if (modifier === 'I' && format[i + 1] === '3' && format[i + 2] === '2')
        {
            i += 2;
        }
        else if ((modifier === 'I' || modifier === 'z' || modifier === 't')
            && i + 1 < format.length && INTEGERS.includes(format[i + 1]))
        {
            // size_t and ptrdiff_t: four bytes here.
        }
        else
        {
            break;
        }
        i++;
    }

    return {
        leftAlign,
        zeroPad,
        plus,
        space,
        alt,
        width,
        precision,
        wide: sawW || (sawL && !sawH),
        narrow: sawH && !sawW,
        short: sawH,
        familyWide: false,
        sixtyFour,
        conversion: i < format.length ? format[i] : '',
        end: i + 1,
    };
}

/**
 * Whether a string or character conversion reads UTF-16: an explicit
 * modifier decides, and otherwise the capital form is the opposite of the
 * family's own width, which is what makes it useful at all.
 *
 * @param {Spec} spec
 */
const wideText = spec=>{
    if (spec.narrow)
    {
        return false;
    }
    if (spec.wide)
    {
        return true;
    }
    const capital = spec.conversion === 'S' || spec.conversion === 'C';
    return capital !== spec.familyWide;
};

/**
 * @typedef {Object} Rendered
 * @property {string} prefix    A sign or radix mark, which zero padding must
 *                              not push right.
 * @property {string} body
 * @property {boolean} zeroable Whether the '0' flag pads it with zeros: every
 *                              conversion but a pointer, and an integer with
 *                              no precision.
 */

/**
 * The sign an integer or float carries, given the flags.
 *
 * @param {boolean} negative @param {Spec} spec
 */
const signOf = (negative, spec)=>{
    if (negative)
    {
        return '-';
    }
    // '+' wins over ' ' when a format asks for both, which is what every
    // implementation does and what C requires.
    return spec.plus ? '+' : spec.space ? ' ' : '';
};

/**
 * Digits, with the precision applied.
 *
 * A precision of zero and a value of zero produce nothing at all -- a rule that
 * looks like a mistake until a program uses it to print a column of blanks.
 *
 * @param {bigint} value @param {number} radix @param {Spec} spec
 */
function digits(value, radix, spec){
    if (spec.precision === 0 && value === 0n)
    {
        return '';
    }
    return value.toString(radix).padStart(Math.max(spec.precision, 0), '0');
}

/**
 * A double as its two stack slots and its value: the bits say which NaN it
 * is, which the value does not keep.
 *
 * @typedef {Object} DoubleArgument
 * @property {number} value
 * @property {number} high  The upper word: the sign, the exponent, the top of
 *                          the fraction.
 * @property {number} low
 */

/** The largest count of significant digits msvcrt converts a double to. */
const SIGNIFICANT = 17;

/**
 * What msvcrt's conversion makes of a value that is no number: digits that
 * are not digits, "1#INF", "1#QNAN", "1#SNAN", or "1#IND" for the quiet NaN
 * with the sign and no payload that the x87 answers an invalid operation
 * with -- rounded and padded as any digits are, so that three places of an
 * infinity are "1#INF" cut to "1#J".
 *
 * @param {DoubleArgument} argument
 * @returns {string | null}
 */
function specialDigits({ value, high, low }){
    if (Number.isFinite(value))
    {
        return null;
    }
    const fraction = (high & 0xfffff) >>> 0;
    if (fraction === 0 && low === 0)
    {
        return '1#INF';
    }
    const quiet = (fraction & 0x80000) !== 0;
    if (!quiet)
    {
        return '1#SNAN';
    }
    return high >>> 31 === 1 && fraction === 0x80000 && low === 0 ? '1#IND' : '1#QNAN';
}

/**
 * Rounds a digit string at `count` characters, half up on the character
 * after the last kept: an increment is the next character code, so a '9'
 * carries and a '#' becomes '$'. Past its end the string is zeros.
 *
 * @param {string} text @param {number} count
 * @returns {{ text: string, carry: boolean }}
 */
function roundDigits(text, count){
    if (count >= text.length)
    {
        return { text: text.padEnd(count, '0'), carry: false };
    }
    if (count < 0 || text[count] < '5')
    {
        return { text: text.slice(0, Math.max(count, 0)), carry: false };
    }
    const kept = [...text.slice(0, count)];
    let at = count - 1;
    while (at >= 0 && kept[at] === '9')
    {
        kept[at] = '0';
        at--;
    }
    if (at < 0)
    {
        return { text: kept.join(''), carry: true };
    }
    kept[at] = String.fromCharCode(kept[at].charCodeAt(0) + 1);
    return { text: kept.join(''), carry: false };
}

/**
 * The digits `_ecvt` answers -- `count` significant ones -- or `_fcvt` --
 * those through `count` places after the point -- with where the point falls
 * among them and the sign. msvcrt converts a double to seventeen significant
 * digits and rounds those; any digit past the seventeenth is a zero. A value
 * that rounds to nothing under `_fcvt` keeps its own point.
 *
 * @param {DoubleArgument} argument @param {number} count @param {boolean} fixed
 * @returns {{ digits: string, point: number, negative: boolean }}
 */
export function cvtDigits(argument, count, fixed){
    const negative = argument.high >>> 31 === 1;
    const special = specialDigits(argument);
    if (special === null && argument.value === 0)
    {
        return { digits: '0'.repeat(Math.max(count, 0)), point: 0, negative };
    }
    let text = special ?? '';
    let point = 1;
    if (special === null)
    {
        const [mantissa, exponent] = Math.abs(argument.value).toExponential(SIGNIFICANT - 1)
            .split('e');
        text = mantissa.replace('.', '');
        point = Number(exponent) + 1;
    }
    const wanted = fixed ? point + count : count;
    const rounded = roundDigits(text, wanted);
    if (!rounded.carry)
    {
        return { digits: rounded.text, point, negative };
    }
    // Carried out of the first digit: a one where nothing stood, the point a
    // place further on -- and under _fcvt a place more to fill.
    const length = fixed ? wanted : wanted - 1;
    return { digits: length < 0 ? '' : `1${'0'.repeat(length)}`, point: point + 1, negative };
}

/**
 * %f's text from its digits: the whole part, or 0, and `precision` places.
 *
 * @param {DoubleArgument} argument @param {number} precision @param {boolean} alt
 */
function fixedText(argument, precision, alt){
    const { digits: text, point } = cvtDigits(argument, precision, true);
    const whole = point > 0 ? text.slice(0, point) : '0';
    const fraction = point > 0 ? text.slice(point)
        : '0'.repeat(Math.min(precision, -point)) + text;
    return precision > 0 || alt ? `${whole}.${fraction}` : whole;
}

/**
 * %e's: one digit, `precision` places and an exponent of three digits at
 * least, as msvcrt writes it -- two under `_set_output_format`'s
 * `_TWO_DIGIT_EXPONENT`.
 *
 * @param {DoubleArgument} argument @param {number} precision @param {boolean} alt
 * @param {string} e  The exponent's letter, in the conversion's case.
 * @param {number} least  The exponent's least digits.
 */
function exponentText(argument, precision, alt, e, least){
    const { digits: text, point } = cvtDigits(argument, precision + 1, false);
    const exponent = argument.value === 0 ? 0 : point - 1;
    const mantissa = precision > 0 || alt ? `${text[0]}.${text.slice(1)}` : text[0];
    return `${mantissa}${e}${exponent < 0 ? '-' : '+'}${String(Math.abs(exponent))
        .padStart(least, '0')}`;
}

/**
 * @param {DoubleArgument} argument
 * @param {Spec} spec
 * @param {number} least  The exponent's least digits.
 * @returns {Rendered}
 */
function convertFloat(argument, spec, least){
    const negative = argument.high >>> 31 === 1;
    const upper = spec.conversion !== spec.conversion.toLowerCase();
    const e = upper ? 'E' : 'e';
    let body;
    switch (spec.conversion.toLowerCase()){
        case 'e':
            body = exponentText(argument, spec.precision < 0 ? 6 : spec.precision, spec.alt, e,
                least);
            break;
        case 'g': {
            // The precision counts significant digits, zero of them one; the
            // exponent the value has at that count chooses the form, and the
            // zeros that end the fraction go unless '#' keeps them.
            const count = spec.precision < 0 ? 6 : Math.max(spec.precision, 1);
            const { point } = cvtDigits(argument, count, false);
            const exponent = argument.value === 0 ? 0 : point - 1;
            body = exponent < -4 || exponent >= count
                ? exponentText(argument, count - 1, spec.alt, e, least)
                : fixedText(argument, count - 1 - exponent, spec.alt);
            if (!spec.alt)
            {
                body = body.replace(/\.([^e]*?)0+(?=$|[eE])/, '.$1').replace(/\.(?=$|[eE])/, '');
            }
            break;
        }
        default:
            body = fixedText(argument, spec.precision < 0 ? 6 : spec.precision, spec.alt);
    }
    return { prefix: signOf(negative, spec), body, zeroable: true };
}

/**
 * @param {Spec} spec
 * @param {Object} source
 * @param {() => number} source.take       Next stack slot, signed.
 * @param {() => bigint} source.takeWide   Next argument as a 64-bit value.
 * @param {() => DoubleArgument} source.takeDouble
 * @param {(pointer: number, wide: boolean) => string} source.readText
 * @param {(pointer: number, wide: boolean) => string | null} source.readCounted
 *        An ANSI_STRING's or UNICODE_STRING's text; null for none.
 * @param {(code: number, wide: boolean) => string} source.character  A %c's text.
 * @param {number} source.exponentDigits  The least digits of %e's exponent.
 * @param {number} produced                Characters written so far, for %n.
 * @param {(pointer: number, value: number) => void} writeCount
 * @returns {Rendered | null}   Null when the conversion is not one we know.
 */
function convert(spec, source, produced, writeCount){
    const { take, takeWide, takeDouble, readText, readCounted, character } = source;
    /** An integer's value, 64 bits or 32, or `h`'s 16. @param {boolean} signed */
    const integer = signed=>{
        if (spec.sixtyFour)
        {
            return signed ? takeWide() : BigInt.asUintN(64, takeWide());
        }
        const slot = take();
        if (spec.short)
        {
            return BigInt(signed ? slot << 16 >> 16 : slot & 0xffff);
        }
        return BigInt(signed ? slot | 0 : slot >>> 0);
    };
    switch (spec.conversion){
        case '%':
            return { prefix: '', body: '%', zeroable: true };
        case 'c':
        case 'C': {
            const wide = wideText(spec);
            const body = character(take() & (wide ? 0xffff : 0xff), wide);
            return { prefix: '', body, zeroable: true };
        }
        case 's':
        case 'S': {
            const pointer = take() >>> 0;
            const text = pointer === 0 ? NULL_STRING : readText(pointer, wideText(spec));
            const body = spec.precision >= 0 ? text.slice(0, spec.precision) : text;
            return { prefix: '', body, zeroable: true };
        }
        case 'Z': {
            // A counted string: ANSI_STRING, or UNICODE_STRING with `w`.
            const pointer = take() >>> 0;
            const text = pointer === 0 ? null : readCounted(pointer, spec.wide);
            const whole = text ?? NULL_STRING;
            const body = spec.precision >= 0 ? whole.slice(0, spec.precision) : whole;
            return { prefix: '', body, zeroable: true };
        }
        case 'd':
        case 'i': {
            const value = integer(true);
            const negative = value < 0n;
            const body = digits(negative ? -value : value, 10, spec);
            return { prefix: signOf(negative, spec), body, zeroable: spec.precision < 0 };
        }
        case 'u':
            return { prefix: '', body: digits(integer(false), 10, spec),
                zeroable: spec.precision < 0 };
        case 'o': {
            const body = digits(integer(false), 8, spec);
            // '#' on octal means "make sure it starts with a zero", not "add
            // one" -- a value that already does gets no second.
            const prefixed = spec.alt && body[0] !== '0' ? `0${body}` : body;
            return { prefix: '', body: prefixed, zeroable: spec.precision < 0 };
        }
        case 'x':
        case 'X': {
            const value = integer(false);
            let body = digits(value, 16, spec);
            if (spec.conversion === 'X')
            {
                body = body.toUpperCase();
            }
            // No radix mark on a zero: there is no hexadecimal zero to mark.
            const prefix = spec.alt && value !== 0n
                ? (spec.conversion === 'X' ? '0X' : '0x')
                : '';
            return { prefix, body, zeroable: spec.precision < 0 };
        }
        case 'p': {
            // Eight upper-case digits, always, '#' marking them 0X. This
            // runtime does not pad a pointer to the field width with zeros
            // the way it does a number.
            const body = (take() >>> 0).toString(16).toUpperCase().padStart(8, '0');
            return { prefix: spec.alt ? '0X' : '', body, zeroable: false };
        }
        case 'e':
        case 'E':
        case 'f':
        case 'g':
        case 'G':
            return convertFloat(takeDouble(), spec, source.exponentDigits);
        case 'n': {
            // The only conversion that writes rather than reads. It produces no
            // output, which is why it returns an empty body rather than null.
            writeCount(take() >>> 0, produced);
            return { prefix: '', body: '', zeroable: false };
        }
        default:
            return null;
    }
}

/**
 * @param {Spec} spec
 * @param {Rendered} rendered
 */
function pad(spec, { prefix, body, zeroable }){
    const missing = spec.width - prefix.length - body.length;
    if (missing <= 0)
    {
        return prefix + body;
    }
    if (spec.leftAlign)
    {
        return prefix + body + ' '.repeat(missing);
    }
    if (spec.zeroPad && zeroable)
    {
        return prefix + '0'.repeat(missing) + body;
    }
    return ' '.repeat(missing) + prefix + body;
}

/**
 * The argument slots behind a `va_list`, read as one block.
 *
 * A `va_list` carries no count, so a fixed window is read and the format
 * decides how much of it is meaningful; the slots past the last argument are
 * never consulted. The window must not run past the end of the region it sits
 * in: a thread's stack has a top, a program formatting from just below it is
 * within its rights -- every argument it reads is there -- and the real
 * runtime touches a slot only when a conversion asks for it. A snapshot that
 * walked off the region turned such a call into a host-side fault. Unreadable
 * slots join the zeros this engine already answers for a format that outran
 * its arguments.
 *
 * @param {(address: number, length: number) => Uint8Array} read
 * @param {(address: number) => { base: number, size: number } | null} locate
 *         The region containing an address; null when nothing does, and then
 *         the whole window is read and a genuinely unmapped list faults there.
 * @param {number} list @param {number} slots
 * @returns {number[]}
 */
export function varargsSlots(read, locate, list, slots){
    const width = slots * 4;
    const at = list >>> 0;
    const region = locate(at);
    const bytes = new Uint8Array(width);
    bytes.set(read(at, region
        ? Math.max(0, Math.min(width, region.base + region.size - at))
        : width));
    const view = new DataView(bytes.buffer);
    return Array.from({ length: slots }, (unused, slot)=>view.getInt32(slot * 4, true));
}

/**
 * What a printer over guest memory hands the engine: %Z's counted string read
 * from it, and %n's count written to it.
 *
 * @param {(address: number, length: number) => Uint8Array} readMemory
 * @param {(address: number, bytes: Uint8Array) => void} writeMemory
 */
export function guestAccess(readMemory, writeMemory){
    return {
        readMemory,
        /** @param {number} pointer @param {number} value */
        writeCount: (pointer, value)=>{
            if (pointer === 0)
            {
                return;
            }
            const bytes = new Uint8Array(4);
            new DataView(bytes.buffer).setInt32(0, value, true);
            writeMemory(pointer, bytes);
        },
    };
}

/**
 * Renders one printf-style format string.
 *
 * @param {string} format
 * @param {number[]} varargs   The variadic tail, as stack slots.
 * @param {(pointer: number) => string} readString  Reads a guest string for %s.
 * @param {Object} [options]
 * @param {(pointer: number) => string} [options.readWideString]
 *        Reads a UTF-16 guest string, for %ls and %S. Absent means a wide
 *        string is read as bytes, which is wrong but visible, rather than
 *        refused.
 * @param {(address: number, length: number) => Uint8Array} [options.readMemory]
 *        Where %Z reads its counted string's length and buffer. Absent, %Z
 *        prints "(null)".
 * @param {(pointer: number, value: number) => void} [options.writeCount]
 *        Where %n stores the count. Absent means %n produces nothing and
 *        writes nothing, which is what a runtime with %n disabled does.
 * @param {number} [options.exponentDigits]
 *        The least digits of %e's exponent: msvcrt's three, or two after
 *        `_set_output_format(_TWO_DIGIT_EXPONENT)`.
 * @param {boolean} [options.wide]
 *        True for the wprintf family, where %s means a wide string by default.
 * @param {boolean} [options.cLocale]
 *        The text is written as bytes under the C locale, which has one for
 *        each character to U+00FF and none past it: a wide string stops
 *        before its first such character, and a wide character that is one
 *        is left out (Wine's msvcrt test_sprintf, where %C of U+3042 writes
 *        nothing, and %S of it nothing on the older runtimes).
 * @param {(bytes: Uint8Array) => string} [options.decodeBytes]
 *        How bytes read as text, as `readString` reads a narrow string's: what
 *        a narrow character's byte is, and in a narrow printer under the C
 *        locale the byte a wide character or string becomes, so that the whole
 *        text is in one page. Absent, a byte is the character of its own code.
 * @returns {string}
 */
export function formatToString(format, varargs, readString, options = {}){
    let out = '';
    let taken = 0;
    // A format string is data the guest may have built at runtime, so it can ask
    // for arguments that were never pushed. Reading those as zero keeps a bad
    // format a wrong string rather than a crash.
    const take = ()=>(taken < varargs.length ? varargs[taken++] | 0 : 0);
    const takeWide = ()=>{
        const low = BigInt(take() >>> 0);
        const high = BigInt(take() | 0);
        return (high << 32n) | low;
    };
    const takeDouble = ()=>{
        const low = take() >>> 0;
        const high = take() >>> 0;
        const bytes = new DataView(new ArrayBuffer(8));
        bytes.setUint32(0, low, true);
        bytes.setUint32(4, high, true);
        return { value: bytes.getFloat64(0, true), high, low };
    };
    const decode = options.decodeBytes
        ?? (bytes=>Array.from(bytes, byte=>String.fromCharCode(byte)).join(''));
    /**
     * Wide text as a narrow printer under the C locale writes it: to its
     * first character with no byte.
     *
     * @param {string} text
     */
    const narrowed = text=>{
        if (!options.cLocale || options.wide)
        {
            return text;
        }
        const unfit = text.search(/[^\0-\xff]/);
        return decode(Uint8Array.from(unfit < 0 ? text : text.slice(0, unfit),
            unit=>unit.charCodeAt(0)));
    };
    /** @param {number} pointer @param {boolean} asWide */
    const readText = (pointer, asWide)=>{
        if (!asWide || !options.readWideString)
        {
            return readString(pointer);
        }
        return narrowed(options.readWideString(pointer));
    };
    /**
     * An ANSI_STRING or UNICODE_STRING: its length in bytes, and its buffer.
     *
     * @param {number} pointer @param {boolean} asWide
     */
    const readCounted = (pointer, asWide)=>{
        const read = options.readMemory;
        if (!read)
        {
            return null;
        }
        const header = new DataView(read(pointer, 8).slice().buffer);
        const length = header.getUint16(0, true);
        const buffer = header.getUint32(4, true);
        if (buffer === 0)
        {
            return null;
        }
        const bytes = read(buffer, length).slice();
        if (!asWide)
        {
            return decode(bytes);
        }
        const units = new Uint16Array(bytes.buffer, 0, length >> 1);
        return narrowed(String.fromCharCode(...units));
    };
    /** @param {number} code @param {boolean} asWide */
    const character = (code, asWide)=>{
        if (asWide && (options.wide || !options.cLocale))
        {
            return String.fromCharCode(code);
        }
        return code > 0xff ? '' : decode(Uint8Array.of(code));
    };

    const source = { take, takeWide, takeDouble, readText, readCounted, character,
        exponentDigits: options.exponentDigits ?? 3 };
    const writeCount = options.writeCount ?? (()=>{});

    for (let i = 0; i < format.length; i++)
    {
        if (format[i] !== '%')
        {
            out += format[i];
            continue;
        }

        const spec = parseSpec(format, i + 1, take);
        spec.familyWide = options.wide === true;
        if (spec.conversion === '')
        {
            // The format ended inside a specification: nothing of it is written.
            break;
        }

        const rendered = convert(spec, source, out.length, writeCount);
        // A conversion msvcrt does not know is written as its own character,
        // the '%' and all that stood between them dropped: "%w0s" is "0s".
        out += rendered ? pad(spec, rendered) : spec.conversion;
        i = spec.end - 1;
    }
    return out;
}

/** Everything this file needs to know about a string's length. */
export { MAX_STRING };

/** One positional conversion: `%`, its index and `$`, what is left of the spec. */
const POSITIONAL = /%(?:(\d+)\$)?([-+ #0]*)(\*(?:(\d+)\$)?|\d*)(?:\.(\*(?:(\d+)\$)?|\d*))?(ll|I64|I32|[hlLwIjzt]*)?(.)/g;

/**
 * A format of the `_p` printers -- `%2$s %1$d`, `%2$*3$s` -- as the ordinary
 * format it amounts to and the arguments in the order that one takes them:
 * each conversion's width, precision and value moved to where it reads them.
 * An argument's slots are known from the conversion that names it, two for a
 * double or a 64-bit integer; one not named by any is taken to be a slot.
 * Null when the format names no position, which the ordinary reading takes.
 *
 * @param {string} format
 * @param {number[]} slots  The arguments as stack slots, in order.
 * @returns {{ format: string, slots: number[] } | null}
 */
export function sequentialArguments(format, slots){
    /** @type {Map<number, number>} the slots each position takes */
    const widths = new Map();
    /** @type {{ value: number, width: number, precision: number }[]} */
    const uses = [];
    let positional = false;
    const rewrite = (/** @type {string} */ whole, /** @type {string=} */ position,
        /** @type {string} */ flags, /** @type {string} */ width, /** @type {string=} */ widthAt,
        /** @type {string=} */ precision, /** @type {string=} */ precisionAt,
        /** @type {string=} */ size, /** @type {string} */ conversion)=>
    {
        if (conversion === '%' && !position)
        {
            return whole;
        }
        positional ||= position !== undefined;
        const value = Number(position ?? 0);
        const isDouble = 'aAeEfgG'.includes(conversion);
        const wideInteger = !isDouble && (size === 'll' || size === 'I64');
        widths.set(value, isDouble || wideInteger ? 2 : 1);
        const at = (/** @type {string | undefined} */ text)=>(text ? Number(text) : 0);
        if (widthAt)
        {
            widths.set(at(widthAt), 1);
        }
        if (precisionAt)
        {
            widths.set(at(precisionAt), 1);
        }
        uses.push({ value, width: at(widthAt), precision: at(precisionAt) });
        return `%${flags}${width.startsWith('*') ? '*' : width}${
            precision === undefined ? '' : `.${precision.startsWith('*') ? '*' : precision}`}${
            size ?? ''}${conversion}`;
    };
    const rewritten = format.replace(POSITIONAL, rewrite);
    if (!positional)
    {
        return null;
    }
    const last = Math.max(...widths.keys());
    /** @type {number[]} */
    const offsets = [];
    for (let position = 1, offset = 0; position <= last; position++)
    {
        offsets[position] = offset;
        offset += widths.get(position) ?? 1;
    }
    /** @param {number} position */
    const argument = position=>slots.slice(offsets[position],
        offsets[position] + (widths.get(position) ?? 1));
    return {
        format: rewritten,
        slots: uses.flatMap(use=>[...use.width ? argument(use.width) : [],
            ...use.precision ? argument(use.precision) : [], ...argument(use.value)]),
    };
}
