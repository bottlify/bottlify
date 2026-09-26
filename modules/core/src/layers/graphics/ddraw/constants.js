/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The DirectDraw constants a program compiles against: return codes, surface
 * capabilities, descriptor field flags, pixel-format flags and cooperative
 * level bits.
 *
 * These are part of the ABI, not an implementation detail. A caps bit read or
 * reported at the wrong value is a plausible-looking number rather than an
 * error, and the guest is the only one that can tell the difference -- so they
 * are written out once, here, and nothing else in the layer spells one inline.
 */

/**
 * MAKE_DDHRESULT: severity bit set, facility 0x876, the code in the low word.
 * A handful of DirectDraw's codes are the generic COM ones instead and are
 * spelled out below rather than run through this.
 *
 * @param {number} code
 * @returns {number}
 */
function dderr(code){
    return ((0x88760000 | code) & 0xffffffff) >>> 0;
}

export const DD_OK = 0;

export const DDERR_ALREADYINITIALIZED = dderr(5);
export const DDERR_CANNOTATTACHSURFACE = dderr(10);
export const DDERR_CANNOTDETACHSURFACE = dderr(20);
export const DDERR_INVALIDCAPS = dderr(100);
export const DDERR_INVALIDOBJECT = dderr(130);
export const DDERR_INVALIDRECT = dderr(150);
export const DDERR_INVALIDMODE = dderr(120);
export const DDERR_NOCOLORKEY = dderr(215);
export const DDERR_NOCOLORKEYHW = dderr(220);
export const DDERR_NOCOOPERATIVELEVELSET = dderr(212);
export const DDERR_NOEXCLUSIVEMODE = dderr(225);
export const DDERR_NOTFOUND = dderr(255);
export const DDERR_NOOVERLAYHW = dderr(260);
export const DDERR_SURFACEALREADYATTACHED = dderr(410);
export const DDERR_SURFACEBUSY = dderr(430);
export const DDERR_SURFACELOST = dderr(450);
export const DDERR_SURFACENOTATTACHED = dderr(460);
export const DDERR_NOCLIPPERATTACHED = dderr(568);
export const DDERR_HWNDALREADYSET = dderr(571);
export const DDERR_CLIPPERISUSINGHWND = dderr(567);
export const DDERR_NOPALETTEATTACHED = dderr(572);
export const DDERR_EXCLUSIVEMODEALREADYSET = dderr(581);
export const DDERR_NOTAOVERLAYSURFACE = dderr(580);
export const DDERR_NOTFLIPPABLE = dderr(582);
export const DDERR_NOTLOCKED = dderr(584);
export const DDERR_NODC = dderr(586);
export const DDERR_IMPLICITLYCREATED = dderr(588);
export const DDERR_INVALIDSURFACETYPE = dderr(592);
export const DDERR_NOTONMIPMAPSUBLEVEL = dderr(603);
export const DDERR_DCALREADYCREATED = dderr(620);

/** DirectDraw borrows these three from COM rather than minting its own. */
export const DDERR_INVALIDPARAMS = 0x80070057;
export const DDERR_OUTOFMEMORY = 0x8007000e;
export const E_NOINTERFACE = 0x80004002;
export const CLASS_E_NOAGGREGATION = 0x80040110;
export const DDERR_UNSUPPORTED = 0x80004001;

/** Blt flags this layer honours; the rest are accepted and ignored. */
export const DDBLT_KEYDEST = 0x00002000;
export const DDBLT_KEYDESTOVERRIDE = 0x00004000;
export const DDBLT_KEYSRC = 0x00008000;
export const DDBLT_KEYSRCOVERRIDE = 0x00010000;
export const DDBLT_COLORFILL = 0x00000400;
export const DDBLT_DEPTHFILL = 0x02000000;
export const DDBLT_WAIT = 0x01000000;

/** BltFast flags. */
export const DDBLTFAST_NOCOLORKEY = 0x00000000;
export const DDBLTFAST_SRCCOLORKEY = 0x00000001;
export const DDBLTFAST_DESTCOLORKEY = 0x00000002;
export const DDBLTFAST_WAIT = 0x00000010;

/** SetColorKey / GetColorKey: which key a call names. */
export const DDCKEY_COLORSPACE = 0x00000001;
export const DDCKEY_DESTBLT = 0x00000002;
export const DDCKEY_SRCBLT = 0x00000008;

/** DDCAPS.dwCaps, the bits this build reports. */
export const DDCAPS_BLT = 0x00000040;
export const DDCAPS_BLTSTRETCH = 0x00000200;
export const DDCAPS_BLTCOLORFILL = 0x04000000;
export const DDCAPS_COLORKEY = 0x00400000;
export const DDCAPS_GDI = 0x00000400;
export const DDCAPS_PALETTE = 0x00008000;
export const DDCAPS_CANBLTSYSMEM = 0x80000000;
export const DDCAPS2_CERTIFIED = 0x00000001;
export const DDCAPS2_WIDESURFACES = 0x00001000;
export const DDCAPS2_PRIMARYGAMMA = 0x00020000;
export const DDCAPS2_CANRENDERWINDOWED = 0x00080000;
export const DDCKEYCAPS_DESTBLT = 0x00000001;
export const DDCKEYCAPS_SRCBLT = 0x00000200;

