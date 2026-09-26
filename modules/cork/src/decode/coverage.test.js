/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Coverage: every opcode and form the decoder table names must have an
 * emitter lowering and an evaluator model, or be named here as left to the
 * host by design with its reason. The test drives the real dispatchers: a
 * representative encoding of each table entry is decoded, the interpreter's
 * `evaluate` is called on it, and the emitter translates it -- a form either
 * tier stops at is reported by name. Adding a table entry without a lowering
 * or a model fails here, which is the point of the list below.
 *
 * It needs no corpus: the encodings are built from the table's own operand
 * forms, so the check runs in the fast unit set.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decode } from './decoder.js';
import { Group, ONE_BYTE, Prefixed, SYS, TWO_BYTE, X87 } from './table.js';
import { Fault, Unsupported, createState, evaluate } from '../ir.js';
import { createTestMachine } from '../testing/machine.js';

const CODE = 0x1000;
const RAM = 1 << 20;
/** The bytes a mandatory prefix is spelled with. @type {Record<string, number[]>} */
const PREFIX = { 66: [0x66], f3: [0xf3], f2: [0xf2], '': [] };

/**
 * Anything a slot of the two opcode maps or the x87 maps can hold.
 *
 * @typedef {import('./table.js').Entry | Group | Prefixed | typeof SYS | null} TableEntry
 */

/**
 * The forms a user-mode program never runs, or that this engine leaves to the
 * host on purpose, each with the reason. `hlt`, `ud2`, `int3`/`int n`/`into`,
 * `bound` and the trap port are modelled or lowered and are not here.
 *
 * @type {ReadonlyMap<string, string>}
 */
const LEFT_TO_HOST = new Map([
    ['in', 'a privileged port read; only the trap port is a user-mode program\'s (plan 4.2)'],
    ['out', 'a port write; any port but the trap port leaves for the host (plan 4.2)'],
    ['cli', 'a privileged interrupt-flag write a user-mode program never runs (plan 4.2)'],
    ['sti', 'a privileged interrupt-flag write a user-mode program never runs (plan 4.2)'],
    ['fxsave', 'the SSE environment, out of scope and ending a region (plan 3.4)'],
    ['fxrstor', 'the SSE environment, out of scope and ending a region (plan 3.4)'],
    ['fbld', 'the packed-BCD load, an environment form ending a region (plan 3.4)'],
    ['rdrand', 'the host\'s randomness, rare enough to end a region for the interpreter'],
]);

/** @param {number[]} bytes */
function tryDecode(bytes){
    const code = [...bytes, ...new Array(24).fill(0)];
    const decoded = decode(address=>code[address] ?? 0, 0);
    return 'refused' in decoded ? null : decoded;
}

/**
 * Every encoding worth trying for a table entry: a prefixed variant's keys,
 * a group's eight rows in the register and the memory modrm, and the plain
 * entry with both.
 *
 * @param {number[]} opcodeBytes
 * @param {TableEntry} entry
 * @param {string} label
 * @returns {Generator<{ bytes: number[], label: string }>}
 */
function* candidates(opcodeBytes, entry, label){
    if (entry === null || entry === SYS)
    {
        return;
    }
    if (entry instanceof Prefixed)
    {
        for (const [key, variant] of Object.entries(entry.variants))
        {
            yield* candidates([...PREFIX[key], ...opcodeBytes], variant,
                `${key ? `${key} ` : ''}${label}`);
        }
        return;
    }
    if (entry instanceof Group)
    {
        for (let row = 0; row < 8; row++)
        {
            const group = entry.entries[row];
            if (group === null || group === SYS)
            {
                continue;
            }
            yield { bytes: [...opcodeBytes, 0xc0 | row << 3], label: `${label} /${row}` };
            yield { bytes: [...opcodeBytes, row << 3], label: `${label} /${row}` };
        }
        return;
    }
    yield { bytes: [...opcodeBytes, 0xc0], label };
    yield { bytes: [...opcodeBytes, 0x00], label };
}

