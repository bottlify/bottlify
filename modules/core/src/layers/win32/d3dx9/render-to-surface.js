/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { createComObject } from '../ole32/objects.js';
import { DEVICE, SURFACE, UNKNOWN_ADDREF, UNKNOWN_RELEASE, createDeviceCalls } from './device.js';

/**
 * ID3DXRenderToSurface: a scene drawn into a surface of the program's,
 * through the device's own methods. BeginScene keeps the device's render
 * target, depth surface and viewport, points the device at the surface -- a
 * depth surface of the described format with it, when the object was made
 * with one, and no depth surface otherwise -- sets the viewport the program
 * gives, and begins the device's scene; EndScene ends it and puts the three
 * back.
 *
 * A surface the device cannot render to (no D3DUSAGE_RENDERTARGET: a level
 * of a managed texture, say) is drawn through a lockable render target of
 * its size and format, copied into it at EndScene as D3DXLoadSurfaceFromSurface
 * copies. The mip filter EndScene is given is not applied: the levels below
 * the surface's are not remade.
 */

export const IID_ID3DXRENDERTOSURFACE = '{6985F346-2C3D-43B3-BE8B-DAAE8A03D894}';

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;
const E_OUTOFMEMORY = 0x8007000e;
const D3DUSAGE_RENDERTARGET = 0x1;
const D3DX_FILTER_NONE = 1;
/** D3DSURFACE_DESC, then three pointers, then a D3DVIEWPORT9. */
const SCRATCH_BYTES = 32 + 12 + 24;

/**
 * @typedef {Object} RenderToSurfaceHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {{ allocate: (bytes: number) => number, free: (address: number) => any }} [heap]
 * @property {(call: { entry: number, args: number[], thread?: any }) => Promise<number>}
 *     [callGuest]
 * @property {() => any} [currentThread]
 * @property {{ publish: (object: any, interfaceId: string) => number }} [vtables]
 */

/**
 * @param {RenderToSurfaceHost} host
 * @param {{ loadSurface: (args: number[]) => number | Promise<number> }} textures
 *     D3DXLoadSurfaceFromSurface, for a surface drawn through a target of D3DX's own.
 */
