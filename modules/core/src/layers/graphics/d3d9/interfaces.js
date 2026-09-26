/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The method order and identifier of every Direct3D 9 interface published to a
 * guest.
 *
 * Declarations only, for the reason the shared vtable file gives: the order
 * *is* the interface. A program calls slot fourteen, and a list with one
 * method missing puts every later method one slot early, where it is called
 * with the wrong arguments and answers something plausible.
 *
 * So every slot is listed, implemented or not, and each pair is
 * `[name, argumentCount]` with `this` excluded -- exactly as the header reads.
 *
 * The identifiers are facts about somebody else's ABI. IDirect3D9 and
 * IDirect3DDevice9 are the two a program is certain to query for and are
 * declared with the shared identifiers; the resource interfaces are reached
 * through the out-parameter of the call that made them far more often than by
 * GUID, so a wrong one here costs a query that should have succeeded rather
 * than a device that never appears.
 */

export { IID_IDirect3D9, IID_IDirect3DDevice9 } from '../seam/iids.js';

export const IID_IDirect3DResource9 = '{05EEC05D-8F7D-4362-B999-D1BAF357C704}';
export const IID_IDirect3DBaseTexture9 = '{580CA87E-1D3C-4D54-991D-B7D3E3C298CE}';
export const IID_IDirect3DTexture9 = '{85C31227-3DE5-4F00-9B3A-F11AC38C18B5}';
export const IID_IDirect3DCubeTexture9 = '{FFF32F81-D953-473A-9223-93D652ABA93F}';
export const IID_IDirect3DVolumeTexture9 = '{2518526C-E789-4111-A7B9-47EF328D13E6}';
export const IID_IDirect3DVolume9 = '{24F416E6-1F67-4AA7-B88E-D33F6F3128A1}';
export const IID_IDirect3DVertexBuffer9 = '{B64BB1B5-FD70-4DF6-BF91-19D0A12455E3}';
export const IID_IDirect3DIndexBuffer9 = '{7C9DD65E-D3F7-4529-ACEE-785830ACDE35}';
export const IID_IDirect3DSurface9 = '{0CFBAF3A-9FF6-429A-99B3-A2796AF8B89B}';
export const IID_IDirect3DSwapChain9 = '{794950F2-ADFC-458A-905E-10A10B0B503B}';
export const IID_IDirect3DVertexDeclaration9 = '{DD13C59C-36FA-4098-A8FB-C7ED39DC8546}';
export const IID_IDirect3DVertexShader9 = '{EFC5557E-6265-4613-8A94-43857889EB36}';
export const IID_IDirect3DPixelShader9 = '{6D3BDBDC-5B02-4415-B852-CE5E8BCCB289}';
export const IID_IDirect3DStateBlock9 = '{B07C4FE5-310D-4BA8-A23C-4F0F206F218B}';
export const IID_IDirect3DQuery9 = '{D9771460-A695-4F26-BBD3-27B840B541CC}';

/**
 * IDirect3DDevice9, after IUnknown's three: one hundred and sixteen slots.
 *
 * The places a transcription goes wrong, checked against the header: the swap
 * chain pair sits between the cursor and Reset; the five surface-to-surface
 * calls (UpdateSurface through ColorFill) come straight after the creates and
 * before the offscreen plain surface; CreateStateBlock precedes Begin and End;
 * GetTexture precedes SetTexture, and the sampler pair likewise Get first; the
 * declaration and FVF calls sit between ProcessVertices and the vertex shader;
 * the stream-frequency pair sits between the stream source and the indices.
 */
