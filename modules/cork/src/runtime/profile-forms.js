/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a profiling run's hot code is made of, by instruction form: each form's
 * executions and the wasm bytes cork emits for it in the regions the run
 * formed, weighted by how often its block ran. A diagnostic, reached only
 * behind the build's guard: the regions are emitted again with the run's own
 * options and without its counts, so the bytes are those a plain build runs.
 */

/**
 * A form's name: the mnemonic and its operands' kinds, so `mov r32, [m]` and
 * `mov [m], r32` are told apart and every register is one.
 *
 * @param {import('../decode/decoder.js').Instruction} instruction
 */
export function formOf(instruction){
    const kinds = (instruction.operands ?? []).map(operand=>{
        switch (operand.kind)
        {
            case 'reg': return `r${operand.size ? operand.size * 8 : ''}`;
            case 'mem': return '[m]';
            case 'imm': return 'imm';
            case 'rel': return 'rel';
            default: return String(operand.kind);
        }
    });
    return `${instruction.op}${kinds.length > 0 ? ` ${kinds.join(', ')}` : ''}`;
}

/**
 * @typedef {Object} FormRow
 * @property {string} form
 * @property {number} executed   instructions of the form the profiled window ran
 * @property {number} bytes      the wasm bytes those executions ran through
 * @property {number} perInstruction  wasm bytes an execution, on average
 * @property {number} share      of all the wasm bytes the window ran through
 */

/**
 * The forms of the regions given, weighted by their blocks' executions.
 * `emit` emits the regions once, telling `note` each instruction's wasm bytes
 * as it goes; an instruction emitted twice (a region's copies) counts once, as
 * the region's own function has it.
 *
 * @param {import('../region.js').Region[]} regions
 * @param {Map<number, number>} executions  by block start, how often it ran
 * @param {(note: import('../emit/region.js').ExpansionNote) => void} emit
 * @param {number} [top]  rows kept, the heaviest first
 */
export function profileForms(regions, executions, emit, top = 40){
    /** @type {Map<number, number>} */
    const bytesAt = new Map();
    /** @type {Map<number, string>} */
    const formAt = new Map();
    emit((instruction, wasm)=>{
        if (!bytesAt.has(instruction.eip))
        {
            bytesAt.set(instruction.eip, wasm);
            formAt.set(instruction.eip, formOf(instruction));
        }
    });
    /** @type {Map<string, { executed: number, bytes: number }>} */
    const byForm = new Map();
    const seen = new Set();
    let executed = 0;
    let bytes = 0;
    for (const region of regions)
    {
        for (const block of region.blocks)
        {
            const runs = executions.get(block.start) ?? 0;
            if (runs === 0 || seen.has(block.start))
            {
                continue;
            }
            seen.add(block.start);
            for (const instruction of block.instructions)
            {
                const wasm = bytesAt.get(instruction.eip);
                const form = formAt.get(instruction.eip);
                if (wasm === undefined || form === undefined)
                {
                    continue;
                }
                const row = byForm.get(form) ?? { executed: 0, bytes: 0 };
                row.executed += runs;
                row.bytes += runs * wasm;
                byForm.set(form, row);
                executed += runs;
                bytes += runs * wasm;
            }
        }
    }
    /** @type {FormRow[]} */
    const rows = [...byForm].map(([form, row])=>({ form, executed: row.executed,
        bytes: row.bytes, perInstruction: row.bytes / row.executed,
        share: bytes > 0 ? row.bytes / bytes : 0 }));
    rows.sort((a, b)=>b.bytes - a.bytes);
    return { regions: regions.length, executed, bytes,
        perInstruction: executed > 0 ? bytes / executed : 0, forms: rows.slice(0, top) };
}
