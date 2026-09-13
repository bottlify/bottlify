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

/** @param {string} character */
const isSpace = character=>character !== undefined && ' \t\n\v\f\r'.includes(character);

/**
 * The bytes one integer conversion stores, from its length modifier.
 *
 * @param {string} modifier
 */
function integerWidth(modifier){
    if (modifier === 'hh')
    {
        return 1;
    }
    if (modifier === 'h')
    {
        return 2;
    }
    return modifier === 'll' || modifier === 'I64' ? 8 : 4;
}

/**
 * Expands a scanset -- the bracketed form of `%[...]` -- into a membership test.
 *
 * `]` first is a literal `]`, and `^` first negates. Both are positional rules
 * with no escape available, because the set has no escape character.
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
    for (let at = 0; at < text.length; at++)
    {
        // A dash between two characters is a range, but a dash at either end is
        // itself.
        if (text[at] === '-' && at > 0 && at + 1 < text.length)
        {
            for (let code = text.charCodeAt(at - 1) + 1; code <= text.charCodeAt(at + 1); code++)
            {
                members.add(String.fromCharCode(code));
            }
            at++;
            continue;
        }
        members.add(text[at]);
    }
    return character=>character !== undefined && members.has(character) !== negated;
}

/**
 * @typedef {Object} ScanStore
 * @property {(pointer: number, value: bigint, bytes: number) => void} integer
 * @property {(pointer: number, value: number, bytes: number) => void} real
 * @property {(pointer: number, text: string, terminate: boolean) => void} text
 */

/**
 * Runs one scanf against a string.
 *
 * @param {string} input
 * @param {string} format
 * @param {() => number} nextPointer  The next argument, taken only when a
 *        conversion is actually going to store through it.
 * @param {ScanStore} store
 * @returns {number} Assignments made, or SCAN_EOF.
 */
export function runScan(input, format, nextPointer, store){
    let at = 0;
    let assigned = 0;

    /** Nothing converted yet and no input left: the caller's loop should stop. */
    const stop = ()=>(assigned === 0 && at >= input.length ? SCAN_EOF : assigned);

    for (let f = 0; f < format.length; f++)
    {
        const directive = format[f];

        if (isSpace(directive))
        {
            // Any whitespace in the format matches any run of it in the input,
            // including none at all.
            while (isSpace(input[at]))
            {
                at++;
            }
            continue;
        }

        if (directive !== '%')
        {
            if (input[at] !== directive)
            {
                return stop();
            }
            at++;
            continue;
        }

        f++;
        if (format[f] === '%')
        {
            if (input[at] !== '%')
            {
                return stop();
            }
            at++;
            continue;
        }

        let suppress = false;
        if (format[f] === '*')
        {
            suppress = true;
            f++;
        }

        let width = '';
        while (format[f] >= '0' && format[f] <= '9')
        {
            width += format[f++];
        }
        const limit = width === '' ? Infinity : Number(width);

        let modifier = '';
        if (format.startsWith('I64', f))
        {
            modifier = 'I64';
            f += 3;
        }
        else
        {
            while ('hlLjzt'.includes(format[f]))
            {
                modifier += format[f++];
            }
        }

        const conversion = format[f];
        // Every conversion but these three skips leading whitespace first, and
        // the ones that do not are exactly the ones that can match it.
        if (!'c[n'.includes(conversion))
        {
            while (isSpace(input[at]))
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

        if (at >= input.length)
        {
            return stop();
        }

        if (conversion === 'c')
        {
            const count = limit === Infinity ? 1 : limit;
            const taken = input.slice(at, at + count);
            if (taken.length < count)
            {
                return stop();
            }
            at += count;
            if (!suppress)
            {
                // No terminator: %c reads characters, not a string, and the
                // caller's buffer is exactly as long as it asked for.
                store.text(nextPointer(), taken, false);
                assigned++;
            }
            continue;
        }

        if (conversion === 's' || conversion === '[')
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
            while (at < input.length && at - start < limit && accepts(input[at]))
            {
                at++;
            }
            if (at === start)
            {
                return stop();
            }
            if (!suppress)
            {
                store.text(nextPointer(), input.slice(start, at), true);
                assigned++;
            }
            continue;
        }

        const field = limit === Infinity ? input.slice(at) : input.slice(at, at + limit);

        if ('eEfgGaA'.includes(conversion))
        {
            const scanned = scanFloat(field);
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
                    modifier === 'l' || modifier === 'L' ? 8 : 4);
                assigned++;
            }
            continue;
        }

        const base = { d: 10, u: 10, i: 0, o: 8, x: 16, X: 16, p: 16 }[conversion];
        if (base === undefined)
        {
            // An unknown conversion is undefined behaviour; stopping is the
            // reading of it that loses the least.
            return stop();
        }

        const scanned = scanInteger(field, base);
        if (scanned === null)
        {
            return stop();
        }
        at += scanned.end;
        if (!suppress)
        {
            store.integer(nextPointer(),
                scanned.negative ? -scanned.magnitude : scanned.magnitude,
                conversion === 'p' ? 4 : integerWidth(modifier));
            assigned++;
        }
    }

    return assigned;
}

/**
 * @typedef {Object} ScanHost
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 */

/**
 * @param {ScanHost} host
 */
export function createScanFunctions(host){
    /** @param {number} pointer */
    const readString = pointer=>host.readCString(pointer, MAX_STRING);

    /** @type {ScanStore} */
    const store = {
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

        text(pointer, value, terminate){
            const buffer = new Uint8Array(value.length + (terminate ? 1 : 0));
            for (let at = 0; at < value.length; at++)
            {
                buffer[at] = value.charCodeAt(at) & 0xff;
            }
            host.writeMemory(pointer, buffer);
        },
    };

    /**
     * @param {number} fixed  Slots before the variadic tail begins.
     * @param {(args: number[]) => string} inputOf
     */
    const scanf = (fixed, inputOf)=>({
        convention: 'cdecl',
        // The pointers to store through are the variadic tail, and only as
        // many slots as are declared are read: with the fixed part alone,
        // every conversion would be stored through a null pointer.
        argBytes: (fixed + VARIADIC_SLOTS) * 4,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ args)=>{
            let taken = fixed;
            return runScan(inputOf(args), readString(args[fixed - 1]),
                ()=>args[taken++] ?? 0, store);
        },
    });

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
    };
}
