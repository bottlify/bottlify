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
 * @param {(address: number) => number} read @param {number} target
 * @param {(eip: number) => boolean} translatable @param {boolean} [calls]
 */
function isLeaf(read, target, translatable, calls = false){
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
            const decoded = decode(read, eip);
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
 * @param {(address: number) => number} read
 * @param {number} entry
 * @param {{ maxBlocks?: number, maxBytes?: number,
 *     translatable?: (eip: number) => boolean, leafCalls?: boolean,
 *     callTargets?: Map<number, number[]> }} [options]
 *     leafCalls: a small leaf callee is formed into its caller (see `isLeaf`); callTargets:
 *     by the address of an indirect call, the callees it has been seen to go to, formed in
 *     as a direct call's small callee is -- the call compares its target with each
 * @returns {Region}
 */
export function formRegion(read, entry,
    { maxBlocks = 128, maxBytes = 8192, translatable = ()=>true, leafCalls = true,
        callTargets } = {})
{
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
    /** `isLeaf` by callee and form, once a region: a function called from many
     * places is decoded once. @type {Map<string, boolean>} */
    const leaves = new Map();
    /** @param {number} target @param {boolean} calls */
    const leafAt = (target, calls)=>{
        const key = `${target}:${calls}`;
        let leaf = leaves.get(key);
        if (leaf === undefined)
        {
            leaf = isLeaf(read, target, translatable, calls);
            leaves.set(key, leaf);
        }
        return leaf;
    };
    let bytes = 0;

    /** The block that contains an address, if any. @param {number} address */
    const containing = address=>{
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
            const decoded = decode(read, eip);
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
    let hash = 0x811c9dc5;
    for (const block of ordered)
    {
        for (const target of block.exit.targets)
        {
            if (blocks.has(target) && target <= block.start)
            {
                block.exit.backEdge = true;
            }
        }
        for (let address = block.start; address < block.end; address++)
        {
            hash = Math.imul(hash ^ read(address), 0x01000193) >>> 0;
            pages.add(address >>> 12);
        }
    }
    // A prediction decides blocks as a table does: its callees are hashed too.
    for (const block of ordered)
    {
        for (const target of block.exit.predicted ? block.exit.targets : [])
        {
            for (let shift = 0; shift < 32; shift += 8)
            {
                hash = Math.imul(hash ^ (target >>> shift & 0xff), 0x01000193) >>> 0;
            }
        }
    }
    // A table's entries decide the region's blocks: they are hashed with the
    // code, and their pages are the region's, so a region is formed again --
    // on a worker, from copies of its pages -- from the same entries.
    for (const table of tables)
    {
        const end = table.address + table.entries.length * 4;
        for (let address = table.address; address < end; address++)
        {
            hash = Math.imul(hash ^ read(address), 0x01000193) >>> 0;
            pages.add(address >>> 12);
        }
    }
    return {
        entry,
        blocks: ordered,
        entries: ordered.map(block=>block.start),
        bytes,
        pages,
        hash: hash.toString(16).padStart(8, '0'),
        refused,
    };
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
