/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * VBScript's tokens, as the VBScript Language Reference describes them.
 *
 * Names and keywords are matched without case. A line ends a statement, and
 * so does ':'; a line ending in " _" goes on to the next. A comment runs from
 * ' or a Rem statement to the end of its line. A number is decimal, &H hex or
 * &O (or bare &) octal; a whole decimal is an Integer when it fits one, a
 * Long when it fits that, and a Double past both, and a hex or octal number
 * of four hex digits or fewer is an Integer read as sixteen signed bits --
 * &HFFFF is -1 -- of eight or fewer a Long read as thirty-two, unless it
 * ends in & (a Long). A string is "..." with "" for a quote, and a date
 * #...#. A name in brackets, [like this], may hold any character but ].
 */

import { SyntaxFailure } from './errors.js';

/**
 * @typedef {'id' | 'kw' | 'num' | 'str' | 'date' | 'op' | 'nl' | 'eof'} TokenKind
 *
 * @typedef {Object} Token
 * @property {TokenKind} kind
 * @property {any} value  A number's value, a string's text, a name's spelling.
 * @property {string} key  A name or keyword in lower case, an operator itself.
 * @property {number} pos  Where it starts in the text.
 * @property {boolean} space  Whether blank space comes before it.
 */

/** The words VBScript reserves, and the ones it lets a name be too. */
const KEYWORDS = new Set([
    'and', 'byref', 'byval', 'call', 'case', 'class', 'const', 'default', 'dim', 'do', 'each',
    'else', 'elseif', 'empty', 'end', 'eqv', 'erase', 'error', 'exit', 'explicit', 'false',
    'for', 'function', 'get', 'goto', 'if', 'imp', 'in', 'is', 'let', 'loop', 'me', 'mod',
    'new', 'next', 'not', 'nothing', 'null', 'on', 'option', 'or', 'preserve', 'private',
    'property', 'public', 'redim', 'resume', 'select', 'set', 'step', 'stop', 'sub', 'then',
    'to', 'true', 'until', 'wend', 'while', 'with', 'xor',
]);

/** The keywords that may also name a variable or a procedure. */
export const NAME_KEYWORDS = new Set(['default', 'error', 'explicit', 'property', 'step', 'get']);

/** How long a name may be. */
const MAX_NAME = 255;

