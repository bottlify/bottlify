/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The scanf family: formatted input, and the direction where the widths matter
 * most.
 *
 * printf reads its arguments and can only get a number wrong. scanf *writes*
 * through pointers whose width the format string alone decides, and there is
 * no other record of it: `%d` stores four bytes, `%hd` two, `%f` four -- a
 * float, not a double, which is the one every reader gets wrong -- and `%lf`
 * eight. Storing the wrong width does not corrupt the value, it corrupts
 * whatever lives beside it, and the program fails somewhere else entirely.
 *
 * The return value carries as much: it counts *assignments*, not conversions,
 * so a suppressed field does not add to it and `%n` never does. A caller reads
 * that count to decide whether the line parsed, and EOF -- meaning the input
 * ran out before anything at all converted -- is -1 rather than 0.
 */

import { scanInteger, scanFloat } from './convert.js';
import { decodeAnsi, encodeAnsi } from '../kernel32/locale.js';
import { wideStringAt } from './widetext.js';

/**
 * How many stack slots a variadic function reads past its fixed arguments.
 *
 * The bridge reads exactly `argBytes` off the stack, and a format string is
 * what decides how many of those a call actually uses. Under cdecl the caller
 * pops, so declaring more than were pushed costs nothing: the slots nobody
 * asked for are never looked at. Declaring only the fixed part hands every
 * conversion a zero.
 */
export const VARIADIC_SLOTS = 32;

const MAX_STRING = 1 << 20;

/** Returned when the input ended before the first conversion could start. */
export const SCAN_EOF = -1;

/** @param {string | undefined} character */
const isSpace = character=>character !== undefined && ' \t\n\v\f\r'.includes(character);

/**
 * The bytes one integer conversion stores, from its length modifier.
 *
 * @param {string} modifier
 */
function integerWidth(modifier){
    if (/ll|I64|j/.test(modifier))
    {
        return 8;
    }
    // One h is a short; msvcrt reads a second as taking the first back.
    return (modifier.match(/h/g) ?? []).length === 1 ? 2 : 4;
}

/**
 * Expands a scanset -- the bracketed form of `%[...]` -- into a membership test.
 *
 * `]` first is a literal `]`, and `^` first negates. Both are positional rules
 * with no escape available, because the set has no escape character. A dash
 * between two characters is a range -- run the other way, the same range, as
 * msvcrt reads it -- but a dash at either end, or right after a range, is
 * itself.
 *
 * @param {string} body
 * @returns {(character: string) => boolean}
 */
function scanset(body){
    let text = body;
    let negated = false;
    if (text.startsWith('^'))
    {
        negated = true;
        text = text.slice(1);
    }
    const members = new Set();
    let afterRange = false;
    for (let at = 0; at < text.length; at++)
    {
        if (text[at] === '-' && at > 0 && at + 1 < text.length && !afterRange)
        {
            // The range runs over byte values, as the runtime compares them,
            // not over the characters the ANSI page makes of those bytes.
            const [start, end] = encodeAnsi(text[at - 1] + text[at + 1]);
            for (let byte = Math.min(start, end); byte <= Math.max(start, end); byte++)
            {
                members.add(decodeAnsi(Uint8Array.of(byte)));
            }
            at++;
            afterRange = true;
            continue;
        }
        members.add(text[at]);
        afterRange = false;
    }
    return character=>character !== undefined && members.has(character) !== negated;
}

/**
 * @typedef {Object} ScanStore
 * @property {(pointer: number, value: bigint, bytes: number) => void} integer
 * @property {(pointer: number, value: number, bytes: number) => void} real
 * @property {(pointer: number, text: string, terminate: boolean, wide: boolean) => void} text
 */

/**
 * How far a scan read: the characters it consumed, and whether it looked for
 * one past the end of what it had -- the case more input could change.
 *
 * @typedef {Object} ScanProgress
 * @property {number} consumed
 * @property {boolean} starved
 */

