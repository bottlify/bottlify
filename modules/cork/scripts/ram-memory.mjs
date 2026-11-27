/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The wide window's build of the interpreter tier, after the linker: guest RAM
 * as the module's second memory.
 *
 * C has no way to say which memory a pointer reaches, and clang compiles every
 * access to memory 0 (with `-mmultimemory` too: the flag only allows what the
 * source cannot ask for). So `interp-wasm.c` built with WIDE reaches the guest
 * through functions it imports from `ram` -- `load8` .. `store64`, `copy`,
 * `fill`, each taking the address as an i64 -- and this pass puts in place of
 * every call of one the instruction it stands for, over memory 1: the operands
 * a call takes are the operands the instruction takes, in the same order. The
 * imports go, an import of the memory (`env.ram`, a `memory64` one of any
 * size) comes in after the module's own, and the functions after the removed
 * imports are renumbered where the module names them: in calls and in the
 * exports. A module that names a function any other way (an element segment,
 * a start function, `ref.func`) is refused; the tier has none.
 */

/** What stands for a call of an import of `ram`: the opcode, and for a load or a
 * store the memory argument's bytes past it -- no alignment claimed (an x86
 * access has none), bit 6 set for a memory index to follow, memory 1, offset 0. */
const MEMORY_1 = [0x40, 0x01, 0x00];
/** @type {Record<string, number[]>} */
const INSTRUCTIONS = {
    load8: [0x2d, ...MEMORY_1],
    load16: [0x2f, ...MEMORY_1],
    load32: [0x28, ...MEMORY_1],
    load64: [0x29, ...MEMORY_1],
    store8: [0x3a, ...MEMORY_1],
    store16: [0x3b, ...MEMORY_1],
    store32: [0x36, ...MEMORY_1],
    store64: [0x37, ...MEMORY_1],
    // memory.copy to memory 1 from memory 1, memory.fill of memory 1.
    copy: [0xfc, 0x0a, 0x01, 0x01],
    fill: [0xfc, 0x0b, 0x01],
};

/** @param {number} value @returns {number[]} unsigned LEB128 */
function leb(value){
    /** @type {number[]} */
    const out = [];
    for (;;)
    {
        const byte = value % 128;
        value = Math.floor(value / 128);
        if (value === 0)
        {
            out.push(byte);
            return out;
        }
        out.push(byte | 0x80);
    }
}

/**
 * A reader over the module's bytes.
 *
 * @param {Uint8Array} bytes @param {number} at
 */
function reader(bytes, at){
    return {
        at: ()=>at,
        /** @param {number} to */
        seek(to){
            at = to;
        },
        byte: ()=>bytes[at++],
        /** An unsigned LEB128, or a signed one's bytes skipped: both end at a clear top bit. */
        leb(){
            let value = 0;
            let scale = 1;
            for (;;)
            {
                const byte = bytes[at++];
                value += (byte & 0x7f) * scale;
                scale *= 128;
                if ((byte & 0x80) === 0)
                {
                    return value;
                }
            }
        },
        name(){
            const length = this.leb();
            at += length;
            return new TextDecoder().decode(bytes.subarray(at - length, at));
        },
    };
}

/**
 * Moves the reader past one instruction's immediates, its opcode `op` read.
 * Every instruction clang emits for the tier is known here and any other
 * refused, never guessed at: a wrong length would rewrite bytes that are no
 * call.
 *
 * @param {ReturnType<typeof reader>} r @param {number} op
 */
function skipImmediates(r, op){
    if (op === 0x02 || op === 0x03 || op === 0x04)
    {
        // A block type: empty, a value type or a type index, one signed LEB128.
        r.leb();
    }
    else if (op === 0x0c || op === 0x0d || op === 0x10 || (op >= 0x20 && op <= 0x24)
        || op === 0x41 || op === 0x42)
    {
        r.leb();
    }
    else if (op === 0x0e)
    {
        for (let targets = r.leb() + 1; targets > 0; targets--)
        {
            r.leb();
        }
    }
    else if (op === 0x11)
    {
        r.leb();
        r.leb();
    }
    else if (op >= 0x28 && op <= 0x3e)
    {
        if (r.leb() & 0x40)
        {
            r.leb();
        }
        r.leb();
    }
    else if (op === 0x3f || op === 0x40)
    {
        r.leb();
    }
    else if (op === 0x43)
    {
        r.seek(r.at() + 4);
    }
    else if (op === 0x44)
    {
        r.seek(r.at() + 8);
    }
    else if (op === 0xfc)
    {
        const sub = r.leb();
        if (sub === 10)
        {
            r.leb();
            r.leb();
        }
        else if (sub === 11)
        {
            r.leb();
        }
        else if (sub > 7)
        {
            throw new Error(`ram-memory: instruction 0xfc ${sub} is not known here`);
        }
    }
    else if (!(op <= 0x01 || op === 0x05 || op === 0x0b || op === 0x0f || op === 0x1a
        || op === 0x1b || (op >= 0x45 && op <= 0xc4)))
    {
        throw new Error(`ram-memory: instruction 0x${op.toString(16)} is not known here`);
    }
}

