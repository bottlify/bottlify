/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The method order of every interface published here.
 *
 * This file is declarations and nothing else, because the order *is* the
 * interface: a program does not call a method by name, it calls slot fourteen,
 * and if slot fourteen is the wrong method it gets called with the wrong
 * arguments and returns the wrong thing. Nothing about that reads as an error.
 * It reads as a picture that is subtly wrong, several thousand instructions
 * later, in a place with no connection to here.
 *
 * So two rules hold throughout, and both are enforced by the tests beside this:
 *
 * - **Every slot is listed, including the ones nothing implements.** A method
 *   with no implementation answers E_NOTIMPL, which is a documented reply a
 *   program handles; a method left *out* shifts every method after it up one
 *   and breaks all of them. Completeness here matters more than coverage.
 * - **`argBytes` counts `this` and every argument.** These are thiscall, and
 *   the bridge has the callee pop everything but `this` -- so a miscount does
 *   not return a wrong value, it returns to a wrong address.
 *
 * Where a method takes a structure by pointer that is still one argument: four
 * bytes, like every other. Only the count of arguments matters here, never
 * their size.
 */

/**
 * Builds a descriptor from a list of `[name, argumentCount]` pairs.
 *
 * The argument count excludes `this`, because that is how a header reads and
 * transcribing from a header is what this file is. The four bytes `this`
 * occupies are added here, once, rather than in ninety-four places.
 *
 * A method may answer with a promise instead of a number: a call into the
 * guest is asynchronous, and the bridge suspends the caller on the promise.
 *
 * @param {string} id
 * @param {[string, number][]} slots
 * @param {Record<string, (target: any, args: number[]) => number | Promise<number>>} [implemented]
 * @returns {import('./com.js').InterfaceDescriptor}
 */
export function describe(id, slots, implemented = {}){
    return {
        id,
        methods: slots.map(([name, args])=>({
            name,
            argBytes: 4 + args * 4,
            // The descriptor's own type says a number; a promise is what the
            // bridge suspends on, and it passes through the adapter untouched.
            invoke: /** @type {any} */ (implemented[name]),
        })),
    };
}

/**
 * IDirect3D8, after IUnknown's three.
 *
 * The last of these is the one that matters: CreateDevice is how a program
 * gets everything else.
 */
export const IDIRECT3D8_SLOTS = /** @type {[string, number][]} */ ([
    ['RegisterSoftwareDevice', 1],
    ['GetAdapterCount', 0],
    ['GetAdapterIdentifier', 3],
    ['GetAdapterModeCount', 1],
    ['EnumAdapterModes', 3],
    ['GetAdapterDisplayMode', 2],
    ['CheckDeviceType', 5],
    ['CheckDeviceFormat', 6],
    ['CheckDeviceMultiSampleType', 5],
    ['CheckDepthStencilMatch', 5],
    ['GetDeviceCaps', 3],
    ['GetAdapterMonitor', 1],
    ['CreateDevice', 6],
]);

/**
 * IDirect3DDevice8, after IUnknown's three.
 *
 * Ninety-four slots, and the two worth watching when checking this against a
 * header are that GetTexture precedes SetTexture -- the opposite way round from
 * every other pair here -- and that the state-block calls sit between the
 * render states and the texture stages rather than at the end.
 */
