/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * HLSL source as tokens.
 *
 * The text arrives from the preprocessor (`preprocess.js`), which has already
 * taken the comments out and run the directives, so what is left of the `#`
 * lines is `#pragma` and `#line`: the first is recorded and ignored, the second
 * moves the position the tokens that follow are reported at, which is how a
 * message about an included file names that file and its own line. The lexer
 * still reads `//` and `/* *\/` comments, because an effect's text reaches it
 * without a preprocessor in tests and in tools.
 *
 * Positions are 1-based, a tab is one column, and a token's `line` and `col`
 * are where it starts.
 */

/**
 * @typedef {Object} Position
 * @property {string} file
 * @property {number} line
 * @property {number} col
 */

/**
 * @typedef {Object} Token
 * @property {'ident' | 'int' | 'float' | 'string' | 'punct' | 'eof'} type
 * @property {string} text    The source text of the token (a string's, without quotes).
 * @property {number} value   A number's value; zero for the rest.
 * @property {string} suffix  A number's type suffix, lower case: 'f', 'h', 'l', 'u' or ''.
 * @property {Position} pos
 */

/** One diagnostic, in the shape the compiler reports them. */
export class HlslError extends Error {
    /**
     * @param {string} code       fxc's error code, 'X3000' and the like.
     * @param {string} message
     * @param {Position} pos
     */
    constructor(code, message, pos){
        super(message);
        this.name = 'HlslError';
        this.code = code;
        this.pos = pos;
    }
}

/**
 * A diagnostic as D3DX prints it: `file(line,col): error Xnnnn: text`.
 *
 * @param {{ code: string, message: string, pos: Position, severity?: string }} d
 */
export function formatDiagnostic(d){
    return `${d.pos.file}(${d.pos.line},${d.pos.col}): ${d.severity ?? 'error'} ${d.code}: `
        + `${d.message}`;
}

/** Punctuators, longest first so that `<<=` is not read as `<<` and `=`. */
const PUNCTUATORS = [
    '<<=', '>>=', '...',
    '++', '--', '&&', '||', '==', '!=', '<=', '>=', '<<', '>>', '+=', '-=', '*=', '/=',
    '%=', '&=', '|=', '^=', '::', '->',
    '{', '}', '(', ')', '[', ']', ';', ',', ':', '?', '.', '+', '-', '*', '/', '%', '<', '>',
    '=', '!', '~', '&', '|', '^',
];

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;

/**
 * Reads a number starting at `at`: hexadecimal, decimal, or floating point
 * with an optional exponent, and a type suffix.
 *
 * @param {string} text
 * @param {number} at
 * @returns {{ end: number, isFloat: boolean, value: number, suffix: string } | null}
 */
function readNumber(text, at){
    const hex = /^0[xX]([0-9a-fA-F]+)([uUlL]?)/.exec(text.slice(at, at + 20));
    if (hex)
    {
        return { end: at + hex[0].length, isFloat: false, value: parseInt(hex[1], 16),
            suffix: hex[2].toLowerCase() };
    }
    let i = at;
    while (DIGIT.test(text[i] ?? ''))
    {
        i++;
    }
    let isFloat = false;
    if (text[i] === '.')
    {
        isFloat = true;
        i++;
        while (DIGIT.test(text[i] ?? ''))
        {
            i++;
        }
    }
    if (i === at || (i === at + 1 && isFloat))
    {
        return null;
    }
    const exponent = /^[eE][+-]?[0-9]+/.exec(text.slice(i, i + 12));
    if (exponent)
    {
        isFloat = true;
        i += exponent[0].length;
    }
    const value = Number(text.slice(at, i));
    // f, h, l, u, and l and u together in either order (3lu).
    const written = /^(?:[uU][lL]|[lL][uU]|[fFhHlLuU])/.exec(text.slice(i, i + 2))?.[0] ?? '';
    const ends = written !== '' && !IDENT_PART.test(text[i + written.length] ?? '');
    const lower = ends ? written.toLowerCase() : '';
    const suffix = lower.includes('u') ? 'u' : lower;
    if (suffix === 'f' || suffix === 'h')
    {
        isFloat = true;
    }
    return { end: i + lower.length, isFloat, value, suffix };
}

/**
 * Splits a source into tokens, the last of which is the end of the text.
 *
 * @param {string} source
 * @param {string} [file]  What positions name; `#line` can change it.
 * @returns {{ tokens: Token[], pragmas: { text: string, pos: Position }[] }}
 * @throws {HlslError}
 */