/**
 * One decoded representative per opcode the table names. An op that shares
 * several encodings keeps the first that decodes.
 *
 * @returns {Map<string, { instruction: import('./decoder.js').Instruction,
 *     bytes: number[], label: string }>}
 */
function representatives(){
    /** @type {{ label: string, bytes: number[] }[]} */
    const entries = [];
    for (let opcode = 0; opcode < 256; opcode++)
    {
        entries.push(...candidates([opcode], ONE_BYTE[opcode],
            opcode.toString(16).padStart(2, '0')));
    }
    for (let second = 0; second < 256; second++)
    {
        entries.push(...candidates([0x0f, second], TWO_BYTE[second],
            `0f ${second.toString(16).padStart(2, '0')}`));
    }
    for (let escape = 0; escape < 8; escape++)
    {
        const map = X87[escape];
        map.mem.forEach((entry, reg)=>{
            if (entry !== null)
            {
                entries.push({ label: `${0xd8 + escape} /${reg}`,
                    bytes: [0xd8 + escape, reg << 3] });
            }
        });
        for (const modrm of Object.keys(map.reg))
        {
            entries.push({ label: `${0xd8 + escape} ${modrm}`,
                bytes: [0xd8 + escape, Number(modrm)] });
        }
    }
    /** @type {Map<string, { instruction: any, bytes: number[], label: string }>} */
    const found = new Map();
    for (const candidate of entries)
    {
        const instruction = tryDecode(candidate.bytes) ?? tryDecode([...candidate.bytes, 0xc0]);
        if (instruction !== null && !found.has(instruction.op))
        {
            found.set(instruction.op,
                { instruction, bytes: candidate.bytes, label: candidate.label });
        }
    }
    return found;
}

/** A tiny flat memory the interpreter can read and write. */
function flatMemory(){
    const ram = new Uint8Array(RAM);
    const view = new DataView(ram.buffer);
    return {
        ram,
        memory: {
            /** @param {number} address @param {number} size */
            read: (address, size)=>{
                if (address + size > RAM)
                {
                    throw new Fault(13, 0);
                }
                return size === 1 ? ram[address] : size === 2 ? view.getUint16(address, true)
                    : view.getUint32(address, true);
            },
            /** @param {number} address @param {number} size @param {number} value */
            write: (address, size, value)=>{
                if (address + size > RAM)
                {
                    throw new Fault(13, 0);
                }
                if (size === 1)
                {
                    ram[address] = value;
                }
                else if (size === 2)
                {
                    view.setUint16(address, value, true);
                }
                else
                {
                    view.setUint32(address, value, true);
                }
            },
        },
    };
}

test('every opcode the table names has a lowering and a model', ()=>{
    const reps = representatives();
    assert.ok(reps.size > 400, `only ${reps.size} opcodes reached`);
    const machine = createTestMachine();
    const { memory } = flatMemory();
    const notLowered = [];
    const notModeled = [];
    for (const [op, { instruction, bytes, label }] of reps)
    {
        if (LEFT_TO_HOST.has(op))
        {
            continue;
        }
        try
        {
            machine.write(CODE, [...bytes, 0xf4]);
            const unit = machine.translate(CODE, { entryTop: 0 });
            if (unit.translation.unsupported.size > 0)
            {
                notLowered.push(`${op} (${label})`);
            }
        }
        catch (e){
            notLowered.push(`${op} (${label}) threw ${e}`);
        }
        const state = createState(memory, { eip: 0 });
        try
        {
            evaluate(instruction, state);
        }
        catch (e){
            if (e instanceof Unsupported)
            {
                notModeled.push(`${op} (${label})`);
            }
            else if (!(e instanceof Fault))
            {
                throw e;
            }
        }
    }
    assert.deepEqual(notLowered, []);
    assert.deepEqual(notModeled, []);
});

test('the left-to-host list names only table opcodes, each with a reason', ()=>{
    const names = new Set([...representatives().keys()]);
    for (const [op, reason] of LEFT_TO_HOST)
    {
        assert.ok(names.has(op), `${op} is not a table opcode`);
        assert.ok(reason.length > 0, `${op} has no reason`);
    }
});