/**
 * Runs one scanf against a string.
 *
 * @param {string} input
 * @param {string} format
 * @param {() => number} nextPointer  The next argument, taken only when a
 *        conversion is actually going to store through it.
 * @param {ScanStore} store
 * @param {{ wide?: boolean, secure?: boolean, progress?: ScanProgress }} [options]
 *        `wide` for the wscanf family, where %s and %c are wide and %S and
 *        %C narrow; `secure` for the _s family, where each %c, %s and %[
 *        takes its buffer's size in characters after its pointer, and text
 *        that does not fit ends the scan with the buffer emptied;
 *        `progress` is filled in with how far the scan read.
 * @returns {number} Assignments made, or SCAN_EOF.
 */
export function runScan(input, format, nextPointer, store, options = {}){
    let at = 0;
    let assigned = 0;
    let starved = false;

    /** The character at `index`, noting a look past the end. @param {number} index */
    const peek = index=>{
        if (index >= input.length)
        {
            starved = true;
            return undefined;
        }
        return input[index];
    };

    const done = (/** @type {number} */ answer)=>{
        if (options.progress)
        {
            options.progress.consumed = at;
            options.progress.starved = starved;
        }
        return answer;
    };

    /** Nothing converted yet and no input left: the caller's loop should stop. */
    const stop = ()=>done(assigned === 0 && at >= input.length ? SCAN_EOF : assigned);

    /** A literal the input must have next. @param {string} character */
    const literal = character=>{
        if (peek(at) !== character)
        {
            return false;
        }
        at++;
        return true;
    };

    for (let f = 0; f < format.length; f++)
    {
        const directive = format[f];

        if (isSpace(directive))
        {
            // Any whitespace in the format matches any run of it in the input,
            // including none at all.
            while (isSpace(peek(at)))
            {
                at++;
            }
            continue;
        }

        if (directive !== '%')
        {
            if (!literal(directive))
            {
                return stop();
            }
            continue;
        }

        f++;
        let suppress = false;
        if (format[f] === '*')
        {
            suppress = true;
            f++;
        }

        // Digits and length modifiers in any order, as msvcrt takes them:
        // every digit adds to the one width, so "%2h0d" reads twenty.
        let width = '';
        let modifier = '';
        for (;;)
        {
            if (format[f] >= '0' && format[f] <= '9')
            {
                width += format[f++];
            }
            else if (format.startsWith('I64', f))
            {
                modifier += 'I64';
                f += 3;
            }
            else if (format.startsWith('I32', f))
            {
                f += 3;
            }
            else if ('hlLjztwFN'.includes(format[f] ?? '_'))
            {
                modifier += format[f++];
            }
            else
            {
                break;
            }
        }
        const limit = Number(width) > 0 ? Number(width) : Infinity;

        const conversion = format[f];
        if (conversion === undefined)
        {
            return stop();
        }
        const known = 'cCsSdiouxXpPneEfgGaA['.includes(conversion);
        if (!known)
        {
            // msvcrt matches a character it does not know as a conversion
            // the way it matches any other: "%%" and "%\"" alike.
            if (!literal(conversion))
            {
                return stop();
            }
            continue;
        }

        // Every conversion but these three skips leading whitespace first, and
        // the ones that do not are exactly the ones that can match it.
        if (!'cC[n'.includes(conversion))
        {
            while (isSpace(peek(at)))
            {
                at++;
            }
        }

        if (conversion === 'n')
        {
            // Not an assignment: it does not add to the count, and a format of
            // nothing but %n returns zero however much was consumed.
            if (!suppress)
            {
                store.integer(nextPointer(), BigInt(at), integerWidth(modifier));
            }
            continue;
        }

        if (peek(at) === undefined)
        {
            return stop();
        }

        const upper = conversion === 'S' || conversion === 'C';
        const wide = /[lw]/.test(modifier) || (!modifier.includes('h')
            && upper !== (options.wide === true));

        if (conversion === 'c' || conversion === 'C')
        {
            const count = limit === Infinity ? 1 : limit;
            const taken = input.slice(at, at + count);
            if (taken.length < count)
            {
                peek(at + count);
                return stop();
            }
            at += count;
            if (!suppress)
            {
                const pointer = nextPointer();
                if (options.secure && (nextPointer() >>> 0) < count)
                {
                    return stop();
                }
                // No terminator: %c reads characters, not a string, and the
                // caller's buffer is exactly as long as it asked for.
                store.text(pointer, taken, false, wide);
                assigned++;
            }
            continue;
        }

        if (conversion === 's' || conversion === 'S' || conversion === '[')
        {
            let accepts = (/** @type {string} */ character)=>!isSpace(character);
            if (conversion === '[')
            {
                const body = format.indexOf(']', format[f + 1] === '^'
                    ? f + 3
                    : f + 2);
                if (body === -1)
                {
                    return stop();
                }
                accepts = scanset(format.slice(f + 1, body));
                f = body;
            }

            const start = at;
            while (at - start < limit && peek(at) !== undefined && accepts(input[at]))
            {
                at++;
            }
            if (at === start)
            {
                return stop();
            }
            if (!suppress)
            {
                const pointer = nextPointer();
                if (options.secure && (nextPointer() >>> 0) < at - start + 1)
                {
                    store.text(pointer, '', true, wide);
                    return stop();
                }
                store.text(pointer, input.slice(start, at), true, wide);
                assigned++;
            }
            continue;
        }

        const field = limit === Infinity ? input.slice(at) : input.slice(at, at + limit);
        /**
         * Whether more input could have changed what a number read: it ran to
         * the end of what there is, or all that follows it could still begin
         * its exponent, fraction or prefix. A caller reading a stream a line
         * at a time reads on only then, and not to the end of the file for
         * every number in the format.
         *
         * @param {{ end: number } | null} scanned
         */
        const short = scanned=>field.length < limit
            && (scanned === null || /^[eEpPxX+-.]{0,2}$/.test(field.slice(scanned.end)));

        if ('eEfgGaA'.includes(conversion))
        {
            const scanned = scanFloat(field);
            starved ||= short(scanned);
            if (scanned === null)
            {
                return stop();
            }
            at += scanned.end;
            if (!suppress)
            {
                // Plain %f is a float. The `l` that makes it a double is not
                // decoration: without it, storing eight bytes overruns.
                store.real(nextPointer(), scanned.value,
                    /[lL]/.test(modifier) ? 8 : 4);
                assigned++;
            }
            continue;
        }

        // A pointer is hexadecimal digits alone: "0x" is not its prefix, and
        // reads as the zero before the x.
        const pointer = conversion === 'p' || conversion === 'P';
        const base = /** @type {Record<string, number>} */ ({ d: 10, u: 10, i: 0, o: 8, x: 16,
            X: 16 })[conversion] ?? 16;
        const scanned = scanInteger(field, pointer ? 16 : base, true, !pointer);
        starved ||= short(scanned);
        if (scanned === null)
        {
            return stop();
        }
        at += scanned.end;
        if (!suppress)
        {
            store.integer(nextPointer(),
                scanned.negative ? -scanned.magnitude : scanned.magnitude,
                pointer ? 4 : integerWidth(modifier));
            assigned++;
        }
    }

    return done(assigned);
}

