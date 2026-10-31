/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The GLSL 1.20 semantic rules (sections 4 to 6 of the language
 * specification) over the parser's tree: every name resolved to what it
 * declares, every expression given its type, every implicit conversion made
 * a node of its own, constants folded where the language says an expression
 * is constant, and a compile error for what the specification makes one.
 *
 * What a compiled shader hands the linker -- its unit -- is its global
 * variables by name, its functions with what each one calls and which
 * global and built-in variables it touches, and the structs it declared.
 * The linker decides from that what a program actually uses, which is what
 * its active attributes and uniforms are.
 *
 * Two of the language's rules are the reason most of this file exists:
 *
 * - **An int becomes a float where a float is wanted, and nowhere else**
 *   (section 4.1.10): in an operand, an argument, an initializer, an
 *   assignment, a return. Nothing converts to an int or a bool implicitly,
 *   and a matrix has no int form to convert from.
 * - **Overloads are chosen exactly first**: a call matching one signature
 *   exactly takes it, and only when none does are conversions tried; two
 *   matches by conversion are an ambiguity, and an error.
 *
 * The first error stops the check, as the first syntax error stops the
 * parse.
 */

import {
    BOOL, FLOAT, INT, VOID, arrayOf, baseOf, componentsOf, glslName, holdsSampler, matrixOf,
    vectorOf,
} from './glsl-types.js';
import { BUILTIN_FUNCTIONS, BUILTIN_VARIABLES } from './glsl-builtins.js';

/**
 * @typedef {import('./glsl-types.js').GlslType} GlslType
 * @typedef {import('./glsl-types.js').StructType} StructType
 * @typedef {import('./glsl-preprocess.js').Token} Token
 */

/**
 * A declared variable.
 *
 * @typedef {Object} VariableSymbol
 * @property {'variable'} kind
 * @property {string} name
 * @property {GlslType} type
 * @property {'uniform' | 'attribute' | 'varying' | 'global' | 'const' | 'local' | 'param'
 *     | 'builtin'} storage
 * @property {number} id  unique in its unit, for the names the emitter gives locals
 * @property {boolean} global
 * @property {Token} at
 * @property {'in' | 'out' | 'inout'} [direction]  a parameter's
 * @property {boolean} [readonly]  a const or `in`-less parameter written through
 * @property {number[] | null} [constant]  a constant's folded value
 * @property {import('./glsl-builtins.js').BuiltinVariable} [builtin]
 * @property {boolean} [invariant]
 * @property {boolean} [written]  assigned somewhere, or passed as `out`
 * @property {any} [initializer]  a global's checked initializer
 */

/**
 * A user function's one signature.
 *
 * @typedef {Object} UserFunction
 * @property {'user'} kind
 * @property {string} name
 * @property {string} key  name and parameter types: what a prototype and its
 *     definition, in any shader of the stage, have in common
 * @property {{ name: string | null, type: GlslType, direction: 'in' | 'out' | 'inout',
 *     symbol: VariableSymbol | null }[]} params
 * @property {GlslType} returns
 * @property {any} body  the checked block, or null for a prototype
 * @property {Set<string>} calls  the keys of the user functions it calls
 * @property {Set<VariableSymbol>} uses  the global and built-in variables it names
 * @property {Token} at
 */

/**
 * @typedef {Object} ShaderUnit
 * @property {'vertex' | 'fragment'} stage
 * @property {number} version
 * @property {Map<string, VariableSymbol>} globals  user globals, by name
 * @property {Map<string, VariableSymbol>} builtins  built-in variables it names
 * @property {UserFunction[]} functions  definitions and prototypes
 * @property {StructType[]} structs  every struct it declared, in order
 * @property {Set<VariableSymbol>} initUses  what the global initializers name
 * @property {Set<string>} initCalls  what the global initializers call
 */

/** A compile error, with the token it was found at. */
export class GlslCompileError extends Error {
    /** @param {Token} at @param {string} message */
    constructor(at, message){
        super(message);
        this.name = 'GlslCompileError';
        this.at = at;
    }
}

/** @param {Token} at @param {string} message @returns {never} */
const fail = (at, message)=>{
    throw new GlslCompileError(at, message);
};

/** The swizzle sets, each spelling the same four components. */
const SWIZZLE_SETS = ['xyzw', 'rgba', 'stpq'];

/** @param {GlslType} a @param {GlslType} b */
export const sameType = (a, b)=>a === b;

/** Whether a value of `from` converts to `to` implicitly. @param {GlslType} from @param {GlslType} to */
export function convertible(from, to){
    if (from === to)
    {
        return true;
    }
    if (from.kind === 'scalar' && to.kind === 'scalar')
    {
        return from.base === 'int' && to.base === 'float';
    }
    if (from.kind === 'vector' && to.kind === 'vector')
    {
        return from.size === to.size && from.base === 'int' && to.base === 'float';
    }
    return false;
}

/**
 * A node that converts `node` to `type`, the node itself when it already is
 * one; a constant converts in place.
 *
 * @param {any} node @param {GlslType} type
 * @returns {any}
 */
export function convertTo(node, type){
    if (node.type === type)
    {
        return node;
    }
    return { node: 'convert', at: node.at, type, operand: node,
        constant: node.constant ? node.constant.map(Math.fround) : null };
}

/** @param {number} value @param {'float' | 'int' | 'bool'} base */
const castScalar = (value, base)=>{
    if (base === 'float')
    {
        return Math.fround(value);
    }
    if (base === 'int')
    {
        return Number.isFinite(value) ? Math.trunc(value) | 0 : 0;
    }
    return value !== 0 ? 1 : 0;
};

/**
 * @param {any} ast  the parser's
 * @param {{ stage: 'vertex' | 'fragment', version: number }} options
 * @returns {ShaderUnit}
 */
