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
 * records a call per command.
 */

import { IDIRECT3DDEVICE9_SLOTS } from './interfaces.js';
import { lightFromDwords } from '../seam/structs.js';

/**
 * The methods the ring carries: setters that answer only D3D_OK and whose
 * order against the shadow block's own setters does not matter, by how much
 * of what they point at the record copies -- a viewport, a light, a plane, a
 * rectangle, or registers four floats or integers or one boolean wide, up to
 * the most a device of this version has.
 *
 * @type {Readonly<Record<string, { args: number, pointer?: number, bytes?: number,
 *     count?: { arg: number, shift: number, most: number } }>>}
 */
export const COMMANDS = Object.freeze({
    SetViewport: { args: 1, pointer: 0, bytes: 24 },
    SetLight: { args: 2, pointer: 1, bytes: 104 },
    LightEnable: { args: 2 },
    SetClipPlane: { args: 2, pointer: 1, bytes: 16 },
    SetScissorRect: { args: 1, pointer: 0, bytes: 16 },
    SetSoftwareVertexProcessing: { args: 1 },
    SetVertexShaderConstantF: { args: 3, pointer: 1, count: { arg: 2, shift: 4, most: 256 } },
    SetVertexShaderConstantI: { args: 3, pointer: 1, count: { arg: 2, shift: 4, most: 16 } },
    SetVertexShaderConstantB: { args: 3, pointer: 1, count: { arg: 2, shift: 2, most: 16 } },
    SetPixelShaderConstantF: { args: 3, pointer: 1, count: { arg: 2, shift: 4, most: 224 } },
    SetPixelShaderConstantI: { args: 3, pointer: 1, count: { arg: 2, shift: 4, most: 16 } },
    SetPixelShaderConstantB: { args: 3, pointer: 1, count: { arg: 2, shift: 2, most: 16 } },
});

/** A method's slot in IDirect3DDevice9's table, IUnknown's three counted. @param {string} name */
export const commandSlot = name=>3 + IDIRECT3DDEVICE9_SLOTS.findIndex(([entry])=>entry === name);

/** The methods by slot, as a record names them. */
const BY_SLOT = new Map(Object.keys(COMMANDS).map(name=>[commandSlot(name), name]));

/** Where a record's arguments start, in dwords. */
const ARGS = 2;

/**
 * The bits of a record's dwords seen as floats and integers, through one
 * buffer made once: a typed array made per record, or asked for its buffer,
 * is an allocation outside the heap, which costs more than the call it
 * carries. What a method keeps is a copy of its own, small enough to stay
 * on the heap.
 */
const scratch = new ArrayBuffer(4 * 4 * 256);
const scratchWords = new Uint32Array(scratch);
const scratchFloats = new Float32Array(scratch);
const scratchInts = new Int32Array(scratch);

/**
 * Makes each call in `records`, in order, on `device`. A record the routines
 * could not have written ends the run, and is reported as one. Nothing is
 * kept of `records`, which may be guest memory the program writes next.
 *
 * @param {Record<string, Function>} device
 * @param {Uint8Array} records  whole records, aligned to four bytes
 * @param {(name: string, hr: number) => void} refused  told each call the device refused
 * @returns {number} how many calls were made
 */
export function runCommands(device, records, refused){
    const words = new Uint32Array(records.buffer, records.byteOffset, records.byteLength >>> 2);
    let made = 0;
    let at = 0;
    while (at < words.length)
    {
        const name = BY_SLOT.get(words[at]);
        const length = words[at + 1] >>> 2;
        const shape = name === undefined ? undefined : COMMANDS[name];
        if (name === undefined || shape === undefined || length < ARGS + shape.args
            || at + length > words.length)
        {
            refused('commands', 0);
            break;
        }
        const first = words[at + ARGS];
        const second = words[at + ARGS + 1];
        const data = at + ARGS + shape.args;
        const dataWords = length - ARGS - shape.args;
        if (dataWords > 0)
        {
            scratchWords.set(words.subarray(data, data + Math.min(dataWords, scratchWords.length)));
        }
        let hr;
        switch (name)
        {
            case 'SetViewport':
                hr = device.SetViewport({ X: scratchWords[0], Y: scratchWords[1],
                    Width: scratchWords[2], Height: scratchWords[3],
                    MinZ: scratchFloats[4], MaxZ: scratchFloats[5] });
                break;
            case 'SetLight':
                hr = device.SetLight(first, lightFromDwords(scratchFloats, scratchWords));
                break;
            case 'LightEnable':
                hr = device.LightEnable(first, second !== 0);
                break;
            case 'SetClipPlane':
                hr = device.SetClipPlane(first, scratchFloats.slice(0, 4));
                break;
            case 'SetScissorRect':
                hr = device.SetScissorRect({ left: scratchWords[0], top: scratchWords[1],
                    right: scratchWords[2], bottom: scratchWords[3] });
                break;
            case 'SetSoftwareVertexProcessing':
                hr = device.SetSoftwareVertexProcessing(first !== 0);
                break;
            default:
            {
                // The constant setters: registers of four floats or integers,
                // or of one boolean.
                const count = words[at + ARGS + 2];
                const kind = name.charCodeAt(name.length - 1);
                const values = kind === 0x46 // F
                    ? scratchFloats.slice(0, count * 4)
                    : kind === 0x49 // I
                        ? scratchInts.slice(0, count * 4)
                        : scratchWords.slice(0, count);
                hr = device[name](first, values, count);
            }
        }
        made++;
        if ((hr ?? 0) !== 0)
        {
            refused(name, hr >>> 0);
        }
        at += length;
    }
    return made;
}
