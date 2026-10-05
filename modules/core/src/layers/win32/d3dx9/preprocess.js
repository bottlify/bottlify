/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The C preprocessor HLSL source goes through before it is compiled, as
 * D3DXPreprocessShader runs it: comments become a space, a backslash joins a
 * line to the next, and the directives -- #define with and without parameters,
 * #undef, #include, #if/#ifdef/#ifndef/#elif/#else/#endif over integer
 * expressions with `defined`, #error, #pragma and #line -- are carried out.
 * Every line of the source keeps a line of the output, a directive's an empty
 * one, so a line number in what follows still names the source's line.
 *
 * `#include` asks the caller, which in D3DX is the program's ID3DXInclude:
 * that is a call into the guest and so may answer later, which is why this is
 * asynchronous.
 */

/**
 * @typedef {Object} Macro
 * @property {string[] | null} params  Null for an object-like macro.
 * @property {string} body
 */

/**
 * @typedef {Object} PreprocessOptions
 * @property {[string, string][]} [defines]  D3DXMACRO's names and definitions.
 * @property {(name: string, system: boolean, parent: string) =>
 *     Promise<string | null> | string | null} [include]
 *           A file's text, or null when it cannot be had.
 */

const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/y;

/**
 * Removes comments, keeping the newlines inside a block comment, and joins
 * lines ended by a backslash -- keeping the count of lines by adding the
 * joined ones back after the line they joined.
 *
 * @param {string} source
 * @returns {string[]}
 */
function logicalLines(source){
    let text = '';
    let i = 0;
    while (i < source.length)
    {
        const c = source[i];
        if (c === '"' || c === '\'')
        {
            let j = i + 1;
            while (j < source.length && source[j] !== c && source[j] !== '\n')
            {
                j += source[j] === '\\' ? 2 : 1;
            }
            text += source.slice(i, j + 1);
            i = j + 1;
        }
        else if (c === '/' && source[i + 1] === '/')
        {
            while (i < source.length && source[i] !== '\n')
            {
                i++;
            }
        }
        else if (c === '/' && source[i + 1] === '*')
        {
            const end = source.indexOf('*/', i + 2);
            const body = source.slice(i, end < 0 ? source.length : end + 2);
            text += ' ' + '\n'.repeat(body.split('\n').length - 1);
            i += body.length;
        }
        else
        {
            text += c;
            i++;
        }
    }
    const raw = text.replace(/\r\n?/g, '\n').split('\n');
    /** @type {string[]} */
    const lines = [];
    for (let n = 0; n < raw.length; n++)
    {
        let line = raw[n];
        let joined = 0;
        while (line.endsWith('\\') && n + 1 < raw.length)
        {
            line = line.slice(0, -1) + raw[++n];
            joined++;
        }
        lines.push(line, ...new Array(joined).fill(''));
    }
    return lines;
}

/**
 * Splits a function-like macro's arguments at the commas outside brackets.
 *
 * @param {string} text  From just after the opening parenthesis.
 * @returns {{ args: string[], end: number } | null}  `end` just past the closing one.
 */
function splitArguments(text){
    const args = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < text.length; i++)
    {
        const c = text[i];
        if (c === '(' || c === '[' || c === '{')
        {
            depth++;
        }
        else if ((c === ')' || c === ']' || c === '}') && depth > 0)
        {
            depth--;
        }
        else if (c === ')' && depth === 0)
        {
            args.push(text.slice(start, i).trim());
            return { args, end: i + 1 };
        }
        else if (c === ',' && depth === 0)
        {
            args.push(text.slice(start, i).trim());
            start = i + 1;
        }
    }
    return null;
}

/**
 * Expands the macros in a line of text, each one not inside its own expansion.
 *
 * @param {string} text
 * @param {Map<string, Macro>} macros
 * @param {Set<string>} [hidden]
 * @returns {string}
 */
