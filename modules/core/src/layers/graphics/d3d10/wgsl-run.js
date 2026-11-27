/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Runs WGSL functions on the CPU, for tests.
 *
 * There is no GPU under the test runner, yet the double-precision helpers
 * (`wgsl-doubles.js`) are arithmetic that has to be exact, which only running
 * them can show. So the very text the translator writes into a module is
 * read here and turned into JavaScript with WGSL's integer semantics - u32
 * wrapping modulo 2^32, i32 in two's complement, `>>` logical on u32 and
 * arithmetic on i32 - and a test calls it like any function.
 *
 * Only the part of WGSL those helpers keep to is read: functions of u32, i32,
 * bool, vec2<u32> and vec4<u32>; `let`, `var`, assignment to a name, `if` /
 * `else`, `for`, `return`; the operators; `select`, `countLeadingZeros`,
 * `min`, `max`, conversions and `bitcast` between u32 and i32; vector
 * constructors and `.x`, `.xy`, `.zw` and the like. Anything else is refused
 * by name, and a shift by 32 or more, which WGSL takes modulo 32 and the
 * helpers never mean, throws.
 *
 * Nothing in this file is reached by the product; it is a fixture.
 */

const PUNCTUATION = ['->', '==', '!=', '<=', '>=', '&&', '||', '<<', '>>', '(', ')', '{', '}',
    ',', ';', ':', '.', '<', '>', '+', '-', '*', '&', '|', '^', '!', '~', '='];

/** @param {string} text @returns {string[]} */
function tokenize(text){
    /** @type {string[]} */
    const tokens = [];
    let at = 0;
    while (at < text.length)
    {
        const rest = text.slice(at);
        const space = /^(\s+|\/\/[^\n]*)/.exec(rest);
        if (space)
        {
            at += space[0].length;
            continue;
        }
        const word = /^(0x[0-9a-fA-F]+[ui]?|[0-9]+[ui]?|[A-Za-z_][A-Za-z0-9_]*)/.exec(rest);
        if (word)
        {
            tokens.push(word[0]);
            at += word[0].length;
            continue;
        }
        const mark = PUNCTUATION.find(candidate=>rest.startsWith(candidate));
        if (!mark)
        {
            throw new Error(`wgsl-run: no token at "${rest.slice(0, 20)}"`);
        }
        tokens.push(mark);
        at += mark.length;
    }
    return tokens;
}

/** @typedef {'u32' | 'i32' | 'bool' | 'vec2<u32>' | 'vec4<u32>'} Type */
/** @typedef {{ js: string, type: Type }} Expression */

const COMPONENTS = 'xyzw';

/**
 * The JavaScript a set of WGSL functions becomes, with the runtime it calls.
 *
 * @param {string} text
 * @returns {string}
 */
