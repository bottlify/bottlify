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
 *              table?: SwitchTable, predicted?: boolean, apart?: Apart }} exit
 *   an `indirect` exit through a switch's table of addresses carries the table,
 *   and its distinct targets as `targets`; an indirect call the runtime has
 *   seen go to a few callees (`callTargets`) is `predicted`, those callees its
 *   `targets`; a call whose callee forming did not take in says why (`apart`)
 */

/**
 * @typedef {'blocks' | 'bytes' | 'shape' | 'nested' | 'unpredicted'} Apart
 *   why a call's callee was not formed into its caller, for a profiling run's
 *   counts: more blocks or bytes than a callee formed in may have; a way out of
 *   it other than a `ret` and direct branches (an indirect jump or call, a
 *   trap, a refusal, a page not to translate); a call of its own inside a
 *   callee already formed in; an indirect call with no callee predicted
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
 * @property {Set<number>} [reads]       every page forming read, `pages` among them: what a
 *                                       worker forms the region again from
 * @property {Set<number>} [formable]    every page forming was told it may form code on: the
 *                                       ones a worker forming it again may, and no others
 * @property {SwitchTable[]} [tables]    the switch tables its jumps go through, read as data
 * @property {string} hash               of the decoded bytes, for the cache
 * @property {{ start: number, bytes: Uint8Array }[]} [sources]  every byte forming read, as
 *                                       it read them: its blocks, and what it looked at past
 *                                       them -- a callee, a jump's target, a table
 *                                       (`sourcesOf`)
 * @property {Map<string, number>} refused   opcode → times a refusal cut a block
 */

/** Exits that end a block and are not followed into another block of this region. */
const TERMINAL = new Set(['ret', 'indirect', 'call', 'trap', 'hlt', 'refused', 'fault']);

/** The callee a direct call is formed into its caller with, at most: a leaf,
 * or one with direct calls of its own (formed one level deep). */
const LEAF_BLOCKS = 16;
const LEAF_BYTES = 512;
/** How large a callee formed into its caller may be, unless forming says otherwise. */
const LEAF_LIMITS = Object.freeze({ blocks: LEAF_BLOCKS, bytes: LEAF_BYTES });
/** Past the caps, for the callees the runtime predicted: four of the largest leaves. */
const PREDICTED_ROOM = Object.freeze({ blocks: 4 * LEAF_BLOCKS, bytes: 4 * LEAF_BYTES });
const NO_ROOM = Object.freeze({ blocks: 0, bytes: 0 });

/**
 * Whether the function at `target` is small enough to form into its caller:
 * a few blocks reached by direct branches alone, every way out of them a
 * `ret`. Only a guess at the shape -- a return is still checked against the
 * return address at run time -- so anything else (an indirect jump, a trap,
 * a refusal, a page not to translate) answers no; so does a direct call in
 * it unless `calls`, when the callee's own callees leave through the hash as
 * any call does and come back to the block after their call. Answers null
 * for yes, and for no why not (`Apart`).
 *
 * @param {(address: number) => import('./decode/decoder.js').Instruction
 *     | import('./decode/decoder.js').Refusal} decodeAt
 * @param {number} target
 * @param {(eip: number) => boolean} translatable @param {boolean} [calls]
 * @param {{ blocks: number, bytes: number }} [limits]  its blocks and bytes at most
 * @returns {Apart | null}
 */
function isLeaf(decodeAt, target, translatable, calls = false, limits = LEAF_LIMITS){
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
        if (seen.size >= limits.blocks)
        {
            return 'blocks';
        }
        if (!translatable(start))
        {
            return 'shape';
        }
        seen.add(start);
        for (let eip = start; ;)
        {
            const decoded = decodeAt(eip);
            if ('refused' in decoded)
            {
                return 'shape';
            }
            bytes += decoded.length;
            if (bytes > limits.bytes)
            {
                return 'bytes';
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
            // A jump through a register or memory leaves through the entry hash
            // from wherever it stands -- a thunk forwarding to a virtual
            // function, a switch's table -- and what it reaches returns past
            // the call as the callee would have: the path ends there, as at a `ret`.
            if (exit.kind === 'ret' || (exit.kind === 'indirect' && decoded.op === 'jmp'))
            {
                break;
            }
            // A call through a register or memory -- a virtual call, the most
            // of what a C++ setter or accessor calls -- is a call out as any
            // indirect call in a region is, and the callee around it forms in
            // as one with a direct call does.
            const call = exit.kind === 'call'
                || (exit.kind === 'indirect' && decoded.op === 'call');
            if (calls && call && seen.size < limits.blocks)
            {
                // The return lands after the call: a block of its own.
                seen.add(eip);
                continue;
            }
            return call && seen.size < limits.blocks ? 'nested' : call ? 'blocks' : 'shape';
        }
    }
    return null;
}

