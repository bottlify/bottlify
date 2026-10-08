/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Semantic analysis of the HLSL tree of `hlsl-parser.js`.
 *
 * The tree is annotated in place, so that what comes after never guesses:
 * - every expression gets `.type`, a semantic type of `hlsl-types.js`;
 * - every implicit conversion is made explicit by wrapping the converted expression in
 *   `{ kind: 'cast', implicit: true, type, operand, pos }` where it stands in its parent;
 * - the parser's `cast` and `construct` nodes keep the type as written in `.typeRef` and get the
 *   semantic type in `.type`;
 * - a name resolves to `.sym`, a call to `.target` (and its callee name to `.fn` or
 *   `.intrinsic`), a member access to `.swizzle`, `.matrixSwizzle` or `.field`/`.fieldName`;
 * - a binary operator, a compound assignment and a unary operator carry `.opType`, the type the
 *   operands were converted to; a call to a user function carries `.argModes`; an
 *   initialiser list carries `.leaves`, its scalars' expressions flattened in order.
 *
 * Errors are collected, one statement at a time; the text and code of each is what fxc prints
 * where that is known (see the report in the tests for the ones that are not).
 */

import {
    BOOL, FLOAT, INT, RANK, STRING, arrayOf, baseOf, componentsOf, conversionRank, fromTypeRef,
    flatBases, isNumeric, matrixOf, samplerOf, sameType, scalarCount, scalarOf, structOf,
    typeToString, vectorOf, withBase,
} from './hlsl-types.js';
import { isIntrinsic, resolveIntrinsic } from './hlsl-intrinsics.js';
import { createEvaluator } from './hlsl-eval.js';

/** @typedef {import('./hlsl-types.js').Type} Type */
/** @typedef {import('./hlsl-types.js').Value} Value */
/** @typedef {import('./hlsl-lexer.js').Position} Position */
/** @typedef {import('./hlsl-parser.js').Program} Program */
/** @typedef {import('./hlsl-parser.js').Variable} Variable */
/** @typedef {import('./hlsl-parser.js').FunctionDecl} FunctionDecl */
/** @typedef {import('./hlsl-parser.js').TechniqueDecl} TechniqueDecl */
/** @typedef {import('./hlsl-parser.js').Register} Register */

/** @typedef {import('./hlsl-types.js').Symbol} Symbol */
/** @typedef {import('./hlsl-types.js').FunctionSymbol} FunctionSymbol */
/** @typedef {import('./hlsl-types.js').Module} Module */

/**
 * @typedef {Object} Diagnostic
 * @property {string} code
 * @property {'error' | 'warning'} severity
 * @property {string} message
 * @property {Position} pos
 */

/** Thrown to abandon the statement an error was found in. */
const ABORT = { abort: true };

const XYZW = 'xyzw';
const RGBA = 'rgba';

