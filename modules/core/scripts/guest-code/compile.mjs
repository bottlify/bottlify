/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Compiles the functions a module marks `@guestCode` from JavaScript into
 * i386 code the guest runs itself: a runtime function that is pure -- no
 * state, no call into the host -- costs an instruction sequence in the
 * program's own translated code instead of a crossing into the host.
 *
 * The same source stays an ordinary JavaScript function, and both are held
 * to one meaning: the subset below is the part of JavaScript whose meaning
 * 32-bit integer and x87 code can reproduce exactly, and anything outside it
 * is refused with its place in the source rather than approximated.
 *
 *   /**
 *    * @guestCode cdecl
 *    * @param {Guest} guest @param {u32} left @param {u32} right @param {u32} count
 *    * @returns {i32}
 *    *\/
 *   export function strncmp({ u8 }, left, right, count){ ... }
 *
 * The tag names the calling convention (`cdecl` or `stdcall`); `@param` and
 * `@returns` give each value's machine type:
 *
 *   i32, u32  a 32-bit stack slot, signed or unsigned; EAX as a result
 *   f64       a double: two stack slots; ST0 as a result
 *   x87       a double the caller left on the x87 stack (the last such
 *             parameter in ST0), which the function pops, as `_ftol` does
 *   i64       a result in EDX:EAX: a double truncated toward zero (NaN and
 *             out of range the integer indefinite, as `fisttp` answers), or
 *             an integer extended by its sign
 *   void      no result
 *
 * A function that touches guest memory or calls a guest function takes the
 * helpers it uses from its first parameter, destructured: `{ u8, setU8 }`.
 * The loads are u8, i8, u16, i16, u32, i32, f32 and f64 (address); the
 * stores setU8, setU16, setU32 and setF64 (address, value); `call(fn, ...)`
 * calls a cdecl function pointer and answers its EAX as an i32; `copyUp`,
 * `copyDown` (dst, src, count) copy bytes ascending or descending, and
 * `fill` (dst, byte, count) sets them -- `rep movsd` and `rep stosd` for the
 * whole dwords, leaving the bytes as the byte forms do.
 *
 * Integers are typed as asm.js types them: `|0`, `>>>0` and the bitwise
 * operators bring a value back to 32 bits; `+` and `-` leave a sum that may
 * have left them (an address may take one, as may another sum, a bitwise
 * operator, a table's index or a store), and a comparison, a variable or a
 * result takes it only once it is brought back. A comparison is of two
 * signed or two unsigned values, never one of each; a byte, a 16-bit table
 * entry or a constant below 2^31 compares either way. `*` multiplies by a
 * constant; anything else is `Math.imul`. There is no division.
 *
 * `++`, `--`, `+=` and `-=` on an integer variable are 32-bit arithmetic:
 * for a counter bounded by a comparison, and a pointer, that is exactly what
 * JavaScript computes; a value that may wrap is written `x = (x + y) | 0`.
 *
 * Doubles are loaded, stored, compared, rounded to an integral double by
 * `Math.floor`, `Math.ceil` and `Math.trunc` (the x87's rounding control set
 * around `frndint` and put back, its precision control never touched) and
 * returned; integers become doubles exactly, by `+x` or where a double is
 * wanted. There is no double arithmetic: under a program's single-precision
 * control word the x87 would not compute what JavaScript does.
 *
 * A module-level constant is folded in. A module-level `Uint8Array`,
 * `Int8Array`, `Uint16Array`, `Int16Array`, `Uint32Array` or `Int32Array`
 * the module exports is a table: its contents when the module is imported
 * are placed after the code and read by index, the index the source's to
 * keep in range. A module-level function of one `return` is inlined, its
 * arguments evaluated once each, in order.
 */

import * as espree from 'espree';
import {
    ALU, Assembler, CC, EAX, EBX, ECX, EDI, ESI, ESP, fitsByte, frame, invert, le32, memory,
} from './x86.mjs';

/**
 * @typedef {'i32' | 'u32' | 'nat' | 'intish' | 'f64'} Type
 *   nat: an integer the source can see only in [0, 2^31) -- a byte, a 16-bit
 *   table entry, a small constant -- which compares as signed or unsigned
 *   alike; intish: a sum not yet brought back to 32 bits
 */

/** @typedef {'i32' | 'u32' | 'f64' | 'x87'} ParamType */
/** @typedef {'i32' | 'u32' | 'f64' | 'i64' | 'void'} ReturnType */

/**
 * @typedef {Object} CompiledFunction
 * @property {string} name
 * @property {'cdecl' | 'stdcall'} convention
 * @property {ParamType[]} params   Excluding the guest's helpers.
 * @property {ReturnType} returns
 * @property {string[]} uses        The helpers the first parameter takes, in order.
 * @property {Uint8Array} code
 */

/**
 * @typedef {Object} Variable
 * @property {string} name
 * @property {'i32' | 'u32' | 'nat' | 'f64'} type
 * @property {number} disp     From EBP.
 * @property {boolean} mutable
 */

/**
 * @typedef {{ where: 'imm', type: Type, value: number }
 *     | { where: 'var', type: Type, v: Variable }
 *     | { where: 'eax', type: Type }
 *     | { where: 'st0', type: 'f64' }} Value
 *   imm and var are not yet emitted: an operand the instruction using it
 *   names directly
 */

/**
 * @typedef {Object} TableInfo
 * @property {string} name
 * @property {Uint8Array} bytes
 * @property {1 | 2 | 4} size
 * @property {boolean} signed
 */

export class GuestCodeError extends Error {
    /** @param {string} message */
    constructor(message){
        super(message);
        this.name = 'GuestCodeError';
    }
}

/** The loads, by helper name: the opcode and what the value is. */
const LOADS = /** @type {Record<string, { op: number[], type: Type }>} */ ({
    u8: { op: [0x0f, 0xb6], type: 'nat' },
    i8: { op: [0x0f, 0xbe], type: 'i32' },
    u16: { op: [0x0f, 0xb7], type: 'nat' },
    i16: { op: [0x0f, 0xbf], type: 'i32' },
    u32: { op: [0x8b], type: 'u32' },
    i32: { op: [0x8b], type: 'i32' },
    f32: { op: [0xd9], type: 'f64' },
    f64: { op: [0xdd], type: 'f64' },
});

/** The stores: the opcode, `mov [m], al/ax/eax` or `fstp qword [m]`. */
const STORES = /** @type {Record<string, number[]>} */ ({
    setU8: [0x88],
    setU16: [0x66, 0x89],
    setU32: [0x89],
    setF64: [0xdd],
});

const HELPERS = new Set([...Object.keys(LOADS), ...Object.keys(STORES),
    'call', 'copyUp', 'copyDown', 'fill']);

const TABLE_KINDS = /** @type {const} */ ([
    ['Uint8Array', 1, false], ['Int8Array', 1, true], ['Uint16Array', 2, false],
    ['Int16Array', 2, true], ['Uint32Array', 4, false], ['Int32Array', 4, true],
]);

const PARAM_TYPES = new Set(['i32', 'u32', 'f64', 'x87']);
const RETURN_TYPES = new Set(['i32', 'u32', 'f64', 'i64', 'void']);

/** Rounding control for Math.floor, Math.ceil and Math.trunc, in the control word's high byte. */
const ROUNDING = /** @type {Record<string, number>} */ ({ floor: 0x04, ceil: 0x08, trunc: 0x0c });

/** How many x87 registers an expression may hold at once. */
const X87_DEPTH = 7;

/** @param {number} value @returns {Type} */
function constType(value){
    if (!Number.isInteger(value) || Object.is(value, -0))
    {
        return 'f64';
    }
    if (value >= 0 && value < 2 ** 31)
    {
        return 'nat';
    }
    if (value < 0 && value >= -(2 ** 31))
    {
        return 'i32';
    }
    if (value >= 2 ** 31 && value < 2 ** 32)
    {
        return 'u32';
    }
    return Math.abs(value) < 2 ** 53 ? 'intish' : 'f64';
}

/** Brought back to 32 bits. @param {Type} type */
const isTyped = type=>type === 'i32' || type === 'u32' || type === 'nat';

/**
 * The module's view the compiler needs: what each top-level name is.
 *
 * @typedef {Object} ModuleScope
 * @property {string} file
 * @property {string} text
 * @property {Map<string, number>} constants
 * @property {Map<string, TableInfo>} tables
 * @property {Map<string, any>} inline     name → a function node of one return
 * @property {Map<string, any>} declared   name → its declarator's init, for folding
 * @property {any[]} comments
 */

/**
 * Compiles every `@guestCode` function of a module.
 *
 * @param {string} text  The module's source.
 * @param {{ file: string, values?: Record<string, unknown> }} options
 *     file: named in errors; values: the module's exports as importing it
 *     gives them, where a table's contents come from
 * @returns {CompiledFunction[]}
 */
