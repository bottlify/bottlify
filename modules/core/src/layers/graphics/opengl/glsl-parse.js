/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The GLSL grammar, 1.10 to 4.60 (section 9 of the language specification),
 * from the preprocessor's tokens to a syntax tree. Nothing here knows types
 * beyond their names: whether `S(x)` constructs a struct or calls a function,
 * and how long `float a[N]` is, the checker decides. What the parser must
 * know is which identifiers name types -- the version's own (`Language`) and
 * the structs declared so far -- because `S x;` is a declaration and `a * b;`
 * an expression, and which words the version reserves.
 *
 * The first syntax error ends the parse: the specification lets a compiler
 * stop there, and every later message would be about the recovery, not the
 * shader.
 */

import { basicTypeAt } from './glsl-types.js';
import { languageOf } from './glsl-versions.js';

/**
 * @typedef {import('./glsl-preprocess.js').Token} Token
 * @typedef {import('./glsl-types.js').GlslType} GlslType
 * @typedef {import('./glsl-versions.js').Language} Language
 */

/**
 * A type as written: a basic type, a struct's name, or a struct defined in
 * place, with its array dimensions outermost first -- each an expression, or
 * 'unsized' for `[]`.
 *
 * @typedef {Object} TypeSpec
 * @property {Token} at
 * @property {GlslType | null} basic
 * @property {string | null} structName
 * @property {StructDef | null} structDef
 * @property {any[]} arrays
 */

/**
 * @typedef {Object} StructDef
 * @property {Token} at
 * @property {string | null} name
 * @property {{ qualifiers: Qualifiers, type: TypeSpec, declarators: Declarator[] }[]} members
 */

/**
 * @typedef {Object} Declarator
 * @property {Token} at
 * @property {string} name
 * @property {any[]} arrays  its own dimensions, after the name, outermost first
 * @property {any} initializer  an expression node, an initializer list, or null
 */

/**
 * One `layout` qualifier: its name as written (case folds for the shader's
 * own identifiers only where the specification says so) and its value, an
 * expression, or null.
 *
 * @typedef {{ at: Token, name: string, value: any }} LayoutEntry
 */

/**
 * @typedef {Object} Qualifiers
 * @property {Token} at
 * @property {'const' | 'attribute' | 'uniform' | 'varying' | 'in' | 'out' | 'buffer'
 *     | 'shared' | null} storage
 * @property {boolean} invariant
 * @property {boolean} precise
 * @property {boolean} centroid
 * @property {boolean} sample
 * @property {boolean} patch
 * @property {'flat' | 'smooth' | 'noperspective' | null} interpolation
 * @property {LayoutEntry[]} layout
 * @property {string[]} memory  coherent, volatile, restrict, readonly, writeonly
 * @property {string | null} precision
 * @property {Token[] | null} subroutine  `subroutine` alone (an empty list) or
 *     `subroutine(T, ...)` the types named; null without it
 */

/** The binary operators, by how tightly each binds. */
const PRECEDENCE = new Map([
    ['||', 1], ['^^', 2], ['&&', 3], ['|', 4], ['^', 5], ['&', 6], ['==', 7], ['!=', 7],
    ['<', 8], ['>', 8], ['<=', 8], ['>=', 8], ['<<', 9], ['>>', 9], ['+', 10], ['-', 10],
    ['*', 11], ['/', 11], ['%', 11],
]);

const ASSIGNMENTS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '&=', '|=', '^=']);

const MEMORY = new Set(['coherent', 'volatile', 'restrict', 'readonly', 'writeonly']);
const INTERPOLATION = new Set(['flat', 'smooth', 'noperspective']);
const PRECISION = new Set(['lowp', 'mediump', 'highp']);

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
 * @param {Language} [language]  the version's; 1.10 by default
 * @returns {{ decls: any[] }}
 */
