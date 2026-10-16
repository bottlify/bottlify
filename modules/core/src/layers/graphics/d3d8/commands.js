/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The calls a device's command ring carried (`seam/shadow.js`,
 * `commandCode`), made on the device in the order the program made them.
 *
 * A record is the method's slot, its length in bytes, its arguments as the
 * program passed them, and a copy of what its pointer argument pointed at.
 * The device takes a run of records in one call, so that a recording device
 * sends one call for the run and the device that plays it makes the same
 * calls: neither side reads a structure out of guest memory, and neither
 * records a call per command. An argument naming an object of the device's
 * -- a texture, a buffer -- travels beside the records, resolved by the host
 * from the pointer the program passed.
 *
 * Between two entries into the host every setter and draw a program makes
 * most is here: the ring keeps their order, which a draw that waits needs.
 */

import { IDIRECT3DDEVICE8_SLOTS } from '../seam/vtables.js';
import { DRAW, SHADOW } from '../seam/shadow.js';
import { D3DFVF_RESERVED0 } from './constants.js';
import { lightFromDwords } from '../seam/structs.js';
import { vertexCountOf } from './render.js';

/** Where a record's arguments start, in dwords. */
const ARGS = 2;

/**
 * The bits of a record's copy seen as dwords, floats and integers, through
 * one buffer made once: a typed array made per record, or asked for its
 * buffer, is an allocation outside the heap, which costs more than the call
 * it carries. What a method keeps is a copy of its own, small enough to stay
 * on the heap.
 */
const scratch = new ArrayBuffer(4 * 4 * 256);
const words = new Uint32Array(scratch);
const floats = new Float32Array(scratch);
const ints = new Int32Array(scratch);
const kinds = { words, floats, ints };

/**
 * The scratch's first `length` elements of a kind, a view made once for each
 * length and kept: a matrix or a run of shader constants handed over by a
 * slice per record was most of what the engine allocated while a game ran.
 * Every device copies what it keeps of such an array before it returns.
 *
 * @type {Record<'words' | 'floats' | 'ints', (Uint32Array | Float32Array | Int32Array)[]>}
 */
const firsts = { words: [], floats: [], ints: [] };
/**
 * @template {'words' | 'floats' | 'ints'} K
 * @param {K} kind @param {number} length
 * @returns {(typeof kinds)[K]}
 */
const first = (kind, length)=>{
    const all = kinds[kind];
    if (length > all.length)
    {
        return /** @type {any} */ (all.subarray(0, length));
    }
    return /** @type {any} */ (firsts[kind][length] ??= all.subarray(0, length));
};

/**
 * What a method's call is made of: `arg(i)` its arguments as dwords, `object()`
 * the next object argument, and the copy as `words`, `floats` and `ints`.
 *
 * @typedef {Object} CommandArgs
 * @property {(index: number) => number} arg
 * @property {() => any} object
 * @property {Uint32Array} words
 * @property {Float32Array} floats
 * @property {Int32Array} ints
 * @property {<K extends 'words' | 'floats' | 'ints'>(kind: K, length: number)
 *     => (typeof kinds)[K]} first  the first `length` of the copy as that kind, in a view
 *     reused by the next record
 * @property {(bytes: number) => Uint8Array} copy  the first `bytes` of the copy, as a copy
 *     of its own, for a method that keeps them or reads more than the scratch holds
 * @property {(bytes: number) => Uint8Array} view  the same bytes in place, for a method
 *     that copies what it reads before it returns
 */

/**
 * A method the ring carries: how many arguments, which of them name an object
 * of the device's, which points at what the method reads and how much of it
 * is copied -- a fixed size, or a count argument of elements `1 << shift`
 * bytes wide up to `most` -- whether it is a draw, and how the device is
 * called with it.
 *
 * @typedef {Object} CommandEntry
 * @property {number} args
 * @property {readonly number[]} [objects]
 * @property {number} [pointer]
 * @property {number} [bytes]
 * @property {{ arg: number, shift: number, most: number }} [count]
 * @property {{ arg: number, cases: readonly [number, number][], otherwise: number }} [choose]
 *     or a size chosen by an argument's value: the bytes of the case it equals, or `otherwise`
 * @property {{ arg: number, ranges: readonly [number, number][] }[]} [within]
 * @property {number} [span] @property {{ arg: number, word: number }} [below]
 * @property {{ arg: number, when: number, table?: number }} [validated]
 * @property {{ arg: number, mask: number, nullable?: boolean }} [surfaceUsage]
 * @property {number} [needs] @property {number} [refuses] @property {boolean} [fresh]
 *     what the routine checks before it answers for the call, so that the
 *     device takes every call it answered for (`commandChecks`)
 * @property {{ type: number, count: number, stride: number, most: number }} [vertices]
 *     or the vertices a draw's primitives span, `stride` bytes each (`commandCode`)
 * @property {boolean} [kept]  its copy is taken with `copy` alone, not through the scratch
 * @property {boolean} [self]  the first argument is the object the method is of, not the device
 * @property {boolean} [stale]  it may change state the device's block mirrors
 * @property {'empty' | 'any'} [nullable]  its pointer may be null: with a count of zero
 *     alone, or whatever the count
 * @property {boolean} [draws]
 * @property {(device: any, call: CommandArgs) => number} make
 */