export function compileModule(text, { file, values = {} }){
    /** @type {any} */
    let ast;
    try
    {
        ast = espree.parse(text, {
            ecmaVersion: 2022, sourceType: 'module', loc: true, range: true, comment: true,
        });
    }
    catch (e){
        const error = /** @type {any} */ (e);
        throw new GuestCodeError(`${file}:${error.lineNumber}:${error.column}: ${error.message}`);
    }
    /** @type {ModuleScope} */
    const scope = {
        file, text, constants: new Map(), tables: new Map(), inline: new Map(),
        declared: new Map(), comments: ast.comments,
    };
    /** @type {{ node: any, doc: string }[]} */
    const marked = [];
    for (const statement of ast.body)
    {
        const node = statement.type === 'ExportNamedDeclaration' && statement.declaration
            ? statement.declaration : statement;
        if (node.type === 'VariableDeclaration' && node.kind === 'const')
        {
            for (const declarator of node.declarations)
            {
                if (declarator.id.type !== 'Identifier' || !declarator.init)
                {
                    continue;
                }
                const name = declarator.id.name;
                scope.declared.set(name, declarator.init);
                const init = declarator.init;
                if (init.type === 'ArrowFunctionExpression' && oneReturn(init))
                {
                    scope.inline.set(name, init);
                }
            }
        }
        else if (node.type === 'FunctionDeclaration' && node.id)
        {
            const doc = leadingDoc(scope, statement);
            if (/@guestCode\b/.test(doc))
            {
                marked.push({ node, doc });
            }
            else if (oneReturn(node))
            {
                scope.inline.set(node.id.name, node);
            }
        }
    }
    for (const [name, value] of Object.entries(values))
    {
        const kind = TABLE_KINDS.find(([constructor])=>
            value instanceof /** @type {any} */ (globalThis)[constructor]);
        if (kind && scope.declared.has(name))
        {
            const array = /** @type {ArrayLike<number>} */ (value);
            const [, size, signed] = kind;
            const bytes = new Uint8Array(array.length * size);
            const view = new DataView(bytes.buffer);
            for (let i = 0; i < array.length; i++)
            {
                if (size === 1)
                {
                    view.setUint8(i, array[i] & 0xff);
                }
                else if (size === 2)
                {
                    view.setUint16(i * 2, array[i] & 0xffff, true);
                }
                else
                {
                    view.setUint32(i * 4, array[i] >>> 0, true);
                }
            }
            scope.tables.set(name, { name, bytes, size, signed });
        }
    }
    return marked.map(({ node, doc })=>new FunctionCompiler(scope, node, doc).compile());
}

/** A function whose body is a single `return` of an expression, or an expression arrow. @param {any} node */
function oneReturn(node){
    if (node.type === 'ArrowFunctionExpression' && node.expression)
    {
        return true;
    }
    const body = node.body?.body;
    return Array.isArray(body) && body.length === 1 && body[0].type === 'ReturnStatement'
        && body[0].argument !== null;
}

/**
 * The block comment right before a node, with nothing but white space
 * between, or ''.
 *
 * @param {ModuleScope} scope @param {any} node
 */
function leadingDoc(scope, node){
    const before = scope.comments.filter(comment=>comment.type === 'Block'
        && comment.range[1] <= node.range[0]).pop();
    if (!before || scope.text.slice(before.range[1], node.range[0]).trim() !== '')
    {
        return '';
    }
    return before.value;
}

/**
 * @param {ModuleScope} scope @param {any} node @param {string} message
 * @returns {never}
 */
function fail(scope, node, message){
    const where = node?.loc?.start;
    throw new GuestCodeError(where
        ? `${scope.file}:${where.line}:${where.column + 1}: ${message}`
        : `${scope.file}: ${message}`);
}

class FunctionCompiler {
    /** @param {ModuleScope} scope @param {any} node @param {string} doc */
    constructor(scope, node, doc){
        this.scope = scope;
        this.node = node;
        this.doc = doc;
        this.a = new Assembler();
        /** @type {Map<string, Variable | { constant: number }>[]} */
        this.scopes = [new Map()];
        this.locals = 0;
        /** @type {Set<number>} */
        this.saves = new Set();
        this.fpu = 0;
        /** @type {{ breakTo: string, continueTo: string }[]} */
        this.loops = [];
        /** @type {Map<string, TableInfo>} */
        this.tables = new Map();
        /** @type {Set<string>} */
        this.helpers = new Set();
        /** @type {ReturnType} */
        this.returns = 'void';
        this.epilogue = this.a.fresh('epilogue');
        this.inlining = 0;
    }

    /** @param {any} node @param {string} message @returns {never} */
    fail(node, message){
        return fail(this.scope, node, message);
    }

    /** @returns {CompiledFunction} */
    compile(){
        const { node, doc } = this;
        const name = node.id.name;
        const convention = /@guestCode\s+(cdecl|stdcall)\b/.exec(doc)?.[1];
        if (convention !== 'cdecl' && convention !== 'stdcall')
        {
            this.fail(node, `${name}: @guestCode names its convention, cdecl or stdcall`);
        }
        if (node.async || node.generator)
        {
            this.fail(node, `${name}: not an async function or a generator`);
        }
        /** @type {Map<string, string>} */
        const declared = new Map();
        for (const [, type, param] of doc.matchAll(/@param\s+\{(\w+)\}\s+(\w+)/g))
        {
            declared.set(param, type);
        }
        const returned = /@returns?\s+\{(\w+)\}/.exec(doc)?.[1] ?? 'void';
        if (!RETURN_TYPES.has(returned))
        {
            this.fail(node, `${name}: @returns {${returned}} is not i32, u32, f64, i64 or void`);
        }
        this.returns = /** @type {ReturnType} */ (returned);

        const params = [...node.params];
        /** @type {string[]} */
        const uses = [];
        if (params[0]?.type === 'ObjectPattern')
        {
            for (const property of params[0].properties)
            {
                if (property.type !== 'Property' || !property.shorthand
                    || property.key.type !== 'Identifier' || !HELPERS.has(property.key.name))
                {
                    this.fail(property, `the guest's helpers are ${[...HELPERS].join(', ')}, `
                        + 'taken by name');
                }
                uses.push(property.key.name);
                this.helpers.add(property.key.name);
            }
            params.shift();
        }
        /** @type {ParamType[]} */
        const types = [];
        /** @type {Variable[]} */
        const x87 = [];
        let stack = 8;
        for (const param of params)
        {
            if (param.type !== 'Identifier')
            {
                this.fail(param, 'a parameter is a name');
            }
            const type = declared.get(param.name);
            if (type === undefined || !PARAM_TYPES.has(type))
            {
                this.fail(param, `@param {i32 | u32 | f64 | x87} ${param.name} is wanted`);
            }
            types.push(/** @type {ParamType} */ (type));
            if (type === 'x87')
            {
                const v = this.declare(param, param.name, 'f64', true);
                x87.push(v);
                continue;
            }
            this.bind(param, { name: param.name, type: /** @type {'i32' | 'u32' | 'f64'} */ (type),
                disp: stack, mutable: true });
            stack += type === 'f64' ? 8 : 4;
        }

        this.statements(node.body.body);
        if (this.returns !== 'void' && !ends(node.body))
        {
            this.fail(node.body, `${name} can reach its end without a return`);
        }
        const last = this.a.items[this.a.items.length - 1];
        if (last?.kind === 'jump' && last.cc < 0 && last.to === this.epilogue)
        {
            this.a.items.pop();
        }

        const out = new Assembler();
        out.emit(0x55, 0x89, 0xe5);                          // push ebp; mov ebp, esp
        if (this.tables.size > 0)
        {
            this.saves.add(EBX);
        }
        const saved = [EBX, ESI, EDI].filter(reg=>this.saves.has(reg));
        if (this.locals > 0)
        {
            out.emit(...fitsByte(this.locals)
                ? [0x83, 0xec, this.locals] : [0x81, 0xec, ...le32(this.locals)]);
        }
        for (const reg of saved)
        {
            out.emit(0x50 | reg);
        }
        if (this.tables.size > 0)
        {
            // The address of the pop, which every table is reached from.
            out.emit(0xe8, 0, 0, 0, 0).label('picBase').emit(0x5b);
        }
        // The last x87 parameter is ST0: each popped into its variable.
        for (const v of [...x87].reverse())
        {
            out.emit(0xdd, ...frame(3, v.disp));
        }
        out.append(this.a);
        out.label(this.epilogue);
        if (saved.length > 0)
        {
            const below = -(this.locals + saved.length * 4);
            out.emit(0x8d, ...frame(ESP, below));             // lea esp, [ebp - ...]
            for (const reg of [...saved].reverse())
            {
                out.emit(0x58 | reg);
            }
        }
        out.emit(0xc9);                                       // leave
        const argBytes = stack - 8;
        if (convention === 'stdcall' && argBytes > 0)
        {
            out.emit(0xc2, argBytes & 0xff, argBytes >>> 8);  // ret argBytes
        }
        else
        {
            out.emit(0xc3);
        }
        const tables = [...this.tables.values()].map(table=>({
            name: table.name, bytes: table.bytes, align: table.size,
        }));
        return {
            name, convention, params: types, returns: this.returns, uses,
            code: out.finish(tables),
        };
    }