export const IDIRECT3DDEVICE8_SLOTS = /** @type {[string, number][]} */ ([
    ['TestCooperativeLevel', 0],
    ['GetAvailableTextureMem', 0],
    ['ResourceManagerDiscardBytes', 1],
    ['GetDirect3D', 1],
    ['GetDeviceCaps', 1],
    ['GetDisplayMode', 1],
    ['GetCreationParameters', 1],
    ['SetCursorProperties', 3],
    ['SetCursorPosition', 3],
    ['ShowCursor', 1],
    ['CreateAdditionalSwapChain', 2],
    ['Reset', 1],
    ['Present', 4],
    ['GetBackBuffer', 3],
    ['GetRasterStatus', 1],
    ['SetGammaRamp', 2],
    ['GetGammaRamp', 1],
    ['CreateTexture', 7],
    ['CreateVolumeTexture', 8],
    ['CreateCubeTexture', 6],
    ['CreateVertexBuffer', 5],
    ['CreateIndexBuffer', 5],
    ['CreateRenderTarget', 6],
    ['CreateDepthStencilSurface', 5],
    ['CreateImageSurface', 4],
    ['CopyRects', 5],
    ['UpdateTexture', 2],
    ['GetFrontBuffer', 1],
    ['SetRenderTarget', 2],
    ['GetRenderTarget', 1],
    ['GetDepthStencilSurface', 1],
    ['BeginScene', 0],
    ['EndScene', 0],
    ['Clear', 6],
    ['SetTransform', 2],
    ['GetTransform', 2],
    ['MultiplyTransform', 2],
    ['SetViewport', 1],
    ['GetViewport', 1],
    ['SetMaterial', 1],
    ['GetMaterial', 1],
    ['SetLight', 2],
    ['GetLight', 2],
    ['LightEnable', 2],
    ['GetLightEnable', 2],
    ['SetClipPlane', 2],
    ['GetClipPlane', 2],
    ['SetRenderState', 2],
    ['GetRenderState', 2],
    ['BeginStateBlock', 0],
    ['EndStateBlock', 1],
    ['ApplyStateBlock', 1],
    ['CaptureStateBlock', 1],
    ['DeleteStateBlock', 1],
    ['CreateStateBlock', 2],
    ['SetClipStatus', 1],
    ['GetClipStatus', 1],
    ['GetTexture', 2],
    ['SetTexture', 2],
    ['GetTextureStageState', 3],
    ['SetTextureStageState', 3],
    ['ValidateDevice', 1],
    ['GetInfo', 3],
    ['SetPaletteEntries', 2],
    ['GetPaletteEntries', 2],
    ['SetCurrentTexturePalette', 1],
    ['GetCurrentTexturePalette', 1],
    ['DrawPrimitive', 3],
    ['DrawIndexedPrimitive', 5],
    ['DrawPrimitiveUP', 4],
    ['DrawIndexedPrimitiveUP', 8],
    ['ProcessVertices', 5],
    ['CreateVertexShader', 4],
    ['SetVertexShader', 1],
    ['GetVertexShader', 1],
    ['DeleteVertexShader', 1],
    ['SetVertexShaderConstant', 3],
    ['GetVertexShaderConstant', 3],
    ['GetVertexShaderDeclaration', 3],
    ['GetVertexShaderFunction', 3],
    ['SetStreamSource', 3],
    ['GetStreamSource', 3],
    ['SetIndices', 2],
    ['GetIndices', 2],
    ['CreatePixelShader', 2],
    ['SetPixelShader', 1],
    ['GetPixelShader', 1],
    ['DeletePixelShader', 1],
    ['SetPixelShaderConstant', 3],
    ['GetPixelShaderConstant', 3],
    ['GetPixelShaderFunction', 3],
    ['DrawRectPatch', 3],
    ['DrawTriPatch', 3],
    ['DeletePatch', 1],
]);

/**
 * IDirect3DResource8's own slots, which every resource interface repeats at the
 * front of its own list. A derived interface names its base's methods again
 * because that is what the guest compiled against.
 */
const RESOURCE8_SLOTS = /** @type {[string, number][]} */ ([
    ['GetDevice', 1],
    ['SetPrivateData', 4],
    ['GetPrivateData', 3],
    ['FreePrivateData', 1],
    ['SetPriority', 1],
    ['GetPriority', 0],
    ['PreLoad', 0],
    ['GetType', 0],
]);

/** IDirect3DSurface8. Not a resource: it has its own short list. */
export const IDIRECT3DSURFACE8_SLOTS = /** @type {[string, number][]} */ ([
    ['GetDevice', 1],
    ['SetPrivateData', 4],
    ['GetPrivateData', 3],
    ['FreePrivateData', 1],
    ['GetContainer', 2],
    ['GetDesc', 1],
    ['LockRect', 3],
    ['UnlockRect', 0],
]);

