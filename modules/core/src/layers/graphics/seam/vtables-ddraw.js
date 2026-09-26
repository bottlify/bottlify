/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The method order of the interfaces a DirectDraw object leads to beyond the
 * ones `vtables.js` lists: the gamma control a surface answers for, and the
 * Direct3D of DirectX 3, 5 and 6 -- the object, its devices, viewports,
 * lights, materials, texture handles, execute buffers and vertex buffers.
 *
 * The rules are that file's: every slot is listed whether anything
 * implements it or not, in the header's order after IUnknown's three, and a
 * count is of arguments, not bytes -- `describe` adds `this`.
 *
 * Unlike DirectDraw's, these generations are not all prefixes of one list.
 * IDirect3D2 drops the first generation's Initialize, IDirect3DDevice2 drops
 * everything execute-buffer and matrix shaped, and IDirect3DDevice3 drops the
 * texture-handle swap -- so each device is written out in full.
 */

/** IDirectDrawGammaControl: one ramp per surface, read and written whole. */
export const IDIRECTDRAWGAMMACONTROL_SLOTS = /** @type {[string, number][]} */ ([
    ['GetGammaRamp', 2],
    ['SetGammaRamp', 2],
]);

/** IDirect3D3. */
export const IDIRECT3D3_SLOTS = /** @type {[string, number][]} */ ([
    ['EnumDevices', 2],
    ['CreateLight', 2],
    ['CreateMaterial', 2],
    ['CreateViewport', 2],
    ['FindDevice', 2],
    ['CreateDevice', 4],
    ['CreateVertexBuffer', 4],
    ['EnumZBufferFormats', 3],
    ['EvictManagedTextures', 0],
]);

/** IDirect3D2: the third without its last three, and CreateDevice takes no outer unknown. */
export const IDIRECT3D2_SLOTS = /** @type {[string, number][]} */ ([
    ...IDIRECT3D3_SLOTS.slice(0, 5),
    ['CreateDevice', 3],
]);

/** IDirect3D: an Initialize first, and no CreateDevice -- a device is a surface's. */
export const IDIRECT3D_SLOTS = /** @type {[string, number][]} */ ([
    ['Initialize', 1],
    ...IDIRECT3D3_SLOTS.slice(0, 5),
]);

/** IDirect3DDevice, the execute-buffer device. */
export const IDIRECT3DDEVICE_SLOTS = /** @type {[string, number][]} */ ([
    ['Initialize', 3],
    ['GetCaps', 2],
    ['SwapTextureHandles', 2],
    ['CreateExecuteBuffer', 3],
    ['GetStats', 1],
    ['Execute', 3],
    ['AddViewport', 1],
    ['DeleteViewport', 1],
    ['NextViewport', 3],
    ['Pick', 4],
    ['GetPickRecords', 2],
    ['EnumTextureFormats', 2],
    ['CreateMatrix', 1],
    ['SetMatrix', 2],
    ['GetMatrix', 2],
    ['DeleteMatrix', 1],
    ['BeginScene', 0],
    ['EndScene', 0],
    ['GetDirect3D', 1],
]);

/** The DrawPrimitive half IDirect3DDevice2 and 3 share, after GetDirect3D. */
const DRAWPRIMITIVE_SLOTS = /** @type {[string, number][]} */ ([
    ['SetCurrentViewport', 1],
    ['GetCurrentViewport', 1],
    ['SetRenderTarget', 2],
    ['GetRenderTarget', 1],
    ['Begin', 3],
    ['BeginIndexed', 5],
    ['Vertex', 1],
    ['Index', 1],
    ['End', 1],
    ['GetRenderState', 2],
    ['SetRenderState', 2],
    ['GetLightState', 2],
    ['SetLightState', 2],
    ['SetTransform', 2],
    ['GetTransform', 2],
    ['MultiplyTransform', 2],
    ['DrawPrimitive', 5],
    ['DrawIndexedPrimitive', 7],
    ['SetClipStatus', 1],
    ['GetClipStatus', 1],
]);

/** IDirect3DDevice2. */
export const IDIRECT3DDEVICE2_SLOTS = /** @type {[string, number][]} */ ([
    ['GetCaps', 2],
    ['SwapTextureHandles', 2],
    ['GetStats', 1],
    ['AddViewport', 1],
    ['DeleteViewport', 1],
    ['NextViewport', 3],
    ['EnumTextureFormats', 2],
    ['BeginScene', 0],
    ['EndScene', 0],
    ['GetDirect3D', 1],
    ...DRAWPRIMITIVE_SLOTS,
]);

