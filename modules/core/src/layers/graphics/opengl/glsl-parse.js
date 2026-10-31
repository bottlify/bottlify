/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The GLSL 1.20 grammar (section 9 of the language specification), from the
 * preprocessor's tokens to a syntax tree. Nothing here knows types beyond
 * their names: whether `S(x)` constructs a struct or calls a function, and
 * how long `float a[N]` is, the checker decides. The one thing the parser
 * must know is which identifiers name structs, because `S x;` is a
 * declaration and `a * b;` an expression.
 *
 * The first syntax error ends the parse: the specification lets a compiler
 * stop there, and every later message would be about the recovery, not the
 * shader.
 */

import { basicType } from './glsl-types.js';

/**
 * @typedef {import('./glsl-preprocess.js').Token} Token
 * @typedef {import('./glsl-types.js').GlslType} GlslType
 */

/**
 * A type as written: a basic type, a struct's name, or a struct defined in
 * place, with an array length -- an expression, or 'unsized' for `[]`.
 *
 * @typedef {Object} TypeSpec
 * @property {Token} at
 * @property {GlslType | null} basic
 * @property {string | null} structName
 * @property {StructDef | null} structDef
 * @property {any} arrayLength  an expression node, 'unsized', or null
 */

/**
 * @typedef {Object} StructDef
 * @property {Token} at
 * @property {string | null} name
 * @property {{ type: TypeSpec, declarators: Declarator[] }[]} members
 */

/**
 * @typedef {Object} Declarator
 * @property {Token} at
 * @property {string} name
 * @property {any} arrayLength  an expression node, 'unsized', or null
 * @property {any} initializer  an expression node, or null
 */

/**
 * @typedef {Object} Qualifiers
 * @property {'const' | 'attribute' | 'uniform' | 'varying' | null} storage
 * @property {boolean} invariant
 * @property {boolean} centroid
 */

/** Words a shader may not use as names (section 3.6). */
const RESERVED = new Set([
    'asm', 'class', 'union', 'enum', 'typedef', 'template', 'this', 'packed', 'goto', 'switch',
    'default', 'inline', 'noinline', 'volatile', 'public', 'static', 'extern', 'external',
    'interface', 'long', 'short', 'double', 'half', 'fixed', 'unsigned', 'input', 'output',
    'hvec2', 'hvec3', 'hvec4', 'dvec2', 'dvec3', 'dvec4', 'fvec2', 'fvec3', 'fvec4',
    'sampler2DRect', 'sampler3DRect', 'sampler2DRectShadow', 'sizeof', 'cast', 'namespace',
    'using', 'case',
]);

/** Keywords that are not type names. */
const KEYWORDS = new Set([
    'attribute', 'const', 'uniform', 'varying', 'centroid', 'break', 'continue', 'do', 'for',
    'while', 'if', 'else', 'in', 'out', 'inout', 'true', 'false', 'invariant', 'discard',
    'return', 'struct', 'lowp', 'mediump', 'highp', 'precision',
]);

/** The binary operators, by how tightly each binds. */
const PRECEDENCE = new Map([
    ['||', 1], ['^^', 2], ['&&', 3], ['|', 4], ['^', 5], ['&', 6], ['==', 7], ['!=', 7],
    ['<', 8], ['>', 8], ['<=', 8], ['>=', 8], ['<<', 9], ['>>', 9], ['+', 10], ['-', 10],
    ['*', 11], ['/', 11], ['%', 11],
]);

const ASSIGNMENTS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '&=', '|=', '^=']);

/** A syntax error, carrying the token it was found at. */
export class GlslSyntaxError extends Error {
    /** @param {Token} at @param {string} message */
    constructor(at, message){
        super(message);
        this.name = 'GlslSyntaxError';
        this.at = at;
    }
}

/**
 * @param {Token[]} tokens  the preprocessor's, ending in `eof`
 * @returns {{ decls: any[] }}
 */
