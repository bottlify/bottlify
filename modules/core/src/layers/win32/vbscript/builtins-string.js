/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * VBScript's string functions. Positions count from 1. A comparison argument
 * of vbTextCompare (1) matches without case; vbBinaryCompare (0), the
 * default, matches code units. Asc and Chr speak Windows-1252, the ANSI code
 * page of the English locale; AscW and ChrW speak UTF-16 code units, AscW
 * as a signed Integer.
 */

import { decodeAnsi, encodeAnsi } from '../kernel32/locale.js';
import { VBRuntimeError } from './errors.js';
import { define } from './builtins.js';
import { VBArray, compare, integer, long, toBool, toLong, toStr } from './values.js';

/**
 * @typedef {import('../script/values.js').Value} Value
 * @typedef {import('./interpreter.js').Interpreter} Interpreter
 */

/**
 * Whether a comparison argument asks for text comparison.
 *
 * @param {Value} mode @returns {boolean}
 */
const textMode = mode=>mode !== undefined && toLong(mode) === 1;

/**
 * Where `needle` is in `haystack` from `from` (0-based), as the mode
 * compares: -1 when it is not.
 *
 * @param {string} haystack @param {string} needle @param {number} from @param {boolean} text
 */
const indexIn = (haystack, needle, from, text)=>(text
    ? haystack.toLowerCase().indexOf(needle.toLowerCase(), from)
    : haystack.indexOf(needle, from));

/**
 * A count or a position an argument gives: a whole number, error 5 below
 * the least it may be.
 *
 * @param {Value} value @param {number} least @returns {number}
 */
function atLeast(value, least){
    const n = toLong(value);
    if (n < least)
    {
        throw new VBRuntimeError(5);
    }
    return n;
}

/**
 * A one-dimensional array's elements, as Join and Filter take them.
 *
 * @param {Value} value @returns {Value[]}
 */
function listOf(value){
    if (value === null)
    {
        throw new VBRuntimeError(94);
    }
    if (!(value instanceof VBArray) || value.bounds.length !== 1)
    {
        throw new VBRuntimeError(13);
    }
    return value.items;
}

