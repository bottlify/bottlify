/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Direct3D 7, between a guest call and the object that implements it.
 *
 * There is no entry point for Direct3D 7: a program reaches IDirect3D7 by
 * asking its DirectDraw object for it, and the object it gets is the same one
 * under another table. So this seam does not publish a root; it hands the
 * DirectDraw seam the descriptor to put beside its own, and keeps one D3D7
 * object per DirectDraw object to answer through it.
 *
 * As everywhere in `seam/`, this is translation: pointers become structures,
 * interface pointers become objects, out-parameters are written when the
 * call succeeded. Three things are D3D7's own here: a draw takes its vertex
 * format as an argument and its indices as sixteen-bit words by pointer; the
 * device description is written into a structure with no size field of its
 * own; and the enumerations call back into guest code, which makes them
 * promises the bridge suspends on.
 */

import { describe, IDIRECT3D7_SLOTS, IDIRECT3DDEVICE7_SLOTS, IDIRECT3DVERTEXBUFFER7_SLOTS }
    from './vtables.js';
import {
    IID_IDirect3D7, IID_IDirect3DDevice7, IID_IDirect3DVertexBuffer7, IID_IDirectDrawSurface7,
} from './iids.js';
import {
    D3DCLIPSTATUS, D3DDEVICEDESC7, D3DLIGHT7, D3DPRIMCAPS, D3DRECT, D3DVERTEXBUFFERDESC,
    D3DVIEWPORT7, RECT, createFields,
} from './structs.js';
import { readGuid } from './ddraw.js';
import { writePixelFormat } from '../ddraw/structs.js';
import { depthFormatForDepth } from '../ddraw/objects.js';
import {
    D3DVBCAPS_DONOTCLIP, DDERR_INVALIDPARAMS, D3D_OK,
} from '../d3d7/constants.js';
import { DDPF_ALPHAPIXELS, DDPF_RGB } from '../ddraw/constants.js';
import { createDirect3D7 } from '../d3d7/device.js';
import { D3D7_COMMANDS, clippedBy } from '../d3d7/commands.js';
import { D3DTSS_MAX } from '../d3d7/constants.js';
import { D3DTSS } from '../d3d8/constants.js';
import { createDefaultStageStates } from '../d3d8/stagestates.js';
import {
    BUFFER, COMMAND, DRAWABLE_MIRRORS, RENDER_STATE_MIRROR, TRANSFORM_MIRROR_7, VERTEX_BUFFER7,
    VIEWPORT_GUARD_8,
    VIEWPORT_MIRROR, commandCode, createShadow, getRenderStateCode, getTextureStageStateCode,
    getTransformCode, getViewportCode, lock7Code, settledAfter, stageStateMirror, unlockCode,
} from './shadow.js';

/**
 * The stage states Direct3D 7 takes, as a mask: those a stage has, through
 * TEXTURETRANSFORMFLAGS.
 */
const STAGE_STATE_TYPES_7 = [...createDefaultStageStates(0).keys()]
    .filter(type=>type >= 1 && type <= D3DTSS_MAX && type !== D3DTSS.ADDRESSW - 13)
    .reduce((mask, type)=>mask | 1 << type, 0) >>> 0;

/**
 * What the command routines keep in the block beside the record: the values
 * the getters in the guest read, and what later calls are checked against.
 */
export const COMMAND_MIRRORS = {
    SetRenderState: [...RENDER_STATE_MIRROR],
    SetTextureStageState: stageStateMirror(STAGE_STATE_TYPES_7),
    SetTransform: [...TRANSFORM_MIRROR_7],
    SetViewport: [...VIEWPORT_GUARD_8, ...VIEWPORT_MIRROR],
    BeginScene: [...DRAWABLE_MIRRORS.BeginScene],
    EndScene: [...DRAWABLE_MIRRORS.EndScene],
};

/**
 * Direct3D 3's device setters a frame makes thousands of, as routines that
 * write Direct3D 7's records into the ring of the Direct3D 7 device under a
 * legacy one (`shadeLegacy`): what these calls do to that device is what
 * Direct3D 7's do, but for the projection, which the legacy device multiplies
 * by its viewport's clip volume -- the host's, by its type -- and the render
 * states it answers for itself, which its block does not hold as valid, so
 * that the routine leaves them to the host as well.
 *
 * @type {Readonly<Record<string, any>>}
 */
export const LEGACY_DEVICE_COMMANDS = Object.freeze(Object.fromEntries(Object.entries({
    SetRenderState: {},
    SetTextureStageState: {},
    SetTransform: { within: [{ arg: 0, ranges: [[0, 2], [4, 0xffffffff]] }] },
    SetTexture: {},
}).map(([name, own])=>[name, { ...D3D7_COMMANDS.COMMANDS[name], ...own,
    slot: D3D7_COMMANDS.commandSlot(name),
    mirror: /** @type {Record<string, any>} */ (COMMAND_MIRRORS)[name] }])));

/** The records whose calls a legacy device keeps something of besides (`ringTaken`). */
const LEGACY_TAKEN = new Map(['SetTextureStageState', 'SetTexture']
    .map(name=>[D3D7_COMMANDS.commandSlot(name), name]));

/**
 * Tells a legacy device, in order, each call of a run of records it keeps
 * something of besides what the Direct3D 7 device under it makes of it.
 *
 * @param {Uint8Array} records
 * @param {(name: string, args: number[]) => void} taken
 */
export function tellTaken(records, taken){
    const all = new Uint32Array(records.buffer, records.byteOffset, records.byteLength >>> 2);
    const header = COMMAND.ARGS >>> 2;
    for (let at = 0; at < all.length;)
    {
        const length = all[at + 1] >>> 2;
        if (length === 0)
        {
            break;
        }
        const name = LEGACY_TAKEN.get(all[at]);
        if (name)
        {
            const args = D3D7_COMMANDS.COMMANDS[name].args;
            taken(name, [...all.subarray(at + header, at + header + args)]);
        }
        at += length;
    }
}

/**
 * A device whose GetRenderState refuses the states `refused` names: as its
 * block's valid render states are made from it (`RENDER_STATE_VALID`), so a
 * routine leaves those states to the host. Everything else is the device's.
 *
 * @param {any} device @param {(state: number) => boolean} refused
 */