export function expand(text, macros, hidden = new Set()){
    let out = '';
    let i = 0;
    while (i < text.length)
    {
        const c = text[i];
        if (c === '"')
        {
            let j = i + 1;
            while (j < text.length && text[j] !== '"')
            {
                j += text[j] === '\\' ? 2 : 1;
            }
            out += text.slice(i, j + 1);
            i = j + 1;
            continue;
        }
        IDENTIFIER.lastIndex = i;
        const match = /[A-Za-z_]/.test(c) && (i === 0 || !/[A-Za-z0-9_]/.test(text[i - 1]))
            ? IDENTIFIER.exec(text) : null;
        if (!match)
        {
            out += c;
            i++;
            continue;
        }
        const name = match[0];
        const macro = hidden.has(name) ? undefined : macros.get(name);
        let next = i + name.length;
        if (!macro)
        {
            out += name;
            i = next;
            continue;
        }
        let body = macro.body;
        if (macro.params)
        {
            let at = next;
            while (at < text.length && /\s/.test(text[at]))
            {
                at++;
            }
            const split = text[at] === '(' ? splitArguments(text.slice(at + 1)) : null;
            if (!split)
            {
                out += name;
                i = next;
                continue;
            }
            next = at + 1 + split.end;
            const params = macro.params;
            const args = split.args.map(arg=>expand(arg, macros, hidden));
            body = body.replace(/#\s*([A-Za-z_][A-Za-z0-9_]*)/g, (whole, param)=>{
                const index = params.indexOf(param);
                return index < 0 ? whole : JSON.stringify(split.args[index] ?? '');
            });
            body = body.replace(/[A-Za-z_][A-Za-z0-9_]*/g, word=>{
                const index = params.indexOf(word);
                return index < 0 ? word : args[index] ?? '';
            });
        }
        body = body.replace(/\s*##\s*/g, '');
        out += expand(body, macros, new Set([...hidden, name]));
        i = next;
    }
    return out;
}

/**
 * The value of an #if expression: integers, `defined NAME` and
 * `defined(NAME)`, the unary, arithmetic, shift, comparison, bitwise and
 * logical operators and `?:`, with C's precedence. A name left after
 * expansion is zero.
 *
 * @param {string} text
 * @param {Map<string, Macro>} macros
 */
export function evaluate(text, macros){
    const resolved = text.replace(/\bdefined\s*(?:\(\s*([A-Za-z_]\w*)\s*\)|([A-Za-z_]\w*))/g,
        (_, a, b)=>(macros.has(a ?? b) ? ' 1 ' : ' 0 '));
    const tokens = expand(resolved, macros)
        .match(/0[xX][0-9a-fA-F]+|\d+|[A-Za-z_]\w*|&&|\|\||<<|>>|<=|>=|==|!=|[-+*/%<>&|^!~?:()]/g)
        ?? [];
    let at = 0;
    const peek = ()=>tokens[at];
    const take = ()=>tokens[at++];
    /** @returns {number} */
    const primary = ()=>{
        const token = take();
        if (token === '(')
        {
            const value = conditional();
            take();
            return value;
        }
        if (token === '-')
        {
            return -primary();
        }
        if (token === '+')
        {
            return primary();
        }
        if (token === '!')
        {
            return primary() ? 0 : 1;
        }
        if (token === '~')
        {
            return ~primary();
        }
        if (token !== undefined && /^\d|^0[xX]/.test(token))
        {
            return parseInt(token, token.startsWith('0x') || token.startsWith('0X') ? 16 : 10);
        }
        return 0;
    };
    /** What each binary operator makes of two integers. */
    /** @type {Record<string, (a: number, b: number) => number>} */
    const OPERATORS = {
        '*': (a, b)=>a * b, '/': (a, b)=>(b ? Math.trunc(a / b) : 0), '%': (a, b)=>(b ? a % b : 0),
        '+': (a, b)=>a + b, '-': (a, b)=>a - b, '<<': (a, b)=>a << b, '>>': (a, b)=>a >> b,
        '<': (a, b)=>Number(a < b), '>': (a, b)=>Number(a > b), '<=': (a, b)=>Number(a <= b),
        '>=': (a, b)=>Number(a >= b), '==': (a, b)=>Number(a === b), '!=': (a, b)=>Number(a !== b),
        '&': (a, b)=>a & b, '^': (a, b)=>a ^ b, '|': (a, b)=>a | b,
        '&&': (a, b)=>Number(Boolean(a && b)), '||': (a, b)=>Number(Boolean(a || b)),
    };
    /** Each level of binary operators, the tightest first. */
    const LEVELS = [['*', '/', '%'], ['+', '-'], ['<<', '>>'], ['<', '>', '<=', '>='], ['==', '!='],
        ['&'], ['^'], ['|'], ['&&'], ['||']];
    /** @param {number} level @returns {number} */
    const binary = level=>{
        if (level < 0)
        {
            return primary();
        }
        let value = binary(level - 1);
        while (LEVELS[level].includes(peek()))
        {
            const op = take();
            value = OPERATORS[op](value, binary(level - 1));
        }
        return value;
    };
    /** @returns {number} */
    const conditional = ()=>{
        const test = binary(LEVELS.length - 1);
        if (peek() !== '?')
        {
            return test;
        }
        take();
        const yes = conditional();
        take();
        const no = conditional();
        return test ? yes : no;
    };
    return conditional();
}

/**
 * @typedef {Object} Origin
 * @property {string} file
 * @property {number} line
 */