export function createRenderToSurface(host, textures){
    const { u32, putU32s, method } = createDeviceCalls(host);

    /**
     * BeginScene's work, once its handler has returned.
     *
     * @param {any} state @param {number} surface @param {number} viewport @param {any} thread
     * @returns {Promise<number>}
     */
    const begin = async(state, surface, viewport, thread)=>{
        await null;
        const heap = /** @type {NonNullable<RenderToSurfaceHost['heap']>} */ (host.heap);
        /** @param {number} slot @param {number[]} rest */
        const call = (slot, rest)=>method(thread, state.device, slot, rest);
        const scratch = heap.allocate(SCRATCH_BYTES);
        if (scratch === 0)
        {
            state.inScene = false;
            return E_OUTOFMEMORY;
        }
        const out = scratch + 32;
        const view = scratch + 44;
        try
        {
            const described = await method(thread, surface, SURFACE.GetDesc, [scratch]);
            if (described !== D3D_OK)
            {
                state.inScene = false;
                return described;
            }
            const [format, , usage] = [0, 4, 8].map(o=>u32(scratch + o));
            const [width, height] = [24, 28].map(o=>u32(scratch + o));
            putU32s(out, [0, 0, 0]);
            await call(DEVICE.GetRenderTarget, [0, out]);
            await call(DEVICE.GetDepthStencilSurface, [out + 4]);
            await call(DEVICE.GetViewport, [view]);
            state.saved = { target: u32(out), depth: u32(out + 4),
                viewport: host.readMemory(view, 24).slice() };
            state.surface = surface >>> 0;
            let target = state.surface;
            if (!(usage & D3DUSAGE_RENDERTARGET))
            {
                const made = await call(DEVICE.CreateRenderTarget, [width, height, format, 0, 0,
                    1, out + 8, 0]);
                if (made !== D3D_OK)
                {
                    await restore(state, thread);
                    return made;
                }
                state.ownTarget = u32(out + 8);
                target = state.ownTarget;
            }
            if (state.desc.depthStencil)
            {
                putU32s(out + 8, [0]);
                const made = await call(DEVICE.CreateDepthStencilSurface, [width, height,
                    state.desc.depthFormat, 0, 0, 1, out + 8, 0]);
                if (made !== D3D_OK)
                {
                    await restore(state, thread);
                    return made;
                }
                state.ownDepth = u32(out + 8);
            }
            await call(DEVICE.SetRenderTarget, [0, target]);
            await call(DEVICE.SetDepthStencilSurface, [state.ownDepth]);
            if ((viewport >>> 0) !== 0)
            {
                await call(DEVICE.SetViewport, [viewport >>> 0]);
            }
            const begun = await call(DEVICE.BeginScene, []);
            if (begun !== D3D_OK)
            {
                await restore(state, thread);
            }
            return begun;
        }
        finally
        {
            heap.free(scratch);
        }
    };

    /**
     * The device as BeginScene found it, and what was made for the scene let go.
     *
     * @param {any} state @param {any} thread
     */
    const restore = async(state, thread)=>{
        const heap = /** @type {NonNullable<RenderToSurfaceHost['heap']>} */ (host.heap);
        /** @param {number} slot @param {number[]} rest */
        const call = (slot, rest)=>method(thread, state.device, slot, rest);
        const saved = state.saved;
        state.inScene = false;
        if (saved)
        {
            await call(DEVICE.SetRenderTarget, [0, saved.target]);
            await call(DEVICE.SetDepthStencilSurface, [saved.depth]);
            const view = heap.allocate(24);
            if (view !== 0)
            {
                host.writeMemory(view, saved.viewport);
                await call(DEVICE.SetViewport, [view]);
                heap.free(view);
            }
            for (const held of [saved.target, saved.depth])
            {
                if (held !== 0)
                {
                    await method(thread, held, UNKNOWN_RELEASE, []);
                }
            }
            state.saved = null;
        }
        for (const key of ['ownTarget', 'ownDepth'])
        {
            if (state[key] !== 0)
            {
                await method(thread, state[key], UNKNOWN_RELEASE, []);
                state[key] = 0;
            }
        }
    };

    /**
     * EndScene's work: the scene ended, a target of D3DX's own copied into
     * the program's surface, and the device put back.
     *
     * @param {any} state @param {any} thread
     * @returns {Promise<number>}
     */
    const end = async(state, thread)=>{
        await null;
        let answer = await method(thread, state.device, DEVICE.EndScene, []);
        if (state.ownTarget !== 0)
        {
            const copied = await textures.loadSurface([state.surface, 0, 0, state.ownTarget, 0, 0,
                D3DX_FILTER_NONE, 0]);
            answer = answer === D3D_OK ? copied >>> 0 : answer;
        }
        await restore(state, thread);
        return answer;
    };

    /** @type {import('../ole32/objects.js').ComInterfaceDescriptor} */
    const renderToSurface = {
        id: IID_ID3DXRENDERTOSURFACE,
        methods: [
            /** HRESULT GetDevice(LPDIRECT3DDEVICE9 *ppDevice) */
            { name: 'GetDevice', argBytes: 8, invoke: (object, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return D3DERR_INVALIDCALL;
                }
                putU32s(out, [object.state.device]);
                const thread = host.currentThread?.();
                return Promise.resolve().then(()=>method(thread, object.state.device,
                    UNKNOWN_ADDREF, [])).then(()=>D3D_OK);
            } },
            /** HRESULT GetDesc(D3DXRTS_DESC *pDesc) */
            { name: 'GetDesc', argBytes: 8, invoke: (object, [at])=>{
                if ((at >>> 0) === 0)
                {
                    return D3DERR_INVALIDCALL;
                }
                const d = object.state.desc;
                putU32s(at, [d.width, d.height, d.format, d.depthStencil, d.depthFormat]);
                return D3D_OK;
            } },
            /** HRESULT BeginScene(LPDIRECT3DSURFACE9 pSurface, CONST D3DVIEWPORT9 *pViewport) */
            { name: 'BeginScene', argBytes: 12, invoke: (object, [surface, viewport])=>{
                const state = object.state;
                if (state.inScene || (surface >>> 0) === 0)
                {
                    return D3DERR_INVALIDCALL;
                }
                state.inScene = true;
                return begin(state, surface, viewport, host.currentThread?.());
            } },
            /** HRESULT EndScene(DWORD MipFilter) */
            { name: 'EndScene', argBytes: 8, invoke: object=>{
                if (!object.state.inScene)
                {
                    return D3DERR_INVALIDCALL;
                }
                return end(object.state, host.currentThread?.());
            } },
            /** HRESULT OnLostDevice() -- nothing outlives a scene, so nothing to let go. */
            { name: 'OnLostDevice', argBytes: 4, invoke: ()=>D3D_OK },
            /** HRESULT OnResetDevice() */
            { name: 'OnResetDevice', argBytes: 4, invoke: ()=>D3D_OK },
        ],
    };

    /** Objects by the interface pointer a program holds. @type {Map<number, any>} */
    const byPointer = new Map();

    /**
     * HRESULT D3DXCreateRenderToSurface(LPDIRECT3DDEVICE9 pDevice, UINT Width, UINT Height,
     *     D3DFORMAT Format, BOOL DepthStencil, D3DFORMAT DepthStencilFormat,
     *     LPD3DXRENDERTOSURFACE *ppRenderToSurface)
     *
     * @param {number[]} args
     * @returns {number}
     */
    const create = ([device, width, height, format, depthStencil, depthFormat, out])=>{
        if ((out >>> 0) !== 0)
        {
            putU32s(out, [0]);
        }
        if ((device >>> 0) === 0 || (out >>> 0) === 0 || !host.vtables)
        {
            return D3DERR_INVALIDCALL;
        }
        let pointer = 0;
        const object = createComObject(IID_ID3DXRENDERTOSURFACE, { interfaces: [renderToSurface],
            state: { device: device >>> 0, desc: { width: width >>> 0, height: height >>> 0,
                format: format >>> 0, depthStencil: depthStencil ? 1 : 0,
                depthFormat: depthFormat >>> 0 },
            inScene: false, saved: null, surface: 0, ownTarget: 0, ownDepth: 0 },
            destroy: ()=>byPointer.delete(pointer) });
        pointer = host.vtables.publish(object, IID_ID3DXRENDERTOSURFACE) >>> 0;
        if (pointer === 0)
        {
            object.release();
            return E_OUTOFMEMORY;
        }
        byPointer.set(pointer, object);
        putU32s(out, [pointer]);
        return D3D_OK;
    };

    return { create, renderToSurface,
        /** @param {number} pointer */
        objectAt: pointer=>byPointer.get(pointer >>> 0) ?? null };
}
