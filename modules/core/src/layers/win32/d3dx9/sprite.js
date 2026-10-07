/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { createComObject } from '../ole32/objects.js';
import { DEVICE, STATEBLOCK_APPLY, TEXTURE, UNKNOWN_RELEASE, createDeviceCalls } from './device.js';

/**
 * ID3DXSprite: textured rectangles queued between Begin and End and drawn on
 * the program's device, with the states D3DX documents for it -- its state
 * saved in a state block and put back at End unless the program says not to,
 * alpha blending when asked, the texture modulated by the sprite's colour.
 *
 * A sprite is placed in screen space: the rectangle of the texture it shows,
 * moved so its centre is at the position, through the 2D part of the sprite
 * transform. The object-space and billboard modes are told as divergences and
 * drawn in screen space.
 */

export const IID_ID3DXSPRITE = '{BA0B762D-7D28-43EC-B9DC-2F84443B0614}';

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;
const E_OUTOFMEMORY = 0x8007000e;

/** D3DXSPRITE flags. */
export const SPRITE = Object.freeze({
    DONOTSAVESTATE: 0x1, DONOTMODIFY_RENDERSTATE: 0x2, OBJECTSPACE: 0x4, BILLBOARD: 0x8,
    ALPHABLEND: 0x10,
});

/** XYZRHW | DIFFUSE | TEX1: x, y, z, rhw, colour, u, v. */
const FVF = 0x144;
const STRIDE = 28;
const D3DPT_TRIANGLELIST = 4;

/** The render, stage and sampler states a sprite draws under, as [state, value]. */
const RENDER_STATES = [[7, 0], [14, 0], [15, 1], [24, 0], [25, 5], [22, 1], [137, 0],
    [28, 0], [29, 0], [52, 0], [8, 3], [168, 0xf], [19, 5], [20, 6]];
const STAGE_STATES = [[0, 1, 4], [0, 2, 2], [0, 3, 0], [0, 4, 4], [0, 5, 2], [0, 6, 0],
    [0, 11, 0], [0, 24, 0], [1, 1, 1], [1, 4, 1]];
const SAMPLER_STATES = [[5, 2], [6, 2], [7, 2], [1, 3], [2, 3]];

/**
 * @typedef {Object} SpriteHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {{ allocate: (bytes: number) => number, free: (address: number) => any }} [heap]
 * @property {(call: { entry: number, args: number[], thread?: any }) => Promise<number>}
 *     [callGuest]
 * @property {() => any} [currentThread]
 * @property {{ publish: (object: any, interfaceId: string) => number }} [vtables]
 */

/**
 * @typedef {Object} Queued
 * @property {number} texture
 * @property {number[] | null} source   left, top, right, bottom; null for the whole texture.
 * @property {number[]} center
 * @property {number[]} position
 * @property {number} color
 * @property {number[]} transform  The sprite transform when it was drawn.
 */

/**
 * @param {SpriteHost} host
 */