export const IDIRECT3DDEVICE9_SLOTS = /** @type {[string, number][]} */ ([
    ['TestCooperativeLevel', 0],
    ['GetAvailableTextureMem', 0],
    ['EvictManagedResources', 0],
    ['GetDirect3D', 1],
    ['GetDeviceCaps', 1],
    ['GetDisplayMode', 2],
    ['GetCreationParameters', 1],
    ['SetCursorProperties', 3],
    ['SetCursorPosition', 3],
    ['ShowCursor', 1],
    ['CreateAdditionalSwapChain', 2],
    ['GetSwapChain', 2],
    ['GetNumberOfSwapChains', 0],
    ['Reset', 1],
    ['Present', 4],
    ['GetBackBuffer', 4],
    ['GetRasterStatus', 2],
    ['SetDialogBoxMode', 1],
    ['SetGammaRamp', 3],
    ['GetGammaRamp', 2],
    ['CreateTexture', 8],
    ['CreateVolumeTexture', 9],
    ['CreateCubeTexture', 7],
    ['CreateVertexBuffer', 6],
    ['CreateIndexBuffer', 6],
    ['CreateRenderTarget', 8],
    ['CreateDepthStencilSurface', 8],
    ['UpdateSurface', 4],
    ['UpdateTexture', 2],
    ['GetRenderTargetData', 2],
    ['GetFrontBufferData', 2],
    ['StretchRect', 5],
    ['ColorFill', 3],
    ['CreateOffscreenPlainSurface', 6],
    ['SetRenderTarget', 2],
    ['GetRenderTarget', 2],
    ['SetDepthStencilSurface', 1],
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
    ['CreateStateBlock', 2],
    ['BeginStateBlock', 0],
    ['EndStateBlock', 1],
    ['SetClipStatus', 1],
    ['GetClipStatus', 1],
    ['GetTexture', 2],
    ['SetTexture', 2],
    ['GetTextureStageState', 3],
    ['SetTextureStageState', 3],
    ['GetSamplerState', 3],
    ['SetSamplerState', 3],
    ['ValidateDevice', 1],
    ['SetPaletteEntries', 2],
    ['GetPaletteEntries', 2],
    ['SetCurrentTexturePalette', 1],
    ['GetCurrentTexturePalette', 1],
    ['SetScissorRect', 1],
    ['GetScissorRect', 1],
    ['SetSoftwareVertexProcessing', 1],
    ['GetSoftwareVertexProcessing', 0],
    ['SetNPatchMode', 1],
    ['GetNPatchMode', 0],
    ['DrawPrimitive', 3],
    ['DrawIndexedPrimitive', 6],
    ['DrawPrimitiveUP', 4],
    ['DrawIndexedPrimitiveUP', 8],
    ['ProcessVertices', 6],
    ['CreateVertexDeclaration', 2],
    ['SetVertexDeclaration', 1],
    ['GetVertexDeclaration', 1],
    ['SetFVF', 1],
    ['GetFVF', 1],
    ['CreateVertexShader', 2],
    ['SetVertexShader', 1],
    ['GetVertexShader', 1],
    ['SetVertexShaderConstantF', 3],
    ['GetVertexShaderConstantF', 3],
    ['SetVertexShaderConstantI', 3],
    ['GetVertexShaderConstantI', 3],
    ['SetVertexShaderConstantB', 3],
    ['GetVertexShaderConstantB', 3],
    ['SetStreamSource', 4],
    ['GetStreamSource', 4],
    ['SetStreamSourceFreq', 2],
    ['GetStreamSourceFreq', 2],
    ['SetIndices', 1],
    ['GetIndices', 1],
    ['CreatePixelShader', 2],
    ['SetPixelShader', 1],
    ['GetPixelShader', 1],
    ['SetPixelShaderConstantF', 3],
    ['GetPixelShaderConstantF', 3],
    ['SetPixelShaderConstantI', 3],
    ['GetPixelShaderConstantI', 3],
    ['SetPixelShaderConstantB', 3],
    ['GetPixelShaderConstantB', 3],
    ['DrawRectPatch', 3],
    ['DrawTriPatch', 3],
    ['DeletePatch', 1],
    ['CreateQuery', 2],
]);

/**
 * IDirect3DResource9's own slots, repeated at the front of every resource
 * interface because that is what the guest compiled against.
 */
export const IDIRECT3DRESOURCE9_SLOTS = /** @type {[string, number][]} */ ([
    ['GetDevice', 1],
    ['SetPrivateData', 4],
    ['GetPrivateData', 3],
    ['FreePrivateData', 1],
    ['SetPriority', 1],
    ['GetPriority', 0],
    ['PreLoad', 0],
    ['GetType', 0],
]);