    // --- names -----------------------------------------------------------

    /** @param {any} node @param {Variable | { constant: number }} what */
    bind(node, what){
        if (this.lookupLocal(node.name) !== undefined)
        {
            this.fail(node, `${node.name} is declared twice`);
        }
        this.scopes[this.scopes.length - 1].set(node.name, what);
    }

    /**
     * A variable in the frame.
     *
     * @param {any} node @param {string} name @param {Variable['type']} type
     * @param {boolean} mutable
     */
    declare(node, name, type, mutable){
        const size = type === 'f64' ? 8 : 4;
        this.locals = Math.ceil((this.locals + size) / size) * size;
        /** @type {Variable} */
        const v = { name, type, disp: -this.locals, mutable };
        const top = this.scopes[this.scopes.length - 1];
        if (this.lookupLocal(name) !== undefined)
        {
            this.fail(node, `${name} is declared twice`);
        }
        top.set(name, v);
        return v;
    }

    /** @param {string} name */
    lookupLocal(name){
        for (let i = this.scopes.length - 1; i >= 0; i--)
        {
            const found = this.scopes[i].get(name);
            if (found !== undefined)
            {
                return found;
            }
        }
        return undefined;
    }

    /**
     * A module-level constant's value, folded from its declaration.
     *
     * @param {string} name @param {Set<string>} [seen]
     * @returns {number | undefined}
     */
    moduleConstant(name, seen = new Set()){
        if (this.scope.constants.has(name))
        {
            return this.scope.constants.get(name);
        }
        const init = this.scope.declared.get(name);
        if (init === undefined || seen.has(name))
        {
            return undefined;
        }
        seen.add(name);
        const value = this.fold(init, seen);
        if (value !== undefined)
        {
            this.scope.constants.set(name, value);
        }
        return value;
    }

    /**
     * A constant expression's value, or undefined when it is not one.
     *
     * @param {any} node @param {Set<string>} [seen]
     * @returns {number | undefined}
     */
    fold(node, seen = new Set()){
        switch (node.type)
        {
            case 'Literal':
                return typeof node.value === 'number' ? node.value : undefined;
            case 'Identifier':
            {
                const local = this.lookupLocal(node.name);
                if (local !== undefined)
                {
                    return 'constant' in local ? local.constant : undefined;
                }
                return this.moduleConstant(node.name, seen);
            }
            case 'UnaryExpression':
            {
                const value = this.fold(node.argument, seen);
                if (value === undefined)
                {
                    return undefined;
                }
                switch (node.operator)
                {
                    case '-': return -value;
                    case '+': return value;
                    case '~': return ~value;
                    default: return undefined;
                }
            }
            case 'BinaryExpression':
            {
                const left = this.fold(node.left, seen);
                const right = left === undefined ? undefined : this.fold(node.right, seen);
                if (left === undefined || right === undefined)
                {
                    return undefined;
                }
                switch (node.operator)
                {
                    case '+': return left + right;
                    case '-': return left - right;
                    case '*': return left * right;
                    case '|': return left | right;
                    case '&': return left & right;
                    case '^': return left ^ right;
                    case '<<': return left << right;
                    case '>>': return left >> right;
                    case '>>>': return left >>> right;
                    default: return undefined;
                }
            }
            default:
                return undefined;
        }
    }

    // --- statements ------------------------------------------------------

    /** @param {any[]} list */
    statements(list){
        for (const statement of list)
        {
            this.statement(statement);
        }
    }

    /** @param {any} node */
    statement(node){
        const a = this.a;
        switch (node.type)
        {
            case 'EmptyStatement':
                return;
            case 'BlockStatement':
                this.scopes.push(new Map());
                this.statements(node.body);
                this.scopes.pop();
                return;
            case 'VariableDeclaration':
                this.variables(node);
                return;
            case 'ExpressionStatement':
                this.effect(node.expression);
                return;
            case 'ReturnStatement':
                this.returnStatement(node);
                return;
            case 'IfStatement':
            {
                const only = node.alternate ? null : this.jumpOnly(node.consequent);
                if (only !== null)
                {
                    // `if (c) break;` and its kin: one conditional jump, not
                    // a jump around a jump.
                    this.branch(node.test, only, true);
                    return;
                }
                const otherwise = a.fresh('else');
                this.branch(node.test, otherwise, false);
                this.statement(node.consequent);
                if (node.alternate)
                {
                    const end = a.fresh('endif');
                    if (!ends(node.consequent))
                    {
                        a.jump(-1, end);
                    }
                    a.label(otherwise);
                    this.statement(node.alternate);
                    a.label(end);
                }
                else
                {
                    a.label(otherwise);
                }
                return;
            }
            case 'WhileStatement':
            case 'DoWhileStatement':
            case 'ForStatement':
                this.loop(node);
                return;
            case 'BreakStatement':
            case 'ContinueStatement':
            {
                if (node.label)
                {
                    this.fail(node, 'a labelled jump is not in the subset');
                }
                const loop = this.loops[this.loops.length - 1];
                if (!loop)
                {
                    this.fail(node, `${node.type === 'BreakStatement' ? 'break' : 'continue'} `
                        + 'outside a loop');
                }
                a.jump(-1, node.type === 'BreakStatement' ? loop.breakTo : loop.continueTo);
                return;
            }
            default:
                this.fail(node, `${describe(node)} is not in the subset`);
        }
    }

    /**
     * Where a statement that is nothing but a jump goes: a `break`, a
     * `continue`, or a void function's `return`; null for anything else.
     *
     * @param {any} node @returns {string | null}
     */
    jumpOnly(node){
        const statement = node.type === 'BlockStatement' && node.body.length === 1
            ? node.body[0] : node;
        const loop = this.loops[this.loops.length - 1];
        if (loop && !statement.label && statement.type === 'BreakStatement')
        {
            return loop.breakTo;
        }
        if (loop && !statement.label && statement.type === 'ContinueStatement')
        {
            return loop.continueTo;
        }
        if (statement.type === 'ReturnStatement' && !statement.argument
            && this.returns === 'void' && this.fpu === 0 && this.inlining === 0)
        {
            return this.epilogue;
        }
        return null;
    }

    /** @param {any} node */
    loop(node){
        const a = this.a;
        const top = a.fresh('loop');
        const test = a.fresh('test');
        const next = a.fresh('next');
        const end = a.fresh('end');
        this.scopes.push(new Map());
        if (node.type === 'ForStatement' && node.init)
        {
            if (node.init.type === 'VariableDeclaration')
            {
                this.variables(node.init);
            }
            else
            {
                this.effect(node.init);
            }
        }
        const always = !node.test || node.test.type === 'Literal' && node.test.value === true;
        if (node.type !== 'DoWhileStatement' && !always)
        {
            a.jump(-1, test);
        }
        a.label(top);
        this.loops.push({ breakTo: end, continueTo: next });
        this.statement(node.body);
        this.loops.pop();
        a.label(next);
        if (node.type === 'ForStatement' && node.update)
        {
            this.effect(node.update);
        }
        a.label(test);
        if (always)
        {
            a.jump(-1, top);
        }
        else
        {
            this.branch(node.test, top, true);
        }
        a.label(end);
        this.scopes.pop();
    }