/** IDirect3DTexture8: a resource, then the base-texture three, then its own. */
export const IDIRECT3DTEXTURE8_SLOTS = /** @type {[string, number][]} */ ([
    ...RESOURCE8_SLOTS,
    ['SetLOD', 1],
    ['GetLOD', 0],
    ['GetLevelCount', 0],
    ['GetLevelDesc', 2],
    ['GetSurfaceLevel', 2],
    ['LockRect', 4],
    ['UnlockRect', 1],
    ['AddDirtyRect', 1],
]);

/** IDirect3DVertexBuffer8. */
export const IDIRECT3DVERTEXBUFFER8_SLOTS = /** @type {[string, number][]} */ ([
    ...RESOURCE8_SLOTS,
    ['Lock', 4],
    ['Unlock', 0],
    ['GetDesc', 1],
]);

/** IDirect3DIndexBuffer8, which is the vertex buffer's shape exactly. */
export const IDIRECT3DINDEXBUFFER8_SLOTS = IDIRECT3DVERTEXBUFFER8_SLOTS;

/**
 * IDirect3D9, after IUnknown's three.
 *
 * Nearly IDirect3D8's list: RegisterSoftwareDevice keeps its place, and the
 * differences are that GetAdapterModeCount and EnumAdapterModes gained a format
 * argument, CheckDeviceFormatConversion is new, and CreateDevice's signature is
 * unchanged.
 */
export const IDIRECT3D9_SLOTS = /** @type {[string, number][]} */ ([
    ['RegisterSoftwareDevice', 1],
    ['GetAdapterCount', 0],
    ['GetAdapterIdentifier', 3],
    ['GetAdapterModeCount', 2],
    ['EnumAdapterModes', 4],
    ['GetAdapterDisplayMode', 2],
    ['CheckDeviceType', 5],
    ['CheckDeviceFormat', 6],
    ['CheckDeviceMultiSampleType', 6],
    ['CheckDepthStencilMatch', 5],
    ['CheckDeviceFormatConversion', 4],
    ['GetDeviceCaps', 3],
    ['GetAdapterMonitor', 1],
    ['CreateDevice', 6],
]);

/**
 * IDirectDraw7, after IUnknown's three.
 *
 * The four DirectDraw generations are prefixes of one list: each newer one
 * appends and never reorders, which is what makes the older tables slices of
 * this one. The single exception is SetDisplayMode, which the first generation
 * declares with three arguments and every later one with five -- so the first
 * generation's table is a slice with one entry replaced, not a slice.
 */
export const IDIRECTDRAW7_SLOTS = /** @type {[string, number][]} */ ([
    ['Compact', 0],
    ['CreateClipper', 3],
    ['CreatePalette', 4],
    ['CreateSurface', 3],
    ['DuplicateSurface', 2],
    ['EnumDisplayModes', 4],
    ['EnumSurfaces', 4],
    ['FlipToGDISurface', 0],
    ['GetCaps', 2],
    ['GetDisplayMode', 1],
    ['GetFourCCCodes', 2],
    ['GetGDISurface', 1],
    ['GetMonitorFrequency', 1],
    ['GetScanLine', 1],
    ['GetVerticalBlankStatus', 1],
    ['Initialize', 1],
    ['RestoreDisplayMode', 0],
    ['SetCooperativeLevel', 2],
    ['SetDisplayMode', 5],
    ['WaitForVerticalBlank', 2],
    ['GetAvailableVidMem', 3],
    ['GetSurfaceFromDC', 2],
    ['RestoreAllSurfaces', 0],
    ['TestCooperativeLevel', 0],
    ['GetDeviceIdentifier', 2],
    ['StartModeTest', 3],
    ['EvaluateMode', 2],
]);

/** IDirectDraw4: everything up to and including GetDeviceIdentifier. */
export const IDIRECTDRAW4_SLOTS = IDIRECTDRAW7_SLOTS.slice(0, 25);

/** IDirectDraw2: through GetAvailableVidMem. */
export const IDIRECTDRAW2_SLOTS = IDIRECTDRAW7_SLOTS.slice(0, 21);