/**
 * A function body with its calls rewritten.
 *
 * @param {Uint8Array} bytes @param {number} from @param {number} to  the body, past its size
 * @param {Map<number, number[]>} replaced  an import of `ram`'s index -> its instruction
 * @param {(index: number) => number} renumbered
 * @returns {number[]}
 */
function rewrittenBody(bytes, from, to, replaced, renumbered){
    const r = reader(bytes, from);
    for (let groups = r.leb(); groups > 0; groups--)
    {
        r.leb();
        r.byte();
    }
    /** @type {number[]} */
    const out = [...bytes.subarray(from, r.at())];
    while (r.at() < to)
    {
        const start = r.at();
        const op = r.byte();
        if (op === 0x10)
        {
            const callee = r.leb();
            out.push(...(replaced.get(callee) ?? [0x10, ...leb(renumbered(callee))]));
            continue;
        }
        skipImmediates(r, op);
        for (let at = start; at < r.at(); at++)
        {
            out.push(bytes[at]);
        }
    }
    if (r.at() !== to)
    {
        throw new Error('ram-memory: a function body ends inside an instruction');
    }
    return out;
}

/**
 * The module with guest RAM as its second memory (see the file's comment).
 *
 * @param {Uint8Array} bytes  the linker's module
 * @returns {Uint8Array}
 */
export function withRamMemory(bytes){
    /** @type {number[][]} */
    const sections = [[...bytes.subarray(0, 8)]];
    /** @type {Map<number, number[]>} */
    const replaced = new Map();
    /** The removed imports' indices, ascending. @type {number[]} */
    const removed = [];
    /** @param {number} index */
    const renumbered = index=>index - removed.filter(gone=>gone < index).length;
    const r = reader(bytes, 8);
    while (r.at() < bytes.length)
    {
        const head = r.at();
        const id = r.byte();
        const size = r.leb();
        const start = r.at();
        const end = start + size;
        /** @type {number[] | null} */
        let body = null;
        if (id === 2)
        {
            body = [];
            let kept = 0;
            let functions = 0;
            for (let count = r.leb(); count > 0; count--)
            {
                const from = r.at();
                const module = r.name();
                const field = r.name();
                const kind = r.byte();
                if (kind === 0)
                {
                    r.leb();
                }
                else if (kind === 1)
                {
                    r.byte();
                    if (r.byte() & 1)
                    {
                        r.leb();
                    }
                    r.leb();
                }
                else if (kind === 2)
                {
                    if (r.byte() & 1)
                    {
                        r.leb();
                    }
                    r.leb();
                }
                else
                {
                    r.byte();
                    r.byte();
                }
                if (kind === 0 && module === 'ram')
                {
                    if (INSTRUCTIONS[field] === undefined)
                    {
                        throw new Error(`ram-memory: no instruction for ram.${field}`);
                    }
                    replaced.set(functions, INSTRUCTIONS[field]);
                    removed.push(functions++);
                    continue;
                }
                functions += kind === 0 ? 1 : 0;
                body.push(...bytes.subarray(from, r.at()));
                kept++;
                if (kind === 2)
                {
                    // The memory after the module's own: memory64, from no pages, no maximum.
                    body.push(3, 0x65, 0x6e, 0x76, 3, 0x72, 0x61, 0x6d, 0x02, 0x04, 0x00);
                    kept++;
                }
            }
            body.unshift(...leb(kept));
        }
        else if (id === 7)
        {
            body = [];
            const count = r.leb();
            body.push(...leb(count));
            for (let left = count; left > 0; left--)
            {
                const from = r.at();
                r.name();
                const kind = r.byte();
                body.push(...bytes.subarray(from, r.at()));
                const index = r.leb();
                body.push(...leb(kind === 0 ? renumbered(index) : index));
            }
        }
        else if (id === 10)
        {
            body = [];
            const count = r.leb();
            body.push(...leb(count));
            for (let left = count; left > 0; left--)
            {
                const length = r.leb();
                const from = r.at();
                const rewritten = rewrittenBody(bytes, from, from + length, replaced, renumbered);
                r.seek(from + length);
                const prefix = leb(rewritten.length);
                for (const byte of prefix)
                {
                    body.push(byte);
                }
                for (const byte of rewritten)
                {
                    body.push(byte);
                }
            }
        }
        else if (id === 8 || (id === 9 && r.leb() !== 0))
        {
            throw new Error(`ram-memory: section ${id} names functions by index`);
        }
        else if (id === 0)
        {
            // The names are by function index and for a debugger: dropped, not renumbered.
            if (reader(bytes, start).name() === 'name')
            {
                r.seek(end);
                continue;
            }
        }
        if (body === null)
        {
            sections.push([...bytes.subarray(head, end)]);
        }
        else
        {
            sections.push([id, ...leb(body.length)], body);
        }
        r.seek(end);
    }
    if (replaced.size === 0)
    {
        throw new Error('ram-memory: the module imports nothing from ram');
    }
    const out = new Uint8Array(sections.reduce((sum, part)=>sum + part.length, 0));
    let at = 0;
    for (const part of sections)
    {
        out.set(part, at);
        at += part.length;
    }
    return out;
}