    /** @param {any} node */
    variables(node){
        if (node.kind !== 'let' && node.kind !== 'const')
        {
            this.fail(node, 'a variable is let or const');
        }
        const annotated = /@type\s+\{(\w+)\}/.exec(leadingDoc(this.scope, node))?.[1];
        if (annotated !== undefined && !['i32', 'u32', 'f64'].includes(annotated))
        {
            this.fail(node, `@type {${annotated}}: a variable is i32, u32 or f64`);
        }
        for (const declarator of node.declarations)
        {
            if (declarator.id.type !== 'Identifier')
            {
                this.fail(declarator.id, 'a variable is a name');
            }
            if (!declarator.init)
            {
                this.fail(declarator, `${declarator.id.name} is given a value where it is `
                    + 'declared');
            }
            const name = declarator.id.name;
            const constant = node.kind === 'const' && annotated === undefined
                ? this.fold(declarator.init) : undefined;
            if (constant !== undefined)
            {
                this.bind(declarator.id, { constant });
                continue;
            }
            const value = this.expr(declarator.init);
            /** @type {Variable['type']} */
            let type;
            if (annotated !== undefined)
            {
                type = /** @type {'i32' | 'u32' | 'f64'} */ (annotated);
            }
            else if (value.type === 'f64')
            {
                type = 'f64';
            }
            else if (value.type === 'intish')
            {
                this.fail(declarator.init, `${name} is given a sum: bring it back to 32 bits `
                    + 'with | 0 or >>> 0');
            }
            else if (value.type === 'nat')
            {
                type = node.kind === 'const' ? 'nat' : 'i32';
            }
            else
            {
                type = value.type;
            }
            const v = this.declare(declarator.id, name, type, node.kind === 'let');
            this.store(v, value, declarator.init);
        }
    }

    /**
     * Writes a value into a variable of its type.
     *
     * @param {Variable} v @param {Value} value @param {any} node
     */
    store(v, value, node){
        if (v.type === 'f64')
        {
            this.toSt0(value, node);
            this.a.emit(0xdd, ...frame(3, v.disp));        // fstp qword [v]
            this.fpu--;
            return;
        }
        this.assignable(v, value.type, node);
        if (value.where === 'imm')
        {
            this.a.emit(0xc7, ...frame(0, v.disp), ...le32(value.value));
            return;
        }
        this.toEax(value, node);
        this.a.emit(0x89, ...frame(EAX, v.disp));
    }

    /** @param {Variable} v @param {Type} type @param {any} node */
    assignable(v, type, node){
        const fits = type === v.type || type === 'nat' && v.type !== 'f64'
            || v.type === 'f64' && isTyped(type);
        if (!fits)
        {
            this.fail(node, type === 'intish'
                ? `${v.name} is given a sum: bring it back to 32 bits with | 0 or >>> 0`
                : `${v.name} is ${v.type}, and this is ${type}`);
        }
    }

    /** An expression evaluated for what it does. @param {any} node */
    effect(node){
        const a = this.a;
        switch (node.type)
        {
            case 'AssignmentExpression':
            {
                const v = this.variable(node.left);
                if (node.operator === '=')
                {
                    this.store(v, this.expr(node.right), node.right);
                    return;
                }
                if (v.type === 'f64')
                {
                    this.fail(node, 'there is no double arithmetic in the subset');
                }
                const op = node.operator.slice(0, -1);
                const result = { '+': 'same', '-': 'same', '|': 'i32', '&': 'i32', '^': 'i32',
                    '<<': 'i32', '>>': 'i32', '>>>': 'u32' }[op];
                if (result === undefined)
                {
                    this.fail(node, `${node.operator} is not in the subset`);
                }
                if (result !== 'same' && result !== v.type)
                {
                    this.fail(node, `${node.operator} makes an ${result} of ${v.name}, `
                        + `an ${v.type}`);
                }
                const value = this.expr(node.right);
                this.integer(value, node.right, op === '+' || op === '-' ? 'intish' : 'any');
                const shift = { '<<': 4, '>>': 7, '>>>': 5 }[op];
                if (shift !== undefined)
                {
                    if (value.where === 'imm')
                    {
                        a.emit(0xc1, ...frame(shift, v.disp), value.value & 31);
                        return;
                    }
                    this.toEax(value, node.right);
                    a.emit(0x89, 0xc1);                           // mov ecx, eax
                    a.emit(0xd3, ...frame(shift, v.disp));        // shl/sar/shr [v], cl
                    return;
                }
                const alu = { '+': ALU.add, '-': ALU.sub, '|': ALU.or, '&': ALU.and,
                    '^': ALU.xor }[/** @type {'+'} */ (op)];
                if (value.where === 'imm')
                {
                    const imm = value.value | 0;
                    a.emit(...fitsByte(imm) ? [0x83, ...frame(alu, v.disp), imm & 0xff]
                        : [0x81, ...frame(alu, v.disp), ...le32(imm)]);
                    return;
                }
                this.toEax(value, node.right);
                a.emit(alu << 3 | 1, ...frame(EAX, v.disp));      // op [v], eax
                return;
            }
            case 'UpdateExpression':
            {
                const v = this.variable(node.argument);
                if (v.type === 'f64')
                {
                    this.fail(node, 'there is no double arithmetic in the subset');
                }
                a.emit(0xff, ...frame(node.operator === '++' ? 0 : 1, v.disp));
                return;
            }
            case 'CallExpression':
            {
                const name = node.callee.type === 'Identifier' ? node.callee.name : '';
                if (Object.hasOwn(STORES, name) && this.helpers.has(name))
                {
                    this.storeCall(node, name);
                    return;
                }
                if ((name === 'copyUp' || name === 'copyDown' || name === 'fill')
                    && this.helpers.has(name))
                {
                    this.bulk(node, name);
                    return;
                }
                if (name === 'call' && this.helpers.has(name))
                {
                    this.guestCall(node);
                    return;
                }
                return this.fail(node, 'a call made for what it does is a store, a copy, a '
                    + 'fill or call()');
            }
            default:
                this.fail(node, `${describe(node)} as a statement is not in the subset`);
        }
    }

    /** @param {any} node @returns {Variable} */
    variable(node){
        if (node.type !== 'Identifier')
        {
            this.fail(node, 'only a variable is assigned');
        }
        const v = this.lookupLocal(node.name);
        if (v === undefined || 'constant' in v)
        {
            this.fail(node, `${node.name} is not a variable of this function`);
        }
        if (!v.mutable)
        {
            this.fail(node, `${node.name} is a const`);
        }
        return v;
    }

    /** @param {any} node */
    returnStatement(node){
        const returns = this.returns;
        if (this.inlining > 0)
        {
            this.fail(node, 'an inlined function returns only by its one return');
        }
        if (returns === 'void')
        {
            if (node.argument)
            {
                this.fail(node, 'a void function returns nothing');
            }
        }
        else
        {
            if (!node.argument)
            {
                this.fail(node, `the function returns an ${returns}`);
            }
            const value = this.expr(node.argument);
            if (returns === 'f64')
            {
                this.toSt0(value, node.argument);
                this.fpu--;
            }
            else if (returns === 'i64' && value.type === 'f64')
            {
                this.toSt0(value, node.argument);
                this.fpu--;
                // fisttp qword [esp]: truncated whatever the rounding control says.
                this.a.emit(0x83, 0xec, 0x08, 0xdd, 0x0c, 0x24, 0x58, 0x5a);
            }
            else
            {
                if (!isTyped(value.type))
                {
                    this.fail(node.argument, value.type === 'intish'
                        ? 'a sum is returned once it is brought back to 32 bits'
                        : `the function returns an ${returns}, not an ${value.type}`);
                }
                if (returns === 'u32' && value.type === 'i32'
                    || returns === 'i32' && value.type === 'u32')
                {
                    this.fail(node.argument, `the function returns an ${returns}, and this `
                        + `is an ${value.type}`);
                }
                this.toEax(value, node.argument);
                if (returns === 'i64')
                {
                    this.a.emit(...value.type === 'u32' ? [0x31, 0xd2] : [0x99]); // xor edx / cdq
                }
            }
        }
        if (this.fpu !== 0)
        {
            this.fail(node, 'the x87 stack is not empty at a return');
        }
        this.a.jump(-1, this.epilogue);
    }

    // --- conditions ------------------------------------------------------

    /**
     * Jumps to `target` when the condition is `when`, and falls through
     * otherwise.
     *
     * @param {any} node @param {string} target @param {boolean} when
     */
    branch(node, target, when){
        const a = this.a;
        if (node.type === 'LogicalExpression' && (node.operator === '&&' || node.operator === '||'))
        {
            const and = node.operator === '&&';
            if (and !== when)
            {
                // a && b false: either is; a || b true: either is.
                this.branch(node.left, target, when);
                this.branch(node.right, target, when);
                return;
            }
            const skip = a.fresh('skip');
            this.branch(node.left, skip, !when);
            this.branch(node.right, target, when);
            a.label(skip);
            return;
        }
        if (node.type === 'UnaryExpression' && node.operator === '!')
        {
            this.branch(node.argument, target, !when);
            return;
        }
        if (node.type === 'Literal' && typeof node.value === 'boolean')
        {
            if (node.value === when)
            {
                a.jump(-1, target);
            }
            return;
        }
        if (node.type === 'BinaryExpression'
            && ['<', '<=', '>', '>=', '===', '!=='].includes(node.operator))
        {
            this.compare(node, target, when);
            return;
        }
        if (node.type === 'BinaryExpression' && (node.operator === '==' || node.operator === '!='))
        {
            this.fail(node, `${node.operator} is written ${node.operator}=`);
        }
        const value = this.expr(node);
        if (!isTyped(value.type))
        {
            this.fail(node, value.type === 'f64'
                ? 'a double is tested by a comparison'
                : 'a sum is tested once it is brought back to 32 bits');
        }
        this.toEax(value, node);
        a.emit(0x85, 0xc0);                                        // test eax, eax
        a.jump(when ? CC.ne : CC.e, target);
    }