/** @param {string} c */
const isDigit = c=>c >= '0' && c <= '9';
/** @param {string} c */
const isLetter = c=>(c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
/** @param {string} c */
const isNameChar = c=>isLetter(c) || isDigit(c) || c === '_';
/** @param {string} c */
const isBlank = c=>c === ' ' || c === '\t' || c === ' ' || c === '\f' || c === '\v';

/**
 * The tokens of a text, ending with one of kind 'eof'.
 *
 * @param {string} text @returns {Token[]}
 */
export function tokenize(text){
    /** @type {Token[]} */
    const tokens = [];
    let at = 0;
    let space = false;
    /**
     * @param {TokenKind} kind @param {any} value @param {string} key @param {number} pos
     */
    const push = (kind, value, key, pos)=>{
        tokens.push({ kind, value, key, pos, space });
        space = false;
    };
    /** @returns {Token | undefined} */
    const last = ()=>tokens[tokens.length - 1];
    /** Skips to the end of the line, leaving the line break to be read. */
    const toEndOfLine = ()=>{
        while (at < text.length && text[at] !== '\n' && text[at] !== '\r')
        {
            at++;
        }
    };
    while (at < text.length)
    {
        const c = text[at];
        const start = at;
        if (isBlank(c))
        {
            at++;
            space = true;
            continue;
        }
        if (c === '\n' || c === '\r')
        {
            at += c === '\r' && text[at + 1] === '\n' ? 2 : 1;
            push('nl', null, '\n', start);
            continue;
        }
        if (c === '\'')
        {
            toEndOfLine();
            continue;
        }
        if (c === '_' && continuation(text, at + 1) !== -1)
        {
            at = continuation(text, at + 1);
            space = true;
            continue;
        }
        if (isLetter(c))
        {
            while (at < text.length && isNameChar(text[at]))
            {
                at++;
            }
            const word = text.slice(start, at);
            if (word.length > MAX_NAME)
            {
                throw new SyntaxFailure(1030, start);
            }
            const key = word.toLowerCase();
            const before = last();
            if (key === 'rem' && before?.key !== '.')
            {
                toEndOfLine();
                continue;
            }
            push(KEYWORDS.has(key) && before?.key !== '.' ? 'kw' : 'id', word, key, start);
            continue;
        }
        if (c === '[')
        {
            const close = text.indexOf(']', at + 1);
            const line = text.slice(at + 1, close < 0 ? text.length : close);
            if (close < 0 || /[\r\n]/.test(line))
            {
                throw new SyntaxFailure(1007, start);
            }
            at = close + 1;
            push('id', line, line.toLowerCase(), start);
            continue;
        }
        if (isDigit(c) || (c === '.' && isDigit(text[at + 1] ?? '') && !memberDot(last(), space)))
        {
            at = readDecimal(text, at, push);
            continue;
        }
        if (c === '&' && (space || !endsValue(last())) && /[HhOo0-7]/.test(text[at + 1] ?? '')
            && (text[at + 1] === 'H' || text[at + 1] === 'h'
                ? /[0-9A-Fa-f]/.test(text[at + 2] ?? '')
                : text[at + 1] === 'O' || text[at + 1] === 'o'
                    ? /[0-7]/.test(text[at + 2] ?? '') : true))
        {
            at = readRadix(text, at, push);
            continue;
        }
        if (c === '"')
        {
            let value = '';
            at++;
            for (;;)
            {
                if (at >= text.length || text[at] === '\n' || text[at] === '\r')
                {
                    throw new SyntaxFailure(1033, start);
                }
                if (text[at] === '"')
                {
                    if (text[at + 1] === '"')
                    {
                        value += '"';
                        at += 2;
                        continue;
                    }
                    at++;
                    break;
                }
                value += text[at++];
            }
            push('str', value, '', start);
            continue;
        }
        if (c === '#')
        {
            const close = text.indexOf('#', at + 1);
            const inside = text.slice(at + 1, close < 0 ? text.length : close);
            if (close < 0 || /[\r\n]/.test(inside))
            {
                throw new SyntaxFailure(1002, start);
            }
            at = close + 1;
            push('date', inside, '', start);
            continue;
        }
        const two = text.slice(at, at + 2);
        if (two === '<=' || two === '>=' || two === '<>' || two === '=<' || two === '=>'
            || two === '><')
        {
            at += 2;
            const key = two === '=<' ? '<=' : two === '=>' ? '>=' : two === '><' ? '<>' : two;
            push('op', key, key, start);
            continue;
        }
        if ('+-*/\\^&=<>(),.:'.includes(c))
        {
            at++;
            push('op', c, c, start);
            continue;
        }
        throw new SyntaxFailure(1032, start);
    }
    push('eof', null, '', text.length);
    return tokens;
}

/**
 * Where a line continued by the "_" before `from` goes on: past the blanks
 * after it and the line break they end in; -1 when the "_" does not end its
 * line.
 *
 * @param {string} text @param {number} from @returns {number}
 */
function continuation(text, from){
    let at = from;
    while (at < text.length && isBlank(text[at]))
    {
        at++;
    }
    if (at >= text.length)
    {
        return at;
    }
    if (text[at] === '\r')
    {
        return text[at + 1] === '\n' ? at + 2 : at + 1;
    }
    return text[at] === '\n' ? at + 1 : -1;
}

/**
 * Whether a "." after this token reaches a member rather than starting a
 * number: straight after a name, a closing parenthesis or Me.
 *
 * @param {Token | undefined} before @param {boolean} space
 */
const memberDot = (before, space)=>!space && before !== undefined
    && (before.kind === 'id' || before.key === ')' || before.key === 'me');

/** The keywords that are values. */
const VALUE_KEYWORDS = new Set(['true', 'false', 'empty', 'null', 'nothing', 'me']);

/**
 * Whether a token ends a value, after which an "&" written against it joins
 * rather than starting a hex or octal number: a&H1 is a joined to H1, and
 * a &H1 an argument.
 *
 * @param {Token | undefined} before
 */
const endsValue = before=>before !== undefined && (before.kind === 'id' || before.kind === 'num'
    || before.kind === 'str' || before.kind === 'date' || before.key === ')'
    || (before.kind === 'kw' && VALUE_KEYWORDS.has(before.key)));

/**
 * A decimal number: whole, an Integer or a Long as it fits and a Double past
 * them; with a fraction or an exponent, a Double.
 *
 * @param {string} text @param {number} from
 * @param {(kind: TokenKind, value: any, key: string, pos: number) => void} push
 * @returns {number} where it ends
 */
function readDecimal(text, from, push){
    const match = /^(\d*)(\.\d*)?([eE][+-]?\d+)?/.exec(text.slice(from));
    const literal = /** @type {RegExpExecArray} */ (match)[0];
    const end = from + literal.length;
    if (isLetter(text[end] ?? '') || text[end] === '_')
    {
        throw new SyntaxFailure(1031, from);
    }
    const value = Number(literal);
    if (!Number.isFinite(value))
    {
        throw new SyntaxFailure(1031, from);
    }
    const whole = match?.[2] === undefined && match?.[3] === undefined;
    push('num', { value, type: !whole ? 'double' : value <= 32767 ? 'integer'
        : value <= 2147483647 ? 'long' : 'double' }, '', from);
    return end;
}

/**
 * &H hex or &O octal: sixteen signed bits when it fits them, thirty-two when
 * it does not or ends in &.
 *
 * @param {string} text @param {number} from
 * @param {(kind: TokenKind, value: any, key: string, pos: number) => void} push
 * @returns {number} where it ends
 */
function readRadix(text, from, push){
    const hex = text[from + 1] === 'H' || text[from + 1] === 'h';
    const digitsFrom = from + (hex || text[from + 1] === 'O' || text[from + 1] === 'o' ? 2 : 1);
    const pattern = hex ? /^[0-9A-Fa-f]+/ : /^[0-7]+/;
    const digits = /** @type {RegExpExecArray} */ (pattern.exec(text.slice(digitsFrom)))[0];
    let end = digitsFrom + digits.length;
    const magnitude = Number.parseInt(digits, hex ? 16 : 8);
    let long = magnitude > 0xffff;
    if (text[end] === '&')
    {
        long = true;
        end++;
    }
    if (magnitude > 0xffffffff)
    {
        throw new SyntaxFailure(1031, from);
    }
    const value = long ? magnitude | 0 : (magnitude << 16) >> 16;
    push('num', { value, type: long ? 'long' : 'integer' }, '', from);
    return end;
}

/**
 * The line and column of an offset, and the text of its line.
 *
 * @param {string} text @param {number} offset
 * @returns {{ line: number, column: number, lineText: string }}
 */
export function positionOf(text, offset){
    let line = 0;
    let lineStart = 0;
    for (let i = 0; i < offset && i < text.length; i++)
    {
        const c = text[i];
        if (c === '\n' || (c === '\r' && text[i + 1] !== '\n'))
        {
            line++;
            lineStart = i + 1;
        }
    }
    let lineEnd = lineStart;
    while (lineEnd < text.length && text[lineEnd] !== '\n' && text[lineEnd] !== '\r')
    {
        lineEnd++;
    }
    return { line, column: offset - lineStart, lineText: text.slice(lineStart, lineEnd) };
}