export function createSprites(host){
    const { u32, putU32s, method } = createDeviceCalls(host);
    /** @param {number} at @param {number} count */
    const floats = (at, count)=>Array.from(new Float32Array(host.readMemory(at >>> 0, count * 4)
        .slice().buffer));
    const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

    /**
     * Everything queued drawn, one DrawPrimitiveUP for each run of one texture.
     *
     * @param {any} state @param {any} thread
     * @returns {Promise<number>}
     */
    const flush = async(state, thread)=>{
        const queue = /** @type {Queued[]} */ (state.queue);
        state.queue = [];
        if (queue.length === 0)
        {
            return D3D_OK;
        }
        const device = state.device;
        const heap = /** @type {NonNullable<SpriteHost['heap']>} */ (host.heap);
        /** @param {number} object @param {number} slot @param {number[]} rest */
        const call = (object, slot, rest)=>method(thread, object, slot, rest);
        if (!(state.flags & SPRITE.DONOTMODIFY_RENDERSTATE))
        {
            await call(device, DEVICE.SetVertexShader, [0]);
            await call(device, DEVICE.SetPixelShader, [0]);
            for (const [name, value] of RENDER_STATES)
            {
                await call(device, DEVICE.SetRenderState, [name, value]);
            }
            await call(device, DEVICE.SetRenderState,
                [27, state.flags & SPRITE.ALPHABLEND ? 1 : 0]);
            for (const [stage, name, value] of STAGE_STATES)
            {
                await call(device, DEVICE.SetTextureStageState, [stage, name, value]);
            }
            for (const [name, value] of SAMPLER_STATES)
            {
                await call(device, DEVICE.SetSamplerState, [0, name, value]);
            }
        }
        await call(device, DEVICE.SetFVF, [FVF]);
        const desc = heap.allocate(32);
        if (desc === 0)
        {
            return E_OUTOFMEMORY;
        }
        /** @type {Map<number, number[]>} */
        const sizes = new Map();
        try
        {
            for (let first = 0; first < queue.length;)
            {
                const texture = queue[first].texture;
                let end = first;
                while (end < queue.length && queue[end].texture === texture)
                {
                    end++;
                }
                if (!sizes.has(texture))
                {
                    await call(texture, TEXTURE.GetLevelDesc, [0, desc]);
                    sizes.set(texture, [u32(desc + 24), u32(desc + 28)]);
                }
                const [width, height] = /** @type {number[]} */ (sizes.get(texture));
                const vertices = new DataView(new ArrayBuffer((end - first) * 6 * STRIDE));
                for (let k = first; k < end; k++)
                {
                    writeQuad(vertices, (k - first) * 6 * STRIDE, queue[k], width, height);
                }
                const data = heap.allocate(vertices.byteLength);
                if (data === 0)
                {
                    return E_OUTOFMEMORY;
                }
                host.writeMemory(data, new Uint8Array(vertices.buffer));
                await call(device, DEVICE.SetTexture, [0, texture]);
                await call(device, DEVICE.DrawPrimitiveUP, [D3DPT_TRIANGLELIST, (end - first) * 2,
                    data, STRIDE]);
                heap.free(data);
                first = end;
            }
        }
        finally
        {
            heap.free(desc);
        }
        return D3D_OK;
    };

    /**
     * Begin's work once its handler has returned: the device's state kept in a
     * state block, unless the flags say not to.
     *
     * @param {any} state @param {number} flags @param {any} thread
     * @returns {Promise<number>}
     */
    const start = async(state, flags, thread)=>{
        state.begun = true;
        state.flags = flags >>> 0;
        if (state.flags & (SPRITE.OBJECTSPACE | SPRITE.BILLBOARD))
        {
            host.divergence?.('ID3DXSprite::Begin',
                'object space and billboards are drawn in screen space');
        }
        if (state.flags & SPRITE.DONOTSAVESTATE)
        {
            return D3D_OK;
        }
        await null;
        const heap = /** @type {NonNullable<SpriteHost['heap']>} */ (host.heap);
        const out = heap.allocate(4);
        putU32s(out, [0]);
        // D3DSBT_ALL.
        const answer = await method(thread, state.device, DEVICE.CreateStateBlock, [1, out]);
        state.saved = answer === D3D_OK ? u32(out) : 0;
        heap.free(out);
        return D3D_OK;
    };

    /**
     * End's work: what is queued drawn, and the device's state put back.
     *
     * @param {any} state @param {any} thread
     * @returns {Promise<number>}
     */
    const finish = async(state, thread)=>{
        await null;
        state.begun = false;
        const answer = await flush(state, thread);
        if (state.saved)
        {
            await method(thread, state.saved, STATEBLOCK_APPLY, []);
            await method(thread, state.saved, UNKNOWN_RELEASE, []);
            state.saved = 0;
        }
        return answer;
    };

    /** Sprites by the interface pointer a program holds. @type {Map<number, any>} */
    const byPointer = new Map();

    /** @type {import('../ole32/objects.js').ComInterfaceDescriptor} */
    const sprite = {
        id: IID_ID3DXSPRITE,
        methods: [
            /** HRESULT GetDevice(LPDIRECT3DDEVICE9 *ppDevice) */
            { name: 'GetDevice', argBytes: 8, invoke: (object, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return D3DERR_INVALIDCALL;
                }
                putU32s(out, [object.state.device]);
                // A reference the caller releases.
                const thread = host.currentThread?.();
                return Promise.resolve().then(()=>method(thread, object.state.device, 1, []))
                    .then(()=>D3D_OK);
            } },
            /** HRESULT GetTransform(D3DXMATRIX *pTransform) */
            { name: 'GetTransform', argBytes: 8, invoke: (object, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return D3DERR_INVALIDCALL;
                }
                host.writeMemory(out >>> 0,
                    new Uint8Array(Float32Array.from(object.state.transform).buffer));
                return D3D_OK;
            } },
            /** HRESULT SetTransform(CONST D3DXMATRIX *pTransform) */
            { name: 'SetTransform', argBytes: 8, invoke: (object, [at])=>{
                if ((at >>> 0) === 0)
                {
                    return D3DERR_INVALIDCALL;
                }
                object.state.transform = floats(at, 16);
                return D3D_OK;
            } },
            /** HRESULT SetWorldViewRH(CONST D3DXMATRIX *pWorld, CONST D3DXMATRIX *pView) */
            { name: 'SetWorldViewRH', argBytes: 12, invoke: ()=>D3D_OK },
            /** HRESULT SetWorldViewLH(CONST D3DXMATRIX *pWorld, CONST D3DXMATRIX *pView) */
            { name: 'SetWorldViewLH', argBytes: 12, invoke: ()=>D3D_OK },
            /** HRESULT Begin(DWORD Flags) */
            { name: 'Begin', argBytes: 8, invoke: (object, [flags])=>{
                if (object.state.begun)
                {
                    return D3DERR_INVALIDCALL;
                }
                return start(object.state, flags, host.currentThread?.());
            } },
            /**
             * HRESULT Draw(LPDIRECT3DTEXTURE9 pTexture, CONST RECT *pSrcRect,
             *     CONST D3DXVECTOR3 *pCenter, CONST D3DXVECTOR3 *pPosition, D3DCOLOR Color)
             */
            { name: 'Draw', argBytes: 24, invoke: (object, args)=>{
                const [texture, source, center, position, color] = args;
                const state = object.state;
                if (!state.begun || (texture >>> 0) === 0)
                {
                    return D3DERR_INVALIDCALL;
                }
                const rect = (source >>> 0) === 0 ? null
                    : [0, 1, 2, 3].map(i=>u32(source + i * 4) | 0);
                state.queue.push({ texture: texture >>> 0, source: rect,
                    center: (center >>> 0) === 0 ? [0, 0, 0] : floats(center, 3),
                    position: (position >>> 0) === 0 ? [0, 0, 0] : floats(position, 3),
                    color: color >>> 0, transform: state.transform });
                return D3D_OK;
            } },
            /** HRESULT Flush() */
            { name: 'Flush', argBytes: 4, invoke: object=>{
                if (!object.state.begun)
                {
                    return D3DERR_INVALIDCALL;
                }
                const thread = host.currentThread?.();
                return Promise.resolve().then(()=>flush(object.state, thread));
            } },
            /** HRESULT End() */
            { name: 'End', argBytes: 4, invoke: object=>{
                if (!object.state.begun)
                {
                    return D3DERR_INVALIDCALL;
                }
                return finish(object.state, host.currentThread?.());
            } },
            /** HRESULT OnLostDevice() */
            { name: 'OnLostDevice', argBytes: 4, invoke: ()=>D3D_OK },
            /** HRESULT OnResetDevice() */
            { name: 'OnResetDevice', argBytes: 4, invoke: ()=>D3D_OK },
        ],
    };

    /**
     * A sprite object on `device`, its interface pointer for the program.
     *
     * @param {number} device
     * @returns {{ pointer: number, object: any }}
     */
    const create = device=>{
        const vtables = /** @type {NonNullable<SpriteHost['vtables']>} */ (host.vtables);
        const object = createComObject(IID_ID3DXSPRITE, { interfaces: [sprite],
            state: { device: device >>> 0, transform: IDENTITY.slice(), queue: [], begun: false,
                flags: 0, saved: 0 } });
        const pointer = vtables.publish(object, IID_ID3DXSPRITE) >>> 0;
        byPointer.set(pointer, object);
        return { pointer, object };
    };

    /**
     * A sprite of its own for whoever draws without one: begun, filled, ended.
     *
     * @param {number} device
     */
    const detached = device=>({ device: device >>> 0, transform: IDENTITY.slice(), queue: [],
        begun: false, flags: 0, saved: 0 });

    return { create, start, finish, detached, sprite,
        /** @param {number} pointer */
        stateAt: pointer=>byPointer.get(pointer >>> 0)?.state ?? null };
}