export function checkShader(ast, { stage, version }){
    const builtinTable = BUILTIN_VARIABLES[stage];
    let nextId = 1;

    /** @type {ShaderUnit} */
    const unit = {
        stage, version,
        globals: new Map(),
        builtins: new Map(),
        functions: [],
        structs: [],
        initUses: new Set(),
        initCalls: new Set(),
    };

    /**
     * A scope: names to what they declare -- a variable, a struct, or the
     * user functions of that name.
     *
     * @typedef {Map<string, { kind: 'variable', symbol: VariableSymbol }
     *     | { kind: 'struct', type: StructType }
     *     | { kind: 'functions', list: UserFunction[] }>} Scope
     */
    /** @type {Scope[]} */
    const scopes = [new Map()];
    /** @param {string} name */
    const lookup = name=>{
        for (let k = scopes.length - 1; k >= 0; k--)
        {
            const found = scopes[k].get(name);
            if (found)
            {
                return found;
            }
        }
        return null;
    };
    /** @type {UserFunction | null} */
    let current = null;
    let loops = 0;

    /** @param {VariableSymbol} symbol */
    const noteUse = symbol=>{
        if (!symbol.global)
        {
            return;
        }
        if (current)
        {
            current.uses.add(symbol);
        }
        else
        {
            unit.initUses.add(symbol);
        }
    };

    /** @param {string} name @returns {VariableSymbol | null} */
    const builtinSymbol = name=>{
        const existing = unit.builtins.get(name);
        if (existing)
        {
            return existing;
        }
        const builtin = builtinTable[name];
        if (!builtin)
        {
            return null;
        }
        /** @type {VariableSymbol} */
        const symbol = {
            kind: 'variable', name, type: builtin.type, storage: 'builtin', id: nextId++,
            global: true, at: /** @type {any} */ (null), builtin,
            constant: builtin.role === 'const' ? builtin.value ?? null : null,
        };
        unit.builtins.set(name, symbol);
        return symbol;
    };

    // --- types ---

    /**
     * @param {any} expression
     * @returns {number}  a positive array length, from a constant integer
     */
    const arrayLength = expression=>{
        const checked = expr(expression);
        if (checked.type !== INT || !checked.constant)
        {
            fail(expression.at, 'array size must be a constant integer expression');
        }
        const length = checked.constant[0];
        if (length <= 0)
        {
            fail(expression.at, 'array size must be greater than zero');
        }
        return length;
    };

    /**
     * @param {import('./glsl-parse.js').TypeSpec} spec
     * @returns {GlslType}  without the spec's array suffix
     */
    const elementType = spec=>{
        if (spec.basic)
        {
            return spec.basic;
        }
        if (spec.structName)
        {
            const found = lookup(spec.structName);
            if (!found || found.kind !== 'struct')
            {
                return fail(spec.at, `'${spec.structName}' : undeclared type`);
            }
            return found.type;
        }
        const def = /** @type {import('./glsl-parse.js').StructDef} */ (spec.structDef);
        /** @type {{ name: string, type: GlslType }[]} */
        const fields = [];
        for (const member of def.members)
        {
            const base = resolve(member.type);
            for (const declarator of member.declarators)
            {
                if (fields.some(field=>field.name === declarator.name))
                {
                    fail(declarator.at, `'${declarator.name}' : redefinition of a struct member`);
                }
                let type = base;
                if (declarator.arrayLength !== null)
                {
                    if (type.kind === 'array' || declarator.arrayLength === 'unsized')
                    {
                        fail(declarator.at, `'${declarator.name}' : a struct member array`
                            + ' needs a size and cannot be an array of arrays');
                    }
                    type = arrayOf(type, arrayLength(declarator.arrayLength));
                }
                if (type.kind === 'void')
                {
                    fail(declarator.at, `'${declarator.name}' : a member cannot be void`);
                }
                fields.push({ name: declarator.name, type });
            }
        }
        /** @type {StructType} */
        const struct = Object.freeze({ kind: 'struct', name: def.name ?? `anon${nextId}`,
            fields, id: nextId++ });
        if (def.name)
        {
            const scope = scopes[scopes.length - 1];
            if (scope.has(def.name))
            {
                fail(def.at, `'${def.name}' : redefinition`);
            }
            scope.set(def.name, { kind: 'struct', type: struct });
        }
        unit.structs.push(struct);
        return struct;
    };

    /** @param {import('./glsl-parse.js').TypeSpec} spec @returns {GlslType} */
    const resolve = spec=>{
        const element = elementType(spec);
        if (spec.arrayLength === null)
        {
            return element;
        }
        if (spec.arrayLength === 'unsized')
        {
            return fail(spec.at, 'an array type needs a size here');
        }
        return arrayOf(element, arrayLength(spec.arrayLength));
    };

    // --- constants ---

    /**
     * Applies `op` component-wise to two constants, a scalar standing for
     * every component of the other.
     *
     * @param {number[]} a @param {number[]} b @param {(x: number, y: number) => number} op
     */
    const zip = (a, b, op)=>{
        const length = Math.max(a.length, b.length);
        return Array.from({ length }, (_, k)=>op(a.length === 1 ? a[0] : a[k],
            b.length === 1 ? b[0] : b[k]));
    };

    // --- expressions ---

    /**
     * A swizzle or a member of `object`.
     *
     * @param {any} node @param {any} object
     */
    const field = (node, object)=>{
        const type = object.type;
        if (type.kind === 'struct')
        {
            const member = type.fields.find((/** @type {any} */ f)=>f.name === node.name);
            if (!member)
            {
                fail(node.at, `'${node.name}' : no such field in structure '${type.name}'`);
            }
            return { ...node, object, type: member.type, member: node.name,
                constant: null };
        }
        if (type.kind === 'vector' || type.kind === 'scalar')
        {
            const size = type.kind === 'vector' ? type.size : 1;
            const set = SWIZZLE_SETS.find(letters=>[...node.name].every(c=>letters.includes(c)));
            if (!set || node.name.length > 4)
            {
                fail(node.at, `'${node.name}' : illegal vector field selection`);
            }
            const indices = [...node.name].map(c=>set.indexOf(c));
            if (indices.some(index=>index >= size))
            {
                fail(node.at, `'${node.name}' : vector field selection out of range`);
            }
            return {
                node: 'swizzle', at: node.at, object, indices,
                type: vectorOf(/** @type {any} */ (baseOf(type)), indices.length),
                constant: object.constant ? indices.map(index=>object.constant[index]) : null,
            };
        }
        if (type.kind === 'array' && node.name === 'length')
        {
            fail(node.at, "'length' : is a method, call it as length()");
        }
        return fail(node.at, `'${node.name}' : field selection requires a structure or a vector`);
    };

    /**
     * @param {any} node @param {any} object @param {any} index
     */
    const indexing = (node, object, index)=>{
        const type = object.type;
        if (index.type !== INT)
        {
            fail(node.at, "'[]' : an index must be an integer expression");
        }
        const bound = type.kind === 'array' ? type.length : type.kind === 'vector' ? type.size
            : type.kind === 'matrix' ? type.cols : 0;
        if (bound === 0)
        {
            fail(node.at, "'[]' : only arrays, vectors and matrices can be indexed");
        }
        if (index.constant && (index.constant[0] < 0 || index.constant[0] >= bound))
        {
            fail(node.at, `'${index.constant[0]}' : index out of range`);
        }
        const element = type.kind === 'array' ? type.element
            : type.kind === 'vector' ? vectorOf(type.base, 1) : vectorOf('float', type.rows);
        /** @type {number[] | null} */
        let constant = null;
        if (object.constant && index.constant && type.kind !== 'array')
        {
            const at = index.constant[0];
            constant = type.kind === 'vector' ? [object.constant[at]]
                : object.constant.slice(at * type.rows, (at + 1) * type.rows);
        }
        return { node: 'index', at: node.at, object, index, type: element, constant };
    };

    /**
     * The symbol a writable expression ends at, or an error for one that is
     * not: what may be assigned, incremented, or passed as `out`.
     *
     * @param {any} node
     * @returns {VariableSymbol}
     */
    const lvalue = node=>{
        switch (node.node)
        {
            case 'name': {
                const symbol = /** @type {VariableSymbol} */ (node.symbol);
                const role = symbol.builtin?.role;
                if (symbol.storage === 'const' || symbol.storage === 'uniform'
                    || symbol.storage === 'attribute' || symbol.readonly
                    || (symbol.storage === 'varying' && stage === 'fragment')
                    || role === 'uniform' || role === 'attribute' || role === 'in'
                    || role === 'const')
                {
                    fail(node.at, `'${symbol.name}' : l-value required (can't modify a`
                        + ` ${symbol.storage === 'builtin' ? 'read-only built-in' : symbol.storage}`
                        + ' variable)');
                }
                return symbol;
            }
            case 'swizzle': {
                const seen = new Set(node.indices);
                if (seen.size !== node.indices.length)
                {
                    fail(node.at, 'l-value required: a swizzle that repeats a component'
                        + ' cannot be written');
                }
                return lvalue(node.object);
            }
            case 'field':
            case 'index':
                return lvalue(node.object);
            default:
                return fail(node.at, 'l-value required');
        }
    };

    /**
     * The type of `left op right` for the arithmetic operators, with the
     * operands converted to it, or an error.
     *
     * @param {any} node @param {string} op @param {any} left @param {any} right
     */
    const arithmetic = (node, op, left, right)=>{
        if (op === '%' || op === '<<' || op === '>>' || op === '&' || op === '|' || op === '^')
        {
            fail(node.at, `'${op}' : reserved operator`);
        }
        let a = left.type;
        let b = right.type;
        const numeric = (/** @type {GlslType} */ t)=>(t.kind === 'scalar' || t.kind === 'vector')
            && t.base !== 'bool' || t.kind === 'matrix';
        if (!numeric(a) || !numeric(b))
        {
            fail(node.at, `'${op}' : wrong operand types: no operation '${op}' exists that takes`
                + ` a left-hand operand of type '${glslName(a)}' and a right operand of type`
                + ` '${glslName(b)}'`);
        }
        // An int operand meeting a float one converts.
        if (baseOf(a) === 'int' && baseOf(b) === 'float')
        {
            left = convertTo(left, vectorOf('float', componentsOf(a)));
            a = left.type;
        }
        else if (baseOf(a) === 'float' && baseOf(b) === 'int')
        {
            right = convertTo(right, vectorOf('float', componentsOf(b)));
            b = right.type;
        }
        /** @type {GlslType | null} */
        let type = null;
        if (a === b && (a.kind !== 'matrix' || op !== '*'))
        {
            type = a;
        }
        else if (a.kind === 'scalar' && b.kind !== 'scalar' && baseOf(a) === baseOf(b))
        {
            type = b;
        }
        else if (b.kind === 'scalar' && a.kind !== 'scalar' && baseOf(a) === baseOf(b))
        {
            type = a;
        }
        else if (op === '*' && a.kind === 'matrix' && b.kind === 'matrix' && a.cols === b.rows)
        {
            type = matrixOf(b.cols, a.rows);
        }
        else if (op === '*' && a.kind === 'matrix' && b.kind === 'vector' && b.base === 'float'
            && a.cols === b.size)
        {
            type = vectorOf('float', a.rows);
        }
        else if (op === '*' && a.kind === 'vector' && b.kind === 'matrix' && a.base === 'float'
            && a.size === b.rows)
        {
            type = vectorOf('float', b.cols);
        }
        if (!type)
        {
            fail(node.at, `'${op}' : wrong operand types: no operation '${op}' exists that takes`
                + ` a left-hand operand of type '${glslName(a)}' and a right operand of type`
                + ` '${glslName(b)}'`);
        }
        /** @type {number[] | null} */
        let constant = null;
        if (left.constant && right.constant && a.kind !== 'matrix' && b.kind !== 'matrix')
        {
            const base = /** @type {'float' | 'int'} */ (baseOf(type));
            /** @type {(x: number, y: number) => number} */
            const apply = op === '+' ? (x, y)=>x + y : op === '-' ? (x, y)=>x - y
                : op === '*' ? (x, y)=>(base === 'int' ? Math.imul(x, y) : x * y)
                    : (x, y)=>(base === 'int' ? (y === 0 ? 0 : Math.trunc(x / y)) : x / y);
            constant = zip(left.constant, right.constant, apply)
                .map(value=>castScalar(value, base));
        }
        return { node: 'binary', at: node.at, op, left, right, type, constant };
    };

    /**
     * @param {any} node
     * @returns {any}
     */
    function expr(node){
        switch (node.node)
        {
            case 'literal': {
                const type = node.kind === 'int' ? INT : node.kind === 'float' ? FLOAT : BOOL;
                const value = node.kind === 'bool' ? (node.value ? 1 : 0) : node.value;
                return { ...node, type, constant: [value] };
            }
            case 'name': {
                const found = lookup(node.name);
                if (found?.kind === 'variable')
                {
                    noteUse(found.symbol);
                    return { ...node, symbol: found.symbol, type: found.symbol.type,
                        constant: found.symbol.constant ?? null };
                }
                if (found)
                {
                    fail(node.at, `'${node.name}' : is not a variable`);
                }
                const builtin = builtinSymbol(node.name);
                if (builtin)
                {
                    noteUse(builtin);
                    return { ...node, symbol: builtin, type: builtin.type,
                        constant: builtin.constant ?? null };
                }
                if (BUILTIN_VARIABLES[stage === 'vertex' ? 'fragment' : 'vertex'][node.name])
                {
                    fail(node.at, `'${node.name}' : not available in the ${stage} shader`);
                }
                return fail(node.at, `'${node.name}' : undeclared identifier`);
            }
            case 'field':
                return field(node, expr(node.object));
            case 'index':
                return indexing(node, expr(node.object), expr(node.index));
            case 'length': {
                const object = expr(node.object);
                if (object.type.kind !== 'array')
                {
                    fail(node.at, "'length' : only an array has a length");
                }
                return { node: 'literal', at: node.at, kind: 'int', value: object.type.length,
                    type: INT, constant: [object.type.length] };
            }
            case 'unary':
                return unary(node);
            case 'postfix': {
                const operand = expr(node.operand);
                lvalue(operand);
                if (!(operand.type.kind === 'matrix' || ((operand.type.kind === 'scalar'
                    || operand.type.kind === 'vector') && operand.type.base !== 'bool')))
                {
                    fail(node.at, `'${node.op}' : wrong operand type '${glslName(operand.type)}'`);
                }
                return { ...node, operand, type: operand.type, constant: null };
            }
            case 'binary':
                return binary(node);
            case 'assign':
                return assign(node);
            case 'conditional': {
                const test = expr(node.test);
                if (test.type !== BOOL)
                {
                    fail(node.at, "'?:' : the condition must be a boolean");
                }
                let then = expr(node.then);
                let otherwise = expr(node.otherwise);
                if (then.type !== otherwise.type)
                {
                    if (convertible(then.type, otherwise.type))
                    {
                        then = convertTo(then, otherwise.type);
                    }
                    else if (convertible(otherwise.type, then.type))
                    {
                        otherwise = convertTo(otherwise, then.type);
                    }
                    else
                    {
                        fail(node.at, "'?:' : both branches must have the same type");
                    }
                }
                if (then.type.kind === 'array' || holdsSampler(then.type))
                {
                    fail(node.at, "'?:' : arrays and samplers cannot be selected");
                }
                const constant = test.constant && then.constant && otherwise.constant
                    ? (test.constant[0] ? then.constant : otherwise.constant) : null;
                return { ...node, test, then, otherwise, type: then.type, constant };
            }
            case 'sequence': {
                const expressions = node.expressions.map(expr);
                const last = expressions[expressions.length - 1];
                return { ...node, expressions, type: last.type, constant: null };
            }
            case 'construct':
                return construct(node, resolveConstructed(node.type, node.args.length),
                    node.args.map(expr));
            case 'call':
                return call(node);
            default:
                return fail(node.at, 'syntax error');
        }
    }

    /**
     * The type a constructor's type spec names, an unsized array taking its
     * length from the arguments.
     *
     * @param {import('./glsl-parse.js').TypeSpec} spec @param {number} count
     */
    const resolveConstructed = (spec, count)=>{
        if (spec.arrayLength === 'unsized')
        {
            return arrayOf(elementType(spec), count);
        }
        return resolve(spec);
    };

    /** @param {any} node */
    function unary(node){
        const operand = expr(node.operand);
        const type = operand.type;
        switch (node.op)
        {
            case '+':
            case '-': {
                if (!(type.kind === 'matrix' || ((type.kind === 'scalar' || type.kind === 'vector')
                    && type.base !== 'bool')))
                {
                    fail(node.at, `'${node.op}' : wrong operand type '${glslName(type)}'`);
                }
                const constant = operand.constant && node.op === '-'
                    ? operand.constant.map((/** @type {number} */ v)=>castScalar(-v,
                        /** @type {any} */ (baseOf(type))))
                    : operand.constant;
                return { ...node, operand, type, constant };
            }
            case '!':
                if (type !== BOOL)
                {
                    fail(node.at, `'!' : wrong operand type '${glslName(type)}'`);
                }
                return { ...node, operand, type,
                    constant: operand.constant ? [operand.constant[0] ? 0 : 1] : null };
            case '++':
            case '--':
                lvalue(operand);
                if (!(type.kind === 'matrix' || ((type.kind === 'scalar' || type.kind === 'vector')
                    && type.base !== 'bool')))
                {
                    fail(node.at, `'${node.op}' : wrong operand type '${glslName(type)}'`);
                }
                return { ...node, operand, type, constant: null };
            default:
                return fail(node.at, `'${node.op}' : reserved operator`);
        }
    }

    /** @param {any} node */
    function binary(node){
        const op = node.op;
        let left = expr(node.left);
        let right = expr(node.right);
        if (op === '&&' || op === '||' || op === '^^')
        {
            if (left.type !== BOOL || right.type !== BOOL)
            {
                fail(node.at, `'${op}' : wrong operand types: both must be scalar booleans`);
            }
            const constant = left.constant && right.constant
                ? [op === '&&' ? left.constant[0] & right.constant[0]
                    : op === '||' ? left.constant[0] | right.constant[0]
                        : left.constant[0] ^ right.constant[0]]
                : null;
            return { node: 'binary', at: node.at, op, left, right, type: BOOL, constant };
        }
        if (op === '<' || op === '>' || op === '<=' || op === '>=')
        {
            if (left.type.kind !== 'scalar' || right.type.kind !== 'scalar'
                || left.type === BOOL || right.type === BOOL)
            {
                fail(node.at, `'${op}' : wrong operand types: no operation '${op}' exists that`
                    + ` takes a left-hand operand of type '${glslName(left.type)}' and a right`
                    + ` operand of type '${glslName(right.type)}'`);
            }
            if (left.type !== right.type)
            {
                left = convertTo(left, FLOAT);
                right = convertTo(right, FLOAT);
            }
            const constant = left.constant && right.constant ? [Number(op === '<'
                ? left.constant[0] < right.constant[0] : op === '>'
                    ? left.constant[0] > right.constant[0] : op === '<='
                        ? left.constant[0] <= right.constant[0]
                        : left.constant[0] >= right.constant[0])] : null;
            return { node: 'binary', at: node.at, op, left, right, type: BOOL, constant };
        }
        if (op === '==' || op === '!=')
        {
            if (left.type !== right.type)
            {
                if (convertible(left.type, right.type))
                {
                    left = convertTo(left, right.type);
                }
                else if (convertible(right.type, left.type))
                {
                    right = convertTo(right, left.type);
                }
                else
                {
                    fail(node.at, `'${op}' : wrong operand types: no operation '${op}' exists`
                        + ` that takes a left-hand operand of type '${glslName(left.type)}' and`
                        + ` a right operand of type '${glslName(right.type)}'`);
                }
            }
            if (holdsSampler(left.type))
            {
                fail(node.at, `'${op}' : samplers cannot be compared`);
            }
            let constant = null;
            if (left.constant && right.constant)
            {
                const equal = left.constant.every((/** @type {number} */ v, /** @type {number} */ k)=>
                    v === right.constant[k]);
                constant = [Number(op === '==' ? equal : !equal)];
            }
            return { node: 'binary', at: node.at, op, left, right, type: BOOL, constant };
        }
        return arithmetic(node, op, left, right);
    }

    /** @param {any} node */
    function assign(node){
        const target = expr(node.target);
        const symbol = lvalue(target);
        symbol.written = true;
        let value = expr(node.value);
        if (node.op === '=')
        {
            if (value.type !== target.type)
            {
                if (!convertible(value.type, target.type))
                {
                    fail(node.at, `'=' : cannot convert from '${glslName(value.type)}' to`
                        + ` '${glslName(target.type)}'`);
                }
                value = convertTo(value, target.type);
            }
            if (holdsSampler(target.type))
            {
                fail(node.at, "'=' : a sampler cannot be assigned");
            }
            return { node: 'assign', at: node.at, op: '=', target, value, type: target.type,
                constant: null };
        }
        const op = node.op.slice(0, -1);
        const combined = arithmetic(node, op, target, value);
        if (combined.type !== target.type)
        {
            fail(node.at, `'${node.op}' : cannot convert from '${glslName(combined.type)}' to`
                + ` '${glslName(target.type)}'`);
        }
        return { node: 'assign', at: node.at, op: node.op, target, value: combined.right,
            type: target.type, constant: null };
    }

    /**
     * @param {any} node
     * @param {GlslType} type
     * @param {any[]} args
     */
    function construct(node, type, args){
        if (args.length === 0)
        {
            fail(node.at, `'${glslName(type)}' : constructor does not have any arguments`);
        }
        for (const arg of args)
        {
            if (holdsSampler(arg.type) || arg.type.kind === 'void')
            {
                fail(arg.at, `'${glslName(type)}' : cannot construct from a`
                    + ` ${glslName(arg.type)}`);
            }
        }
        const allConstant = args.every(arg=>arg.constant);
        if (type.kind === 'struct' || type.kind === 'array')
        {
            const wanted = type.kind === 'struct'
                ? type.fields.map(f=>f.type)
                : Array.from({ length: type.length }, ()=>type.element);
            if (args.length !== wanted.length)
            {
                fail(node.at, `'${glslName(type)}' : wrong number of arguments: ${args.length}`
                    + ` given, ${wanted.length} expected`);
            }
            const converted = args.map((arg, k)=>{
                if (!convertible(arg.type, wanted[k]))
                {
                    fail(arg.at, `'${glslName(type)}' : cannot convert from`
                        + ` '${glslName(arg.type)}' to '${glslName(wanted[k])}'`);
                }
                return convertTo(arg, wanted[k]);
            });
            return { node: 'construct', at: node.at, type, args: converted, constant: null };
        }
        if (type.kind === 'sampler' || type.kind === 'void')
        {
            fail(node.at, `'${glslName(type)}' : cannot be constructed`);
        }
        for (const arg of args)
        {
            if (arg.type.kind === 'struct' || arg.type.kind === 'array')
            {
                fail(arg.at, `'${glslName(type)}' : cannot construct from a`
                    + ` ${glslName(arg.type)}`);
            }
        }
        const base = /** @type {'float' | 'int' | 'bool'} */ (baseOf(type));
        const size = componentsOf(type);
        // Each argument's components, cast to the constructed type's scalar.
        const constants = allConstant
            ? args.flatMap(arg=>arg.constant.map((/** @type {number} */ v)=>castScalar(v, base)))
            : null;
        if (type.kind === 'scalar')
        {
            if (args.length > 1)
            {
                fail(node.at, `'${glslName(type)}' : too many arguments`);
            }
            return { node: 'construct', at: node.at, type, args,
                constant: constants ? [constants[0]] : null };
        }
        if (type.kind === 'matrix' && args.some(arg=>arg.type.kind === 'matrix')
            && args.length > 1)
        {
            fail(node.at, `'${glslName(type)}' : a matrix argument must be the only argument`
                + ' of a matrix constructor');
        }
        if (args.length === 1 && args[0].type.kind === 'scalar')
        {
            /** @type {number[] | null} */
            let constant = null;
            if (constants)
            {
                constant = type.kind === 'vector' ? new Array(size).fill(constants[0])
                    : Array.from({ length: size }, (_, k)=>(Math.floor(k / type.rows)
                        === k % type.rows ? constants[0] : 0));
            }
            return { node: 'construct', at: node.at, type, args, constant };
        }
        if (type.kind === 'matrix' && args.length === 1 && args[0].type.kind === 'matrix')
        {
            const from = args[0].type;
            /** @type {number[] | null} */
            let constant = null;
            if (constants)
            {
                constant = Array.from({ length: size }, (_, k)=>{
                    const col = Math.floor(k / type.rows);
                    const row = k % type.rows;
                    return col < from.cols && row < from.rows ? constants[col * from.rows + row]
                        : col === row ? 1 : 0;
                });
            }
            return { node: 'construct', at: node.at, type, args, constant };
        }
        let total = 0;
        for (let k = 0; k < args.length; k++)
        {
            if (total >= size)
            {
                fail(args[k].at, `'${glslName(type)}' : too many arguments`);
            }
            total += componentsOf(args[k].type);
        }
        if (total < size)
        {
            fail(node.at, `'${glslName(type)}' : not enough data provided for construction`);
        }
        return { node: 'construct', at: node.at, type, args,
            constant: constants ? constants.slice(0, size) : null };
    }

    /**
     * @param {any} node
     */
    function call(node){
        const found = lookup(node.name);
        const args = node.args.map(expr);
        if (found?.kind === 'struct')
        {
            return construct(node, found.type, args);
        }
        if (found?.kind === 'variable')
        {
            fail(node.at, `'${node.name}' : is not a function`);
        }
        const user = found?.kind === 'functions' ? found.list : [];
        const builtins = BUILTIN_FUNCTIONS.get(node.name) ?? [];
        /** @type {{ params: GlslType[], directions: string[], target: any }[]} */
        const candidates = user.length > 0
            ? user.map(f=>({ params: f.params.map(p=>p.type),
                directions: f.params.map(p=>p.direction), target: f }))
            : builtins.map(b=>({ params: b.params, directions: b.params.map(()=>'in'),
                target: b }));
        if (candidates.length === 0)
        {
            fail(node.at, `'${node.name}' : no matching overloaded function found`);
        }
        const arity = candidates.filter(c=>c.params.length === args.length);
        const exact = arity.filter(c=>c.params.every((p, k)=>p === args[k].type));
        let chosen = exact[0];
        if (!chosen)
        {
            const loose = arity.filter(c=>c.params.every((p, k)=>convertible(args[k].type, p)
                && (c.directions[k] === 'in' || p === args[k].type)));
            if (loose.length > 1)
            {
                fail(node.at, `'${node.name}' : ambiguous overloaded function call`);
            }
            chosen = loose[0];
        }
        if (!chosen)
        {
            fail(node.at, `'${node.name}' : no matching overloaded function found`
                + ` (given ${args.map((/** @type {any} */ a)=>glslName(a.type)).join(', ')
                    || 'no arguments'})`);
        }
        const target = chosen.target;
        if (target.kind !== 'user' && target.stage && target.stage !== stage)
        {
            fail(node.at, `'${node.name}' : no matching overloaded function found: this form`
                + ` is available in the ${target.stage} shader only`);
        }
        const converted = args.map((/** @type {any} */ arg, /** @type {number} */ k)=>{
            if (chosen.directions[k] !== 'in')
            {
                lvalue(arg).written = true;
            }
            return convertTo(arg, chosen.params[k]);
        });
        if (node.name === 'ftransform')
        {
            noteUse(/** @type {VariableSymbol} */ (builtinSymbol('gl_Vertex')));
        }
        if (target.kind === 'user')
        {
            if (current)
            {
                current.calls.add(target.key);
            }
            else
            {
                unit.initCalls.add(target.key);
            }
            return { node: 'call', at: node.at, name: node.name, user: target, args: converted,
                type: target.returns, constant: null };
        }
        return { node: 'call', at: node.at, name: node.name, builtin: target, args: converted,
            type: target.returns, constant: foldBuiltin(node.name, converted, target.returns) };
    }

    /**
     * The few built-ins a constant expression in a declaration's size or a
     * const's initializer is seen to use.
     *
     * @param {string} name @param {any[]} args @param {GlslType} returns
     * @returns {number[] | null}
     */
    function foldBuiltin(name, args, returns){
        if (!args.every(arg=>arg.constant))
        {
            return null;
        }
        const values = args.map(arg=>arg.constant);
        /** @type {Record<string, (x: number, y: number) => number>} */
        const binaryOps = { min: Math.min, max: Math.max, pow: Math.pow };
        /** @type {Record<string, (x: number) => number>} */
        const unaryOps = { abs: Math.abs, floor: Math.floor, ceil: Math.ceil, sqrt: Math.sqrt,
            sin: Math.sin, cos: Math.cos, exp: Math.exp, log: Math.log,
            radians: x=>x * Math.PI / 180, degrees: x=>x * 180 / Math.PI };
        if (unaryOps[name] && values.length === 1)
        {
            return values[0].map((/** @type {number} */ v)=>Math.fround(unaryOps[name](v)));
        }
        if (binaryOps[name] && values.length === 2)
        {
            return zip(values[0], values[1], binaryOps[name]).map(Math.fround);
        }
        if (name === 'clamp' && values.length === 3)
        {
            return zip(zip(values[0], values[1], Math.max), values[2], Math.min).map(Math.fround);
        }
        return returns === FLOAT && name === 'length'
            ? [Math.fround(Math.hypot(...values[0]))] : null;
    }

    // --- declarations ---

    /**
     * @param {any} decl  a `variables` node
     * @param {boolean} global
     * @returns {any[]}  the checked declarators: symbol and initializer
     */
    function variables(decl, global){
        const q = decl.qualifiers;
        const storage = q.storage;
        if (!global && storage && storage !== 'const')
        {
            fail(decl.at, `'${storage}' : only allowed at global scope`);
        }
        if (storage === 'attribute' && stage !== 'vertex')
        {
            fail(decl.at, "'attribute' : supported in vertex shaders only");
        }
        const base = elementType(decl.type);
        /** @type {any[]} */
        const checked = [];
        for (const declarator of decl.declarators)
        {
            let type = base;
            const length = declarator.arrayLength ?? decl.type.arrayLength;
            if (length !== null)
            {
                if (declarator.arrayLength !== null && decl.type.arrayLength !== null)
                {
                    fail(declarator.at, `'${declarator.name}' : arrays of arrays are not`
                        + ' allowed');
                }
                if (length === 'unsized' && declarator.name === 'gl_TexCoord')
                {
                    type = /** @type {GlslType} */ (builtinTable.gl_TexCoord?.type ?? base);
                }
                else if (length === 'unsized')
                {
                    const init = declarator.initializer ? expr(declarator.initializer) : null;
                    if (!init || init.type.kind !== 'array')
                    {
                        fail(declarator.at, `'${declarator.name}' : an unsized array needs`
                            + ' an initializer of a sized array');
                    }
                    type = arrayOf(base, init.type.length);
                }
                else
                {
                    type = arrayOf(base, arrayLength(length));
                }
            }
            if (type.kind === 'void')
            {
                fail(declarator.at, `'${declarator.name}' : illegal use of type 'void'`);
            }
            if (storage === 'attribute' && !((type.kind === 'scalar' && type.base === 'float')
                || (type.kind === 'vector' && type.base === 'float') || type.kind === 'matrix'))
            {
                fail(declarator.at, `'${declarator.name}' : an attribute must be a float,`
                    + ' a floating-point vector or a matrix');
            }
            if (storage === 'varying' && !isVaryingType(type))
            {
                fail(declarator.at, `'${declarator.name}' : a varying must be a float, a`
                    + ' floating-point vector, a matrix or an array of them');
            }
            if (holdsSampler(type) && storage !== 'uniform')
            {
                fail(declarator.at, `'${declarator.name}' : a sampler must be a uniform or`
                    + ' a function parameter');
            }
            if ((storage === 'attribute' || storage === 'varying') && declarator.initializer)
            {
                fail(declarator.at, `'${declarator.name}' : cannot initialize this type of`
                    + ' qualifier');
            }
            if (storage === 'uniform' && declarator.initializer && version < 120)
            {
                fail(declarator.at, `'${declarator.name}' : a uniform initializer needs`
                    + ' version 120');
            }
            /** @type {any} */
            let initializer = null;
            if (declarator.initializer)
            {
                initializer = expr(declarator.initializer);
                if (initializer.type !== type)
                {
                    if (!convertible(initializer.type, type))
                    {
                        fail(declarator.at, `'=' : cannot convert from`
                            + ` '${glslName(initializer.type)}' to '${glslName(type)}'`);
                    }
                    initializer = convertTo(initializer, type);
                }
                if (storage === 'uniform' && !initializer.constant)
                {
                    fail(declarator.at, `'${declarator.name}' : a uniform initializer must be`
                        + ' a constant expression');
                }
            }
            if (storage === 'const' && !initializer)
            {
                fail(declarator.at, `'${declarator.name}' : a const variable must be`
                    + ' initialized');
            }
            const scope = scopes[scopes.length - 1];
            const existing = scope.get(declarator.name);
            if (existing)
            {
                fail(declarator.at, `'${declarator.name}' : redefinition`);
            }
            if (declarator.name.startsWith('gl_'))
            {
                if (!(global && redeclaresBuiltin(declarator.name, type, storage)))
                {
                    fail(declarator.at, `'${declarator.name}' : identifiers starting with`
                        + ' "gl_" are reserved');
                }
                checked.push({ symbol: builtinSymbol(declarator.name), initializer: null });
                continue;
            }
            /** @type {VariableSymbol} */
            const symbol = {
                kind: 'variable', name: declarator.name, type,
                storage: global ? storage ?? 'global' : storage === 'const' ? 'const' : 'local',
                id: nextId++, global, at: declarator.at,
                constant: storage === 'const' ? initializer?.constant ?? null : null,
                invariant: q.invariant, initializer,
            };
            scope.set(declarator.name, { kind: 'variable', symbol });
            if (global)
            {
                unit.globals.set(declarator.name, symbol);
            }
            checked.push({ symbol, initializer });
        }
        return checked;
    }

    /**
     * Whether a declaration of a `gl_` name is one the language allows: a
     * built-in varying given a size or invariance again.
     *
     * @param {string} name @param {GlslType} type @param {string | null} storage
     */
    function redeclaresBuiltin(name, type, storage){
        const builtin = builtinTable[name];
        if (!builtin || storage !== 'varying')
        {
            return false;
        }
        if (name === 'gl_TexCoord')
        {
            return type.kind === 'array' && builtin.type.kind === 'array'
                && type.element === builtin.type.element
                && type.length <= builtin.type.length;
        }
        return type === builtin.type;
    }

    /** @param {GlslType} type @returns {boolean} */
    function isVaryingType(type){
        if (type.kind === 'array')
        {
            return isVaryingType(type.element);
        }
        return (type.kind === 'scalar' || type.kind === 'vector') && type.base === 'float'
            || type.kind === 'matrix';
    }

    // --- statements ---

    /** @param {any} node @returns {any} */
    function statement(node){
        switch (node.node)
        {
            case 'block': {
                scopes.push(new Map());
                const body = node.body.map(statement);
                scopes.pop();
                return { ...node, body };
            }
            case 'declaration': {
                const decl = node.declaration;
                if (decl.node === 'empty')
                {
                    return decl;
                }
                if (decl.node === 'invariant')
                {
                    fail(decl.at, "'invariant' : only allowed at global scope");
                }
                return { node: 'declaration', at: node.at, declarators: variables(decl, false) };
            }
            case 'expression':
                return { ...node, expr: expr(node.expr) };
            case 'if': {
                const test = condition(node.test, 'if');
                scopes.push(new Map());
                const then = statement(node.then);
                scopes.pop();
                scopes.push(new Map());
                const otherwise = node.otherwise ? statement(node.otherwise) : null;
                scopes.pop();
                return { ...node, test, then, otherwise };
            }
            case 'for': {
                scopes.push(new Map());
                const init = node.init.node === 'variables'
                    ? { node: 'declaration', at: node.init.at,
                        declarators: variables(node.init, false) }
                    : statement(node.init);
                const test = node.test ? condition(node.test, 'for') : null;
                const update = node.update ? expr(node.update) : null;
                loops++;
                const body = statement(node.body);
                loops--;
                scopes.pop();
                return { ...node, init, test, update, body };
            }
            case 'while': {
                const test = condition(node.test, 'while');
                loops++;
                scopes.push(new Map());
                const body = statement(node.body);
                scopes.pop();
                loops--;
                return { ...node, test, body };
            }
            case 'do': {
                loops++;
                scopes.push(new Map());
                const body = statement(node.body);
                scopes.pop();
                loops--;
                return { ...node, body, test: condition(node.test, 'do') };
            }
            case 'return': {
                const fn = /** @type {UserFunction} */ (current);
                if (!node.value)
                {
                    if (fn.returns !== VOID)
                    {
                        fail(node.at, "'return' : non-void function must return a value");
                    }
                    return node;
                }
                let value = expr(node.value);
                if (fn.returns === VOID)
                {
                    fail(node.at, "'return' : void function cannot return a value");
                }
                if (value.type !== fn.returns)
                {
                    if (!convertible(value.type, fn.returns))
                    {
                        fail(node.at, "'return' : function return is not matching type");
                    }
                    value = convertTo(value, fn.returns);
                }
                return { ...node, value };
            }
            case 'break':
            case 'continue':
                if (loops === 0)
                {
                    fail(node.at, `'${node.node}' : statement only allowed in loops`);
                }
                return node;
            case 'discard':
                if (stage !== 'fragment')
                {
                    fail(node.at, "'discard' : not supported in vertex shaders");
                }
                return node;
            case 'empty':
                return node;
            default:
                return fail(node.at, 'syntax error');
        }
    }

    /** @param {any} node @param {string} what */
    function condition(node, what){
        const test = expr(node);
        if (test.type !== BOOL)
        {
            fail(node.at, `'${what}' : the condition must be a scalar boolean expression`);
        }
        return test;
    }

    // --- the unit ---

    /** @param {any} decl */
    function functionDecl(decl){
        const returns = resolve(decl.returnType);
        if (returns.kind === 'array' || holdsSampler(returns))
        {
            fail(decl.at, `'${decl.name}' : a function cannot return a sampler or an array`);
        }
        if (decl.name.startsWith('gl_'))
        {
            fail(decl.at, `'${decl.name}' : identifiers starting with "gl_" are reserved`);
        }
        if (version >= 120 && BUILTIN_FUNCTIONS.has(decl.name))
        {
            fail(decl.at, `'${decl.name}' : a built-in function cannot be redefined or`
                + ' overloaded');
        }
        const params = decl.params.map((/** @type {any} */ p)=>{
            let type = resolve(p.type);
            if (p.arrayLength !== null)
            {
                if (p.arrayLength === 'unsized')
                {
                    fail(p.at, 'a parameter array needs a size');
                }
                type = arrayOf(type, arrayLength(p.arrayLength));
            }
            if (type.kind === 'void')
            {
                fail(p.at, "'void' : illegal use of type 'void'");
            }
            if (holdsSampler(type) && p.direction !== 'in')
            {
                fail(p.at, 'a sampler parameter cannot be out or inout');
            }
            return { name: p.name, type, direction: p.direction, constant: p.constant, at: p.at };
        });
        const key = `${decl.name}(${params.map((/** @type {any} */ p)=>glslName(p.type))
            .join(',')})`;
        const global = scopes[0];
        let entry = global.get(decl.name);
        if (entry && entry.kind !== 'functions')
        {
            fail(decl.at, `'${decl.name}' : redefinition`);
        }
        if (!entry)
        {
            entry = { kind: 'functions', list: [] };
            global.set(decl.name, entry);
        }
        if (decl.name === 'main' && (params.length > 0 || returns !== VOID))
        {
            fail(decl.at, "'main' : must be declared as void main()");
        }
        let fn = entry.list.find(f=>f.key === key);
        if (fn)
        {
            if (fn.returns !== returns)
            {
                fail(decl.at, `'${decl.name}' : overloaded functions must have the same`
                    + ' return type');
            }
            if (fn.body && decl.body)
            {
                fail(decl.at, `'${decl.name}' : function already has a body`);
            }
        }
        else
        {
            fn = {
                kind: 'user', name: decl.name, key,
                params: params.map((/** @type {any} */ p)=>({ name: p.name, type: p.type,
                    direction: p.direction, symbol: null })),
                returns, body: null, calls: new Set(), uses: new Set(), at: decl.at,
            };
            entry.list.push(fn);
            unit.functions.push(fn);
        }
        if (!decl.body)
        {
            return;
        }
        const defined = /** @type {UserFunction} */ (fn);
        // A definition's parameters are its own, as named here.
        defined.params = params.map((/** @type {any} */ p)=>({ name: p.name, type: p.type,
            direction: p.direction, symbol: null }));
        current = defined;
        scopes.push(new Map());
        params.forEach((/** @type {any} */ p, /** @type {number} */ k)=>{
            if (p.name === null)
            {
                return;
            }
            if (scopes[scopes.length - 1].has(p.name))
            {
                fail(p.at, `'${p.name}' : redefinition`);
            }
            /** @type {VariableSymbol} */
            const symbol = { kind: 'variable', name: p.name, type: p.type, storage: 'param',
                id: nextId++, global: false, at: p.at, direction: p.direction,
                readonly: p.constant };
            defined.params[k].symbol = symbol;
            scopes[scopes.length - 1].set(p.name, { kind: 'variable', symbol });
        });
        defined.body = { node: 'block', at: decl.body.at,
            body: decl.body.body.map(statement) };
        scopes.pop();
        current = null;
    }

    for (const decl of ast.decls)
    {
        switch (decl.node)
        {
            case 'variables':
                if (decl.declarators.length === 0)
                {
                    // A struct declared on its own.
                    elementType(decl.type);
                    break;
                }
                variables(decl, true);
                break;
            case 'function':
                functionDecl(decl);
                break;
            case 'invariant':
                for (const name of decl.names)
                {
                    const found = lookup(name.text);
                    const symbol = found?.kind === 'variable' ? found.symbol
                        : builtinSymbol(name.text);
                    const out = symbol && (symbol.storage === 'varying'
                        || symbol.builtin?.role === 'out' || symbol.builtin?.role === 'in');
                    if (!out)
                    {
                        fail(name, `'${name.text}' : only a varying can be made invariant`);
                    }
                    /** @type {VariableSymbol} */ (symbol).invariant = true;
                }
                break;
            default:
                break;
        }
    }
    return unit;
}