export function withoutStates(device, refused){
    return new Proxy(device, {
        get(target, key){
            if (key === 'GetRenderState')
            {
                return (/** @type {number} */ state, /** @type {any} */ out)=>(
                    refused(state >>> 0) ? DDERR_INVALIDPARAMS : target.GetRenderState(state, out));
            }
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}
import { loadTexture } from '../d3d7/load.js';
import { D3DVOP, processVertices } from '../d3d7/process.js';
import { decodeFvf } from '../webgpu/internal/vertexformat.js';

/** What an enumeration callback answers to stop. */
const DDENUMRET_CANCEL = 0;

/** Succeeded, and answered nothing -- which is what GetInfo does outside a debug runtime. */
const S_FALSE = 1;

/**
 * @param {number} bitCount @param {number} red @param {number} green @param {number} blue
 * @param {number} alpha
 */
const rgbFormat = (bitCount, red, green, blue, alpha)=>Object.freeze({
    size: 0x20, flags: DDPF_RGB | (alpha !== 0 ? DDPF_ALPHAPIXELS : 0), fourCC: 0, bitCount,
    redMask: red, greenMask: green, blueMask: blue, alphaMask: alpha,
});

/**
 * The texture formats EnumTextureFormats names: the ones the renderer uploads
 * (d3d7/device.js d3dFormatOf), each by its own masks, as a driver of the era
 * named them. A program picks its formats by those masks -- one with alpha for
 * what it blends, 5-5-5 or 4-4-4-4 -- and gives up when the one it looks for
 * is not offered.
 */
const TEXTURE_FORMATS = Object.freeze([
    rgbFormat(32, 0x00ff0000, 0x0000ff00, 0x000000ff, 0),
    rgbFormat(32, 0x00ff0000, 0x0000ff00, 0x000000ff, 0xff000000),
    rgbFormat(16, 0xf800, 0x07e0, 0x001f, 0),
    rgbFormat(16, 0x7c00, 0x03e0, 0x001f, 0),
    rgbFormat(16, 0x7c00, 0x03e0, 0x001f, 0x8000),
    rgbFormat(16, 0x0f00, 0x00f0, 0x000f, 0xf000),
]);

/** The most vertices one draw may name (d3dtypes.h). */
const D3DMAXNUMVERTICES = 0xffff;

/**
 * Which entry of a D3DDRAWPRIMITIVESTRIDEDDATA holds an attribute, and where
 * in that entry's element it starts; the coordinate sets follow at four on.
 *
 * @type {Readonly<Record<string, [number, number]>>}
 */
const STRIDED_STREAMS = Object.freeze({
    position: [0, 0], blendWeight: [0, 12], normal: [1, 0], diffuse: [2, 0], specular: [3, 0],
});

/**
 * A GUID as its sixteen bytes, the way a program reads one out of a structure:
 * three little-endian integers and eight raw bytes.
 *
 * @param {string} guid
 * @returns {Uint8Array}
 */
export function guidBytes(guid){
    const hex = guid.replace(/[{}-]/g, '');
    const word = (/** @type {number} */ from, /** @type {number} */ width)=>
        parseInt(hex.slice(from, from + width), 16);
    const out = new Uint8Array(16);
    const data1 = word(0, 8);
    out[0] = data1 & 0xff;
    out[1] = (data1 >>> 8) & 0xff;
    out[2] = (data1 >>> 16) & 0xff;
    out[3] = data1 >>> 24;
    out[4] = word(8, 4) & 0xff;
    out[5] = word(8, 4) >>> 8;
    out[6] = word(12, 4) & 0xff;
    out[7] = word(12, 4) >>> 8;
    for (let index = 0; index < 8; index++)
    {
        out[8 + index] = word(16 + index * 2, 2);
    }
    return out;
}

/**
 * @typedef {Object} Direct3D7Deps
 * @property {any} publisher
 * @property {any} memory
 * @property {import('../d3d7/device.js').RenderServices
 *            | (() => import('../d3d7/device.js').RenderServices)} [render]
 *           The backend and its company, for a device that draws. A function
 *           is called when the first D3D7 object is made, so that a build
 *           that never reaches Direct3D never builds a GPU.
 * @property {(call: { entry: number, args: number[], thread?: any })
 *              => Promise<number>} [callGuest]
 * @property {() => any} [currentThread]
 * @property {{ allocate: (bytes: number) => number }} [scratch]
 * @property {(bytes: number) => number} [allocate]  Guest memory, for a device's block
 *     of the state its setters write without leaving the guest, and its command ring.
 * @property {(bytes: number) => number} [allocateCode]  Pages of their own for those
 *     setters' code.
 * @property {Set<string>} [traps]  Guest routines kept as traps, by name or group
 *     (`getters`, `ring`).
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {number} [ringBytes]  A device's command ring's size (`shadow.js`).
 */

/**
 * @param {Direct3D7Deps} deps
 */
export function createDirect3D7Seam(
    { publisher, memory, render, callGuest, currentThread, scratch, allocate, allocateCode,
        traps = new Set(), divergence, ringBytes })
{
    const fields = createFields(memory);

    /**
     * Each device's block, its command ring and the routines over them
     * (`shadow.js`): made with the device where there is guest memory for it.
     *
     * @type {WeakMap<object, ReturnType<typeof createShadow>>}
     */
    const shadows = new WeakMap();
    /**
     * Every block made, for `aroundDevices`.
     * ponytail: never pruned -- a program makes a device or two -- prune on release if one
     * remakes them by the thousand.
     *
     * @type {Set<ReturnType<typeof createShadow>>}
     */
    const madeShadows = new Set();
    /** @param {any} device */
    const shadowOf = device=>(device ? shadows.get(device) : undefined);
    /**
     * A transform as this version numbers it, from the number its device keeps
     * it under (Direct3D 8's: WORLD 256, WORLD1..3 257..259; the rest alike).
     *
     * @param {number} key
     */
    const typeOf7 = key=>(key === 256 ? 1 : key > 256 && key < 260 ? key - 253 : key);
    /**
     * Makes what every device's command ring holds, then `call`, then has
     * each block say what its routines check against again: around a call
     * of the DirectDraw seam's -- a Flip shows the draws made before it, a
     * Lock or a Blt of a target reads them, a depth buffer attached is one a
     * clear may ask for -- and of a vertex buffer's, whose Lock may write
     * over what a draw that waits reads.
     *
     * @template T
     * @param {() => T} call
     * @returns {T}
     */
    const aroundDevices = call=>{
        let run = call;
        for (const shadow of madeShadows)
        {
            const inner = run;
            run = ()=>settledAfter(shadow, inner);
        }
        return run();
    };
    /**
     * Each vertex buffer's block (`VERTEX_BUFFER7`): what a draw from it in
     * the ring checks. Where there is guest memory for one.
     *
     * @type {WeakMap<object, number>}
     */
    const vertexBlocks = new WeakMap();
    /**
     * A buffer's lock as its block says it, after a call that may have taken
     * or let go of one.
     *
     * @param {any} buffer
     */
    const noteLocked = buffer=>{
        const owner = buffer ? vertexOwners.get(buffer) : undefined;
        if (owner)
        {
            owner.noteLocked(asShadowBuffer(buffer), buffer.locked);
            return;
        }
        const block = buffer ? vertexBlocks.get(buffer) : undefined;
        if (block !== undefined)
        {
            fields.writeU32(block + VERTEX_BUFFER7.LOCKED, buffer.locked ? 1 : 0);
        }
    };
    /**
     * The device's block that took a buffer's (`adoptBuffer`): from then on
     * the guest's Lock and Unlock keep it, and that device replays them.
     *
     * @type {WeakMap<object, ReturnType<typeof createShadow>>}
     */
    const vertexOwners = new WeakMap();
    /** @type {WeakMap<object, any>} */
    const shadowBuffers = new WeakMap();
    /**
     * A buffer as a device's block replays the guest's locks of it: this
     * version's lock of the whole of it, made as the host's own is
     * (`lockOnHost`), and let go of at once. The host keeps no lock the guest
     * took: this version refuses a draw from a buffer locked, and the ring
     * holds draws made before the lock -- each replay sends what guest memory
     * holds, and the guest's unlock what it wrote last. An unlock lets go of a
     * lock the host took itself.
     *
     * @param {any} buffer
     */
    const asShadowBuffer = buffer=>{
        let adapter = shadowBuffers.get(buffer);
        if (!adapter)
        {
            adapter = {
                base: buffer.base,
                length: buffer.length,
                type: 0,
                usage: 0,
                get refCount(){
                    return buffer.refCount;
                },
                release: ()=>buffer.release(),
                /** @param {number} offset @param {number} size @param {any} out @param {number} [flags] */
                Lock: (offset, size, out, flags)=>{
                    const hr = lockOnHost(buffer, (flags ?? 0) >>> 0, out);
                    if (hr === D3D_OK)
                    {
                        unlock(buffer);
                    }
                    return hr;
                },
                Unlock: ()=>(buffer.locked ? unlock(buffer) : D3D_OK),
            };
            shadowBuffers.set(buffer, adapter);
        }
        return adapter;
    };
    /**
     * A buffer's block taken by a device's (`adoptBuffer`), the first
     * device to draw from it or to lock it on the host.
     *
     * @param {any} buffer @param {ReturnType<typeof createShadow> | undefined} shadow
     */
    const adopt = (buffer, shadow)=>{
        const block = buffer ? vertexBlocks.get(buffer) : undefined;
        if (!shadow || block === undefined || vertexOwners.has(buffer))
        {
            return;
        }
        if (shadow.adoptBuffer(asShadowBuffer(buffer), block))
        {
            vertexOwners.set(buffer, shadow);
        }
    };
    /** @param {(at: number) => Uint8Array} code */
    const placeCode = code=>{
        // Sized by a throwaway rendering: the bytes depend on where they
        // land only through relative jumps, never in length.
        const at = (allocateCode ?? /** @type {(bytes: number) => number} */ (allocate))(
            code(0).length);
        memory.writeMemory(at, code(at));
        return at;
    };
    /**
     * The guest routines a device offers, less those `traps` keeps as traps:
     * by name, or by group -- `getters`, `ring`.
     *
     * @type {Record<string, (builder: { trap: number }) => number>}
     */
    const deviceGuests = allocate
        ? Object.fromEntries(Object.entries({
            GetRenderState: (/** @type {{ trap: number }} */ { trap })=>placeCode(at=>
                getRenderStateCode(at, trap)),
            GetTextureStageState: (/** @type {{ trap: number }} */ { trap })=>placeCode(at=>
                getTextureStageStateCode(at, trap, STAGE_STATE_TYPES_7)),
            GetViewport: (/** @type {{ trap: number }} */ { trap })=>placeCode(at=>
                getViewportCode(at, trap)),
            GetTransform: (/** @type {{ trap: number }} */ { trap })=>placeCode(at=>
                getTransformCode(at, trap, true)),
            ...Object.fromEntries(Object.entries(D3D7_COMMANDS.COMMANDS).map(([name, shape])=>[
                name, (/** @type {{ trap: number }} */ { trap })=>placeCode(at=>commandCode(at,
                    trap, { ...shape, slot: D3D7_COMMANDS.commandSlot(name),
                        mirror: /** @type {Record<string, any>} */ (COMMAND_MIRRORS)[name] }))])),
        }).filter(([name])=>!traps.has(name)
            && !traps.has(name.startsWith('Get') ? 'getters' : 'ring')))
        : {};
    /**
     * Direct3D 3's setters as guest routines (`LEGACY_DEVICE_COMMANDS`), less
     * those `traps` keeps as traps, as the device's own are.
     *
     * @type {Record<string, (builder: { trap: number }) => number>}
     */
    const legacyDeviceGuests = allocate
        ? Object.fromEntries(Object.entries(LEGACY_DEVICE_COMMANDS)
            .filter(([name])=>!traps.has(name) && !traps.has('ring'))
            .map(([name, shape])=>[name, (/** @type {{ trap: number }} */ { trap })=>
                placeCode(at=>commandCode(at, trap, shape))]))
        : {};
    /**
     * What a call the host made changed of what the block mirrors, brought
     * to the block after it: a set the host makes -- its routine kept as a
     * trap, the slow path up -- is one the guest's getters read too. A state
     * block being recorded captures what is set rather than changing it: the
     * guest's setters give way to the host until it ends.
     *
     * @type {Record<string, (shadow: ReturnType<typeof createShadow>, args: number[],
     *     hr: number) => void>}
     */
    const MIRRORED = {
        SetRenderState: (shadow, [state])=>shadow.remirror({ renderStates: [state >>> 0] }),
        SetTransform: (shadow, [type])=>shadow.refreshTransform(type >>> 0),
        MultiplyTransform: (shadow, [type])=>shadow.refreshTransform(type >>> 0),
        SetTextureStageState: (shadow, [stage, type])=>shadow.remirror({
            stageStates: [(stage & 0xffffff) << 8 | type & 0xff] }),
        SetViewport: shadow=>shadow.remirror({ viewport: true }),
        SetRenderTarget: shadow=>shadow.remirror({ viewport: true }),
        ApplyStateBlock: shadow=>shadow.remirror(),
        BeginStateBlock: (shadow, args, hr)=>{
            if (hr === D3D_OK)
            {
                shadow.slowPath(true);
            }
        },
        EndStateBlock: shadow=>shadow.slowPath(false),
    };
    /**
     * Every method first makes what the guest wrote into the ring, and after
     * it what the routines check their calls against is the device's again.
     *
     * @param {Record<string, any>} methods
     * @returns {Record<string, any>}
     */
    const synced = methods=>Object.fromEntries(Object.entries(methods)
        .map(([name, method])=>[name, (/** @type {any} */ device, /** @type {number[]} */ args)=>{
            const shadow = shadowOf(device);
            const hr = settledAfter(shadow, ()=>method(device, args));
            const after = MIRRORED[name];
            if (shadow && after)
            {
                after(shadow, args, typeof hr === 'number' ? hr : D3D_OK);
            }
            return hr;
        }]));

    /**
     * A device's block and command ring (`createShadow`), its records made on
     * the device at its next host entry. A legacy device's (`legacy`) is the
     * Direct3D 7 device's under it, whose ring the legacy one's routines write
     * as well: the render states the legacy device answers for itself are not
     * valid in the block, so its routine leaves them to the host, and what the
     * legacy device keeps of a call besides is told it as the ring is made.
     *
     * @param {any} device
     * @param {{ answersFor: (state: number) => boolean,
     *     taken: (name: string, args: number[]) => void } | null} [legacy]
     */
    const shade = (device, legacy = null)=>{
        const shadow = createShadow({
            ringBytes,
            allocate: /** @type {(bytes: number) => number} */ (allocate),
            readMemory: memory.windowMemory ?? memory.readMemory,
            readU32: memory.readU32,
            writeMemory: memory.writeMemory,
            device: legacy ? withoutStates(device, legacy.answersFor) : device,
            divergence,
            name: legacy ? 'IDirect3DDevice3' : 'IDirect3DDevice7',
            still: work=>{
                if (typeof device.whileStill === 'function')
                {
                    device.whileStill(work);
                    return;
                }
                work();
            },
            commands: { take: records=>{
                const named = D3D7_COMMANDS.commandObjects(records, publisher.objectAt);
                // A buffer a draw in the run reads is readied as the draw
                // made on the host readies it: nothing it reads changes
                // between the draw and here, every call that may is the
                // host's and makes the ring first.
                for (const object of named)
                {
                    if (vertexBlocks.has(object))
                    {
                        drawingFrom(object, shadow);
                    }
                }
                if (legacy)
                {
                    tellTaken(records, legacy.taken);
                }
                const count = device.commands(records, named);
                // A state block applied in the ring: the block is
                // brought to what the blocks applied hold, and the
                // getters may read it again.
                if (shadow.stale())
                {
                    for (const token of D3D7_COMMANDS.tokensApplied(records))
                    {
                        const applied = device.stateBlocks?.get(token);
                        if (applied)
                        {
                            shadow.remirror({ renderStates: applied.renderStates.keys(),
                                transforms: [...applied.transforms.keys()].map(typeOf7),
                                stageStates: applied.stageStates.keys() });
                        }
                    }
                    shadow.settled();
                    shadow.fresh();
                }
                return count;
            } },
        });
        shadows.set(device, shadow);
        madeShadows.add(shadow);
        device.guestState = ()=>shadow.address();
        device.settleGuestRefs = ()=>shadow.sync();
        return shadow;
    };

    /** One D3D7 object per DirectDraw object, made when first asked for. */
    /** @type {WeakMap<object, any>} */
    const objects = new WeakMap();
    /** The device made last, whose counters a run reports. @type {any} */
    let lastDevice = null;
    /**
     * The DirectDraw object each device was made through, as it was
     * published: this layer's bookkeeping, kept here rather than on the
     * device, which remote graphics records and plays elsewhere.
     *
     * @type {WeakMap<object, any>}
     */
    const madeThrough = new WeakMap();
    /** @param {any} root */
    const d3dFor = root=>{
        const existing = objects.get(root);
        if (existing)
        {
            return existing;
        }
        const services = typeof render === 'function' ? render() : render ?? {};
        const made = services.remote
            ? services.remote(root, services)
            : createDirect3D7(root, services);
        objects.set(root, made);
        return made;
    };

    /** Guest memory for what a callback is shown, taken once. */
    let block = 0;
    const scratchBlock = ()=>{
        if (block === 0 && scratch)
        {
            // Two strings, a description and a pixel format share the block;
            // nothing outlives the callback it was written for.
            block = scratch.allocate(0x200);
        }
        return block;
    };
    const canEnumerate = ()=>callGuest !== undefined && scratchBlock() !== 0;

    /** @param {number} pointer @param {number} count @returns {Float32Array} */
    const readFloats = (pointer, count)=>new Float32Array(
        memory.readMemory(pointer >>> 0, count * 4).slice().buffer);

    /** @param {number} pointer @returns {import('../d3d7/device.js').Material} */
    const readMaterial = pointer=>{
        const f = readFloats(pointer, 17);
        const colour = (/** @type {number} */ at)=>(
            { r: f[at], g: f[at + 1], b: f[at + 2], a: f[at + 3] });
        return {
            Diffuse: colour(0),
            Ambient: colour(4),
            Specular: colour(8),
            Emissive: colour(12),
            Power: f[16],
        };
    };

    /** @param {number} pointer @param {import('../d3d7/device.js').Material} material */
    const writeMaterial = (pointer, material)=>{
        const values = [
            material.Diffuse, material.Ambient, material.Specular, material.Emissive,
        ].flatMap(colour=>[colour.r, colour.g, colour.b, colour.a]);
        values.push(material.Power);
        values.forEach((value, index)=>fields.writeF32((pointer >>> 0) + index * 4, value));
    };

    /** @param {number} pointer @returns {import('../d3d7/device.js').Light} */
    const readLight = pointer=>{
        const at = pointer >>> 0;
        const colour = (/** @type {number} */ offset)=>{
            const f = readFloats(at + offset, 4);
            return { r: f[0], g: f[1], b: f[2], a: f[3] };
        };
        const vector = (/** @type {number} */ offset)=>{
            const f = readFloats(at + offset, 3);
            return { x: f[0], y: f[1], z: f[2] };
        };
        return {
            Type: fields.readU32(at + D3DLIGHT7.dltType),
            Diffuse: colour(D3DLIGHT7.dcvDiffuse),
            Specular: colour(D3DLIGHT7.dcvSpecular),
            Ambient: colour(D3DLIGHT7.dcvAmbient),
            Position: vector(D3DLIGHT7.dvPosition),
            Direction: vector(D3DLIGHT7.dvDirection),
            Range: fields.readF32(at + D3DLIGHT7.dvRange),
            Falloff: fields.readF32(at + D3DLIGHT7.dvFalloff),
            Attenuation0: fields.readF32(at + D3DLIGHT7.dvAttenuation0),
            Attenuation1: fields.readF32(at + D3DLIGHT7.dvAttenuation1),
            Attenuation2: fields.readF32(at + D3DLIGHT7.dvAttenuation2),
            Theta: fields.readF32(at + D3DLIGHT7.dvTheta),
            Phi: fields.readF32(at + D3DLIGHT7.dvPhi),
        };
    };

    /** @param {number} pointer @param {import('../d3d7/device.js').Light} light */
    const writeLight = (pointer, light)=>{
        const at = pointer >>> 0;
        fields.writeU32(at + D3DLIGHT7.dltType, light.Type);
        const colour = (/** @type {number} */ offset, /** @type {any} */ c)=>{
            [c.r, c.g, c.b, c.a].forEach((value, index)=>fields.writeF32(at + offset + index * 4,
                value));
        };
        const vector = (/** @type {number} */ offset, /** @type {any} */ v)=>{
            [v.x, v.y, v.z].forEach((value, index)=>
                fields.writeF32(at + offset + index * 4, value));
        };
        colour(D3DLIGHT7.dcvDiffuse, light.Diffuse);
        colour(D3DLIGHT7.dcvSpecular, light.Specular);
        colour(D3DLIGHT7.dcvAmbient, light.Ambient);
        vector(D3DLIGHT7.dvPosition, light.Position);
        vector(D3DLIGHT7.dvDirection, light.Direction);
        fields.writeF32(at + D3DLIGHT7.dvRange, light.Range);
        fields.writeF32(at + D3DLIGHT7.dvFalloff, light.Falloff);
        fields.writeF32(at + D3DLIGHT7.dvAttenuation0, light.Attenuation0);
        fields.writeF32(at + D3DLIGHT7.dvAttenuation1, light.Attenuation1);
        fields.writeF32(at + D3DLIGHT7.dvAttenuation2, light.Attenuation2);
        fields.writeF32(at + D3DLIGHT7.dvTheta, light.Theta);
        fields.writeF32(at + D3DLIGHT7.dvPhi, light.Phi);
    };

    /**
     * Bytes a draw reads straight out of the program's own arrays; null when
     * there is nothing to read, which the device refuses.
     *
     * @param {number} pointer @param {number} length @returns {Uint8Array | null}
     */
    const readArray = (pointer, length)=>((pointer >>> 0) === 0 || !(length > 0)
        ? null
        : memory.readMemory(pointer >>> 0, length));

    /**
     * One stream of a D3DDRAWPRIMITIVESTRIDEDDATA: a pointer and a stride for
     * the position, the normal, the two colours and eight coordinate sets, in
     * that order. Blend weights ride in the position's stream after its three
     * floats; a point size has no stream in this version.
     *
     * @param {number} data @param {string} name  An attribute of decodeFvf's.
     * @returns {{ base: number, stride: number } | null}
     */
    const stridedStream = (data, name)=>{
        const [entry, offset] = STRIDED_STREAMS[name]
            ?? (name.startsWith('texCoord') ? [4 + Number(name.slice('texCoord'.length)), 0]
                : [-1, 0]);
        if (entry < 0)
        {
            return null;
        }
        const at = (data >>> 0) + entry * 8;
        return { base: (fields.readU32(at) + offset) >>> 0, stride: fields.readU32(at + 4) };
    };

    /**
     * The vertices of a strided draw packed as the format lays them out, so
     * the draw goes down the path a draw by pointer takes. Each stream is read
     * once over the span its vertices cover, unless its stride makes that
     * span a waste. Null for no structure, a format with no position, or more
     * vertices than one draw may have -- all of which the draw refuses.
     *
     * @param {number} data @param {number} fvf @param {number} count
     * @returns {Uint8Array | null}
     */
    const gatherStrided = (data, fvf, count)=>{
        if ((data >>> 0) === 0 || count > D3DMAXNUMVERTICES)
        {
            return null;
        }
        let layout;
        try
        {
            layout = decodeFvf(fvf >>> 0);
        }
        catch (e){
            void e;
            return null;
        }
        const packed = new Uint8Array(layout.stride * count);
        layout.attributes.forEach((attribute, index)=>{
            const size = (layout.attributes[index + 1]?.offset ?? layout.stride) - attribute.offset;
            const stream = stridedStream(data, attribute.name);
            if (!stream || count === 0)
            {
                return;
            }
            const spanBytes = (count - 1) * stream.stride + size;
            const span = spanBytes <= count * size * 4
                ? memory.readMemory(stream.base, spanBytes)
                : null;
            for (let k = 0; k < count; k++)
            {
                const bytes = span
                    ? span.subarray(k * stream.stride, k * stream.stride + size)
                    : memory.readMemory((stream.base + k * stream.stride) >>> 0, size);
                packed.set(bytes, k * layout.stride + attribute.offset);
            }
        });
        return packed;
    };

    /** @param {number} fvf @returns {number} the stride of a format, or zero for a bad one */
    const strideOf = fvf=>{
        try
        {
            return decodeFvf(fvf >>> 0).stride;
        }
        catch (e){
            void e;
            return 0;
        }
    };

    /**
     * @param {number} pointer
     * @param {import('../d3d7/caps.js').DeviceCaps} caps
     */
    const writeDeviceDescription = (pointer, caps)=>{
        const at = pointer >>> 0;
        memory.writeMemory(at, new Uint8Array(D3DDEVICEDESC7.SIZE));
        const primitive = (/** @type {number} */ offset, /** @type {any} */ p)=>{
            fields.writeStruct(at + offset, D3DPRIMCAPS, {
                dwSize: D3DPRIMCAPS.SIZE,
                dwMiscCaps: p.miscCaps,
                dwRasterCaps: p.rasterCaps,
                dwZCmpCaps: p.zCmpCaps,
                dwSrcBlendCaps: p.srcBlendCaps,
                dwDestBlendCaps: p.destBlendCaps,
                dwAlphaCmpCaps: p.alphaCmpCaps,
                dwShadeCaps: p.shadeCaps,
                dwTextureCaps: p.textureCaps,
                dwTextureFilterCaps: p.textureFilterCaps,
                dwTextureBlendCaps: p.textureBlendCaps,
                dwTextureAddressCaps: p.textureAddressCaps,
                dwStippleWidth: p.stippleWidth,
                dwStippleHeight: p.stippleHeight,
            });
        };
        primitive(D3DDEVICEDESC7.dpcLineCaps, caps.lineCaps);
        primitive(D3DDEVICEDESC7.dpcTriCaps, caps.triCaps);
        fields.writeStruct(at, D3DDEVICEDESC7, {
            dwDevCaps: caps.devCaps,
            dwDeviceRenderBitDepth: caps.deviceRenderBitDepth,
            dwDeviceZBufferBitDepth: caps.deviceZBufferBitDepth,
            dwMinTextureWidth: caps.minTextureWidth,
            dwMinTextureHeight: caps.minTextureHeight,
            dwMaxTextureWidth: caps.maxTextureWidth,
            dwMaxTextureHeight: caps.maxTextureHeight,
            dwMaxTextureRepeat: caps.maxTextureRepeat,
            dwMaxTextureAspectRatio: caps.maxTextureAspectRatio,
            dwMaxAnisotropy: caps.maxAnisotropy,
            dvGuardBandLeft: caps.guardBandLeft,
            dvGuardBandTop: caps.guardBandTop,
            dvGuardBandRight: caps.guardBandRight,
            dvGuardBandBottom: caps.guardBandBottom,
            dvExtentsAdjust: caps.extentsAdjust,
            dwStencilCaps: caps.stencilCaps,
            dwFVFCaps: caps.fvfCaps,
            dwTextureOpCaps: caps.textureOpCaps,
            dwMaxActiveLights: caps.maxActiveLights,
            dvMaxVertexW: caps.maxVertexW,
            dwVertexProcessingCaps: caps.vertexProcessingCaps,
        }, ['dvGuardBandLeft', 'dvGuardBandTop', 'dvGuardBandRight', 'dvGuardBandBottom',
            'dvExtentsAdjust', 'dvMaxVertexW']);
        // The two WORD pairs share a dword each, low word first.
        fields.writeU32(at + D3DDEVICEDESC7.wMaxTextureBlendStages,
            (caps.maxTextureBlendStages & 0xffff) | (caps.maxSimultaneousTextures << 16));
        fields.writeU32(at + D3DDEVICEDESC7.wMaxUserClipPlanes,
            (caps.maxUserClipPlanes & 0xffff) | (caps.maxVertexBlendMatrices << 16));
        memory.writeMemory(at + D3DDEVICEDESC7.deviceGUID, guidBytes(caps.deviceGuid));
    };

    /** @param {number} pointer @param {string} text NUL-terminated ANSI, as a name travels */
    const writeString = (pointer, text)=>{
        const bytes = new Uint8Array(text.length + 1);
        for (let index = 0; index < text.length; index++)
        {
            bytes[index] = text.charCodeAt(index) & 0x7f;
        }
        memory.writeMemory(pointer, bytes);
    };

    // --- vertex buffer ---

    /**
     * Runs ProcessVertices into a buffer, which is written as a lock would
     * write it, so a device drawing the buffer takes the new vertices.
     *
     * @param {any} buffer
     * @param {number} op @param {number} destIndex @param {number} count
     * @param {number} device @param {number} flags
     * @param {import('../d3d7/process.js').VertexSource} source
     */
    const processInto = (buffer, op, destIndex, count, device, flags, source)=>{
        const owner = publisher.objectAt(device);
        if (!owner)
        {
            return DDERR_INVALIDPARAMS;
        }
        const clips = (op & D3DVOP.CLIP) !== 0 && (buffer.caps & D3DVBCAPS_DONOTCLIP) === 0;
        if (buffer.clipCodes !== clips)
        {
            buffer.ClipCodes(clips);
        }
        // Only the vertices written are locked, and the one after them, whose
        // first four bytes take the last RHW (`processVertices`); a buffer no
        // draw has read yet is written in place and read whole at its first.
        const locking = !buffer.locked;
        if (locking && drawn.has(buffer))
        {
            buffer.LockRange((destIndex >>> 0) * buffer.stride,
                ((count >>> 0) + 1) * buffer.stride, 0, {});
        }
        else if (locking)
        {
            buffer.LockInPlace({});
            unseen.add(buffer);
        }
        const hr = processVertices({ memory, vertexOp: op >>> 0, dest: buffer,
            destIndex: destIndex >>> 0, count: count >>> 0, source,
            state: owner.processingState(), flags: flags >>> 0 });
        if (locking)
        {
            unlock(buffer);
        }
        return hr;
    };

    /**
     * The vertex buffers a draw has read. Until one has, the program's locks
     * of a buffer are taken in place: nothing reads it but ProcessVertices,
     * here, from guest memory, and a lock the renderer was told of had all of
     * it compared or sent at every unlock -- a program that fills a megabyte
     * buffer's first four vertices a quad sent the megabyte a quad.
     *
     * @type {WeakSet<object>}
     */
    const drawn = new WeakSet();
    /** The buffers written in place since a draw last read them whole. @type {WeakSet<object>} */
    const unseen = new WeakSet();
    /** @param {any} buffer */
    const unlock = buffer=>(buffer.lockedInPlace ? buffer.UnlockInPlace() : buffer.Unlock());
    /**
     * A buffer as a draw is about to read it: what was written in place goes
     * to the renderer first, by a lock of all of it.
     *
     * @param {any} buffer
     * @param {ReturnType<typeof createShadow>} [shadow]  the device's block, which takes the
     *     buffer's (`adopt`)
     */
    const drawingFrom = (buffer, shadow = undefined)=>{
        adopt(buffer, shadow);
        if (!buffer || buffer.locked)
        {
            return;
        }
        drawn.add(buffer);
        if (unseen.has(buffer))
        {
            unseen.delete(buffer);
            buffer.Lock(0, {});
            buffer.Unlock();
        }
    };

    /**
     * Readies a buffer for a draw from it (`drawingFrom`), and answers what
     * the draw is told of its clipping: a buffer whose last ProcessVertices
     * was asked to clip, made without D3DVBCAPS_DONOTCLIP, keeps each
     * vertex's clip codes, and the runtime clips the triangles when it is
     * drawn unless the draw says D3DDP_DONOTCLIP (decisions.md A45). The
     * buffer holds it (`ClipCodes`), so a device drawn elsewhere has it too.
     *
     * @param {any} buffer @param {number} flags D3DDP
     * @param {ReturnType<typeof createShadow>} [shadow]
     * @returns {number}
     */
    const clippedDraw = (buffer, flags, shadow = undefined)=>{
        drawingFrom(buffer, shadow);
        return clippedBy(buffer, flags >>> 0);
    };

    /**
     * The host's lock of a buffer: through the renderer once a draw has read
     * it, in place before that (`drawingFrom` reads it whole then).
     *
     * @param {any} buffer @param {number} flags DDLOCK
     * @param {{ data?: number, size?: number }} locked
     * @returns {number}
     */
    const lockOnHost = (buffer, flags, locked)=>{
        if (drawn.has(buffer))
        {
            return buffer.Lock(flags, locked);
        }
        const hr = buffer.LockInPlace(locked);
        if (hr === D3D_OK)
        {
            unseen.add(buffer);
        }
        return hr;
    };

    /**
     * Each method first makes what the rings hold -- a draw from the buffer
     * waiting in one reads it as it was -- and after it the buffer's block
     * says whether it is locked.
     *
     * @template {Record<string, (buffer: any, args: number[]) => any>} T
     * @param {T} methods
     * @returns {T}
     */
    const bufferSynced = methods=>/** @type {T} */ (Object.fromEntries(Object.entries(methods)
        .map(([name, method])=>[name, (/** @type {any} */ buffer, /** @type {number[]} */ args)=>{
            // What the guest did to it first, as Direct3D 8's buffers settle;
            // a buffer no device took is taken by the last one made.
            adopt(buffer, shadowOf(lastDevice));
            vertexOwners.get(buffer)?.settleBuffer(asShadowBuffer(buffer));
            const hr = aroundDevices(()=>method(buffer, args));
            noteLocked(buffer);
            return hr;
        }])));

    const bufferMethods = bufferSynced({
        /** @param {any} buffer @param {number[]} args */
        Lock: (buffer, [flags, out, sizeOut])=>{
            if ((out >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            /** @type {{ data?: number, size?: number }} */
            const locked = {};
            const hr = lockOnHost(buffer, flags >>> 0, locked);
            if (hr === D3D_OK)
            {
                fields.writeU32(out >>> 0, locked.data ?? 0);
                if ((sizeOut >>> 0) !== 0)
                {
                    fields.writeU32(sizeOut >>> 0, locked.size ?? 0);
                }
            }
            return hr;
        },
        /** @param {any} buffer */
        Unlock: (/** @type {any} */ buffer)=>unlock(buffer),
        /** @param {any} buffer @param {number[]} args */
        GetVertexBufferDesc: (buffer, [out])=>{
            if ((out >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            /** @type {{ desc?: any }} */
            const held = {};
            buffer.GetVertexBufferDesc(held);
            fields.writeStruct(out >>> 0, D3DVERTEXBUFFERDESC, {
                dwSize: D3DVERTEXBUFFERDESC.SIZE,
                dwCaps: held.desc.caps,
                dwFVF: held.desc.fvf,
                dwNumVertices: held.desc.numVertices,
            });
            return D3D_OK;
        },
        /** @param {any} buffer */
        Optimize: (/** @type {any} */ buffer)=>buffer.Optimize(),
        /** @param {any} buffer @param {number[]} args */
        ProcessVertices: (buffer, [op, destIndex, count, source, sourceIndex, device, flags])=>{
            const from = publisher.objectAt(source);
            if (!from || (sourceIndex >>> 0) + (count >>> 0) > from.numVertices)
            {
                return DDERR_INVALIDPARAMS;
            }
            const layout = decodeFvf(from.fvf);
            return processInto(buffer, op, destIndex, count, device, flags, {
                fvf: from.fvf,
                addressOf: (name, k)=>{
                    const attribute = layout.attributes.find(entry=>entry.name === name);
                    return attribute
                        ? from.base + ((sourceIndex >>> 0) + k) * layout.stride + attribute.offset
                        : null;
                },
            });
        },
        /**
         * The source is a D3DDRAWPRIMITIVESTRIDEDDATA, each stream read from
         * its first vertex.
         *
         * @param {any} buffer @param {number[]} args
         */
        ProcessVerticesStrided: (buffer, [op, destIndex, count, data, fvf, device, flags])=>{
            if ((data >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            let layout;
            try
            {
                layout = decodeFvf(fvf >>> 0);
            }
            catch (e){
                void e;
                return DDERR_INVALIDPARAMS;
            }
            return processInto(buffer, op, destIndex, count, device, flags, {
                fvf: fvf >>> 0,
                addressOf: (name, k)=>{
                    const stream = layout.attributes.some(entry=>entry.name === name)
                        ? stridedStream(data, name)
                        : null;
                    return stream ? stream.base + k * stream.stride : null;
                },
            });
        },
    });
    /**
     * Lock and Unlock in the guest, as Direct3D 8's and 9's buffers have
     * them (`lock7Code`): unless `traps` keeps them, by name or as `locks`.
     *
     * @type {Record<string, (builder: { trap: number }) => number>}
     */
    const bufferGuests = allocate
        ? Object.fromEntries(Object.entries({
            Lock: (/** @type {{ trap: number }} */ { trap })=>placeCode(at=>lock7Code(at, trap)),
            Unlock: (/** @type {{ trap: number }} */ { trap })=>placeCode(at=>
                unlockCode(at, trap)),
        }).filter(([name])=>!traps.has(name) && !traps.has('locks')))
        : {};
    const bufferInterfaces = [
        describe(IID_IDirect3DVertexBuffer7, IDIRECT3DVERTEXBUFFER7_SLOTS, bufferMethods,
            bufferGuests),
    ];

    // --- device ---

    const deviceMethods = {
        /** @param {any} device @param {number[]} args */
        GetCaps: (device, [out])=>{
            if ((out >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            /** @type {{ caps?: any }} */
            const held = {};
            device.GetCaps(held);
            writeDeviceDescription(out, held.caps);
            return D3D_OK;
        },

        /**
         * The formats a texture may have, one callback each. A program that
         * cannot be called back is told there are none, which it handles as
         * a device with no textures would be handled.
         *
         * @param {any} device @param {number[]} args
         */
        EnumTextureFormats: (device, [callback, context])=>{
            if ((callback >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            if (!canEnumerate())
            {
                return D3D_OK;
            }
            const call = /** @type {NonNullable<typeof callGuest>} */ (callGuest);
            // Whose call this is, before the loop awaits anything: only the
            // first callback of an enumeration runs on the thread standing here.
            const asked = currentThread?.();
            return (async()=>{
                for (const format of TEXTURE_FORMATS)
                {
                    const at = scratchBlock();
                    writePixelFormat(memory, at, format);
                    const answer = await call({ entry: callback >>> 0,
                        args: [at, context >>> 0], thread: asked });
                    if ((answer >>> 0) === DDENUMRET_CANCEL)
                    {
                        break;
                    }
                }
                return D3D_OK;
            })();
        },

        /** @param {any} device */
        BeginScene: (/** @type {any} */ device)=>device.BeginScene(),
        /** @param {any} device */
        EndScene: (/** @type {any} */ device)=>device.EndScene(),

        /** @param {any} device @param {number[]} args */
        GetDirect3D: (device, [out])=>{
            if ((out >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            // IDirect3D7 shares IDirectDraw7's count, and the object it is
            // published on is the one CreateDevice was called through.
            const root = madeThrough.get(device);
            root.addRef(IID_IDirect3D7);
            fields.writeU32(out >>> 0, publisher.publish(root, [], IID_IDirect3D7));
            return D3D_OK;
        },

        /** @param {any} device @param {number[]} args */
        SetRenderTarget: (device, [surface])=>device.SetRenderTarget(publisher.objectAt(surface)),

        /** @param {any} device @param {number[]} args */
        GetRenderTarget: (device, [out])=>{
            if ((out >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            /** @type {{ surface?: any }} */
            const held = {};
            device.GetRenderTarget(held);
            fields.writeU32(out >>> 0,
                publisher.publish(held.surface, [], IID_IDirectDrawSurface7));
            return D3D_OK;
        },

        // Z arrives as a float in a slot read as a dword; the bytes are the
        // caller's, only the interpretation differs.
        /** @param {any} device @param {number[]} args */
        Clear: (device, [count, rects, flags, colour, z, stencil])=>device.Clear(
            count >>> 0,
            (rects >>> 0) === 0
                ? null
                : Array.from({ length: count >>> 0 }, (_, index)=>
                    fields.readStruct((rects >>> 0) + index * D3DRECT.SIZE, D3DRECT)),
            flags >>> 0, colour >>> 0, fields.asFloat(z), stencil >>> 0),

        /** @param {any} device @param {number[]} args */
        SetTransform: (device, [type, matrix])=>((matrix >>> 0) === 0
            ? DDERR_INVALIDPARAMS
            : device.SetTransform(type >>> 0, readFloats(matrix, 16))),

        /** @param {any} device @param {number[]} args */
        GetTransform: (device, [type, out])=>{
            if ((out >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            /** @type {{ matrix?: Float32Array }} */
            const held = {};
            const hr = device.GetTransform(type >>> 0, held);
            if (hr === D3D_OK && held.matrix)
            {
                held.matrix.forEach((value, index)=>
                    fields.writeF32((out >>> 0) + index * 4, value));
            }
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        MultiplyTransform: (device, [type, matrix])=>((matrix >>> 0) === 0
            ? DDERR_INVALIDPARAMS
            : device.MultiplyTransform(type >>> 0, readFloats(matrix, 16))),

        /** @param {any} device @param {number[]} args */
        SetViewport: (device, [pointer])=>{
            if ((pointer >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            const raw = fields.readStruct(pointer >>> 0, D3DVIEWPORT7, ['dvMinZ', 'dvMaxZ']);
            return device.SetViewport({
                X: raw.dwX, Y: raw.dwY, Width: raw.dwWidth, Height: raw.dwHeight,
                MinZ: raw.dvMinZ, MaxZ: raw.dvMaxZ,
            });
        },

        /** @param {any} device @param {number[]} args */
        GetViewport: (device, [out])=>{
            if ((out >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            /** @type {{ viewport?: any }} */
            const held = {};
            device.GetViewport(held);
            const v = held.viewport;
            fields.writeStruct(out >>> 0, D3DVIEWPORT7, {
                dwX: v.X, dwY: v.Y, dwWidth: v.Width, dwHeight: v.Height,
                dvMinZ: v.MinZ, dvMaxZ: v.MaxZ,
            }, ['dvMinZ', 'dvMaxZ']);
            return D3D_OK;
        },

        /** @param {any} device @param {number[]} args */
        SetMaterial: (device, [pointer])=>((pointer >>> 0) === 0
            ? DDERR_INVALIDPARAMS
            : device.SetMaterial(readMaterial(pointer))),

        /** @param {any} device @param {number[]} args */
        GetMaterial: (device, [out])=>{
            if ((out >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            /** @type {{ material?: any }} */
            const held = {};
            device.GetMaterial(held);
            writeMaterial(out, held.material);
            return D3D_OK;
        },

        /** @param {any} device @param {number[]} args */
        SetLight: (device, [index, pointer])=>((pointer >>> 0) === 0
            ? DDERR_INVALIDPARAMS
            : device.SetLight(index >>> 0, readLight(pointer))),

        /** @param {any} device @param {number[]} args */
        GetLight: (device, [index, out])=>{
            if ((out >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            /** @type {{ light?: any }} */
            const held = {};
            const hr = device.GetLight(index >>> 0, held);
            if (hr === D3D_OK && held.light)
            {
                writeLight(out, held.light);
            }
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        SetRenderState: (device, [state, value])=>device.SetRenderState(state >>> 0, value >>> 0),

        /** @param {any} device @param {number[]} args */
        GetRenderState: (device, [state, out])=>{
            /** @type {{ value?: number }} */
            const held = {};
            const hr = device.GetRenderState(state >>> 0, held);
            if (hr === D3D_OK && (out >>> 0) !== 0)
            {
                fields.writeU32(out >>> 0, held.value ?? 0);
            }
            return hr;
        },

        /** @param {any} device */
        BeginStateBlock: (/** @type {any} */ device)=>device.BeginStateBlock(),

        /** @param {any} device @param {number[]} args */
        EndStateBlock: (device, [out])=>{
            /** @type {{ handle?: number }} */
            const held = {};
            const hr = device.EndStateBlock(held);
            if (hr === D3D_OK && (out >>> 0) !== 0)
            {
                fields.writeU32(out >>> 0, held.handle ?? 0);
            }
            return hr;
        },

        PreLoad: ()=>D3D_OK,

        /**
         * Vertices by pointer: the count of vertices, times the stride the
         * format implies, is how far to read.
         *
         * @param {any} device @param {number[]} args
         */
        DrawPrimitive: (device, [type, fvf, vertices, count])=>device.DrawPrimitive(
            type >>> 0, fvf >>> 0,
            readArray(vertices, (count >>> 0) * strideOf(fvf)), count >>> 0),

        /** @param {any} device @param {number[]} args */
        DrawIndexedPrimitive: (device, [type, fvf, vertices, count, indices, indexCount])=>
            device.DrawIndexedPrimitive(type >>> 0, fvf >>> 0,
                readArray(vertices, (count >>> 0) * strideOf(fvf)), count >>> 0,
                readArray(indices, (indexCount >>> 0) * 2), indexCount >>> 0),

        /** @param {any} device @param {number[]} args */
        SetClipStatus: (device, [pointer])=>{
            if ((pointer >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            const raw = fields.readStruct(pointer >>> 0, D3DCLIPSTATUS,
                ['minx', 'maxx', 'miny', 'maxy', 'minz', 'maxz']);
            return device.SetClipStatus({
                flags: raw.dwFlags,
                status: raw.dwStatus,
                extents: [raw.minx, raw.maxx, raw.miny, raw.maxy, raw.minz, raw.maxz],
            });
        },

        /** @param {any} device @param {number[]} args */
        GetClipStatus: (device, [out])=>{
            if ((out >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            /** @type {{ status?: any }} */
            const held = {};
            device.GetClipStatus(held);
            const s = held.status;
            fields.writeStruct(out >>> 0, D3DCLIPSTATUS, {
                dwFlags: s.flags, dwStatus: s.status,
                minx: s.extents[0], maxx: s.extents[1], miny: s.extents[2], maxy: s.extents[3],
                minz: s.extents[4], maxz: s.extents[5],
            }, ['minx', 'maxx', 'miny', 'maxy', 'minz', 'maxz']);
            return D3D_OK;
        },

        /** @param {any} device @param {number[]} args */
        DrawPrimitiveStrided: (device, [type, fvf, data, count])=>device.DrawPrimitive(
            type >>> 0, fvf >>> 0, gatherStrided(data, fvf, count >>> 0), count >>> 0),

        /** @param {any} device @param {number[]} args */
        DrawIndexedPrimitiveStrided: (device, [type, fvf, data, count, indices, indexCount])=>
            device.DrawIndexedPrimitive(type >>> 0, fvf >>> 0,
                gatherStrided(data, fvf, count >>> 0), count >>> 0,
                readArray(indices, (indexCount >>> 0) * 2), indexCount >>> 0),

        /** @param {any} device @param {number[]} args */
        DrawPrimitiveVB: (device, [type, buffer, start, count, flags])=>{
            const vertices = publisher.objectAt(buffer);
            return device.DrawPrimitiveVB(type >>> 0, vertices, start >>> 0, count >>> 0,
                clippedDraw(vertices, flags, shadowOf(device)));
        },

        /** @param {any} device @param {number[]} args */
        DrawIndexedPrimitiveVB: (device, args)=>{
            const [type, buffer, start, count, indices, indexCount, flags] = args;
            const vertices = publisher.objectAt(buffer);
            return device.DrawIndexedPrimitiveVB(type >>> 0, vertices, start >>> 0,
                count >>> 0, indices >>> 0, indexCount >>> 0,
                clippedDraw(vertices, flags, shadowOf(device)));
        },

        /** @param {any} device @param {number[]} args */
        GetTexture: (device, [stage, out])=>{
            if ((out >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            /** @type {{ surface?: any }} */
            const held = {};
            const hr = device.GetTexture(stage >>> 0, held);
            if (hr === D3D_OK)
            {
                fields.writeU32(out >>> 0, held.surface
                    ? publisher.publish(held.surface, [], IID_IDirectDrawSurface7)
                    : 0);
            }
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        SetTexture: (device, [stage, surface])=>
            device.SetTexture(stage >>> 0, publisher.objectAt(surface)),

        /** @param {any} device @param {number[]} args */
        GetTextureStageState: (device, [stage, type, out])=>{
            /** @type {{ value?: number }} */
            const held = {};
            const hr = device.GetTextureStageState(stage >>> 0, type >>> 0, held);
            if (hr === D3D_OK && (out >>> 0) !== 0)
            {
                fields.writeU32(out >>> 0, held.value ?? 0);
            }
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        SetTextureStageState: (device, [stage, type, value])=>
            device.SetTextureStageState(stage >>> 0, type >>> 0, value >>> 0),

        /** @param {any} device @param {number[]} args */
        ValidateDevice: (device, [out])=>{
            /** @type {{ passes?: number }} */
            const held = {};
            const hr = device.ValidateDevice(held);
            if (hr === D3D_OK && (out >>> 0) !== 0)
            {
                fields.writeU32(out >>> 0, held.passes ?? 1);
            }
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        ApplyStateBlock: (device, [handle])=>device.ApplyStateBlock(handle >>> 0),
        /** @param {any} device @param {number[]} args */
        CaptureStateBlock: (device, [handle])=>device.CaptureStateBlock(handle >>> 0),
        /** @param {any} device @param {number[]} args */
        DeleteStateBlock: (device, [handle])=>device.DeleteStateBlock(handle >>> 0),

        /** @param {any} device @param {number[]} args */
        CreateStateBlock: (device, [type, out])=>{
            if ((out >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            /** @type {{ handle?: number }} */
            const held = {};
            const hr = device.CreateStateBlock(type >>> 0, held);
            if (hr === D3D_OK)
            {
                fields.writeU32(out >>> 0, held.handle ?? 0);
            }
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        LightEnable: (device, [index, enable])=>device.LightEnable(index >>> 0, enable !== 0),

        /** @param {any} device @param {number[]} args */
        GetLightEnable: (device, [index, out])=>{
            /** @type {{ enabled?: boolean }} */
            const held = {};
            const hr = device.GetLightEnable(index >>> 0, held);
            if (hr === D3D_OK && (out >>> 0) !== 0)
            {
                fields.writeU32(out >>> 0, held.enabled ? 1 : 0);
            }
            return hr;
        },

        /**
         * The flags name cube faces, and no surface here is a cube map.
         *
         * @param {any} device @param {number[]} args
         */
        Load: (device, [dest, point, src, rect])=>loadTexture({
            memory,
            dest: publisher.objectAt(dest),
            destPoint: (point >>> 0) === 0
                ? null
                : { x: fields.readU32(point >>> 0) | 0, y: fields.readU32((point >>> 0) + 4) | 0 },
            src: publisher.objectAt(src),
            srcRect: (rect >>> 0) === 0
                ? null
                : {
                    left: fields.readU32((rect >>> 0) + RECT.left) | 0,
                    top: fields.readU32((rect >>> 0) + RECT.top) | 0,
                    right: fields.readU32((rect >>> 0) + RECT.right) | 0,
                    bottom: fields.readU32((rect >>> 0) + RECT.bottom) | 0,
                },
        }),

        /** @param {any} device @param {number[]} args */
        ComputeSphereVisibility: (device, [centers, radii, count, , results])=>{
            if ((centers >>> 0) === 0 || (radii >>> 0) === 0 || (results >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            const points = readFloats(centers, (count >>> 0) * 3);
            /** @type {{ results?: number[] }} */
            const held = {};
            const hr = device.ComputeSphereVisibility(
                Array.from({ length: count >>> 0 }, (_, k)=>[...points.subarray(k * 3, k * 3 + 3)]),
                [...readFloats(radii, count >>> 0)], held);
            if (hr === D3D_OK)
            {
                (held.results ?? []).forEach((status, k)=>
                    fields.writeU32((results >>> 0) + k * 4, status));
            }
            return hr;
        },

        // The retail answer: the call succeeded and there is nothing to report,
        // which is what a program checks before reading the structure it
        // passed. Nothing is written into it.
        GetInfo: ()=>S_FALSE,

        /** @param {any} device @param {number[]} args */
        SetClipPlane: (device, [index, pointer])=>((pointer >>> 0) === 0
            ? DDERR_INVALIDPARAMS
            : device.SetClipPlane(index >>> 0, [...readFloats(pointer, 4)])),

        /** @param {any} device @param {number[]} args */
        GetClipPlane: (device, [index, out])=>{
            if ((out >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            /** @type {{ plane?: number[] }} */
            const held = {};
            const hr = device.GetClipPlane(index >>> 0, held);
            if (hr === D3D_OK && held.plane)
            {
                held.plane.forEach((value, index2)=>
                    fields.writeF32((out >>> 0) + index2 * 4, value));
            }
            return hr;
        },
    };

    const deviceInterfaces = [
        describe(IID_IDirect3DDevice7, IDIRECT3DDEVICE7_SLOTS, synced(deviceMethods), deviceGuests),
    ];

    // A surface handed back here was made through IDirectDraw7 and published
    // by the DirectDraw seam as that generation's surface; asking the
    // publisher for the same identifier answers the same pointer.

    // --- the IDirect3D7 slots, on the DirectDraw object ---

    const d3dMethods = {
        /**
         * Each device is named to the callback with its description and
         * name written into the scratch block and its capabilities beside
         * them; the callback gets pointers to all three.
         *
         * @param {any} root @param {number[]} args
         */
        EnumDevices: (root, [callback, context])=>{
            if ((callback >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            if (!canEnumerate())
            {
                return D3D_OK;
            }
            const call = /** @type {NonNullable<typeof callGuest>} */ (callGuest);
            // Whose call this is, before the loop awaits anything: only the
            // first callback of an enumeration runs on the thread standing here.
            const asked = currentThread?.();
            const d3d = d3dFor(root);
            return (async()=>{
                for (const device of d3d.enumDevices())
                {
                    const at = scratchBlock();
                    const description = at + D3DDEVICEDESC7.SIZE;
                    const name = description + 0x80;
                    writeDeviceDescription(at, device.caps);
                    writeString(description, device.text);
                    writeString(name, device.name);
                    const answer = await call({ entry: callback >>> 0,
                        args: [description, name, at, context >>> 0], thread: asked });
                    if ((answer >>> 0) === DDENUMRET_CANCEL)
                    {
                        break;
                    }
                }
                return D3D_OK;
            })();
        },

        /** @param {any} root @param {number[]} args */
        CreateDevice: (root, [riid, surface, out])=>{
            if ((riid >>> 0) === 0 || (out >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            const made = d3dFor(root).createDevice(readGuid(memory, riid),
                publisher.objectAt(surface));
            if (made.hr !== D3D_OK)
            {
                fields.writeU32(out >>> 0, 0);
                return made.hr;
            }
            madeThrough.set(made.device, root);
            lastDevice = made.device;
            if (allocate)
            {
                // The block, which the guest methods find one word past the
                // interface pointer: made before the interface is published,
                // which is when that word is written.
                shade(made.device);
            }
            fields.writeU32(out >>> 0,
                publisher.publish(made.device, deviceInterfaces, IID_IDirect3DDevice7));
            return D3D_OK;
        },

        /** @param {any} root @param {number[]} args */
        CreateVertexBuffer: (root, [desc, out])=>{
            if ((desc >>> 0) === 0 || (out >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            const raw = fields.readStruct(desc >>> 0, D3DVERTEXBUFFERDESC);
            if (raw.dwSize !== D3DVERTEXBUFFERDESC.SIZE)
            {
                return DDERR_INVALIDPARAMS;
            }
            const made = d3dFor(root).createVertexBuffer({
                caps: raw.dwCaps, fvf: raw.dwFVF, numVertices: raw.dwNumVertices,
            });
            if (made.hr !== D3D_OK)
            {
                return made.hr;
            }
            const own = allocate ? allocate(VERTEX_BUFFER7.SIZE) : 0;
            if (own !== 0)
            {
                // Found one word past the interface pointer, which publishing
                // writes: a buffer's block no device has taken yet, its
                // storage in it, and how many vertices it holds.
                const words = new Uint32Array(VERTEX_BUFFER7.SIZE / 4);
                words[BUFFER.BASE / 4] = made.buffer.base;
                words[BUFFER.LENGTH / 4] = made.buffer.length;
                words[VERTEX_BUFFER7.VERTICES / 4] = made.buffer.numVertices >>> 0;
                memory.writeMemory(own, new Uint8Array(words.buffer));
                vertexBlocks.set(made.buffer, own);
                made.buffer.guestState = ()=>own;
                // A draw in a ring holds the buffer from when the ring is made.
                made.buffer.settleGuestRefs = ()=>aroundDevices(()=>undefined);
            }
            fields.writeU32(out >>> 0,
                publisher.publish(made.buffer, bufferInterfaces, IID_IDirect3DVertexBuffer7));
            return D3D_OK;
        },

        /**
         * The depth formats a device can have: sixteen bits of depth, and
         * twenty-four with eight of stencil.
         *
         * @param {any} root @param {number[]} args
         */
        EnumZBufferFormats: (root, [, callback, context])=>{
            if ((callback >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            if (!canEnumerate())
            {
                return D3D_OK;
            }
            const call = /** @type {NonNullable<typeof callGuest>} */ (callGuest);
            // Whose call this is, before the loop awaits anything: only the
            // first callback of an enumeration runs on the thread standing here.
            const asked = currentThread?.();
            return (async()=>{
                for (const depth of [16, 32])
                {
                    const at = scratchBlock();
                    writePixelFormat(memory, at, depthFormatForDepth(depth));
                    const answer = await call({ entry: callback >>> 0,
                        args: [at, context >>> 0], thread: asked });
                    if ((answer >>> 0) === DDENUMRET_CANCEL)
                    {
                        break;
                    }
                }
                return D3D_OK;
            })();
        },

        EvictManagedTextures: ()=>D3D_OK,
    };

    return {
        /** The descriptor the DirectDraw seam puts beside its own generations. */
        interface: describe(IID_IDirect3D7, IDIRECT3D7_SLOTS, d3dMethods),

        /** For tests, which have no guest to call through. */
        interfaces: { device: deviceInterfaces, buffer: bufferInterfaces },

        /** What the device made last drew, as Direct3D 8's and 9's seams answer it. */
        diagnostics: ()=>lastDevice?.diagnostics?.() ?? null,

        aroundDevices,

        /**
         * What the Direct3D of DirectX 3, 5 and 6 shares with this one: the
         * object per DirectDraw object, and the translations of the calls
         * whose arguments did not change -- its devices wrap these devices,
         * and its vertex buffer is this one under an older table.
         */
        shared: {
            d3dFor, deviceMethods, bufferMethods, d3dMethods, gatherStrided, readArray, readFloats,
            strideOf, writeString, textureFormats: TEXTURE_FORMATS, clippedDraw,
            /**
             * The block and ring of the Direct3D 7 device under a legacy one
             * (`shade`), where there is guest memory for them; null where not.
             *
             * @param {any} inner
             * @param {{ answersFor: (state: number) => boolean,
             *     taken: (name: string, args: number[]) => void }} legacy
             */
            shadeLegacy: (/** @type {any} */ inner, /** @type {any} */ legacy)=>
                (allocate ? shade(inner, legacy) : null),
            /**
             * `call`, after what the device's routines wrote into its ring is
             * made, with what they check against brought up to date after it.
             *
             * @template T
             * @param {any} device @param {() => T} call
             * @returns {T}
             */
            settledOn: (/** @type {any} */ device, /** @type {() => any} */ call)=>
                settledAfter(shadowOf(device), call),
            legacyDeviceGuests,
        },
    };
}
