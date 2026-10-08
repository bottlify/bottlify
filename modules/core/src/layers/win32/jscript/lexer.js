/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * JScript's tokens, from the text of a script (ECMA-262 3rd edition, clause
 * 7, with JScript's own differences).
 *
 * The lexer does not decide alone whether a slash starts a regular
 * expression: that depends on the grammar, so the parser asks for a slash it
 * finds where an expression begins to be read again as one
 * ({@link Lexer#regex}). Tokens are read one at a time, on demand, which is
 * what makes reading one again possible.
 *
 * Conditional compilation is handled here, because it is lexical: a comment
 * that begins `/*@` or `//@` is code once `@cc_on` has been seen, `@if`,
 * `@elif`, `@else` and `@end` keep or drop the text between them, `@set`
 * gives a variable a value, and a variable read in code is the constant it
 * holds -- NaN for one never set.
 *
 * JScript's differences kept here: `\v` in a string is the letter v, a
 * string may hold an octal escape, and a backslash before a line break
 * continues the string onto the next line.
 */

import { SyntaxFailure } from './errors.js';

/** Token kinds. */
export const T = Object.freeze({
    NAME: 1,
    NUMBER: 2,
    STRING: 3,
    REGEX: 4,
    PUNCT: 5,
    EOF: 6,
});

/**
 * @typedef {Object} Token
 * @property {number} t  A {@link T} kind.
 * @property {any} v  The name, the number, the string, the punctuator, or
 *     `{ pattern, flags }` for a regular expression.
 * @property {number} s  Where it starts in the text.
 * @property {number} e  Where it ends.
 * @property {boolean} nl  Whether a line break came before it.
 * @property {boolean} [escaped]  A name spelled with a \u escape: never a keyword.
 * @property {string} [ccVariable]  The conditional-compilation variable it was read from.
 */

/** The words JScript reserves: ES3's keywords and the future words it refuses. */
export const KEYWORDS = new Set([
    'break', 'case', 'catch', 'continue', 'default', 'delete', 'do', 'else', 'finally', 'for',
    'function', 'if', 'in', 'instanceof', 'new', 'return', 'switch', 'this', 'throw', 'try',
    'typeof', 'var', 'void', 'while', 'with', 'null', 'true', 'false',
    'class', 'const', 'enum', 'export', 'extends', 'import', 'super', 'debugger',
]);

const PUNCTUATORS = [
    '>>>=', '===', '!==', '>>>', '<<=', '>>=',
    '<=', '>=', '==', '!=', '++', '--', '<<', '>>', '&&', '||', '+=', '-=', '*=', '%=',
    '&=', '|=', '^=', '/=',
    '{', '}', '(', ')', '[', ']', '.', ';', ',', '<', '>', '+', '-', '*', '%', '&', '|', '^',
    '!', '~', '?', ':', '=', '/',
];

/** @param {number} c @returns {boolean} */
const isLineTerminator = c=>c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029;

/** @param {number} c @returns {boolean} */
function isWhitespace(c){
    return c === 0x20 || c === 0x09 || c === 0x0b || c === 0x0c || c === 0xa0 || c === 0xfeff
        || (c > 0x7f && /\s/.test(String.fromCharCode(c)) && !isLineTerminator(c));
}

/** @param {number} c @returns {boolean} */
function isIdentifierStart(c){
    if (c < 0x80)
    {
        return (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || c === 0x24 || c === 0x5f;
    }
    return /[\p{L}\p{Nl}]/u.test(String.fromCharCode(c));
}

/** @param {number} c @returns {boolean} */
function isIdentifierPart(c){
    if (c < 0x80)
    {
        return isIdentifierStart(c) || (c >= 0x30 && c <= 0x39);
    }
    return /[\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}]/u.test(String.fromCharCode(c));
}

/** @param {number} c @returns {number} the digit's value, or -1 */
function hexValue(c){
    if (c >= 0x30 && c <= 0x39)
    {
        return c - 0x30;
    }
    if (c >= 0x61 && c <= 0x66)
    {
        return c - 0x57;
    }
    if (c >= 0x41 && c <= 0x46)
    {
        return c - 0x37;
    }
    return -1;
}

/**
 * The variables conditional compilation starts with: what the engine is and
 * what it runs on. One never set reads as NaN.
 *
 * @param {{ major: number, minor: number, build: number }} version
 * @returns {Map<string, number | boolean>}
 */
export function conditionalVariables(version){
    return new Map(/** @type {[string, number | boolean][]} */ ([
        ['_jscript', true],
        ['_jscript_build', version.build],
        ['_jscript_version', version.major + version.minor / 10],
        ['_win32', true],
        ['_x86', true],
    ]));
}

/** Binary operators a conditional-compilation expression takes, loosest first. */
const CC_PRECEDENCE = new Map([
    ['||', 1], ['&&', 2], ['|', 3], ['^', 4], ['&', 5],
    ['==', 6], ['!=', 6], ['===', 6], ['!==', 6],
    ['<', 7], ['>', 7], ['<=', 7], ['>=', 7],
    ['<<', 8], ['>>', 8], ['>>>', 8],
    ['+', 9], ['-', 9], ['*', 10], ['/', 10], ['%', 10],
]);

/** @param {number | boolean} value @returns {number} */
const ccNumber = value=>(typeof value === 'boolean' ? (value ? 1 : 0) : value);

/**
 * @param {string} op @param {number | boolean} a @param {number | boolean} b
 * @returns {number | boolean}
 */
function ccBinary(op, a, b){
    const x = ccNumber(a);
    const y = ccNumber(b);
    switch (op)
    {
        case '||': return a ? a : b;
        case '&&': return a ? b : a;
        case '|': return x | y;
        case '^': return x ^ y;
        case '&': return x & y;
        case '==': case '===': return x === y;
        case '!=': case '!==': return x !== y;
        case '<': return x < y;
        case '>': return x > y;
        case '<=': return x <= y;
        case '>=': return x >= y;
        case '<<': return x << y;
        case '>>': return x >> y;
        case '>>>': return x >>> y;
        case '+': return x + y;
        case '-': return x - y;
        case '*': return x * y;
        case '/': return x / y;
        default: return x % y;
    }
}

export class Lexer
{
    /**
     * @param {string} text
     * @param {{ conditional?: Map<string, number | boolean>, ccOn?: boolean }} [options]
     *     The engine's conditional-compilation variables, which `@set`
     *     changes for every later script, as JScript keeps them per engine.
     */
    constructor(text, options = {}){
        this.text = text;
        this.at = 0;
        this.sawLineBreak = false;
        this.conditional = options.conditional ?? new Map();
        /** Whether `@cc_on` has been seen, by this script or an earlier one. */
        this.ccOn = options.ccOn ?? false;
        /** One open `@if` per entry: whether its branch is being read. */
        /** @type {boolean[]} */
        this.ccIf = [];
        /** @type {Token | null} */
        this.pushed = null;
    }

    /** @param {number} code @param {number} [at] @returns {never} */
    fail(code, at = this.at){
        throw new SyntaxFailure(code, at);
    }

    /** @returns {Token} */
    next(){
        if (this.pushed)
        {
            const token = this.pushed;
            this.pushed = null;
            return token;
        }
        return this.scan();
    }

    /** @returns {Token} */
    scan(){
        this.sawLineBreak = false;
        for (;;)
        {
            this.skipSpace();
            const text = this.text;
            if (this.at >= text.length)
            {
                if (this.ccIf.length > 0)
                {
                    this.fail(1029);
                }
                return this.token(T.EOF, null, this.at);
            }
            const c = text.charCodeAt(this.at);
            if (c === 0x40)
            {
                const value = this.directive();
                if (value !== undefined)
                {
                    return value;
                }
                // An expression a directive read may have read one token past
                // its end, and that token is the next one.
                if (this.pushed)
                {
                    const token = this.pushed;
                    this.pushed = null;
                    return token;
                }
                continue;
            }
            return this.read(c);
        }
    }

    /**
     * @param {number} t @param {any} v @param {number} start
     * @returns {Token}
     */
    token(t, v, start){
        return { t, v, s: start, e: this.at, nl: this.sawLineBreak };
    }

    /** Whitespace, line breaks and comments, except a comment that is code. */
    skipSpace(){
        const text = this.text;
        while (this.at < text.length)
        {
            const c = text.charCodeAt(this.at);
            if (isLineTerminator(c))
            {
                this.sawLineBreak = true;
                this.at++;
            }
            else if (isWhitespace(c))
            {
                this.at++;
            }
            else if (c === 0x2f && text.charCodeAt(this.at + 1) === 0x2a)
            {
                if (this.conditionalComment(2))
                {
                    continue;
                }
                const end = text.indexOf('*/', this.at + 2);
                if (end < 0)
                {
                    this.fail(1016);
                }
                if (/[\n\r\u2028\u2029]/.test(text.slice(this.at, end)))
                {
                    this.sawLineBreak = true;
                }
                this.at = end + 2;
            }
            else if (c === 0x2f && text.charCodeAt(this.at + 1) === 0x2f)
            {
                if (this.conditionalComment(2))
                {
                    continue;
                }
                this.at += 2;
                while (this.at < text.length && !isLineTerminator(text.charCodeAt(this.at)))
                {
                    this.at++;
                }
            }
            else if (c === 0x40 && this.ccOn && text.startsWith('@*/', this.at))
            {
                // The end of a comment conditional compilation made code.
                this.at += 3;
            }
            else
            {
                return;
            }
        }
    }

    /**
     * A comment whose text is code: `/*@` or `//@` before a name, once
     * conditional compilation is on or when the name turns it on. Steps past
     * the comment's opening and answers true; anything else is a comment.
     *
     * @param {number} opening  Its length.
     * @returns {boolean}
     */
    conditionalComment(opening){
        const text = this.text;
        const after = this.at + opening;
        if (text.charCodeAt(after) !== 0x40 || !isIdentifierStart(text.charCodeAt(after + 1)))
        {
            return false;
        }
        if (!this.ccOn && !/^@(cc_on|if|set)\b/.test(text.slice(after, after + 7)))
        {
            return false;
        }
        this.at = after;
        return true;
    }

    /**
     * `@` at `at`: a directive, read and acted on (undefined), or a
     * variable, answered as the constant it holds.
     *
     * @returns {Token | undefined}
     */
    directive(){
        const start = this.at;
        this.at++;
        const word = this.word();
        if (word === 'cc_on')
        {
            this.ccOn = true;
            return undefined;
        }
        if (word === 'set')
        {
            this.ccOn = true;
            this.skipSpace();
            if (this.text.charCodeAt(this.at) !== 0x40)
            {
                this.fail(1032);
            }
            this.at++;
            const name = this.word();
            if (name === '')
            {
                this.fail(1010);
            }
            const equals = this.next();
            if (equals.t !== T.PUNCT || equals.v !== '=')
            {
                this.fail(1011, equals.s);
            }
            this.conditional.set(name, this.ccExpression(0));
            // The token read past the expression may be a variable read
            // before this one was set; it is read again, as it now is.
            const after = this.pushed;
            if (after?.ccVariable !== undefined)
            {
                this.pushed = { ...this.variable(after.ccVariable, after.s),
                    ccVariable: after.ccVariable, nl: after.nl };
            }
            return undefined;
        }
        if (word === 'if')
        {
            this.ccOn = true;
            const taken = Boolean(this.ccCondition());
            this.ccIf.push(taken);
            if (!taken)
            {
                this.skipBranch(true);
            }
            return undefined;
        }
        if (word === 'elif' || word === 'else')
        {
            if (this.ccIf.length === 0)
            {
                this.fail(1002, start);
            }
            // The branch being read has ended; the rest of the @if is not.
            this.skipBranch(false);
            return undefined;
        }
        if (word === 'end')
        {
            if (this.ccIf.length === 0)
            {
                this.fail(1002, start);
            }
            this.ccIf.pop();
            return undefined;
        }
        if (!this.ccOn)
        {
            this.fail(1030, start);
        }
        if (word === '')
        {
            this.fail(1002, start);
        }
        const token = this.variable(word, start);
        token.ccVariable = word;
        return token;
    }

    /**
     * A conditional-compilation variable as the constant it holds now.
     *
     * @param {string} name @param {number} start @returns {Token}
     */
    variable(name, start){
        const value = this.conditional.get(name) ?? NaN;
        return typeof value === 'boolean'
            ? this.token(T.NAME, value ? 'true' : 'false', start)
            : this.token(T.NUMBER, value, start);
    }

    /** @returns {string} the identifier at `at`, read past, or '' */
    word(){
        const start = this.at;
        while (this.at < this.text.length && isIdentifierPart(this.text.charCodeAt(this.at)))
        {
            this.at++;
        }
        return this.text.slice(start, this.at);
    }

    /** @returns {number | boolean} a parenthesised condition */
    ccCondition(){
        const open = this.next();
        if (open.t !== T.PUNCT || open.v !== '(')
        {
            this.fail(1005, open.s);
        }
        const value = this.ccExpression(0);
        const close = this.next();
        if (close.t !== T.PUNCT || close.v !== ')')
        {
            this.fail(1006, close.s);
        }
        return value;
    }

    /**
     * An expression of constants, read by precedence: conditional
     * compilation's own small language.
     *
     * @param {number} loosest @returns {number | boolean}
     */
    ccExpression(loosest){
        let left = this.ccUnary();
        for (;;)
        {
            const op = this.next();
            const precedence = op.t === T.PUNCT ? CC_PRECEDENCE.get(op.v) : undefined;
            if (precedence === undefined || precedence <= loosest)
            {
                this.pushed = op;
                return left;
            }
            left = ccBinary(op.v, left, this.ccExpression(precedence));
        }
    }

    /** @returns {number | boolean} */
    ccUnary(){
        const token = this.next();
        if (token.t === T.NUMBER)
        {
            return token.v;
        }
        if (token.t === T.NAME && (token.v === 'true' || token.v === 'false'))
        {
            return token.v === 'true';
        }
        if (token.t === T.PUNCT)
        {
            switch (token.v)
            {
                case '(':
                {
                    const value = this.ccExpression(0);
                    const close = this.next();
                    if (close.t !== T.PUNCT || close.v !== ')')
                    {
                        this.fail(1006, close.s);
                    }
                    return value;
                }
                case '!': return !this.ccUnary();
                case '~': return ~ccNumber(this.ccUnary());
                case '-': return -ccNumber(this.ccUnary());
                case '+': return ccNumber(this.ccUnary());
                default: break;
            }
        }
        return this.fail(1031, token.s);
    }

    /**
     * Steps over text an `@if` does not keep, to the `@elif` or `@else`
     * that starts a branch to read (when `seeking`), or to its `@end`.
     * Nested `@if`s are passed over whole. The text skipped is not read as
     * tokens -- only its directives are looked for.
     *
     * @param {boolean} seeking  Whether a later branch may still be taken.
     */
    skipBranch(seeking){
        const text = this.text;
        let depth = 0;
        for (;;)
        {
            const at = text.indexOf('@', this.at);
            if (at < 0)
            {
                this.at = text.length;
                this.fail(1029);
            }
            this.at = at + 1;
            const word = this.word();
            if (word === 'if')
            {
                depth++;
            }
            else if (word === 'end')
            {
                if (depth === 0)
                {
                    this.ccIf.pop();
                    return;
                }
                depth--;
            }
            else if (depth === 0 && seeking && word === 'else')
            {
                this.ccIf[this.ccIf.length - 1] = true;
                return;
            }
            else if (depth === 0 && seeking && word === 'elif')
            {
                if (this.ccCondition())
                {
                    this.ccIf[this.ccIf.length - 1] = true;
                    return;
                }
            }
        }
    }

    /** @param {number} c @returns {Token} */
    read(c){
        const start = this.at;
        if (isIdentifierStart(c) || c === 0x5c)
        {
            return this.name(start);
        }
        if ((c >= 0x30 && c <= 0x39)
            || (c === 0x2e && this.isDigit(this.text.charCodeAt(this.at + 1))))
        {
            return this.number(start);
        }
        if (c === 0x22 || c === 0x27)
        {
            return this.string(start, c);
        }
        for (const p of PUNCTUATORS)
        {
            if (this.text.startsWith(p, this.at))
            {
                this.at += p.length;
                return this.token(T.PUNCT, p, start);
            }
        }
        return this.fail(1014);
    }

    /** @param {number} c */
    isDigit(c){
        return c >= 0x30 && c <= 0x39;
    }

    /** @param {number} start @returns {Token} */
    name(start){
        const text = this.text;
        let value = '';
        let escaped = false;
        let first = true;
        while (this.at < text.length)
        {
            let c = text.charCodeAt(this.at);
            if (c === 0x5c)
            {
                if (text.charCodeAt(this.at + 1) !== 0x75)
                {
                    this.fail(1014);
                }
                this.at += 2;
                c = this.hexDigits(4);
                escaped = true;
                if (!(first ? isIdentifierStart(c) : isIdentifierPart(c)))
                {
                    this.fail(1014);
                }
                value += String.fromCharCode(c);
            }
            else if (first ? isIdentifierStart(c) : isIdentifierPart(c))
            {
                value += text[this.at];
                this.at++;
            }
            else
            {
                break;
            }
            first = false;
        }
        const token = this.token(T.NAME, value, start);
        if (escaped)
        {
            token.escaped = true;
        }
        return token;
    }

    /** @param {number} count @returns {number} */
    hexDigits(count){
        let value = 0;
        for (let i = 0; i < count; i++)
        {
            const digit = hexValue(this.text.charCodeAt(this.at));
            if (digit < 0)
            {
                this.fail(1023);
            }
            value = value * 16 + digit;
            this.at++;
        }
        return value;
    }

    /** @param {number} start @returns {Token} */
    number(start){
        const text = this.text;
        const c = text.charCodeAt(this.at);
        const following = text.charCodeAt(this.at + 1);
        let value;
        if (c === 0x30 && (following === 0x78 || following === 0x58))
        {
            this.at += 2;
            const digits = this.at;
            while (hexValue(text.charCodeAt(this.at)) >= 0)
            {
                this.at++;
            }
            if (this.at === digits)
            {
                this.fail(1023);
            }
            value = parseInt(text.slice(digits, this.at), 16);
        }
        else if (c === 0x30 && this.isDigit(following))
        {
            // An octal literal, as JScript reads one -- unless a digit 8 or 9
            // makes it decimal after all.
            this.at++;
            const digits = this.at;
            while (this.isDigit(text.charCodeAt(this.at)))
            {
                this.at++;
            }
            const spelled = text.slice(digits, this.at);
            value = /[89]/.test(spelled) ? Number(spelled) : parseInt(spelled, 8);
        }
        else
        {
            while (this.isDigit(text.charCodeAt(this.at)))
            {
                this.at++;
            }
            if (text.charCodeAt(this.at) === 0x2e)
            {
                this.at++;
                while (this.isDigit(text.charCodeAt(this.at)))
                {
                    this.at++;
                }
            }
            const e = text.charCodeAt(this.at);
            if (e === 0x65 || e === 0x45)
            {
                const mark = this.at;
                this.at++;
                const sign = text.charCodeAt(this.at);
                if (sign === 0x2b || sign === 0x2d)
                {
                    this.at++;
                }
                if (!this.isDigit(text.charCodeAt(this.at)))
                {
                    this.fail(1013, mark);
                }
                while (this.isDigit(text.charCodeAt(this.at)))
                {
                    this.at++;
                }
            }
            value = Number(text.slice(start, this.at));
        }
        if (this.at < text.length && isIdentifierStart(text.charCodeAt(this.at)))
        {
            this.fail(1013);
        }
        return this.token(T.NUMBER, value, start);
    }

    /** @param {number} start @param {number} quote @returns {Token} */
    string(start, quote){
        const text = this.text;
        this.at++;
        let value = '';
        for (;;)
        {
            if (this.at >= text.length)
            {
                this.fail(1015, start);
            }
            const c = text.charCodeAt(this.at);
            if (c === quote)
            {
                this.at++;
                break;
            }
            if (isLineTerminator(c))
            {
                this.fail(1015, start);
            }
            if (c !== 0x5c)
            {
                value += text[this.at];
                this.at++;
                continue;
            }
            this.at++;
            const e = text.charCodeAt(this.at);
            this.at++;
            switch (e)
            {
                case 0x62: value += '\b'; break;
                case 0x74: value += '\t'; break;
                case 0x6e: value += '\n'; break;
                case 0x66: value += '\f'; break;
                case 0x72: value += '\r'; break;
                case 0x78: value += String.fromCharCode(this.hexDigits(2)); break;
                case 0x75: value += String.fromCharCode(this.hexDigits(4)); break;
                case 0x0d:
                    // A continued line, CR LF counted as one break.
                    if (text.charCodeAt(this.at) === 0x0a)
                    {
                        this.at++;
                    }
                    break;
                case 0x0a: case 0x2028: case 0x2029:
                    break;
                default:
                    if (e >= 0x30 && e <= 0x37)
                    {
                        value += String.fromCharCode(this.octalEscape(e));
                    }
                    else if (Number.isNaN(e))
                    {
                        this.fail(1015, start);
                    }
                    else
                    {
                        // Every other escaped character is itself; `\v`
                        // among them, which is how JScript reads it.
                        value += String.fromCharCode(e);
                    }
            }
        }
        return this.token(T.STRING, value, start);
    }

    /**
     * Up to three octal digits, the first already read, worth at most 255.
     *
     * @param {number} first @returns {number}
     */
    octalEscape(first){
        let value = first - 0x30;
        const limit = first <= 0x33 ? 2 : 1;
        for (let i = 0; i < limit; i++)
        {
            const c = this.text.charCodeAt(this.at);
            if (c < 0x30 || c > 0x37)
            {
                break;
            }
            value = value * 8 + (c - 0x30);
            this.at++;
        }
        return value;
    }

    /**
     * Reads a `/` or `/=` token again as the start of a regular expression
     * literal, which is what it is where an expression begins.
     *
     * @param {Token} slash @returns {Token}
     */
    regex(slash){
        const text = this.text;
        this.at = slash.s + 1;
        let inClass = false;
        for (;;)
        {
            if (this.at >= text.length || isLineTerminator(text.charCodeAt(this.at)))
            {
                this.fail(1012, slash.s);
            }
            const c = text.charCodeAt(this.at);
            if (c === 0x5c)
            {
                this.at += 2;
                continue;
            }
            this.at++;
            if (c === 0x5b)
            {
                inClass = true;
            }
            else if (c === 0x5d)
            {
                inClass = false;
            }
            else if (c === 0x2f && !inClass)
            {
                break;
            }
        }
        const pattern = text.slice(slash.s + 1, this.at - 1);
        const flagsStart = this.at;
        while (this.at < text.length && isIdentifierPart(text.charCodeAt(this.at)))
        {
            this.at++;
        }
        return { t: T.REGEX, v: { pattern, flags: text.slice(flagsStart, this.at) },
            s: slash.s, e: this.at, nl: slash.nl };
    }
}

/**
 * Line and column of an offset, both counted from 0, as an active script
 * reports a position.
 *
 * @param {string} text @param {number} offset
 * @returns {{ line: number, column: number, lineText: string }}
 */
export function positionOf(text, offset){
    let line = 0;
    let lineStart = 0;
    const end = Math.min(offset, text.length);
    for (let i = 0; i < end; i++)
    {
        const c = text.charCodeAt(i);
        if (c === 0x0d && text.charCodeAt(i + 1) === 0x0a)
        {
            continue;
        }
        if (isLineTerminator(c))
        {
            line++;
            lineStart = i + 1;
        }
    }
    let lineEnd = lineStart;
    while (lineEnd < text.length && !isLineTerminator(text.charCodeAt(lineEnd)))
    {
        lineEnd++;
    }
    return { line, column: end - lineStart, lineText: text.slice(lineStart, lineEnd) };
}
