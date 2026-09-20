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
 *              refusal?: import('./decode/decoder.js').Refusal }} exit
 */

/**
 * @typedef {Object} Region
 * @property {number} entry
 * @property {Block[]} blocks            in address order; the entry's block first by address
 *                                       is not guaranteed -- find it by `entry`
 * @property {number[]} entries          every block start
 * @property {number} bytes
 * @property {Set<number>} pages         4 KiB pages the code spans
 * @property {string} hash               of the decoded bytes, for the cache
 * @property {Map<string, number>} refused   opcode → times a refusal cut a block
 */

/** Exits that end a block and are not followed into another block of this region. */
const TERMINAL = new Set(['ret', 'indirect', 'call', 'trap', 'hlt', 'refused', 'fault']);

/**
 * @param {(address: number) => number} read
 * @param {number} entry
 * @param {{ maxBlocks?: number, maxBytes?: number,
 *     translatable?: (eip: number) => boolean }} [options]
 * @returns {Region}
 */
export function formRegion(read, entry,
    { maxBlocks = 64, maxBytes = 8192, translatable = ()=>true } = {})
{
    /** @type {Map<number, Block>} by start */
    const blocks = new Map();
    /** @type {number[]} */
    const pending = [entry];
    /** @type {Map<string, number>} */
    const refused = new Map();
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

    while (pending.length > 0)
    {
        const start = /** @type {number} */ (pending.shift());
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
                pending.push(eip);
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
            if (!TERMINAL.has(exit.kind))
            {
                // The fall-through first, so a capped region keeps the code
                // that follows in address order rather than a far target.
                for (const target of [...exit.targets].reverse())
                {
                    pending.push(target);
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