export function tokenize(source, file = 'memory'){
    /** @type {Token[]} */
    const tokens = [];
    /** @type {{ text: string, pos: Position }[]} */
    const pragmas = [];
    let name = file;
    let line = 1;
    let lineStart = 0;
    let i = 0;
    let atLineStart = true;
    /** @param {number} at @returns {Position} */
    const here = at=>({ file: name, line, col: at - lineStart + 1 });
    /**
     * @param {Token['type']} type @param {string} text @param {number} start
     * @param {number} [value] @param {string} [suffix]
     */
    const push = (type, text, start, value = 0, suffix = '')=>{
        tokens.push({ type, text, value, suffix, pos: here(start) });
    };

    while (i < source.length)
    {
        const c = source[i];
        if (c === '\n')
        {
            i++;
            line++;
            lineStart = i;
            atLineStart = true;
            continue;
        }
        if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v')
        {
            i++;
            continue;
        }
        if (c === '/' && source[i + 1] === '/')
        {
            while (i < source.length && source[i] !== '\n')
            {
                i++;
            }
            continue;
        }
        if (c === '/' && source[i + 1] === '*')
        {
            const end = source.indexOf('*/', i + 2);
            if (end < 0)
            {
                throw new HlslError('X3000', 'unterminated comment', here(i));
            }
            for (let j = i; j < end; j++)
            {
                if (source[j] === '\n')
                {
                    line++;
                    lineStart = j + 1;
                }
            }
            i = end + 2;
            continue;
        }
        if (c === '#' && atLineStart)
        {
            let end = source.indexOf('\n', i);
            if (end < 0)
            {
                end = source.length;
            }
            const directive = /^#\s*(\w+)\s*(.*?)\s*$/.exec(source.slice(i, end));
            const start = here(i);
            if (directive?.[1] === 'pragma')
            {
                pragmas.push({ text: directive[2], pos: start });
            }
            else if (directive?.[1] === 'line')
            {
                // `#line N "file"`: the next line is N, in that file.
                const target = /^(\d+)(?:\s+"([^"]*)")?/.exec(directive[2]);
                if (!target)
                {
                    throw new HlslError('X3000', 'syntax error: malformed #line', start);
                }
                // The newline ending this line moves to the line after it.
                line = Number(target[1]) - 1;
                if (target[2] !== undefined)
                {
                    name = target[2];
                }
            }
            else if (directive?.[1] !== undefined)
            {
                throw new HlslError('X3000',
                    `syntax error: unexpected directive '#${directive[1]}'`, start);
            }
            i = end;
            continue;
        }
        atLineStart = false;
        if (IDENT_START.test(c))
        {
            let j = i + 1;
            while (j < source.length && IDENT_PART.test(source[j]))
            {
                j++;
            }
            push('ident', source.slice(i, j), i);
            i = j;
            continue;
        }
        if (DIGIT.test(c) || (c === '.' && DIGIT.test(source[i + 1] ?? '')))
        {
            const number = readNumber(source, i);
            if (number)
            {
                // `1.xxx` and `a.0` are not numbers followed by names; a letter
                // right after the digits that is not a suffix is a malformed literal.
                if (IDENT_PART.test(source[number.end] ?? ''))
                {
                    throw new HlslError('X3000',
                        `syntax error: malformed number '${source.slice(i,
                            number.end + 1)}'`, here(i));
                }
                push(number.isFloat ? 'float' : 'int', source.slice(i, number.end), i,
                    number.value, number.suffix);
                i = number.end;
                continue;
            }
        }
        if (c === '"')
        {
            let j = i + 1;
            let text = '';
            while (j < source.length && source[j] !== '"' && source[j] !== '\n')
            {
                if (source[j] === '\\' && j + 1 < source.length)
                {
                    j++;
                    const escaped = source[j];
                    text += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped;
                }
                else
                {
                    text += source[j];
                }
                j++;
            }
            if (source[j] !== '"')
            {
                throw new HlslError('X3000', 'syntax error: unterminated string', here(i));
            }
            push('string', text, i);
            i = j + 1;
            continue;
        }
        const punct = PUNCTUATORS.find(p=>source.startsWith(p, i));
        if (!punct)
        {
            throw new HlslError('X3000', `syntax error: unexpected character '${c}'`, here(i));
        }
        push('punct', punct, i);
        i += punct.length;
    }
    tokens.push({ type: 'eof', text: '', value: 0, suffix: '', pos: here(i) });
    return { tokens, pragmas };
}