/**
 * HLSL source preprocessed, or the error a directive raised. `origins` has an
 * entry for each line of the text: the file it was read from and its line
 * there, which differ from the text's own once an include has been expanded.
 *
 * @param {string} source
 * @param {PreprocessOptions} [options]
 * @returns {Promise<{ text: string, origins: Origin[] } | { error: string }>}
 */
export async function preprocessTracked(source, options = {}){
    /** @type {Map<string, Macro>} */
    const macros = new Map();
    for (const [name, value] of options.defines ?? [])
    {
        macros.set(name, { params: null, body: value ?? '' });
    }
    /** @type {string[]} */
    const out = [];
    /** Where each output line came from: the file and its line there. @type {Origin[]} */
    const origins = [];
    /** @param {string} text @param {string} file @param {number} n */
    const emit = (text, file, n)=>{
        out.push(text);
        origins.push({ file, line: n + 1 });
    };
    /**
     * @param {string} text @param {string} file @param {number} depth
     * @returns {Promise<string | null>}  An error, or null.
     */
    const run = async(text, file, depth)=>{
        /** Whether each open #if's branch is taken, and whether one was. */
        /** @type {{ active: boolean, taken: boolean, outer: boolean }[]} */
        const stack = [];
        const active = ()=>stack.every(level=>level.active);
        const lines = logicalLines(text);
        for (let n = 0; n < lines.length; n++)
        {
            const line = lines[n];
            const directive = /^\s*#\s*(\w*)\s*(.*)$/.exec(line);
            if (!directive)
            {
                emit(active() ? expand(line, macros) : '', file, n);
                continue;
            }
            emit('', file, n);
            const [, name, rest] = directive;
            const where = `${file}(${n + 1})`;
            if (name === 'if' || name === 'ifdef' || name === 'ifndef')
            {
                const outer = active();
                const word = rest.trim().split(/\s+/)[0];
                const value = !outer ? false : name === 'if' ? evaluate(rest, macros) !== 0
                    : name === 'ifdef' ? macros.has(word) : !macros.has(word);
                stack.push({ active: value, taken: value, outer });
            }
            else if (name === 'elif')
            {
                const top = stack.at(-1);
                if (!top)
                {
                    return `${where}: #elif without #if`;
                }
                top.active = top.outer && !top.taken && evaluate(rest, macros) !== 0;
                top.taken ||= top.active;
            }
            else if (name === 'else')
            {
                const top = stack.at(-1);
                if (!top)
                {
                    return `${where}: #else without #if`;
                }
                top.active = top.outer && !top.taken;
                top.taken = true;
            }
            else if (name === 'endif')
            {
                if (!stack.pop())
                {
                    return `${where}: #endif without #if`;
                }
            }
            else if (!active())
            {
                continue;
            }
            else if (name === 'define')
            {
                const match = /^([A-Za-z_]\w*)(\(([^)]*)\))?\s*(.*)$/.exec(rest);
                if (!match)
                {
                    return `${where}: a #define names nothing`;
                }
                macros.set(match[1], {
                    params: match[2] === undefined ? null
                        : match[3].split(',').map(param=>param.trim()).filter(Boolean),
                    body: match[4].trim(),
                });
            }
            else if (name === 'undef')
            {
                macros.delete(rest.trim());
            }
            else if (name === 'include')
            {
                const target = /^\s*(?:"([^"]+)"|<([^>]+)>)/.exec(expand(rest, macros));
                if (!target)
                {
                    return `${where}: #include names no file`;
                }
                const included = depth > 32 || !options.include ? null
                    : await options.include(target[1] ?? target[2], target[2] !== undefined, file);
                if (included === null)
                {
                    return `${where}: cannot open include file '${target[1] ?? target[2]}'`;
                }
                out.pop();
                origins.pop();
                const failed = await run(included, target[1] ?? target[2], depth + 1);
                if (failed)
                {
                    return failed;
                }
                emit('', file, n);
            }
            else if (name === 'error')
            {
                return `${where}: #error ${rest}`;
            }
            else if (name === 'pragma' || name === 'line')
            {
                out[out.length - 1] = line.trim();
            }
        }
        return stack.length > 0 ? `${file}: #if without #endif` : null;
    };
    const error = await run(source, 'memory', 0);
    return error ? { error } : { text: out.join('\n'), origins };
}

/**
 * HLSL source preprocessed, or the error a directive raised.
 *
 * @param {string} source
 * @param {PreprocessOptions} [options]
 * @returns {Promise<{ text: string } | { error: string }>}
 */
export async function preprocess(source, options = {}){
    const result = await preprocessTracked(source, options);
    return 'error' in result ? result : { text: result.text };
}