    /** @param {any} node @param {string} target @param {boolean} when */
    compare(node, target, when){
        const a = this.a;
        const op = node.operator;
        const leftType = this.peekType(node.left);
        const rightType = this.peekType(node.right);
        if (leftType === 'f64' || rightType === 'f64')
        {
            this.toSt0(this.expr(node.left), node.left);
            this.toSt0(this.expr(node.right), node.right);
            // ST0 the right, ST1 the left; fucomip compares ST0 with ST1, so
            // `>` and `>=` exchange them first and every test is `a`/`ae`,
            // which an unordered comparison (CF set) fails.
            if (op === '>' || op === '>=')
            {
                a.emit(0xd9, 0xc9);                                // fxch st1
            }
            a.emit(0xdf, 0xe9, 0xdd, 0xd8);                        // fucomip st1; fstp st0
            this.fpu -= 2;
            if (op === '===' || op === '!==')
            {
                // Equal is ZF set with PF clear; unordered sets both.
                if (op === '===' === when)
                {
                    const skip = a.fresh('unordered');
                    a.jump(CC.p, skip);
                    a.jump(CC.e, target);
                    a.label(skip);
                }
                else
                {
                    a.jump(CC.ne, target);
                    a.jump(CC.p, target);
                }
                return;
            }
            const cc = op === '<' || op === '>' ? CC.a : CC.ae;
            a.jump(when ? cc : invert(cc), target);
            return;
        }
        const signed = this.signedness(node, leftType, rightType);
        const operand = this.pair(node.left, node.right);
        this.alu(ALU.cmp, operand);
        /** @type {Record<string, number>} */
        const codes = signed
            ? { '<': CC.l, '<=': CC.le, '>': CC.g, '>=': CC.ge, '===': CC.e, '!==': CC.ne }
            : { '<': CC.b, '<=': CC.be, '>': CC.a, '>=': CC.ae, '===': CC.e, '!==': CC.ne };
        const cc = codes[op];
        a.jump(when ? cc : invert(cc), target);
    }

    /**
     * Whether two integers compare signed: both the same signedness, or a
     * value either way beside one of them.
     *
     * @param {any} node @param {Type} left @param {Type} right
     */
    signedness(node, left, right){
        if (left === 'intish' || right === 'intish')
        {
            this.fail(node, 'a sum is compared once it is brought back to 32 bits (| 0 or >>> 0)');
        }
        if (left === 'i32' && right === 'u32' || left === 'u32' && right === 'i32')
        {
            this.fail(node, 'a signed value compared with an unsigned one: JavaScript compares '
                + 'their values, and no one x86 comparison does');
        }
        return left !== 'u32' && right !== 'u32';
    }

    // --- expressions -----------------------------------------------------

    /**
     * The type an expression has, without emitting it: what a comparison
     * needs before it chooses its instructions.
     *
     * @param {any} node @returns {Type}
     */
    peekType(node){
        const mark = this.a.items.length;
        const last = this.a.items[mark - 1];
        const lastLength = last?.kind === 'bytes' ? last.bytes.length : 0;
        const fpu = this.fpu;
        const labels = this.a.labels;
        const locals = this.locals;
        const tables = new Map(this.tables);
        const saves = new Set(this.saves);
        const scopes = this.scopes.map(scope=>new Map(scope));
        const value = this.expr(node);
        this.a.items.length = mark;
        if (last?.kind === 'bytes')
        {
            last.bytes.length = lastLength;
        }
        this.fpu = fpu;
        this.a.labels = labels;
        this.locals = locals;
        this.tables = tables;
        this.saves = saves;
        this.scopes = scopes;
        return value.type;
    }

    /**
     * An operand an instruction can name without code before it: a constant
     * or an integer variable.
     *
     * @param {any} node @returns {Value | null}
     */
    simple(node){
        const constant = this.fold(node);
        if (constant !== undefined)
        {
            return { where: 'imm', type: constType(constant), value: constant };
        }
        if (node.type === 'Identifier')
        {
            const v = this.lookupLocal(node.name);
            if (v !== undefined && !('constant' in v) && v.type !== 'f64')
            {
                return { where: 'var', type: v.type, v };
            }
        }
        return null;
    }

    /**
     * Emits the left operand into EAX and answers the right as an operand:
     * a constant or a variable as it is, anything else in ECX. JavaScript's
     * order holds: the left is read first unless it is a constant or a
     * variable, which nothing on the right can change. For an operation
     * that commutes, a left constant or variable is the operand as it is.
     *
     * @param {any} left @param {any} right @param {boolean} [commutes]
     * @returns {{ right: Value | { where: 'ecx', type: Type }, leftType: Type }}
     */
    pair(left, right, commutes = false){
        const a = this.a;
        const r = this.simple(right);
        if (r !== null)
        {
            const l = this.expr(left);
            this.integer(l, left, 'intish');
            this.integer(r, right, 'intish');
            this.toEax(l, left);
            return { right: r, leftType: l.type };
        }
        const l = this.simple(left);
        if (l !== null)
        {
            const value = this.expr(right);
            this.integer(value, right, 'intish');
            this.integer(l, left, 'intish');
            this.toEax(value, right);
            if (commutes)
            {
                return { right: l, leftType: value.type };
            }
            a.emit(0x89, 0xc1);                                        // mov ecx, eax
            this.toEax(l, left);
            return { right: { where: 'ecx', type: value.type }, leftType: l.type };
        }
        const lv = this.expr(left);
        this.integer(lv, left, 'intish');
        this.toEax(lv, left);
        a.emit(0x50);                                                  // push eax
        const rv = this.expr(right);
        this.integer(rv, right, 'intish');
        this.toEax(rv, right);
        a.emit(0x89, 0xc1, 0x58);                                      // mov ecx, eax; pop eax
        return { right: { where: 'ecx', type: rv.type }, leftType: lv.type };
    }

    /**
     * `op eax, operand`.
     *
     * @param {number} op @param {{ right: Value | { where: 'ecx', type: Type } }} pair
     */
    alu(op, { right }){
        const a = this.a;
        if (right.where === 'imm' && op === ALU.cmp && right.value === 0)
        {
            a.emit(0x85, 0xc0);                                        // test eax, eax
        }
        else if (right.where === 'imm')
        {
            const imm = right.value | 0;
            a.emit(...fitsByte(imm) ? [0x83, 0xc0 | op << 3, imm & 0xff]
                : [0x81, 0xc0 | op << 3, ...le32(imm)]);
        }
        else if (right.where === 'var')
        {
            a.emit(op << 3 | 3, ...frame(EAX, right.v.disp));
        }
        else
        {
            a.emit(op << 3 | 1, 0xc8);                                  // op eax, ecx
        }
    }

    /**
     * Holds a value to be an integer: brought back to 32 bits unless `allow`
     * is 'intish'.
     *
     * @param {Value} value @param {any} node @param {'intish' | 'typed' | 'any'} allow
     */
    integer(value, node, allow){
        if (value.type === 'f64')
        {
            this.fail(node, 'a double where an integer is wanted: there is no double arithmetic '
                + '(under a program\'s single-precision control word the x87 would not compute '
                + 'what JavaScript does), and a double becomes an integer only as an i64 result');
        }
        if (allow === 'typed' && value.type === 'intish')
        {
            this.fail(node, 'a sum is used here once it is brought back to 32 bits');
        }
    }

    /**
     * Brings a value into EAX.
     *
     * @param {Value} value @param {any} node
     */
    toEax(value, node){
        const a = this.a;
        if (value.type === 'f64')
        {
            this.fail(node, 'a double where an integer is wanted');
        }
        switch (value.where)
        {
            case 'imm':
                if (value.value === 0)
                {
                    a.emit(0x31, 0xc0);                                    // xor eax, eax
                }
                else
                {
                    a.emit(0xb8, ...le32(value.value));
                }
                return;
            case 'var':
                a.emit(0x8b, ...frame(EAX, value.v.disp));
                return;
            default:
                return;
        }
    }

