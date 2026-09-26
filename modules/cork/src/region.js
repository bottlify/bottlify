/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A region: the unit of translation.
 *
 * From an entry, blocks are decoded along fall-through and direct branches
 * until the code meets an indirect jump, a return, a call, a trap, a halt,
 * an instruction the decoder refuses, a page the runtime says not to
 * translate, or one of the size caps. A branch into the middle of a block
 * already decoded splits it at the target, so every block starts on an
 * instruction boundary another block can jump to. The result is a set of
 * blocks in address order with their exits: what kind of instruction ended
 * the block, where it can go, and whether an edge goes backwards -- the
 * shape the emitter turns into one wasm function.
 */

import { RUNTIME_HELPERS, helperAt, helperInstructions } from './helpers.js';
import { decode } from './decode/decoder.js';

/**
 * @typedef {'fallthrough' | 'jump' | 'jcc' | 'loop' | 'ret' | 'indirect' | 'call' | 'trap'
 *     | 'hlt' | 'refused' | 'fault' | 'cut'} ExitKind
 *   fallthrough  the block ends where another block starts
 *   jump         an unconditional direct jump
 *   jcc          a conditional jump: targets [taken, not taken]
 *   loop         loop/jecxz: the same two targets
 *   ret          a return
 *   indirect     jmp r/m: the target is in a register or memory
 *   call         a call: targets [callee], the return address in `next`
 *   trap         out to the trap port, int, cli/sti, in: the runtime's
 *   hlt          the processor halts
 *   refused      the decoder refused the next instruction, named in `refusal`
 *   fault        ud2 and friends: a fault by design
 *   cut          a cap: the region stops here and `next` is an exit
 */

/**
 * @typedef {Object} Block
 * @property {number} start
 * @property {number} end                [start, end)
 * @property {import('./decode/decoder.js').Instruction[]} instructions
 * @property {{ kind: ExitKind, targets: number[], next: number, backEdge: boolean,
 *              refusal?: import('./decode/decoder.js').Refusal,
 *              table?: SwitchTable, predicted?: boolean }} exit
 *   an `indirect` exit through a switch's table of addresses carries the table,
 *   and its distinct targets as `targets`; an indirect call the runtime has
 *   seen go to a few callees (`callTargets`) is `predicted`, those callees its
 *   `targets`
 */

/**
 * A `jmp [table + r*4]` whose index a `cmp r, n` and an unsigned branch bound
 * before it, as compilers lay out a switch: the table's entries as they were
 * when the region was formed. The jump still loads its target and compares it
 * with the entry, so a table written since leaves the region as any indirect
 * jump does.
 *
 * @typedef {{ index: number, address: number, entries: number[] }} SwitchTable
 */

/**
 * @typedef {Object} Region
 * @property {number} entry
 * @property {Block[]} blocks            in address order; the entry's block first by address
 *                                       is not guaranteed -- find it by `entry`
 * @property {number[]} entries          every block start
 * @property {number} bytes
 * @property {Set<number>} pages         4 KiB pages the code and its switch tables span
 * @property {SwitchTable[]} [tables]    the switch tables its jumps go through, read as data
 * @property {string} hash               of the decoded bytes, for the cache
 * @property {Map<string, number>} refused   opcode → times a refusal cut a block
 */

/** Exits that end a block and are not followed into another block of this region. */
const TERMINAL = new Set(['ret', 'indirect', 'call', 'trap', 'hlt', 'refused', 'fault']);

/** The callee a direct call is formed into its caller with, at most: a leaf,
 * or one with direct calls of its own (formed one level deep). */
const LEAF_BLOCKS = 16;
const LEAF_BYTES = 512;

/**
 * Whether the function at `target` is small enough to form into its caller:
 * a few blocks reached by direct branches alone, every way out of them a
 * `ret`. Only a guess at the shape -- a return is still checked against the
 * return address at run time -- so anything else (an indirect jump, a trap,
 * a refusal, a page not to translate) answers no; so does a direct call in
 * it unless `calls`, when the callee's own callees leave through the hash as
 * any call does and come back to the block after their call.
 *
 * @param {(address: number) => import('./decode/decoder.js').Instruction
 *     | import('./decode/decoder.js').Refusal} decodeAt
 * @param {number} target
 * @param {(eip: number) => boolean} translatable @param {boolean} [calls]
 */
