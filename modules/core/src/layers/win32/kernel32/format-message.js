/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * FormatMessage's formatter: a message's escapes and inserts, and the line
 * width its flags' low byte asks for. The buffers, the flags and where a
 * message comes from are the caller's (`system.js`); this is the text.
 *
 * The rules are Windows', as Wine's format_msg tests pin them:
 *
 * - `%0` ends the message, `%n` is CR LF and `%r` a CR, both starting a new
 *   line; `%t` is a tab; `%%`, `%.`, `%!` and `% ` are the character, and so
 *   is any other after a `%`; a `%` that ends the message is an error. With
 *   FORMAT_MESSAGE_IGNORE_INSERTS only `%0`, `%n`, `%r` and `%t` are escapes
 *   and the rest is copied as written.
 * - `%1`..`%99` insert an argument, as `!printf format!` says or as a
 *   string. A `*` width or precision takes an argument of its own, counted
 *   as Windows counts it: from an array, the insert's own slot and then the
 *   slots after the last one used; from a va_list, the arguments in the order
 *   they are read, an insert seen before naming what it named then.
 * - A line break in the message is CR LF; with a width it is a space, and a
 *   line is broken before it reaches the width, at its last space (the spaces
 *   before the break dropped) or, with none, where it is full. Width 0xff is
 *   no width at all.
 */

const ERROR_INVALID_PARAMETER = 87;
const ERROR_INSUFFICIENT_BUFFER = 122;

/** FormatMessage's low byte of flags: no wrapping, and newlines made spaces. */
const MAX_WIDTH = 0xff;

/**
 * @typedef {Object} MessageArguments
 * @property {boolean} array   FORMAT_MESSAGE_ARGUMENT_ARRAY: the slots are an array.
 * @property {(slot: number) => number} read  A DWORD slot, from the first.
 */

/**
 * @typedef {Object} MessageOptions
 * @property {boolean} wide           FormatMessageW's: what a bare `s` and `c` read.
 * @property {boolean} ignoreInserts
 * @property {number} width           The flags' low byte.
 * @property {MessageArguments | null} args  Null where the caller gave none.
 * @property {(address: number, wide: boolean) => string} readString
 * @property {number} [room]  Stop once the text is longer than this: what the
 *           caller's buffer holds, so no argument past it is read.
 */

/**
 * The argument slots a message's inserts read, the two ways Windows counts.
 *
 * @param {MessageArguments} args
 */
function argumentReader(args){
    /** va_list: what each insert number was given, and how many slots are read. */
    const named = new Map();
    let read = 0;
    /** An array's: the first slot past the last one used. */
    let cursor = 0;
    return {
        get reads(){
            return read;
        },
        /**
         * An insert's slots: its first (its own) and then `count - 1` more.
         *
         * @param {number} insert @param {number} count
         */
        take(insert, count){
            /** @type {number[]} */
            const slots = [];
            if (args.array)
            {
                let at = insert - 1;
                for (let index = 0; index < count; index++)
                {
                    slots.push(args.read(at));
                    cursor = Math.max(cursor, at + 1);
                    at = Math.max(at + 1, cursor);
                }
                return slots;
            }
            if (!named.has(insert))
            {
                if (read < insert)
                {
                    while (read < insert)
                    {
                        named.set(read + 1, args.read(read));
                        read++;
                    }
                }
                else
                {
                    named.set(insert, args.read(read++));
                }
            }
            slots.push(named.get(insert));
            for (let index = 1; index < count; index++)
            {
                slots.push(args.read(read++));
            }
            return slots;
        },
    };
}

/**
 * The text a message's output becomes, line by line: where the width says,
 * a line is broken.
 *
 * @param {number} width
 */
function lines(width){
    const wraps = width > 0 && width < MAX_WIDTH;
    let done = '';
    let line = '';
    const wrap = ()=>{
        const space = line.lastIndexOf(' ');
        if (space === -1)
        {
            done += `${line}\r\n`;
            line = '';
            return;
        }
        done += `${line.slice(0, space).replace(/ +$/, '')}\r\n`;
        line = line.slice(space + 1);
    };
    return {
        /** @param {string} text */
        put(text){
            for (const character of text)
            {
                line += character;
                if (wraps && line.length >= width)
                {
                    wrap();
                }
            }
        },
        /** A line break of the message's own: CR LF, or `%r`'s CR. @param {string} ending */
        end(ending){
            done += line + ending;
            line = '';
        },
        get length(){
            return done.length + line.length;
        },
        get text(){
            return done + line;
        },
    };
}

/**
 * One insert's text, as printf writes its conversion.
 *
 * @param {string} spec  What stands between the exclamation marks.
 * @param {(count: number) => number[]} take  The insert's slots.
 * @param {MessageOptions} options
 * @returns {string | null}  Null for a specification that is none.
 */