    /**
     * Brings a value onto the x87 stack as a double: an integer converted
     * exactly.
     *
     * @param {Value} value @param {any} node
     */
    toSt0(value, node){
        const a = this.a;
        if (value.where === 'st0')
        {
            return;
        }
        if (++this.fpu > X87_DEPTH)
        {
            this.fail(node, 'the expression holds more doubles at once than the x87 has room for');
        }
        if (value.where === 'var' && value.type === 'f64')
        {
            a.emit(0xdd, ...frame(0, value.v.disp));                    // fld qword [v]
            return;
        }
        if (value.where === 'imm')
        {
            const bits = new DataView(new ArrayBuffer(8));
            bits.setFloat64(0, value.value, true);
            // push the two halves; fld qword [esp]; add esp, 8
            a.emit(0x68, ...le32(bits.getUint32(4, true)), 0x68, ...le32(bits.getUint32(0, true)));
            a.emit(0xdd, 0x04, 0x24, 0x83, 0xc4, 0x08);
            return;
        }
        if (value.type === 'intish')
        {
            this.fail(node, 'a sum becomes a double once it is brought back to 32 bits');
        }
        this.toEax(value, node);
        if (value.type === 'u32')
        {
            // push 0; push eax; fild qword [esp]; add esp, 8
            a.emit(0x6a, 0x00, 0x50, 0xdf, 0x2c, 0x24, 0x83, 0xc4, 0x08);
        }
        else
        {
            // push eax; fild dword [esp]; pop eax
            a.emit(0x50, 0xdb, 0x04, 0x24, 0x58);
        }
    }

    /**
     * Evaluates an expression: a constant or a variable is answered as an
     * operand, anything else emitted into EAX or onto the x87 stack.
     *
     * @param {any} node @returns {Value}
     */
    expr(node){
        const simple = this.simple(node);
        if (simple !== null)
        {
            return simple;
        }
        const a = this.a;
        switch (node.type)
        {
            case 'Identifier':
            {
                const v = this.lookupLocal(node.name);
                if (v !== undefined && !('constant' in v))
                {
                    return { where: 'var', type: v.type, v };
                }
                return this.fail(node, `${node.name} is not a variable, a constant or a `
                    + 'parameter here');
            }
            case 'Literal':
                return this.fail(node, typeof node.value === 'boolean'
                    ? 'a boolean is a condition, not a value: write c ? 1 : 0'
                    : `${JSON.stringify(node.value)} is not a number`);
            case 'UnaryExpression':
                return this.unary(node);
            case 'BinaryExpression':
                return this.binary(node);
            case 'LogicalExpression':
                return this.fail(node, `${node.operator} makes a condition, not a value: `
                    + 'write c ? 1 : 0');
            case 'ConditionalExpression':
            {
                const otherwise = a.fresh('else');
                const end = a.fresh('end');
                this.branch(node.test, otherwise, false);
                const yes = this.expr(node.consequent);
                const no = this.peekType(node.alternate);
                if (yes.type === 'f64' || no === 'f64')
                {
                    this.toSt0(yes, node.consequent);
                    this.fpu--;
                    a.jump(-1, end).label(otherwise);
                    this.toSt0(this.expr(node.alternate), node.alternate);
                    a.label(end);
                    return { where: 'st0', type: 'f64' };
                }
                const type = this.join(node, yes.type, no);
                this.toEax(yes, node.consequent);
                a.jump(-1, end).label(otherwise);
                this.toEax(this.expr(node.alternate), node.alternate);
                a.label(end);
                return { where: 'eax', type };
            }
            case 'CallExpression':
                return this.callExpression(node);
            case 'MemberExpression':
                return this.tableLoad(node);
            default:
                this.fail(node, `${describe(node)} is not in the subset`);
        }
    }

    /**
     * The one type both arms of a conditional have.
     *
     * @param {any} node @param {Type} yes @param {Type} no @returns {Type}
     */
    join(node, yes, no){
        if (!isTyped(yes) || !isTyped(no))
        {
            this.fail(node, 'each arm of a conditional is brought back to 32 bits');
        }
        if (yes === no)
        {
            return yes;
        }
        if (yes === 'nat' || no === 'nat')
        {
            return yes === 'nat' ? no : yes;
        }
        this.fail(node, `one arm is an ${yes} and the other an ${no}`);
    }

    /** @param {any} node @returns {Value} */
    unary(node){
        const a = this.a;
        switch (node.operator)
        {
            case '-':
            {
                const value = this.expr(node.argument);
                if (value.type === 'f64')
                {
                    this.toSt0(value, node.argument);
                    a.emit(0xd9, 0xe0);                                   // fchs
                    return { where: 'st0', type: 'f64' };
                }
                this.toEax(value, node.argument);
                a.emit(0xf7, 0xd8);                                        // neg eax
                return { where: 'eax', type: 'intish' };
            }
            case '~':
            {
                const value = this.expr(node.argument);
                this.integer(value, node.argument, 'intish');
                this.toEax(value, node.argument);
                a.emit(0xf7, 0xd0);                                        // not eax
                return { where: 'eax', type: 'i32' };
            }
            case '+':
            {
                const value = this.expr(node.argument);
                this.toSt0(value, node.argument);
                return { where: 'st0', type: 'f64' };
            }
            case '!':
                return this.fail(node, '! makes a condition, not a value: write c ? 0 : 1');
            default:
                this.fail(node, `unary ${node.operator} is not in the subset`);
        }
    }

    /** @param {any} node @returns {Value} */
    binary(node){
        const a = this.a;
        const op = node.operator;
        if (['<', '<=', '>', '>=', '===', '!==', '==', '!='].includes(op))
        {
            this.fail(node, 'a comparison is a condition, not a value: write c ? 1 : 0');
        }
        // x | 0 and x >>> 0 bring a value back and emit nothing.
        const zero = this.fold(node.right) === 0;
        if (zero && (op === '|' || op === '>>>'))
        {
            const value = this.expr(node.left);
            this.integer(value, node.left, 'intish');
            if (value.where === 'imm')
            {
                const folded = op === '|' ? value.value | 0 : value.value >>> 0;
                return { where: 'imm', type: constType(folded), value: folded };
            }
            this.toEax(value, node.left);
            return { where: 'eax', type: op === '|' ? 'i32' : 'u32' };
        }
        switch (op)
        {
            case '+':
            case '-':
            {
                const pair = this.pair(node.left, node.right, op === '+');
                this.alu(op === '+' ? ALU.add : ALU.sub, pair);
                return { where: 'eax', type: 'intish' };
            }
            case '&':
            case '|':
            case '^':
            {
                const pair = this.pair(node.left, node.right, true);
                this.alu(op === '&' ? ALU.and : op === '|' ? ALU.or : ALU.xor, pair);
                return { where: 'eax', type: 'i32' };
            }
            case '<<':
            case '>>':
            case '>>>':
            {
                const digit = op === '<<' ? 4 : op === '>>' ? 7 : 5;
                const count = this.fold(node.right);
                if (count !== undefined)
                {
                    const value = this.expr(node.left);
                    this.integer(value, node.left, 'intish');
                    this.toEax(value, node.left);
                    a.emit(0xc1, 0xc0 | digit << 3, count & 31);
                }
                else
                {
                    const { right } = this.pair(node.left, node.right);
                    if (right.where === 'var')
                    {
                        a.emit(0x8b, ...frame(ECX, right.v.disp));        // mov ecx, [count]
                    }
                    a.emit(0xd3, 0xc0 | digit << 3);                     // shl/sar/shr eax, cl
                }
                return { where: 'eax', type: op === '>>>' ? 'u32' : 'i32' };
            }
            case '*':
            {
                const leftConstant = this.fold(node.left);
                const rightConstant = this.fold(node.right);
                const constant = rightConstant ?? leftConstant;
                const other = rightConstant !== undefined ? node.left : node.right;
                if (constant === undefined || !Number.isInteger(constant)
                    || Math.abs(constant) > 2 ** 20)
                {
                    this.fail(node, '* multiplies by an integer constant up to 2^20; anything '
                        + 'else is Math.imul');
                }
                const value = this.expr(other);
                this.integer(value, other, 'typed');
                this.toEax(value, other);
                a.emit(...fitsByte(constant) ? [0x6b, 0xc0, constant & 0xff]
                    : [0x69, 0xc0, ...le32(constant)]);                 // imul eax, eax, c
                return { where: 'eax', type: 'intish' };
            }
            default:
                this.fail(node, `${op} is not in the subset${op === '/' || op === '%'
                    ? ': there is no division' : ''}`);
        }
    }