function isLeaf(decodeAt, target, translatable, calls = false){
    const seen = new Set();
    const work = [target];
    let bytes = 0;
    while (work.length > 0)
    {
        const start = /** @type {number} */ (work.pop());
        if (seen.has(start))
        {
            continue;
        }
        if (seen.size >= LEAF_BLOCKS || !translatable(start))
        {
            return false;
        }
        seen.add(start);
        for (let eip = start; ;)
        {
            const decoded = decodeAt(eip);
            if ('refused' in decoded)
            {
                return false;
            }
            bytes += decoded.length;
            if (bytes > LEAF_BYTES)
            {
                return false;
            }
            eip = (eip + decoded.length) >>> 0;
            const exit = exitOf(decoded, eip);
            if (exit === null)
            {
                continue;
            }
            if (exit.kind === 'jump' || exit.kind === 'jcc' || exit.kind === 'loop')
            {
                work.push(...exit.targets);
                break;
            }
            if (exit.kind === 'ret')
            {
                break;
            }
            if (calls && exit.kind === 'call' && seen.size < LEAF_BLOCKS)
            {
                // The return lands after the call: a block of its own.
                seen.add(eip);
                continue;
            }
            return false;
        }
    }
    return true;
}

/**
 * The callees a call block may go to inside the region: a direct call's, or
 * a predicted indirect call's.
 *
 * @param {Block['exit']} exit
 */
const calleesOf = exit=>(exit.kind === 'call' || exit.kind === 'indirect' && exit.predicted
    ? exit.targets : []);

/**
 * Where each `ret` of the region may come back to inside it: the return
 * addresses of the calls -- direct, or indirect with their callees predicted
 * -- whose callee is formed into the region with them (the callee's start and
 * the return address both blocks), for the rets the callee reaches by its own
 * branches. Such a ret that comes back to one of them jumps there rather than
 * leaving; the region's other rets are no edge to them.
 *
 * @param {Region} region
 * @returns {Map<number, number[]>}  ret block start → return addresses
 */
export function inlineReturns(region){
    const byStart = new Map(region.blocks.map(block=>[block.start, block]));
    /** @type {Map<number, number[]>} */
    const out = new Map();
    for (const block of region.blocks)
    {
        const { next } = block.exit;
        const callees = calleesOf(block.exit).filter(callee=>byStart.has(callee));
        if (callees.length === 0 || !byStart.has(next))
        {
            continue;
        }
        const seen = new Set();
        const work = [...callees];
        while (work.length > 0)
        {
            const at = /** @type {number} */ (work.pop());
            const reached = byStart.get(at);
            if (reached === undefined || seen.has(at))
            {
                continue;
            }
            seen.add(at);
            const exit = reached.exit;
            if (exit.kind === 'ret')
            {
                const list = out.get(at) ?? [];
                if (!list.includes(next))
                {
                    list.push(next);
                }
                out.set(at, list);
            }
            else if (exit.kind === 'fallthrough' || exit.kind === 'jump' || exit.kind === 'jcc'
                || exit.kind === 'loop')
            {
                work.push(...exit.targets, ...(exit.kind === 'jump' ? [] : [exit.next]));
            }
            else if (calleesOf(exit).length > 0)
            {
                // A callee of the callee comes back after its call.
                work.push(exit.next);
            }
        }
    }
    return out;
}

/** The most entries a switch's table is read for. */
const SWITCH_ENTRIES = 1024;

/** What may stand between a switch's bound test and its branch: a write to a
 * register the instruction names, and nothing else. */
const PLAIN_WRITES = new Set([
    'mov', 'movzx', 'movsx', 'lea', 'add', 'sub', 'and', 'or', 'xor', 'inc', 'dec', 'not', 'neg',
    'shl', 'shr', 'sar', 'imul',
]);