/**
 * The callee of a call through a fixed slot -- `call [address]`, an import's
 * call through the import table -- when it is a leaf to form in: predicted
 * from the slot as it reads now, as the runtime predicts an indirect call
 * from the targets it sampled. The call compares the slot's value with it
 * when it runs, so a slot written since goes out as any indirect call does.
 *
 * @param {(address: number) => number} read
 * @param {import('./decode/decoder.js').Instruction} call
 * @param {(target: number, calls: boolean) => Apart | null} leafAt
 * @returns {number[] | undefined}
 */
function slotCallee(read, call, leafAt){
    const [operand] = call.operands;
    if (operand.kind !== 'mem' || operand.size !== 4 || (operand.base ?? -1) >= 0
        || (operand.index ?? -1) >= 0 || operand.segment === 4 || operand.segment === 5
        || operand.addressSize === 16)
    {
        return undefined;
    }
    const slot = (operand.disp ?? 0) >>> 0;
    const target = (read(slot) | read(slot + 1) << 8 | read(slot + 2) << 16
        | read(slot + 3) << 24) >>> 0;
    return target !== 0 && leafAt(target, false) === null ? [target] : undefined;
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
 * Whether a block ends in a call that leaves its region: a direct call whose
 * callee is not formed in, or an indirect one that no prediction or table
 * formed a callee of in. Under `callReturn` such a call is a wasm call, and
 * its return address the block's way on.
 *
 * @param {Block} block
 * @param {{ has(start: number): boolean }} starts  the region's block starts
 */
export function callsOut(block, starts){
    const { kind, targets, table, predicted } = block.exit;
    const last = block.instructions[block.instructions.length - 1];
    return kind === 'call' ? !starts.has(targets[0])
        : kind === 'indirect' && last?.op === 'call' && table === undefined && !predicted;
}

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
 * code, whose index test sends an index past the table out of the region. Or
 * the block masks the index itself, `and r, m` with only such writes after it,
 * and the table has m + 1 entries.
 *
 * @param {(address: number) => number} read @param {Block} block
 * @param {Iterable<Block>} blocks
 * @param {number} [most]  entries a table may have
 * @returns {SwitchTable | null}
 */
function switchTable(read, block, blocks, most = SWITCH_ENTRIES){
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
    /** @param {number} count */
    const tableOf = count=>{
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
    };
    // A switch on a value masked to its low bits (`x & 15`, `x % 16` unsigned)
    // has every case in its table and no bound test: the `and` in the jump's
    // own block bounds the index on every way in.
    for (let at = instructions.length - 2; at >= 0; at--)
    {
        const one = instructions[at];
        const [into, by] = one.operands;
        if (one.op === 'and' && into?.kind === 'reg' && into.size === 4 && into.reg === index
            && by?.kind === 'imm')
        {
            const count = (/** @type {number} */ (by.value) >>> 0) + 1;
            return count <= most ? tableOf(count) : null;
        }
        if (!(PLAIN_WRITES.has(one.op) && into?.kind === 'reg' && into.reg !== index
            && !(one.op === 'imul' && one.operands.length === 1)))
        {
            break;
        }
    }
    // What the bound test must have compared: the index register itself, or
    // the memory a `mov` at the block's start loads it from. Writes to other
    // registers may stand between that and the jump, where a compiler
    // schedules the code the cases share.
    /** @type {import('./decode/decoder.js').Operand} */
    let tested = { kind: 'reg', size: 4, reg: index };
    const [load] = instructions;
    const [into, from] = load.operands;
    const loads = instructions.length > 1 && load.op === 'mov' && into.kind === 'reg'
        && into.size === 4 && into.reg === index && from.kind === 'mem';
    if (loads)
    {
        tested = from;
    }
    if (!instructions.slice(loads ? 1 : 0, -1).every(one=>PLAIN_WRITES.has(one.op)
        && one.operands[0]?.kind === 'reg' && one.operands[0].reg !== index
        && !(one.op === 'imul' && one.operands.length === 1)))
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
        if (count === 0 || count > most)
        {
            continue;
        }
        return tableOf(count);
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
 *     | import('./decode/decoder.js').Refusal>, leaves: Map<number, Apart | null> }} FormShared
 */

