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
 * most is here or in the host, never in the shadow block's marks: the ring
 * keeps their order, which a block of the latest values cannot, and a draw
 * that waits needs it.
 */

import { IDIRECT3DDEVICE8_SLOTS } from '../seam/vtables.js';
import { lightFromDwords } from '../seam/structs.js';

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
 * @property {boolean} [draws]
 * @property {(device: any, call: CommandArgs) => number} make
 */

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
    /** @type {Map<number, CommandEntry>} */
    const bySlot = new Map(Object.entries(table)
        .map(([name, entry])=>[commandSlot(name), entry]));
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
            const entry = bySlot.get(all[at]);
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
        };
        while (at < all.length)
        {
            const entry = bySlot.get(all[at]);
            const length = all[at + 1] >>> 2;
            if (entry === undefined || length < ARGS + entry.args || at + length > all.length)
            {
                refused('commands', 0);
                break;
            }
            const data = at + ARGS + entry.args;
            const copied = length - ARGS - entry.args;
            if (copied > 0)
            {
                words.set(all.subarray(data, data + Math.min(copied, words.length)));
            }
            const hr = entry.make(device, call);
            made++;
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

/**
 * The calls both versions' rings carry the same way.
 *
 * @type {Record<string, CommandEntry>}
 */
export const SHARED_COMMANDS = {
    SetRenderState: { args: 2, make: (d, c)=>d.SetRenderState(c.arg(0), c.arg(1)) },
    SetTransform: { args: 2, pointer: 1, bytes: 64,
        make: (d, c)=>d.SetTransform(c.arg(0), c.floats.slice(0, 16)) },
    SetTextureStageState: { args: 3,
        make: (d, c)=>d.SetTextureStageState(c.arg(0), c.arg(1), c.arg(2)) },
    SetMaterial: { args: 1, pointer: 0, bytes: 68,
        make: (d, c)=>d.SetMaterial(materialOf(c.floats)) },
    SetTexture: { args: 2, objects: [1], make: (d, c)=>d.SetTexture(c.arg(0), c.object()) },
    SetViewport: { args: 1, pointer: 0, bytes: 24,
        make: (d, c)=>d.SetViewport({ X: c.words[0], Y: c.words[1], Width: c.words[2],
            Height: c.words[3], MinZ: c.floats[4], MaxZ: c.floats[5] }) },
    SetLight: { args: 2, pointer: 1, bytes: 104,
        make: (d, c)=>d.SetLight(c.arg(0), lightFromDwords(c.floats, c.words)) },
    LightEnable: { args: 2, make: (d, c)=>d.LightEnable(c.arg(0), c.arg(1) !== 0) },
    SetClipPlane: { args: 2, pointer: 1, bytes: 16,
        make: (d, c)=>d.SetClipPlane(c.arg(0), c.floats.slice(0, 4)) },
    DrawPrimitive: { args: 3, draws: true,
        make: (d, c)=>d.DrawPrimitive(c.arg(0), c.arg(1), c.arg(2)) },
};

/**
 * Direct3D 8's: its streams take a stride and no offset, its indices a base
 * vertex, its shaders are handles, its indexed draw has no base vertex, and
 * its shader constants are floats alone, up to what a 1.x shader has.
 */
export const D3D8_COMMANDS = commandSet(IDIRECT3DDEVICE8_SLOTS, {
    ...SHARED_COMMANDS,
    SetStreamSource: { args: 3, objects: [1],
        make: (d, c)=>d.SetStreamSource(c.arg(0), c.object(), c.arg(2)) },
    SetIndices: { args: 2, objects: [0], make: (d, c)=>d.SetIndices(c.object(), c.arg(1)) },
    SetVertexShader: { args: 1, make: (d, c)=>d.SetVertexShader(c.arg(0)) },
    SetPixelShader: { args: 1, make: (d, c)=>d.SetPixelShader(c.arg(0)) },
    SetVertexShaderConstant: { args: 3, pointer: 1, count: { arg: 2, shift: 4, most: 256 },
        make: (d, c)=>d.SetVertexShaderConstant(c.arg(0), c.floats.slice(0, c.arg(2) * 4),
            c.arg(2)) },
    SetPixelShaderConstant: { args: 3, pointer: 1, count: { arg: 2, shift: 4, most: 8 },
        make: (d, c)=>d.SetPixelShaderConstant(c.arg(0), c.floats.slice(0, c.arg(2) * 4),
            c.arg(2)) },
    DrawIndexedPrimitive: { args: 5, draws: true,
        make: (d, c)=>d.DrawIndexedPrimitive(c.arg(0), c.arg(1), c.arg(2), c.arg(3), c.arg(4)) },
});