/**
 * Two triangles for one sprite, its texels on the pixels they cover: the
 * corners pulled back half a pixel, as a pre-transformed vertex is placed.
 *
 * @param {DataView} view @param {number} at @param {Queued} one
 * @param {number} width @param {number} height  The texture's.
 */
function writeQuad(view, at, one, width, height){
    const [left, top, right, bottom] = one.source ?? [0, 0, width, height];
    const m = one.transform;
    const [cx, cy] = one.center;
    const [px, py, pz] = one.position;
    /** @param {number} x @param {number} y */
    const place = (x, y)=>{
        const sx = x - cx + px;
        const sy = y - cy + py;
        return [sx * m[0] + sy * m[4] + m[12] - 0.5, sx * m[1] + sy * m[5] + m[13] - 0.5];
    };
    const w = right - left;
    const h = bottom - top;
    const corners = [[0, 0], [w, 0], [0, h], [w, 0], [w, h], [0, h]];
    corners.forEach(([x, y], k)=>{
        const [sx, sy] = place(x, y);
        const o = at + k * STRIDE;
        view.setFloat32(o, sx, true);
        view.setFloat32(o + 4, sy, true);
        view.setFloat32(o + 8, pz, true);
        view.setFloat32(o + 12, 1, true);
        view.setUint32(o + 16, one.color, true);
        view.setFloat32(o + 20, (left + x) / width, true);
        view.setFloat32(o + 24, (top + y) / height, true);
    });
}