/** @returns {FormShared} */
export function formShared(){
    return { decoded: new Map(), leaves: new Map() };
}

/**
 * @param {(address: number) => number} read
 * @param {number} entry
 * @param {{ maxBlocks?: number, maxBytes?: number, leafBlocks?: number, leafBytes?: number,
 *     formDepth?: number, predictedRoom?: { blocks: number, bytes: number },
 *     switchEntries?: number,
 *     translatable?: (eip: number) => boolean, leafCalls?: boolean,
 *     callTargets?: Map<number, number[]>, shared?: FormShared,
 *     helpers?: boolean | readonly import('./helpers.js').RuntimeHelper[] }} [options]
 *     leafCalls: a small leaf callee is formed into its caller (see `isLeaf`), of
 *     `leafBlocks` blocks and `leafBytes` bytes at most; formDepth: how many levels of
 *     callees formed in may have direct calls of their own, formed in in turn when small
 *     (1: a callee's callees leave; 0: only leaves are formed in); switchEntries: the most
 *     entries a switch's jump table is followed through; helpers: a
 *     call to a compiler's runtime helper is formed as what it amounts to (helpers.js), those
 *     of RUNTIME_HELPERS or of the list given;
 *     callTargets:
 *     by the address of an indirect call, the callees it has been seen to go to, formed in
 *     as a direct call's small callee is -- the call compares its target with each;
 *     predictedRoom: the blocks and bytes past `maxBlocks` and `maxBytes` those callees may
 *     take, all of them together: a region full of its own function is where a hot call
 *     was left out, and the runtime asks for its callees having seen it go there;
 *     shared: what forming found, for other regions formed over the same bytes with the
 *     same `translatable` (`formShared`)
 * @returns {Region}
 */