/**
 * The calls command rings carried, kept while asked for: a debugging switch
 * on a running program, since the guest makes these calls without crossing
 * to the host one by one, and no call log shows them otherwise.
 */
/** @type {{ limit: number, lines: string[] }} */
const traced = { limit: 0, lines: [] };

/**
 * Starts keeping the last `count` ring calls (a fresh list), or with 0 stops;
 * answers what was kept either way, oldest first.
 *
 * @param {number} [count]  absent, only answers
 * @returns {string[]}
 */
export function ringTrace(count){
    const kept = traced.lines;
    if (count !== undefined)
    {
        traced.limit = Math.max(0, count | 0);
        traced.lines = [];
    }
    return kept;
}

/**
 * A device's command set: its table, and what the seam and the device do
 * with a run of records.
 *
 * @param {readonly [string, number][]} slots  the device interface's methods, IUnknown's
 *     not counted
 * @param {Readonly<Record<string, CommandEntry>>} table
 */
export function commandSet(slots, table){
    /** @param {string} name */
    const commandSlot = name=>3 + slots.findIndex(([entry])=>entry === name);
    /** @type {(CommandEntry | undefined)[]} */
    const bySlot = [];
    for (const [name, entry] of Object.entries(table))
    {
        bySlot[commandSlot(name)] = entry;
    }
    /** @type {Map<CommandEntry, string>} */
    const names = new Map(Object.entries(table).map(([name, entry])=>[entry, name]));

    /**
     * The objects the records name, in the order `runCommands` takes them:
     * what each pointer an object argument holds is published as.
     *
     * @param {Uint8Array} records
     * @param {(pointer: number) => any} objectAt
     * @returns {any[]}
     */
    const commandObjects = (records, objectAt)=>{
        const all = new Uint32Array(records.buffer, records.byteOffset, records.byteLength >>> 2);
        /** @type {any[]} */
        const objects = [];
        let at = 0;
        while (at < all.length)
        {
            const entry = bySlot[all[at]];
            const length = all[at + 1] >>> 2;
            if (entry === undefined || length === 0)
            {
                break;
            }
            for (const index of entry.objects ?? [])
            {
                objects.push(objectAt(all[at + ARGS + index]) ?? null);
            }
            at += length;
        }
        return objects;
    };

    /**
     * Makes each call in `records`, in order, on `device`. A record the
     * routines could not have written ends the run, and is reported as one.
     * Nothing is kept of `records`, which may be guest memory the program
     * writes next.
     *
     * @param {any} device
     * @param {Uint8Array} records  whole records, aligned to four bytes
     * @param {readonly any[]} objects  what the records' object arguments name, in order
     * @param {(name: string, hr: number) => void} refused  told each call the device refused
     * @returns {number} how many calls were made
     */
    const runCommands = (device, records, objects, refused)=>{
        const all = new Uint32Array(records.buffer, records.byteOffset, records.byteLength >>> 2);
        let made = 0;
        let at = 0;
        let next = 0;
        /** @type {CommandArgs} */
        const call = {
            arg: index=>all[at + ARGS + index],
            object: ()=>objects[next++],
            words,
            floats,
            ints,
            first,
            view: bytes=>{
                const from = records.byteOffset
                    + (at + ARGS + (bySlot[all[at]]?.args ?? 0)) * 4;
                return new Uint8Array(records.buffer, from, bytes);
            },
            copy: bytes=>{
                const from = records.byteOffset
                    + (at + ARGS + (bySlot[all[at]]?.args ?? 0)) * 4;
                return new Uint8Array(records.buffer.slice(from, from + bytes));
            },
        };
        while (at < all.length)
        {
            const entry = bySlot[all[at]];
            const length = all[at + 1] >>> 2;
            if (entry === undefined || length < ARGS + entry.args || at + length > all.length)
            {
                refused('commands', 0);
                break;
            }
            const data = at + ARGS + entry.args;
            const copied = length - ARGS - entry.args;
            // Word by word: a view of the run made per record costs more than
            // the copy.
            for (let i = 0, end = entry.kept ? 0 : Math.min(copied, words.length); i < end; i++)
            {
                words[i] = all[data + i];
            }
            const hr = entry.make(device, call);
            made++;
            if (traced.limit > 0)
            {
                // The arguments, then the first words of what the record
                // carries besides them: a viewport's rectangle, a matrix.
                const hex = (/** @type {number} */ from, /** @type {number} */ to)=>
                    Array.from(all.subarray(from, to), word=>word.toString(16)).join(',');
                traced.lines.push(`${names.get(entry)}(${hex(at + ARGS, data)})${
                    copied > 0 ? ` [${hex(data, data + Math.min(copied, 8))}]` : ''} = ${
                    ((hr ?? 0) >>> 0).toString(16)}`);
                if (traced.lines.length > traced.limit)
                {
                    traced.lines.splice(0, traced.lines.length - traced.limit);
                }
            }
            if ((hr ?? 0) !== 0)
            {
                refused(/** @type {string} */ (names.get(entry)), hr >>> 0);
            }
            at += length;
        }
        return made;
    };

    return { COMMANDS: table, commandSlot, commandObjects, runCommands };
}