/** DDSCAPS.dwCaps. */
export const DDSCAPS_BACKBUFFER = 0x00000004;
export const DDSCAPS_COMPLEX = 0x00000008;
export const DDSCAPS_FLIP = 0x00000010;
export const DDSCAPS_FRONTBUFFER = 0x00000020;
export const DDSCAPS_OFFSCREENPLAIN = 0x00000040;
export const DDSCAPS_OVERLAY = 0x00000080;
export const DDSCAPS_PALETTE = 0x00000100;
export const DDSCAPS_PRIMARYSURFACE = 0x00000200;
export const DDSCAPS_SYSTEMMEMORY = 0x00000800;
export const DDSCAPS_TEXTURE = 0x00001000;
export const DDSCAPS_3DDEVICE = 0x00002000;
export const DDSCAPS_VIDEOMEMORY = 0x00004000;
export const DDSCAPS_VISIBLE = 0x00008000;
export const DDSCAPS_WRITEONLY = 0x00010000;
export const DDSCAPS_ZBUFFER = 0x00020000;
export const DDSCAPS_MIPMAP = 0x00400000;
export const DDSCAPS_ALLOCONLOAD = 0x04000000;
export const DDSCAPS_LOCALVIDMEM = 0x10000000;
export const DDSCAPS_NONLOCALVIDMEM = 0x20000000;

/**
 * The three bits that say where a surface ended up rather than what it is.
 * Creation adds them, so a test comparing requested against reported caps has
 * to mask them out or compare against the placement the driver chose.
 */
export const PLACEMENT_CAPS = DDSCAPS_LOCALVIDMEM | DDSCAPS_VIDEOMEMORY | DDSCAPS_SYSTEMMEMORY;

/** DDSCAPS2.dwCaps2. */
export const DDSCAPS2_TEXTUREMANAGE = 0x00000010;
export const DDSCAPS2_CUBEMAP = 0x00000200;
export const DDSCAPS2_CUBEMAP_POSITIVEX = 0x00000400;
export const DDSCAPS2_CUBEMAP_ALLFACES = 0x0000fc00;
export const DDSCAPS2_MIPMAPSUBLEVEL = 0x00010000;
export const DDSCAPS2_D3DTEXTUREMANAGE = 0x00020000;

/** DDSURFACEDESC.dwFlags: which fields of the descriptor the caller filled in. */
export const DDSD_CAPS = 0x00000001;
export const DDSD_HEIGHT = 0x00000002;
export const DDSD_WIDTH = 0x00000004;
export const DDSD_PITCH = 0x00000008;
export const DDSD_BACKBUFFERCOUNT = 0x00000020;
export const DDSD_ZBUFFERBITDEPTH = 0x00000040;
export const DDSD_ALPHABITDEPTH = 0x00000080;
export const DDSD_LPSURFACE = 0x00000800;
export const DDSD_PIXELFORMAT = 0x00001000;
export const DDSD_CKDESTOVERLAY = 0x00002000;
export const DDSD_CKDESTBLT = 0x00004000;
export const DDSD_CKSRCOVERLAY = 0x00008000;
export const DDSD_CKSRCBLT = 0x00010000;
export const DDSD_MIPMAPCOUNT = 0x00020000;
export const DDSD_REFRESHRATE = 0x00040000;
export const DDSD_LINEARSIZE = 0x00080000;
export const DDSD_TEXTURESTAGE = 0x00100000;
export const DDSD_FVF = 0x00200000;
export const DDSD_DEPTH = 0x00800000;

/** DDPIXELFORMAT.dwFlags. */
export const DDPF_ALPHAPIXELS = 0x00000001;
export const DDPF_ALPHA = 0x00000002;
export const DDPF_FOURCC = 0x00000004;
export const DDPF_PALETTEINDEXED4 = 0x00000008;
export const DDPF_PALETTEINDEXEDTO8 = 0x00000010;
export const DDPF_PALETTEINDEXED8 = 0x00000020;
export const DDPF_RGB = 0x00000040;
export const DDPF_COMPRESSED = 0x00000080;
export const DDPF_YUV = 0x00000200;
export const DDPF_ZBUFFER = 0x00000400;
export const DDPF_PALETTEINDEXED1 = 0x00000800;
export const DDPF_PALETTEINDEXED2 = 0x00001000;
export const DDPF_STENCILBUFFER = 0x00004000;
export const DDPF_LUMINANCE = 0x00020000;

/** Every way a pixel format can say "the value is an index into a palette". */
export const DDPF_PALETTEINDEXED_ANY = DDPF_PALETTEINDEXED1 | DDPF_PALETTEINDEXED2
    | DDPF_PALETTEINDEXED4 | DDPF_PALETTEINDEXED8;

/** DDPCAPS: what a palette holds and what it is attached to. */
export const DDPCAPS_4BIT = 0x00000001;
export const DDPCAPS_8BITENTRIES = 0x00000002;
export const DDPCAPS_8BIT = 0x00000004;
export const DDPCAPS_INITIALIZE = 0x00000008;
export const DDPCAPS_PRIMARYSURFACE = 0x00000010;
export const DDPCAPS_ALLOW256 = 0x00000040;
export const DDPCAPS_1BIT = 0x00000100;
export const DDPCAPS_2BIT = 0x00000200;

/** SetCooperativeLevel flags. */
export const DDSCL_FULLSCREEN = 0x00000001;
export const DDSCL_NORMAL = 0x00000008;
export const DDSCL_EXCLUSIVE = 0x00000010;
export const DDSCL_SETFOCUSWINDOW = 0x00000080;
export const DDSCL_ALLOWMODEX = 0x00000040;
export const DDSCL_MULTITHREADED = 0x00000400;

/** Lock and Flip flags this layer has an opinion about. */
export const DDLOCK_READONLY = 0x00000010;
export const DDLOCK_WRITEONLY = 0x00000020;
export const DDLOCK_WAIT = 0x00000001;
export const DDFLIP_WAIT = 0x00000001;

/** GetDeviceIdentifier: the adapter a secondary 3D-only device is attached to. */
export const DDGDI_GETHOSTIDENTIFIER = 0x00000001;