export function formRegion(read, entry,
    { maxBlocks = 128, maxBytes = 8192, translatable = ()=>true, leafCalls = true,
        callTargets, shared, helpers = true, leafBlocks = LEAF_BLOCKS, leafBytes = LEAF_BYTES,
        formDepth = 1, predictedRoom = PREDICTED_ROOM,
        switchEntries = SWITCH_ENTRIES } = {})
{
    // Every page forming reads decides what it forms -- an import slot a call is predicted
    // through, a callee looked at for a leaf or a runtime helper -- so a worker forms the
    // region again from copies of all of them (`reads`); only the pages its code is made
    // of (`pages`) drop it when written.
    const leafLimits = leafBlocks === LEAF_BLOCKS && leafBytes === LEAF_BYTES ? LEAF_LIMITS
        : { blocks: leafBlocks, bytes: leafBytes };
    /** @type {Set<number>} */
    const touched = new Set();
    let lastTouched = -1;
    // The pages `translatable` answered yes for: a worker forming the region
    // again answers the same for them and no for the rest, or its region
    // differs -- a callee looked into here and not there, a prediction made
    // here and not there -- and the batch's copy of it is refused as changed.
    /** @type {Set<number>} */
    const granted = new Set();
    const asked = translatable;
    translatable = address=>{
        const yes = asked(address);
        if (yes)
        {
            granted.add(address >>> 12);
        }
        return yes;
    };
    const source = read;
    /** The bytes read, as `[start, end)` spans in the order met. @type {[number, number][]} */
    const spans = [];
    /** @param {number} address @param {number} length */
    const noteRead = (address, length)=>{
        const last = spans[spans.length - 1];
        if (last !== undefined && address >= last[0] && address <= last[1])
        {
            last[1] = Math.max(last[1], address + length);
            return;
        }
        spans.push([address, address + length]);
    };
    read = address=>{
        const page = address >>> 12;
        if (page !== lastTouched)
        {
            lastTouched = page;
            touched.add(page);
        }
        noteRead(address, 1);
        return source(address);
    };
    /** @param {number} address */
    const decodeAt = shared === undefined ? (/** @type {number} */ address)=>decode(read, address)
        : (/** @type {number} */ address)=>{
            let decoded = shared.decoded.get(address);
            if (decoded === undefined)
            {
                decoded = decode(read, address);
                shared.decoded.set(address, decoded);
            }
            else
            {
                // Decoded for another region: its bytes are read here all the same.
                noteRead(address, 'length' in decoded ? Math.max(decoded.length, 1) : 1);
                for (let page = address >>> 12;
                    page <= (address + ('length' in decoded ? Math.max(decoded.length, 1) : 1)
                        - 1) >>> 12; page++)
                {
                    touched.add(page);
                }
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
    /** The starts reached through a callee `callTargets` named, which may take
     * `predictedRoom` past the caps. @type {Set<number>} */
    const predictedStarts = new Set();
    /** Whether the block being decoded was reached through such a callee. */
    let inPredicted = false;
    /** @param {number} at @param {number} depth */
    const follow = (at, depth)=>{
        if (inPredicted)
        {
            predictedStarts.add(at);
        }
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
     * @type {Map<number, Apart | null>} */
    const leaves = shared?.leaves ?? new Map();
    /** @param {number} target @param {boolean} calls @returns {Apart | null} */
    const leafAt = (target, calls)=>{
        const key = target * 2 + (calls ? 1 : 0);
        let leaf = leaves.get(key);
        if (leaf === undefined)
        {
            leaf = isLeaf(decodeAt, target, translatable, calls, leafLimits);
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
        inPredicted = predictedStarts.has(start);
        const room = inPredicted ? predictedRoom : NO_ROOM;
        if (blocks.size >= maxBlocks + room.blocks || !translatable(start))
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
            if (bytes >= maxBytes + room.bytes)
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
                            invalid: false,
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
            const table = exit.kind === 'indirect'
                ? switchTable(read, block, blocks.values(), switchEntries) : null;
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
            else if (exit.kind === 'call' || exit.kind === 'trap' && decoded.op !== 'int3'
                || block.instructions[block.instructions.length - 1]?.op === 'call')
            {
                // The callee's return lands after the call, direct or through
                // a register or a table, and the host's trap resumes after
                // the port write: a block there lets the return come back
                // into translated code. Not after a breakpoint: compilers pad
                // between functions with int3, and following each to the next
                // byte made a block of every byte of the padding, until the
                // region had none left for the callees it forms in.
                follow(exit.next, depth);
                const predicted = exit.kind !== 'indirect' ? undefined
                    : callTargets?.get(decoded.eip) ?? slotCallee(read, decoded, leafAt);
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
                    const apart = leafAt(callee, depth < formDepth);
                    if (apart === null)
                    {
                        if (exit.predicted === true && callTargets?.has(decoded.eip))
                        {
                            predictedStarts.add(callee);
                        }
                        follow(callee, depth + 1);
                    }
                    else
                    {
                        exit.apart ??= apart;
                    }
                }
                if (exit.kind === 'indirect' && !exit.predicted)
                {
                    exit.apart = 'unpredicted';
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
    for (const page of pages)
    {
        touched.add(page);
    }
    return {
        entry,
        blocks: ordered,
        entries: ordered.map(block=>block.start),
        bytes,
        pages,
        reads: touched,
        formable: granted,
        tables,
        hash: hashRegion(read, { blocks: ordered, tables }),
        sources: copiesOf(source, spans),
        refused,
    };
}

/**
 * The bytes of `spans`, merged where they meet, as `read` answers now.
 *
 * @param {(address: number) => number} read @param {[number, number][]} spans
 * @returns {{ start: number, bytes: Uint8Array }[]}
 */
function copiesOf(read, spans){
    const sorted = [...spans].sort((a, b)=>a[0] - b[0]);
    /** @type {[number, number][]} */
    const merged = [];
    for (const [start, end] of sorted)
    {
        const last = merged[merged.length - 1];
        if (last !== undefined && start <= last[1])
        {
            last[1] = Math.max(last[1], end);
        }
        else
        {
            merged.push([start, end]);
        }
    }
    return merged.map(([start, end])=>({ start,
        bytes: Uint8Array.from({ length: end - start }, (_, at)=>read(start + at)) }));
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
            // `call $+5` pushes its own return address and goes on to it: a
            // push, not a call -- a program's way to find its own address,
            // which ends no block. Taken as a call, its callee and its return
            // address would be one block, the target of the `ret` the callee
            // is formed in with: x87 code whose stack is deeper or shallower
            // at that `ret` than at the call would give the block two tops.
            if (operands[0].kind === 'rel' && target === next && !instruction.prefixes.operand)
            {
                return null;
            }
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