/** IDirect3DBaseTexture9: a resource, then the six every texture kind shares. */
export const IDIRECT3DBASETEXTURE9_SLOTS = /** @type {[string, number][]} */ ([
    ...IDIRECT3DRESOURCE9_SLOTS,
    ['SetLOD', 1],
    ['GetLOD', 0],
    ['GetLevelCount', 0],
    ['SetAutoGenFilterType', 1],
    ['GetAutoGenFilterType', 0],
    ['GenerateMipSubLevels', 0],
]);

/** IDirect3DSurface9: a resource in this version, unlike 8's, then a device context pair. */
export const IDIRECT3DSURFACE9_SLOTS = /** @type {[string, number][]} */ ([
    ...IDIRECT3DRESOURCE9_SLOTS,
    ['GetContainer', 2],
    ['GetDesc', 1],
    ['LockRect', 3],
    ['UnlockRect', 0],
    ['GetDC', 1],
    ['ReleaseDC', 1],
]);

export const IDIRECT3DTEXTURE9_SLOTS = /** @type {[string, number][]} */ ([
    ...IDIRECT3DBASETEXTURE9_SLOTS,
    ['GetLevelDesc', 2],
    ['GetSurfaceLevel', 2],
    ['LockRect', 4],
    ['UnlockRect', 1],
    ['AddDirtyRect', 1],
]);

export const IDIRECT3DCUBETEXTURE9_SLOTS = /** @type {[string, number][]} */ ([
    ...IDIRECT3DBASETEXTURE9_SLOTS,
    ['GetLevelDesc', 2],
    ['GetCubeMapSurface', 3],
    ['LockRect', 5],
    ['UnlockRect', 2],
    ['AddDirtyRect', 2],
]);

export const IDIRECT3DVOLUMETEXTURE9_SLOTS = /** @type {[string, number][]} */ ([
    ...IDIRECT3DBASETEXTURE9_SLOTS,
    ['GetLevelDesc', 2],
    ['GetVolumeLevel', 2],
    ['LockBox', 4],
    ['UnlockBox', 1],
    ['AddDirtyBox', 1],
]);

/** A volume texture's level, which unlike a surface is not a resource. */
export const IDIRECT3DVOLUME9_SLOTS = /** @type {[string, number][]} */ ([
    ['GetDevice', 1],
    ['SetPrivateData', 4],
    ['GetPrivateData', 3],
    ['FreePrivateData', 1],
    ['GetContainer', 2],
    ['GetDesc', 1],
    ['LockBox', 3],
    ['UnlockBox', 0],
]);

export const IDIRECT3DVERTEXBUFFER9_SLOTS = /** @type {[string, number][]} */ ([
    ...IDIRECT3DRESOURCE9_SLOTS,
    ['Lock', 4],
    ['Unlock', 0],
    ['GetDesc', 1],
]);

export const IDIRECT3DINDEXBUFFER9_SLOTS = IDIRECT3DVERTEXBUFFER9_SLOTS;

export const IDIRECT3DSWAPCHAIN9_SLOTS = /** @type {[string, number][]} */ ([
    ['Present', 5],
    ['GetFrontBufferData', 1],
    ['GetBackBuffer', 3],
    ['GetRasterStatus', 1],
    ['GetDisplayMode', 1],
    ['GetDevice', 1],
    ['GetPresentParameters', 1],
]);

export const IDIRECT3DVERTEXDECLARATION9_SLOTS = /** @type {[string, number][]} */ ([
    ['GetDevice', 1],
    ['GetDeclaration', 2],
]);

/** Both shader interfaces have this shape. */
export const IDIRECT3DSHADER9_SLOTS = /** @type {[string, number][]} */ ([
    ['GetDevice', 1],
    ['GetFunction', 2],
]);

export const IDIRECT3DSTATEBLOCK9_SLOTS = /** @type {[string, number][]} */ ([
    ['GetDevice', 1],
    ['Capture', 0],
    ['Apply', 0],
]);

export const IDIRECT3DQUERY9_SLOTS = /** @type {[string, number][]} */ ([
    ['GetDevice', 1],
    ['GetType', 0],
    ['GetDataSize', 0],
    ['Issue', 1],
    ['GetData', 3],
]);