/**
 * The stores a scan makes, into guest memory: an integer of its width, a
 * float or a double, and text in the ANSI page or UTF-16.
 *
 * @param {{ writeMemory: (address: number, bytes: Uint8Array) => void }} host
 * @returns {ScanStore}
 */
export function createScanStore(host){
    return {
        integer(pointer, value, bytes){
            const buffer = new Uint8Array(bytes);
            const view = new DataView(buffer.buffer);
            const truncated = BigInt.asUintN(bytes * 8, value);
            if (bytes === 8)
            {
                view.setBigUint64(0, truncated, true);
            }
            else if (bytes === 4)
            {
                view.setUint32(0, Number(truncated), true);
            }
            else if (bytes === 2)
            {
                view.setUint16(0, Number(truncated), true);
            }
            else
            {
                view.setUint8(0, Number(truncated));
            }
            host.writeMemory(pointer, buffer);
        },

        real(pointer, value, bytes){
            const buffer = new Uint8Array(bytes);
            const view = new DataView(buffer.buffer);
            if (bytes === 8)
            {
                view.setFloat64(0, value, true);
            }
            else
            {
                view.setFloat32(0, value, true);
            }
            host.writeMemory(pointer, buffer);
        },

        text(pointer, value, terminate, wide){
            if (wide)
            {
                const buffer = new Uint8Array((value.length + (terminate ? 1 : 0)) * 2);
                const view = new DataView(buffer.buffer);
                for (let at = 0; at < value.length; at++)
                {
                    view.setUint16(at * 2, value.charCodeAt(at), true);
                }
                host.writeMemory(pointer, buffer);
                return;
            }
            const buffer = new Uint8Array(value.length + (terminate ? 1 : 0));
            buffer.set(encodeAnsi(value));
            host.writeMemory(pointer, buffer);
        },
    };
}

