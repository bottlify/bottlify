/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * HLSL (the Direct3D 9 dialect) as a syntax tree.
 *
 * What it reads: structures and typedefs; global variables with their
 * modifiers, semantics, `register(...)`, `packoffset(...)`, annotations and
 * initialisers; functions with in/out/inout parameters and semantics on the
 * parameters and the result; every statement and operator of the language;
 * the loop and branch attributes; and, for the effects that carry them,
 * `sampler_state` blocks, `technique`/`pass` blocks and `compile` expressions,
 * which the compiler of a single entry point reads past.
 *
 * Nothing is resolved here. A name stays a name, a type stays as written (a
 * built-in's shape is known, a structure or typedef is `named`), and whether
 * `a.xy` is a swizzle or a member is for the checker, which has the types.
 * The one thing the parser must know is which names are types, because
 * `(foo) - 1` is a cast or a subtraction by that alone; it learns them from
 * the `struct` and `typedef` declarations it has read.
 *
 * The first syntax error stops the parse: it throws an `HlslError` carrying
 * fxc's code and the position of the token it stopped at.
 */

import { HlslError, tokenize } from './hlsl-lexer.js';

/** @typedef {import('./hlsl-lexer.js').Position} Position */
/** @typedef {import('./hlsl-lexer.js').Token} Token */

/**
 * A type as written. `scalar` is the element type; `rows` and `cols` are 1 for
 * a scalar, 1 and n for a vector, and the matrix's own for a matrix. `named`
 * is a structure or a typedef, resolved by the checker.
 *
 * @typedef {Object} TypeRef
 * @property {'scalar' | 'vector' | 'matrix' | 'named' | 'void' | 'sampler' | 'texture'
 *     | 'string' | 'shader'} cls
 * @property {'bool' | 'int' | 'uint' | 'half' | 'float' | 'double'} [scalar]
 * @property {number} [rows]
 * @property {number} [cols]
 * @property {string} [name]   The structure or typedef a `named` type names, or the keyword.
 * @property {'any' | '1d' | '2d' | '3d' | 'cube'} [dim]   For a sampler or a texture.
 * @property {Position} pos
 */

/**
 * @typedef {Object} Annotation
 * @property {TypeRef} type
 * @property {string} name
 * @property {Expr[]} dims   Array dimensions, as a variable's.
 * @property {Expr | null} value
 */

/**
 * @typedef {Object} Register
 * @property {string | null} profile   The shader stage a `register(ps, c0)` names, or null.
 * @property {string} name             'c0', 's2', 'b1'...
 */

/**
 * @typedef {Object} Attribute
 * @property {string} name   'unroll', 'loop', 'branch', 'flatten'...
 * @property {Expr[]} args
 */

/**
 * @typedef {Object} Semantics
 * @property {string | null} semantic
 * @property {Register | null} register
 * @property {{ register: string, component: string } | null} packoffset
 */

/**
 * A variable, global or local, and a structure member or a parameter.
 *
 * @typedef {Object} Variable
 * @property {'var'} kind
 * @property {string} name
 * @property {TypeRef} type
 * @property {string[]} mods        'static', 'uniform', 'const', 'in', 'out', 'inout'...
 * @property {Expr[]} dims          Array dimensions; a null-valued slot is `[]`.
 * @property {string | null} semantic
 * @property {Register | null} register
 * @property {{ register: string, component: string } | null} packoffset
 * @property {Annotation[]} annotations
 * @property {Expr | null} init
 * @property {boolean} [packRows]   Matrices packed by row, as the last `#pragma pack_matrix`
 *     before the declaration says; absent where none stands before it.
 * @property {Position} pos
 */

/**
 * @typedef {Object} StructDecl
 * @property {'struct'} kind
 * @property {string} name
 * @property {string | null} base   The structure it extends (`struct B : A`), whose members
 *     come first.
 * @property {Variable[]} members
 * @property {Position} pos
 */

/**
 * @typedef {Object} TypedefDecl
 * @property {'typedef'} kind
 * @property {string} name
 * @property {TypeRef} type
 * @property {Expr[]} dims
 * @property {string[]} mods
 * @property {Position} pos
 */

/**
 * @typedef {Object} FunctionDecl
 * @property {'function'} kind
 * @property {string} name
 * @property {TypeRef} returnType
 * @property {string | null} semantic   The result's.
 * @property {string[]} mods
 * @property {Attribute[]} attributes
 * @property {Variable[]} params
 * @property {Stmt | null} body        Null for a prototype.
 * @property {Position} pos
 */

/**
 * @typedef {Object} CBufferDecl
 * @property {'cbuffer'} kind
 * @property {string} name
 * @property {Register | null} register
 * @property {Variable[]} members
 * @property {Position} pos
 */

/**
 * A state assignment in a pass: `AlphaBlendEnable = true;`, `Sampler[0] = ...;`,
 * `VertexShader = compile vs_2_0 main();`.
 *
 * @typedef {Object} StateAssign
 * @property {string} name
 * @property {Expr | null} index
 * @property {Expr} value
 * @property {Position} pos
 */

/**
 * @typedef {Object} PassDecl
 * @property {string | null} name
 * @property {Annotation[]} annotations
 * @property {StateAssign[]} states
 * @property {Position} pos
 */

/**
 * @typedef {Object} TechniqueDecl
 * @property {'technique'} kind
 * @property {string | null} name
 * @property {Annotation[]} annotations
 * @property {PassDecl[]} passes
 * @property {Position} pos
 */

/** @typedef {StructDecl | TypedefDecl | Variable | FunctionDecl | CBufferDecl | TechniqueDecl} Decl */

/**
 * @typedef {{ kind: 'num', value: number, ntype: 'int' | 'uint' | 'half' | 'float' | 'double',
 *     text: string, pos: Position }
 *   | { kind: 'bool', value: boolean, pos: Position }
 *   | { kind: 'string', value: string, pos: Position }
 *   | { kind: 'ident', name: string, pos: Position }
 *   | { kind: 'unary', op: string, operand: Expr, pos: Position }
 *   | { kind: 'incdec', op: '++' | '--', prefix: boolean, operand: Expr, pos: Position }
 *   | { kind: 'binary', op: string, left: Expr, right: Expr, pos: Position }
 *   | { kind: 'assign', op: string, target: Expr, value: Expr, pos: Position }
 *   | { kind: 'cond', test: Expr, then: Expr, else: Expr, pos: Position }
 *   | { kind: 'comma', exprs: Expr[], pos: Position }
 *   | { kind: 'call', callee: Expr, args: Expr[], pos: Position }
 *   | { kind: 'construct', type: TypeRef, args: Expr[], pos: Position }
 *   | { kind: 'cast', type: TypeRef, dims?: Expr[], operand: Expr, pos: Position }
 *   | { kind: 'index', object: Expr, index: Expr, pos: Position }
 *   | { kind: 'member', object: Expr, name: string, pos: Position }
 *   | { kind: 'initlist', items: Expr[], pos: Position }
 *   | { kind: 'compile', target: string, callee: string, args: Expr[], pos: Position }
 *   | { kind: 'samplerstate', entries: { name: string, value: Expr, pos: Position }[],
 *       pos: Position }
 *   | { kind: 'texref', name: string, pos: Position }} Expr
 */

/**
 * @typedef {{ kind: 'block', stmts: Stmt[], pos: Position }
 *   | { kind: 'decl', vars: Variable[], pos: Position }
 *   | { kind: 'expr', expr: Expr, pos: Position }
 *   | { kind: 'if', test: Expr, then: Stmt, else: Stmt | null, attributes: Attribute[],
 *       pos: Position }
 *   | { kind: 'for', init: Stmt | null, test: Expr | null, step: Expr | null, body: Stmt,
 *       attributes: Attribute[], pos: Position }
 *   | { kind: 'while', test: Expr, body: Stmt, attributes: Attribute[], pos: Position }
 *   | { kind: 'do', body: Stmt, test: Expr, attributes: Attribute[], pos: Position }
 *   | { kind: 'switch', test: Expr, cases: { value: Expr | null, body: Stmt[] }[],
 *       attributes: Attribute[], pos: Position }
 *   | { kind: 'break', pos: Position }
 *   | { kind: 'continue', pos: Position }
 *   | { kind: 'discard', pos: Position }
 *   | { kind: 'return', value: Expr | null, pos: Position }
 *   | { kind: 'empty', pos: Position }} Stmt
 */

/**
 * @typedef {Object} Program
 * @property {Decl[]} decls
 * @property {{ text: string, pos: Position, at: number }[]} pragmas
 */

/** The element types, with the width at which `half` and the rest are the same as `float`. */
const SCALARS = ['bool', 'int', 'uint', 'dword', 'half', 'float', 'double'];

const BUILTIN_TYPE = new RegExp(`^(${SCALARS.join('|')}|min16float|min10float|min16int|min12int|`
    + 'min16uint)([1-4])?(?:x([1-4]))?$');

/** The sampler and texture keywords, and the dimension each reads. */
const OBJECT_TYPES = new Map(/** @type {[string, [TypeRef['cls'], TypeRef['dim']]][]} */ ([
    ['sampler', ['sampler', 'any']], ['sampler1D', ['sampler', '1d']],
    ['sampler2D', ['sampler', '2d']], ['sampler3D', ['sampler', '3d']],
    ['samplerCUBE', ['sampler', 'cube']], ['texture', ['texture', 'any']],
    ['texture1D', ['texture', '1d']], ['texture2D', ['texture', '2d']],
    ['texture3D', ['texture', '3d']], ['textureCUBE', ['texture', 'cube']],
    ['string', ['string', undefined]], ['void', ['void', undefined]],
    ['vertexshader', ['shader', undefined]], ['pixelshader', ['shader', undefined]],
    ['VertexShader', ['shader', undefined]], ['PixelShader', ['shader', undefined]],
    // Direct3D 10's, which fxc takes in models 2 and 3: a texture read through a sampler state.
    ['Texture1D', ['texture', '1d']], ['Texture2D', ['texture', '2d']],
    ['Texture3D', ['texture', '3d']], ['TextureCube', ['texture', 'cube']],
    ['SamplerState', ['sampler', 'any']], ['SamplerComparisonState', ['sampler', 'any']],
    // Effect files write the Direct3D 9 texture capitalised as often as not.
    ['Texture', ['texture', 'any']],
]));

/**
 * The objects of an effect file that a compile of one entry point reads past: a declaration
 * of one, its initialiser or state block with it, is skipped whole.
 */
const EFFECT_OBJECTS = new Set(['GeometryShader', 'DepthStencilState', 'BlendState',
    'RasterizerState', 'ComputeShader', 'DomainShader', 'HullShader', 'fxgroup',
    'RenderTargetView', 'DepthStencilView', 'InputPatch', 'OutputPatch']);

/** Modifiers that stand before a type and are always modifiers. */
const MODIFIERS = new Set(['const', 'static', 'uniform', 'volatile', 'row_major', 'column_major',
    'extern', 'shared', 'precise', 'in', 'out', 'inout', 'groupshared', 'inline', 'target']);

/** Modifiers that are also ordinary names unless a type follows. */
const SOFT_MODIFIERS = new Set(['linear', 'centroid', 'nointerpolation', 'noperspective',
    'sample']);

const BINARY_PRECEDENCE = new Map([
    ['||', 4], ['&&', 5], ['|', 6], ['^', 7], ['&', 8], ['==', 9], ['!=', 9], ['<', 10],
    ['>', 10], ['<=', 10], ['>=', 10], ['<<', 11], ['>>', 11], ['+', 12], ['-', 12],
    ['*', 13], ['/', 13], ['%', 13],
]);

const ASSIGNMENT = new Set(['=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '&=', '|=', '^=']);

/**
 * @param {string} word
 * @returns {TypeRef | null} the built-in type that word names, or null
 */
function builtinType(word){
    const none = /** @type {Position} */ ({ file: '', line: 0, col: 0 });
    // fxc takes string in any case, and DWORD as well as dword.
    if (word.toLowerCase() === 'string')
    {
        return { cls: 'string', name: 'string', pos: none };
    }
    if (word === 'DWORD')
    {
        return { cls: 'scalar', scalar: 'uint', rows: 1, cols: 1, pos: none };
    }
    // The shader object types of an effect, like string, in any case.
    const lower = word.toLowerCase();
    const object = OBJECT_TYPES.get(word) ?? (lower === 'vertexshader' || lower === 'pixelshader'
        ? OBJECT_TYPES.get(lower) : undefined);
    if (object)
    {
        return { cls: object[0], dim: object[1], name: word, pos: none };
    }
    if (word === 'matrix')
    {
        return { cls: 'matrix', scalar: 'float', rows: 4, cols: 4, pos: none };
    }
    if (word === 'vector')
    {
        return { cls: 'vector', scalar: 'float', rows: 1, cols: 4, pos: none };
    }
    const match = BUILTIN_TYPE.exec(word);
    if (!match)
    {
        return null;
    }
    const base = match[1];
    const scalar = base === 'dword' ? 'uint'
        : base.startsWith('min') ? (base.endsWith('float') ? 'half' : base.endsWith('uint')
            ? 'uint' : 'int')
            : /** @type {NonNullable<TypeRef['scalar']>} */ (base);
    if (match[3] !== undefined)
    {
        return { cls: 'matrix', scalar, rows: Number(match[2]), cols: Number(match[3]), pos: none };
    }
    if (match[2] !== undefined)
    {
        return { cls: 'vector', scalar, rows: 1, cols: Number(match[2]), pos: none };
    }
    return { cls: 'scalar', scalar, rows: 1, cols: 1, pos: none };
}

/**
 * @param {string} source   HLSL, preprocessed.
 * @param {string} [file]   What positions name.
 * @returns {Program}
 * @throws {HlslError}
 */
export function parse(source, file = 'memory'){
    const { tokens, pragmas } = tokenize(source, file);
    let at = 0;
    /** The packing `#pragma pack_matrix` sets from where it stands, up to the token `index`. */
    const packing = (/** @type {number} */ index)=>{
        /** @type {boolean | undefined} */
        let rows;
        for (const pragma of pragmas)
        {
            const set = /^pack_matrix\s*\(\s*(row_major|column_major)\s*\)/.exec(pragma.text);
            if (set && pragma.at <= index)
            {
                rows = set[1] === 'row_major';
            }
        }
        return rows;
    };
    /** The names `struct` and `typedef` have introduced. @type {Set<string>} */
    const typeNames = new Set();
    /**
     * Structures defined where a type is written -- `static const struct { ... } a`, or in a
     * function -- declared at the top, before the declaration that defines them: a
     * structure is a type of the whole program here. One with no name gets one.
     *
     * @type {StructDecl[]}
     */
    const hoisted = [];
    let anonymous = 0;

    const peek = (/** @type {number} */ ahead = 0)=>tokens[Math.min(at + ahead, tokens.length - 1)];
    const next = ()=>tokens[Math.min(at++, tokens.length - 1)];
    /** @param {string} text @param {number} [ahead] */
    const isPunct = (text, ahead = 0)=>peek(ahead).type === 'punct' && peek(ahead).text === text;
    /** @param {string} text @param {number} [ahead] */
    const isWord = (text, ahead = 0)=>peek(ahead).type === 'ident' && peek(ahead).text === text;

    /** @param {Token} token */
    const unexpected = token=>new HlslError('X3000', token.type === 'eof'
        ? 'syntax error: unexpected end of file'
        : `syntax error: unexpected token '${token.text}'`, token.pos);

    /** @param {string} text */
    const expectPunct = text=>{
        if (!isPunct(text))
        {
            throw unexpected(peek());
        }
        return next();
    };
    /** @param {string} text */
    const acceptPunct = text=>{
        if (isPunct(text))
        {
            next();
            return true;
        }
        return false;
    };
    const expectIdent = ()=>{
        if (peek().type !== 'ident')
        {
            throw unexpected(peek());
        }
        return next();
    };

    /** @param {Token} token */
    const isTypeToken = token=>token.type === 'ident'
        && (builtinType(token.text) !== null || typeNames.has(token.text)
            || token.text === 'struct');

    /**
     * A type: a built-in, `vector<T, n>`, `matrix<T, r, c>`, `struct Name` or a name.
     *
     * @returns {TypeRef}
     */
    const parseType = ()=>{
        if (isWord('unsigned'))
        {
            // `unsigned int2`: the integer type, unsigned.
            next();
            const type = parseType();
            if (type.scalar === 'int')
            {
                type.scalar = 'uint';
            }
            return type;
        }
        const token = expectIdent();
        if (token.text === 'struct')
        {
            if (isPunct('{') || (peek().type === 'ident' && (isPunct('{', 1) || isPunct(':', 1))))
            {
                at--;
                const struct = parseStruct();
                hoisted.push(struct);
                return { cls: 'named', name: struct.name, pos: token.pos };
            }
            const name = expectIdent();
            return { cls: 'named', name: name.text, pos: token.pos };
        }
        if ((token.text === 'vector' || token.text === 'matrix') && isPunct('<'))
        {
            next();
            const element = builtinType(expectIdent().text);
            if (!element || element.cls !== 'scalar')
            {
                throw unexpected(tokens[at - 1]);
            }
            expectPunct(',');
            const first = next();
            if (first.type !== 'int')
            {
                throw unexpected(first);
            }
            let second = null;
            if (token.text === 'matrix')
            {
                expectPunct(',');
                second = next();
                if (second.type !== 'int')
                {
                    throw unexpected(second);
                }
            }
            expectPunct('>');
            const rows = token.text === 'matrix' ? first.value : 1;
            const cols = token.text === 'matrix' ? /** @type {Token} */ (second).value
                : first.value;
            if (rows < 1 || rows > 4 || cols < 1 || cols > 4)
            {
                throw new HlslError('X3000', 'syntax error: dimensions must be 1 to 4', token.pos);
            }
            return { cls: token.text === 'matrix' ? 'matrix' : 'vector', scalar: element.scalar,
                rows, cols, pos: token.pos };
        }
        const built = builtinType(token.text);
        if (built)
        {
            built.pos = token.pos;
            // `Texture2D<float4>`: what a texel holds, which a model 2 or 3 read ignores.
            if (built.cls === 'texture' && /^Texture/.test(token.text) && isPunct('<'))
            {
                next();
                parseType();
                expectPunct('>');
            }
            return built;
        }
        if (typeNames.has(token.text))
        {
            return { cls: 'named', name: token.text, pos: token.pos };
        }
        throw new HlslError('X3000', `syntax error: unexpected token '${token.text}'`, token.pos);
    };

    /** @returns {string[]} */
    const parseModifiers = ()=>{
        /** @type {string[]} */
        const mods = [];
        for (;;)
        {
            const token = peek();
            if (token.type !== 'ident')
            {
                break;
            }
            if (MODIFIERS.has(token.text)
                || (SOFT_MODIFIERS.has(token.text)
                    && (isTypeToken(peek(1)) || SOFT_MODIFIERS.has(peek(1).text)
                        || MODIFIERS.has(peek(1).text))))
            {
                mods.push(next().text);
            }
            else
            {
                break;
            }
        }
        return mods;
    };

    /** @returns {Attribute[]} */
    const parseAttributes = ()=>{
        /** @type {Attribute[]} */
        const attributes = [];
        while (isPunct('['))
        {
            next();
            const name = expectIdent().text;
            /** @type {Expr[]} */
            const args = [];
            if (acceptPunct('('))
            {
                while (!isPunct(')'))
                {
                    args.push(assignment());
                    if (!acceptPunct(','))
                    {
                        break;
                    }
                }
                expectPunct(')');
            }
            expectPunct(']');
            attributes.push({ name, args });
        }
        return attributes;
    };

    /** @returns {Expr} */
    const parseInitializer = ()=>{
        if (isPunct('{'))
        {
            const open = next();
            /** @type {Expr[]} */
            const items = [];
            while (!isPunct('}'))
            {
                items.push(parseInitializer());
                if (!acceptPunct(','))
                {
                    break;
                }
            }
            expectPunct('}');
            return { kind: 'initlist', items, pos: open.pos };
        }
        return assignment();
    };

    /** @returns {Annotation[]} */
    const parseAnnotations = ()=>{
        /** @type {Annotation[]} */
        const annotations = [];
        if (!acceptPunct('<'))
        {
            return annotations;
        }
        while (!isPunct('>'))
        {
            parseModifiers();
            const type = parseType();
            const name = expectIdent().text;
            const dims = parseDims();
            let value = null;
            if (acceptPunct('='))
            {
                value = parseInitializer();
            }
            expectPunct(';');
            annotations.push({ type, name, dims, value });
        }
        expectPunct('>');
        return annotations;
    };

    /**
     * The `: SEMANTIC`, `: register(...)` and `: packoffset(...)` after a
     * declarator, in any order.
     *
     * @returns {Semantics}
     */
    const parseSemantics = ()=>{
        /** @type {Semantics} */
        const result = { semantic: null, register: null, packoffset: null };
        while (isPunct(':'))
        {
            next();
            const word = expectIdent();
            if (word.text === 'register' && isPunct('('))
            {
                next();
                let first = expectIdent().text;
                /** @type {string | null} */
                let profile = null;
                if (acceptPunct(','))
                {
                    profile = first;
                    first = expectIdent().text;
                }
                // `register(c0)`; a later `[n]` or `, space` is read past.
                while (!isPunct(')'))
                {
                    next();
                }
                expectPunct(')');
                result.register = { profile, name: first };
            }
            else if (word.text === 'packoffset' && isPunct('('))
            {
                next();
                const register = expectIdent().text;
                let component = '';
                if (acceptPunct('.'))
                {
                    component = expectIdent().text;
                }
                expectPunct(')');
                result.packoffset = { register, component };
            }
            else
            {
                result.semantic = word.text;
            }
        }
        return result;
    };

    /** @returns {Expr[]} */
    const parseDims = ()=>{
        /** @type {Expr[]} */
        const dims = [];
        while (isPunct('['))
        {
            const open = next();
            if (isPunct(']'))
            {
                next();
                dims.push({ kind: 'num', value: -1, ntype: 'int', text: '', pos: open.pos });
                continue;
            }
            dims.push(expression());
            expectPunct(']');
        }
        return dims;
    };

    /**
     * One declarator after a type: its name, array dimensions, semantics,
     * annotations and initialiser.
     *
     * @param {TypeRef} type @param {string[]} mods
     * @returns {Variable}
     */
    const parseDeclarator = (type, mods)=>{
        const name = expectIdent();
        const dims = parseDims();
        const semantics = parseSemantics();
        const annotations = parseAnnotations();
        // Annotations may come before the semantic as well as after it.
        const later = parseSemantics();
        const merged = {
            semantic: later.semantic ?? semantics.semantic,
            register: later.register ?? semantics.register,
            packoffset: later.packoffset ?? semantics.packoffset,
        };
        /** @type {Expr | null} */
        let init = null;
        if (acceptPunct('='))
        {
            init = parseInitializer();
        }
        else if (isPunct('{'))
        {
            // `sampler s { Filter = ...; }`, `float a {}`: a state block of Direct3D 10 effects,
            // which a compile of one entry point reads past.
            skipBalanced();
        }
        const packRows = packing(at);
        return { kind: 'var', name: name.text, type, mods, dims, ...merged, annotations, init,
            ...(packRows === undefined ? {} : { packRows }), pos: name.pos };
    };

    /** Past a `{ ... }` and what it holds, nested ones too. */
    const skipBalanced = ()=>{
        let depth = 0;
        do {
            const token = next();
            if (token.type === 'eof')
            {
                throw unexpected(token);
            }
            if (token.type === 'punct' && token.text === '{')
            {
                depth++;
            }
            else if (token.type === 'punct' && token.text === '}')
            {
                depth--;
            }
        } while (depth > 0);
    };

    /**
     * `{ Name = value; ... }` of a sampler or a texture declared with a state block.
     *
     * @param {Position} pos
     * @returns {Expr}
     */
    const samplerStateBody = pos=>{
        expectPunct('{');
        /** @type {{ name: string, value: Expr, pos: Position }[]} */
        const entries = [];
        while (!isPunct('}'))
        {
            const name = expectIdent();
            expectPunct('=');
            /** @type {Expr} */
            let value;
            if (isPunct('<'))
            {
                next();
                value = { kind: 'texref', name: expectIdent().text, pos: name.pos };
                expectPunct('>');
            }
            else
            {
                value = expression();
            }
            expectPunct(';');
            entries.push({ name: name.text, value, pos: name.pos });
        }
        expectPunct('}');
        return { kind: 'samplerstate', entries, pos };
    };

    /** @returns {StructDecl} */
    const parseStruct = ()=>{
        const keyword = next();
        const name = isPunct('{') ? { text: `<anonymous ${++anonymous}>` } : expectIdent();
        /** @type {string | null} */
        let base = null;
        if (acceptPunct(':'))
        {
            base = expectIdent().text;
        }
        typeNames.add(name.text);
        expectPunct('{');
        /** @type {Variable[]} */
        const members = [];
        while (!isPunct('}'))
        {
            const mods = parseModifiers();
            const type = parseType();
            do {
                members.push(parseDeclarator(type, mods));
            } while (acceptPunct(','));
            expectPunct(';');
        }
        expectPunct('}');
        return { kind: 'struct', name: name.text, base, members, pos: keyword.pos };
    };

    /** @returns {Variable[]} */
    const parseParameters = ()=>{
        /** @type {Variable[]} */
        const params = [];
        expectPunct('(');
        if (isWord('void') && isPunct(')', 1))
        {
            next();
        }
        while (!isPunct(')'))
        {
            const mods = parseModifiers();
            const type = parseType();
            params.push(parseDeclarator(type, mods));
            if (!acceptPunct(','))
            {
                break;
            }
        }
        expectPunct(')');
        return params;
    };

    /**
     * A declaration, local or global, after its modifiers and type are read.
     *
     * @param {TypeRef} type @param {string[]} mods
     * @returns {Variable[]}
     */
    const parseDeclarators = (type, mods)=>{
        /** @type {Variable[]} */
        const vars = [];
        do {
            vars.push(parseDeclarator(type, mods));
        } while (acceptPunct(','));
        expectPunct(';');
        return vars;
    };

    /** Whether a statement starting here is a declaration. */
    const startsDeclaration = ()=>{
        const token = peek();
        if (token.type !== 'ident')
        {
            return false;
        }
        if (MODIFIERS.has(token.text))
        {
            return true;
        }
        if (SOFT_MODIFIERS.has(token.text))
        {
            return isTypeToken(peek(1)) || SOFT_MODIFIERS.has(peek(1).text)
                || MODIFIERS.has(peek(1).text);
        }
        if (token.text === 'struct')
        {
            return true;
        }
        if (builtinType(token.text) !== null)
        {
            // `float4(...)` is a constructor, `float4 x` a declaration;
            // `vector<float, 3> v` opens with an angle bracket.
            return peek(1).type === 'ident' || isPunct('<', 1);
        }
        return typeNames.has(token.text) && peek(1).type === 'ident';
    };

    // ---- expressions ---------------------------------------------------------------------

    /** @returns {Expr} */
    function expression(){
        const first = assignment();
        if (!isPunct(','))
        {
            return first;
        }
        const exprs = [first];
        while (acceptPunct(','))
        {
            exprs.push(assignment());
        }
        return { kind: 'comma', exprs, pos: first.pos };
    }

    /** @returns {Expr} */
    function assignment(){
        const left = conditional();
        const token = peek();
        if (token.type === 'punct' && ASSIGNMENT.has(token.text))
        {
            next();
            return { kind: 'assign', op: token.text, target: left, value: assignment(),
                pos: token.pos };
        }
        return left;
    }

    /** @returns {Expr} */
    function conditional(){
        const test = binary(4);
        if (!isPunct('?'))
        {
            return test;
        }
        const question = next();
        const then = expression();
        expectPunct(':');
        return { kind: 'cond', test, then, else: assignment(), pos: question.pos };
    }

    /** @param {number} minimum @returns {Expr} */
    function binary(minimum){
        let left = unary();
        for (;;)
        {
            const token = peek();
            const precedence = token.type === 'punct'
                ? BINARY_PRECEDENCE.get(token.text) : undefined;
            if (precedence === undefined || precedence < minimum)
            {
                return left;
            }
            next();
            const right = binary(precedence + 1);
            left = { kind: 'binary', op: token.text, left, right, pos: token.pos };
        }
    }

    /** @returns {Expr} */
    function unary(){
        const token = peek();
        if (token.type === 'punct')
        {
            if (token.text === '-' || token.text === '+' || token.text === '!'
                || token.text === '~')
            {
                next();
                return { kind: 'unary', op: token.text, operand: unary(), pos: token.pos };
            }
            if (token.text === '++' || token.text === '--')
            {
                next();
                return { kind: 'incdec', op: token.text, prefix: true, operand: unary(),
                    pos: token.pos };
            }
            if (token.text === '(' && (isTypeToken(peek(1))
                || (MODIFIERS.has(peek(1).text) && isTypeToken(peek(2)))))
            {
                // A cast, if what is in the parentheses is exactly a type.
                const saved = at;
                next();
                try
                {
                    parseModifiers();
                    const type = parseType();
                    // `(float[2]) p`: a cast to an array type.
                    const dims = parseDims();
                    if (acceptPunct(')'))
                    {
                        return { kind: 'cast', type, ...(dims.length ? { dims } : {}),
                            operand: unary(), pos: token.pos };
                    }
                }
                catch (e){
                    if (!(e instanceof HlslError))
                    {
                        throw e;
                    }
                }
                at = saved;
            }
        }
        return postfix(primary());
    }

    /** @param {Expr} base @returns {Expr} */
    function postfix(base){
        let expr = base;
        for (;;)
        {
            const token = peek();
            if (token.type !== 'punct')
            {
                return expr;
            }
            if (token.text === '[')
            {
                next();
                const index = expression();
                expectPunct(']');
                expr = { kind: 'index', object: expr, index, pos: token.pos };
            }
            else if (token.text === '.')
            {
                next();
                expr = { kind: 'member', object: expr, name: expectIdent().text, pos: token.pos };
            }
            else if (token.text === '(' && expr.kind === 'member')
            {
                expr = { kind: 'call', callee: expr, args: parseArguments(), pos: expr.pos };
            }
            else if (token.text === '++' || token.text === '--')
            {
                next();
                expr = { kind: 'incdec', op: token.text, prefix: false, operand: expr,
                    pos: token.pos };
            }
            else
            {
                return expr;
            }
        }
    }

    /** @returns {Expr[]} */
    function parseArguments(){
        expectPunct('(');
        /** @type {Expr[]} */
        const args = [];
        while (!isPunct(')'))
        {
            args.push(assignment());
            if (!acceptPunct(','))
            {
                break;
            }
        }
        expectPunct(')');
        return args;
    }

    /** @returns {Expr} */
    function primary(){
        const token = peek();
        switch (token.type)
        {
            case 'int':
            case 'float': {
                next();
                const ntype = token.suffix === 'h' ? 'half' : token.suffix === 'u' ? 'uint'
                    : token.type === 'float' ? 'float' : 'int';
                return { kind: 'num', value: token.value, ntype, text: token.text,
                    pos: token.pos };
            }
            case 'string':
                next();
                return { kind: 'string', value: token.text, pos: token.pos };
            case 'ident':
                return identifier();
            case 'punct':
                if (token.text === '(')
                {
                    next();
                    const inner = expression();
                    expectPunct(')');
                    return inner;
                }
                break;
            default:
                break;
        }
        throw unexpected(token);
    }

    /** @returns {Expr} */
    function identifier(){
        const token = next();
        if (token.text === 'true' || token.text === 'false')
        {
            return { kind: 'bool', value: token.text === 'true', pos: token.pos };
        }
        if (token.text === 'compile' && peek().type === 'ident')
        {
            const target = next().text;
            const callee = expectIdent().text;
            return { kind: 'compile', target, callee, args: parseArguments(), pos: token.pos };
        }
        if (token.text === 'sampler_state' && isPunct('{'))
        {
            return samplerStateBody(token.pos);
        }
        if ((token.text === 'vector' || token.text === 'matrix') && isPunct('<'))
        {
            at--;
            const type = parseType();
            return { kind: 'construct', type, args: parseArguments(), pos: token.pos };
        }
        const type = builtinType(token.text);
        if (type && isPunct('('))
        {
            type.pos = token.pos;
            return { kind: 'construct', type, args: parseArguments(), pos: token.pos };
        }
        if (isPunct('('))
        {
            return { kind: 'call', callee: { kind: 'ident', name: token.text, pos: token.pos },
                args: parseArguments(), pos: token.pos };
        }
        return { kind: 'ident', name: token.text, pos: token.pos };
    }

    // ---- statements ----------------------------------------------------------------------

    /** @returns {Stmt} */
    function block(){
        const open = expectPunct('{');
        /** @type {Stmt[]} */
        const stmts = [];
        while (!isPunct('}'))
        {
            if (peek().type === 'eof')
            {
                throw unexpected(peek());
            }
            stmts.push(statement());
        }
        next();
        return { kind: 'block', stmts, pos: open.pos };
    }

    /** @returns {Stmt} */
    function declarationStatement(){
        const pos = peek().pos;
        const mods = parseModifiers();
        const type = parseType();
        // A structure defined in a function with nothing declared of it.
        if (acceptPunct(';'))
        {
            return { kind: 'empty', pos };
        }
        return { kind: 'decl', vars: parseDeclarators(type, mods), pos };
    }

    /** @returns {Stmt} */
    function statement(){
        const attributes = isPunct('[') ? parseAttributes() : [];
        const token = peek();
        if (token.type === 'punct')
        {
            if (token.text === '{')
            {
                return block();
            }
            if (token.text === ';')
            {
                next();
                return { kind: 'empty', pos: token.pos };
            }
        }
        if (peek().type === 'ident')
        {
            const word = peek().text;
            switch (word)
            {
                case 'if': {
                    const keyword = next();
                    expectPunct('(');
                    const test = expression();
                    expectPunct(')');
                    const then = statement();
                    /** @type {Stmt | null} */
                    let otherwise = null;
                    if (isWord('else'))
                    {
                        next();
                        otherwise = statement();
                    }
                    return { kind: 'if', test, then, else: otherwise, attributes,
                        pos: keyword.pos };
                }
                case 'for': {
                    const keyword = next();
                    expectPunct('(');
                    /** @type {Stmt | null} */
                    let init = null;
                    if (isPunct(';'))
                    {
                        next();
                    }
                    else if (startsDeclaration())
                    {
                        init = declarationStatement();
                    }
                    else
                    {
                        const expr = expression();
                        expectPunct(';');
                        init = { kind: 'expr', expr, pos: expr.pos };
                    }
                    const test = isPunct(';') ? null : expression();
                    expectPunct(';');
                    const step = isPunct(')') ? null : expression();
                    expectPunct(')');
                    return { kind: 'for', init, test, step, body: statement(), attributes,
                        pos: keyword.pos };
                }
                case 'while': {
                    const keyword = next();
                    expectPunct('(');
                    const test = expression();
                    expectPunct(')');
                    return { kind: 'while', test, body: statement(), attributes,
                        pos: keyword.pos };
                }
                case 'do': {
                    const keyword = next();
                    const body = statement();
                    if (!isWord('while'))
                    {
                        throw unexpected(peek());
                    }
                    next();
                    expectPunct('(');
                    const test = expression();
                    expectPunct(')');
                    expectPunct(';');
                    return { kind: 'do', body, test, attributes, pos: keyword.pos };
                }
                case 'switch':
                    return switchStatement(attributes);
                case 'break':
                    next();
                    expectPunct(';');
                    return { kind: 'break', pos: token.pos };
                case 'continue':
                    next();
                    expectPunct(';');
                    return { kind: 'continue', pos: token.pos };
                case 'discard':
                    next();
                    expectPunct(';');
                    return { kind: 'discard', pos: token.pos };
                case 'return': {
                    next();
                    const value = isPunct(';') ? null : expression();
                    expectPunct(';');
                    return { kind: 'return', value, pos: token.pos };
                }
                default:
                    break;
            }
        }
        if (startsDeclaration())
        {
            return declarationStatement();
        }
        const expr = expression();
        expectPunct(';');
        return { kind: 'expr', expr, pos: expr.pos };
    }

    /** @param {Attribute[]} attributes @returns {Stmt} */
    function switchStatement(attributes){
        const keyword = next();
        expectPunct('(');
        const test = expression();
        expectPunct(')');
        expectPunct('{');
        /** @type {{ value: Expr | null, body: Stmt[] }[]} */
        const cases = [];
        while (!isPunct('}'))
        {
            /** @type {Expr | null} */
            let value = null;
            if (isWord('case'))
            {
                next();
                value = expression();
            }
            else if (isWord('default'))
            {
                next();
            }
            else
            {
                throw unexpected(peek());
            }
            expectPunct(':');
            /** @type {Stmt[]} */
            const body = [];
            while (!isPunct('}') && !isWord('case') && !isWord('default'))
            {
                body.push(statement());
            }
            cases.push({ value, body });
        }
        next();
        return { kind: 'switch', test, cases, attributes, pos: keyword.pos };
    }

    // ---- declarations --------------------------------------------------------------------

    /** @returns {TechniqueDecl} */
    function technique(){
        const keyword = next();
        const name = peek().type === 'ident' ? next().text : null;
        const annotations = parseAnnotations();
        expectPunct('{');
        /** @type {PassDecl[]} */
        const passes = [];
        while (!isPunct('}'))
        {
            if (!isWord('pass') && !isWord('Pass'))
            {
                throw unexpected(peek());
            }
            const pass = next();
            const passName = peek().type === 'ident' ? next().text : null;
            const passAnnotations = parseAnnotations();
            expectPunct('{');
            /** @type {StateAssign[]} */
            const states = [];
            while (!isPunct('}'))
            {
                const state = expectIdent();
                /** @type {Expr | null} */
                let index = null;
                if (acceptPunct('['))
                {
                    index = expression();
                    expectPunct(']');
                }
                expectPunct('=');
                /** @type {Expr} */
                let value;
                if (isPunct('<'))
                {
                    // `AlphaBlendEnable = <enabled>;`: a parameter named, as a sampler state
                    // names its texture.
                    next();
                    value = { kind: 'texref', name: expectIdent().text, pos: state.pos };
                    expectPunct('>');
                }
                else if (isWord('asm') && isPunct('{', 1))
                {
                    // A shader in assembly: read past, a compile of nothing the effect can
                    // say it did not make.
                    next();
                    skipBalanced();
                    value = { kind: 'compile', target: 'asm', callee: '', args: [],
                        pos: state.pos };
                }
                else
                {
                    value = isPunct('{') ? parseInitializer() : expression();
                }
                expectPunct(';');
                states.push({ name: state.text, index, value, pos: state.pos });
            }
            next();
            passes.push({ name: passName, annotations: passAnnotations, states, pos: pass.pos });
        }
        next();
        return { kind: 'technique', name, annotations, passes, pos: keyword.pos };
    }

    /** @param {Decl[]} decls */
    function declaration(decls){
        const token = peek();
        if (token.type === 'punct' && token.text === ';')
        {
            next();
            return;
        }
        if (token.type !== 'ident' && !(token.type === 'punct' && token.text === '['))
        {
            throw unexpected(token);
        }
        if (EFFECT_OBJECTS.has(token.text))
        {
            // To the end of the declaration: its `;`, or the `}` of a block that ends it.
            next();
            while (!isPunct(';'))
            {
                if (isPunct('{'))
                {
                    skipBalanced();
                    if (!isPunct('=') && !isPunct(','))
                    {
                        acceptPunct(';');
                        return;
                    }
                    continue;
                }
                if (peek().type === 'eof')
                {
                    throw unexpected(peek());
                }
                next();
            }
            next();
            return;
        }
        const lower = token.text.toLowerCase();
        if (lower === 'technique' || lower === 'technique10' || lower === 'technique11')
        {
            decls.push(technique());
            return;
        }
        // `single cbuffer`: a word only fx_5_0 gives a meaning.
        if (token.text === 'single' && (isWord('cbuffer', 1) || isWord('tbuffer', 1)))
        {
            next();
            declaration(decls);
            return;
        }
        if (token.text === 'cbuffer' || token.text === 'tbuffer')
        {
            next();
            const name = expectIdent();
            const semantics = parseSemantics();
            parseAnnotations();
            expectPunct('{');
            /** @type {Variable[]} */
            const members = [];
            while (!isPunct('}'))
            {
                const mods = parseModifiers();
                const type = parseType();
                members.push(...parseDeclarators(type, mods));
            }
            next();
            acceptPunct(';');
            decls.push({ kind: 'cbuffer', name: name.text, register: semantics.register, members,
                pos: token.pos });
            return;
        }
        if (token.text === 'typedef')
        {
            next();
            const mods = parseModifiers();
            const type = parseType();
            do {
                const name = expectIdent();
                const dims = parseDims();
                typeNames.add(name.text);
                const packRows = packing(at);
                decls.push({ kind: 'typedef', name: name.text, type, dims, mods,
                    ...(packRows === undefined ? {} : { packRows }), pos: name.pos });
            } while (acceptPunct(','));
            expectPunct(';');
            return;
        }
        if (token.text === 'struct' && peek(1).type === 'ident' && (isPunct('{', 2)
            || isPunct(':', 2)))
        {
            const struct = parseStruct();
            decls.push(struct);
            // `struct S { ... } instance;` declares a variable of it as well.
            if (!isPunct(';'))
            {
                decls.push(...parseDeclarators({ cls: 'named', name: struct.name,
                    pos: struct.pos }, []));
            }
            else
            {
                next();
            }
            return;
        }
        const attributes = isPunct('[') ? parseAttributes() : [];
        const mods = parseModifiers();
        const type = parseType();
        if (peek().type === 'ident' && isPunct('(', 1))
        {
            const name = next();
            const params = parseParameters();
            const semantics = parseSemantics();
            /** @type {Stmt | null} */
            let body = null;
            if (isPunct('{'))
            {
                body = block();
            }
            else
            {
                expectPunct(';');
            }
            decls.push({ kind: 'function', name: name.text, returnType: type,
                semantic: semantics.semantic, mods, attributes, params, body, pos: name.pos });
            return;
        }
        decls.push(...parseDeclarators(type, mods));
    }

    /** @type {Decl[]} */
    const decls = [];
    while (peek().type !== 'eof')
    {
        const before = decls.length;
        declaration(decls);
        decls.splice(before, 0, ...hoisted.splice(0));
    }
    return { decls, pragmas };
}
