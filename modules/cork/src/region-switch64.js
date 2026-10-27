/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The switch tables of long-mode code, as `region.js`'s `switchTable` finds
 * them at 32 bits: where a block's indirect jump goes through a table the
 * compiler laid out, read as data when the region is formed, so the cases
 * join the region and the jump becomes a branch among them. What was read is
 * checked, not trusted: the jump still goes where the instruction computes,
 * and a case is taken only where that is the case read, so a table read
 * wrong, or written since, sends the jump out of the region, never astray.
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
 * widened from (`movsxd`, `mov`) at the block's start -- or the mask the
 * block itself takes the index's low bits with (`x & 7`), every case in the
 * table.
 */

/** What may stand between the bound test and the table read: a write to another register. */
const PLAIN_WRITES = new Set([
    'mov', 'movzx', 'movsx', 'movsxd', 'lea', 'add', 'sub', 'and', 'or', 'xor', 'inc', 'dec', 'not',
    'neg', 'shl', 'shr', 'sar', 'imul',
]);

/**
 * @typedef {import('./decode/decoder.js').Instruction} Instruction
 * @typedef {import('./decode/decoder.js').Operand} Operand
 * @typedef {import('./region.js').Block} Block
 * @typedef {import('./region.js').SwitchTable} SwitchTable
 */

/** Whether an instruction writes a register other than `reg` only. @param {Instruction} one @param {number} reg */
const leaves = (one, reg)=>PLAIN_WRITES.has(one.op) && one.operands[0]?.kind === 'reg'
    && one.operands[0].reg !== reg && !(one.op === 'imul' && one.operands.length === 1);

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
 * @param {number} most
 * @returns {number}  0 where none is found
 */
