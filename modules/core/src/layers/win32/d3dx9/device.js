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
    CreateDepthStencilSurface: 29, UpdateTexture: 31, SetRenderTarget: 37, GetRenderTarget: 38,
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
export const SURFACE = Object.freeze({ GetDesc: 12, LockRect: 13, UnlockRect: 14 });

/**
 * @typedef {Object} DeviceHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number) => number} [readU32]  A word read in place.
 * @property {(address: number, value: number) => void} [writeU32]  A word written in place.
 * @property {{ allocate: (bytes: number) => number, free: (address: number) => any }} [heap]
 * @property {(call: { entry: number, args: number[], thread?: any }) => Promise<number>}
 *     [callGuest]
 */

/**
 * @param {DeviceHost} host
 */
export function createDeviceCalls(host){
    /**
     * Read from the bytes the host hands back, not a copy of them: an effect's
     * setters read a word at a time, and a buffer made for each word was most of
     * their cost.
     *
     * @param {number} at
     */
    const u32 = host.readU32 ? (/** @type {number} */ at)=>/** @type {NonNullable<DeviceHost['readU32']>} */ (
        host.readU32)(at >>> 0) >>> 0 : (/** @type {number} */ at)=>{
        const bytes = host.readMemory(at >>> 0, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };
    /** @param {number} at @param {number[]} values */
    const putU32s = (at, values)=>{
        if (values.length === 1 && host.writeU32)
        {
            host.writeU32(at >>> 0, values[0] >>> 0);
            return;
        }
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
    /**
     * A NUL-ended string, narrow or wide, of at most `max` characters, read a
     * page at a time: a name near the end of its region -- one on the stack's
     * last page -- ends before the region does, and a fixed-size read past it
     * faulted the caller.
     *
     * @param {number} at @param {boolean} [wide] @param {number} [max]
     */
    const string = (at, wide = false, max = 4096)=>{
        const width = wide ? 2 : 1;
        /** @type {number[]} */
        const units = [];
        let address = at >>> 0;
        while (units.length < max)
        {
            const room = Math.min((max - units.length) * width, 0x1000 - (address & 0xfff));
            let bytes;
            try
            {
                bytes = host.readMemory(address, room);
            }
            catch (e){
                if (units.length === 0 && address === (at >>> 0))
                {
                    throw e;
                }
                break;
            }
            for (let i = 0; i + width <= bytes.length; i += width)
            {
                const unit = wide ? bytes[i] | (bytes[i + 1] << 8) : bytes[i];
                if (unit === 0)
                {
                    return String.fromCharCode(...units);
                }
                units.push(unit);
            }
            address += room;
        }
        return String.fromCharCode(...units);
    };
    return { u32, putU32s, method, string };
}