function insertText(spec, take, options){
    const match = /^([-+ #0]*)(\*|\d*)(?:\.(\*|\d*))?(hh?|ll?|[wLjzt]|I64|I32|I)?([sScCdiuxXop])$/
        .exec(spec);
    if (match === null)
    {
        return null;
    }
    const [, flags, widthText, precisionText, size = '', conversion] = match;
    const long = size === 'I64' || size === 'll';
    const count = (widthText === '*' ? 1 : 0) + (precisionText === '*' ? 1 : 0) + (long ? 2 : 1);
    const slots = take(count);
    let at = 0;
    const width = widthText === '*' ? slots[at++] | 0 : Number(widthText || 0);
    const precision = precisionText === undefined ? -1
        : precisionText === '*' ? slots[at++] | 0 : Number(precisionText || 0);
    const value = slots[at] >>> 0;
    const high = long ? slots[at + 1] >>> 0 : 0;
    const big = BigInt(high) << 32n | BigInt(value);

    let body;
    switch (conversion)
    {
        case 's':
        case 'S': {
            const wideString = size === 'l' || size === 'w' ? true : size === 'h' ? false
                : options.wide !== (conversion === 'S');
            body = value === 0 ? '(null)' : options.readString(value, wideString);
            if (precision >= 0)
            {
                body = body.slice(0, precision);
            }
            break;
        }
        case 'c':
        case 'C': {
            const wideCharacter = size === 'l' || size === 'w' || conversion === 'C'
                ? true : size === 'h' ? false : options.wide;
            body = String.fromCharCode(wideCharacter ? value & 0xffff : value & 0xff);
            break;
        }
        default: {
            const signed = conversion === 'd' || conversion === 'i';
            const number = signed ? (long ? BigInt.asIntN(64, big) : BigInt(value | 0))
                : (long ? big : BigInt(value));
            const negative = number < 0n;
            const magnitude = negative ? -number : number;
            let digits = conversion === 'o' ? magnitude.toString(8)
                : conversion === 'x' ? magnitude.toString(16)
                    : conversion === 'X' || conversion === 'p'
                        ? magnitude.toString(16).toUpperCase() : magnitude.toString();
            if (conversion === 'p')
            {
                digits = digits.padStart(8, '0');
            }
            if (precision >= 0)
            {
                digits = precision === 0 && magnitude === 0n ? '' : digits.padStart(precision, '0');
            }
            const sign = negative ? '-' : !signed ? '' : flags.includes('+') ? '+'
                : flags.includes(' ') ? ' ' : '';
            const prefixes = { x: '0x', X: '0X', o: '0' };
            const prefix = !flags.includes('#') || magnitude === 0n ? ''
                : prefixes[/** @type {keyof typeof prefixes} */ (conversion)] ?? '';
            body = sign + prefix + digits;
            if (flags.includes('0') && !flags.includes('-') && precision < 0
                && body.length < width)
            {
                body = sign + prefix + digits.padStart(width - sign.length - prefix.length, '0');
            }
            break;
        }
    }
    if (body.length >= Math.abs(width))
    {
        return body;
    }
    return flags.includes('-') || width < 0 ? body.padEnd(Math.abs(width))
        : body.padStart(width);
}

/**
 * A message formatted.
 *
 * @param {string} format @param {MessageOptions} options
 * @returns {{ text: string, error: number, reads: number }}  `error` is 0,
 *          ERROR_INVALID_PARAMETER for a message that cannot be formatted, or
 *          ERROR_INSUFFICIENT_BUFFER when it outgrew `room` and was stopped.
 */
export function formatMessageText(format, options){
    const out = lines(options.width);
    const reader = options.args === null ? null : argumentReader(options.args);
    const room = options.room ?? Infinity;
    const newline = options.width === 0 ? null : ' ';
    /** @param {number} error */
    const result = error=>({ text: out.text, error, reads: reader?.reads ?? 0 });

    for (let at = 0; at < format.length; at++)
    {
        if (out.length > room)
        {
            return result(ERROR_INSUFFICIENT_BUFFER);
        }
        const character = format[at];
        if (character === '\r' || character === '\n')
        {
            if (character === '\r' && format[at + 1] === '\n')
            {
                at++;
            }
            if (newline === null)
            {
                out.end('\r\n');
            }
            else
            {
                out.put(newline);
            }
            continue;
        }
        if (character !== '%')
        {
            out.put(character);
            continue;
        }
        const next = format[at + 1];
        if (next === undefined)
        {
            if (options.ignoreInserts)
            {
                out.put('%');
                continue;
            }
            return result(ERROR_INVALID_PARAMETER);
        }
        if (next === '0')
        {
            return result(0);
        }
        if (next === 'n' || next === 'r' || next === 't')
        {
            at++;
            if (next === 't')
            {
                out.put('\t');
            }
            else
            {
                out.end(next === 'n' ? '\r\n' : '\r');
            }
            continue;
        }
        if (options.ignoreInserts)
        {
            out.put('%');
            continue;
        }
        if (next < '1' || next > '9')
        {
            out.put(next);
            at++;
            continue;
        }
        const second = format[at + 2];
        const twoDigits = second !== undefined && second >= '0' && second <= '9';
        const insert = Number(twoDigits ? next + second : next);
        at += twoDigits ? 2 : 1;
        let spec = 's';
        if (format[at + 1] === '!')
        {
            const close = format.indexOf('!', at + 2);
            if (close === -1)
            {
                return result(ERROR_INVALID_PARAMETER);
            }
            spec = format.slice(at + 2, close);
            at = close;
        }
        if (reader === null)
        {
            return result(ERROR_INVALID_PARAMETER);
        }
        const text = insertText(spec, count=>reader.take(insert, count), options);
        if (text === null)
        {
            return result(ERROR_INVALID_PARAMETER);
        }
        out.put(text);
    }
    return result(out.length > room ? ERROR_INSUFFICIENT_BUFFER : 0);
}
