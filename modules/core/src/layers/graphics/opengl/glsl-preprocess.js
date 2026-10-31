/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The GLSL preprocessor (The OpenGL Shading Language 1.20, section 3.3),
 * turning a shader's source strings into the tokens the parser reads.
 *
 * What the specification decides here, and a C preprocessor would not:
 *
 * - **The strings are one text.** glShaderSource's strings are concatenated
 *   as they are, so a string that does not end in a newline continues on the
 *   next one's first line. A token keeps the string it came from and its line
 *   in that string, which is what an info log names (`0:12`), and what
 *   `__FILE__` and `__LINE__` expand to.
 * - **`#version` comes first**, before anything but comments and white
 *   space; 110 is assumed without one, and a version past 120 is an error,
 *   since this is what a 2.1 implementation compiles.
 * - **An identifier `#if` does not know is an error**, not zero; `defined` is
 *   the way to ask. There is no stringification and no token pasting.
 * - **Names starting with `GL_` belong to the implementation**: defining or
 *   undefining one is an error, as is redefining a predefined macro.
 * - **`#extension` names an extension this compiler supports**, and there
 *   are none: `require` fails, `enable` and `warn` warn.
 */

/**
 * @typedef {Object} Token
 * @property {'ident' | 'int' | 'float' | 'punct' | 'eof'} kind
 * @property {string} text
 * @property {number} string  the source string it came from
 * @property {number} line    its line in that string, from 1
 */

/**
 * @typedef {Object} Diagnostic
 * @property {'error' | 'warning'} severity
 * @property {number} string
 * @property {number} line
 * @property {string} message
 */

/**
 * @typedef {Object} Preprocessed
 * @property {Token[]} tokens   ending in an `eof` token
 * @property {number} version   110 or 120
 * @property {Diagnostic[]} diagnostics
 */

/** The versions this compiler takes. */
export const GLSL_VERSIONS = Object.freeze([110, 120]);

/** Punctuators, longest first so that a match is the longest one. */
const PUNCTUATORS = [
    '<<=', '>>=', '...',
    '++', '--', '<=', '>=', '==', '!=', '&&', '||', '^^', '+=', '-=', '*=', '/=', '%=',
    '&=', '|=', '^=', '<<', '>>',
    '(', ')', '[', ']', '{', '}', '.', ',', ';', ':', '?', '=', '+', '-', '*', '/', '%',
    '<', '>', '!', '~', '&', '|', '^', '#',
];

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;

/**
 * @typedef {Object} RawToken
 * @property {'ident' | 'number' | 'punct' | 'other'} kind
 * @property {string} text
 * @property {number} string
 * @property {number} line
 * @property {number} [column]  where on its line it starts
 * @property {boolean} [painted]  an identifier that named a macro being expanded
 *           when it was produced, which never expands again
 */

/**
 * Where each character of the joined text came from.
 *
 * @param {readonly string[]} sources
 */
function joinSources(sources){
    const text = sources.join('');
    /** @type {number[]} the offset each string starts at */
    const starts = [];
    let at = 0;
    for (const source of sources)
    {
        starts.push(at);
        at += source.length;
    }
    return { text, starts };
}

/**
 * The text with comments blanked out, character for character: each becomes
 * spaces, with the newlines a block comment spanned kept, so an offset into
 * the result is the same offset into the source.
 *
 * @param {string} text
 * @returns {{ text: string, unterminated: number }}  where an unterminated
 *     block comment starts, or -1
 */