/**
 * A D3DMATERIAL out of its seventeen floats: four colours, then the power.
 *
 * @param {Float32Array} f
 */
export function materialOf(f){
    /** @param {number} at */
    const colour = at=>({ r: f[at], g: f[at + 1], b: f[at + 2], a: f[at + 3] });
    return { Diffuse: colour(0), Ambient: colour(4), Specular: colour(8), Emissive: colour(12),
        Power: f[16] };
}

const bits = new DataView(new ArrayBuffer(4));
/** A float's bits as the float. @param {number} word */
const floatOf = word=>{
    bits.setUint32(0, word >>> 0, true);
    return bits.getFloat32(0, true);
};

/**
 * Clear's rectangles, four integers each, as the device takes them.
 *
 * @param {Int32Array} copy @param {number} count
 */
const rectsOf = (copy, count)=>Array.from({ length: count }, (unused, i)=>({
    x1: copy[i * 4], y1: copy[i * 4 + 1], x2: copy[i * 4 + 2], y2: copy[i * 4 + 3],
}));

/**
 * The most a draw from the program's own memory copies into a record: past
 * it the host reads the vertices itself, as it does without a ring.
 */
const UP_BYTES = 16 * 1024;

/** D3DCLEAR_TARGET, the same in both versions. */
const D3DCLEAR_TARGET = 1;

/** D3DPT_POINTLIST to D3DPT_TRIANGLEFAN, a primitive type a draw takes. */
const PRIMITIVE_TYPES = /** @type {[number, number][]} */ ([[1, 6]]);
/** At least one primitive. */
const SOME = /** @type {[number, number][]} */ ([[1, 0xffffffff]]);
/**
 * What a draw from the device's streams checks in the guest: a type, some
 * primitives, a scene, something to read the vertices with and stream zero.
 * A state block applied in the ring may have changed the last two.
 *
 * @param {number} type @param {number} count  the arguments that carry them
 */
const drawChecks = (type, count)=>({
    within: [{ arg: type, ranges: PRIMITIVE_TYPES }, { arg: count, ranges: SOME }],
    needs: DRAW.SCENE | DRAW.DECLARED | DRAW.STREAM, fresh: true,
});

/**
 * The calls both versions' rings carry the same way.
 *
 * @type {Record<string, CommandEntry>}
 */
