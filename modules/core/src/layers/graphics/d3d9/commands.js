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
 * The methods the ring carries, by what a record of each holds: how many
 * arguments, which of them name an object of the device's (resolved by the
 * host and handed over beside the records, in order), which points at what
 * the method reads and how much of it is copied -- a viewport, a light, a
 * plane, a rectangle, a matrix, a material, or registers four floats or
 * integers or one boolean wide up to the most a device of this version has
 * -- and which are draws.
 *
 * Between two entries into the host every setter of the device's state and
 * every draw a program makes most is here or in the host, never in the
 * shadow block's marks: the ring keeps their order, which a block of the
 * latest values cannot.
 *
 * @type {Readonly<Record<string, { args: number, objects?: readonly number[], pointer?: number,
 *     bytes?: number, count?: { arg: number, shift: number, most: number },
 *     draws?: boolean }>>}
 */
export const COMMANDS = Object.freeze({
    SetRenderState: { args: 2 },
    SetTransform: { args: 2, pointer: 1, bytes: 64 },
    SetTextureStageState: { args: 3 },
    SetSamplerState: { args: 3 },
    SetMaterial: { args: 1, pointer: 0, bytes: 68 },
    SetTexture: { args: 2, objects: [1] },
    SetStreamSource: { args: 4, objects: [1] },
    SetIndices: { args: 1, objects: [0] },
    SetVertexDeclaration: { args: 1, objects: [0] },
    SetVertexShader: { args: 1, objects: [0] },
    SetPixelShader: { args: 1, objects: [0] },
    SetFVF: { args: 1 },
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
    DrawPrimitive: { args: 3, draws: true },
    DrawIndexedPrimitive: { args: 6, draws: true },
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
 * The objects the records name, in the order `runCommands` takes them: what
 * each pointer an object argument holds is published as, by `objectAt`.
 *
 * @param {Uint8Array} records
 * @param {(pointer: number) => any} objectAt
 * @returns {any[]}
 */
export function commandObjects(records, objectAt){
    const words = new Uint32Array(records.buffer, records.byteOffset, records.byteLength >>> 2);
    /** @type {any[]} */
    const objects = [];
    let at = 0;
    while (at < words.length)
    {
        const name = BY_SLOT.get(words[at]);
        const shape = name === undefined ? undefined : COMMANDS[name];
        const length = words[at + 1] >>> 2;
        if (shape === undefined || length === 0)
        {
            break;
        }
        for (const arg of shape.objects ?? [])
        {
            objects.push(objectAt(words[at + ARGS + arg]) ?? null);
        }
        at += length;
    }
    return objects;
}

/**
 * Makes each call in `records`, in order, on `device`. A record the routines
 * could not have written ends the run, and is reported as one. Nothing is
 * kept of `records`, which may be guest memory the program writes next.
 *
 * @param {Record<string, Function>} device
 * @param {Uint8Array} records  whole records, aligned to four bytes
 * @param {readonly any[]} objects  what the records' object arguments name, in order
 * @param {(name: string, hr: number) => void} refused  told each call the device refused
 * @returns {number} how many calls were made
 */
export function runCommands(device, records, objects, refused){
    const words = new Uint32Array(records.buffer, records.byteOffset, records.byteLength >>> 2);
    let made = 0;
    let at = 0;
    let object = 0;
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
        const args = at + ARGS;
        const data = args + shape.args;
        const dataWords = length - ARGS - shape.args;
        if (dataWords > 0)
        {
            scratchWords.set(words.subarray(data, data + Math.min(dataWords, scratchWords.length)));
        }
        let hr;
        switch (name)
        {
            case 'SetRenderState':
                hr = device.SetRenderState(words[args], words[args + 1]);
                break;
            case 'SetTransform':
                hr = device.SetTransform(words[args], scratchFloats.slice(0, 16));
                break;
            case 'SetTextureStageState':
            case 'SetSamplerState':
                hr = device[name](words[args], words[args + 1], words[args + 2]);
                break;
            case 'SetMaterial':
                hr = device.SetMaterial(materialOf(scratchFloats));
                break;
            case 'SetTexture':
                hr = device.SetTexture(words[args], objects[object++]);
                break;
            case 'SetStreamSource':
                hr = device.SetStreamSource(words[args], objects[object++], words[args + 2],
                    words[args + 3]);
                break;
            case 'SetIndices':
            case 'SetVertexDeclaration':
            case 'SetVertexShader':
            case 'SetPixelShader':
                hr = device[name](objects[object++]);
                break;
            case 'SetFVF':
                hr = device.SetFVF(words[args]);
                break;
            case 'SetViewport':
                hr = device.SetViewport({ X: scratchWords[0], Y: scratchWords[1],
                    Width: scratchWords[2], Height: scratchWords[3],
                    MinZ: scratchFloats[4], MaxZ: scratchFloats[5] });
                break;
            case 'SetLight':
                hr = device.SetLight(words[args], lightFromDwords(scratchFloats, scratchWords));
                break;
            case 'LightEnable':
                hr = device.LightEnable(words[args], words[args + 1] !== 0);
                break;
            case 'SetClipPlane':
                hr = device.SetClipPlane(words[args], scratchFloats.slice(0, 4));
                break;
            case 'SetScissorRect':
                hr = device.SetScissorRect({ left: scratchWords[0], top: scratchWords[1],
                    right: scratchWords[2], bottom: scratchWords[3] });
                break;
            case 'SetSoftwareVertexProcessing':
                hr = device.SetSoftwareVertexProcessing(words[args] !== 0);
                break;
            case 'DrawPrimitive':
                hr = device.DrawPrimitive(words[args], words[args + 1], words[args + 2]);
                break;
            case 'DrawIndexedPrimitive':
                hr = device.DrawIndexedPrimitive(words[args], words[args + 1] | 0, words[args + 2],
                    words[args + 3], words[args + 4], words[args + 5]);
                break;
            default:
            {
                // The constant setters: registers of four floats or integers,
                // or of one boolean.
                const count = words[args + 2];
                const kind = name.charCodeAt(name.length - 1);
                const values = kind === 0x46 // F
                    ? scratchFloats.slice(0, count * 4)
                    : kind === 0x49 // I
                        ? scratchInts.slice(0, count * 4)
                        : scratchWords.slice(0, count);
                hr = device[name](words[args], values, count);
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

/**
 * A D3DMATERIAL9 out of its seventeen floats: four colours, then the power.
 *
 * @param {Float32Array} f
 */
function materialOf(f){
    /** @param {number} at */
    const colour = at=>({ r: f[at], g: f[at + 1], b: f[at + 2], a: f[at + 3] });
    return { Diffuse: colour(0), Ambient: colour(4), Specular: colour(8), Emissive: colour(12),
        Power: f[16] };
}
