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
    GetDirect3D: 6, GetDeviceCaps: 7, GetDisplayMode: 8, GetCreationParameters: 9,
    CreateTexture: 23, CreateVolumeTexture: 24, CreateCubeTexture: 25,
    CreateVertexBuffer: 26,
    CreateIndexBuffer: 27, CreateRenderTarget: 28,
    CreateDepthStencilSurface: 29, UpdateSurface: 30, UpdateTexture: 31,
    CreateOffscreenPlainSurface: 36, SetRenderTarget: 37, GetRenderTarget: 38,
    SetDepthStencilSurface: 39, GetDepthStencilSurface: 40, BeginScene: 41, EndScene: 42,
    SetTransform: 44, SetViewport: 47, GetViewport: 48, SetRenderState: 57,
    CreateStateBlock: 59, SetTexture: 65, SetTextureStageState: 67, SetSamplerState: 69,
    DrawIndexedPrimitive: 82, DrawPrimitiveUP: 83, CreateVertexDeclaration: 86,
    SetVertexDeclaration: 87, SetFVF: 89, SetVertexShader: 92, SetStreamSource: 100,
    SetIndices: 104, SetPixelShader: 107,
});

/** IDirect3D9's CheckDeviceFormat. */
export const D3D9_CHECK_DEVICE_FORMAT = 10;

/** IUnknown's AddRef and Release, and IDirect3DStateBlock9's Apply. */
export const UNKNOWN_ADDREF = 1;
export const UNKNOWN_RELEASE = 2;
export const STATEBLOCK_APPLY = 5;

/** IDirect3DTexture9's slots. */
export const TEXTURE = Object.freeze({ GetType: 10, GetLevelCount: 13, GetLevelDesc: 17,
    GetSurfaceLevel: 18, LockRect: 19, UnlockRect: 20 });

/** IDirect3DVolumeTexture9's slots where they differ in name: a box where a texture has a rect. */
export const VOLUME_TEXTURE = Object.freeze({ GetLevelCount: 13, GetLevelDesc: 17, LockBox: 19,
    UnlockBox: 20 });

/** IDirect3DIndexBuffer9's slots, which IDirect3DVertexBuffer9's are too. */
export const INDEX_BUFFER = Object.freeze({ Lock: 11, Unlock: 12 });
export const VERTEX_BUFFER = INDEX_BUFFER;

/** IDirect3DSurface9's slots. */
export const SURFACE = Object.freeze({ GetDevice: 3, GetDesc: 12, LockRect: 13, UnlockRect: 14 });

/**
 * @typedef {Object} DeviceHost
 * @property {import('../common/guest.js').Guest} guest  the guest's memory at the process's width
 * @property {{ allocate: (bytes: number) => number, free: (address: number) => any }} [heap]
 * @property {(call: { entry: number, args: number[], thread?: any }) => Promise<number>}
 *     [callGuest]
 */

/**
 * Room for a D3DLOCKED_RECT at either width (INT Pitch; void *pBits: 8 bytes, 16 with
 * a quadword pointer) and for an out pointer.
 */
export const LOCKED_RECT_BYTES = 16;
export const POINTER_BYTES = 8;

/**
 * @param {DeviceHost} host
 */
export function createDeviceCalls(host){
    const { guest } = host;
    /** A pointer's bytes in the calling process. */
    const pointer = guest.pointerSize;
    /**
     * A method of a COM object in guest memory, its answer as an unsigned HRESULT.
     *
     * @param {any} thread @param {number} object @param {number} slot @param {number[]} rest
     * @returns {Promise<number>}
     */
    const method = (thread, object, slot, rest)=>
        /** @type {NonNullable<DeviceHost['callGuest']>} */ (host.callGuest)({
            entry: guest.method(object, slot), args: [object, ...rest],
            ...(thread === undefined ? {} : { thread }),
        }).then(answer=>answer >>> 0);
    /**
     * A D3DLOCKED_RECT read: the pointer follows the pitch at the pointer's own alignment.
     *
     * @param {number} at
     */
    const lockedRect = at=>({ pitch: guest.u32(at), bits: guest.ptr(at + pointer) });
    return { lockedRect, method, pointer };
}