const COMPOUND = new Set(['+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '&=', '|=', '^=']);

/**
 * @param {Program} program
 * @param {{ entry?: string, rowMajor?: boolean }} [options]
 * @returns {{ module: Module, diagnostics: Diagnostic[] }}
 */
export function check(program, options = {}){
    /** @type {Diagnostic[]} */
    const diagnostics = [];
    let nextId = 1;
    /** @type {Map<string, Type>} */
    const structs = new Map();
    /** @type {Map<string, Type>} */
    const typedefs = new Map();
    /** @type {Symbol[]} */
    const globals = [];
    /** @type {Map<string, Symbol[]>} */
    const globalByName = new Map();
    /** @type {Map<string, FunctionSymbol[]>} */
    const functions = new Map();
    /** @type {TechniqueDecl[]} */
    const techniques = [];
    /** @type {FunctionSymbol[]} */
    const queue = [];
    /** @type {Map<Symbol, number>} */
    const initState = new Map();
    let seq = 0;

    // The context of the declaration being checked.
    /** @type {Map<string, Symbol>[]} */
    let scopes = [];
    let limit = Infinity;
    /** @type {{ fn: FunctionSymbol | null, loops: number, switches: number }} */
    let ctx = { fn: null, loops: 0, switches: 0 };

    /** @type {Position} */
    const noPos = { file: '', line: 1, col: 1 };

    /** @param {string} code @param {string} message @param {Position} pos */
    const warn = (code, message, pos)=>{
        diagnostics.push({ code, severity: 'warning', message, pos });
    };

    /** @param {string} code @param {string} message @param {Position} pos @returns {never} */
    function fail(code, message, pos){
        diagnostics.push({ code, severity: 'error', message, pos });
        throw ABORT;
    }

    /**
     * Runs one unit of checking, abandoning it at its first error.
     *
     * @param {() => void} body
     */
    function recover(body){
        try
        {
            body();
        }
        catch (e){
            if (e !== ABORT)
            {
                throw e;
            }
        }
    }

    // ---- types -----------------------------------------------------------------------------

    /** @param {import('./hlsl-parser.js').TypeRef} ref @returns {Type} */
    function typeOf(ref){
        const t = fromTypeRef(ref, name=>structs.get(name) ?? typedefs.get(name));
        if (!t)
        {
            return fail('X3000', `unrecognized identifier '${ref.name}'`, ref.pos);
        }
        return t;
    }

    /**
     * Evaluates a dimension; -1 for an unsized `[]`.
     *
     * @param {any} dim @returns {number}
     */
    function dimension(dim){
        if (dim.kind === 'num' && dim.text === '' && dim.value === -1)
        {
            return -1;
        }
        const e = coerce(expr(dim), INT);
        const v = evaluateConstant(e);
        if (typeof v !== 'number')
        {
            return fail('X3058', 'array dimensions must be literal scalar expressions', dim.pos);
        }
        if (v < 1 || v > 65536)
        {
            return fail('X3059', 'array dimension must be between 1 and 65536', dim.pos);
        }
        return v;
    }

    /**
     * @param {import('./hlsl-parser.js').TypeRef} ref @param {any[]} dims
     * @returns {{ type: Type, lengths: number[] }}
     */
    function declaredType(ref, dims){
        let type = typeOf(ref);
        const lengths = dims.map(dimension);
        for (let i = lengths.length - 1; i >= 0; i--)
        {
            type = arrayOf(type, lengths[i]);
        }
        return { type, lengths };
    }

    // ---- diagnostics helpers ---------------------------------------------------------------

    /**
     * An implicit conversion, as an explicit node. Truncation warns.
     *
     * @param {any} e @param {Type} to
     * @returns {any}
     */
    function coerce(e, to){
        const from = /** @type {Type} */ (e.type);
        if (from.kind === 'error' || to.kind === 'error' || sameType(from, to))
        {
            return e;
        }
        const rank = conversionRank(from, to);
        if (rank === RANK.IMPOSSIBLE)
        {
            return fail('X3017', `cannot convert from '${typeToString(from)}' to `
                + `'${typeToString(to)}'`, e.pos);
        }
        if (rank === RANK.TRUNCATION)
        {
            if (from.kind === 'matrix' || to.kind === 'matrix')
            {
                warn('X3205', 'conversion from larger type to smaller, possible loss of data',
                    e.pos);
            }
            else
            {
                warn('X3206', 'implicit truncation of vector type', e.pos);
            }
        }
        return { kind: 'cast', implicit: true, type: to, operand: e, pos: e.pos };
    }

    /** A condition: one component, as a bool. @param {any} e @returns {any} */
    function condition(e){
        return toCondition(expr(e));
    }

    /** @param {any} checked @returns {any} */
    function toCondition(checked){
        if (!isNumeric(checked.type) || scalarCount(checked.type) !== 1)
        {
            return fail('X3017', `cannot convert from '${typeToString(checked.type)}' to 'bool'`,
                checked.pos);
        }
        return coerce(checked, BOOL);
    }

    /**
     * The shape of two numeric types as one type of the given element type: a scalar takes the
     * shape of the other, vectors and matrices shrink to the smaller, a vector and a matrix do
     * not meet.
     *
     * @param {'bool' | 'int' | 'float'} base @param {Type} ta @param {Type} tb
     * @param {Position} pos
     * @returns {Type}
     */
    function shapeType(base, ta, tb, pos){
        if (ta.kind === 'scalar')
        {
            return withBase(tb, base);
        }
        if (tb.kind === 'scalar')
        {
            return withBase(ta, base);
        }
        if (ta.kind === 'vector' && tb.kind === 'vector')
        {
            const n = ta.n === 1 ? tb.n : tb.n === 1 ? ta.n : Math.min(ta.n, tb.n);
            return vectorOf(base, n);
        }
        if (ta.kind === 'matrix' && tb.kind === 'matrix')
        {
            return matrixOf(base, Math.min(ta.rows, tb.rows), Math.min(ta.cols, tb.cols));
        }
        if (ta.kind === 'matrix' && tb.kind === 'vector' && tb.n === 1)
        {
            return withBase(ta, base);
        }
        if (tb.kind === 'matrix' && ta.kind === 'vector' && ta.n === 1)
        {
            return withBase(tb, base);
        }
        return fail('X3020', 'type mismatch', pos);
    }

    /**
     * The widest element type of two numeric types, a bool being the narrowest.
     *
     * @param {Type} ta @param {Type} tb
     * @returns {'bool' | 'int' | 'float'}
     */
    function widest(ta, tb){
        const a = baseOf(ta);
        const b = baseOf(tb);
        return a === 'float' || b === 'float' ? 'float' : a === 'int' || b === 'int' ? 'int'
            : 'bool';
    }

    /**
     * @param {string} op @param {Type} ta @param {Type} tb @param {Position} pos
     * @returns {{ opType: Type, type: Type, integerOnly: boolean }}
     */
    function binaryTyping(op, ta, tb, pos){
        if (!isNumeric(ta) || !isNumeric(tb))
        {
            return fail('X3020', 'type mismatch', pos);
        }
        switch (op)
        {
            case '+': case '-': case '*': case '/': case '%': {
                const base = widest(ta, tb) === 'float' ? 'float' : 'int';
                const t = shapeType(base, ta, tb, pos);
                return { opType: t, type: t, integerOnly: false };
            }
            case '<': case '>': case '<=': case '>=': case '==': case '!=': {
                const t = shapeType(widest(ta, tb), ta, tb, pos);
                return { opType: t, type: withBase(t, 'bool'), integerOnly: false };
            }
            case '&&': case '||': {
                const t = shapeType('bool', ta, tb, pos);
                return { opType: t, type: t, integerOnly: false };
            }
            default: {
                if (baseOf(ta) === 'float' || baseOf(tb) === 'float')
                {
                    return fail('X3082', 'int or unsigned int type required', pos);
                }
                const t = shapeType('int', ta, tb, pos);
                return { opType: t, type: t, integerOnly: true };
            }
        }
    }

    // ---- scopes and symbols ----------------------------------------------------------------

    /** @param {string} name @returns {Symbol | undefined} */
    function lookup(name){
        for (let i = scopes.length - 1; i >= 0; i--)
        {
            const s = scopes[i].get(name);
            if (s)
            {
                return s;
            }
        }
        const list = globalByName.get(name);
        if (list)
        {
            for (let i = list.length - 1; i >= 0; i--)
            {
                if (list[i].order < limit)
                {
                    return list[i];
                }
            }
        }
        return undefined;
    }

    /**
     * @param {Partial<Symbol> & { kind: Symbol['kind'], name: string, type: Type,
     *     decl: Variable }} init
     * @returns {Symbol}
     */
    function makeSymbol(init){
        const mods = init.decl.mods;
        return {
            id: nextId++, mods, isUniform: false, isStatic: mods.includes('static'),
            isConst: mods.includes('const'), register: init.decl.register,
            semantic: init.decl.semantic, constValue: undefined, init: null, order: 0, ...init,
        };
    }

    /** @param {Symbol} sym */
    function declareLocal(sym){
        const scope = scopes[scopes.length - 1];
        const before = scope.get(sym.name);
        // A variable the head of a `for` declares belongs to the block around the loop, as in
        // the Direct3D 9 compilers, and a later declaration of the name replaces it.
        if (before && !forDeclared && !forScoped.has(before))
        {
            fail('X3003', `redefinition of '${sym.name}'`, sym.decl.pos);
        }
        if (forDeclared)
        {
            forScoped.add(sym);
        }
        scope.set(sym.name, sym);
    }

    /** Whether the head of a `for` is being checked. */
    let forDeclared = false;
    /** The variables declared by the head of a `for`. @type {Set<Symbol>} */
    const forScoped = new Set();

    // ---- declarations ----------------------------------------------------------------------

    /** @param {Variable} v */
    function declareGlobal(v){
        const { type } = declaredType(v.type, v.dims);
        if (type.kind === 'void')
        {
            fail('X3005', 'illegal variable type', v.pos);
        }
        const sym = makeSymbol({ kind: 'global', name: v.name, type, decl: v });
        sym.isUniform = !sym.isStatic;
        sym.order = seq++;
        const list = globalByName.get(v.name) ?? [];
        if (list.length > 0)
        {
            fail('X3003', `redefinition of '${v.name}'`, v.pos);
        }
        list.push(sym);
        globalByName.set(v.name, list);
        globals.push(sym);
        const init = /** @type {any} */ (v.init);
        if (init && init.kind === 'samplerstate')
        {
            sym.samplerState = init.entries.map((/** @type {any} */ x)=>({ name: x.name,
                valueText: stateText(x.value) }));
        }
    }

    /** @param {any} x @returns {string} */
    function stateText(x){
        switch (x.kind)
        {
            case 'texref':
            case 'ident': return x.name;
            case 'num': return x.text;
            case 'bool': return String(x.value);
            case 'string': return x.value;
            case 'unary': return `${x.op}${stateText(x.operand)}`;
            case 'binary': return `${stateText(x.left)} ${x.op} ${stateText(x.right)}`;
            default: return '';
        }
    }

    /**
     * Checks a global's initialiser the first time the global is named.
     *
     * @param {Symbol} sym
     */
    function ensureGlobal(sym){
        if (initState.has(sym))
        {
            return;
        }
        initState.set(sym, 1);
        const v = sym.decl;
        const init = /** @type {any} */ (v.init);
        if (!init || init.kind === 'samplerstate')
        {
            return;
        }
        const saved = { scopes, limit, ctx };
        scopes = [new Map()];
        limit = sym.order;
        ctx = { fn: null, loops: 0, switches: 0 };
        try
        {
            recover(()=>{
                let type = sym.type;
                if (type.kind === 'array' && type.length === -1)
                {
                    type = unsizedArray(type, init);
                    sym.type = type;
                }
                sym.init = initialiser(type, init);
                v.init = sym.init;
                if (sym.isConst && sym.isStatic)
                {
                    sym.constValue = evaluateConstant(sym.init);
                }
            });
        }
        finally
        {
            ({ scopes, limit, ctx } = saved);
        }
    }

    /** @param {Variable} v @param {boolean} entry */
    function paramSymbol(v, entry){
        const { type } = declaredType(v.type, v.dims);
        const dir = v.mods.includes('inout') ? 'inout' : v.mods.includes('out') ? 'out' : 'in';
        const sym = makeSymbol({ kind: 'param', name: v.name, type, decl: v, dir });
        sym.isUniform = v.mods.includes('uniform') || (entry && dir === 'in' && !v.semantic
            && (isNumeric(type) || type.kind === 'array' || type.kind === 'sampler'
                || type.kind === 'texture'));
        return sym;
    }

    /** @param {FunctionDecl} d */
    function declareFunction(d){
        const entry = d.name === options.entry;
        const at = seq++;
        const params = d.params.map(p=>paramSymbol(p, entry));
        const returnType = typeOf(d.returnType);
        const overloadKey = `${d.name}(${params.map(p=>typeToString(p.type)).join(',')})`;
        const list = functions.get(d.name) ?? [];
        functions.set(d.name, list);
        const same = list.find(f=>f.overloadKey === overloadKey);
        if (same)
        {
            if (same.decl.body && d.body)
            {
                fail('X3003', `redefinition of '${d.name}'`, d.pos);
            }
            if (d.body)
            {
                same.decl = d;
                same.params = params;
                same.semantic = d.semantic;
                same.bodyLimit = at + 1;
            }
            return;
        }
        list.push({ name: d.name, decl: d, params, returnType, semantic: d.semantic,
            overloadKey, calls: [], usedGlobals: new Set(), checked: false, order: at,
            bodyLimit: at + 1 });
    }

    /** @param {Variable} v @returns {Type} */
    function memberType(v){
        const { type } = declaredType(v.type, v.dims);
        if (type.kind === 'void')
        {
            fail('X3005', 'illegal variable type', v.pos);
        }
        /** @type {any} */
        let t = type;
        while (t.kind === 'array')
        {
            if (t.length < 0)
            {
                fail('X3072', `'${v.name}': array dimensions of structure members must be explicit`,
                    v.pos);
            }
            t = t.elem;
        }
        return type;
    }

    // ---- initialisers ----------------------------------------------------------------------

    /** @param {any} node @returns {any[]} */
    function rawLeaves(node){
        return node.kind === 'initlist' ? node.items.flatMap(rawLeaves) : [node];
    }

    /** @param {any} node @returns {any[]} */
    function checkedLeaves(node){
        if (!node.checkedLeaves)
        {
            node.checkedLeaves = rawLeaves(node).map(x=>expr(x));
        }
        return node.checkedLeaves;
    }

    /** The length of `T x[] = { ... }` follows from the list. @param {Type} type @param {any} init */
    function unsizedArray(type, init){
        const array = /** @type {Extract<Type, { kind: 'array' }>} */ (type);
        if (init.kind !== 'initlist')
        {
            return fail('X3074', 'unsized array requires an initializer list', init.pos);
        }
        const per = scalarCount(array.elem);
        const total = checkedLeaves(init).reduce((n, l)=>n + scalarCount(l.type), 0);
        if (per === 0 || total % per !== 0 || total === 0)
        {
            return fail('X3017', `cannot convert initializer list to '${typeToString(type)}'`,
                init.pos);
        }
        return arrayOf(array.elem, total / per);
    }

    /**
     * The initialiser of a variable of the type, converted; an initialiser list is checked by
     * its scalar count.
     *
     * @param {Type} type @param {any} node
     * @returns {any}
     */
    function initialiser(type, node){
        if (node.kind !== 'initlist')
        {
            return coerce(expr(node), type);
        }
        if (!(isNumeric(type) || type.kind === 'array' || type.kind === 'struct'))
        {
            return fail('X3017', `cannot convert from initializer list to `
                + `'${typeToString(type)}'`, node.pos);
        }
        // A texture or a sampler in the list is the object member it stands at, which holds
        // no number: the numbers fill the rest.
        const leaves = checkedLeaves(node).filter((/** @type {any} */ l)=>
            l.type.kind !== 'texture' && l.type.kind !== 'sampler');
        let total = 0;
        for (const l of leaves)
        {
            if (!isNumeric(l.type))
            {
                return fail('X3017', `cannot convert from '${typeToString(l.type)}' to a `
                    + 'numeric type', l.pos);
            }
            total += scalarCount(l.type);
        }
        if (total !== scalarCount(type))
        {
            return fail('X3017', `cannot convert initializer list of ${total} elements to `
                + `'${typeToString(type)}' (${scalarCount(type)} expected)`, node.pos);
        }
        const bases = flatBases(type);
        let at = 0;
        node.leaves = leaves.map(l=>{
            const base = bases[at];
            at += scalarCount(l.type);
            return baseOf(l.type) === base ? l : { kind: 'cast', implicit: true,
                type: withBase(l.type, base), operand: l, pos: l.pos };
        });
        node.type = type;
        return node;
    }

    // ---- expressions -----------------------------------------------------------------------

    /**
     * Whether an expression may be assigned to; fails with the reason when it may not.
     *
     * @param {any} e
     */
    function lvalue(e){
        switch (e.kind)
        {
            case 'ident': {
                const s = e.sym;
                // A global that is not const is a program's own copy of the uniform, as in
                // Direct3D 9 compilers: the write changes what this invocation reads back.
                if (s.isConst || (s.kind === 'param' && s.mods.includes('uniform'))
                    || e.type.kind === 'sampler' || e.type.kind === 'texture')
                {
                    fail('X3025', 'l-value specifies const object', e.pos);
                }
                return;
            }
            case 'member': {
                if (e.swizzle && new Set(e.swizzle).size !== e.swizzle.length)
                {
                    fail('X3025', 'invalid l-value', e.pos);
                }
                if (e.matrixSwizzle && new Set(e.matrixSwizzle.map((/** @type {number[]} */ p)=>
                    p[0] * 4 + p[1])).size !== e.matrixSwizzle.length)
                {
                    fail('X3025', 'invalid l-value', e.pos);
                }
                lvalue(e.object);
                return;
            }
            case 'index':
                lvalue(e.object);
                return;
            case 'cast':
                // `(float2) p = v` writes what the cast shows of p, converted back.
                lvalue(e.operand);
                return;
            default:
                fail('X3025', 'l-value specifies const object', e.pos);
        }
    }

    /** @param {any} e @returns {any} */
    function expr(e){
        switch (e.kind)
        {
            case 'num':
                e.type = e.ntype === 'int' || e.ntype === 'uint' ? INT : FLOAT;
                return e;
            case 'bool':
                e.type = BOOL;
                return e;
            case 'string':
                e.type = STRING;
                return e;
            case 'ident': return identifier(e);
            case 'combine': return e;
            case 'unary': return unary(e);
            case 'incdec': {
                e.operand = expr(e.operand);
                lvalue(e.operand);
                if (!isNumeric(e.operand.type))
                {
                    fail('X3020', 'type mismatch', e.pos);
                }
                e.opType = e.operand.type;
                e.type = e.operand.type;
                return e;
            }
            case 'binary': {
                const a = expr(e.left);
                const b = expr(e.right);
                const r = binaryTyping(e.op, a.type, b.type, e.pos);
                e.left = coerce(a, r.opType);
                e.right = coerce(b, r.opType);
                e.opType = r.opType;
                e.type = r.type;
                if (r.integerOnly)
                {
                    e.integerOnly = true;
                }
                return e;
            }
            case 'assign': return assignment(e);
            case 'cond': return conditional(e);
            case 'comma':
                e.exprs = e.exprs.map(expr);
                e.type = e.exprs[e.exprs.length - 1].type;
                return e;
            case 'call': return call(e);
            case 'construct': return construct(e);
            case 'cast': return castExpr(e);
            case 'member': return member(e);
            case 'index': return indexExpr(e);
            case 'initlist':
                return fail('X3000', 'initializer lists are only allowed in declarations', e.pos);
            default:
                return fail('X3000', 'unexpected expression', e.pos);
        }
    }

    /** @param {any} e @returns {any} */
    function identifier(e){
        const sym = lookup(e.name);
        if (!sym)
        {
            return fail('X3004', `undeclared identifier '${e.name}'`, e.pos);
        }
        if (sym.kind === 'global')
        {
            ensureGlobal(sym);
            ctx.fn?.usedGlobals.add(sym);
        }
        e.sym = sym;
        e.type = sym.type;
        return e;
    }

    /** @param {any} e @returns {any} */
    function unary(e){
        const a = expr(e.operand);
        const t = a.type;
        if (!isNumeric(t))
        {
            return fail('X3020', 'type mismatch', e.pos);
        }
        let opType;
        switch (e.op)
        {
            case '!':
                opType = withBase(t, 'bool');
                break;
            case '~':
                if (baseOf(t) === 'float')
                {
                    return fail('X3082', 'int or unsigned int type required', e.pos);
                }
                opType = withBase(t, 'int');
                break;
            default:
                opType = withBase(t, baseOf(t) === 'float' ? 'float' : 'int');
                break;
        }
        e.operand = coerce(a, opType);
        e.opType = opType;
        e.type = opType;
        return e;
    }

    /** @param {any} e @returns {any} */
    function assignment(e){
        const target = expr(e.target);
        lvalue(target);
        const value = expr(e.value);
        e.target = target;
        e.type = target.type;
        if (e.op === '=')
        {
            e.value = coerce(value, target.type);
            return e;
        }
        if (!COMPOUND.has(e.op))
        {
            return fail('X3000', `unknown assignment operator '${e.op}'`, e.pos);
        }
        const r = binaryTyping(e.op.slice(0, -1), target.type, value.type, e.pos);
        if (conversionRank(r.type, target.type) === RANK.IMPOSSIBLE)
        {
            return fail('X3017', `cannot convert from '${typeToString(r.type)}' to `
                + `'${typeToString(target.type)}'`, e.pos);
        }
        e.value = coerce(value, r.opType);
        e.opType = r.opType;
        if (r.integerOnly)
        {
            e.integerOnly = true;
        }
        return e;
    }

    /** @param {any} e @returns {any} */
    function conditional(e){
        const raw = expr(e.test);
        if (isNumeric(raw.type) && scalarCount(raw.type) > 1)
        {
            return componentwiseConditional(e, raw);
        }
        const test = toCondition(raw);
        const a = expr(e.then);
        const b = expr(e.else);
        /** @type {Type} */
        let t;
        if (sameType(a.type, b.type))
        {
            t = a.type;
        }
        else if (isNumeric(a.type) && isNumeric(b.type))
        {
            t = shapeType(widest(a.type, b.type), a.type, b.type, e.pos);
        }
        else
        {
            return fail('X3020', 'type mismatch', e.pos);
        }
        e.test = test;
        e.then = coerce(a, t);
        e.else = coerce(b, t);
        e.type = t;
        return e;
    }

    /**
     * `v ? a : b` with a vector or matrix condition: each component chooses for itself, and
     * both arms are evaluated.
     *
     * @param {any} e @param {any} raw The checked condition.
     * @returns {any}
     */
    function componentwiseConditional(e, raw){
        const a = expr(e.then);
        const b = expr(e.else);
        if (!isNumeric(a.type) || !isNumeric(b.type))
        {
            return fail('X3020', 'type mismatch', e.pos);
        }
        const base = widest(a.type, b.type);
        const t = shapeType(base, shapeType(base, a.type, b.type, e.pos), raw.type, e.pos);
        e.test = coerce(raw, withBase(t, 'bool'));
        e.then = coerce(a, t);
        e.else = coerce(b, t);
        e.type = t;
        e.componentwise = true;
        return e;
    }

    /** @param {any} e @returns {any} */
    function construct(e){
        const ref = e.typeRef ?? e.type;
        const t = typeOf(ref);
        if (!isNumeric(t))
        {
            return fail('X3014', 'incorrect number of arguments to numeric-type constructor',
                e.pos);
        }
        e.args = e.args.map(expr);
        const counts = [];
        let total = 0;
        for (const a of e.args)
        {
            // An array or a structure of numbers gives its numbers in order.
            if (!isNumeric(a.type) && !((a.type.kind === 'array' || a.type.kind === 'struct')
                && componentsOf(a.type).every(c=>c[0] === 'n')))
            {
                return fail('X3017', `cannot convert from '${typeToString(a.type)}' to `
                    + `'${typeToString(t)}'`, a.pos);
            }
            counts.push(scalarCount(a.type));
            total += counts[counts.length - 1];
        }
        const need = scalarCount(t);
        const replicate = e.args.length === 1 && counts[0] === 1 && need > 1;
        if (total !== need && !replicate)
        {
            return fail('X3014', 'incorrect number of arguments to numeric-type constructor',
                e.pos);
        }
        e.typeRef = ref;
        e.type = t;
        e.argScalars = counts;
        e.replicate = replicate;
        return e;
    }

    /** @param {any} e @returns {any} */
    function castExpr(e){
        const ref = e.typeRef ?? e.type;
        const to = e.dims?.length ? declaredType(ref, e.dims).type : typeOf(ref);
        const a = expr(e.operand);
        // `(S)0` zero-fills a structure or an array; a value with as many scalars as the
        // aggregate fills it in order.
        const fills = (to.kind === 'struct' || to.kind === 'array') && isNumeric(a.type)
            && (scalarCount(a.type) === 1 || scalarCount(a.type) === scalarCount(to));
        // Between aggregates, component by component: the source's cover the target's in
        // order, numbers for numbers and objects for objects of their kind.
        const aggregate = !isNumeric(a.type) || !isNumeric(to);
        const from = componentsOf(a.type);
        const into = componentsOf(to);
        const matches = aggregate && into.length > 0 && from.length >= into.length
            && into.every((c, i)=>c === from[i] || (c[0] === 'n' && from[i][0] === 'n'));
        if (!fills && !matches && conversionRank(a.type, to) === RANK.IMPOSSIBLE)
        {
            return fail('X3017', `cannot convert from '${typeToString(a.type)}' to `
                + `'${typeToString(to)}'`, e.pos);
        }
        e.typeRef = ref;
        e.type = to;
        e.operand = a;
        e.implicit = false;
        return e;
    }

    /** @param {any} e @returns {any} */
    function member(e){
        const obj = expr(e.object);
        e.object = obj;
        const t = obj.type;
        const name = e.name;
        const bad = ()=>fail('X3018', `invalid subscript '${name}'`, e.pos);
        if (t.kind === 'struct')
        {
            const i = t.members.findLastIndex((/** @type {any} */ m)=>m.name === name);
            if (i < 0)
            {
                return bad();
            }
            e.field = i;
            e.fieldName = name;
            e.type = t.members[i].type;
            return e;
        }
        if (t.kind === 'scalar' || t.kind === 'vector')
        {
            const set = [...name].every(c=>XYZW.includes(c)) ? XYZW
                : [...name].every(c=>RGBA.includes(c)) ? RGBA : null;
            if (!set || name.length > 4)
            {
                return bad();
            }
            const size = t.kind === 'scalar' ? 1 : t.n;
            const indices = [...name].map(c=>set.indexOf(c));
            if (indices.some(i=>i >= size))
            {
                return bad();
            }
            e.swizzle = indices;
            e.type = indices.length === 1 ? scalarOf(t.base) : vectorOf(t.base, indices.length);
            return e;
        }
        if (t.kind === 'matrix')
        {
            const zero = /^(?:_m[0-3][0-3]){1,4}$/.test(name);
            const one = /^(?:_[1-4][1-4]){1,4}$/.test(name);
            if (!zero && !one)
            {
                return bad();
            }
            /** @type {[number, number][]} */
            const picks = [];
            const digits = name.match(zero ? /_m(\d)(\d)/g : /_(\d)(\d)/g) ?? [];
            for (const d of digits)
            {
                const nums = d.replace('_m', '').replace('_', '');
                const r = Number(nums[0]) - (zero ? 0 : 1);
                const c = Number(nums[1]) - (zero ? 0 : 1);
                if (r >= t.rows || c >= t.cols)
                {
                    return bad();
                }
                picks.push([r, c]);
            }
            e.matrixSwizzle = picks;
            e.type = picks.length === 1 ? scalarOf(t.base) : vectorOf(t.base, picks.length);
            return e;
        }
        return bad();
    }

    /** @param {any} e @returns {any} */
    function indexExpr(e){
        const obj = expr(e.object);
        const t = obj.type;
        /** @type {Type} */
        let result;
        if (t.kind === 'array')
        {
            result = t.elem;
        }
        else if (t.kind === 'vector')
        {
            result = scalarOf(t.base);
        }
        else if (t.kind === 'matrix')
        {
            result = vectorOf(t.base, t.cols);
        }
        else
        {
            return fail('X3121', 'array, matrix, vector, or indexable object type expected in '
                + 'index expression', e.pos);
        }
        const index = expr(e.index);
        if (!isNumeric(index.type) || scalarCount(index.type) !== 1)
        {
            return fail('X3017', `cannot convert from '${typeToString(index.type)}' to 'int'`,
                index.pos);
        }
        e.object = obj;
        e.index = coerce(index, INT);
        e.type = result;
        return e;
    }

    // ---- calls -----------------------------------------------------------------------------

    /**
     * Conversion rank of an argument for a parameter; out parameters convert the other way.
     *
     * @param {Symbol} p @param {Type} arg
     */
    function paramRank(p, arg){
        if (p.dir === 'out')
        {
            return conversionRank(p.type, arg);
        }
        if (p.dir === 'inout')
        {
            return Math.max(conversionRank(arg, p.type), conversionRank(p.type, arg));
        }
        return conversionRank(arg, p.type);
    }

    /** @param {any} e @returns {any} */
    function call(e){
        if (e.callee.kind === 'member')
        {
            return textureMethod(e);
        }
        if (e.callee.kind !== 'ident')
        {
            return fail('X3087', 'methods are not supported', e.pos);
        }
        const name = e.callee.name;
        e.args = e.args.map(expr);
        const args = e.args;
        const visible = (functions.get(name) ?? []).filter(f=>f.order < limit);
        const sameArity = visible.filter(f=>f.params.length === args.length);
        const viable = sameArity.map(f=>({ f, ranks: f.params.map((p, i)=>paramRank(p,
            args[i].type)) })).filter(v=>v.ranks.every((/** @type {number} */ r)=>
            r < RANK.IMPOSSIBLE));
        if (viable.length > 0)
        {
            let best = viable.filter(v=>viable.every(o=>o === v || v.ranks.every((r, i)=>
                r <= o.ranks[i])));
            if (best.length > 1)
            {
                // Equal ranks everywhere: the overload that drops fewer components is nearer.
                const lost = (/** @type {typeof viable[number]} */ v)=>v.f.params.reduce((n, p, i)=>
                    n + Math.max(0, scalarCount(args[i].type) - scalarCount(p.type)), 0);
                const least = Math.min(...best.map(lost));
                best = best.filter(v=>lost(v) === least);
            }
            if (best.length !== 1)
            {
                return fail('X3067', `'${name}': ambiguous function call`, e.pos);
            }
            return userCall(e, best[0].f);
        }
        if (isIntrinsic(name))
        {
            return intrinsicCall(e, name);
        }
        if (visible.length === 0)
        {
            return fail('X3004', `undeclared identifier '${name}'`, e.pos);
        }
        return fail('X3013', `'${name}': no matching ${args.length} parameter function`, e.pos);
    }

    /**
     * `tex.Sample(sam, uv)` and its kin, the Direct3D 10 way of reading a texture, which fxc
     * takes in models 2 and 3 as the tex2D family on a sampler of the pair: Sample as tex2D,
     * SampleLevel and SampleBias as tex2Dlod and tex2Dbias with the level in w, SampleGrad
     * as tex2Dgrad.
     *
     * @param {any} e @returns {any}
     */
    function textureMethod(e){
        const method = e.callee.name;
        if (!['Sample', 'SampleLevel', 'SampleBias', 'SampleGrad', 'SampleCmp', 'Load',
            'Gather', 'GetDimensions', 'SampleCmpLevelZero'].includes(method))
        {
            return fail('X3087', 'methods are not supported', e.callee.pos);
        }
        const object = expr(e.callee.object);
        if (object.type.kind !== 'texture')
        {
            return fail('X3087', 'methods are not supported', e.pos);
        }
        const dim = object.type.dim === 'any' ? '2d' : object.type.dim;
        const suffix = { '1d': '1D', '2d': '2D', '3d': '3D', cube: 'CUBE' }[
            /** @type {'1d' | '2d' | '3d' | 'cube'} */ (dim)];
        const lanes = dim === '1d' ? 1 : dim === '2d' ? 2 : 3;
        const known = { Sample: 2, SampleLevel: 3, SampleBias: 3, SampleGrad: 4 };
        const arity = /** @type {Record<string, number>} */ (known)[method];
        if (arity === undefined)
        {
            return fail('X3500', `'${method}' is not available in shader models 2 and 3`,
                e.pos);
        }
        if (e.args.length !== arity)
        {
            return fail('X3013', `'${method}': no matching ${e.args.length} parameter intrinsic `
                + 'function', e.pos);
        }
        const sampler = expr(e.args[0]);
        if (sampler.type.kind !== 'sampler')
        {
            return fail('X3017', `cannot convert from '${typeToString(sampler.type)}' to `
                + `'SamplerState'`, sampler.pos);
        }
        const combine = { kind: 'combine', sampler, texture: object, pos: e.pos,
            type: samplerOf(dim) };
        const pos = e.pos;
        const zero = { kind: 'num', value: 0, ntype: 'float', text: '0', pos };
        /** The coordinate and a level or bias in w, as tex2Dlod and tex2Dbias read them. */
        const withW = (/** @type {any} */ w)=>({ kind: 'construct', pos, args: [e.args[1],
            ...Array.from({ length: 3 - lanes }, ()=>zero), w],
        type: { cls: 'vector', scalar: 'float', rows: 1, cols: 4, pos } });
        const name = `tex${suffix}${method === 'SampleLevel' ? 'lod' : method === 'SampleBias'
            ? 'bias' : method === 'SampleGrad' ? 'grad' : ''}`;
        const rest = method === 'SampleLevel' || method === 'SampleBias' ? [withW(e.args[2])]
            : e.args.slice(1);
        const rewritten = { kind: 'call', callee: { kind: 'ident', name, pos }, pos,
            args: [combine, ...rest.map(expr)] };
        return intrinsicCall(rewritten, name);
    }

    /** @param {any} e @param {FunctionSymbol} fn @returns {any} */
    function userCall(e, fn){
        /** @type {string[]} */
        const modes = [];
        fn.params.forEach((p, i)=>{
            modes.push(/** @type {string} */ (p.dir));
            if (p.dir === 'in')
            {
                e.args[i] = coerce(e.args[i], p.type);
            }
            else
            {
                lvalue(e.args[i]);
            }
        });
        e.argModes = modes;
        e.callee.fn = fn;
        e.target = { kind: 'user', fn };
        e.type = fn.returnType;
        const caller = ctx.fn;
        if (caller && !caller.calls.includes(fn))
        {
            caller.calls.push(fn);
        }
        if (!fn.checked && !queue.includes(fn))
        {
            queue.push(fn);
        }
        return e;
    }

    /** @param {any} e @param {string} name @returns {any} */
    function intrinsicCall(e, name){
        const sig = resolveIntrinsic(name, e.args.map((/** @type {any} */ a)=>a.type));
        if (!sig)
        {
            return fail('X3013', `'${name}': no matching ${e.args.length} parameter intrinsic `
                + 'function', e.pos);
        }
        if (sig.unsupported)
        {
            return fail('X3500', `'${name}': intrinsic function is not supported`, e.pos);
        }
        sig.paramTypes.forEach((pt, i)=>{
            if (sig.outParams?.includes(i))
            {
                lvalue(e.args[i]);
                if (conversionRank(pt, e.args[i].type) === RANK.IMPOSSIBLE)
                {
                    fail('X3017', `cannot convert from '${typeToString(pt)}' to `
                        + `'${typeToString(e.args[i].type)}'`, e.args[i].pos);
                }
            }
            else
            {
                e.args[i] = coerce(e.args[i], pt);
            }
        });
        e.callee.intrinsic = name;
        e.target = { kind: 'intrinsic', name, signature: sig };
        e.type = sig.resultType;
        return e;
    }

    // ---- statements ------------------------------------------------------------------------

    /** @param {any} s */
    function stmt(s){
        recover(()=>statement(s));
    }

    /** @param {any} v */
    function localDeclaration(v){
        recover(()=>{
            let { type, lengths } = declaredType(v.type, v.dims);
            if (type.kind === 'void')
            {
                fail('X3005', 'illegal variable type', v.pos);
            }
            if (lengths.includes(-1) && lengths.indexOf(-1) === 0 && v.init)
            {
                // Only the outermost length may follow from the list.
                type = unsizedFrom(v, type);
            }
            else if (lengths.includes(-1))
            {
                fail('X3074', 'unsized array requires an initializer list', v.pos);
            }
            const sym = makeSymbol({ kind: 'local', name: v.name, type, decl: v });
            declareLocal(sym);
            v.sym = sym;
            if (v.init)
            {
                sym.init = initialiser(type, v.init);
                v.init = sym.init;
                if (sym.isConst && !sym.isStatic)
                {
                    sym.constValue = evaluateConstant(sym.init);
                }
            }
        });
    }

    /** @param {any} v @param {Type} type @returns {Type} */
    function unsizedFrom(v, type){
        return unsizedArray(type, v.init);
    }

    /** @param {any} s */
    function statement(s){
        switch (s.kind)
        {
            case 'block':
                scopes.push(new Map());
                try
                {
                    s.stmts.forEach(stmt);
                }
                finally
                {
                    scopes.pop();
                }
                return;
            case 'decl':
                s.vars.forEach(localDeclaration);
                return;
            case 'expr':
                s.expr = expr(s.expr);
                return;
            case 'if':
                s.test = condition(s.test);
                stmt(s.then);
                if (s.else)
                {
                    stmt(s.else);
                }
                return;
            case 'for':
                if (s.init)
                {
                    forDeclared = true;
                    try
                    {
                        stmt(s.init);
                    }
                    finally
                    {
                        forDeclared = false;
                    }
                }
                recover(()=>{
                    if (s.test)
                    {
                        s.test = condition(s.test);
                    }
                    if (s.step)
                    {
                        s.step = expr(s.step);
                    }
                });
                loopBody(s.body);
                return;
            case 'while':
                recover(()=>{
                    s.test = condition(s.test);
                });
                loopBody(s.body);
                return;
            case 'do':
                loopBody(s.body);
                recover(()=>{
                    s.test = condition(s.test);
                });
                return;
            case 'switch': {
                s.test = coerce(expr(s.test), INT);
                ctx.switches++;
                try
                {
                    for (const c of s.cases)
                    {
                        if (c.value)
                        {
                            c.value = coerce(expr(c.value), INT);
                            if (evaluateConstant(c.value) === undefined)
                            {
                                fail('X3000', 'case expression must be a constant', c.value.pos);
                            }
                        }
                        scopes.push(new Map());
                        c.body.forEach(stmt);
                        scopes.pop();
                    }
                }
                finally
                {
                    ctx.switches--;
                }
                return;
            }
            case 'break':
                if (ctx.loops === 0 && ctx.switches === 0)
                {
                    fail('X3518', "'break' statement is not inside a loop or switch", s.pos);
                }
                return;
            case 'continue':
                if (ctx.loops === 0)
                {
                    fail('X3519', "'continue' statement is not inside a loop", s.pos);
                }
                return;
            case 'discard':
            case 'empty':
                return;
            case 'return': {
                const fn = /** @type {FunctionSymbol} */ (ctx.fn);
                if (fn.returnType.kind === 'void')
                {
                    if (s.value)
                    {
                        fail('X3079', `'${fn.name}': void functions cannot return a value`,
                            s.pos);
                    }
                    return;
                }
                if (!s.value)
                {
                    fail('X3080', `'${fn.name}': function must return a value`, s.pos);
                }
                s.value = coerce(expr(s.value), fn.returnType);
                return;
            }
            default:
                fail('X3000', 'unexpected statement', s.pos);
        }
    }

    /** @param {any} body */
    function loopBody(body){
        ctx.loops++;
        try
        {
            stmt(body);
        }
        finally
        {
            ctx.loops--;
        }
    }

    // ---- control flow ----------------------------------------------------------------------

    /** Whether a loop test is the constant true. @param {any} t */
    /** @type {(t: any) => boolean} */
    const alwaysTrue = t=>t === null || (t.kind === 'bool' && t.value)
        || (t.kind === 'num' && t.value !== 0)
        || (t.kind === 'cast' && alwaysTrue(t.operand));

    /**
     * How a statement can end: normally, by `break`, by `continue`; a statement that only
     * returns ends none of the ways.
     *
     * @param {any} s
     * @returns {{ normal: boolean, brk: boolean, cont: boolean }}
     */
    function flow(s){
        const none = { normal: false, brk: false, cont: false };
        switch (s.kind)
        {
            case 'return': return none;
            case 'break': return { ...none, brk: true };
            case 'continue': return { ...none, cont: true };
            case 'block': {
                const out = { normal: true, brk: false, cont: false };
                for (const x of s.stmts)
                {
                    const f = flow(x);
                    out.brk = out.brk || f.brk;
                    out.cont = out.cont || f.cont;
                    if (!f.normal)
                    {
                        out.normal = false;
                        break;
                    }
                }
                return out;
            }
            case 'if': {
                const a = flow(s.then);
                const b = s.else ? flow(s.else) : { normal: true, brk: false, cont: false };
                return { normal: a.normal || b.normal, brk: a.brk || b.brk,
                    cont: a.cont || b.cont };
            }
            case 'for':
            case 'while': {
                const body = flow(s.body);
                return { normal: !alwaysTrue(s.test ?? null) || body.brk, brk: false,
                    cont: false };
            }
            case 'do': {
                const body = flow(s.body);
                const reaches = body.normal || body.cont;
                return { normal: body.brk || (reaches && !alwaysTrue(s.test)), brk: false,
                    cont: false };
            }
            case 'switch': {
                let hasDefault = false;
                let anyBreak = false;
                let cont = false;
                let falls = true;
                for (const c of s.cases)
                {
                    hasDefault = hasDefault || c.value === null;
                    let open = true;
                    for (const x of c.body)
                    {
                        const f = flow(x);
                        anyBreak = anyBreak || f.brk;
                        cont = cont || f.cont;
                        if (!f.normal)
                        {
                            open = false;
                            break;
                        }
                    }
                    falls = open;
                }
                return { normal: !hasDefault || anyBreak || falls || s.cases.length === 0,
                    brk: false, cont };
            }
            default: return { normal: true, brk: false, cont: false };
        }
    }

    // ---- functions -------------------------------------------------------------------------

    /** @param {FunctionSymbol} fn */
    function checkFunction(fn){
        if (fn.checked || !fn.decl.body)
        {
            return;
        }
        fn.checked = true;
        const saved = { scopes, limit, ctx };
        scopes = [new Map()];
        limit = fn.bodyLimit;
        ctx = { fn, loops: 0, switches: 0 };
        try
        {
            for (const p of fn.params)
            {
                recover(()=>declareLocal(p));
            }
            stmt(fn.decl.body);
            if (fn.returnType.kind !== 'void' && flow(fn.decl.body).normal)
            {
                diagnostics.push({ code: 'X3507', severity: 'error', message:
                    `'${fn.name}': Not all control paths return a value`, pos: fn.decl.pos });
            }
        }
        finally
        {
            ({ scopes, limit, ctx } = saved);
        }
    }

    /** @param {FunctionSymbol} fn @param {Set<FunctionSymbol>} seen @param {FunctionSymbol[]} out */
    function walk(fn, seen, out){
        for (const callee of fn.calls)
        {
            if (!seen.has(callee))
            {
                seen.add(callee);
                out.push(callee);
                walk(callee, seen, out);
            }
        }
    }

    /** @param {any} expression */
    function evaluateConstant(expression){
        return createEvaluator(module, { uniform: sym=>{
            throw new Error(`no value for ${sym.name}`);
        } }).evaluateConstant(expression);
    }

    // ---- driver ----------------------------------------------------------------------------

    /** @type {Module} */
    const module = {
        globals, functions, structs, typedefs, techniques, pragmas: program.pragmas,
        rowMajor: options.rowMajor ?? false,
        findFunction: name=>{
            const list = functions.get(name) ?? [];
            return list.find(f=>f.decl.body) ?? list[0];
        },
        reachable: fn=>{
            /** @type {FunctionSymbol[]} */
            const out = [];
            walk(fn, new Set([fn]), out);
            return out;
        },
        reachableGlobals: fn=>{
            /** @type {Set<Symbol>} */
            const used = new Set(fn.usedGlobals);
            /** @type {FunctionSymbol[]} */
            const all = [];
            walk(fn, new Set([fn]), all);
            for (const f of all)
            {
                f.usedGlobals.forEach(g=>used.add(g));
            }
            return globals.filter(g=>used.has(g));
        },
        evaluateConstant,
    };

    for (const d of program.decls)
    {
        limit = seq;
        recover(()=>{
            switch (d.kind)
            {
                case 'struct': {
                    if (structs.has(d.name))
                    {
                        fail('X3003', `redefinition of '${d.name}'`, d.pos);
                    }
                    const names = new Set();
                    // What a structure extends comes first; a member of its own of the same
                    // name hides the inherited one.
                    const inherited = d.base === null ? []
                        : /** @type {any} */ (structs.get(d.base))?.members
                        ?? fail('X3000', `syntax error: unexpected token '${d.base}'`, d.pos);
                    const members = d.members.map(m=>{
                        if (names.has(m.name))
                        {
                            fail('X3003', `redefinition of '${m.name}'`, m.pos);
                        }
                        names.add(m.name);
                        return { name: m.name, type: memberType(m), semantic: m.semantic };
                    });
                    structs.set(d.name, structOf(d.name, [...inherited, ...members]));
                    break;
                }
                case 'typedef':
                    typedefs.set(d.name, declaredType(d.type, d.dims).type);
                    break;
                case 'var':
                    declareGlobal(d);
                    break;
                case 'cbuffer':
                    for (const m of d.members)
                    {
                        limit = seq;
                        recover(()=>declareGlobal(m));
                    }
                    break;
                case 'function':
                    declareFunction(d);
                    break;
                case 'technique':
                    techniques.push(d);
                    break;
                default:
                    break;
            }
        });
    }
    limit = Infinity;

    if (options.entry !== undefined)
    {
        const entries = functions.get(options.entry) ?? [];
        if (entries.length === 0)
        {
            diagnostics.push({ code: 'X3501', severity: 'error', message:
                `'${options.entry}': entrypoint not found`, pos: program.decls[0]?.pos
                ?? noPos });
        }
        queue.push(...entries);
    }
    else
    {
        for (const list of functions.values())
        {
            queue.push(...list);
        }
        globals.forEach(ensureGlobal);
    }
    while (queue.length > 0)
    {
        checkFunction(/** @type {FunctionSymbol} */ (queue.shift()));
    }

    // A function that is called must be defined, and must not call itself.
    /** @type {Set<FunctionSymbol>} */
    const reported = new Set();
    for (const list of functions.values())
    {
        for (const fn of list)
        {
            if (!fn.checked)
            {
                continue;
            }
            /** @type {FunctionSymbol[]} */
            const callees = [];
            walk(fn, new Set(), callees);
            if (callees.includes(fn) && !reported.has(fn))
            {
                reported.add(fn);
                diagnostics.push({ code: 'X3500', severity: 'error', message:
                    `'${fn.name}': recursive functions are not allowed`, pos: fn.decl.pos });
            }
            for (const c of fn.calls)
            {
                if (!c.decl.body && !reported.has(c))
                {
                    reported.add(c);
                    diagnostics.push({ code: 'X3510', severity: 'error', message:
                        `'${c.name}': function is declared but never defined`,
                    pos: c.decl.pos });
                }
            }
        }
    }

    return { module, diagnostics };
}