function boundOf(block, blocks, tested, most){
    const held = registersOf(tested);
    for (const guard of blocks)
    {
        const { instructions } = guard;
        const branch = instructions[instructions.length - 1];
        if (guard.exit.kind !== 'jcc' || branch === undefined)
        {
            continue;
        }
        const { targets, next } = guard.exit;
        const bounding = (branch.op === 'ja' || branch.op === 'jae') && next === block.start
            || (branch.op === 'jbe' || branch.op === 'jb') && targets[0] === block.start;
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
        if (count > 0 && count <= most)
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
 * The entries a switch's index masked in its own block allows: `and i, m` --
 * a dword one zero-extends the register -- with only writes to other
 * registers after it up to the table's read, m + 1 entries; 0 where there is
 * no such mask or it allows more than `most`.
 *
 * @param {Instruction[]} instructions @param {number} index @param {number} upTo
 * @param {number} most
 */
function maskedCount(instructions, index, upTo, most){
    for (let at = upTo - 1; at >= 0; at--)
    {
        const one = instructions[at];
        const [into, by] = one.operands;
        if (one.op === 'and' && into?.kind === 'reg' && into.reg === index && into.size >= 4
            && by?.kind === 'imm')
        {
            const mask = Number(by.value);
            return mask >= 0 && mask < most ? mask + 1 : 0;
        }
        if (!leaves(one, index))
        {
            return 0;
        }
    }
    return 0;
}

/**
 * A long-mode block's switch table, or null where its jump goes through none
 * this reads.
 *
 * @param {(address: number) => number} read
 * @param {Block} block  its last instruction the jump
 * @param {Iterable<Block>} blocks  the region's blocks so far
 * @param {number} most  entries a table may have
 * @param {((reg: number) => number | null) | undefined} baseOf  a register's value as the
 *     region is formed, for a table base set before the block and outside the region:
 *     only where the region is formed where it runs, never on a worker forming it again
 * @returns {SwitchTable | null}
 */
export function switchTable64(read, block, blocks, most, baseOf){
    // Looked through more than once: for the base's lea, then for the bound.
    const all = [...blocks];
    const { instructions } = block;
    const jump = instructions[instructions.length - 1];
    if (jump.op !== 'jmp')
    {
        return null;
    }
    /** @param {number} at */
    const dword = at=>(read(at) | read(at + 1) << 8 | read(at + 2) << 16
        | read(at + 3) << 24) >>> 0;
    const [operand] = jump.operands;
    if (operand.kind === 'mem')
    {
        if (operand.size !== 8 || (operand.base ?? -1) >= 0 || (operand.index ?? -1) < 0
            || operand.scale !== 8 || operand.rip || operand.addressSize !== 64
            || operand.segment === 4 || operand.segment === 5 || (operand.disp ?? 0) < 0
            || (operand.disp ?? 0) >= 2 ** 32)
        {
            return null;
        }
        const index = /** @type {number} */ (operand.index);
        const tested = testedOf(instructions, index, instructions.length - 1);
        const count = maskedCount(instructions, index, instructions.length - 1, most)
            || (tested === null ? 0 : boundOf(block, all, tested, most));
        const address = /** @type {number} */ (operand.disp);
        const entries = [];
        for (let i = 0; i < count; i++)
        {
            if (dword(address + i * 8 + 4) !== 0)
            {
                return null;
            }
            entries.push(dword(address + i * 8));
        }
        return count > 0 ? { index, address, entries, entrySize: 8 } : null;
    }
    return relativeTable(block, all, dword, most, baseOf);
}

/**
 * `jmp r` after `r = load32(b + i*4 + d) + b`, b a `lea b, [rip + x]` of the
 * block, or set before it: the doubleword tables, signed (`movsxd`) or not (`mov`).
 *
 * @param {Block} block @param {Block[]} blocks
 * @param {(at: number) => number} dword @param {number} most
 * @param {((reg: number) => number | null) | undefined} baseOf
 * @returns {SwitchTable | null}
 */
function relativeTable(block, blocks, dword, most, baseOf){
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
    /** @type {number | null} */
    let baseValue;
    if (lea >= 0)
    {
        const made = instructions[lea];
        if (made.op !== 'lea' || !made.operands[1].rip || made.operands[0].size !== 8)
        {
            return null;
        }
        baseValue = /** @type {number} */ (made.operands[1].disp);
    }
    else
    {
        // Set before the block, as Clang hoists it out of an interpreter's
        // loop: the one lea of it among the region's blocks, else what the
        // register holds as the region is formed. Either is a guess the
        // dispatch checks, a case taken only where the jump goes to it.
        const leas = new Set(blocks.flatMap(one=>one.instructions)
            .filter(one=>one.op === 'lea' && one.operands[0]?.kind === 'reg'
                && one.operands[0].reg === base && one.operands[0].size === 8
                && one.operands[1].rip)
            .map(one=>/** @type {number} */ (one.operands[1].disp)));
        baseValue = leas.size === 1 ? [...leas][0] : baseOf?.(base) ?? null;
    }
    if (baseValue === null || baseValue < 0 || baseValue >= 2 ** 32)
    {
        return null;
    }
    // The index as the load used it stays where the jump is made, or is the
    // load's own register, kept from before it.
    if (!instructions.slice(at + 1, -2).every(one=>leaves(one, base) && leaves(one, r)
        && leaves(one, index)))
    {
        return null;
    }
    const tested = testedOf(instructions, index, at);
    const count = maskedCount(instructions, index, at, most)
        || (tested === null ? 0 : boundOf(block, blocks, tested, most));
    const address = baseValue + (from.disp ?? 0);
    if (count === 0 || address < 0 || address + count * 4 > 2 ** 32)
    {
        return null;
    }
    const entries = [];
    for (let i = 0; i < count; i++)
    {
        const entry = dword(address + i * 4);
        const landing = baseValue + (signed ? entry | 0 : entry);
        if (landing < 0 || landing >= 2 ** 32)
        {
            return null;
        }
        entries.push(landing);
    }
    return { index, address, entries, entrySize: 4,
        ...r === index ? { before: load.eip } : {} };
}
