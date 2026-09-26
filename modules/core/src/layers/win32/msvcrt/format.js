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
 * @property {boolean} alt        The '#' flag: 0x on hex, a leading 0 on octal.
 * @property {number} width       Negative is impossible; '*' with a negative
 *                                argument becomes left alignment instead.
 * @property {number} precision   -1 when the format gave none.
 * @property {boolean} wide       This conversion's string or char is UTF-16.
 * @property {boolean} narrow     ...or explicitly not, overriding the default.
 * @property {boolean} familyWide The format belongs to the wprintf family,
 *                                where an unmodified %s is wide and %S is not.
 * @property {boolean} sixtyFour  The argument occupies two stack slots.
 * @property {string} conversion  Empty when the format ended mid-specifier.
 * @property {number} end         Index just past the specifier.
 */

/** @param {string} character */
const isDigit = character=>character >= '0' && character <= '9';

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
    else
    {
        while (isDigit(format[i]))
        {
            width = width * 10 + Number(format[i]);
            i++;
        }
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

    // The length modifier decides how many stack slots the argument occupies
    // and, for strings and characters, how wide its elements are. On a 32-bit
    // target `long` and `int` are the same size, so `l` says nothing about the
    // slot count -- but `ll`, `L`, `I64` and `j` each say the argument is eight
    // bytes, and reading four would leave everything after it misaligned.
    let wide = false;
    let narrow = false;
    let sixtyFour = false;
    if (format[i] === 'h')
    {
        narrow = true;
        i++;
        if (format[i] === 'h')
        {
            i++;
        }
    }
    else if (format[i] === 'l')
    {
        wide = true;
        i++;
        if (format[i] === 'l')
        {
            sixtyFour = true;
            wide = false;
            i++;
        }
    }
    else if (format[i] === 'L' || format[i] === 'w')
    {
        wide = format[i] === 'w';
        sixtyFour = format[i] === 'L';
        i++;
    }
    else if (format[i] === 'j')
    {
        sixtyFour = true;
        i++;
    }
    else if (format[i] === 'z' || format[i] === 't')
    {
        i++;
    }
    else if (format[i] === 'I')
    {
        i++;
        if (format[i] === '6' && format[i + 1] === '4')
        {
            sixtyFour = true;
            i += 2;
        }
        else if (format[i] === '3' && format[i + 1] === '2')
        {
            i += 2;
        }
    }

    return {
        leftAlign,
        zeroPad,
        plus,
        space,
        alt,
        width,
        precision,
        wide,
        narrow,
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
 * @property {boolean} numeric  Only numbers may be padded with zeros.
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
 * @param {number} value
 * @param {Spec} spec
 * @returns {Rendered}
 */
function convertFloat(value, spec){
    const precision = spec.precision < 0 ? 6 : spec.precision;
    const negative = value < 0 || Object.is(value, -0);
    const magnitude = Math.abs(value);

    if (!Number.isFinite(magnitude))
    {
        // Not padded with zeros however the format asks: a zero-padded infinity
        // reads as a number.
        const body = Number.isNaN(magnitude) ? 'nan' : 'inf';
        const cased = spec.conversion === spec.conversion.toUpperCase()
            ? body.toUpperCase()
            : body;
        return { prefix: signOf(negative, spec), body: cased, numeric: false };
    }

    let body;
    switch (spec.conversion.toLowerCase()){
        case 'e':
            body = magnitude.toExponential(precision);
            break;
        case 'g':
            // Precision zero means one significant digit here, which is the one
            // place %g departs from reading the number as a count of digits.
            body = magnitude.toPrecision(Math.max(precision, 1));
            break;
        default:
            body = magnitude.toFixed(precision);
    }
    if (spec.conversion !== spec.conversion.toLowerCase())
    {
        body = body.toUpperCase();
    }
    return { prefix: signOf(negative, spec), body, numeric: true };
}

/**
 * @param {Spec} spec
 * @param {Object} source
 * @param {() => number} source.take       Next stack slot, signed.
 * @param {() => bigint} source.takeWide   Next argument as a 64-bit value.
 * @param {() => number} source.takeDouble
 * @param {(pointer: number, wide: boolean) => string} source.readText
 * @param {(code: number, wide: boolean) => string} source.character  A %c's text.
 * @param {number} produced                Characters written so far, for %n.
 * @param {(pointer: number, value: number) => void} writeCount
 * @returns {Rendered | null}   Null when the conversion is not one we know.
 */
function convert(spec, source, produced, writeCount){
    const { take, takeWide, takeDouble, readText, character } = source;
    switch (spec.conversion){
        case '%':
            return { prefix: '', body: '%', numeric: false };
        case 'c':
        case 'C': {
            const wide = wideText(spec);
            const body = character(take() & (wide ? 0xffff : 0xff), wide);
            return { prefix: '', body, numeric: false };
        }
        case 's':
        case 'S': {
            const pointer = take() >>> 0;
            const text = pointer === 0 ? NULL_STRING : readText(pointer, wideText(spec));
            const body = spec.precision >= 0 ? text.slice(0, spec.precision) : text;
            return { prefix: '', body, numeric: false };
        }
        case 'd':
        case 'i': {
            const value = spec.sixtyFour ? takeWide() : BigInt(take() | 0);
            const negative = value < 0n;
            const body = digits(negative ? -value : value, 10, spec);
            return { prefix: signOf(negative, spec), body, numeric: true };
        }
        case 'u': {
            const value = spec.sixtyFour
                ? BigInt.asUintN(64, takeWide())
                : BigInt(take() >>> 0);
            return { prefix: '', body: digits(value, 10, spec), numeric: true };
        }
        case 'o': {
            const value = spec.sixtyFour
                ? BigInt.asUintN(64, takeWide())
                : BigInt(take() >>> 0);
            const body = digits(value, 8, spec);
            // '#' on octal means "make sure it starts with a zero", not "add
            // one" -- a value that already does gets no second.
            const prefixed = spec.alt && body[0] !== '0' ? `0${body}` : body;
            return { prefix: '', body: prefixed, numeric: true };
        }
        case 'x':
        case 'X': {
            const value = spec.sixtyFour
                ? BigInt.asUintN(64, takeWide())
                : BigInt(take() >>> 0);
            let body = digits(value, 16, spec);
            if (spec.conversion === 'X')
            {
                body = body.toUpperCase();
            }
            // No radix mark on a zero: there is no hexadecimal zero to mark.
            const prefix = spec.alt && value !== 0n
                ? (spec.conversion === 'X' ? '0X' : '0x')
                : '';
            return { prefix, body, numeric: true };
        }
        case 'p': {
            // Eight upper-case digits, always. This runtime does not pad a
            // pointer to the field width with zeros the way it does a number.
            const body = (take() >>> 0).toString(16).toUpperCase().padStart(8, '0');
            return { prefix: '', body, numeric: false };
        }
        case 'e':
        case 'E':
        case 'f':
        case 'F':
        case 'g':
        case 'G':
            return convertFloat(takeDouble(), spec);
        case 'n': {
            // The only conversion that writes rather than reads. It produces no
            // output, which is why it returns an empty body rather than null.
            writeCount(take() >>> 0, produced);
            return { prefix: '', body: '', numeric: false };
        }
        default:
            return null;
    }
}

/**
 * @param {Spec} spec
 * @param {Rendered} rendered
 */
function pad(spec, { prefix, body, numeric }){
    const missing = spec.width - prefix.length - body.length;
    if (missing <= 0)
    {
        return prefix + body;
    }
    if (spec.leftAlign)
    {
        return prefix + body + ' '.repeat(missing);
    }
    // A precision has already fixed the digit count, and C says the zero flag
    // is ignored once it has.
    if (spec.zeroPad && numeric && spec.precision < 0)
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
 * @param {(pointer: number, value: number) => void} [options.writeCount]
 *        Where %n stores the count. Absent means %n produces nothing and
 *        writes nothing, which is what a runtime with %n disabled does.
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
        const bytes = new DataView(new ArrayBuffer(8));
        bytes.setUint32(0, take() >>> 0, true);
        bytes.setUint32(4, take() >>> 0, true);
        return bytes.getFloat64(0, true);
    };
    const decode = options.decodeBytes
        ?? (bytes=>Array.from(bytes, byte=>String.fromCharCode(byte)).join(''));
    /** @param {number} pointer @param {boolean} asWide */
    const readText = (pointer, asWide)=>{
        if (!asWide || !options.readWideString)
        {
            return readString(pointer);
        }
        const text = options.readWideString(pointer);
        if (!options.cLocale)
        {
            return text;
        }
        const unfit = text.search(/[^\0-\xff]/);
        return decode(Uint8Array.from(unfit < 0 ? text : text.slice(0, unfit),
            unit=>unit.charCodeAt(0)));
    };
    /** @param {number} code @param {boolean} asWide */
    const character = (code, asWide)=>{
        if (asWide && (options.wide || !options.cLocale))
        {
            return String.fromCharCode(code);
        }
        return code > 0xff ? '' : decode(Uint8Array.of(code));
    };

    const source = { take, takeWide, takeDouble, readText, character };

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
            out += '%';
            break;
        }

        const noop = ()=>{};
        const rendered = convert(spec, source, out.length, options.writeCount ?? noop);
        out += rendered ? pad(spec, rendered) : format.slice(i, spec.end);
        i = spec.end - 1;
    }
    return out;
}

/** Everything this file needs to know about a string's length. */
export { MAX_STRING };
