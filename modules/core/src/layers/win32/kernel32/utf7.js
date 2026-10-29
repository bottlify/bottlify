/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * CP_UTF7, as MultiByteToWideChar and WideCharToMultiByte speak it.
 *
 * RFC 2152 leaves an encoder free in what it writes directly and when it ends
 * a base64 run; Windows chose, and programs that compare bytes see the
 * choice. Only RFC 2152's set D and the four controls NUL, TAB, LF and CR are
 * written as themselves -- the optional set O ('!', '"', '#', ...) goes into
 * base64 -- '+' is "+-", and every run of base64 is closed with '-' whatever
 * follows it.
 *
 * The decoder is as lenient as Windows': a '+' that starts no run and is not
 * "+-" is dropped, '-' closes a run and is consumed, any other ASCII byte
 * closes it and is kept, and the bits short of a whole character are thrown
 * away -- except when the byte that ends the run is above 0x7f, which closes
 * the run but leaves its bits pending for the next one. Bytes outside a run
 * are taken as their own code points.
 */

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** A base64 digit's value by ASCII byte, -1 for a byte that is none. */
const DIGIT_VALUE = new Int8Array(128).fill(-1);
for (let at = 0; at < BASE64.length; at++)
{
    DIGIT_VALUE[BASE64.charCodeAt(at)] = at;
}

/** The ASCII characters written as themselves. */
const DIRECT = new Uint8Array(128);
for (const character of '\0\t\n\r \'(),-./:?')
{
    DIRECT[character.charCodeAt(0)] = 1;
}
for (const [first, last] of [['0', '9'], ['A', 'Z'], ['a', 'z']])
{
    for (let code = first.charCodeAt(0); code <= last.charCodeAt(0); code++)
    {
        DIRECT[code] = 1;
    }
}

const PLUS = 0x2b;
const MINUS = 0x2d;

/**
 * UTF-7 bytes as UTF-16 code units.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function decodeUtf7(bytes){
    /** @type {number[]} */
    const units = [];
    let inRun = false;
    let bits = 0;
    let pending = 0;
    for (let at = 0; at < bytes.length; at++)
    {
        const byte = bytes[at];
        if (!inRun)
        {
            if (byte !== PLUS)
            {
                units.push(byte);
                continue;
            }
            if (at + 1 === bytes.length)
            {
                break;
            }
            const next = bytes[at + 1];
            if (next === MINUS)
            {
                units.push(PLUS);
                at++;
            }
            else if (next < 0x80 && DIGIT_VALUE[next] !== -1)
            {
                inRun = true;
            }
            continue;
        }
        const value = byte < 0x80 ? DIGIT_VALUE[byte] : -1;
        if (value !== -1)
        {
            bits = (bits << 6 | value) & 0x3fffff;
            pending += 6;
            if (pending >= 16)
            {
                pending -= 16;
                units.push(bits >>> pending & 0xffff);
            }
            continue;
        }
        inRun = false;
        if (byte < 0x80)
        {
            pending = 0;
        }
        if (byte !== MINUS)
        {
            units.push(byte);
        }
    }
    let text = '';
    for (let at = 0; at < units.length; at += 4096)
    {
        text += String.fromCharCode(...units.slice(at, at + 4096));
    }
    return text;
}

/**
 * UTF-16 code units as UTF-7 bytes, and how many of them a buffer of a given
 * size takes: a run's last digit and the '-' after it are written together
 * or not at all, so a buffer one byte short of both ends before the digit.
 *
 * @param {string} text
 * @returns {{ bytes: Uint8Array, fit: (room: number) => number }}
 */
export function encodeUtf7(text){
    /** @type {number[]} */
    const out = [];
    /** Offsets a short buffer may not stop at. @type {Set<number>} */
    const joined = new Set();
    let inRun = false;
    let bits = 0;
    let pending = 0;
    const close = ()=>{
        if (pending > 0)
        {
            out.push(BASE64.charCodeAt(bits << (6 - pending) & 0x3f));
            joined.add(out.length);
        }
        out.push(MINUS);
        inRun = false;
        pending = 0;
    };
    for (let at = 0; at < text.length; at++)
    {
        const code = text.charCodeAt(at);
        if (code < 0x80 && (DIRECT[code] === 1 || code === PLUS))
        {
            if (inRun)
            {
                close();
            }
            out.push(code);
            if (code === PLUS)
            {
                out.push(MINUS);
            }
            continue;
        }
        if (!inRun)
        {
            out.push(PLUS);
            inRun = true;
        }
        bits = (bits << 16 | code) & 0x3fffff;
        pending += 16;
        while (pending >= 6)
        {
            pending -= 6;
            out.push(BASE64.charCodeAt(bits >>> pending & 0x3f));
        }
    }
    if (inRun)
    {
        close();
    }
    return {
        bytes: Uint8Array.from(out),
        fit: room=>(joined.has(room) ? room - 1 : room),
    };
}