export function wgslToJs(text){
    const tokens = tokenize(text);
    let at = 0;
    const peek = (offset = 0)=>tokens[at + offset];
    /** @param {string} [expected] */
    const take = expected=>{
        const token = tokens[at++];
        if (expected !== undefined && token !== expected)
        {
            throw new Error(`wgsl-run: expected "${expected}", found "${token}"`
                + ` at token ${at - 1}`);
        }
        return token;
    };

    /** @returns {Type} */
    const readType = ()=>{
        const name = take();
        if (name === 'vec2' || name === 'vec4')
        {
            take('<');
            take('u32');
            take('>');
            return /** @type {Type} */ (`${name}<u32>`);
        }
        if (name !== 'u32' && name !== 'i32' && name !== 'bool')
        {
            throw new Error(`wgsl-run: no type ${name}`);
        }
        return name;
    };

    /** @type {Map<string, Type>} */
    const returns = new Map();
    /** @type {Map<string, Type>[]} */
    let scopes = [];
    /** @param {string} name */
    const typeOf = name=>{
        for (let index = scopes.length - 1; index >= 0; index--)
        {
            const found = scopes[index].get(name);
            if (found)
            {
                return found;
            }
        }
        throw new Error(`wgsl-run: ${name} is not declared`);
    };

    /** @param {Expression} expression @param {Type} type */
    const expect = (expression, type)=>{
        if (expression.type !== type)
        {
            throw new Error(`wgsl-run: ${expression.js} is ${expression.type}, not ${type}`);
        }
        return expression.js;
    };

    /** @returns {Expression} */
    const primary = ()=>{
        const token = take();
        if (token === '(')
        {
            const inner = expression();
            take(')');
            return { js: `(${inner.js})`, type: inner.type };
        }
        if (token === 'true' || token === 'false')
        {
            return { js: token, type: 'bool' };
        }
        const number = /^(0x[0-9a-fA-F]+|[0-9]+)([ui])$/.exec(token);
        if (number)
        {
            const value = Number(number[1]);
            return number[2] === 'u' ? { js: `${value >>> 0}`, type: 'u32' }
                : { js: `(${value | 0})`, type: 'i32' };
        }
        if (/^[0-9]/.test(token))
        {
            throw new Error(`wgsl-run: ${token} has no suffix`);
        }
        if (token === 'vec2' || token === 'vec4')
        {
            take('<');
            take('u32');
            take('>');
            const values = callArguments().map(argument=>expect(argument, 'u32'));
            const size = token === 'vec2' ? 2 : 4;
            if (values.length !== size)
            {
                throw new Error(`wgsl-run: ${token} of ${values.length}`);
            }
            return { js: `[${values.join(', ')}]`, type: /** @type {Type} */ (`${token}<u32>`) };
        }
        if (token === 'bitcast')
        {
            take('<');
            const type = readType();
            take('>');
            const [value] = callArguments();
            return convert(value, type);
        }
        if (token === 'u32' || token === 'i32')
        {
            const [value] = callArguments();
            return convert(value, token);
        }
        if (peek() === '(')
        {
            return call(token, callArguments());
        }
        return { js: token, type: typeOf(token) };
    };

    /** @param {Expression} value @param {Type} type @returns {Expression} */
    const convert = (value, type)=>{
        if (value.type === 'u32' && type === 'i32')
        {
            return { js: `(${value.js} | 0)`, type };
        }
        if (value.type === 'i32' && type === 'u32')
        {
            return { js: `(${value.js} >>> 0)`, type };
        }
        expect(value, type);
        return value;
    };

    /** @param {string} name @param {Expression[]} values @returns {Expression} */
    const call = (name, values)=>{
        switch (name)
        {
            case 'select': {
                const [no, yes, condition] = values;
                expect(yes, no.type);
                return { js: `(${expect(condition, 'bool')} ? ${yes.js} : ${no.js})`,
                    type: no.type };
            }
            case 'countLeadingZeros':
                return { js: `Math.clz32(${expect(values[0], 'u32')})`, type: 'u32' };
            case 'min':
            case 'max':
                expect(values[1], values[0].type);
                return { js: `Math.${name}(${values[0].js}, ${values[1].js})`,
                    type: values[0].type };
            default: {
                const type = returns.get(name);
                if (!type)
                {
                    throw new Error(`wgsl-run: no function ${name}`);
                }
                return { js: `${name}(${values.map(value=>value.js).join(', ')})`, type };
            }
        }
    };

    const callArguments = ()=>{
        take('(');
        /** @type {Expression[]} */
        const values = [];
        while (peek() !== ')')
        {
            values.push(expression());
            if (peek() === ',')
            {
                take(',');
            }
        }
        take(')');
        return values;
    };

    /** @returns {Expression} */
    const postfix = ()=>{
        let value = primary();
        while (peek() === '.')
        {
            take('.');
            const swizzle = take();
            const places = [...swizzle].map(letter=>COMPONENTS.indexOf(letter));
            const size = value.type === 'vec2<u32>' ? 2 : value.type === 'vec4<u32>' ? 4 : 0;
            if (places.some(place=>place < 0 || place >= size)
                || ![1, 2, 4].includes(places.length))
            {
                throw new Error(`wgsl-run: .${swizzle} of ${value.type}`);
            }
            value = places.length === 1 ? { js: `${value.js}[${places[0]}]`, type: 'u32' }
                : { js: `pick(${value.js}, [${places.join(', ')}])`,
                    type: /** @type {Type} */ (`vec${places.length}<u32>`) };
        }
        return value;
    };

    /** @returns {Expression} */
    const unary = ()=>{
        if (peek() === '!')
        {
            take();
            return { js: `!${expect(unary(), 'bool')}`, type: 'bool' };
        }
        if (peek() === '~')
        {
            take();
            return { js: `((~${expect(unary(), 'u32')}) >>> 0)`, type: 'u32' };
        }
        if (peek() === '-')
        {
            take();
            return { js: `((-${expect(unary(), 'i32')}) | 0)`, type: 'i32' };
        }
        return postfix();
    };

    /** @param {string} operator @param {Expression} left @param {Expression} right @returns {Expression} */
    const binary = (operator, left, right)=>{
        if (operator === '&&' || operator === '||')
        {
            return { js: `(${expect(left, 'bool')} ${operator} ${expect(right, 'bool')})`,
                type: 'bool' };
        }
        if (['==', '!=', '<', '<=', '>', '>='].includes(operator))
        {
            if (left.type !== 'u32' && left.type !== 'i32' && left.type !== 'bool')
            {
                throw new Error(`wgsl-run: ${operator} of ${left.type}`);
            }
            expect(right, left.type);
            const js = operator === '==' ? '===' : operator === '!=' ? '!==' : operator;
            return { js: `(${left.js} ${js} ${right.js})`, type: 'bool' };
        }
        if (left.type !== 'u32' && left.type !== 'i32')
        {
            throw new Error(`wgsl-run: ${operator} of ${left.type}`);
        }
        const signed = left.type === 'i32';
        const wrap = signed ? '| 0' : '>>> 0';
        if (operator === '<<' || operator === '>>')
        {
            const count = expect(right, 'u32');
            const helper = `${operator === '<<' ? 'shl' : 'shr'}${signed ? 'I' : 'U'}`;
            return { js: `${helper}(${left.js}, ${count})`, type: left.type };
        }
        expect(right, left.type);
        if (operator === '*')
        {
            return { js: `(Math.imul(${left.js}, ${right.js}) ${wrap})`, type: left.type };
        }
        if (!['+', '-', '&', '|', '^'].includes(operator))
        {
            throw new Error(`wgsl-run: no operator ${operator}`);
        }
        return { js: `((${left.js} ${operator} ${right.js}) ${wrap})`, type: left.type };
    };

    // From loosest to tightest; every level associates to the left.
    const LEVELS = [['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='], ['<', '<=', '>', '>='],
        ['<<', '>>'], ['+', '-'], ['*']];

    /** @param {number} index @returns {Expression} */
    const level = index=>{
        if (index === LEVELS.length)
        {
            return unary();
        }
        let left = level(index + 1);
        while (LEVELS[index].includes(peek()))
        {
            const operator = take();
            left = binary(operator, left, level(index + 1));
        }
        return left;
    };
    /** @returns {Expression} */
    const expression = ()=>level(0);

    /** @param {Type} returned @returns {string} */
    const block = returned=>{
        take('{');
        scopes.push(new Map());
        /** @type {string[]} */
        const out = [];
        while (peek() !== '}')
        {
            out.push(statement(returned));
        }
        take('}');
        scopes.pop();
        return `{\n${out.join('\n')}\n}`;
    };

    /** @returns {string} */
    const declaration = ()=>{
        take();
        const name = take();
        take(':');
        const type = readType();
        take('=');
        const value = expect(expression(), type);
        scopes[scopes.length - 1].set(name, type);
        return `let ${name} = ${value}`;
    };

    /** @param {Type} returned @returns {string} */
    const statement = returned=>{
        const token = peek();
        if (token === 'let' || token === 'var')
        {
            const declared = declaration();
            take(';');
            return `${declared};`;
        }
        if (token === 'return')
        {
            take();
            const value = expect(expression(), returned);
            take(';');
            return `return ${value};`;
        }
        if (token === 'if')
        {
            take();
            take('(');
            const condition = expect(expression(), 'bool');
            take(')');
            let branch = `if (${condition}) ${block(returned)}`;
            if (peek() === 'else')
            {
                take();
                branch += ` else ${peek() === 'if' ? statement(returned) : block(returned)}`;
            }
            return branch;
        }
        if (token === 'for')
        {
            take();
            take('(');
            scopes.push(new Map());
            const start = declaration();
            take(';');
            const condition = expect(expression(), 'bool');
            take(';');
            const step = assignment();
            take(')');
            const body = block(returned);
            scopes.pop();
            return `for (${start}; ${condition}; ${step}) ${body}`;
        }
        const assigned = assignment();
        take(';');
        return `${assigned};`;
    };

    const assignment = ()=>{
        const name = take();
        const type = typeOf(name);
        take('=');
        return `${name} = ${expect(expression(), type)}`;
    };

    // First the signatures, so a function may call one written after it.
    for (let index = 0; index < tokens.length; index++)
    {
        if (tokens[index] === 'fn')
        {
            let close = index;
            while (tokens[close] !== '->')
            {
                close++;
            }
            at = close + 1;
            returns.set(tokens[index + 1], readType());
        }
    }
    at = 0;
    /** @type {string[]} */
    const functions = [];
    while (at < tokens.length)
    {
        take('fn');
        const name = take();
        take('(');
        /** @type {Map<string, Type>} */
        const parameters = new Map();
        while (peek() !== ')')
        {
            const parameter = take();
            take(':');
            parameters.set(parameter, readType());
            if (peek() === ',')
            {
                take(',');
            }
        }
        take(')');
        take('->');
        const returned = readType();
        scopes = [parameters];
        functions.push(`function ${name}(${[...parameters.keys()].join(', ')}) ${block(returned)}`);
    }
    return [RUNTIME, ...functions].join('\n');
}

/** What the JavaScript calls: shifts that refuse a count WGSL would wrap, swizzles. */
const RUNTIME = `
function counted(n) {
    if (n >= 32) {
        throw new Error('wgsl-run: shift by ' + n);
    }
    return n;
}
function shlU(a, n) { return (a << counted(n)) >>> 0; }
function shlI(a, n) { return (a << counted(n)) | 0; }
function shrU(a, n) { return a >>> counted(n); }
function shrI(a, n) { return a >> counted(n); }
function pick(v, places) { return places.map(place=>v[place]); }`;

/**
 * The functions, callable: u32 and i32 as numbers, bool as a boolean, a
 * vector as an array.
 *
 * @param {string} text
 * @returns {Record<string, (...values: any[]) => any>}
 */
export function runWgsl(text){
    const js = wgslToJs(text);
    const names = [...js.matchAll(/^function ([A-Za-z0-9_]+)/gm)].map(match=>match[1])
        .filter(name=>!['counted', 'shlU', 'shlI', 'shrU', 'shrI', 'pick'].includes(name));
    return new Function(`${js}\nreturn { ${names.join(', ')} };`)();
}