/** @param {Interpreter} interp */
export function installStrings(interp){
    define(interp, 'Len', 1, 1, ([v])=>(v === null ? null : long(toStr(v).length)));
    define(interp, 'LenB', 1, 1, ([v])=>(v === null ? null : long(toStr(v).length * 2)));
    define(interp, 'Left', 2, 2, ([v, n])=>{
        const count = atLeast(n, 0);
        return v === null ? null : toStr(v).slice(0, count);
    });
    define(interp, 'Right', 2, 2, ([v, n])=>{
        const count = atLeast(n, 0);
        if (v === null)
        {
            return null;
        }
        const text = toStr(v);
        return count === 0 ? '' : text.slice(Math.max(0, text.length - count));
    });
    define(interp, 'Mid', 2, 3, ([v, start, length])=>{
        const from = atLeast(start, 1);
        const count = length === undefined ? Infinity : atLeast(length, 0);
        if (v === null)
        {
            return null;
        }
        const text = toStr(v);
        return text.slice(from - 1, count === Infinity ? undefined : from - 1 + count);
    });
    define(interp, 'InStr', 2, 4, args=>{
        let from = 1;
        let rest = args;
        if (args.length > 2)
        {
            if (args[0] === null)
            {
                throw new VBRuntimeError(94);
            }
            from = atLeast(args[0], 1);
            rest = args.slice(1);
        }
        const [haystack, needle, mode] = rest;
        if (haystack === null || needle === null)
        {
            return null;
        }
        const text = toStr(haystack);
        const sought = toStr(needle);
        if (from > text.length)
        {
            return long(0);
        }
        if (sought === '')
        {
            return long(from);
        }
        return long(indexIn(text, sought, from - 1, textMode(mode)) + 1);
    });
    define(interp, 'InStrRev', 2, 4, ([haystack, needle, start, mode])=>{
        if (haystack === null || needle === null)
        {
            return null;
        }
        const text = toStr(haystack);
        const sought = toStr(needle);
        const from = start === undefined ? -1 : toLong(start);
        if (from === 0 || from < -1)
        {
            throw new VBRuntimeError(5);
        }
        const last = from === -1 ? text.length : from;
        if (last > text.length)
        {
            return long(0);
        }
        if (sought === '')
        {
            return long(last);
        }
        const within = (textMode(mode) ? text.toLowerCase() : text).slice(0, last);
        const target = textMode(mode) ? sought.toLowerCase() : sought;
        return long(within.lastIndexOf(target) + 1);
    });
    define(interp, 'LCase', 1, 1, ([v])=>(v === null ? null : toStr(v).toLowerCase()));
    define(interp, 'UCase', 1, 1, ([v])=>(v === null ? null : toStr(v).toUpperCase()));
    define(interp, 'LTrim', 1, 1, ([v])=>(v === null ? null : toStr(v).replace(/^ +/, '')));
    define(interp, 'RTrim', 1, 1, ([v])=>(v === null ? null : toStr(v).replace(/ +$/, '')));
    define(interp, 'Trim', 1, 1, ([v])=>(v === null ? null
        : toStr(v).replace(/^ +/, '').replace(/ +$/, '')));
    define(interp, 'Space', 1, 1, ([n])=>' '.repeat(atLeast(n, 0)));
    define(interp, 'String', 2, 2, ([n, character])=>{
        const count = atLeast(n, 0);
        if (character === null)
        {
            return null;
        }
        let unit;
        if (typeof character === 'string')
        {
            if (character === '')
            {
                throw new VBRuntimeError(5);
            }
            unit = character[0];
        }
        else
        {
            unit = ansiChar(((toLong(character) % 256) + 256) % 256);
        }
        return unit.repeat(count);
    });
    define(interp, 'StrComp', 2, 3, ([a, b, mode])=>{
        if (a === null || b === null)
        {
            return null;
        }
        return integer(/** @type {number} */ (compare(toStr(a), toStr(b), textMode(mode))));
    });
    define(interp, 'StrReverse', 1, 1, ([v])=>[...toStr(v)].reverse().join(''));
    define(interp, 'Replace', 3, 6, ([expression, find, replacement, start, count, mode])=>{
        const text = toStr(expression);
        const sought = toStr(find);
        const replace = toStr(replacement);
        const from = start === undefined ? 1 : atLeast(start, 1);
        const limit = count === undefined ? -1 : atLeast(count, -1);
        if (from > text.length)
        {
            return '';
        }
        const rest = text.slice(from - 1);
        if (sought === '' || limit === 0)
        {
            return rest;
        }
        const text1 = textMode(mode);
        let out = '';
        let at = 0;
        let done = 0;
        for (;;)
        {
            const found = limit !== -1 && done >= limit ? -1 : indexIn(rest, sought, at, text1);
            if (found < 0)
            {
                return out + rest.slice(at);
            }
            out += rest.slice(at, found) + replace;
            at = found + sought.length;
            done++;
        }
    });
    define(interp, 'Split', 1, 4, ([expression, delimiter, count, mode])=>{
        const text = toStr(expression);
        const separator = delimiter === undefined ? ' ' : toStr(delimiter);
        const limit = count === undefined ? -1 : atLeast(count, -1);
        if (text === '' || limit === 0)
        {
            return VBArray.of([]);
        }
        if (separator === '')
        {
            return VBArray.of([text]);
        }
        const text1 = textMode(mode);
        const parts = [];
        let at = 0;
        for (;;)
        {
            if (limit !== -1 && parts.length === limit - 1)
            {
                parts.push(text.slice(at));
                return VBArray.of(parts);
            }
            const found = indexIn(text, separator, at, text1);
            if (found < 0)
            {
                parts.push(text.slice(at));
                return VBArray.of(parts);
            }
            parts.push(text.slice(at, found));
            at = found + separator.length;
        }
    });
    define(interp, 'Join', 1, 2, ([list, delimiter])=>listOf(list).map(toStr)
        .join(delimiter === undefined ? ' ' : toStr(delimiter)), { raw: true });
    define(interp, 'Filter', 2, 4, ([list, value, include, mode])=>{
        const items = listOf(list);
        if (value === null)
        {
            throw new VBRuntimeError(94);
        }
        const sought = toStr(value);
        const keep = include === undefined ? true : toBool(include);
        const text1 = textMode(mode);
        return VBArray.of(items.map(toStr).filter(item=>(indexIn(item, sought, 0, text1) >= 0)
            === keep));
    }, { raw: true });
    define(interp, 'Asc', 1, 1, ([v])=>{
        const text = toStr(v);
        if (text === '')
        {
            throw new VBRuntimeError(5);
        }
        return integer(encodeAnsi(text[0])[0]);
    });
    define(interp, 'AscB', 1, 1, ([v])=>{
        const text = toStr(v);
        if (text === '')
        {
            throw new VBRuntimeError(5);
        }
        return integer(text.charCodeAt(0) & 0xff);
    });
    define(interp, 'AscW', 1, 1, ([v])=>{
        const text = toStr(v);
        if (text === '')
        {
            throw new VBRuntimeError(5);
        }
        return integer((text.charCodeAt(0) << 16) >> 16);
    });
    define(interp, 'Chr', 1, 1, ([n])=>{
        const code = toLong(n);
        if (code < 0 || code > 255)
        {
            throw new VBRuntimeError(5);
        }
        return ansiChar(code);
    });
    define(interp, 'ChrW', 1, 1, ([n])=>{
        const code = toLong(n);
        if (code < -32768 || code > 65535)
        {
            throw new VBRuntimeError(5);
        }
        return String.fromCharCode(code & 0xffff);
    });
}

/**
 * The character a Windows-1252 code is, a code the page leaves undefined
 * as itself.
 *
 * @param {number} code @returns {string}
 */
function ansiChar(code){
    const text = decodeAnsi(Uint8Array.of(code));
    return text === '' || text === '\0' && code !== 0 ? String.fromCharCode(code) : text;
}