/** @param {import('./decode/decoder.js').Operand} a @param {import('./decode/decoder.js').Operand} b */
const sameOperand = (a, b)=>a.kind === b.kind && a.size === b.size && a.reg === b.reg
    && (a.base ?? -1) === (b.base ?? -1) && (a.index ?? -1) === (b.index ?? -1)
    && (a.scale ?? 1) === (b.scale ?? 1) && (a.disp ?? 0) === (b.disp ?? 0)
    && a.segment === b.segment && a.addressSize === b.addressSize && a.high === b.high;

/**
 * The table a block's jump goes through: `jmp [table + r*4]`, alone in its
 * block or after the `mov r, x` that loads its index, where the branch into
 * the block bounds the index as compilers lay out a switch -- the last flag
 * writer before it `cmp x, n` (x the register r, or the memory the index is
 * loaded from), then `ja`/`jae` falling through to the block or `jbe`/`jb`
 * taken to it, with only register writes that leave x alone between. The
 * bound holds on that edge only; another way into the block reaches the same
 * code, whose index test sends an index past the table out of the region.
 *
 * @param {(address: number) => number} read @param {Block} block
 * @param {Iterable<Block>} blocks
 * @returns {SwitchTable | null}
 */
function switchTable(read, block, blocks){
    const { instructions } = block;
    const jump = instructions[instructions.length - 1];
    const [operand] = jump.operands;
    if (jump.op !== 'jmp' || operand.kind !== 'mem' || operand.size !== 4
        || (operand.base ?? -1) >= 0 || (operand.index ?? -1) < 0 || operand.scale !== 4
        || operand.addressSize === 16 || operand.segment === 4 || operand.segment === 5)
    {
        return null;
    }
    const index = /** @type {number} */ (operand.index);
    // What the bound test must have compared: the index register itself, or
    // the memory a `mov` at the block's start loads it from.
    /** @type {import('./decode/decoder.js').Operand} */
    let tested = { kind: 'reg', size: 4, reg: index };
    if (instructions.length === 2)
    {
        const [load] = instructions;
        const [into, from] = load.operands;
        if (load.op !== 'mov' || into.kind !== 'reg' || into.size !== 4 || into.reg !== index
            || from.kind !== 'mem')
        {
            return null;
        }
        tested = from;
    }
    else if (instructions.length !== 1)
    {
        return null;
    }
    // The registers the tested operand is made of, which nothing between the
    // test and the jump may write.
    const held = new Set(tested.kind === 'reg' ? [tested.reg]
        : [tested.base ?? -1, tested.index ?? -1].filter(r=>r >= 0));
    for (const guard of blocks)
    {
        const { kind, targets, next } = guard.exit;
        const branch = guard.instructions[guard.instructions.length - 1];
        if (kind !== 'jcc')
        {
            continue;
        }
        const bounding = (branch.op === 'ja' || branch.op === 'jae') && next === block.start
            || (branch.op === 'jbe' || branch.op === 'jb') && targets[0] === block.start;
        if (!bounding)
        {
            continue;
        }
        let at = guard.instructions.length - 2;
        while (at >= 0 && guard.instructions[at].flagsWritten === 0)
        {
            at--;
        }
        const compare = guard.instructions[at];
        if (compare?.op !== 'cmp' || compare.operands[1].kind !== 'imm'
            || !sameOperand(compare.operands[0], tested))
        {
            continue;
        }
        const between = guard.instructions.slice(at + 1, -1);
        if (!between.every(one=>PLAIN_WRITES.has(one.op) && one.operands[0]?.kind === 'reg'
            && !held.has(/** @type {number} */ (one.operands[0].reg))
            && !(one.op === 'imul' && one.operands.length === 1)))
        {
            continue;
        }
        const bound = /** @type {number} */ (compare.operands[1].value) >>> 0;
        const count = branch.op === 'ja' || branch.op === 'jbe' ? bound + 1 : bound;
        if (count === 0 || count > SWITCH_ENTRIES)
        {
            continue;
        }
        const address = (operand.disp ?? 0) >>> 0;
        /** @type {number[]} */
        const entries = [];
        for (let i = 0; i < count; i++)
        {
            const entry = address + i * 4;
            entries.push((read(entry) | read(entry + 1) << 8 | read(entry + 2) << 16
                | read(entry + 3) << 24) >>> 0);
        }
        return { index, address, entries };
    }
    return null;
}