/** IDirectDraw: through WaitForVerticalBlank, with the three-argument SetDisplayMode. */
export const IDIRECTDRAW_SLOTS = /** @type {[string, number][]} */ (
    IDIRECTDRAW7_SLOTS.slice(0, 20).map(function narrow(slot){
        return slot[0] === 'SetDisplayMode' ? [slot[0], 3] : slot;
    }));

/**
 * IDirectDrawSurface7, after IUnknown's three.
 *
 * As with the ddraw object, the earlier surface generations are prefixes:
 * the first ends at UpdateOverlayZOrder, the second adds the three through
 * PageUnlock, the third SetSurfaceDesc, the fourth the private-data and
 * uniqueness five, and the seventh the priority and LOD four. What the
 * prefixes do not say is that the fourth generation onward takes the larger
 * surface descriptor in Lock and GetSurfaceDesc; that is the seam's to know.
 *
 * The Blt family sits in the middle and the order within it is alphabetical by
 * accident rather than design -- Blt, BltBatch, BltFast -- which is the sort of
 * thing worth noting because it looks like a transcription slip and is not.
 */
export const IDIRECTDRAWSURFACE7_SLOTS = /** @type {[string, number][]} */ ([
    ['AddAttachedSurface', 1],
    ['AddOverlayDirtyRect', 1],
    ['Blt', 5],
    ['BltBatch', 3],
    ['BltFast', 5],
    ['DeleteAttachedSurface', 2],
    ['EnumAttachedSurfaces', 2],
    ['EnumOverlayZOrders', 3],
    ['Flip', 2],
    ['GetAttachedSurface', 2],
    ['GetBltStatus', 1],
    ['GetCaps', 1],
    ['GetClipper', 1],
    ['GetColorKey', 2],
    ['GetDC', 1],
    ['GetFlipStatus', 1],
    ['GetOverlayPosition', 2],
    ['GetPalette', 1],
    ['GetPixelFormat', 1],
    ['GetSurfaceDesc', 1],
    ['Initialize', 2],
    ['IsLost', 0],
    ['Lock', 4],
    ['ReleaseDC', 1],
    ['Restore', 0],
    ['SetClipper', 1],
    ['SetColorKey', 2],
    ['SetOverlayPosition', 2],
    ['SetPalette', 1],
    ['Unlock', 1],
    ['UpdateOverlay', 5],
    ['UpdateOverlayDisplay', 1],
    ['UpdateOverlayZOrder', 2],
    ['GetDDInterface', 1],
    ['PageLock', 1],
    ['PageUnlock', 1],
    ['SetSurfaceDesc', 2],
    ['SetPrivateData', 4],
    ['GetPrivateData', 3],
    ['FreePrivateData', 1],
    ['GetUniquenessValue', 1],
    ['ChangeUniquenessValue', 0],
    ['SetPriority', 1],
    ['GetPriority', 1],
    ['SetLOD', 1],
    ['GetLOD', 1],
]);

export const IDIRECTDRAWSURFACE4_SLOTS = IDIRECTDRAWSURFACE7_SLOTS.slice(0, 42);
export const IDIRECTDRAWSURFACE3_SLOTS = IDIRECTDRAWSURFACE7_SLOTS.slice(0, 37);
export const IDIRECTDRAWSURFACE2_SLOTS = IDIRECTDRAWSURFACE7_SLOTS.slice(0, 36);
export const IDIRECTDRAWSURFACE_SLOTS = IDIRECTDRAWSURFACE7_SLOTS.slice(0, 33);

/** IDirectDrawPalette, after IUnknown's three. One shape for every generation. */
export const IDIRECTDRAWPALETTE_SLOTS = /** @type {[string, number][]} */ ([
    ['GetCaps', 1],
    ['GetEntries', 4],
    ['Initialize', 3],
    ['SetEntries', 4],
]);

/** IDirectDrawClipper, after IUnknown's three. */
export const IDIRECTDRAWCLIPPER_SLOTS = /** @type {[string, number][]} */ ([
    ['GetClipList', 3],
    ['GetHWnd', 1],
    ['Initialize', 2],
    ['IsClipListChanged', 1],
    ['SetClipList', 2],
    ['SetHWnd', 2],
]);