/** IDirect3DDevice3: no handle swap, and the vertex-buffer and texture-stage calls after. */
export const IDIRECT3DDEVICE3_SLOTS = /** @type {[string, number][]} */ ([
    ['GetCaps', 2],
    ['GetStats', 1],
    ['AddViewport', 1],
    ['DeleteViewport', 1],
    ['NextViewport', 3],
    ['EnumTextureFormats', 2],
    ['BeginScene', 0],
    ['EndScene', 0],
    ['GetDirect3D', 1],
    ...DRAWPRIMITIVE_SLOTS,
    ['DrawPrimitiveStrided', 5],
    ['DrawIndexedPrimitiveStrided', 7],
    ['DrawPrimitiveVB', 5],
    ['DrawIndexedPrimitiveVB', 5],
    ['ComputeSphereVisibility', 5],
    ['GetTexture', 2],
    ['SetTexture', 2],
    ['GetTextureStageState', 3],
    ['SetTextureStageState', 3],
    ['ValidateDevice', 1],
]);

/** IDirect3DViewport3; the second generation is its first sixteen, the first its thirteen. */
export const IDIRECT3DVIEWPORT3_SLOTS = /** @type {[string, number][]} */ ([
    ['Initialize', 1],
    ['GetViewport', 1],
    ['SetViewport', 1],
    ['TransformVertices', 4],
    ['LightElements', 2],
    ['SetBackground', 1],
    ['GetBackground', 2],
    ['SetBackgroundDepth', 1],
    ['GetBackgroundDepth', 2],
    ['Clear', 3],
    ['AddLight', 1],
    ['DeleteLight', 1],
    ['NextLight', 3],
    ['GetViewport2', 1],
    ['SetViewport2', 1],
    ['SetBackgroundDepth2', 1],
    ['GetBackgroundDepth2', 2],
    ['Clear2', 6],
]);
export const IDIRECT3DVIEWPORT2_SLOTS = IDIRECT3DVIEWPORT3_SLOTS.slice(0, 15);
export const IDIRECT3DVIEWPORT_SLOTS = IDIRECT3DVIEWPORT3_SLOTS.slice(0, 13);

/** IDirect3DLight: one generation. */
export const IDIRECT3DLIGHT_SLOTS = /** @type {[string, number][]} */ ([
    ['Initialize', 1],
    ['SetLight', 1],
    ['GetLight', 1],
]);

/** IDirect3DMaterial, with the palette reservation the later two dropped. */
export const IDIRECT3DMATERIAL_SLOTS = /** @type {[string, number][]} */ ([
    ['Initialize', 1],
    ['SetMaterial', 1],
    ['GetMaterial', 1],
    ['GetHandle', 2],
    ['Reserve', 0],
    ['Unreserve', 0],
]);
export const IDIRECT3DMATERIAL3_SLOTS = IDIRECT3DMATERIAL_SLOTS.slice(1, 4);
export const IDIRECT3DMATERIAL2_SLOTS = IDIRECT3DMATERIAL3_SLOTS;

/** IDirect3DTexture, on a DirectDraw surface; the second generation drops Initialize and Unload. */
export const IDIRECT3DTEXTURE_SLOTS = /** @type {[string, number][]} */ ([
    ['Initialize', 2],
    ['GetHandle', 2],
    ['PaletteChanged', 2],
    ['Load', 1],
    ['Unload', 0],
]);
export const IDIRECT3DTEXTURE2_SLOTS = IDIRECT3DTEXTURE_SLOTS.slice(1, 4);

/** IDirect3DExecuteBuffer. */
export const IDIRECT3DEXECUTEBUFFER_SLOTS = /** @type {[string, number][]} */ ([
    ['Initialize', 2],
    ['Lock', 1],
    ['Unlock', 0],
    ['SetExecuteData', 1],
    ['GetExecuteData', 1],
    ['Validate', 4],
    ['Optimize', 1],
]);

/** IDirect3DVertexBuffer, DirectX 6's: the seventh's without ProcessVerticesStrided. */
export const IDIRECT3DVERTEXBUFFER_SLOTS = /** @type {[string, number][]} */ ([
    ['Lock', 3],
    ['Unlock', 0],
    ['ProcessVertices', 7],
    ['GetVertexBufferDesc', 1],
    ['Optimize', 2],
]);