function stripComments(text){
    let out = '';
    let i = 0;
    /** @param {number} end */
    const blank = end=>{
        out += text.slice(i, end).replace(/[^\n]/g, ' ');
        i = end;
    };
    while (i < text.length)
    {
        const next = text.indexOf('/', i);
        if (next < 0)
        {
            out += text.slice(i);
            break;
        }
        out += text.slice(i, next);
        i = next;
        if (text[i + 1] === '/')
        {
            const end = text.indexOf('\n', i);
            blank(end < 0 ? text.length : end);
            continue;
        }
        if (text[i + 1] === '*')
        {
            const end = text.indexOf('*/', i + 2);
            if (end < 0)
            {
                const unterminated = i;
                blank(text.length);
                return { text: out, unterminated };
            }
            blank(end + 2);
            continue;
        }
        out += '/';
        i++;
    }
    return { text: out, unterminated: -1 };
}

/**
 * The tokens of one line.
 *
 * @param {string} line
 * @param {number} string
 * @param {number} number
 * @returns {RawToken[]}
 */
function lexLine(line, string, number){
    /** @type {RawToken[]} */
    const tokens = [];
    let i = 0;
    while (i < line.length)
    {
        const c = line[i];
        if (c === ' ' || c === '\t' || c === '\r' || c === '\v' || c === '\f')
        {
            i++;
            continue;
        }
        if (IDENT_START.test(c))
        {
            let j = i + 1;
            while (j < line.length && IDENT_PART.test(line[j]))
            {
                j++;
            }
            tokens.push({ kind: 'ident', text: line.slice(i, j), string, line: number,
                column: i });
            i = j;
            continue;
        }
        if (DIGIT.test(c) || (c === '.' && DIGIT.test(line[i + 1] ?? '')))
        {
            // A preprocessing number: digits, letters, dots, and a sign
            // after an exponent's e, read as one and classified later.
            let j = i + 1;
            while (j < line.length)
            {
                const d = line[j];
                if (IDENT_PART.test(d) || d === '.')
                {
                    j++;
                    continue;
                }
                if ((d === '+' || d === '-') && /[eE]/.test(line[j - 1])
                    && !/^0[xX]/.test(line.slice(i, j)))
                {
                    j++;
                    continue;
                }
                break;
            }
            tokens.push({ kind: 'number', text: line.slice(i, j), string, line: number,
                column: i });
            i = j;
            continue;
        }
        const punct = PUNCTUATORS.find(p=>line.startsWith(p, i));
        if (punct)
        {
            tokens.push({ kind: 'punct', text: punct, string, line: number, column: i });
            i += punct.length;
            continue;
        }
        tokens.push({ kind: 'other', text: c, string, line: number, column: i });
        i++;
    }
    return tokens;
}