/**
 * What forming learns of bytes that stay as they are while several regions are
 * formed over them -- a batch on the engine thread, a relink over its copy of
 * the pages -- so each instruction is decoded, and each callee's leaf test
 * made, once for all of them: a loading phase's regions call the same small
 * functions, and each region decoded every callee again to test it.
 *
 * @typedef {{ decoded: Map<number, import('./decode/decoder.js').Instruction
 *     | import('./decode/decoder.js').Refusal>, leaves: Map<number, boolean> }} FormShared
 */

/** @returns {FormShared} */
export function formShared(){
    return { decoded: new Map(), leaves: new Map() };
}

/**
 * @param {(address: number) => number} read
 * @param {number} entry
 * @param {{ maxBlocks?: number, maxBytes?: number,
 *     translatable?: (eip: number) => boolean, leafCalls?: boolean,
 *     callTargets?: Map<number, number[]>, shared?: FormShared,
 *     helpers?: boolean | readonly import('./helpers.js').RuntimeHelper[] }} [options]
 *     leafCalls: a small leaf callee is formed into its caller (see `isLeaf`); helpers: a
 *     call to a compiler's runtime helper is formed as what it amounts to (helpers.js), those
 *     of RUNTIME_HELPERS or of the list given;
 *     callTargets:
 *     by the address of an indirect call, the callees it has been seen to go to, formed in
 *     as a direct call's small callee is -- the call compares its target with each;
 *     shared: what forming found, for other regions formed over the same bytes with the
 *     same `translatable` (`formShared`)
 * @returns {Region}
 */
