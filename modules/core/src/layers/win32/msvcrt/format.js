/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

/**
 * The printf format engine, shared by every function that renders one.
 *
 * It is deliberately free of guest memory: strings are fetched through a
 * callback, so the engine is a pure function of its format and its arguments
 * and can be tested without a machine underneath it.
 *
 * Floating-point conversions are not here. A double is pushed as eight bytes
 * and would change how the variadic tail is read, so it is a decision of its
 * own rather than another case in the switch.
 */

/** What msvcrt prints for a null pointer passed to %s. */
const NULL_STRING = '(null)';

/**
 * @typedef {Object} Spec
 * @property {boolean} leftAlign
 * @property {boolean} zeroPad
 * @property {number} width
 * @property {number} precision   -1 when the format gave none.
 * @property {string} conversion  Empty when the format ended mid-specifier.
 * @property {number} end         Index just past the specifier.
 */

/**
 * @param {string} format
 * @param {number} start   Index of the character after the '%'.
 * @returns {Spec}
 */
function parseSpec(format, start){
    let i = start;
    let leftAlign = false;
    let zeroPad = false;
    while (format[i] === '-' || format[i] === '0')
    {
        leftAlign = leftAlign || format[i] === '-';
        zeroPad = zeroPad || format[i] === '0';
        i++;
    }

    let width = 0;
    while (format[i] >= '0' && format[i] <= '9')
    {
        width = width * 10 + Number(format[i]);
        i++;
    }

    let precision = -1;
    if (format[i] === '.')
    {
        i++;
        precision = 0;
        while (format[i] >= '0' && format[i] <= '9')
        {
            precision = precision * 10 + Number(format[i]);
            i++;
        }
    }

    // On a 32-bit target `long` and `int` are the same width, so a size modifier
    // says nothing about how the argument was pushed. `ll` and `I64` are another
    // matter and are not accepted: they would consume two DWORDs, not one.
    while (format[i] === 'h' || format[i] === 'l')
    {
        i++;
    }

    return {
        leftAlign,
        zeroPad,
        width,
        precision,
        conversion: i < format.length ? format[i] : '',
        end: i + 1,
    };
}

/**
 * @typedef {Object} Rendered
 * @property {string} prefix    A sign, which zero padding must not push right.
 * @property {string} body
 * @property {boolean} numeric  Only numbers may be padded with zeros.
 */

/**
 * @param {number} value
 * @param {number} radix
 * @param {Spec} spec
 */
const digits = (value, radix, spec)=>
    value.toString(radix).padStart(Math.max(spec.precision, 0), '0');

/**
 * @param {Spec} spec
 * @param {() => number} take                       Next variadic argument.
 * @param {(pointer: number) => string} readString
 * @returns {Rendered | null}   Null when the conversion is not one we know.
 */
function convert(spec, take, readString){
    switch (spec.conversion){
        case '%':
            return { prefix: '', body: '%', numeric: false };
        case 'c':
            return { prefix: '', body: String.fromCharCode(take() & 0xff), numeric: false };
        case 's': {
            const pointer = take() >>> 0;
            const text = pointer === 0 ? NULL_STRING : readString(pointer);
            const body = spec.precision >= 0 ? text.slice(0, spec.precision) : text;
            return { prefix: '', body, numeric: false };
        }
        case 'd':
        case 'i': {
            const value = take() | 0;
            // Math.abs, not negation: it is the one that survives INT_MIN.
            const body = digits(Math.abs(value), 10, spec);
            return { prefix: value < 0 ? '-' : '', body, numeric: true };
        }
        case 'u':
            return { prefix: '', body: digits(take() >>> 0, 10, spec), numeric: true };
        case 'x':
            return { prefix: '', body: digits(take() >>> 0, 16, spec), numeric: true };
        case 'X': {
            const body = digits(take() >>> 0, 16, spec).toUpperCase();
            return { prefix: '', body, numeric: true };
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
 * Renders one printf-style format string.
 *
 * @param {string} format
 * @param {number[]} varargs                        The variadic tail, as DWORDs.
 * @param {(pointer: number) => string} readString  Reads a guest string for %s.
 * @returns {string}
 */
export function formatToString(format, varargs, readString){
    let out = '';
    let taken = 0;
    // A format string is data the guest may have built at runtime, so it can ask
    // for arguments that were never pushed. Reading those as zero keeps a bad
    // format a wrong string rather than a crash.
    const take = ()=>(taken < varargs.length ? varargs[taken++] | 0 : 0);

    for (let i = 0; i < format.length; i++)
    {
        if (format[i] !== '%')
        {
            out += format[i];
            continue;
        }

        const spec = parseSpec(format, i + 1);
        if (spec.conversion === '')
        {
            out += '%';
            break;
        }

        const rendered = convert(spec, take, readString);
        out += rendered ? pad(spec, rendered) : format.slice(i, spec.end);
        i = spec.end - 1;
    }
    return out;
}