/** @param {string} text */
const isInteger = text=>/^(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)$/.test(text);
/** @param {string} text */
const isFloat = text=>/^(([0-9]+\.[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?|[0-9]+[eE][+-]?[0-9]+)[fF]?$/
    .test(text);

/**
 * @typedef {Object} Macro
 * @property {string[] | null} params  null for an object-like macro
 * @property {RawToken[]} body
 * @property {boolean} [predefined]
 */

/**
 * @param {readonly string[]} sources  glShaderSource's strings, in order
 * @returns {Preprocessed}
 */
export function preprocess(sources){
    /** @type {Diagnostic[]} */
    const diagnostics = [];
    const joined = joinSources(sources);
    const stripped = stripComments(joined.text);

    // Where an offset came from, walked forward from the last one asked:
    // the lines are read in order, so the walk is once over the text. A
    // position belongs to the last string starting at or before it.
    /** @param {number} at @param {number} string */
    const settle = (at, string)=>{
        let s = string;
        while (s + 1 < joined.starts.length && joined.starts[s + 1] <= at)
        {
            s++;
        }
        return s;
    };
    let walked = { offset: 0, string: settle(0, 0), line: 1 };
    /** @param {number} offset @returns {{ string: number, line: number }} */
    const originOf = offset=>{
        if (offset < walked.offset)
        {
            walked = { offset: 0, string: settle(0, 0), line: 1 };
        }
        let { string, line } = walked;
        for (let k = walked.offset; k < offset; k++)
        {
            if (joined.text[k] === '\n')
            {
                line++;
            }
            const next = settle(k + 1, string);
            if (next !== string)
            {
                string = next;
                line = 1;
            }
        }
        walked = { offset, string, line };
        return { string, line };
    };
    if (stripped.unterminated >= 0)
    {
        const where = originOf(stripped.unterminated);
        diagnostics.push({ severity: 'error', ...where, message: 'unterminated comment' });
    }

    // Lines, each with where it begins; a line's tokens carry its origin,
    // and a string boundary inside a line moves the line counter of the
    // tokens after it.
    /** @type {{ text: string, offset: number }[]} */
    const lines = [];
    {
        let offset = 0;
        for (const text of stripped.text.split('\n'))
        {
            lines.push({ text, offset });
            offset += text.length + 1;
        }
    }

    /** @type {Map<string, Macro>} */
    const macros = new Map();
    let version = 110;
    let versionSeen = false;
    let anythingSeen = false;
    /** The line offset `#line` set: what the next line's number is said to be, less its own. */
    let lineShift = 0;
    let stringOverride = -1;

    /** @param {RawToken} at @param {string} message */
    const error = (at, message)=>{
        diagnostics.push({ severity: 'error', string: at.string, line: at.line, message });
    };
    /** @param {RawToken} at @param {string} message */
    const warning = (at, message)=>{
        diagnostics.push({ severity: 'warning', string: at.string, line: at.line, message });
    };

    /**
     * The tokens of a stored line, each tagged with the string and line its
     * characters came from (`#line` applied).
     *
     * @param {{ text: string, offset: number }} entry
     * @returns {RawToken[]}
     */
    const tokensOf = entry=>{
        const tokens = lexLine(entry.text, 0, 0);
        for (const token of tokens)
        {
            const origin = originOf(entry.offset + (token.column ?? 0));
            token.string = stringOverride >= 0 ? stringOverride : origin.string;
            token.line = origin.line + lineShift;
        }
        return tokens;
    };

    // --- #if expressions ---

    /**
     * @param {RawToken[]} tokens  after `defined` and macros are dealt with
     * @param {RawToken} at
     * @returns {number | null}  null when the expression is malformed
     */
    const evaluate = (tokens, at)=>{
        let i = 0;
        let failed = false;
        const peek = ()=>tokens[i]?.text;
        /** @returns {number} */
        const primary = ()=>{
            const token = tokens[i++];
            if (!token)
            {
                failed = true;
                return 0;
            }
            if (token.text === '(')
            {
                const value = conditional();
                if (tokens[i++]?.text !== ')')
                {
                    failed = true;
                }
                return value;
            }
            if (token.kind === 'number' && isInteger(token.text))
            {
                return Number.parseInt(token.text, /^0[xX]/.test(token.text) ? 16
                    : token.text.length > 1 && token.text[0] === '0' ? 8 : 10) | 0;
            }
            if (token.kind === 'ident')
            {
                error(token, `'${token.text}' : undefined identifier in a preprocessor expression`);
                failed = true;
                return 0;
            }
            failed = true;
            return 0;
        };
        /** @returns {number} */
        const unary = ()=>{
            const op = peek();
            if (op === '+' || op === '-' || op === '!' || op === '~')
            {
                i++;
                const value = unary();
                return op === '+' ? value : op === '-' ? -value | 0 : op === '!' ? (value ? 0 : 1)
                    : ~value;
            }
            return primary();
        };
        /** @type {[string[], (a: number, b: number, op: string) => number][]} */
        const levels = [
            [['*', '/', '%'], (a, b, op)=>{
                if (op !== '*' && b === 0)
                {
                    error(at, 'division by zero in a preprocessor expression');
                    failed = true;
                    return 0;
                }
                return op === '*' ? Math.imul(a, b) : op === '/' ? (a / b) | 0 : a % b;
            }],
            [['+', '-'], (a, b, op)=>(op === '+' ? (a + b) | 0 : (a - b) | 0)],
            [['<<', '>>'], (a, b, op)=>(op === '<<' ? a << b : a >> b)],
            [['<', '>', '<=', '>='], (a, b, op)=>Number(op === '<' ? a < b : op === '>' ? a > b
                : op === '<=' ? a <= b : a >= b)],
            [['==', '!='], (a, b, op)=>Number(op === '==' ? a === b : a !== b)],
            [['&'], (a, b)=>a & b],
            [['^'], (a, b)=>a ^ b],
            [['|'], (a, b)=>a | b],
            [['&&'], (a, b)=>Number(a !== 0 && b !== 0)],
            [['||'], (a, b)=>Number(a !== 0 || b !== 0)],
        ];
        /** @param {number} level @returns {number} */
        const binary = level=>{
            if (level < 0)
            {
                return unary();
            }
            const [ops, apply] = levels[level];
            let value = binary(level - 1);
            while (ops.includes(peek() ?? ''))
            {
                const op = /** @type {string} */ (peek());
                i++;
                value = apply(value, binary(level - 1), op);
            }
            return value;
        };
        /** @returns {number} */
        const conditional = ()=>{
            const test = binary(levels.length - 1);
            if (peek() !== '?')
            {
                return test;
            }
            i++;
            const then = conditional();
            if (tokens[i++]?.text !== ':')
            {
                failed = true;
            }
            const otherwise = conditional();
            return test ? then : otherwise;
        };
        const value = conditional();
        if (i !== tokens.length)
        {
            failed = true;
        }
        return failed ? null : value;
    };

    // --- macro expansion ---

    /**
     * @param {RawToken[]} tokens
     * @param {Set<string>} disabled  the macros being expanded around these tokens
     * @param {() => RawToken[] | null} [more]  the next line's tokens, for a
     *     function-like macro whose arguments go on past this line
     * @returns {RawToken[]}
     */
    const expand = (tokens, disabled, more)=>{
        /** @type {RawToken[]} */
        const out = [];
        const queue = tokens.slice();
        while (queue.length > 0)
        {
            const token = /** @type {RawToken} */ (queue.shift());
            if (token.kind !== 'ident' || token.painted)
            {
                out.push(token);
                continue;
            }
            if (token.text === '__LINE__')
            {
                out.push({ kind: 'number', text: String(token.line), string: token.string,
                    line: token.line });
                continue;
            }
            if (token.text === '__VERSION__')
            {
                out.push({ kind: 'number', text: String(version), string: token.string,
                    line: token.line });
                continue;
            }
            if (token.text === '__FILE__')
            {
                out.push({ kind: 'number', text: String(token.string), string: token.string,
                    line: token.line });
                continue;
            }
            const macro = macros.get(token.text);
            if (!macro)
            {
                out.push(token);
                continue;
            }
            if (disabled.has(token.text))
            {
                out.push({ ...token, painted: true });
                continue;
            }
            /** @param {RawToken[]} body */
            const located = body=>body.map(part=>({ ...part, string: token.string,
                line: token.line }));
            if (macro.params === null)
            {
                const inner = new Set(disabled).add(token.text);
                queue.unshift(...expand(located(macro.body), inner));
                continue;
            }
            // A function-like macro's name without arguments is just a name.
            if (queue.length === 0 && more)
            {
                for (let next = more(); next !== null; next = queue.length === 0 ? more() : null)
                {
                    queue.push(...next);
                }
            }
            if (queue[0]?.text !== '(')
            {
                out.push(token);
                continue;
            }
            queue.shift();
            /** @type {RawToken[][]} */
            const args = [[]];
            let depth = 0;
            let closed = false;
            for (;;)
            {
                if (queue.length === 0)
                {
                    const next = more ? more() : null;
                    if (next === null)
                    {
                        break;
                    }
                    queue.push(...next);
                    continue;
                }
                const part = /** @type {RawToken} */ (queue.shift());
                if (part.text === '(')
                {
                    depth++;
                }
                else if (part.text === ')')
                {
                    if (depth === 0)
                    {
                        closed = true;
                        break;
                    }
                    depth--;
                }
                else if (part.text === ',' && depth === 0)
                {
                    args.push([]);
                    continue;
                }
                args[args.length - 1].push(part);
            }
            if (!closed)
            {
                error(token, `'${token.text}' : unterminated macro invocation`);
                continue;
            }
            const given = args.length === 1 && args[0].length === 0 ? [] : args;
            if (given.length !== macro.params.length)
            {
                error(token, `'${token.text}' : macro expects ${macro.params.length} arguments,`
                    + ` given ${given.length}`);
                continue;
            }
            const expanded = given.map(arg=>expand(arg, disabled));
            /** @type {RawToken[]} */
            const substituted = [];
            for (const part of macro.body)
            {
                const index = part.kind === 'ident' ? macro.params.indexOf(part.text) : -1;
                if (index >= 0)
                {
                    substituted.push(...expanded[index]);
                }
                else
                {
                    substituted.push({ ...part, string: token.string, line: token.line });
                }
            }
            queue.unshift(...expand(substituted, new Set(disabled).add(token.text)));
        }
        return out;
    };

    // --- the lines ---

    /** @type {{ active: boolean, taken: boolean, sawElse: boolean, at: RawToken }[]} */
    const conditions = [];
    const active = ()=>conditions.every(entry=>entry.active);
    /** @type {RawToken[]} */
    const output = [];
    let lineIndex = 0;
    /** The next line's tokens, outside any directive, for a macro's arguments. */
    const nextLine = ()=>{
        while (lineIndex < lines.length)
        {
            const tokens = tokensOf(lines[lineIndex++]);
            if (tokens[0]?.text === '#')
            {
                lineIndex--;
                return null;
            }
            if (tokens.length > 0)
            {
                return tokens;
            }
        }
        return null;
    };

    // Predefined: `defined` finds them, and nothing redefines them; their
    // values are made where they are expanded.
    for (const predefined of ['__VERSION__', '__LINE__', '__FILE__'])
    {
        macros.set(predefined, { params: null, body: [], predefined: true });
    }

    while (lineIndex < lines.length)
    {
        const tokens = tokensOf(lines[lineIndex++]);
        if (tokens.length === 0)
        {
            continue;
        }
        if (tokens[0].text !== '#')
        {
            if (!active())
            {
                continue;
            }
            anythingSeen = true;
            output.push(...expand(tokens, new Set(), nextLine));
            continue;
        }
        const hash = tokens[0];
        const name = tokens[1];
        const rest = tokens.slice(2);
        if (!name)
        {
            continue;
        }
        const directive = name.text;
        // The conditionals are followed even where the text is skipped, to
        // know where the skipping ends.
        if (directive === 'ifdef' || directive === 'ifndef' || directive === 'if')
        {
            if (!active())
            {
                conditions.push({ active: false, taken: true, sawElse: false, at: hash });
                continue;
            }
            let value = false;
            if (directive === 'if')
            {
                value = condition(rest, hash);
            }
            else if (rest[0]?.kind !== 'ident')
            {
                error(hash, `#${directive} needs a macro name`);
            }
            else
            {
                value = macros.has(rest[0].text) === (directive === 'ifdef');
            }
            conditions.push({ active: value, taken: value, sawElse: false, at: hash });
            continue;
        }
        if (directive === 'elif' || directive === 'else')
        {
            const top = conditions[conditions.length - 1];
            if (!top || top.sawElse)
            {
                error(hash, `#${directive} without a matching #if`);
                continue;
            }
            const outer = conditions.slice(0, -1).every(entry=>entry.active);
            if (directive === 'else')
            {
                top.sawElse = true;
                top.active = outer && !top.taken;
                top.taken = true;
                continue;
            }
            const value = outer && !top.taken ? condition(rest, hash) : false;
            top.active = value;
            top.taken = top.taken || value;
            continue;
        }
        if (directive === 'endif')
        {
            if (!conditions.pop())
            {
                error(hash, '#endif without a matching #if');
            }
            continue;
        }
        if (!active())
        {
            continue;
        }
        switch (directive)
        {
            case 'version': {
                if (versionSeen || anythingSeen)
                {
                    error(hash, '#version must occur before anything else in the shader');
                    break;
                }
                versionSeen = true;
                anythingSeen = true;
                const number = rest[0];
                if (!number || number.kind !== 'number' || !isInteger(number.text))
                {
                    error(hash, '#version needs a number');
                    break;
                }
                const asked = Number.parseInt(number.text, 10);
                if (!GLSL_VERSIONS.includes(asked))
                {
                    error(number, `version ${asked} is not supported: this implementation`
                        + ' compiles GLSL 1.10 and 1.20');
                    break;
                }
                version = asked;
                break;
            }
            case 'define': {
                anythingSeen = true;
                const macroName = rest[0];
                if (!macroName || macroName.kind !== 'ident')
                {
                    error(hash, '#define needs a macro name');
                    break;
                }
                if (macroName.text.startsWith('GL_') || macroName.text === 'defined'
                    || macros.get(macroName.text)?.predefined)
                {
                    error(macroName, `'${macroName.text}' : a reserved name cannot be defined`);
                    break;
                }
                if (macroName.text.includes('__'))
                {
                    warning(macroName, `'${macroName.text}' : names containing two`
                        + ' underscores are reserved');
                }
                /** @type {string[] | null} */
                let params = null;
                let bodyStart = 1;
                // A parameter list only when the parenthesis touches the name.
                const touching = rest[1]?.column === (macroName.column ?? 0)
                    + macroName.text.length;
                if (rest[1]?.text === '(' && touching)
                {
                    params = [];
                    let k = 2;
                    let ok = true;
                    if (rest[k]?.text === ')')
                    {
                        k++;
                    }
                    else
                    {
                        for (;;)
                        {
                            const param = rest[k];
                            if (!param || param.kind !== 'ident')
                            {
                                ok = false;
                                break;
                            }
                            params.push(param.text);
                            k++;
                            if (rest[k]?.text === ',')
                            {
                                k++;
                                continue;
                            }
                            if (rest[k]?.text === ')')
                            {
                                k++;
                                break;
                            }
                            ok = false;
                            break;
                        }
                    }
                    if (!ok)
                    {
                        error(macroName, `'${macroName.text}' : malformed macro parameter list`);
                        break;
                    }
                    bodyStart = k;
                }
                const body = rest.slice(bodyStart);
                const existing = macros.get(macroName.text);
                if (existing && (JSON.stringify(existing.params) !== JSON.stringify(params)
                    || existing.body.map(t=>t.text).join(' ') !== body.map(t=>t.text).join(' ')))
                {
                    error(macroName, `'${macroName.text}' : macro redefined differently`);
                    break;
                }
                macros.set(macroName.text, { params, body });
                break;
            }
            case 'undef': {
                anythingSeen = true;
                const macroName = rest[0];
                if (!macroName || macroName.kind !== 'ident')
                {
                    error(hash, '#undef needs a macro name');
                    break;
                }
                if (macroName.text.startsWith('GL_') || macros.get(macroName.text)?.predefined)
                {
                    error(macroName, `'${macroName.text}' : a predefined macro cannot be`
                        + ' undefined');
                    break;
                }
                macros.delete(macroName.text);
                break;
            }
            case 'error':
                error(hash, `#error ${rest.map(t=>t.text).join(' ')}`);
                break;
            case 'pragma':
                break;
            case 'extension': {
                anythingSeen = true;
                const extension = rest[0];
                const behaviour = rest[2];
                if (!extension || rest[1]?.text !== ':' || !behaviour
                    || !['require', 'enable', 'warn', 'disable'].includes(behaviour.text))
                {
                    error(hash, '#extension needs a name, a colon and a behaviour');
                    break;
                }
                if (extension.text === 'all')
                {
                    if (behaviour.text === 'require' || behaviour.text === 'enable')
                    {
                        error(behaviour, `'${behaviour.text}' : not allowed with 'all'`);
                    }
                    break;
                }
                if (behaviour.text === 'require')
                {
                    error(extension, `'${extension.text}' : extension is not supported`);
                }
                else if (behaviour.text !== 'disable')
                {
                    warning(extension, `'${extension.text}' : extension is not supported`);
                }
                break;
            }
            case 'line': {
                const expanded = expand(rest, new Set());
                const number = expanded[0];
                if (!number || number.kind !== 'number' || !isInteger(number.text))
                {
                    error(hash, '#line needs a line number');
                    break;
                }
                // The line after the directive is the one numbered.
                const next = Number.parseInt(number.text, 10);
                lineShift += next - (hash.line + 1);
                if (expanded[1])
                {
                    if (expanded[1].kind !== 'number' || !isInteger(expanded[1].text))
                    {
                        error(hash, '#line needs a source string number');
                        break;
                    }
                    stringOverride = Number.parseInt(expanded[1].text, 10);
                }
                break;
            }
            default:
                error(name, `'${directive}' : invalid directive`);
        }
    }
    for (const left of conditions)
    {
        error(left.at, 'unterminated conditional directive');
    }

    /**
     * @param {RawToken[]} rest
     * @param {RawToken} hash
     * @returns {boolean}
     */
    function condition(rest, hash){
        /** @type {RawToken[]} */
        const resolved = [];
        for (let k = 0; k < rest.length; k++)
        {
            const token = rest[k];
            if (token.kind === 'ident' && token.text === 'defined')
            {
                const parens = rest[k + 1]?.text === '(';
                const named = rest[k + (parens ? 2 : 1)];
                if (!named || named.kind !== 'ident' || (parens && rest[k + 3]?.text !== ')'))
                {
                    error(token, "'defined' : needs a macro name");
                    return false;
                }
                resolved.push({ kind: 'number', text: macros.has(named.text) ? '1' : '0',
                    string: token.string, line: token.line });
                k += parens ? 3 : 1;
                continue;
            }
            resolved.push(token);
        }
        const reported = diagnostics.length;
        const value = evaluate(expand(resolved, new Set()), hash);
        if (value === null)
        {
            if (diagnostics.length === reported)
            {
                error(hash, 'malformed preprocessor expression');
            }
            return false;
        }
        return value !== 0;
    }

    /** @type {Token[]} */
    const tokens = [];
    for (const token of output)
    {
        if (token.kind === 'number')
        {
            if (isInteger(token.text))
            {
                tokens.push({ kind: 'int', text: token.text, string: token.string,
                    line: token.line });
            }
            else if (isFloat(token.text))
            {
                tokens.push({ kind: 'float', text: token.text, string: token.string,
                    line: token.line });
            }
            else
            {
                error(token, `'${token.text}' : invalid number`);
            }
            continue;
        }
        if (token.kind === 'other')
        {
            error(token, `'${token.text}' : invalid character`);
            continue;
        }
        if (token.kind === 'punct' && token.text === '#')
        {
            error(token, "'#' : unexpected outside a directive");
            continue;
        }
        tokens.push({ kind: token.kind === 'ident' ? 'ident' : 'punct', text: token.text,
            string: token.string, line: token.line });
    }
    const last = tokens[tokens.length - 1];
    tokens.push({ kind: 'eof', text: '', string: last?.string ?? 0, line: last?.line ?? 1 });
    return { tokens, version, diagnostics };
}