export function formRegion(read, entry,
    { maxBlocks = 128, maxBytes = 8192, translatable = ()=>true, leafCalls = true,
        callTargets, shared, helpers = true } = {})
{
    /** @param {number} address */
    const decodeAt = shared === undefined ? (/** @type {number} */ address)=>decode(read, address)
        : (/** @type {number} */ address)=>{
            let decoded = shared.decoded.get(address);
            if (decoded === undefined)
            {
                decoded = decode(read, address);
                shared.decoded.set(address, decoded);
            }
            return decoded;
        };
    /** @type {Map<number, Block>} by start */
    const blocks = new Map();
    /** The starts still to decode, by how many callees deep they were reached:
     * the entry's own function first, so the callees formed into it take only
     * what the caps leave rather than cutting the caller's own loops. A callee
     * that makes calls of its own is formed into the entry's function alone,
     * a leaf into that callee too. @type {number[][]} */
    const pendingAt = [[entry], [], []];
    /** @type {Map<number, number>} */
    const depthOf = new Map([[entry, 0]]);
    /** @param {number} at @param {number} depth */
    const follow = (at, depth)=>{
        pendingAt[Math.min(depth, 2)].push(at);
        if (!((depthOf.get(at) ?? Infinity) <= depth))
        {
            depthOf.set(at, depth);
        }
    };
    const next = ()=>pendingAt.find(queue=>queue.length > 0)?.shift();
    /** @type {Map<string, number>} */
    const refused = new Map();
    /** The switch tables the region's jumps go through, read as data. @type {SwitchTable[]} */
    const tables = [];
    /** `isLeaf` by callee and form, once a region (or once for every region
     * sharing it): a function called from many places is decoded once.
     * @type {Map<number, boolean>} */
    const leaves = shared?.leaves ?? new Map();
    /** @param {number} target @param {boolean} calls */
    const leafAt = (target, calls)=>{
        const key = target * 2 + (calls ? 1 : 0);
        let leaf = leaves.get(key);
        if (leaf === undefined)
        {
            leaf = isLeaf(decodeAt, target, translatable, calls);
            leaves.set(key, leaf);
        }
        return leaf;
    };
    let bytes = 0;

    /** The block starts in address order, for `containing`'s search. @type {number[]} */
    const sorted = [];
    /** Where `at` goes in `sorted`: the first start not below it. @param {number} at */
    const place = at=>{
        let lo = 0;
        let hi = sorted.length;
        while (lo < hi)
        {
            const mid = (lo + hi) >> 1;
            if (sorted[mid] < at)
            {
                lo = mid + 1;
            }
            else
            {
                hi = mid;
            }
        }
        return lo;
    };
    /** @param {number} at */
    const addStart = at=>{
        sorted.splice(place(at), 0, at);
    };
    // Whether two blocks share a byte: a target inside an instruction another
    // block decoded, or an instruction running into a block after it. Until
    // they do, the blocks are disjoint and the one holding an address is the
    // last to start at or below it; once they do, the first block made that
    // holds it answers, as the scan in insertion order always did.
    let overlapping = false;

    /** The block that contains an address, if any. @param {number} address */
    const containing = address=>{
        if (!overlapping)
        {
            const at = place(address + 1) - 1;
            const block = at < 0 ? undefined : blocks.get(sorted[at]);
            return block !== undefined && address < block.end ? block : null;
        }
        for (const block of blocks.values())
        {
            if (address >= block.start && address < block.end)
            {
                return block;
            }
        }
        return null;
    };

    /**
     * Splits a block at an instruction boundary inside it, so the address
     * becomes a block start. Answers false when the address is not on a
     * boundary of that block (overlapping code): the target then gets a
     * block of its own, decoded afresh.
     *
     * @param {Block} block @param {number} at
     */
    const split = (block, at)=>{
        const index = block.instructions.findIndex(instruction=>instruction.eip === at);
        if (index <= 0)
        {
            return index === 0;
        }
        const tail = {
            start: at,
            end: block.end,
            instructions: block.instructions.slice(index),
            exit: block.exit,
        };
        block.end = at;
        block.instructions = block.instructions.slice(0, index);
        block.exit = { kind: 'fallthrough', targets: [at], next: at, backEdge: false };
        blocks.set(at, tail);
        addStart(at);
        return true;
    };

    for (let start = next(); start !== undefined; start = next())
    {
        const depth = depthOf.get(start) ?? 0;
        if (blocks.has(start))
        {
            continue;
        }
        const inside = containing(start);
        if (inside && split(inside, start))
        {
            continue;
        }
        if (inside)
        {
            overlapping = true;
        }
        if (blocks.size >= maxBlocks || !translatable(start))
        {
            // Not followed: whoever jumps here exits to the runtime.
            continue;
        }
        /** @type {Block} */
        const block = {
            start, end: start, instructions: [],
            exit: { kind: 'cut', targets: [], next: start, backEdge: false },
        };
        blocks.set(start, block);
        addStart(start);
        let eip = start;
        for (;;)
        {
            if (eip !== start && (blocks.has(eip) || containing(eip)))
            {
                // Ran into a block already decoded: fall through to it.
                block.exit = { kind: 'fallthrough', targets: [eip], next: eip, backEdge: false };
                follow(eip, depth);
                break;
            }
            if (bytes >= maxBytes)
            {
                block.exit = { kind: 'cut', targets: [], next: eip, backEdge: false };
                break;
            }
            const decoded = decodeAt(eip);
            const called = !('refused' in decoded) && helpers !== false && decoded.op === 'call'
                && decoded.operands[0].kind === 'rel'
                ? /** @type {number} */ (decoded.operands[0].target) : -1;
            const helper = called >= 0 && translatable(called)
                ? helperAt(read, called, helpers === true ? RUNTIME_HELPERS
                    : /** @type {readonly import('./helpers.js').RuntimeHelper[]} */ (helpers))
                : null;
            if (helper !== null && !('refused' in decoded))
            {
                // A compiler's runtime helper: its call is formed as the
                // instructions it amounts to, and the block goes on (helpers.js).
                block.instructions.push(...helperInstructions(helper, decoded, called));
                bytes += decoded.length;
                eip = (eip + decoded.length) >>> 0;
                block.end = eip;
                continue;
            }
            if ('refused' in decoded)
            {
                refused.set(decoded.opcode, (refused.get(decoded.opcode) ?? 0) + 1);
                block.exit = {
                    kind: 'refused', targets: [], next: eip, backEdge: false, refusal: decoded,
                };
                break;
            }
            // Two all-zero instructions in a row (`add [eax], al` twice) are
            // a page's zero fill, not code: a region that walked past a call
            // that never returns would otherwise decode a page of it.
            if (decoded.length === 2 && read(decoded.eip) === 0 && read(decoded.eip + 1) === 0)
            {
                const previous = block.instructions[block.instructions.length - 1];
                if (previous && previous.length === 2 && read(previous.eip) === 0
                    && read(previous.eip + 1) === 0)
                {
                    block.instructions.pop();
                    block.end = previous.eip;
                    bytes -= previous.length;
                    refused.set('00 00', (refused.get('00 00') ?? 0) + 1);
                    block.exit = {
                        kind: 'refused', targets: [], next: previous.eip, backEdge: false,
                        refusal: {
                            refused: true, eip: previous.eip, opcode: '00 00', reason: 'zero fill',
                        },
                    };
                    break;
                }
            }
            block.instructions.push(decoded);
            bytes += decoded.length;
            // A block that starts inside this instruction's bytes shares them.
            const after = place(decoded.eip + 1);
            if (after < sorted.length && sorted[after] < decoded.eip + decoded.length)
            {
                overlapping = true;
            }
            eip = (eip + decoded.length) >>> 0;
            block.end = eip;
            const exit = exitOf(decoded, eip);
            if (exit === null)
            {
                continue;
            }
            block.exit = exit;
            const table = exit.kind === 'indirect' ? switchTable(read, block, blocks.values())
                : null;
            if (table !== null)
            {
                // The cases join the region in the table's order: a switch's
                // jump becomes a branch among them.
                exit.table = table;
                exit.targets = [...new Set(table.entries)];
                tables.push(table);
                for (const target of exit.targets)
                {
                    follow(target, depth);
                }
            }
            else if (!TERMINAL.has(exit.kind))
            {
                // The fall-through first, so a capped region keeps the code
                // that follows in address order rather than a far target.
                for (const target of [...exit.targets].reverse())
                {
                    follow(target, depth);
                }
            }
            else if (exit.kind === 'call' || exit.kind === 'trap'
                || block.instructions[block.instructions.length - 1]?.op === 'call')
            {
                // The callee's return lands after the call, direct or through
                // a register or a table, and the host's trap resumes after
                // the port write: a block there lets the return come back
                // into translated code.
                follow(exit.next, depth);
                const predicted = exit.kind === 'indirect' ? callTargets?.get(decoded.eip)
                    : undefined;
                if (leafCalls && predicted !== undefined && predicted.length > 0)
                {
                    exit.predicted = true;
                    exit.targets = [...predicted];
                }
                for (const callee of leafCalls ? calleesOf(exit) : [])
                {
                    // A small callee is formed into its caller: the call
                    // becomes a jump inside the region, and its return, when
                    // it comes back to this call's return address, one too.
                    if (leafAt(callee, depth === 0))
                    {
                        follow(callee, depth + 1);
                    }
                }
            }
            break;
        }
    }

    const ordered = [...blocks.values()].sort((a, b)=>a.start - b.start);
    const pages = new Set();
    for (const block of ordered)
    {
        for (const target of block.exit.targets)
        {
            if (blocks.has(target) && target <= block.start)
            {
                block.exit.backEdge = true;
            }
        }
        // Each page the block spans, in address order, once: the set of every
        // byte's page, without a set operation a byte.
        if (block.end > block.start)
        {
            for (let page = block.start >>> 12; page <= (block.end - 1) >>> 12; page++)
            {
                pages.add(page);
            }
        }
    }
    // A runtime helper a call was formed as decides the code as its bytes do:
    // they are the region's, so a write to them drops it.
    for (const { address, length } of helpersOf(ordered))
    {
        for (let page = address >>> 12; page <= (address + length - 1) >>> 12; page++)
        {
            pages.add(page);
        }
    }
    // A table's entries decide the region's blocks: they are hashed with the
    // code, and their pages are the region's, so a region is formed again --
    // on a worker, from copies of its pages -- from the same entries.
    for (const table of tables)
    {
        const end = table.address + table.entries.length * 4;
        for (let page = table.address >>> 12; end > table.address && page <= (end - 1) >>> 12;
            page++)
        {
            pages.add(page);
        }
    }
    return {
        entry,
        blocks: ordered,
        entries: ordered.map(block=>block.start),
        bytes,
        pages,
        tables,
        hash: hashRegion(read, { blocks: ordered, tables }),
        refused,
    };
}