    /** @param {any} node @returns {Value} */
    callExpression(node){
        const a = this.a;
        const callee = node.callee;
        if (callee.type === 'MemberExpression' && !callee.computed
            && callee.object.type === 'Identifier' && callee.object.name === 'Math')
        {
            const name = callee.property.name;
            if (name === 'imul')
            {
                this.arity(node, 2);
                const pair = this.pair(node.arguments[0], node.arguments[1], true);
                const right = pair.right;
                if (right.where === 'imm')
                {
                    const imm = right.value | 0;
                    a.emit(...fitsByte(imm) ? [0x6b, 0xc0, imm & 0xff]
                        : [0x69, 0xc0, ...le32(imm)]);
                }
                else if (right.where === 'var')
                {
                    a.emit(0x0f, 0xaf, ...frame(EAX, right.v.disp));
                }
                else
                {
                    a.emit(0x0f, 0xaf, 0xc1);                          // imul eax, ecx
                }
                return { where: 'eax', type: 'i32' };
            }
            if (Object.hasOwn(ROUNDING, name) || name === 'abs')
            {
                this.arity(node, 1);
                this.toSt0(this.expr(node.arguments[0]), node.arguments[0]);
                if (name === 'abs')
                {
                    a.emit(0xd9, 0xe1);                                    // fabs
                    return { where: 'st0', type: 'f64' };
                }
                // The control word with only its rounding control changed, and
                // back: the program's precision control and masks stand.
                a.emit(0x83, 0xec, 0x04);                                  // sub esp, 4
                a.emit(0xd9, 0x3c, 0x24);                                  // fnstcw [esp]
                a.emit(0x0f, 0xb7, 0x04, 0x24);                            // movzx eax, word [esp]
                a.emit(0x80, 0xe4, 0xf3);                                  // and ah, 0xf3
                a.emit(0x80, 0xcc, ROUNDING[name]);                        // or ah, rc
                a.emit(0x66, 0x89, 0x44, 0x24, 0x02);                      // mov [esp+2], ax
                a.emit(0xd9, 0x6c, 0x24, 0x02);                            // fldcw [esp+2]
                a.emit(0xd9, 0xfc);                                        // frndint
                a.emit(0xd9, 0x2c, 0x24);                                  // fldcw [esp]
                a.emit(0x83, 0xc4, 0x04);                                  // add esp, 4
                return { where: 'st0', type: 'f64' };
            }
            this.fail(node, `Math.${name} is not in the subset`);
        }
        if (callee.type !== 'Identifier')
        {
            this.fail(node, 'only a helper, Math.imul/floor/ceil/trunc/abs or a module-level '
                + 'function of one return is called');
        }
        const name = callee.name;
        if (this.helpers.has(name))
        {
            if (Object.hasOwn(LOADS, name))
            {
                this.arity(node, 1);
                const load = LOADS[name];
                const operand = this.address(node.arguments[0]);
                if (load.type === 'f64')
                {
                    if (++this.fpu > X87_DEPTH)
                    {
                        this.fail(node, 'the expression holds more doubles at once than the x87 '
                            + 'has room for');
                    }
                    a.emit(...load.op, ...memory(0, operand));
                    return { where: 'st0', type: 'f64' };
                }
                a.emit(...load.op, ...memory(EAX, operand));
                return { where: 'eax', type: load.type };
            }
            if (name === 'call')
            {
                this.guestCall(node);
                return { where: 'eax', type: 'i32' };
            }
            this.fail(node, `${name} is a statement: it answers nothing`);
        }
        if (HELPERS.has(name))
        {
            this.fail(node, `${name} is taken from the guest in the first parameter: { ${name} }`);
        }
        const inline = this.scope.inline.get(name);
        if (inline && this.lookupLocal(name) === undefined)
        {
            return this.inline(node, inline);
        }
        this.fail(node, `${name} is not a helper, nor a module-level function of one return`);
    }

    /** @param {any} node @param {number} count */
    arity(node, count){
        if (node.arguments.length !== count)
        {
            this.fail(node, `takes ${count} argument${count === 1 ? '' : 's'}`);
        }
        const spread = node.arguments.find((/** @type {any} */ arg)=>arg.type === 'SpreadElement');
        if (spread)
        {
            this.fail(spread, 'no spread');
        }
    }

    /**
     * A module-level function of one return, inlined: each argument into a
     * variable of its own, in order, then the expression.
     *
     * @param {any} node @param {any} fn @returns {Value}
     */
    inline(node, fn){
        if (this.inlining > 8)
        {
            this.fail(node, 'inlined too deep: a function calls itself');
        }
        this.arity(node, fn.params.length);
        /** @type {Map<string, Variable | { constant: number }>} */
        const bound = new Map();
        fn.params.forEach((/** @type {any} */ param, /** @type {number} */ i)=>{
            if (param.type !== 'Identifier')
            {
                this.fail(param, 'an inlined function\'s parameter is a name');
            }
            const argument = node.arguments[i];
            const constant = this.fold(argument);
            if (constant !== undefined)
            {
                bound.set(param.name, { constant });
                return;
            }
            // A variable is read where it is: nothing in an expression assigns.
            const simple = this.simple(argument);
            if (simple?.where === 'var')
            {
                bound.set(param.name, { ...simple.v, mutable: false });
                return;
            }
            const value = this.expr(argument);
            if (value.type === 'intish')
            {
                this.fail(argument, 'an argument is brought back to 32 bits');
            }
            const type = value.type;
            const size = type === 'f64' ? 8 : 4;
            this.locals = Math.ceil((this.locals + size) / size) * size;
            /** @type {Variable} */
            const v = { name: param.name, type, disp: -this.locals, mutable: false };
            if (type === 'f64')
            {
                this.toSt0(value, argument);
                this.a.emit(0xdd, ...frame(3, v.disp));
                this.fpu--;
            }
            else
            {
                this.toEax(value, argument);
                this.a.emit(0x89, ...frame(EAX, v.disp));
            }
            bound.set(param.name, v);
        });
        const saved = this.scopes;
        this.scopes = [bound];
        this.inlining++;
        const body = fn.body.type === 'BlockStatement' ? fn.body.body[0].argument : fn.body;
        try
        {
            return this.expr(body);
        }
        finally
        {
            this.inlining--;
            this.scopes = saved;
        }
    }

    /**
     * Emits an address into EAX (and ECX, for a sum of two values) and
     * answers the memory operand that names it.
     *
     * @param {any} node @returns {import('./x86.mjs').Memory}
     */
    address(node){
        const a = this.a;
        if (node.type === 'BinaryExpression' && (node.operator === '+' || node.operator === '-'))
        {
            const constant = this.fold(node.right);
            if (constant !== undefined && Math.abs(constant) < 2 ** 31)
            {
                const value = this.expr(node.left);
                this.integer(value, node.left, 'intish');
                this.toEax(value, node.left);
                return { base: EAX, disp: node.operator === '+' ? constant : -constant };
            }
            if (node.operator === '+')
            {
                this.pair(node.left, node.right);
                const r = this.simple(node.right);
                if (r !== null)
                {
                    if (r.where === 'imm')
                    {
                        return { base: EAX, disp: r.value | 0 };
                    }
                    a.emit(0x8b, ...frame(ECX, /** @type {Variable} */ (
                        /** @type {any} */ (r).v).disp));
                }
                return { base: EAX, index: ECX };
            }
        }
        const value = this.expr(node);
        this.integer(value, node, 'intish');
        this.toEax(value, node);
        return { base: EAX };
    }

    /** @param {any} node @returns {Value} */
    tableLoad(node){
        const a = this.a;
        if (!node.computed || node.object.type !== 'Identifier')
        {
            this.fail(node, 'a member is read only from a table, by index');
        }
        const table = this.scope.tables.get(node.object.name);
        if (!table || this.lookupLocal(node.object.name) !== undefined)
        {
            this.fail(node.object, `${node.object.name} is not an exported module-level typed `
                + 'array');
        }
        this.tables.set(table.name, table);
        let index = node.property;
        let addend = 0;
        if (index.type === 'BinaryExpression' && (index.operator === '+' || index.operator === '-'))
        {
            const constant = this.fold(index.right);
            if (constant !== undefined && Math.abs(constant) < 2 ** 20)
            {
                addend = (index.operator === '+' ? constant : -constant) * table.size;
                index = index.left;
            }
        }
        const value = this.expr(index);
        this.integer(value, index, 'intish');
        this.toEax(value, index);
        const scale = table.size;
        const sib = (scale === 1 ? 0 : scale === 2 ? 1 : 2) << 6 | EAX << 3 | EBX;
        /** @type {number[]} */
        let op;
        if (scale === 4)
        {
            op = [0x8b];
        }
        else if (scale === 2)
        {
            op = table.signed ? [0x0f, 0xbf] : [0x0f, 0xb7];
        }
        else
        {
            op = table.signed ? [0x0f, 0xbe] : [0x0f, 0xb6];
        }
        // op eax, [ebx + eax*scale + disp32]
        a.emit(...op, 0x84, sib).ref(table.name, addend);
        const type = table.signed ? 'i32' : scale === 4 ? 'u32' : 'nat';
        return { where: 'eax', type };
    }