export function parse(tokens){
    let i = 0;
    /** @type {Set<string>} */
    const structNames = new Set();

    const peek = (offset = 0)=>tokens[Math.min(i + offset, tokens.length - 1)];
    const next = ()=>tokens[Math.min(i++, tokens.length - 1)];
    /** @param {string} text */
    const is = text=>peek().text === text && peek().kind !== 'eof';
    /** @param {string} text */
    const accept = text=>{
        if (is(text))
        {
            i++;
            return true;
        }
        return false;
    };
    /** @param {Token} at @param {string} message @returns {never} */
    const fail = (at, message)=>{
        throw new GlslSyntaxError(at, message);
    };
    /** @param {string} text */
    const expect = text=>{
        const token = peek();
        if (token.text !== text || token.kind === 'eof')
        {
            fail(token, `'${token.text || 'end of shader'}' : syntax error, expected '${text}'`);
        }
        i++;
        return token;
    };
    /** @returns {Token} */
    const identifier = ()=>{
        const token = peek();
        if (token.kind !== 'ident' || KEYWORDS.has(token.text) || basicType(token.text))
        {
            fail(token, `'${token.text || 'end of shader'}' : syntax error, expected a name`);
        }
        if (RESERVED.has(token.text))
        {
            fail(token, `'${token.text}' : reserved word`);
        }
        i++;
        return token;
    };

    /** Whether the next tokens begin a type. */
    const startsType = (offset = 0)=>{
        const token = peek(offset);
        if (token.kind !== 'ident')
        {
            return false;
        }
        return token.text === 'struct' || !!basicType(token.text) || structNames.has(token.text);
    };

    /** Skips a precision qualifier, which 1.20 reserves and drivers accept. */
    const skipPrecision = ()=>{
        while (is('lowp') || is('mediump') || is('highp'))
        {
            i++;
        }
    };

    /** @returns {Qualifiers} */
    const qualifiers = ()=>{
        /** @type {Qualifiers} */
        const q = { storage: null, invariant: false, centroid: false };
        for (;;)
        {
            const text = peek().text;
            if (text === 'invariant')
            {
                q.invariant = true;
                i++;
                continue;
            }
            if (text === 'centroid')
            {
                q.centroid = true;
                i++;
                continue;
            }
            if (text === 'const' || text === 'attribute' || text === 'uniform'
                || text === 'varying')
            {
                if (q.storage)
                {
                    fail(peek(), `'${text}' : only one storage qualifier is allowed`);
                }
                q.storage = /** @type {Qualifiers['storage']} */ (text);
                i++;
                continue;
            }
            if (text === 'lowp' || text === 'mediump' || text === 'highp')
            {
                i++;
                continue;
            }
            return q;
        }
    };

    /** @returns {any} an array length: an expression, or 'unsized' */
    const arraySuffix = ()=>{
        if (!accept('['))
        {
            return null;
        }
        if (accept(']'))
        {
            return 'unsized';
        }
        const length = conditional();
        expect(']');
        if (is('['))
        {
            fail(peek(), "'[' : arrays of arrays are not allowed");
        }
        return length;
    };

    /** @returns {TypeSpec} */
    const typeSpec = ()=>{
        skipPrecision();
        const at = peek();
        if (accept('struct'))
        {
            const name = peek().kind === 'ident' && !is('{') ? identifier().text : null;
            if (name)
            {
                structNames.add(name);
            }
            expect('{');
            /** @type {StructDef['members']} */
            const members = [];
            while (!accept('}'))
            {
                if (is('const') || is('uniform') || is('attribute') || is('varying'))
                {
                    fail(peek(), `'${peek().text}' : a struct member takes no qualifier`);
                }
                const type = typeSpec();
                /** @type {Declarator[]} */
                const declarators = [];
                do {
                    const nameToken = identifier();
                    declarators.push({ at: nameToken, name: nameToken.text,
                        arrayLength: arraySuffix(), initializer: null });
                }
                while (accept(','));
                expect(';');
                members.push({ type, declarators });
            }
            if (members.length === 0)
            {
                fail(at, "'struct' : a struct needs at least one member");
            }
            return { at, basic: null, structName: null, structDef: { at, name, members },
                arrayLength: arraySuffix() };
        }
        const token = next();
        if (token.kind !== 'ident')
        {
            fail(token, `'${token.text || 'end of shader'}' : syntax error, expected a type`);
        }
        const basic = basicType(token.text);
        if (basic)
        {
            return { at, basic, structName: null, structDef: null, arrayLength: arraySuffix() };
        }
        if (structNames.has(token.text))
        {
            return { at, basic: null, structName: token.text, structDef: null,
                arrayLength: arraySuffix() };
        }
        if (RESERVED.has(token.text))
        {
            fail(token, `'${token.text}' : reserved word`);
        }
        return fail(token, `'${token.text}' : syntax error, expected a type`);
    };

    // --- expressions ---

    /** @returns {any} */
    const expression = ()=>{
        const at = peek();
        const first = assignment();
        if (!is(','))
        {
            return first;
        }
        const expressions = [first];
        while (accept(','))
        {
            expressions.push(assignment());
        }
        return { node: 'sequence', at, expressions };
    };

    /** @returns {any} */
    const assignment = ()=>{
        const at = peek();
        const target = conditional();
        if (peek().kind === 'punct' && ASSIGNMENTS.has(peek().text))
        {
            const op = next().text;
            return { node: 'assign', at, op, target, value: assignment() };
        }
        return target;
    };

    /** @returns {any} */
    const conditional = ()=>{
        const at = peek();
        const test = binary(1);
        if (!accept('?'))
        {
            return test;
        }
        const then = expression();
        expect(':');
        return { node: 'conditional', at, test, then, otherwise: assignment() };
    };

    /** @param {number} minimum @returns {any} */
    const binary = minimum=>{
        let left = unary();
        for (;;)
        {
            const token = peek();
            const level = token.kind === 'punct' ? PRECEDENCE.get(token.text) : undefined;
            if (level === undefined || level < minimum)
            {
                return left;
            }
            i++;
            const right = binary(level + 1);
            left = { node: 'binary', at: token, op: token.text, left, right };
        }
    };

    /** @returns {any} */
    const unary = ()=>{
        const token = peek();
        if (token.kind === 'punct' && ['+', '-', '!', '~', '++', '--'].includes(token.text))
        {
            i++;
            return { node: 'unary', at: token, op: token.text, operand: unary() };
        }
        return postfix(primary());
    };

    /** @param {any} operand @returns {any} */
    const postfix = operand=>{
        for (;;)
        {
            const token = peek();
            if (accept('['))
            {
                const index = expression();
                expect(']');
                operand = { node: 'index', at: token, object: operand, index };
                continue;
            }
            if (accept('.'))
            {
                const name = next();
                if (name.kind !== 'ident')
                {
                    fail(name, `'${name.text}' : syntax error, expected a field`);
                }
                if (name.text === 'length' && is('('))
                {
                    expect('(');
                    expect(')');
                    operand = { node: 'length', at: name, object: operand };
                    continue;
                }
                operand = { node: 'field', at: name, object: operand, name: name.text };
                continue;
            }
            if (token.kind === 'punct' && (token.text === '++' || token.text === '--'))
            {
                i++;
                operand = { node: 'postfix', at: token, op: token.text, operand };
                continue;
            }
            return operand;
        }
    };

    /** @returns {any[]} */
    const callArguments = ()=>{
        expect('(');
        /** @type {any[]} */
        const args = [];
        if (accept(')'))
        {
            return args;
        }
        // `f(void)` is a call with no arguments.
        if (is('void') && peek(1).text === ')')
        {
            i += 2;
            return args;
        }
        do {
            args.push(assignment());
        }
        while (accept(','));
        expect(')');
        return args;
    };

    /** @returns {any} */
    const primary = ()=>{
        const token = peek();
        if (token.kind === 'int')
        {
            i++;
            const text = token.text;
            const value = /^0[xX]/.test(text) ? Number.parseInt(text, 16)
                : text.length > 1 && text[0] === '0' ? Number.parseInt(text, 8)
                    : Number.parseInt(text, 10);
            if (value > 0xffffffff)
            {
                fail(token, `'${text}' : integer constant overflow`);
            }
            return { node: 'literal', at: token, kind: 'int', value: value | 0 };
        }
        if (token.kind === 'float')
        {
            i++;
            return { node: 'literal', at: token, kind: 'float',
                value: Math.fround(Number.parseFloat(token.text.replace(/[fF]$/, ''))) };
        }
        if (token.text === 'true' || token.text === 'false')
        {
            i++;
            return { node: 'literal', at: token, kind: 'bool', value: token.text === 'true' };
        }
        if (accept('('))
        {
            const inner = expression();
            expect(')');
            return inner;
        }
        if (token.kind === 'ident' && (basicType(token.text) || structNames.has(token.text)))
        {
            // A constructor: a basic type's or a struct's, maybe of an array.
            const spec = typeSpec();
            if (!is('('))
            {
                fail(peek(), `'${peek().text}' : syntax error, a type name is not a value`);
            }
            return { node: 'construct', at: token, type: spec, args: callArguments() };
        }
        if (token.kind === 'ident' && !KEYWORDS.has(token.text))
        {
            if (RESERVED.has(token.text))
            {
                fail(token, `'${token.text}' : reserved word`);
            }
            i++;
            if (is('('))
            {
                return { node: 'call', at: token, name: token.text, args: callArguments() };
            }
            return { node: 'name', at: token, name: token.text };
        }
        return fail(token, `'${token.text || 'end of shader'}' : syntax error`);
    };

    // --- statements ---

    /**
     * The declarators after a type: names, array lengths, initializers.
     *
     * @param {TypeSpec} type
     * @param {Qualifiers} q
     * @param {Token} at
     * @returns {any}
     */
    const declarationRest = (type, q, at)=>{
        /** @type {Declarator[]} */
        const declarators = [];
        if (!is(';'))
        {
            do {
                const nameToken = identifier();
                const arrayLength = arraySuffix();
                const initializer = accept('=') ? assignment() : null;
                declarators.push({ at: nameToken, name: nameToken.text, arrayLength,
                    initializer });
            }
            while (accept(','));
        }
        expect(';');
        return { node: 'variables', at, qualifiers: q, type, declarators };
    };

    /** Whether the next tokens begin a declaration rather than an expression. */
    const startsDeclaration = ()=>{
        const text = peek().text;
        if (['const', 'attribute', 'uniform', 'varying', 'invariant', 'centroid', 'struct',
            'lowp', 'mediump', 'highp', 'precision'].includes(text))
        {
            return true;
        }
        if (!startsType())
        {
            return false;
        }
        // `vec3(...)` and `S(...)` are constructors, and `float[2](...)` too.
        if (peek(1).text === '(')
        {
            return false;
        }
        if (peek(1).text === '[')
        {
            // `float[2] a` declares; `float[2](...)` constructs.
            let depth = 0;
            for (let k = 1; ; k++)
            {
                const t = peek(k);
                if (t.kind === 'eof')
                {
                    return false;
                }
                if (t.text === '[')
                {
                    depth++;
                }
                else if (t.text === ']' && --depth === 0)
                {
                    return peek(k + 1).text !== '(';
                }
            }
        }
        return true;
    };

    /** @returns {any} */
    const declaration = ()=>{
        const at = peek();
        if (accept('precision'))
        {
            skipPrecision();
            typeSpec();
            expect(';');
            return { node: 'empty', at };
        }
        if (is('invariant') && peek(1).kind === 'ident' && !startsType(1)
            && !['varying', 'centroid'].includes(peek(1).text))
        {
            i++;
            const names = [identifier()];
            while (accept(','))
            {
                names.push(identifier());
            }
            expect(';');
            return { node: 'invariant', at, names };
        }
        const q = qualifiers();
        const type = typeSpec();
        return declarationRest(type, q, at);
    };

    /** @returns {any} */
    const statement = ()=>{
        const at = peek();
        if (is('{'))
        {
            return block();
        }
        if (accept(';'))
        {
            return { node: 'empty', at };
        }
        if (accept('if'))
        {
            expect('(');
            const test = expression();
            expect(')');
            const then = statement();
            const otherwise = accept('else') ? statement() : null;
            return { node: 'if', at, test, then, otherwise };
        }
        if (accept('while'))
        {
            expect('(');
            const test = expression();
            expect(')');
            return { node: 'while', at, test, body: statement() };
        }
        if (accept('do'))
        {
            const body = statement();
            expect('while');
            expect('(');
            const test = expression();
            expect(')');
            expect(';');
            return { node: 'do', at, body, test };
        }
        if (accept('for'))
        {
            expect('(');
            const init = is(';') ? (i++, { node: 'empty', at }) : startsDeclaration()
                ? declaration() : expressionStatement();
            const test = is(';') ? null : expression();
            expect(';');
            const update = is(')') ? null : expression();
            expect(')');
            return { node: 'for', at, init, test, update, body: statement() };
        }
        if (accept('return'))
        {
            const value = is(';') ? null : expression();
            expect(';');
            return { node: 'return', at, value };
        }
        if (accept('break'))
        {
            expect(';');
            return { node: 'break', at };
        }
        if (accept('continue'))
        {
            expect(';');
            return { node: 'continue', at };
        }
        if (accept('discard'))
        {
            expect(';');
            return { node: 'discard', at };
        }
        if (startsDeclaration())
        {
            return { node: 'declaration', at, declaration: declaration() };
        }
        return expressionStatement();
    };

    /** @returns {any} */
    const expressionStatement = ()=>{
        const at = peek();
        const expr = expression();
        expect(';');
        return { node: 'expression', at, expr };
    };

    /** @returns {any} */
    const block = ()=>{
        const at = expect('{');
        /** @type {any[]} */
        const body = [];
        while (!accept('}'))
        {
            if (peek().kind === 'eof')
            {
                fail(peek(), "'end of shader' : syntax error, expected '}'");
            }
            body.push(statement());
        }
        return { node: 'block', at, body };
    };

    // --- the translation unit ---

    /** @type {any[]} */
    const decls = [];
    while (peek().kind !== 'eof')
    {
        const at = peek();
        if (accept(';'))
        {
            continue;
        }
        if (is('precision') || (is('invariant') && peek(1).kind === 'ident' && !startsType(1)
            && !['varying', 'centroid'].includes(peek(1).text)))
        {
            decls.push(declaration());
            continue;
        }
        const q = qualifiers();
        const type = typeSpec();
        // A function: a type, a name and a parenthesis.
        if (peek().kind === 'ident' && peek(1).text === '(' && !q.storage && !q.invariant)
        {
            const nameToken = identifier();
            expect('(');
            /** @type {any[]} */
            const params = [];
            if (is('void') && peek(1).text === ')')
            {
                i++;
            }
            if (!is(')'))
            {
                do {
                    const paramAt = peek();
                    let constant = false;
                    /** @type {'in' | 'out' | 'inout'} */
                    let direction = 'in';
                    for (;;)
                    {
                        if (accept('const'))
                        {
                            constant = true;
                            continue;
                        }
                        if (is('in') || is('out') || is('inout'))
                        {
                            direction = /** @type {'in' | 'out' | 'inout'} */ (next().text);
                            continue;
                        }
                        break;
                    }
                    const paramType = typeSpec();
                    const name = peek().kind === 'ident' && !KEYWORDS.has(peek().text)
                        ? identifier() : null;
                    const arrayLength = name ? arraySuffix() : null;
                    params.push({ at: paramAt, name: name?.text ?? null, type: paramType,
                        arrayLength, direction, constant });
                }
                while (accept(','));
            }
            expect(')');
            const body = is('{') ? block() : (expect(';'), null);
            decls.push({ node: 'function', at: nameToken, name: nameToken.text,
                returnType: type, params, body });
            continue;
        }
        decls.push(declarationRest(type, q, at));
    }
    return { decls };
}