/**
 * The runtime helpers the region's calls were formed as, each once, by address.
 *
 * @param {Block[]} blocks
 * @returns {{ address: number, length: number }[]}
 */
function helpersOf(blocks){
    /** @type {Map<number, { address: number, length: number }>} */
    const found = new Map();
    for (const block of blocks)
    {
        for (const instruction of block.instructions)
        {
            if (instruction.helper !== undefined)
            {
                found.set(instruction.helper.address, instruction.helper);
            }
        }
    }
    return [...found.values()].sort((a, b)=>a.address - b.address);
}

/**
 * A region's hash, over what decides its code: its blocks' bytes in address
 * order, the callees its predictions name and its switch tables' entries. Two
 * FNV lanes, 64 bits: the hash is what a stored translation is found by, and a
 * store -- a bundle's seed above all, made on another machine from a build of
 * the program that may differ -- must not answer for other bytes at the same
 * entry. Thirty-two bits met that at one pair in four billion, and a birthday
 * search finds such a pair in a second. Read again later, it tells a region
 * whose code was written since it was formed from one that still fits.
 *
 * @param {(address: number) => number} read
 * @param {{ blocks: Block[], tables?: SwitchTable[] }} region  its blocks in address order
 * @returns {string}
 */
export function hashRegion(read, { blocks, tables = [] }){
    let low = 0x811c9dc5;
    let high = 0x050c5d1f;
    let at = 0;
    /** @param {number} byte */
    const mix = byte=>{
        low = Math.imul(low ^ byte, 0x01000193);
        high = Math.imul(high ^ byte ^ at++ & 0xff, 0x01000193);
    };
    for (const block of blocks)
    {
        for (let address = block.start; address < block.end; address++)
        {
            mix(read(address));
        }
    }
    // A prediction decides blocks as a table does: its callees are hashed too.
    for (const block of blocks)
    {
        for (const target of block.exit.predicted ? block.exit.targets : [])
        {
            for (let shift = 0; shift < 32; shift += 8)
            {
                mix(target >>> shift & 0xff);
            }
        }
    }
    for (const table of tables)
    {
        const end = table.address + table.entries.length * 4;
        for (let address = table.address; address < end; address++)
        {
            mix(read(address));
        }
    }
    for (const { address, length } of helpersOf(blocks))
    {
        // Tagged, so the same bytes formed in as a leaf callee are keyed apart.
        mix(0x48);
        for (let byte = address; byte < address + length; byte++)
        {
            mix(read(byte));
        }
    }
    return (high >>> 0).toString(16).padStart(8, '0') + (low >>> 0).toString(16).padStart(8, '0');
}

/**
 * How an instruction ends a block, or null when it does not.
 *
 * @param {import('./decode/decoder.js').Instruction} instruction
 * @param {number} next
 * @returns {Block['exit'] | null}
 */
function exitOf(instruction, next){
    const { op, operands, cc, faults } = instruction;
    /** @param {ExitKind} kind @param {number[]} targets */
    const exit = (kind, targets)=>({ kind, targets, next, backEdge: false });
    if (faults === 'halt')
    {
        return exit('hlt', []);
    }
    if (faults === 'invalid')
    {
        return exit('fault', []);
    }
    if (faults === 'trap')
    {
        return exit('trap', []);
    }
    const target = operands[0]?.target ?? 0;
    switch (op)
    {
        case 'jmp':
            return operands[0].kind === 'rel'
                ? exit('jump', [target])
                : exit('indirect', []);
        case 'call':
            return operands[0].kind === 'rel'
                ? exit('call', [target])
                : exit('indirect', []);
        case 'ret':
            return exit('ret', []);
        case 'loop': case 'loope': case 'loopne': case 'jecxz':
            return exit('loop', [target, next]);
        default:
            if (cc !== undefined && op.startsWith('j'))
            {
                return exit('jcc', [target, next]);
            }
            return null;
    }
}
