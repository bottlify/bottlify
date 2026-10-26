/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The cases of a long-mode switch: where a block's indirect jump goes through
 * a table the compiler laid out, read as data when the region is formed, so
 * the cases join the region and the jump becomes a branch among them by its
 * index (`emit.js`'s `dispatch`), as the 32-bit translator's `switchTable`
 * does at 32 bits. What was read is checked, not trusted: the jump still goes
 * where the instruction computes, and a case's branch is taken only where
 * that is the case read, so a table read wrong, or written since, sends the
 * jump out of the region, never astray.
 *
 * Two shapes, the ones x64 compilers lay a switch out in:
 *
 *   jmp [table + i*8]                     absolute quadwords (GCC, no PIC)
 *   lea b, [rip + x] ... mov(sxd) r, [b + i*4 + d] ... add r, b ... jmp r
 *                                         doublewords from a base: the image
 *                                         base and an RVA (MSVC), or the table
 *                                         itself and an offset (MinGW, PIC)
 *
 * The table's length is the bound the compiler tests the index against on
 * the way into the block: `cmp x, n` then `ja`/`jae` falling through to it,
 * or `jbe`/`jb` taken to it, x the index register or the register it was
 * widened from (`movsxd`, `mov`) at the block's start.
 */

/** The most entries a switch's table is read for, as at 32 bits. */
const MOST = 1024;

/** What may stand between the bound test and the table read: a write to another register. */
const PLAIN_WRITES = new Set([
    'mov', 'movzx', 'movsx', 'movsxd', 'lea', 'add', 'sub', 'and', 'or', 'xor', 'inc', 'dec', 'not',
    'neg', 'shl', 'shr', 'sar', 'imul',
]);

/**
 * @typedef {import('../decode/decoder.js').Instruction} Instruction
 * @typedef {{ entry: number, instructions: Instruction[] }} Block
 */

/** Whether an instruction writes a register other than `reg` only. @param {Instruction} one @param {number} reg */
const leaves = (one, reg)=>PLAIN_WRITES.has(one.op) && one.operands[0]?.kind === 'reg'
    && one.operands[0].reg !== reg && !(one.op === 'imul' && one.operands.length === 1);

/**
 * @typedef {import('../decode/decoder.js').Operand} Operand
 */

/** The registers an operand is made of. @param {Operand} operand */
const registersOf = operand=>(operand.kind === 'reg' ? [Number(operand.reg)]
    : [operand.base ?? -1, operand.index ?? -1].filter(reg=>reg >= 0));

/** Whether a compare's operand is the tested one. @param {Operand} a @param {Operand} b */
const same = (a, b)=>(a.kind === 'reg' ? b.kind === 'reg' && a.reg === b.reg && b.size >= 4
    : a.kind === 'mem' && b.kind === 'mem' && a.size === b.size && a.base === b.base
        && (a.index ?? -1) === (b.index ?? -1) && (a.scale ?? 1) === (b.scale ?? 1)
        && (a.disp ?? 0) === (b.disp ?? 0) && a.segment === b.segment && !a.rip && !b.rip);

/**
 * The bound a block's index is tested against on some way in, as a count of
 * entries: a guard among `blocks` whose last flag writer is `cmp tested, n`
 * and whose branch reaches the block only where the index is below the
 * bound, with only writes to other registers between.
 *
 * @param {Block} block @param {Iterable<Block>} blocks @param {Operand} tested
 * @returns {number}  0 where none is found
 */
function boundOf(block, blocks, tested){
    const held = registersOf(tested);
    for (const guard of blocks)
    {
        const { instructions } = guard;
        const branch = instructions[instructions.length - 1];
        const target = branch.operands[0]?.kind === 'rel' ? branch.operands[0].target : -1;
        const next = branch.eip + branch.length;
        const bounding = (branch.op === 'ja' || branch.op === 'jae') && next === block.entry
            || (branch.op === 'jbe' || branch.op === 'jb') && target === block.entry;
        if (!bounding)
        {
            continue;
        }
        let at = instructions.length - 2;
        while (at >= 0 && instructions[at].flagsWritten === 0)
        {
            at--;
        }
        const compare = instructions[at];
        const [left, right] = compare?.operands ?? [];
        if (compare?.op !== 'cmp' || right?.kind !== 'imm' || left === undefined
            || !same(tested, left))
        {
            continue;
        }
        if (!instructions.slice(at + 1, -1).every(one=>held.every(reg=>leaves(one, reg))))
        {
            continue;
        }
        const bound = Number(right.value) >>> 0;
        const count = branch.op === 'ja' || branch.op === 'jbe' ? bound + 1 : bound;
        if (count > 0 && count <= MOST)
        {
            return count;
        }
    }
    return 0;
}

/**
 * What the bound test compares: the register or the memory the index was
 * loaded or widened from in the block (`movsxd i, j`, `mov i32, j32`,
 * `mov i32, [m]`), else the index register itself; null where something else
 * writes what it is made of before the table is read.
 *
 * @param {Instruction[]} instructions @param {number} index @param {number} upTo
 * @returns {Operand | null}
 */
function testedOf(instructions, index, upTo){
    for (let at = 0; at < upTo; at++)
    {
        const [into, from] = instructions[at].operands;
        if ((instructions[at].op === 'movsxd' || instructions[at].op === 'mov')
            && into?.kind === 'reg' && into.reg === index && from?.size === 4
            && (from.kind === 'reg' || from.kind === 'mem' && !from.rip))
        {
            const made = registersOf(from);
            return instructions.slice(at + 1, upTo).every(one=>leaves(one, index))
                && instructions.slice(0, at).every(one=>made.every(reg=>leaves(one, reg)))
                ? from : null;
        }
    }
    return instructions.slice(0, upTo).every(one=>leaves(one, index))
        ? { kind: 'reg', size: 8, reg: index } : null;
}

/**
 * A block's switch, where its indirect jump goes through a table: the
 * register holding the index when the jump is made, and the case addresses
 * by index; null where it does not, or where the table cannot be read.
 *
 * @typedef {{ index: number, cases: number[] }} Switch
 *
 * @param {Block} block @param {Iterable<Block>} blocks  the region's blocks so far
 * @param {(address: number) => number} read  a byte of guest memory; throws where it cannot
 * @returns {Switch | null}
 */
export function switchCases(block, blocks, read){
    const { instructions } = block;
    const jump = instructions[instructions.length - 1];
    if (jump.op !== 'jmp')
    {
        return null;
    }
    const [operand] = jump.operands;
    /** @param {number} at @param {number} size */
    const word = (at, size)=>{
        let value = 0;
        for (let i = size - 1; i >= 0; i--)
        {
            value = value * 256 + read(at + i);
        }
        return value;
    };
    try
    {
        if (operand.kind === 'mem')
        {
            if (operand.size !== 8 || (operand.base ?? -1) >= 0 || (operand.index ?? -1) < 0
                || operand.scale !== 8 || operand.rip || operand.addressSize !== 64
                || operand.segment === 4 || operand.segment === 5)
            {
                return null;
            }
            const index = /** @type {number} */ (operand.index);
            const tested = testedOf(instructions, index, instructions.length - 1);
            const count = tested === null ? 0 : boundOf(block, blocks, tested);
            const table = (operand.disp ?? 0) >>> 0;
            const cases = [];
            for (let i = 0; i < count; i++)
            {
                const high = word(table + i * 8 + 4, 4);
                if (high !== 0)
                {
                    return null;
                }
                cases.push(word(table + i * 8, 4));
            }
            return count > 0 ? { index, cases } : null;
        }
        return relativeCases(block, blocks, word);
    }
    catch {
        return null;
    }
}

/**
 * `jmp r` after `r = load32(b + i*4 + d) + b`, b a `lea b, [rip + x]` of the
 * block: the doubleword tables, signed (`movsxd`) or not (`mov`).
 *
 * @param {Block} block @param {Iterable<Block>} blocks
 * @param {(at: number, size: number) => number} word
 * @returns {Switch | null}
 */
function relativeCases(block, blocks, word){
    const { instructions } = block;
    const jump = instructions[instructions.length - 1];
    const [target] = jump.operands;
    if (target.kind !== 'reg' || target.size !== 8)
    {
        return null;
    }
    const r = /** @type {number} */ (target.reg);
    // add r, b just before the jump
    let at = instructions.length - 2;
    const add = instructions[at];
    const [sum, addend] = add?.operands ?? [];
    if (add?.op !== 'add' || sum?.kind !== 'reg' || sum.reg !== r || sum.size !== 8
        || addend?.kind !== 'reg' || addend.size !== 8)
    {
        return null;
    }
    const base = /** @type {number} */ (addend.reg);
    // the load into r
    at--;
    while (at >= 0 && leaves(instructions[at], r) && instructions[at].operands[0].reg !== base)
    {
        at--;
    }
    const load = instructions[at];
    const [into, from] = load?.operands ?? [];
    const signed = load?.op === 'movsxd';
    if (!(signed || load?.op === 'mov') || into?.kind !== 'reg' || into.reg !== r
        || from?.kind !== 'mem' || from.size !== 4 || from.base !== base || from.scale !== 4
        || (from.index ?? -1) < 0 || from.addressSize !== 64 || from.segment === 4
        || from.segment === 5)
    {
        return null;
    }
    const index = /** @type {number} */ (from.index);
    // the base's lea, before the load, with nothing writing the base between
    let lea = at - 1;
    while (lea >= 0 && !(instructions[lea].operands[0]?.kind === 'reg'
        && instructions[lea].operands[0].reg === base))
    {
        lea--;
    }
    const made = instructions[lea];
    if (made?.op !== 'lea' || !made.operands[1].rip || made.operands[0].size !== 8)
    {
        return null;
    }
    const baseValue = /** @type {number} */ (made.operands[1].disp) >>> 0;
    // The index as the load used it stays where the jump is made.
    if (!instructions.slice(at + 1, -2).every(one=>leaves(one, base) && leaves(one, r)
        && leaves(one, index)) || r === index)
    {
        return null;
    }
    const tested = testedOf(instructions, index, at);
    const count = tested === null ? 0 : boundOf(block, blocks, tested);
    const table = baseValue + (from.disp ?? 0);
    const cases = [];
    for (let i = 0; i < count; i++)
    {
        const entry = word(table + i * 4, 4);
        const offset = signed ? entry | 0 : entry;
        const address = baseValue + offset;
        if (address < 0 || address >= 2 ** 32)
        {
            return null;
        }
        cases.push(address);
    }
    return count > 0 ? { index, cases } : null;
}