    /** @param {any} node @param {string} name */
    storeCall(node, name){
        const a = this.a;
        this.arity(node, 2);
        const operand = this.address(node.arguments[0]);
        if (operand.index !== undefined)
        {
            a.emit(0x01, 0xc8);                                            // add eax, ecx
        }
        a.emit(0x50);                                                      // push eax
        const value = this.expr(node.arguments[1]);
        if (name === 'setF64')
        {
            this.toSt0(value, node.arguments[1]);
            a.emit(0x59);                                                  // pop ecx
            a.emit(0xdd, ...memory(3, { base: ECX, disp: operand.disp ?? 0 }));
            this.fpu--;
            return;
        }
        this.integer(value, node.arguments[1], 'intish');
        this.toEax(value, node.arguments[1]);
        a.emit(0x59);                                                      // pop ecx
        a.emit(...STORES[name], ...memory(EAX, { base: ECX, disp: operand.disp ?? 0 }));
    }

    /**
     * copyUp, copyDown and fill: `rep movsd` or `rep stosd` for the whole
     * dwords and the byte forms for the rest. Each turn of a `rep` counts as
     * an instruction, so a dword a turn is a quarter of the turns, and the
     * bytes land as the byte form leaves them -- except where a copy's two
     * ends are one to three bytes apart, and a dword read would take bytes
     * the byte form had already overwritten: that copy is bytes throughout.
     *
     * @param {any} node @param {string} name
     */
    bulk(node, name){
        const a = this.a;
        this.arity(node, 3);
        this.saves.add(ESI);
        this.saves.add(EDI);
        for (const argument of node.arguments)
        {
            const value = this.expr(argument);
            this.integer(value, argument, 'intish');
            this.toEax(value, argument);
            a.emit(0x50);                                                  // push eax
        }
        a.emit(0x59);                                                      // pop ecx: the count
        if (name === 'fill')
        {
            a.emit(0x58, 0x5f);                                            // pop eax; pop edi
            a.emit(0x0f, 0xb6, 0xc0, 0x69, 0xc0, ...le32(0x01010101));    // the byte, four times
            a.emit(0x89, 0xca, 0xc1, 0xe9, 0x02, 0xf3, 0xab);          // edx = n; rep stosd
            a.emit(0x89, 0xd1, 0x83, 0xe1, 0x03, 0xf3, 0xaa);          // n & 3; rep stosb
            return;
        }
        a.emit(0x5e, 0x5f);                                                // pop esi; pop edi
        const bytes = a.fresh('bytes');
        if (name === 'copyUp')
        {
            // One to three bytes ahead of the source: bytes throughout.
            a.emit(0x89, 0xf8, 0x29, 0xf0, 0x48, 0x83, 0xf8, 0x03);    // eax = edi - esi - 1
            a.jump(CC.b, bytes);
            a.emit(0x89, 0xca, 0xc1, 0xe9, 0x02, 0xf3, 0xa5);          // edx = n; rep movsd
            a.emit(0x89, 0xd1, 0x83, 0xe1, 0x03);                      // ecx = n & 3
            a.label(bytes);
            a.emit(0xf3, 0xa4);                                            // rep movsb
            return;
        }
        // From the last byte of each, with the direction flag set and cleared
        // again: the top n & 3 bytes, then the dwords below them.
        const done = a.fresh('done');
        a.emit(0x89, 0xf0, 0x29, 0xf8, 0x48, 0x83, 0xf8, 0x03);        // eax = esi - edi - 1
        a.emit(0x8d, 0x74, 0x0e, 0xff, 0x8d, 0x7c, 0x0f, 0xff, 0xfd);  // lea esi/edi, ...; std
        a.jump(CC.b, bytes);
        a.emit(0x89, 0xca, 0x83, 0xe1, 0x03, 0xf3, 0xa4);              // edx = n; rep movsb
        a.emit(0x83, 0xee, 0x03, 0x83, 0xef, 0x03);                    // esi, edi at a dword
        a.emit(0x89, 0xd1, 0xc1, 0xe9, 0x02, 0xf3, 0xa5);              // n >> 2; rep movsd
        a.jump(-1, done);
        a.label(bytes);
        a.emit(0xf3, 0xa4);                                                // rep movsb
        a.label(done);
        a.emit(0xfc);                                                      // cld
    }

    /** `push` a constant or a variable. @param {Value} value */
    pushOperand(value){
        if (value.where === 'imm')
        {
            const imm = value.value | 0;
            this.a.emit(...fitsByte(imm) ? [0x6a, imm & 0xff] : [0x68, ...le32(imm)]);
        }
        else if (value.where === 'var')
        {
            this.a.emit(0xff, ...frame(6, value.v.disp));                   // push [v]
        }
    }

    /**
     * call(fn, ...args): a cdecl call through a pointer, the arguments
     * evaluated in order into the space they are passed in.
     *
     * @param {any} node
     */
    guestCall(node){
        const a = this.a;
        const [target, ...args] = node.arguments;
        if (!target)
        {
            this.fail(node, 'call(fn, ...args) names the function');
        }
        if (this.fpu !== 0)
        {
            this.fail(node, 'a call is made with the x87 stack empty, as cdecl has it');
        }
        if (args.length > 30)
        {
            this.fail(node, 'call() passes at most thirty arguments');
        }
        const bytes = args.length * 4;
        const simple = [target, ...args].map(arg=>this.simple(arg));
        if (simple.every(value=>value !== null))
        {
            // Constants and variables: nothing to evaluate in order, so each
            // is pushed where it goes, the last first.
            for (const [i, value] of [...simple].entries())
            {
                this.integer(/** @type {Value} */ (value), [target, ...args][i], 'typed');
            }
            for (const value of simple.slice(1).reverse())
            {
                this.pushOperand(/** @type {Value} */ (value));
            }
            const fn = /** @type {Value} */ (simple[0]);
            if (fn.where === 'var')
            {
                a.emit(0xff, ...frame(2, fn.v.disp));                      // call [fn]
            }
            else
            {
                this.toEax(fn, target);
                a.emit(0xff, 0xd0);                                        // call eax
            }
            if (bytes > 0)
            {
                a.emit(0x83, 0xc4, bytes);                                 // add esp, 4n
            }
            return;
        }
        const fn = this.expr(target);
        this.integer(fn, target, 'typed');
        this.toEax(fn, target);
        a.emit(0x50);                                                      // push eax
        if (bytes > 0)
        {
            a.emit(0x83, 0xec, bytes);                                     // sub esp, 4n
        }
        args.forEach((/** @type {any} */ argument, /** @type {number} */ i)=>{
            const value = this.expr(argument);
            this.integer(value, argument, 'typed');
            this.toEax(value, argument);
            a.emit(0x89, ...memory(EAX, { base: ESP, disp: i * 4 }));       // mov [esp+4i], eax
        });
        a.emit(0xff, ...memory(2, { base: ESP, disp: bytes }));            // call [esp+4n]
        a.emit(0x83, 0xc4, bytes + 4);                                     // add esp, 4n+4
    }
}

/**
 * Whether control cannot fall out of the end of a statement.
 *
 * @param {any} node @returns {boolean}
 */
function ends(node){
    switch (node.type)
    {
        case 'ReturnStatement':
            return true;
        case 'BlockStatement':
            return node.body.length > 0 && ends(node.body[node.body.length - 1]);
        case 'IfStatement':
            return !!node.alternate && ends(node.consequent) && ends(node.alternate);
        case 'ForStatement':
        case 'WhileStatement':
            // A loop with no test, and no break of its own, is left only by a return.
            return (!node.test || node.test.type === 'Literal' && node.test.value === true)
                && !breaks(node.body);
        default:
            return false;
    }
}

/**
 * Whether a loop's body breaks out of it: a `break` not inside a loop of its own.
 *
 * @param {any} node @returns {boolean}
 */
function breaks(node){
    switch (node?.type)
    {
        case 'BreakStatement':
            return true;
        case 'BlockStatement':
            return node.body.some(breaks);
        case 'IfStatement':
            return breaks(node.consequent) || !!node.alternate && breaks(node.alternate);
        default:
            return false;
    }
}

/** @param {any} node */
function describe(node){
    return {
        FunctionExpression: 'a function', ArrowFunctionExpression: 'a closure',
        ObjectExpression: 'an object', ArrayExpression: 'an array', TemplateLiteral: 'a string',
        AwaitExpression: 'await', NewExpression: 'new', ThisExpression: 'this',
        SwitchStatement: 'switch', TryStatement: 'try', ThrowStatement: 'throw',
        ForOfStatement: 'for...of', ForInStatement: 'for...in', SequenceExpression: 'a comma',
    }[/** @type {string} */ (node.type)] ?? node.type;
}
