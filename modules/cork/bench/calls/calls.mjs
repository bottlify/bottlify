/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A benchmark of calling conventions for translated code, run in Node or a
 * page: the same guest call chains -- their shape from a real block profile
 * (`tools/cork-calls.mjs`) -- compiled under each convention, timed after
 * warming, several runs each. Self-contained (its own small wasm encoder) so a
 * page can be one file.
 *
 * Conventions (arms):
 *   state         cork's today: eax..ebx and the budget in parameters, the rest of the
 *                 registers and the six words of the lazy flags through the state block,
 *                 a shadow stack of return addresses, every call through a shared transfer
 *                 that probes an entry hash and tail-calls through the table
 *   state-direct  the same convention, a direct `call` or a `call_indirect` by index: the
 *                 transfer's share apart from the convention's
 *   params        all eight registers and the budget in parameters and results; the flags
 *                 through memory as today; the callee answers the address it returned to
 *   params+flags  the six flag words as parameters and results too
 *
 * Every arm does the same guest work and ends with the same registers, which
 * the runner compares: a convention that dropped work would not be measured.
 */

// ---- a small wasm encoder ------------------------------------------------

/** @param {number[]} out @param {number} value */
const u32 = (out, value)=>{
    let v = value >>> 0;
    for (;;)
    {
        const byte = v & 0x7f;
        v >>>= 7;
        if (v === 0)
        {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
};
/** @param {number[]} out @param {number} value */
const s32 = (out, value)=>{
    let v = value | 0;
    for (;;)
    {
        const byte = v & 0x7f;
        v >>= 7;
        if ((v === 0 && (byte & 0x40) === 0) || (v === -1 && (byte & 0x40) !== 0))
        {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
};
/** `out.push(...items)` for arrays too long to spread. @param {number[]} out @param {number[]} items */
const append = (out, items)=>{
    for (const item of items)
    {
        out.push(item);
    }
};
const I32 = 0x7f;
const OP = Object.freeze({
    block: 0x02, loop: 0x03, if: 0x04, else: 0x05, end: 0x0b, br: 0x0c, brIf: 0x0d,
    brTable: 0x0e, return: 0x0f, call: 0x10, callIndirect: 0x11, returnCallIndirect: 0x13,
    drop: 0x1a, get: 0x20, set: 0x21, tee: 0x22, load: 0x28, load16u: 0x2f, store: 0x36,
    const: 0x41, eqz: 0x45, eq: 0x46, ne: 0x47, ltU: 0x49, geU: 0x4f, leS: 0x4c,
    add: 0x6a, sub: 0x6b, mul: 0x6c, and: 0x71, or: 0x72, xor: 0x73, shl: 0x74, shrU: 0x76,
    rotl: 0x77, remU: 0x70,
});

/** A function body under construction. */
class Body
{
    constructor(){
        /** @type {number[]} */
        this.code = [];
    }
    /** @param {...number} bytes */
    op(...bytes){
        this.code.push(...bytes);
        return this;
    }
    /** @param {number} n */
    i32(n){
        this.code.push(OP.const);
        s32(this.code, n);
        return this;
    }
    /** @param {number} n */
    get(n){
        this.code.push(OP.get);
        u32(this.code, n);
        return this;
    }
    /** @param {number} n */
    set(n){
        this.code.push(OP.set);
        u32(this.code, n);
        return this;
    }
    /** @param {number} n */
    tee(n){
        this.code.push(OP.tee);
        u32(this.code, n);
        return this;
    }
    /** @param {number} offset */
    load(offset){
        this.code.push(OP.load, 2);
        u32(this.code, offset);
        return this;
    }
    /** @param {number} offset */
    load16(offset){
        this.code.push(OP.load16u, 1);
        u32(this.code, offset);
        return this;
    }
    /** @param {number} offset */
    store(offset){
        this.code.push(OP.store, 2);
        u32(this.code, offset);
        return this;
    }
    /** @param {number} index */
    call(index){
        this.code.push(OP.call);
        u32(this.code, index);
        return this;
    }
    /** @param {number} type */
    callIndirect(type){
        this.code.push(OP.callIndirect);
        u32(this.code, type);
        this.code.push(0);
        return this;
    }
    /** @param {number} type */
    returnCallIndirect(type){
        this.code.push(OP.returnCallIndirect);
        u32(this.code, type);
        this.code.push(0);
        return this;
    }
    /** @param {number} depth */
    br(depth){
        this.code.push(OP.br);
        u32(this.code, depth);
        return this;
    }
    /** @param {number} depth */
    brIf(depth){
        this.code.push(OP.brIf);
        u32(this.code, depth);
        return this;
    }
}

/**
 * A module: types, functions (all of one table, in order), one memory of
 * `pages`, exports by name.
 *
 * @param {{ types: [number[], number[]][], functions: { type: number, locals: number,
 *     body: Body }[], pages: number, exports: Record<string, [number, number]>,
 *     table: boolean }} spec  exports: by name, [kind, index] (0 a function, 2 the memory)
 */
function encode(spec){
    /** @param {number} id @param {number[]} body */
    const section = (id, body)=>{
        const out = [id];
        u32(out, body.length);
        return out.concat(body);
    };
    /** @param {number[]} out @param {number[]} items */
    const vec = (out, items)=>{
        u32(out, items.length);
        append(out, items);
    };
    const bytes = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
    const types = [];
    u32(types, spec.types.length);
    for (const [params, results] of spec.types)
    {
        types.push(0x60);
        vec(types, params);
        vec(types, results);
    }
    append(bytes, section(1, types));
    const funcs = [];
    u32(funcs, spec.functions.length);
    for (const one of spec.functions)
    {
        u32(funcs, one.type);
    }
    append(bytes, section(3, funcs));
    if (spec.table)
    {
        const table = [1, 0x70, 0x00];
        u32(table, spec.functions.length);
        append(bytes, section(4, table));
    }
    const memory = [1, 0x00];
    u32(memory, spec.pages);
    append(bytes, section(5, memory));
    const exports = [];
    const names = Object.entries(spec.exports);
    u32(exports, names.length);
    for (const [name, [kind, index]] of names)
    {
        const text = [...new TextEncoder().encode(name)];
        vec(exports, text);
        exports.push(kind);
        u32(exports, index);
    }
    append(bytes, section(7, exports));
    if (spec.table)
    {
        const elem = [1, 0x00, OP.const, 0, OP.end];
        u32(elem, spec.functions.length);
        for (let i = 0; i < spec.functions.length; i++)
        {
            u32(elem, i);
        }
        append(bytes, section(9, elem));
    }
    const code = [];
    u32(code, spec.functions.length);
    for (const one of spec.functions)
    {
        const body = [];
        if (one.locals > 0)
        {
            u32(body, 1);
            u32(body, one.locals);
            body.push(I32);
        }
        else
        {
            u32(body, 0);
        }
        append(body, one.body.code);
        body.push(OP.end);
        u32(code, body.length);
        append(code, body);
    }
    append(bytes, section(10, code));
    return new Uint8Array(bytes);
}

// ---- the guest's memory ---------------------------------------------------

/** The state block, as cork's own layout has it: registers, flags, a budget. */
const REGS = 0;          // eight words
const FLAGS = 40;        // six words: the lazy flag record
const BUDGET = 96;
const DEPTH = 100;       // the shadow stack's depth
const SHADOW = 104;      // 256 return addresses
const SELECT = 1152;     // the indirect calls' generator
const TARGETS = 2048;    // per depth, 256 callee indices
const HASH = 65536;      // 4096 slots of [eip, function, label]
const HASH_SLOTS = 4096;
const DATA = 131072;     // the guest's data: 16 KiB
const DATA_MASK = 0x3ffc;
const STACK = 196608;     // the guest's stack: esp is an offset from here
const ESP0 = 32768;
/** The address a chain's first function returns to: the root loop's. */
const ROOT_RETURN = 0x3ff000;
const PAGES = 4;
/** A function's guest address: what the entry hash keys. @param {number} index */
const eipOf = index=>0x400000 + index * 0x40;
const RETURNED = 7;

/** A seeded generator (mulberry32). @param {number} seed */
function random(seed){
    let state = seed >>> 0;
    return ()=>{
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * @typedef {Object} Workload
 * @property {string} name
 * @property {number} functions        distinct guest functions the chains go through
 * @property {number} work             guest instructions between calls
 * @property {number} indirectShare    of the calls, through a register or memory
 * @property {number} liveAfter        registers the code after a return reads first
 * @property {number} depth            calls a chain makes, one inside another
 */

/**
 * The program every arm runs: the functions by depth, what each does and whom
 * it calls. Function i sits at depth i % depth; one at the last depth calls
 * nobody. A call is direct (one callee, fixed) or indirect (the callee read
 * from a per-depth table by a generator in guest memory).
 *
 * @param {Workload} w @param {number} seed
 */
function plan(w, seed){
    const next = random(seed);
    const depth = Math.max(2, w.depth);
    const count = Math.max(w.functions, 2 * depth);
    const atDepth = (/** @type {number} */ d)=>Array.from({ length: count }, (_, i)=>i)
        .filter(i=>i % depth === d);
    return Array.from({ length: count }, (_, index)=>{
        const d = index % depth;
        /** Guest work: [kind, a, b, constant]. */
        const ops = (/** @type {number} */ n)=>Array.from({ length: n }, ()=>[
            Math.floor(next() * 4), Math.floor(next() * 8), Math.floor(next() * 8),
            (next() * 0x7fffffff) | 0]);
        const children = d + 1 < depth ? atDepth(d + 1) : [];
        const half = Math.floor(w.work / 2);
        return {
            index,
            before: ops(children.length > 0 ? half : w.work),
            after: ops(children.length > 0 ? w.work - half : 0),
            calls: children.length > 0,
            indirect: next() < w.indirectShare,
            callee: children[Math.floor(next() * children.length)] ?? -1,
            depth: d,
        };
    });
}

/**
 * One guest instruction's worth of work on the register locals `reg(n)`:
 * arithmetic, a rotate, a load or a store of the guest's data, a flag record
 * written as cork's lazy flags are (a kind and a result).
 *
 * @param {Body} b @param {number[]} op @param {(n: number) => number} reg
 * @param {(n: number) => number} flag
 */
function work(b, [kind, x, y, c], reg, flag){
    const ra = reg(x === 4 ? 0 : x);
    const rb = reg(y);
    switch (kind)
    {
        case 0:
            b.get(ra).get(rb).op(OP.add).tee(ra).set(flag(1)).i32(1).set(flag(0));
            break;
        case 1:
            b.get(ra).i32(c).op(OP.xor).i32(5).op(OP.rotl).set(ra);
            break;
        case 2:
            b.get(rb).i32(DATA_MASK).op(OP.and).load(DATA).set(ra);
            break;
        default:
            b.get(rb).i32(DATA_MASK).op(OP.and).get(ra).store(DATA);
    }
}

/**
 * The indirect callee's index, from the generator in guest memory: what a
 * virtual call's two loads amount to. Leaves it on the stack.
 *
 * @param {Body} b @param {number} d  the callee's depth
 */
function pickIndirect(b, d){
    b.i32(0).i32(0).load(SELECT).i32(1103515245).op(OP.mul).i32(12345).op(OP.add)
        .store(SELECT);
    b.i32(0).load(SELECT).i32(16).op(OP.shrU).i32(255).op(OP.and).i32(2).op(OP.shl)
        .load(TARGETS + d * 1024);
}

/** The arms, by name. */
export const ARMS = ['state', 'state-direct', 'params', 'params+flags'];

/**
 * The module of one arm: the guest functions, then `run(iterations)` -- the
 * root loop -- and, for `state`, the shared transfer. Exports `run` and
 * `checksum`.
 *
 * @param {Workload} w @param {string} arm @param {number} seed
 */
export function build(w, arm, seed = 1){
    const program = plan(w, seed);
    const n = program.length;
    const live = Math.max(0, Math.min(7, Math.round(w.liveAfter)));
    const state = arm === 'state' || arm === 'state-direct';
    const flagsInParams = arm === 'params+flags';
    /** @type {[number[], number[]][]} */
    const types = state
        // (eip or label, budget, eax, ecx, edx, ebx) -> status
        ? [[[I32, I32, I32, I32, I32, I32], [I32]], [[I32], [I32]]]
        // (budget, eight registers[, six flags]) -> (returned-to, budget, registers[, flags])
        : [[Array(9 + (flagsInParams ? 6 : 0)).fill(I32),
            Array(10 + (flagsInParams ? 6 : 0)).fill(I32)], [[I32], [I32]]];
    const transferIndex = n;
    /** @type {{ type: number, locals: number, body: Body }[]} */
    const functions = [];

    for (const fn of program)
    {
        const b = new Body();
        // Locals: in `state`, params 0..5 are (label, budget, eax..ebx); registers
        // r0..r3 are params 2..5, r4..r7 locals 6..9, flags 10..15, temps 16..17.
        // In `params`, params 0..8 are (budget, r0..r7), flags 9..14 (params or
        // locals), temps 15..16.
        const reg = state
            ? (/** @type {number} */ r)=>(r < 4 ? 2 + r : 2 + r)
            : (/** @type {number} */ r)=>1 + r;
        const flag = state ? (/** @type {number} */ f)=>10 + f : (/** @type {number} */ f)=>9 + f;
        const budget = state ? 1 : 0;
        const t0 = state ? 16 : 15;
        const retAddr = eipOf(fn.index) + 0x20;
        const locals = state ? 12 : (flagsInParams ? 2 : 8);
        if (state)
        {
            // The region's entry: its dispatch on the label, then the state the
            // parameters do not carry, from the state block.
            b.op(OP.block, 0x40).get(0).op(OP.brTable, 0, 0).op(OP.end);
            for (let r = 4; r < 8; r++)
            {
                b.i32(0).load(REGS + r * 4).set(reg(r));
            }
            for (let f = 0; f < 6; f++)
            {
                b.i32(0).load(FLAGS + f * 4).set(flag(f));
            }
        }
        else if (!flagsInParams)
        {
            for (let f = 0; f < 6; f++)
            {
                b.i32(0).load(FLAGS + f * 4).set(flag(f));
            }
        }
        for (const op of fn.before)
        {
            work(b, op, reg, flag);
        }
        if (fn.calls)
        {
            // The guest's push of its return address, and the budget.
            b.get(reg(4)).i32(4).op(OP.sub).tee(reg(4)).i32(retAddr).store(STACK);
            b.get(budget).i32(1).op(OP.sub).set(budget);
            const target = ()=>{
                if (fn.indirect)
                {
                    pickIndirect(b, fn.depth + 1);
                }
                else
                {
                    b.i32(fn.callee);
                }
            };
            if (state)
            {
                // cork's call: the shadow stack, the state written back, the call,
                // the answer tested, the state loaded again.
                b.i32(0).load(DEPTH).tee(t0).i32(256).op(OP.geU).get(budget).i32(0).op(OP.leS)
                    .op(OP.or).op(OP.if, 0x40).i32(0).op(OP.return).op(OP.end);
                b.get(t0).i32(2).op(OP.shl).i32(retAddr).store(SHADOW);
                b.i32(0).get(t0).i32(1).op(OP.add).store(DEPTH);
                for (let r = 4; r < 8; r++)
                {
                    b.i32(0).get(reg(r)).store(REGS + r * 4);
                }
                for (let f = 0; f < 6; f++)
                {
                    b.i32(0).get(flag(f)).store(FLAGS + f * 4);
                }
                if (arm === 'state')
                {
                    // The callee's guest address, for the transfer to look up.
                    target();
                    b.i32(0x40).op(OP.mul).i32(0x400000).op(OP.add);
                    b.get(budget);
                    for (let r = 0; r < 4; r++)
                    {
                        b.get(reg(r));
                    }
                    b.call(transferIndex);
                }
                else
                {
                    b.i32(0).get(budget);
                    for (let r = 0; r < 4; r++)
                    {
                        b.get(reg(r));
                    }
                    if (fn.indirect)
                    {
                        target();
                        b.callIndirect(0);
                    }
                    else
                    {
                        b.call(fn.callee);
                    }
                }
                b.tee(t0).i32(RETURNED).op(OP.ne).op(OP.if, 0x40).i32(0).get(t0)
                    .op(OP.drop).op(OP.return).op(OP.end);
                b.i32(0).load(BUDGET).set(budget);
                for (let f = 0; f < 6; f++)
                {
                    b.i32(0).load(FLAGS + f * 4).set(flag(f));
                }
                for (let r = 0; r < 8; r++)
                {
                    b.i32(0).load(REGS + r * 4).set(reg(r));
                }
            }
            else
            {
                if (!flagsInParams)
                {
                    for (let f = 0; f < 6; f++)
                    {
                        b.i32(0).get(flag(f)).store(FLAGS + f * 4);
                    }
                }
                b.get(budget);
                for (let r = 0; r < 8; r++)
                {
                    b.get(reg(r));
                }
                if (flagsInParams)
                {
                    for (let f = 0; f < 6; f++)
                    {
                        b.get(flag(f));
                    }
                }
                if (fn.indirect)
                {
                    target();
                    b.callIndirect(0);
                }
                else
                {
                    b.call(fn.callee);
                }
                // The results, last first: the flags, the registers, the budget,
                // then the address the callee's ret went to.
                if (flagsInParams)
                {
                    for (let f = 5; f >= 0; f--)
                    {
                        b.set(flag(f));
                    }
                }
                for (let r = 7; r >= 0; r--)
                {
                    b.set(reg(r));
                }
                b.set(budget);
                b.i32(retAddr).op(OP.ne).op(OP.if, 0x40);
                for (let r = 0; r < 8; r++)
                {
                    b.i32(0).get(reg(r)).store(REGS + r * 4);
                }
                b.i32(0);
                for (let k = 0; k < 9 + (flagsInParams ? 6 : 0); k++)
                {
                    b.i32(0);
                }
                b.op(OP.return).op(OP.end);
                if (!flagsInParams)
                {
                    for (let f = 0; f < 6; f++)
                    {
                        b.i32(0).load(FLAGS + f * 4).set(flag(f));
                    }
                }
            }
            // The code after the return reads `live` registers first (esp aside).
            for (const r of [0, 1, 2, 3, 5, 6, 7].slice(0, live))
            {
                b.get(reg(r)).i32(r + 1).op(OP.add).set(reg(r));
            }
        }
        for (const op of fn.after)
        {
            work(b, op, reg, flag);
        }
        // The guest's ret: the address popped, then answered.
        b.get(reg(4)).load(STACK).set(t0 + 1);
        b.get(reg(4)).i32(4).op(OP.add).set(reg(4));
        if (state)
        {
            // cork's ret: the shadow stack's top compared, the state written back.
            b.i32(0).load(DEPTH).tee(t0).op(OP.if, 0x40)
                .get(t0).i32(2).op(OP.shl).load(SHADOW - 4).get(t0 + 1).op(OP.eq)
                .op(OP.if, 0x40).i32(0).get(t0).i32(1).op(OP.sub).store(DEPTH);
            for (let r = 0; r < 8; r++)
            {
                b.i32(0).get(reg(r)).store(REGS + r * 4);
            }
            for (let f = 0; f < 6; f++)
            {
                b.i32(0).get(flag(f)).store(FLAGS + f * 4);
            }
            b.i32(0).get(budget).store(BUDGET);
            b.i32(RETURNED).op(OP.return).op(OP.end).op(OP.end);
            for (let r = 0; r < 8; r++)
            {
                b.i32(0).get(reg(r)).store(REGS + r * 4);
            }
            b.i32(0);
        }
        else
        {
            if (!flagsInParams)
            {
                for (let f = 0; f < 6; f++)
                {
                    b.i32(0).get(flag(f)).store(FLAGS + f * 4);
                }
            }
            b.get(t0 + 1).get(budget);
            for (let r = 0; r < 8; r++)
            {
                b.get(reg(r));
            }
            if (flagsInParams)
            {
                for (let f = 0; f < 6; f++)
                {
                    b.get(flag(f));
                }
            }
        }
        functions.push({ type: 0, locals, body: b });
    }

    if (arm === 'state')
    {
        // The transfer: the entry hash probed by the guest address, the
        // region's function tail-called with its label (cork's `transfer`).
        const b = new Body();
        const slot = 6;
        b.get(0).i32(0x9e3779b1 | 0).op(OP.mul).i32(20).op(OP.shrU).set(slot);
        b.op(OP.loop, 0x40);
        b.get(slot).i32(12).op(OP.mul).load(HASH).get(0).op(OP.ne).op(OP.if, 0x40)
            .get(slot).i32(1).op(OP.add).i32(HASH_SLOTS - 1).op(OP.and).set(slot).br(1)
            .op(OP.end).op(OP.end);
        b.get(slot).i32(12).op(OP.mul).load16(HASH + 8);
        for (let p = 1; p < 6; p++)
        {
            b.get(p);
        }
        b.get(slot).i32(12).op(OP.mul).load(HASH + 4).returnCallIndirect(0);
        functions.push({ type: 0, locals: 1, body: b });
    }

    // run(iterations): the root loop, a chain from a function at depth 0 each turn.
    const roots = program.filter(fn=>fn.depth === 0).map(fn=>fn.index);
    const b = new Body();
    const left = 0;
    const at = 1;
    const temp = 2;
    b.op(OP.loop, 0x40);
    b.get(at).i32(1).op(OP.add).i32(roots.length).op(OP.remU).set(at);
    if (state)
    {
        // The root's call as any call: its return address on the guest's stack
        // and the shadow stack's.
        b.i32(0).i32(1).store(DEPTH);
        b.i32(0).i32(ROOT_RETURN).store(SHADOW);
        b.i32(0).i32(ROOT_RETURN).store(STACK + ESP0 - 4);
        b.i32(0).i32(0x7fffffff).store(BUDGET);
        b.i32(0).i32(ESP0 - 4).store(REGS + 16);
        b.get(at).i32(2).op(OP.shl).load(SELECT + 64);
        b.i32(0).load(BUDGET);
        for (let r = 0; r < 4; r++)
        {
            b.i32(0).load(REGS + r * 4);
        }
        b.get(at).i32(2).op(OP.shl).load(SELECT + 64 + 1024).callIndirect(0).op(OP.drop);
    }
    else
    {
        b.i32(0).i32(ROOT_RETURN).store(STACK + ESP0 - 4);
        b.i32(0x7fffffff);
        for (let r = 0; r < 8; r++)
        {
            if (r === 4)
            {
                b.i32(ESP0 - 4);
            }
            else
            {
                b.i32(0).load(REGS + r * 4);
            }
        }
        if (flagsInParams)
        {
            for (let f = 0; f < 6; f++)
            {
                b.i32(0).load(FLAGS + f * 4);
            }
        }
        b.get(at).i32(2).op(OP.shl).load(SELECT + 64 + 1024).callIndirect(0);
        // The results, last first, into the state block for the next turn.
        if (flagsInParams)
        {
            for (let f = 5; f >= 0; f--)
            {
                b.set(temp).i32(0).get(temp).store(FLAGS + f * 4);
            }
        }
        for (let r = 7; r >= 0; r--)
        {
            b.set(temp).i32(0).get(temp).store(REGS + r * 4);
        }
        b.op(OP.drop).op(OP.drop);
    }
    b.get(left).i32(1).op(OP.sub).tee(left).brIf(0).op(OP.end);
    b.i32(0);
    functions.push({ type: 1, locals: 2, body: b });
    // run is the last function, after the transfer where there is one.
    const runAt = functions.length - 1;
    const bytes = encode({ types, functions, pages: PAGES, table: true,
        exports: { run: [0, runAt], memory: [2, 0] } });
    return { bytes, program, roots };
}

/**
 * The memory every arm starts from: the entry hash, the roots and their
 * labels, the per-depth indirect tables, the generator, the guest's data.
 *
 * @param {Uint8Array} memory @param {ReturnType<typeof plan>} program
 * @param {number[]} roots @param {number} seed
 */
function prepare(memory, program, roots, seed){
    const view = new DataView(memory.buffer, memory.byteOffset, memory.byteLength);
    memory.fill(0);
    const next = random(seed ^ 0x5bd1e995);
    for (let i = 0; i < 4096; i++)
    {
        view.setUint32(DATA + i * 4, (next() * 0xffffffff) >>> 0, true);
    }
    for (const fn of program)
    {
        let slot = Math.imul(eipOf(fn.index), 0x9e3779b1) >>> 20;
        while (view.getUint32(HASH + slot * 12, true) !== 0)
        {
            slot = (slot + 1) & (HASH_SLOTS - 1);
        }
        view.setUint32(HASH + slot * 12, eipOf(fn.index), true);
        view.setUint32(HASH + slot * 12 + 4, fn.index, true);
        view.setUint16(HASH + slot * 12 + 8, 0, true);
    }
    const depths = Math.max(...program.map(fn=>fn.depth)) + 1;
    for (let d = 0; d < depths; d++)
    {
        const at = program.filter(fn=>fn.depth === d).map(fn=>fn.index);
        for (let i = 0; i < 256; i++)
        {
            view.setUint32(TARGETS + d * 1024 + i * 4, at[Math.floor(next() * at.length)], true);
        }
    }
    view.setUint32(SELECT, 12345, true);
    roots.forEach((root, i)=>{
        view.setUint32(SELECT + 64 + i * 4, 0, true);
        view.setUint32(SELECT + 64 + 1024 + i * 4, root, true);
    });
}

/** What a run leaves in the state block's registers: every arm's must match. @param {Uint8Array} memory */
const registersOf = memory=>[...new Uint32Array(memory.buffer, memory.byteOffset, 8)];

/**
 * How many turns make a run of about `ms`: first the code warmed until it has
 * run half a second (V8 compiles a function on its first call and may compile
 * it again, and a cold run times the compiler), then turns grown until a run
 * takes a tenth of `ms` at least -- far above a page's coarse clock -- scaled
 * to `ms`, and checked once more on a run of that many.
 *
 * @param {(turns: number) => void} go @param {number} ms @param {() => number} now
 */
function calibrate(go, ms, now){
    let turns = 1000;
    const warmed = now();
    while (now() - warmed < 500)
    {
        const start = now();
        go(turns);
        if (now() - start < 50)
        {
            turns *= 2;
        }
    }
    for (;;)
    {
        const start = now();
        go(turns);
        const took = now() - start;
        if (took >= ms / 10 || turns > 1e9)
        {
            turns = Math.max(1000, Math.round(turns * ms / Math.max(took, 0.001)));
            break;
        }
        turns *= 2;
    }
    const start = now();
    go(turns);
    return Math.max(1000, Math.round(turns * ms / Math.max(now() - start, 0.001)));
}

/**
 * Times one arm: `warm` runs first, then `runs` runs of about `ms` each.
 * Answers nanoseconds a guest call, every run's, and the registers.
 *
 * @param {Workload} w @param {string} arm
 * @param {{ runs?: number, warm?: number, ms?: number, seed?: number,
 *     now?: () => number }} [options]
 */
export async function measure(w, arm, { runs = 9, warm = 5, ms = 200, seed = 1,
    now = ()=>performance.now() } = {})
{
    const { bytes, program, roots } = build(w, arm, seed);
    const { instance } = await WebAssembly.instantiate(bytes);
    const run = /** @type {(n: number) => number} */ (instance.exports.run);
    const memory = new Uint8Array(/** @type {WebAssembly.Memory} */ (instance.exports.memory)
        .buffer);
    const callsPerTurn = Math.max(2, w.depth) - 1;
    const turns = calibrate(n=>{
        prepare(memory, program, roots, seed);
        run(n);
    }, ms, now);
    for (let i = 0; i < warm; i++)
    {
        prepare(memory, program, roots, seed);
        run(turns);
    }
    const values = [];
    for (let i = 0; i < runs; i++)
    {
        prepare(memory, program, roots, seed);
        const start = now();
        run(turns);
        values.push((now() - start) * 1e6 / (turns * callsPerTurn));
    }
    prepare(memory, program, roots, seed);
    run(1000);
    return { arm, nsPerCall: values, registers: registersOf(memory), moduleBytes: bytes.length,
        turns, callsPerTurn };
}

/**
 * The parameter sweep: a chain of indirect calls passing `k` i32 parameters
 * and answering `k` results, for each k. Where V8 stops keeping them in
 * registers the cost a call steps up.
 *
 * @param {number} k
 */
export function sweepModule(k){
    const depth = 16;
    const copies = 8;
    const types = [[Array(k).fill(I32), Array(k).fill(I32)], [[I32], [I32]]];
    /** @type {{ type: number, locals: number, body: Body }[]} */
    const functions = [];
    // Eight identical copies a depth, each call to one of the next depth's
    // picked by its first parameter: a call site of eight targets, which V8
    // neither inlines nor turns into a direct call, as a guest's would not be.
    for (let d = 0; d < depth; d++)
    {
        for (let c = 0; c < copies; c++)
        {
            const b = new Body();
            if (d + 1 < depth)
            {
                for (let p = 0; p < k; p++)
                {
                    b.get(p).i32(p + 1).op(OP.add);
                }
                b.get(0).i32(copies - 1).op(OP.and).i32((d + 1) * copies).op(OP.add)
                    .callIndirect(0);
            }
            else
            {
                for (let p = 0; p < k; p++)
                {
                    b.get(p);
                }
            }
            functions.push({ type: 0, locals: 0, body: b });
        }
    }
    const b = new Body();
    b.op(OP.loop, 0x40);
    for (let p = 0; p < k; p++)
    {
        b.get(1).i32(p).op(OP.add);
    }
    b.get(1).i32(copies - 1).op(OP.and).callIndirect(0);
    for (let p = 1; p < k; p++)
    {
        b.op(OP.drop);
    }
    b.get(2).op(OP.add).set(2);
    b.get(1).i32(1).op(OP.add).set(1);
    b.get(0).i32(1).op(OP.sub).tee(0).brIf(0).op(OP.end);
    b.get(2);
    functions.push({ type: 1, locals: 2, body: b });
    return { bytes: encode({ types, functions, pages: 1, table: true,
        exports: { run: [0, functions.length - 1] } }), callsPerTurn: depth };
}

/**
 * Nanoseconds a call of the sweep at `k` parameters, every run's.
 *
 * @param {number} k @param {{ runs?: number, ms?: number, now?: () => number }} [options]
 */
export async function measureSweep(k, { runs = 9, ms = 150, now = ()=>performance.now() } = {}){
    const { bytes, callsPerTurn } = sweepModule(k);
    const { instance } = await WebAssembly.instantiate(bytes);
    const run = /** @type {(n: number) => number} */ (instance.exports.run);
    const turns = calibrate(n=>run(n), ms, now);
    for (let i = 0; i < 3; i++)
    {
        run(turns);
    }
    const values = [];
    for (let i = 0; i < runs; i++)
    {
        const start = now();
        run(turns);
        values.push((now() - start) * 1e6 / (turns * callsPerTurn));
    }
    return { k, nsPerCall: values };
}

/** The median, and the spread of the runs as a share of it. @param {number[]} values */
export function summary(values){
    const sorted = [...values].sort((a, b)=>a - b);
    const median = sorted[sorted.length >> 1];
    return { median, min: sorted[0], max: sorted[sorted.length - 1],
        spread: (sorted[sorted.length - 1] - sorted[0]) / median };
}