export const SHARED_COMMANDS = {
    SetRenderState: { args: 2, make: (d, c)=>d.SetRenderState(c.arg(0), c.arg(1)) },
    SetTransform: { args: 2, pointer: 1, bytes: 64,
        make: (d, c)=>d.SetTransform(c.arg(0), c.first('floats', 16)) },
    SetTextureStageState: { args: 3,
        make: (d, c)=>d.SetTextureStageState(c.arg(0), c.arg(1), c.arg(2)) },
    SetMaterial: { args: 1, pointer: 0, bytes: 68,
        make: (d, c)=>d.SetMaterial(materialOf(c.floats)) },
    SetViewport: { args: 1, pointer: 0, bytes: 24,
        make: (d, c)=>d.SetViewport({ X: c.words[0], Y: c.words[1], Width: c.words[2],
            Height: c.words[3], MinZ: c.floats[4], MaxZ: c.floats[5], MinZWord: c.words[4],
            MaxZWord: c.words[5] }) },
    SetLight: { args: 2, pointer: 1, bytes: 104,
        make: (d, c)=>d.SetLight(c.arg(0), lightFromDwords(c.floats, c.words)) },
    LightEnable: { args: 2, make: (d, c)=>d.LightEnable(c.arg(0), c.arg(1) !== 0) },
    SetClipPlane: { args: 2, pointer: 1, bytes: 16,
        below: { arg: 0, word: SHADOW.CLIP_PLANES },
        make: (d, c)=>d.SetClipPlane(c.arg(0), c.first('floats', 4)) },
    DrawPrimitive: { args: 3, draws: true, ...drawChecks(0, 2),
        make: (d, c)=>d.DrawPrimitive(c.arg(0), c.arg(1), c.arg(2)) },
    BeginScene: { args: 0, refuses: DRAW.SCENE, make: d=>d.BeginScene() },
    EndScene: { args: 0, needs: DRAW.SCENE, make: d=>d.EndScene() },
    // No rectangles is the whole target; Z comes as a float in a dword. Only
    // the target is cleared here: a depth or stencil clear is refused for a
    // depth surface without one, and a program that is told so clears again
    // with less, so the answer must be the device's.
    Clear: { args: 6, pointer: 1, nullable: 'empty', count: { arg: 0, shift: 4, most: 64 },
        within: [{ arg: 2, ranges: [[D3DCLEAR_TARGET, D3DCLEAR_TARGET]] }],
        make: (d, c)=>d.Clear(c.arg(0), c.arg(1) === 0 ? null : rectsOf(c.ints, c.arg(0)),
            c.arg(2), c.arg(3), floatOf(c.arg(4)), c.arg(5)) },
    DrawPrimitiveUP: { args: 4, pointer: 2, kept: true, draws: true,
        vertices: { type: 0, count: 1, stride: 3, most: UP_BYTES },
        needs: DRAW.SCENE | DRAW.DECLARED, fresh: true,
        make: (d, c)=>d.DrawPrimitiveUP(c.arg(0), c.arg(1),
            c.copy(vertexCountOf(c.arg(0), c.arg(1)) * c.arg(3)), c.arg(3)) },
};

/**
 * Direct3D 8's: its streams take a stride and no offset, its indices a base
 * vertex, its shaders are handles, its indexed draw has no base vertex, and
 * its shader constants are floats alone, up to what a 1.x shader has.
 */
export const D3D8_COMMANDS = commandSet(IDIRECT3DDEVICE8_SLOTS, {
    ...SHARED_COMMANDS,
    SetTexture: { args: 2, objects: [1], within: [{ arg: 0, ranges: [[0, 7]] }],
        make: (d, c)=>d.SetTexture(c.arg(0), c.object()) },
    SetStreamSource: { args: 3, objects: [1],
        make: (d, c)=>d.SetStreamSource(c.arg(0), c.object(), c.arg(2)) },
    SetIndices: { args: 2, objects: [0], make: (d, c)=>d.SetIndices(c.object(), c.arg(1)) },
    // A format is always taken; a shader's handle only while the shader lives.
    SetVertexShader: { args: 1, validated: { arg: 0, when: D3DFVF_RESERVED0 },
        make: (d, c)=>d.SetVertexShader(c.arg(0)) },
    SetPixelShader: { args: 1, validated: { arg: 0, when: 0xffffffff, table: 1 },
        make: (d, c)=>d.SetPixelShader(c.arg(0)) },
    SetVertexShaderConstant: { args: 3, pointer: 1, count: { arg: 2, shift: 4, most: 256 },
        span: 0, make: (d, c)=>d.SetVertexShaderConstant(c.arg(0),
            c.first('floats', c.arg(2) * 4), c.arg(2)) },
    SetPixelShaderConstant: { args: 3, pointer: 1, count: { arg: 2, shift: 4, most: 8 },
        span: 0, make: (d, c)=>d.SetPixelShaderConstant(c.arg(0),
            c.first('floats', c.arg(2) * 4), c.arg(2)) },
    // Without a stream or indices this version draws nothing and says D3D_OK.
    DrawIndexedPrimitive: { args: 5, draws: true, ...drawChecks(0, 4),
        needs: DRAW.SCENE | DRAW.DECLARED,
        make: (d, c)=>d.DrawIndexedPrimitive(c.arg(0), c.arg(1), c.arg(2), c.arg(3), c.arg(4)) },
});
