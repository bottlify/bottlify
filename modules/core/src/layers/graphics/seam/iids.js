/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Interface identifiers.
 *
 * These are facts about somebody else's ABI, and the only thing that can be
 * done with one is get it right: a program calls QueryInterface with the GUID
 * it was compiled against, and a single wrong digit is an interface that
 * reports it does not exist. There is no partial credit and no way to derive
 * one from anything.
 *
 * They are separated from the descriptors so that a reader checking them
 * against a header has one short list to check rather than a long file to read.
 */

/** DirectDraw. The four generations are four interfaces on one object. */
export const IID_IDirectDraw = '{6C14DB80-A733-11CE-A521-0020AF0BE560}';
export const IID_IDirectDraw2 = '{B3A6F3E0-2B43-11CF-A2DE-00AA00B93356}';
export const IID_IDirectDraw4 = '{9C59509A-39BD-11D1-8C4A-00C04FD930C5}';
export const IID_IDirectDraw7 = '{15E65EC0-3B9C-11D2-B92F-00609797EA5B}';

export const IID_IDirectDrawSurface = '{6C14DB81-A733-11CE-A521-0020AF0BE560}';
export const IID_IDirectDrawSurface2 = '{57805885-6EEC-11CF-9441-A82303C10E27}';
export const IID_IDirectDrawSurface3 = '{DA044E00-69B2-11D0-A1D5-00AA00B8DFBB}';
export const IID_IDirectDrawSurface4 = '{0B2B8630-AD35-11D0-8EA6-00609797EA5B}';
export const IID_IDirectDrawSurface7 = '{06675A80-3B9B-11D2-B92F-00609797EA5B}';

export const IID_IDirectDrawPalette = '{6C14DB84-A733-11CE-A521-0020AF0BE560}';
export const IID_IDirectDrawClipper = '{6C14DB85-A733-11CE-A521-0020AF0BE560}';
export const IID_IDirectDrawGammaControl = '{69C11C3E-B46B-11D1-AD7A-00C04FC29B4E}';

/**
 * Direct3D 7, which is reached from the DirectDraw object by QueryInterface
 * rather than made by an entry point of its own.
 */
export const IID_IDirect3D7 = '{F5049E77-4861-11D2-A407-00A0C90629A8}';
export const IID_IDirect3DDevice7 = '{F5049E79-4861-11D2-A407-00A0C90629A8}';
export const IID_IDirect3DVertexBuffer7 = '{F5049E7D-4861-11D2-A407-00A0C90629A8}';

/** The Direct3D of DirectX 3, 5 and 6, reached the same way. */
export const IID_IDirect3D = '{3BBA0080-2421-11CF-A31A-00AA00B93356}';
export const IID_IDirect3D2 = '{6AAE1EC1-662A-11D0-889D-00AA00BBB76A}';
export const IID_IDirect3D3 = '{BB223240-E72B-11D0-A9B4-00AA00C0993E}';
export const IID_IDirect3DDevice = '{64108800-957D-11D0-89AB-00A0C9054129}';
export const IID_IDirect3DDevice2 = '{93281501-8CF8-11D0-89AB-00A0C9054129}';
export const IID_IDirect3DDevice3 = '{B0AB3B60-33D7-11D1-A981-00C04FD7B174}';
export const IID_IDirect3DTexture = '{2CDCD9E0-25A0-11CF-A31A-00AA00B93356}';
export const IID_IDirect3DTexture2 = '{93281502-8CF8-11D0-89AB-00A0C9054129}';
export const IID_IDirect3DLight = '{4417C142-33AD-11CF-816F-0000C020156E}';
export const IID_IDirect3DMaterial = '{4417C144-33AD-11CF-816F-0000C020156E}';
export const IID_IDirect3DMaterial2 = '{93281503-8CF8-11D0-89AB-00A0C9054129}';
export const IID_IDirect3DMaterial3 = '{CA9C46F4-D3C5-11D1-B75A-00600852B312}';
export const IID_IDirect3DExecuteBuffer = '{4417C145-33AD-11CF-816F-0000C020156E}';
export const IID_IDirect3DViewport = '{4417C146-33AD-11CF-816F-0000C020156E}';
export const IID_IDirect3DViewport2 = '{93281500-8CF8-11D0-89AB-00A0C9054129}';
export const IID_IDirect3DViewport3 = '{B0AB3B61-33D7-11D1-A981-00C04FD7B174}';
export const IID_IDirect3DVertexBuffer = '{7A503555-4A83-11D1-A5DB-00A0C90367F8}';

/** Direct3D 8. */
export const IID_IDirect3D8 = '{1DD9E8DA-1C77-4D40-B0CF-98FEFDFF9512}';
export const IID_IDirect3DDevice8 = '{7385E5DF-8FE8-41D5-86B6-D7B48547B6CF}';

/** Direct3D 9. */
export const IID_IDirect3D9 = '{81BDCBCA-64D4-426D-AE8D-AD0147F4275C}';
export const IID_IDirect3DDevice9 = '{D0223B96-BF7A-43FD-92BD-A43B0D82B9EB}';

/**
 * The Direct3D 8 resource interfaces, as d3d8.h defines them.
 *
 * A resource is nearly always reached through the out-parameter of the call
 * that made it, which hands back the interface already published -- so a wrong
 * identifier here costs nothing until a program queries for one by GUID, and
 * then costs an interface that should have been found. The seam tests query
 * by the header's own bytes for that reason.
 */
export const IID_IDirect3DResource8 = '{1B36BB7B-09B7-410A-B445-7D1430D7B33F}';
export const IID_IDirect3DBaseTexture8 = '{B4211CFA-51B9-4A9F-AB78-DB99B2BB678E}';
export const IID_IDirect3DTexture8 = '{E4CDD575-2866-4F01-B12E-7EECE1EC9358}';
export const IID_IDirect3DSurface8 = '{B96EEBCA-B326-4EA5-882F-2FF5BAE021DD}';
export const IID_IDirect3DVertexBuffer8 = '{8AEEEAC7-05F9-44D4-B591-000B0DF1CB95}';
export const IID_IDirect3DIndexBuffer8 = '{0E689C9A-053D-44A0-9D92-DB0E3D750F86}';
export const IID_IDirect3DSwapChain8 = '{928C088B-76B9-4C6B-A536-A590853876CD}';
export const IID_IDirect3DCubeTexture8 = '{3EE5B968-2ACA-4C34-8BB5-7E0C3D19B750}';
export const IID_IDirect3DVolumeTexture8 = '{4B8AAAFA-140F-42BA-9131-597EAFAA2EAD}';
export const IID_IDirect3DVolume8 = '{BD7349F5-14F1-42E4-9C79-972380DB40C0}';