export function parse(tokens, language = languageOf(110)){
    let i = 0;
    /** @type {Set<string>} */
    const structNames = new Set();
    const version = language.version;
    const { keywords, reserved } = language;

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
    /** @param {Token} token */
    const isKeyword = token=>token.kind === 'ident' && keywords.has(token.text);
    /** @param {string} name */
    const typeOf = name=>basicTypeAt(name, version) ?? null;
    /** @returns {Token} */
    const identifier = ()=>{
        const token = peek();
        if (token.kind === 'ident' && reserved.has(token.text))
        {
            fail(token, `'${token.text}' : reserved word`);
        }
        if (token.kind !== 'ident' || isKeyword(token))
        {
            fail(token, `'${token.text || 'end of shader'}' : syntax error, expected a name`);
        }
        i++;
        return token;
    };

    /** Whether the token `offset` ahead begins a type. */
    const startsType = (offset = 0)=>{
        const token = peek(offset);
        if (token.kind !== 'ident')
        {
            return false;
        }
        return token.text === 'struct' || !!typeOf(token.text) || structNames.has(token.text);
    };

    /** Whether the token `offset` ahead is one a qualifier list may start with. */
    const isQualifierWord = (offset = 0)=>{
        const text = peek(offset).text;
        if (peek(offset).kind !== 'ident' || !keywords.has(text))
        {
            return false;
        }
        return ['const', 'attribute', 'uniform', 'varying', 'in', 'out', 'inout', 'buffer',
            'shared', 'invariant', 'precise', 'centroid', 'sample', 'patch', 'layout',
            'subroutine'].includes(text) || MEMORY.has(text) || INTERPOLATION.has(text)
            || PRECISION.has(text);
    };

    /** @returns {LayoutEntry[]} */
    const layoutList = ()=>{
        expect('(');
        /** @type {LayoutEntry[]} */
        const entries = [];
        do {
            const token = next();
            // `shared` is a keyword and a layout qualifier both.
            if (token.kind !== 'ident')
            {
                fail(token, `'${token.text}' : syntax error, expected a layout qualifier`);
            }
            const value = accept('=') ? conditional() : null;
            entries.push({ at: token, name: token.text, value });
        }
        while (accept(','));
        expect(')');
        return entries;
    };

    /**
     * The qualifiers before a type, in any order (4.20 lifted 1.x's order).
     *
     * @param {boolean} [parameter]  a parameter's: `in`, `out` and `inout` are
     *     directions there, read by the caller
     * @returns {Qualifiers}
     */
    const qualifiers = (parameter = false)=>{
        /** @type {Qualifiers} */
        const q = { at: peek(), storage: null, invariant: false, precise: false, centroid: false,
            sample: false, patch: false, interpolation: null, layout: [], memory: [],
            precision: null, subroutine: null };
        /** @param {Qualifiers['storage']} storage */
        const store = storage=>{
            if (q.storage)
            {
                fail(peek(), `'${peek().text}' : only one storage qualifier is allowed`);
            }
            q.storage = storage;
            i++;
        };
        for (;;)
        {
            const token = peek();
            const text = token.text;
            if (token.kind !== 'ident')
            {
                return q;
            }
            if (text === 'invariant' && keywords.has(text))
            {
                q.invariant = true;
                i++;
            }
            else if (text === 'precise' && keywords.has(text))
            {
                q.precise = true;
                i++;
            }
            else if (text === 'centroid')
            {
                q.centroid = true;
                i++;
            }
            else if ((text === 'sample' || text === 'patch') && keywords.has(text))
            {
                q[text] = true;
                i++;
            }
            else if (INTERPOLATION.has(text) && keywords.has(text))
            {
                if (q.interpolation)
                {
                    fail(token, `'${text}' : only one interpolation qualifier is allowed`);
                }
                q.interpolation = /** @type {Qualifiers['interpolation']} */ (text);
                i++;
            }
            else if (MEMORY.has(text) && keywords.has(text))
            {
                q.memory.push(text);
                i++;
            }
            else if (PRECISION.has(text))
            {
                q.precision = text;
                i++;
            }
            else if (text === 'layout' && keywords.has(text))
            {
                i++;
                q.layout.push(...layoutList());
            }
            else if (text === 'subroutine' && keywords.has(text))
            {
                i++;
                /** @type {Token[]} */
                const types = [];
                if (accept('('))
                {
                    do {
                        types.push(identifier());
                    }
                    while (accept(','));
                    expect(')');
                }
                q.subroutine = types;
            }
            else if (!parameter && (text === 'const' || text === 'attribute'
                || text === 'uniform' || text === 'varying'
                || ((text === 'buffer' || text === 'shared') && keywords.has(text))))
            {
                store(/** @type {Qualifiers['storage']} */ (text));
            }
            else if (!parameter && (text === 'in' || text === 'out') && language.has('inOut'))
            {
                store(text);
            }
            else if (!parameter && text === 'inout' && language.has('inOut'))
            {
                fail(token, "'inout' : only allowed on a function parameter");
            }
            else
            {
                return q;
            }
        }
    };

    /** @returns {any[]} the array dimensions here, each an expression or 'unsized' */
    const arraySuffixes = ()=>{
        /** @type {any[]} */
        const dims = [];
        while (is('['))
        {
            const at = next();
            if (dims.length > 0 && !language.has('arraysOfArrays'))
            {
                fail(at, "'[' : arrays of arrays need version 430");
            }
            if (accept(']'))
            {
                dims.push('unsized');
                continue;
            }
            dims.push(conditional());
            expect(']');
        }
        return dims;
    };

    /** @returns {TypeSpec} */
    const typeSpec = ()=>{
        while (PRECISION.has(peek().text))
        {
            i++;
        }
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
                if (peek().kind === 'eof')
                {
                    fail(peek(), "'end of shader' : syntax error, expected '}'");
                }
                const memberQualifiers = qualifiers();
                if (memberQualifiers.storage || memberQualifiers.invariant
                    || memberQualifiers.layout.length > 0 || memberQualifiers.interpolation
                    || memberQualifiers.centroid || memberQualifiers.memory.length > 0)
                {
                    fail(memberQualifiers.at, `'${memberQualifiers.at.text}' : a struct member`
                        + ' takes no qualifier');
                }
                const type = typeSpec();
                /** @type {Declarator[]} */
                const declarators = [];
                do {
                    const nameToken = identifier();
                    declarators.push({ at: nameToken, name: nameToken.text,
                        arrays: arraySuffixes(), initializer: null });
                }
                while (accept(','));
                expect(';');
                members.push({ qualifiers: memberQualifiers, type, declarators });
            }
            if (members.length === 0)
            {
                fail(at, "'struct' : a struct needs at least one member");
            }
            return { at, basic: null, structName: null, structDef: { at, name, members },
                arrays: arraySuffixes() };
        }
        const token = next();
        if (token.kind !== 'ident')
        {
            fail(token, `'${token.text || 'end of shader'}' : syntax error, expected a type`);
        }
        const basic = typeOf(token.text);
        if (basic)
        {
            return { at, basic, structName: null, structDef: null, arrays: arraySuffixes() };
        }
        if (structNames.has(token.text))
        {
            return { at, basic: null, structName: token.text, structDef: null,
                arrays: arraySuffixes() };
        }
        if (reserved.has(token.text))
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

    /** @param {Token} token @returns {any} */
    const integerLiteral = token=>{
        const unsigned = /[uU]$/.test(token.text);
        const text = unsigned ? token.text.slice(0, -1) : token.text;
        if (unsigned && !language.has('uint'))
        {
            fail(token, `'${token.text}' : an unsigned literal needs version 130`);
        }
        const value = /^0[xX]/.test(text) ? Number.parseInt(text, 16)
            : text.length > 1 && text[0] === '0' ? Number.parseInt(text, 8)
                : Number.parseInt(text, 10);
        if (value > 0xffffffff)
        {
            fail(token, `'${token.text}' : integer constant overflow`);
        }
        return unsigned ? { node: 'literal', at: token, kind: 'uint', value: value >>> 0 }
            : { node: 'literal', at: token, kind: 'int', value: value | 0 };
    };

    /** @param {Token} token @returns {any} */
    const floatLiteral = token=>{
        const isDouble = /(lf|LF)$/.test(token.text);
        if (isDouble && !language.has('double'))
        {
            fail(token, `'${token.text}' : a double literal needs version 400`);
        }
        if (/[fF]$/.test(token.text) && !isDouble && !language.has('inOut'))
        {
            fail(token, `'${token.text}' : a float suffix needs version 130`);
        }
        const value = Number.parseFloat(token.text.replace(/(lf|LF|[fF])$/, ''));
        return isDouble ? { node: 'literal', at: token, kind: 'double', value }
            : { node: 'literal', at: token, kind: 'float', value: Math.fround(value) };
    };

    /** @returns {any} */
    const primary = ()=>{
        const token = peek();
        if (token.kind === 'int')
        {
            i++;
            return integerLiteral(token);
        }
        if (token.kind === 'float')
        {
            i++;
            return floatLiteral(token);
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
        if (token.kind === 'ident' && (typeOf(token.text) || structNames.has(token.text)))
        {
            // A constructor: a basic type's or a struct's, maybe of an array.
            const spec = typeSpec();
            if (!is('('))
            {
                fail(peek(), `'${peek().text}' : syntax error, a type name is not a value`);
            }
            return { node: 'construct', at: token, type: spec, args: callArguments() };
        }
        if (token.kind === 'ident' && !keywords.has(token.text))
        {
            if (reserved.has(token.text))
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

    /**
     * An initializer: an expression, or from 4.20 a brace list of them
     * (section 4.1.11), nested as the type it initializes is.
     *
     * @returns {any}
     */
    const initializer = ()=>{
        const at = peek();
        if (!is('{'))
        {
            return assignment();
        }
        if (!language.has('shadingLanguage420pack'))
        {
            fail(at, "'{' : an initializer list needs version 420");
        }
        expect('{');
        /** @type {any[]} */
        const items = [];
        do {
            if (is('}'))
            {
                break;
            }
            items.push(initializer());
        }
        while (accept(','));
        expect('}');
        if (items.length === 0)
        {
            fail(at, "'{' : an initializer list cannot be empty");
        }
        return { node: 'list', at, items };
    };

    // --- statements ---

    /**
     * The declarators after a type: names, array dimensions, initializers.
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
                const arrays = arraySuffixes();
                const init = accept('=') ? initializer() : null;
                declarators.push({ at: nameToken, name: nameToken.text, arrays,
                    initializer: init });
            }
            while (accept(','));
        }
        expect(';');
        return { node: 'variables', at, qualifiers: q, type, declarators };
    };

    /**
     * An interface block (sections 4.3.9): `uniform Name { members } instance[];`.
     *
     * @param {Qualifiers} q @param {Token} at
     * @returns {any}
     */
    const blockRest = (q, at)=>{
        const nameToken = identifier();
        expect('{');
        /** @type {{ qualifiers: Qualifiers, type: TypeSpec, declarators: Declarator[] }[]} */
        const members = [];
        while (!accept('}'))
        {
            if (peek().kind === 'eof')
            {
                fail(peek(), "'end of shader' : syntax error, expected '}'");
            }
            const memberQualifiers = qualifiers();
            if (is('struct'))
            {
                fail(peek(), "'struct' : a structure cannot be defined in a block");
            }
            const type = typeSpec();
            /** @type {Declarator[]} */
            const declarators = [];
            do {
                const memberName = identifier();
                declarators.push({ at: memberName, name: memberName.text, arrays: arraySuffixes(),
                    initializer: null });
            }
            while (accept(','));
            expect(';');
            members.push({ qualifiers: memberQualifiers, type, declarators });
        }
        /** @type {Declarator | null} */
        let instance = null;
        if (!is(';'))
        {
            const instanceToken = identifier();
            instance = { at: instanceToken, name: instanceToken.text, arrays: arraySuffixes(),
                initializer: null };
        }
        expect(';');
        return { node: 'block', at, qualifiers: q, name: nameToken.text, nameAt: nameToken,
            members, instance };
    };

    /** Whether the next tokens begin a declaration rather than an expression. */
    const startsDeclaration = ()=>{
        if (isQualifierWord() || is('struct') || is('precision'))
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
                else if (t.text === ']' && --depth === 0 && peek(k + 1).text !== '[')
                {
                    return peek(k + 1).text !== '(';
                }
            }
        }
        return true;
    };

    /**
     * `invariant a, b;` and `precise a;`: a qualifier given to names
     * declared before.
     *
     * @returns {boolean}
     */
    const startsRequalification = ()=>(is('invariant') || (is('precise')
        && keywords.has('precise'))) && peek(1).kind === 'ident' && !startsType(1)
        && !isQualifierWord(1);

    /** @returns {any} */
    const declaration = ()=>{
        const at = peek();
        if (accept('precision'))
        {
            if (!PRECISION.has(peek().text))
            {
                fail(peek(), `'${peek().text}' : syntax error, expected a precision`);
            }
            i++;
            typeSpec();
            expect(';');
            return { node: 'empty', at };
        }
        if (startsRequalification())
        {
            const qualifier = next().text;
            const names = [identifier()];
            while (accept(','))
            {
                names.push(identifier());
            }
            expect(';');
            return { node: qualifier === 'invariant' ? 'invariant' : 'precise', at, names };
        }
        const q = qualifiers();
        if (is(';') && (q.layout.length > 0 || q.storage))
        {
            // `layout(std140) uniform;`, `layout(triangles) in;`: defaults.
            i++;
            return { node: 'defaults', at, qualifiers: q };
        }
        if (q.storage && peek().kind === 'ident' && peek(1).text === '{'
            && !startsType())
        {
            return blockRest(q, at);
        }
        if (q.storage && q.storage !== 'const' && q.storage !== 'attribute'
            && q.storage !== 'varying' && peek().kind === 'ident' && peek(1).text === '{')
        {
            return blockRest(q, at);
        }
        // `invariant gl_Position;` after other qualifiers names a variable.
        if ((q.invariant || q.precise) && !q.storage && peek().kind === 'ident'
            && !startsType() && (peek(1).text === ';' || peek(1).text === ','))
        {
            const names = [identifier()];
            while (accept(','))
            {
                names.push(identifier());
            }
            expect(';');
            return { node: q.invariant ? 'invariant' : 'precise', at, names };
        }
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
            const test = startsDeclaration() ? conditionDeclaration()
                : expression();
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
            const test = is(';') ? null : startsDeclaration() ? conditionDeclaration()
                : expression();
            expect(';');
            const update = is(')') ? null : expression();
            expect(')');
            return { node: 'for', at, init, test, update, body: statement() };
        }
        if (keywords.has('switch') && accept('switch'))
        {
            expect('(');
            const test = expression();
            expect(')');
            const body = block();
            return { node: 'switch', at, test, body: body.body };
        }
        if (keywords.has('case') && accept('case'))
        {
            const value = expression();
            expect(':');
            return { node: 'case', at, value };
        }
        if (keywords.has('default') && accept('default'))
        {
            expect(':');
            return { node: 'default', at };
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

    /**
     * A condition that declares (section 6.3): `while (bool b = f())`, its
     * variable in the loop's scope.
     *
     * @returns {any}
     */
    const conditionDeclaration = ()=>{
        const at = peek();
        const type = typeSpec();
        const name = identifier();
        expect('=');
        return { node: 'condition', at, type, name, value: assignment() };
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

    /** @returns {any[]} a function's parameters, after its '(' */
    const parameters = ()=>{
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
                let directed = false;
                /** @type {string[]} */
                const memory = [];
                for (;;)
                {
                    if (accept('const'))
                    {
                        constant = true;
                        continue;
                    }
                    if (is('in') || is('out') || is('inout'))
                    {
                        if (directed)
                        {
                            fail(peek(), `'${peek().text}' : only one parameter direction`
                                + ' is allowed');
                        }
                        directed = true;
                        direction = /** @type {'in' | 'out' | 'inout'} */ (next().text);
                        continue;
                    }
                    if (MEMORY.has(peek().text) && keywords.has(peek().text))
                    {
                        memory.push(next().text);
                        continue;
                    }
                    if (PRECISION.has(peek().text) || (is('precise')
                        && keywords.has('precise')))
                    {
                        i++;
                        continue;
                    }
                    break;
                }
                const paramType = typeSpec();
                const name = peek().kind === 'ident' && !keywords.has(peek().text)
                    ? identifier() : null;
                const arrays = name ? arraySuffixes() : [];
                params.push({ at: paramAt, name: name?.text ?? null, type: paramType,
                    arrays, direction, constant, memory });
            }
            while (accept(','));
        }
        expect(')');
        return params;
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
        if (is('precision') || startsRequalification())
        {
            decls.push(declaration());
            continue;
        }
        const q = qualifiers();
        if (is(';') && (q.layout.length > 0 || q.storage))
        {
            i++;
            decls.push({ node: 'defaults', at, qualifiers: q });
            continue;
        }
        if (q.storage && q.storage !== 'const' && peek().kind === 'ident'
            && peek(1).text === '{' && !isKeyword(peek()))
        {
            decls.push(blockRest(q, at));
            continue;
        }
        if ((q.invariant || q.precise) && !q.storage && peek().kind === 'ident'
            && !startsType() && (peek(1).text === ';' || peek(1).text === ','))
        {
            const names = [identifier()];
            while (accept(','))
            {
                names.push(identifier());
            }
            expect(';');
            decls.push({ node: q.invariant ? 'invariant' : 'precise', at, names });
            continue;
        }
        const type = typeSpec();
        // A function: a type, a name and a parenthesis.
        if (peek().kind === 'ident' && peek(1).text === '(' && !q.storage && !q.invariant)
        {
            const nameToken = identifier();
            expect('(');
            const params = parameters();
            const body = is('{') ? block() : (expect(';'), null);
            if (q.subroutine?.length === 0 && !body)
            {
                // A subroutine type's name is a type a subroutine uniform declares.
                structNames.add(nameToken.text);
            }
            decls.push({ node: 'function', at: nameToken, name: nameToken.text,
                returnType: type, params, body, qualifiers: q });
            continue;
        }
        decls.push(declarationRest(type, q, at));
    }
    return { decls };
}