/**
 * @typedef {Object} ScanHost
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, length: number) => Uint8Array} [readMemory]
 *           For the wide input and format of swscanf. Absent, it stays unexported.
 */

/**
 * @param {ScanHost} host
 */
export function createScanFunctions(host){
    /** @param {number} pointer */
    const readString = pointer=>host.readCString(pointer, MAX_STRING);

    const store = createScanStore(host);

    /**
     * @param {number} fixed  Slots before the variadic tail begins.
     * @param {(args: number[]) => string} inputOf
     * @param {(pointer: number) => string} [formatOf]
     * @param {boolean} [wide]
     * @param {boolean} [secure]
     */
    const scanf = (fixed, inputOf, formatOf = readString, wide = false, secure = false)=>({
        convention: 'cdecl',
        // The pointers to store through are the variadic tail, and only as
        // many slots as are declared are read: with the fixed part alone,
        // every conversion would be stored through a null pointer.
        argBytes: (fixed + VARIADIC_SLOTS) * 4,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ args)=>{
            let taken = fixed;
            const assigned = runScan(inputOf(args), formatOf(args[fixed - 1]),
                ()=>args[taken++] ?? 0, store, { wide, secure });
            // msvcrt's wide scan answers no input with nothing assigned, not
            // with EOF, as the later runtimes do.
            return wide && assigned === SCAN_EOF ? 0 : assigned;
        },
    });

    const { readMemory } = host;
    /** @param {number} pointer */
    const readWide = pointer=>wideStringAt(/** @type {(address: number, length: number)
        => Uint8Array} */ (readMemory), pointer);

    return {
        /** int sscanf(const char *buffer, const char *format, ...) */
        sscanf: scanf(2, args=>readString(args[0])),

        /**
         * int _snscanf(const char *buffer, size_t count, const char *format, ...)
         *
         * The count bounds the input rather than the output, so a buffer that
         * is not terminated at all is still safe to read from.
         */
        _snscanf: scanf(3, args=>readString(args[0]).slice(0, args[1] >>> 0)),

        /** int sscanf_s(const char *buffer, const char *format, ...) */
        sscanf_s: scanf(2, args=>readString(args[0]), readString, false, true),

        ...readMemory ? {
            /**
             * int swscanf(const wchar_t *buffer, const wchar_t *format, ...)
             *
             * %s and %c store wide text here, %S, %C and an h narrow.
             */
            swscanf: scanf(2, args=>readWide(args[0]), readWide, true),

            /** int swscanf_s(const wchar_t *buffer, const wchar_t *format, ...) */
            swscanf_s: scanf(2, args=>readWide(args[0]), readWide, true, true),
        } : {},
    };
}
