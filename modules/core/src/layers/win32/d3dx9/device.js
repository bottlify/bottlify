/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * D3DX's way to a program's device: the device's own methods, called through
 * the vtable its pointer leads to, as D3DX itself calls them. What a method
 * does is the graphics layer's; this layer sits below it and reaches it only
 * the way the program does.
 *
 * A call goes into the guest, so it is made from a handler that has already
 * returned its promise -- the bridge builds the frame below the host call in
 * flight, and a handler's call is in flight only once it has returned -- and
 * names the thread whose call it answers.
 */

/** IDirect3DDevice9's slots, after IUnknown's three, in d3d9.h's order. */
export const DEVICE = Object.freeze({
    GetDeviceCaps: 7, CreateTexture: 23, CreateCubeTexture: 25, CreateVertexBuffer: 26,
    CreateIndexBuffer: 27, CreateRenderTarget: 28,
    CreateDepthStencilSurface: 29, UpdateTexture: 31, SetRenderTarget: 37, GetRenderTarget: 38,
    SetDepthStencilSurface: 39, GetDepthStencilSurface: 40, BeginScene: 41, EndScene: 42,
    SetTransform: 44, SetViewport: 47, GetViewport: 48, SetRenderState: 57,
    CreateStateBlock: 59, SetTexture: 65, SetTextureStageState: 67, SetSamplerState: 69,
    DrawPrimitiveUP: 83, SetFVF: 89, SetVertexShader: 92, SetPixelShader: 107,
});

/** IUnknown's AddRef and Release, and IDirect3DStateBlock9's Apply. */
export const UNKNOWN_ADDREF = 1;
export const UNKNOWN_RELEASE = 2;
export const STATEBLOCK_APPLY = 5;

/** IDirect3DTexture9's slots. */
export const TEXTURE = Object.freeze({ GetType: 10, GetLevelCount: 13, GetLevelDesc: 17,
    GetSurfaceLevel: 18, LockRect: 19, UnlockRect: 20 });

/** IDirect3DIndexBuffer9's slots. */
export const INDEX_BUFFER = Object.freeze({ Lock: 11, Unlock: 12 });

/** IDirect3DSurface9's slots. */
export const SURFACE = Object.freeze({ GetDesc: 12, LockRect: 13, UnlockRect: 14 });

/**
 * @typedef {Object} DeviceHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {{ allocate: (bytes: number) => number, free: (address: number) => any }} [heap]
 * @property {(call: { entry: number, args: number[], thread?: any }) => Promise<number>}
 *     [callGuest]
 */

/**
 * @param {DeviceHost} host
 */
export function createDeviceCalls(host){
    /** @param {number} at */
    const u32 = at=>new DataView(host.readMemory(at >>> 0, 4).slice().buffer).getUint32(0, true);
    /** @param {number} at @param {number[]} values */
    const putU32s = (at, values)=>{
        const bytes = new Uint8Array(values.length * 4);
        const view = new DataView(bytes.buffer);
        values.forEach((v, i)=>view.setUint32(i * 4, v >>> 0, true));
        host.writeMemory(at >>> 0, bytes);
    };
    /**
     * A method of a COM object in guest memory, its answer as an unsigned HRESULT.
     *
     * @param {any} thread @param {number} object @param {number} slot @param {number[]} rest
     * @returns {Promise<number>}
     */
    const method = (thread, object, slot, rest)=>
        /** @type {NonNullable<DeviceHost['callGuest']>} */ (host.callGuest)({
            entry: u32(u32(object) + slot * 4), args: [object >>> 0, ...rest],
            ...(thread === undefined ? {} : { thread }),
        }).then(answer=>answer >>> 0);
    return { u32, putU32s, method };
}
