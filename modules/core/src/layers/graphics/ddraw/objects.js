/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * DirectDraw's object model: what exists, who owns whom, and when it dies.
 *
 * Nothing here draws. Every method is about state a program can observe
 * without a single pixel moving -- a reference count, an error code, which
 * surface a walk arrives at next -- because that is the part that is cheap to
 * get right while writing and expensive to retrofit underneath a renderer.
 *
 * Four rules are worth stating up front, because each one contradicts what a
 * reader would otherwise assume:
 *
 * - **The interface generations do not share a reference count.** Query
 *   IDirectDraw, IDirectDraw2, IDirectDraw4 and IDirectDraw7 from one object
 *   and each has a count of one. This breaks the COM rule that an object has
 *   a single count, and it is the biggest trap in the API: releasing "the"
 *   object releases one generation and leaves the other three alive. The
 *   object dies when every generation that was ever handed out is at zero.
 * - **IDirectDrawX and IDirect3DX are the same count.** Querying IDirect3D7
 *   raises IDirectDraw7's count, and an AddRef through either raises what the
 *   other reads back. The older Direct3D interfaces bind instead to whichever
 *   IDirectDraw generation queried one first, and stay bound to it.
 * - **Creating a surface or a palette takes a reference on the ddraw object,
 *   but only through the two newer generations.** IDirectDraw and
 *   IDirectDraw2 hand back a surface without raising anything, so a program
 *   written against them can release the ddraw object and keep drawing. This
 *   is a version difference, not an oversight to normalise away.
 * - **A palette is owned by the surface it is set on, not the other way
 *   round.** SetPalette raises the palette's count and leaves the surface's
 *   alone; releasing the surface detaches the palette and lowers it again.
 *
 * The flip chain is stored as a forward link per surface and no backward one
 * at the end. Walking the attached surfaces from the last back buffer still
 * arrives at the front -- the loop closes -- but it closes because the walk
 * knows where the head is, not because a link points there. A stored closing
 * link would be a reference the front could never shed, and the front's own
 * release is what destroys the chain.
 */

import {
    CLASS_E_NOAGGREGATION,
    DDCKEY_COLORSPACE,
    DDCKEY_DESTBLT,
    DDCKEY_SRCBLT,
    DDERR_CANNOTATTACHSURFACE,
    DDERR_CANNOTDETACHSURFACE,
    DDERR_CANTCREATEDC,
    DDERR_DCALREADYCREATED,
    DDERR_CLIPPERISUSINGHWND,
    DDERR_EXCLUSIVEMODEALREADYSET,
    DDERR_WRONGMODE,
    DDERR_INVALIDCAPS,
    DDERR_INVALIDMODE,
    DDERR_INVALIDOBJECT,
    DDERR_INVALIDPARAMS,
    DDERR_INVALIDSURFACETYPE,
    DDERR_NOCLIPPERATTACHED,
    DDERR_NOCOLORKEY,
    DDERR_NOCOLORKEYHW,
    DDERR_NOCOOPERATIVELEVELSET,
    DDERR_NODC,
    DDERR_NOEXCLUSIVEMODE,
    DDERR_NOPALETTEATTACHED,
    DDERR_NOTFLIPPABLE,
    DDERR_NOTFOUND,
    DDERR_NOTLOCKED,
    DDERR_NOTONMIPMAPSUBLEVEL,
    DDERR_SURFACEALREADYATTACHED,
    DDERR_SURFACEBUSY,
    DDERR_SURFACELOST,
    DDERR_SURFACENOTATTACHED,
    DDPCAPS_1BIT,
    DDPCAPS_2BIT,
    DDPCAPS_4BIT,
    DDPCAPS_PRIMARYSURFACE,
    DDPF_FOURCC,
    DDPF_PALETTEINDEXED8,
    DDPF_RGB,
    DDPF_ZBUFFER,
    DDSCAPS2_D3DTEXTUREMANAGE,
    DDSCAPS2_MIPMAPSUBLEVEL,
    DDSCAPS2_CUBEMAP,
    DDSCAPS2_CUBEMAP_ALLFACES,
    DDSCAPS2_CUBEMAP_POSITIVEX,
    DDSCAPS2_TEXTUREMANAGE,
    DDSCAPS_FLIP,
    DDSCAPS_PRIMARYSURFACE,
    DDSCAPS_SYSTEMMEMORY,
    DDSCAPS_TEXTURE,
    DDSCAPS_VISIBLE,
    DDSCAPS_ZBUFFER,
    DDSCL_EXCLUSIVE,
    DDSD_BACKBUFFERCOUNT,
    DDSD_CAPS,
    DDSD_HEIGHT,
    DDSD_LPSURFACE,
    DDSD_MIPMAPCOUNT,
    DDSD_PITCH,
    DDSD_PIXELFORMAT,
    DDSD_WIDTH,
    DDSD_ZBUFFERBITDEPTH,
    DDLOCK_READONLY,
    DD_OK,
    E_NOINTERFACE,
} from './constants.js';
import {
    acceptsMalformedLockRect,
    backBufferCaps,
    mipLevelCount,
    validateSurfaceCaps,
    validateSurfaceSize,
} from './caps.js';
import { bytesPerPixel } from './structs.js';

/**
 * A DXTn surface's row: one row of 4x4 blocks, eight bytes a block for DXT1
 * and sixteen for the others, as a lock hands it out and a loader writes the
 * blocks row after row. Null for a format that is not block-compressed.
 *
 * @param {import('./structs.js').PixelFormatFields} format @param {number} width
 * @returns {number | null}
 */
function blockRowBytes(format, width){
    if ((format.flags & DDPF_FOURCC) === 0)
    {
        return null;
    }
    const code = format.fourCC >>> 0;
    if (code < 0x31545844 || code > 0x35545844)
    {
        return null;
    }
    return Math.max(1, Math.ceil(width / 4)) * (code === 0x31545844 ? 8 : 16);
}

/** The four IDirectDraw generations, in the order they were introduced. */
const DDRAW_INTERFACES = Object.freeze(
    ['IDirectDraw', 'IDirectDraw2', 'IDirectDraw4', 'IDirectDraw7']);

/** Which generation a version number names. */
const GENERATION_OF = Object.freeze({
    1: 'IDirectDraw',
    2: 'IDirectDraw2',
    4: 'IDirectDraw4',
    7: 'IDirectDraw7',
});

/**
 * The generations whose count a surface or palette takes a reference on. The
 * two older ones create without owning.
 */
const OWNING_GENERATIONS = Object.freeze(new Set(['IDirectDraw4', 'IDirectDraw7']));

/** The three Direct3D interfaces that predate IDirect3D7 and behave alike. */
const LEGACY_D3D = Object.freeze(new Set(['IDirect3D', 'IDirect3D2', 'IDirect3D3']));

/**
 * @typedef {Object} Rect
 * @property {number} left
 * @property {number} top
 * @property {number} right
 * @property {number} bottom
 */

/**
 * @typedef {Object} ColorKey
 * @property {number} low
 * @property {number} high
 */

/**
 * @typedef {Object} SurfaceRequest
 * @property {number} flags       dwFlags, saying which of the rest was filled in.
 * @property {number} caps
 * @property {number} [caps2]
 * @property {number} [width]
 * @property {number} [height]
 * @property {number} [backBufferCount]
 * @property {number} [mipMapCount]      dwMipMapCount, when DDSD_MIPMAPCOUNT names it.
 * @property {number} [zBufferBitDepth]  dwZBufferBitDepth, in the older layout.
 * @property {import("./structs.js").PixelFormatFields} [pixelFormat]
 * @property {ColorKey} [srcColorKey]   ddckCKSrcBlt, when DDSD_CKSRCBLT names it.
 * @property {ColorKey} [destColorKey]  ddckCKDestBlt, when DDSD_CKDESTBLT names it.
 * @property {number} [pitch]           lPitch, when DDSD_PITCH names it.
 * @property {number} [surfacePointer]  lpSurface, when DDSD_LPSURFACE names it.
 */

/** The fields SetSurfaceDesc may name; lpSurface has to be among them. */
const SETTABLE_FIELDS = DDSD_LPSURFACE | DDSD_WIDTH | DDSD_HEIGHT | DDSD_PITCH | DDSD_PIXELFORMAT
    | DDSD_CAPS;

/**
 * The pixel format of a depth buffer asked for by bit depth alone, which is
 * how the older descriptor describes one: a depth of sixteen is depth only,
 * thirty-two is twenty-four bits of depth and eight of stencil, the way the
 * hardware of the era laid them out.
 *
 * @param {number} bitDepth
 * @returns {import("./structs.js").PixelFormatFields}
 */
export function depthFormatForDepth(bitDepth){
    const stencil = bitDepth === 32 ? 8 : 0;
    return {
        size: 0x20,
        flags: DDPF_ZBUFFER,
        fourCC: 0,
        bitCount: bitDepth,
        redMask: stencil,
        greenMask: stencil === 0 ? 0xffffffff >>> (32 - bitDepth) : 0x00ffffff,
        blueMask: stencil === 0 ? 0 : 0xff000000,
        alphaMask: 0,
    };
}

/**
 * The three child objects, written out rather than inferred. A surface refers
 * to other surfaces -- the one behind it in a flip chain, the depth buffer
 * attached to it -- so its type cannot be read off its own construction.
 *
 * @typedef {Object} Palette
 * @property {number} refCount
 * @property {boolean} destroyed
 * @property {() => number} addRef
 * @property {() => number} release
 * @property {number} caps
 * @property {number[]} entries
 * @property {number[]} pixels
 *     The entries as the pixels a drawing surface holds, kept up to date in
 *     place, so a device context given this array sees every later SetEntries.
 * @property {(on: boolean) => void} markPrimary
 * @property {(start: number, values: readonly number[]) => number} setEntries
 * @property {(start: number, count: number) => { hr: number, entries: number[] }} getEntries
 *
 * @typedef {Object} Clipper
 * @property {number} refCount
 * @property {boolean} destroyed
 * @property {() => number} addRef
 * @property {() => number} release
 * @property {Rect[]} clipList
 * @property {(rects: Rect[]) => number} setClipList
 * @property {number} window
 * @property {(handle: number) => number} setHWnd
 * @property {() => boolean} isClipListChanged
 *
 * @typedef {Object} LockResult
 * @property {number} hr
 * @property {number | null} surfacePointer  Null on every failure, without exception.
 * @property {number} pitch
 *
 * @typedef {Object} Surface
 * @property {number} refCount
 * @property {boolean} destroyed
 * @property {any} directDraw  The DirectDraw object that made it.
 * @property {() => number} addRef
 * @property {() => number} release
 * @property {number} caps
 * @property {number} caps2
 * @property {number} width
 * @property {number} height
 * @property {number} pitch
 * @property {import("./structs.js").PixelFormatFields} pixelFormat
 * @property {number} backBufferCount
 * @property {number} mipMapCount     Levels from this one down; zero off a mip chain.
 * @property {Surface | null} mipNext The next smaller level.
 * @property {(next: Surface | null) => void} setMipNext
 * @property {(faces: Surface[]) => void} setFaces  A cube map's other faces, on its first.
 * @property {number} buffer          The pixels this surface currently shows.
 * @property {boolean} implicit       Created as part of a complex surface.
 * @property {Palette | null} palette
 * @property {Clipper | null} clipper
 * @property {number} bytesPerPixel
 * @property {boolean} locked
 * @property {number | null} dc
 * @property {() => void} present
 * @property {(rect: Rect | null, value: number) => void} depthFilled
 * @property {(rect: Rect | null, value: number) => boolean} colorFilled  whether whoever
 *           keeps its pixels on the GPU filled them there, the guest bytes left to read
 *           back when a program reads them
 * @property {(which: number, key: ColorKey | null) => number} setColorKey
 * @property {(which: number) => { hr: number, key: ColorKey | null }} getColorKey
 * @property {() => number} uniquenessValue
 * @property {() => void} changeUniquenessValue
 * @property {Surface | null} flipNext
 * @property {Surface | null} flipPrev
 * @property {(value: number) => void} setBuffer
 * @property {(value: number) => void} setCaps
 * @property {(previous: Surface | null) => void} setFlipPrev
 * @property {(next: Surface | null, isImplicit: boolean) => void} setFlipNext
 * @property {() => void} markLost
 * @property {() => number} isLost
 * @property {() => number} restore
 * @property {(next: Palette | null) => number} setPalette
 * @property {() => { hr: number, palette: Palette | null }} getPalette
 * @property {(next: Clipper | null) => number} setClipper
 * @property {() => { hr: number, clipper: Clipper | null }} getClipper
 * @property {(rect?: Rect | null, flags?: number) => LockResult} lock
 * @property {(rect?: Rect | null) => number} unlock
 * @property {() => { hr: number, dc: number | null }} getDC
 * @property {(handle: number) => number} releaseDC
 * @property {(other: Surface) => number} addAttachedSurface
 * @property {(other: Surface | null) => number} deleteAttachedSurface
 * @property {(wanted: number, wanted2?: number) => { hr: number, surface: Surface | null }}
 *           getAttachedSurface
 * @property {() => Surface[]} enumAttachedSurfaces
 * @property {(target?: Surface | null, flags?: number) => number} flip
 * @property {(request: SurfaceRequest, flags: number) => number} setSurfaceDesc
 * @property {Uint16Array | null} gammaRamp  What SetGammaRamp set; null is the identity.
 * @property {() => Uint16Array} getGammaRamp
 * @property {(ramp: ArrayLike<number>) => number} setGammaRamp
 * @property {() => { hr: number, priority: number }} getPriority
 * @property {(value: number) => number} setPriority
 * @property {() => Promise<void> | null} pixelsCurrent
 *
 * @typedef {Object} PixelWatcher
 * @property {(surface: Surface) => Promise<void> | null} readBack
 *           Settles once the surface's guest bytes hold what the watcher's copy
 *           holds; null for a surface it keeps no copy of.
 * @property {(surface: Surface) => void} written
 *           The guest bytes are newer than the watcher's copy now.
 */

/** Entries per channel of a DDGAMMARAMP, and its three channels end to end. */
const GAMMA_ENTRIES = 256;
const GAMMA_WORDS = GAMMA_ENTRIES * 3;

/** @returns {Uint16Array} red, green and blue, each passing its input straight through */
function identityRamp(){
    return Uint16Array.from({ length: GAMMA_WORDS }, (_, index)=>(index % GAMMA_ENTRIES) * 257);
}

/**
 * The pixel format a display depth means, which is what a primary surface --
 * and a surface whose description carried no format -- is created with.
 *
 * Three depths: a palettised byte, 5-6-5, and X8R8G8B8. Twenty-four bits is
 * not a mode this layer sets, and a request for one is refused rather than
 * answered with the nearest thing.
 *
 * @param {number} bitCount
 * @returns {import("./structs.js").PixelFormatFields | null}
 */
export function pixelFormatForDepth(bitCount){
    switch (bitCount)
    {
        case 8:
            return { size: 0x20, flags: DDPF_RGB | DDPF_PALETTEINDEXED8, fourCC: 0,
                bitCount: 8, redMask: 0, greenMask: 0, blueMask: 0, alphaMask: 0 };
        case 16:
            return { size: 0x20, flags: DDPF_RGB, fourCC: 0, bitCount: 16,
                redMask: 0xf800, greenMask: 0x07e0, blueMask: 0x001f, alphaMask: 0 };
        case 32:
            return { size: 0x20, flags: DDPF_RGB, fourCC: 0, bitCount: 32,
                redMask: 0x00ff0000, greenMask: 0x0000ff00, blueMask: 0x000000ff, alphaMask: 0 };
        default:
            return null;
    }
}

/** How many entries a palette holds, from the capability that says its width. */
const PALETTE_SIZES = Object.freeze([
    [DDPCAPS_1BIT, 2], [DDPCAPS_2BIT, 4], [DDPCAPS_4BIT, 16],
]);

/** @param {number} caps @returns {number} */
function paletteSize(caps){
    const narrow = PALETTE_SIZES.find(([bit])=>(caps & bit) !== 0);
    return narrow ? narrow[1] : 256;
}

/**
 * @param {Rect | null} rect
 * @param {number} width
 * @param {number} height
 * @returns {Rect}
 */
function wholeSurface(rect, width, height){
    return rect ?? { left: 0, top: 0, right: width, bottom: height };
}

/**
 * A lock rectangle is malformed when it is inverted or reaches outside the
 * surface. An empty one is not: a rectangle with zero width or zero height
 * locks nothing and is accepted.
 *
 * @param {Rect} rect
 * @param {number} width
 * @param {number} height
 * @returns {boolean}
 */
function rectIsValid(rect, width, height){
    return rect.left >= 0 && rect.top >= 0
        && rect.right <= width && rect.bottom <= height
        && rect.left <= rect.right && rect.top <= rect.bottom;
}

/**
 * Whether two display modes are one: the same size and depth. The refresh
 * rate is left out, zero standing for whatever rate the display runs at.
 *
 * @param {{ width: number, height: number, bitCount: number }} a
 * @param {{ width: number, height: number, bitCount: number }} b
 */
function sameMode(a, b){
    return a.width === b.width && a.height === b.height && a.bitCount === b.bitCount;
}

/**
 * @param {Rect} a
 * @param {Rect} b
 * @returns {boolean}
 */
function sameRect(a, b){
    return a.left === b.left && a.top === b.top
        && a.right === b.right && a.bottom === b.bottom;
}

/**
 * @typedef {Object} DirectDrawOptions
 * @property {1 | 2 | 4 | 7} [version]  The generation the object was created through.
 * @property {number} [screenWidth]
 * @property {number} [screenHeight]
 * @property {(bytes: number) => number} [allocate]
 *           Where a surface's pixels live. Injected so the model is testable
 *           with no backend; the default hands out distinct, page-aligned
 *           addresses and never reads or writes them.
 * @property {(address: number) => void} [free]
 *           Gives a surface's pixels back when its last reference goes.
 * @property {(attributes: DcAttributes) => number} [createDc]
 *           A device context handle for GetDC, over the surface's own pixels.
 *           This layer records that one was handed out and nothing more --
 *           what a DC *is* belongs to gdi, which is told where the pixels are.
 * @property {(handle: number) => void} [releaseDc]
 *           The other end of `createDc`.
 * @property {import('../webgpu/internal/presenter.js').DisplayGamma} [gamma]
 *           The display's gamma ramp, which is the primary surface's: set when
 *           a program sets one through the primary's gamma control, taken back
 *           when the primary goes. Absent, a ramp is kept and read back only.
 * @property {{ deactivated: () => boolean, deactivations: () => number }} [application]
 *           Whether the application is not the active one now, and how many
 *           times it has stopped being. An exclusive owner loses its video
 *           memory each time, and cannot restore it until the application is
 *           active again. Absent, the application is always active.
 * @property {(surface: Surface, window: number, exclusive: boolean) => void} [onPresent]
 *           Called whenever what the primary surface shows may have changed: a
 *           flip, an unlock or a released DC on it, a blit into it -- with the
 *           window the cooperative level named and whether it is exclusive,
 *           which is whose picture this is. What showing means -- uploading,
 *           composing, presenting -- is not decided here.
 */

/**
 * @typedef {Object} DcAttributes
 * @property {number} width
 * @property {number} height
 * @property {number} pitch
 * @property {number} bitCount
 * @property {number} bits   Guest address of row zero.
 * @property {number[] | null} palette
 *           The surface's palette as `0x00RRGGBB` pixels, for an 8-bit surface
 *           with one set; null otherwise. A PALETTEENTRY holds red in its low
 *           byte and a pixel holds blue, so the two are not the same dword.
 * @property {'565' | '555'} format
 *           Which 16-bit layout the surface's masks describe; meaningless at
 *           other depths.
 */

/**
 * @param {number} entry a PALETTEENTRY dword: red, green, blue, flags as bytes
 * @returns {number} the pixel a drawing surface holds
 */
function paletteEntryToPixel(entry){
    return (((entry & 0xff) << 16) | (entry & 0xff00) | ((entry >>> 16) & 0xff)) >>> 0;
}

/**
 * @param {DirectDrawOptions} [options]
 */
export function createDirectDraw(options = {}){
    const screenWidth = options.screenWidth ?? 640;
    const screenHeight = options.screenHeight ?? 480;

    let nextAddress = 0x40000000;
    const allocate = options.allocate ?? (bytes=>{
        const address = nextAddress;
        nextAddress += (bytes + 0xfff) & ~0xfff;
        return address;
    });

    const free = options.free ?? (()=>{});

    let nextDc = 0x1000;
    const createDc = options.createDc ?? (()=>{
        nextDc += 4;
        return nextDc;
    });
    const releaseDc = options.releaseDc ?? (()=>{});
    const onPresent = options.onPresent ?? (()=>{});
    /**
     * Who draws against a depth buffer somewhere else -- a Direct3D device,
     * on the GPU -- and so must hear of a fill of its memory.
     *
     * @type {Set<(surface: Surface, rect: Rect | null, value: number) => void>}
     */
    const depthFillWatchers = new Set();
    /**
     * Who draws into a surface on the GPU and fills it there itself: a colour
     * fill handed to one is no read-back, fill and upload again.
     *
     * @type {Set<(surface: Surface, rect: Rect | null, value: number) => boolean>}
     */
    const colorFillWatchers = new Set();
    /**
     * Who keeps a surface's pixels somewhere other than its guest bytes -- a
     * Direct3D device, on the GPU -- and so is asked for them before they are
     * read and told when the program wrote them.
     *
     * @type {Set<PixelWatcher>}
     */
    const pixelWatchers = new Set();

    /**
     * The display mode, which is what a primary surface takes its size and
     * format from. Restoring puts it back to what the screen was built as.
     */
    const nativeMode = { width: screenWidth, height: screenHeight, bitCount: 32, refreshRate: 0 };
    let displayMode = { ...nativeMode };

    /** Per-generation counts. A generation exists once it has been handed out. */
    /** @type {Map<string, number>} */
    const counts = new Map();
    /** @type {Map<string, { id: string, generation: string }>} */
    const published = new Map();
    /** @type {Set<any>} */
    const surfaces = new Set();

    /**
     * Which generation the older Direct3D interfaces are bound to. Chosen by
     * the first query for one and never revisited, which is why an interface
     * queried later through a different generation still reports the first
     * one's count.
     * @type {string | null}
     */
    let legacyD3dGeneration = null;

    let cooperativeLevel = 0;
    let cooperativeWindow = 0;
    let levelSet = false;
    let destroyed = false;

    const seed = GENERATION_OF[options.version ?? 7];
    counts.set(seed, 1);
    published.set(seed, { id: seed, generation: seed });

    /** @returns {boolean} */
    const exclusive = ()=>(cooperativeLevel & DDSCL_EXCLUSIVE) !== 0;

    /**
     * Whether a surface's memory is the display's, which the display takes
     * back: anything not in system memory. A managed texture is the
     * runtime's to keep and reports itself in system memory besides.
     *
     * @param {{ caps: number, caps2: number }} surface
     */
    const canBeLost = surface=>(surface.caps & DDSCAPS_SYSTEMMEMORY) === 0
        && (surface.caps2 & (DDSCAPS2_TEXTUREMANAGE | DDSCAPS2_D3DTEXTUREMANAGE)) === 0;
    const loseVideoMemory = ()=>{
        for (const surface of surfaces)
        {
            if (canBeLost(surface))
            {
                surface.markLost();
            }
        }
    };
    /** The deactivations counted when this object last looked. */
    let deactivationsSeen = options.application?.deactivations() ?? 0;
    /**
     * Brings the surfaces up to what the application's activation has done
     * since they were last looked at: every deactivation while this object
     * held the screen took its video memory. Asked on every call that can
     * find a surface lost, because nothing tells this layer when it happens.
     */
    const noticeDeactivation = ()=>{
        const count = options.application?.deactivations() ?? 0;
        if (count !== deactivationsSeen)
        {
            deactivationsSeen = count;
            if (exclusive())
            {
                loseVideoMemory();
            }
        }
    };
    /** Whether the screen is out of this object's hands: exclusive, and in the background. */
    const screenWithheld = ()=>exclusive() && options.application?.deactivated() === true;
    /**
     * Makes `next` the display mode. A change of size or depth takes the
     * display's memory back from every surface, whichever cooperative level
     * the object is at; setting the mode already in effect takes nothing.
     *
     * @param {{ width: number, height: number, bitCount: number, refreshRate: number }} next
     */
    const changeDisplayMode = next=>{
        const changed = !sameMode(next, displayMode);
        displayMode = next;
        if (changed)
        {
            loseVideoMemory();
        }
    };

    function destroyIfUnreferenced(){
        if (destroyed)
        {
            return;
        }
        for (const count of counts.values())
        {
            if (count > 0)
            {
                return;
            }
        }
        destroyed = true;
    }

    /** @param {string} generation */
    function addRef(generation){
        counts.set(generation, (counts.get(generation) ?? 0) + 1);
        return counts.get(generation) ?? 0;
    }

    /** @param {string} generation */
    function release(generation){
        const count = (counts.get(generation) ?? 0) - 1;
        counts.set(generation, Math.max(count, 0));
        destroyIfUnreferenced();
        return Math.max(count, 0);
    }

    /**
     * Which generation's count a Direct3D interface shares, or null when the
     * interface is not reachable from the one asked through.
     *
     * @param {string} id
     * @param {string} through
     * @returns {string | null}
     */
    function d3dGenerationFor(id, through){
        if (id === 'IDirect3D7')
        {
            // IDirect3D7 exists only on the newest generation, and the newest
            // generation answers for nothing older.
            return through === 'IDirectDraw7' ? 'IDirectDraw7' : null;
        }
        if (through === 'IDirectDraw7' || through === 'IDirect3D7')
        {
            return null;
        }
        if (legacyD3dGeneration === null)
        {
            legacyD3dGeneration = published.get(through)?.generation ?? through;
        }
        return legacyD3dGeneration;
    }

    /**
     * The generation the older Direct3D interfaces count against when the
     * caller cannot say which interface a query came through -- the bridge
     * answers a QueryInterface from the table alone. Bound as a query binds
     * it, once: to the newest generation before the seventh that is held,
     * which is the one a program queries from, or else to the seed.
     *
     * @returns {string}
     */
    function legacyD3dGenerationHeld(){
        if (legacyD3dGeneration === null)
        {
            legacyD3dGeneration = ['IDirectDraw4', 'IDirectDraw2', 'IDirectDraw']
                .find(generation=>(counts.get(generation) ?? 0) > 0) ?? seed;
        }
        return legacyD3dGeneration;
    }

    /**
     * @param {string} id       The interface asked for.
     * @param {string} [through] The interface asked through; defaults to the seed.
     * @returns {{ hr: number, iface: { id: string, generation: string } | null }}
     */
    function queryInterface(id, through = seed){
        if (destroyed)
        {
            return { hr: E_NOINTERFACE, iface: null };
        }
        let generation = null;
        if (DDRAW_INTERFACES.includes(id))
        {
            generation = id;
        }
        else if (id === 'IDirect3D7' || LEGACY_D3D.has(id))
        {
            generation = d3dGenerationFor(id, through);
        }
        if (generation === null)
        {
            return { hr: E_NOINTERFACE, iface: null };
        }
        // Memoised, so two queries for one interface answer with one record and
        // the pointers a program compares stay equal.
        let record = published.get(id);
        if (!record)
        {
            record = { id, generation };
            published.set(id, record);
        }
        addRef(record.generation);
        return { hr: DD_OK, iface: record };
    }

    /**
     * @typedef {Object} Life
     * @property {number} count
     * @property {boolean} dead
     * @property {() => number} addRef
     * @property {() => number} release
     */

    /**
     * The reference counting every child object shares. `destroy` runs once,
     * when the last reference goes, and is where a child sheds what it holds.
     *
     * Callers hold this record and expose `refCount` over it rather than
     * spreading it in: a getter copied by a spread becomes a frozen number,
     * and every count in the model would then read as one forever.
     *
     * @param {() => void} destroy
     * @returns {Life}
     */
    function counted(destroy){
        /** @type {Life} */
        const life = {
            count: 1,
            dead: false,
            addRef(){
                life.count++;
                return life.count;
            },
            release(){
                if (life.dead)
                {
                    return 0;
                }
                life.count--;
                if (life.count > 0)
                {
                    return life.count;
                }
                life.dead = true;
                destroy();
                return 0;
            },
        };
        return life;
    }

    /**
     * @param {number} paletteCaps
     * @param {number[]} entries
     * @param {string | null} owner  The generation to release when the palette dies.
     * @returns {Palette}
     */
    function makePalette(paletteCaps, entries, owner){
        let caps = paletteCaps >>> 0;
        const size = paletteSize(caps);
        // Every entry exists from the start: a program reads back the ones it
        // never wrote and expects zeros, not a shorter array.
        const held = Array.from({ length: size }, (_, index)=>(entries[index] ?? 0) >>> 0);
        const pixels = held.map(paletteEntryToPixel);
        const life = counted(()=>{
            if (owner)
            {
                release(owner);
            }
        });
        /** @type {Palette} */
        const palette = {
            get refCount(){
                return life.count;
            },
            get destroyed(){
                return life.dead;
            },
            addRef: ()=>life.addRef(),
            release: ()=>life.release(),
            get caps(){
                return caps;
            },
            get entries(){
                return held;
            },
            get pixels(){
                return pixels;
            },
            /** @param {boolean} on */
            markPrimary(on){
                caps = (on ? caps | DDPCAPS_PRIMARYSURFACE : caps & ~DDPCAPS_PRIMARYSURFACE) >>> 0;
            },

            /**
             * @param {number} start
             * @param {readonly number[]} values  PALETTEENTRY dwords.
             */
            setEntries(start, values){
                if (start < 0 || start + values.length > size)
                {
                    return DDERR_INVALIDPARAMS;
                }
                values.forEach((value, index)=>{
                    held[start + index] = value >>> 0;
                    pixels[start + index] = paletteEntryToPixel(value >>> 0);
                });
                // The screen shows the primary through its palette, and on the
                // hardware a new entry is on it at once, with no blit: that is
                // how a program fades its picture in and out.
                if ((caps & DDPCAPS_PRIMARYSURFACE) !== 0)
                {
                    for (const surface of surfaces)
                    {
                        if (surface.palette === palette)
                        {
                            surface.present();
                        }
                    }
                }
                return DD_OK;
            },

            /**
             * @param {number} start
             * @param {number} count
             * @returns {{ hr: number, entries: number[] }}
             */
            getEntries(start, count){
                if (start < 0 || count < 0 || start + count > size)
                {
                    return { hr: DDERR_INVALIDPARAMS, entries: [] };
                }
                return { hr: DD_OK, entries: held.slice(start, start + count) };
            },
        };
        return palette;
    }

    /** @returns {Clipper} */
    function makeClipper(){
        let clipList = /** @type {Rect[]} */ ([]);
        let window = 0;
        let changed = false;
        const life = counted(()=>{
            clipList = [];
        });
        return {
            get refCount(){
                return life.count;
            },
            get destroyed(){
                return life.dead;
            },
            addRef: ()=>life.addRef(),
            release: ()=>life.release(),
            get clipList(){
                return clipList;
            },
            /**
             * A clipper bound to a window takes its list from the window, so a
             * list set by hand is refused while one is bound.
             *
             * @param {Rect[]} rects
             */
            setClipList(rects){
                if (window !== 0)
                {
                    return DDERR_CLIPPERISUSINGHWND;
                }
                clipList = rects.map(rect=>({ ...rect }));
                changed = true;
                return DD_OK;
            },
            get window(){
                return window;
            },
            /** @param {number} handle */
            setHWnd(handle){
                window = handle >>> 0;
                changed = true;
                return DD_OK;
            },
            /** Whether the list moved since the last time this was asked. */
            isClipListChanged(){
                const answer = changed;
                changed = false;
                return answer;
            },
        };
    }

    /** The palette set on the primary surface, or null. @returns {Palette | null} */
    function primaryPalette(){
        for (const surface of surfaces)
        {
            if ((surface.caps & DDSCAPS_PRIMARYSURFACE) !== 0 && surface.palette)
            {
                return surface.palette;
            }
        }
        return null;
    }

    /**
     * @param {{ caps: number, caps2: number, width: number, height: number,
     *   backBufferCount: number, pixelFormat: import("./structs.js").PixelFormatFields,
     *   owner: string | null, implicit: boolean, mipMapCount?: number,
     *   mode?: { width: number, height: number, bitCount: number },
     *   version?: 1 | 2 | 4 | 7 }} spec
     *   `mode` is the display mode a primary and its buffers are the screen in;
     *   `version` the generation a mipmap level was created through.
     * @returns {Surface}
     */
    function makeSurface(spec){
        let caps = spec.caps >>> 0;
        // The geometry is the creation's until SetSurfaceDesc hands the
        // surface memory of the program's own, of a size it names.
        let width = spec.width;
        let height = spec.height;
        let pixelFormat = spec.pixelFormat;
        let bpp = bytesPerPixel(pixelFormat);
        let pitch = blockRowBytes(pixelFormat, width) ?? width * (bpp > 0 ? bpp : 1);
        let buffer = allocate(pitch * height);

        /** @type {Surface | null} */
        let flipNext = null;
        /** @type {Surface | null} */
        let flipPrev = null;
        /** True when the forward link was made by the runtime and is not the guest's to undo. */
        let flipImplicit = false;
        /** @type {Surface | null} */
        let depth = null;
        /** @type {Surface | null} */
        let mipNext = null;
        /** @type {Surface[]} */
        let faces = [];
        // A level below the top is the texture's storage and nothing more:
        // its palette and colour keys are the top level's.
        const sublevel = (spec.caps2 & DDSCAPS2_MIPMAPSUBLEVEL) !== 0;
        /** @type {Palette | null} */
        let palette = null;
        /** @type {Clipper | null} */
        let clipper = null;
        /** @type {{ area: Rect, readOnly: boolean }[]} */
        const locks = [];
        /** @type {number | null} */
        let dc = null;
        let lost = false;
        /** Colour keys by the DDCKEY flag that names them. @type {Map<number, ColorKey>} */
        const colorKeys = new Map();
        let uniqueness = 1;
        /** @type {Uint16Array | null} */
        let gammaRamp = null;
        let priority = 0;
        /**
         * Whether this surface can hold a priority: only a texture the
         * runtime manages has one, and only at its top level.
         */
        const priorityRefusal = ()=>{
            if ((caps & DDSCAPS_TEXTURE) === 0)
            {
                return DDERR_INVALIDOBJECT;
            }
            return (spec.caps2 & (DDSCAPS2_TEXTUREMANAGE | DDSCAPS2_D3DTEXTUREMANAGE)) === 0
                || sublevel
                ? DDERR_INVALIDPARAMS
                : DD_OK;
        };
        /** Whoever keeps a copy of these pixels hears that the guest's bytes changed. */
        const tellWritten = ()=>{
            for (const watcher of pixelWatchers)
            {
                watcher.written(surface);
            }
        };

        const life = counted(()=>{
            surfaces.delete(surface);
            // Releasing a surface sheds everything it holds: the palette set on
            // it, the clipper, the buffer behind it in the chain and any
            // attached depth buffer. A chain therefore collapses from its front
            // when the front's last reference goes.
            surface.setPalette(null);
            surface.setClipper(null);
            if (flipNext)
            {
                flipNext.setFlipPrev(null);
                flipNext.release();
                flipNext = null;
            }
            if (depth)
            {
                depth.release();
                depth = null;
            }
            if (mipNext)
            {
                mipNext.release();
                mipNext = null;
            }
            for (const face of faces)
            {
                face.release();
            }
            faces = [];
            if (spec.owner)
            {
                release(spec.owner);
            }
            if (gammaRamp && (caps & DDSCAPS_PRIMARYSURFACE) !== 0)
            {
                options.gamma?.set(surface, null);
            }
            // Whatever the surface holds now: a flip moves buffers between a
            // chain's members, and each member gives back the one it ends with.
            free(buffer);
        });

        const surface = {
            get refCount(){
                return life.count;
            },
            get destroyed(){
                return life.dead;
            },
            /** The DirectDraw object that made it, which an attached surface has too. */
            get directDraw(){
                return directDraw;
            },
            addRef: ()=>life.addRef(),
            release: ()=>life.release(),

            get caps(){
                return caps;
            },
            get caps2(){
                return spec.caps2;
            },
            get width(){
                return width;
            },
            get height(){
                return height;
            },
            get pitch(){
                return pitch;
            },
            get pixelFormat(){
                return pixelFormat;
            },
            get backBufferCount(){
                return spec.backBufferCount;
            },
            get mipMapCount(){
                return spec.mipMapCount ?? 0;
            },
            get mipNext(){
                return mipNext;
            },
            /** @param {Surface | null} next */
            setMipNext(next){
                mipNext = next;
            },
            /** @param {Surface[]} list */
            setFaces(list){
                faces = list;
            },
            get buffer(){
                return buffer;
            },
            get implicit(){
                return spec.implicit;
            },
            get palette(){
                return palette;
            },
            get clipper(){
                return clipper;
            },
            get bytesPerPixel(){
                return bpp;
            },
            get locked(){
                return locks.length > 0;
            },
            get dc(){
                return dc;
            },

            /**
             * A key is one colour. Without DDCKEY_COLORSPACE the high value
             * is not read at all; with it, a range is refused rather than
             * narrowed, because no device of the era keyed on one.
             *
             * @param {number} which  A DDCKEY flag, with DDCKEY_COLORSPACE or without.
             * @param {ColorKey | null} key  Null removes the key.
             */
            setColorKey(which, key){
                if (sublevel)
                {
                    return DDERR_NOTONMIPMAPSUBLEVEL;
                }
                const kind = which & ~DDCKEY_COLORSPACE;
                if (key === null)
                {
                    colorKeys.delete(kind);
                    return DD_OK;
                }
                if ((which & DDCKEY_COLORSPACE) !== 0 && key.low >>> 0 !== key.high >>> 0)
                {
                    return DDERR_NOCOLORKEYHW;
                }
                colorKeys.set(kind, { low: key.low >>> 0, high: key.low >>> 0 });
                return DD_OK;
            },

            /** @param {number} which */
            getColorKey(which){
                const key = colorKeys.get(which);
                return key ? { hr: DD_OK, key: { ...key } } : { hr: DDERR_NOCOLORKEY, key: null };
            },

            uniquenessValue(){
                return uniqueness;
            },

            /** Called by whatever wrote into the surface behind the program's back. */
            changeUniquenessValue(){
                uniqueness++;
                tellWritten();
            },

            /**
             * Brings the guest's bytes up to date with a copy kept elsewhere
             * -- a render target the GPU draws into -- before they are read
             * or partly overwritten. Null when nobody keeps one: the bytes
             * are the pixels already.
             *
             * @returns {Promise<void> | null}
             */
            pixelsCurrent(){
                const pending = [...pixelWatchers].map(watcher=>watcher.readBack(surface))
                    .filter(answer=>answer !== null);
                return pending.length === 0 ? null : Promise.all(pending).then(()=>undefined);
            },

            /**
             * What this surface shows may have changed. Only the visible
             * primary is worth telling anyone about: everything else is seen
             * through a blit or a flip onto it, which reports on its own.
             */
            present(){
                if ((caps & DDSCAPS_PRIMARYSURFACE) !== 0 && (caps & DDSCAPS_VISIBLE) !== 0)
                {
                    onPresent(surface, cooperativeWindow, exclusive());
                }
            },

            /**
             * A depth fill wrote this surface's depth bits.
             *
             * @param {Rect | null} rect  Null for all of it.
             * @param {number} value      The fill, in the surface's own depth bits.
             */
            depthFilled(rect, value){
                for (const watcher of depthFillWatchers)
                {
                    watcher(surface, rect, value);
                }
            },

            /**
             * A colour fill of this surface, to whoever keeps its pixels on the
             * GPU: true when one filled them there.
             *
             * @param {Rect | null} rect  Null for all of it.
             * @param {number} value      The fill, in the surface's own pixel format.
             */
            colorFilled(rect, value){
                return [...colorFillWatchers].some(watcher=>watcher(surface, rect, value));
            },

            /** @param {number} value */
            setBuffer(value){
                buffer = value;
            },
            /** @param {number} value */
            setCaps(value){
                caps = value >>> 0;
            },
            /** @param {Surface | null} previous */
            setFlipPrev(previous){
                flipPrev = previous;
            },
            get flipNext(){
                return flipNext;
            },
            get flipPrev(){
                return flipPrev;
            },
            /** @param {Surface | null} next @param {boolean} isImplicit */
            setFlipNext(next, isImplicit){
                flipNext = next;
                flipImplicit = isImplicit;
            },
            markLost(){
                lost = true;
            },

            isLost(){
                noticeDeactivation();
                return lost ? DDERR_SURFACELOST : DD_OK;
            },

            /**
             * Gives a lost surface its memory back -- not its contents, which
             * the program redraws -- with the surfaces created with it: a
             * flip chain's buffers and a texture's levels come back with the
             * surface they were made for, one attached later does not. Not
             * while the screen is another application's.
             */
            restore(){
                noticeDeactivation();
                if (!canBeLost(surface))
                {
                    return DD_OK;
                }
                if (screenWithheld())
                {
                    return DDERR_WRONGMODE;
                }
                if (spec.mode && !sameMode(spec.mode, displayMode))
                {
                    return DDERR_WRONGMODE;
                }
                lost = false;
                if (mipNext?.implicit)
                {
                    mipNext.restore();
                }
                if (flipNext && flipImplicit)
                {
                    flipNext.restore();
                }
                return DD_OK;
            },

            /**
             * Before DirectDraw 7 a level below the top holds a palette of its
             * own; from 7 on it takes the top level's and refuses one.
             *
             * @param {Palette | null} next
             */
            setPalette(next){
                if (sublevel && spec.version === 7)
                {
                    return DDERR_NOTONMIPMAPSUBLEVEL;
                }
                if (palette)
                {
                    if (caps & DDSCAPS_PRIMARYSURFACE)
                    {
                        palette.markPrimary(false);
                    }
                    palette.release();
                }
                palette = next;
                if (next)
                {
                    next.addRef();
                    if (caps & DDSCAPS_PRIMARYSURFACE)
                    {
                        next.markPrimary(true);
                    }
                    surface.present();
                }
                return DD_OK;
            },

            getPalette(){
                if (!palette)
                {
                    return { hr: DDERR_NOPALETTEATTACHED, palette: null };
                }
                palette.addRef();
                return { hr: DD_OK, palette };
            },

            /** @param {Clipper | null} next */
            setClipper(next){
                clipper?.release();
                clipper = next;
                next?.addRef();
                return DD_OK;
            },

            getClipper(){
                if (!clipper)
                {
                    return { hr: DDERR_NOCLIPPERATTACHED, clipper: null };
                }
                clipper.addRef();
                return { hr: DD_OK, clipper };
            },

            /**
             * @param {Rect | null} [rect]
             * @param {number} [flags]  DDLOCK; a read-only lock writes nothing when released.
             * @returns {{ hr: number, surfacePointer: number | null, pitch: number }}
             */
            lock(rect = null, flags = 0){
                // Every failure below leaves the surface pointer null. A caller
                // that ignores the return code and follows the pointer anyway
                // then faults instead of writing into a surface it does not own.
                const fail = /** @param {number} hr */ hr=>(
                    { hr, surfacePointer: null, pitch });
                noticeDeactivation();
                if (lost)
                {
                    return fail(DDERR_SURFACELOST);
                }
                // A held device context makes the surface busy for locking, but
                // not the other way round -- see getDC.
                if (dc !== null)
                {
                    return fail(DDERR_SURFACEBUSY);
                }
                const area = wholeSurface(rect, width, height);
                if (locks.some(held=>sameRect(held.area, area)))
                {
                    return fail(DDERR_SURFACEBUSY);
                }
                if (!rectIsValid(area, width, height)
                    && !acceptsMalformedLockRect(caps, spec.caps2))
                {
                    return fail(DDERR_INVALIDPARAMS);
                }
                locks.push({ area, readOnly: (flags & DDLOCK_READONLY) !== 0 });
                // The pointer names the rectangle's own top-left corner, and the
                // pitch does not change with it: a partial lock is a window onto
                // the same rows, not a buffer of its own.
                return {
                    hr: DD_OK,
                    surfacePointer: buffer + (area.top * pitch) + (area.left * bpp),
                    pitch,
                };
            },

            /** @param {Rect | null} [rect] */
            unlock(rect = null){
                if (locks.length === 0)
                {
                    return DDERR_NOTLOCKED;
                }
                // Unlocking without naming a rectangle releases the most recent
                // lock, which is the only reading that lets a nested pair of
                // Lock/Unlock calls unwind in the order they were made.
                const index = rect === null
                    ? locks.length - 1
                    : locks.findIndex(held=>sameRect(held.area, rect));
                if (index < 0)
                {
                    return DDERR_NOTLOCKED;
                }
                const [released] = locks.splice(index, 1);
                uniqueness++;
                if (!released.readOnly)
                {
                    tellWritten();
                }
                surface.present();
                return DD_OK;
            },

            /** @returns {{ hr: number, dc: number | null }} */
            getDC(){
                if (dc !== null)
                {
                    // The handle the caller passed in is left alone, which is
                    // what tells it apart from a call that succeeded: there is
                    // no second DC to hand back and none is invented.
                    return { hr: DDERR_DCALREADYCREATED, dc: null };
                }
                noticeDeactivation();
                if (lost)
                {
                    return { hr: DDERR_SURFACELOST, dc: null };
                }
                const made = createDc({
                    width: width,
                    height: height,
                    pitch,
                    bitCount: bpp * 8,
                    bits: buffer,
                    // The palette's own live array: a program that animates its
                    // palette while holding the DC draws in the new colours. A
                    // surface with none of its own draws in the primary's, the
                    // colours its pixels are shown in once blitted there.
                    palette: bpp === 1 ? (palette ?? primaryPalette())?.pixels ?? null : null,
                    format: pixelFormat.greenMask === 0x07e0 ? '565' : '555',
                });
                // No DC is a failure, and leaves the surface free: a DC
                // handed out as zero is never released, and every Lock after
                // it is DDERR_SURFACEBUSY.
                if (!made)
                {
                    return { hr: DDERR_CANTCREATEDC, dc: null };
                }
                dc = made;
                return { hr: DD_OK, dc };
            },

            /** @param {number} handle */
            releaseDC(handle){
                if (dc === null)
                {
                    return DDERR_NODC;
                }
                void handle;
                releaseDc(dc);
                dc = null;
                uniqueness++;
                tellWritten();
                surface.present();
                return DD_OK;
            },

            /** @param {Surface} other */
            addAttachedSurface(other){
                if (other === surface)
                {
                    return DDERR_CANNOTATTACHSURFACE;
                }
                if (flipNext === other || other.flipNext === surface || depth === other)
                {
                    return DDERR_SURFACEALREADYATTACHED;
                }
                if (other.caps & DDSCAPS_ZBUFFER)
                {
                    if (depth)
                    {
                        return DDERR_CANNOTATTACHSURFACE;
                    }
                    depth = other;
                    other.addRef();
                    return DD_OK;
                }
                // A flip chain is a line, so the surface doing the attaching
                // must not already have something behind it and the one being
                // attached must not already be behind something else.
                if (flipNext !== null || other.flipPrev !== null)
                {
                    return DDERR_CANNOTATTACHSURFACE;
                }
                if (other.width !== width || other.height !== height)
                {
                    return DDERR_CANNOTATTACHSURFACE;
                }
                flipNext = other;
                flipImplicit = false;
                other.setFlipPrev(surface);
                other.addRef();
                caps |= DDSCAPS_FLIP;
                other.setCaps(other.caps | DDSCAPS_FLIP);
                return DD_OK;
            },

            /**
             * Null detaches every surface this one attached. What the runtime
             * attached stays, as it does when named one at a time.
             *
             * @param {Surface | null} other
             */
            deleteAttachedSurface(other){
                if (other === null)
                {
                    if (depth)
                    {
                        surface.deleteAttachedSurface(depth);
                    }
                    // Each detach splices the next one up behind this surface.
                    let next = flipNext;
                    while (next !== null && surface.deleteAttachedSurface(next) === DD_OK)
                    {
                        next = flipNext;
                    }
                    return DD_OK;
                }
                if (depth === other)
                {
                    depth = null;
                    other.release();
                    return DD_OK;
                }
                if (mipNext === other)
                {
                    return DDERR_CANNOTDETACHSURFACE;
                }
                if (flipNext !== other)
                {
                    // Attached the other way round, or attached only by the
                    // closure of the loop, is still attached -- it just cannot
                    // be taken apart from this end.
                    if (other.flipNext === surface || (flipPrev !== null && chainHead() === other))
                    {
                        return DDERR_CANNOTDETACHSURFACE;
                    }
                    return DDERR_SURFACENOTATTACHED;
                }
                if (flipImplicit)
                {
                    return DDERR_CANNOTDETACHSURFACE;
                }
                // Splicing, not truncating: whatever was behind the detached
                // surface moves up to take its place, and the reference it held
                // on that successor transfers here rather than being retaken.
                const successor = other.flipNext;
                other.setFlipNext(null, false);
                other.setFlipPrev(null);
                flipNext = successor;
                successor?.setFlipPrev(surface);
                other.release();
                shedFlipCap(other);
                shedFlipCap(surface);
                return DD_OK;
            },

            /**
             * The first attached surface whose caps hold every bit asked for.
             * The last buffer of a flip chain counts the front as attached,
             * which is how a walk down the chain comes round again.
             *
             * @param {number} wanted   The DDSCAPS the caller is looking for.
             * @param {number} [wanted2]  DDSCAPS2, from the wider structure.
             * @returns {{ hr: number, surface: Surface | null }}
             */
            getAttachedSurface(wanted, wanted2 = 0){
                noticeDeactivation();
                if (lost)
                {
                    return { hr: DDERR_SURFACELOST, surface: null };
                }
                const next = flipNext ?? (flipPrev ? chainHead() : null);
                const found = [mipNext, next, depth, ...faces].find(candidate=>candidate !== null
                    && candidate !== surface
                    && (candidate.caps & wanted) === wanted >>> 0
                    && (candidate.caps2 & wanted2) === wanted2 >>> 0);
                if (!found)
                {
                    return { hr: DDERR_NOTFOUND, surface: null };
                }
                found.addRef();
                return { hr: DD_OK, surface: found };
            },

            /** @returns {Surface[]} */
            enumAttachedSurfaces(){
                /** @type {Surface[]} */
                const found = [];
                if (mipNext)
                {
                    found.push(mipNext);
                }
                if (flipNext)
                {
                    found.push(flipNext);
                }
                if (depth)
                {
                    found.push(depth);
                }
                found.push(...faces);
                return found;
            },

            /**
             * @param {Surface | null} [target]
             * @param {number} [flags]
             */
            flip(target = null, flags = 0){
                void flags;
                if (!(caps & DDSCAPS_FLIP) || flipNext === null || flipPrev !== null)
                {
                    return DDERR_NOTFLIPPABLE;
                }
                if (target !== null && (target === surface || !inChain(target)))
                {
                    return DDERR_NOTFLIPPABLE;
                }
                // A primary surface in video memory is the screen, and only the
                // exclusive owner of the screen may change what it shows. One
                // held in system memory is a copy and flips regardless.
                if ((caps & DDSCAPS_PRIMARYSURFACE) && !(caps & DDSCAPS_SYSTEMMEMORY)
                    && !exclusive())
                {
                    return DDERR_NOEXCLUSIVEMODE;
                }
                noticeDeactivation();
                if (lost)
                {
                    return DDERR_SURFACELOST;
                }
                if (target)
                {
                    const swapped = buffer;
                    buffer = target.buffer;
                    target.setBuffer(swapped);
                    surface.present();
                    return DD_OK;
                }
                const members = chainMembers();
                const first = members[0].buffer;
                for (let index = 0; index < members.length - 1; index++)
                {
                    members[index].setBuffer(members[index + 1].buffer);
                }
                members[members.length - 1].setBuffer(first);
                surface.present();
                return DD_OK;
            },

            /**
             * Puts the surface over memory the program owns, with a new size,
             * pitch or format if it names one. Only a system-memory surface
             * the runtime does not manage can be moved -- video memory and
             * the screen are not the program's to point elsewhere -- and that
             * is decided before the descriptor is read. The memory has to be
             * named every time: the call hands memory over, it does not
             * resize. The pitch is the program's word, checked only for being
             * a positive whole number of dwords. Everything else the surface
             * has -- keys, palette, attachments -- is kept.
             *
             * @param {SurfaceRequest} request
             * @param {number} flags  The call's own, which are reserved.
             */
            setSurfaceDesc(request, flags){
                if (flags !== 0)
                {
                    return DDERR_INVALIDPARAMS;
                }
                if ((caps & DDSCAPS_SYSTEMMEMORY) === 0 || (caps & DDSCAPS_PRIMARYSURFACE) !== 0
                    || (spec.caps2 & (DDSCAPS2_TEXTUREMANAGE | DDSCAPS2_D3DTEXTUREMANAGE)) !== 0)
                {
                    return DDERR_INVALIDSURFACETYPE;
                }
                const named = request.flags >>> 0;
                const has = (/** @type {number} */ flag)=>(named & flag) !== 0;
                if ((named & ~SETTABLE_FIELDS) !== 0 || !has(DDSD_LPSURFACE)
                    || (request.surfacePointer ?? 0) >>> 0 === 0)
                {
                    return DDERR_INVALIDPARAMS;
                }
                if (has(DDSD_CAPS) && request.caps !== 0)
                {
                    return DDERR_INVALIDCAPS;
                }
                const newPitch = (request.pitch ?? 0) | 0;
                if ((has(DDSD_HEIGHT) && !((request.height ?? 0) > 0))
                    || has(DDSD_WIDTH) !== has(DDSD_PITCH)
                    || (has(DDSD_WIDTH) && (!((request.width ?? 0) > 0) || newPitch <= 0
                        || (newPitch & 3) !== 0)))
                {
                    return DDERR_INVALIDPARAMS;
                }
                buffer = /** @type {number} */ (request.surfacePointer) >>> 0;
                if (has(DDSD_WIDTH))
                {
                    width = /** @type {number} */ (request.width);
                    pitch = newPitch;
                }
                if (has(DDSD_HEIGHT))
                {
                    height = /** @type {number} */ (request.height);
                }
                if (has(DDSD_PIXELFORMAT) && request.pixelFormat)
                {
                    pixelFormat = request.pixelFormat;
                    bpp = bytesPerPixel(pixelFormat);
                }
                uniqueness++;
                return DD_OK;
            },

            /**
             * The ramp a gamma control on this surface holds. Only the
             * primary's reaches the screen, and there it is the display's;
             * another surface's is kept and read back.
             */
            get gammaRamp(){
                return gammaRamp;
            },
            getGammaRamp(){
                return gammaRamp ? gammaRamp.slice() : identityRamp();
            },
            /** @param {ArrayLike<number>} ramp  Red, green and blue, 256 words each. */
            setGammaRamp(ramp){
                gammaRamp = Uint16Array.from({ length: GAMMA_WORDS }, (_, index)=>ramp[index] ?? 0);
                if ((caps & DDSCAPS_PRIMARYSURFACE) !== 0)
                {
                    const channel = GAMMA_WORDS / 3;
                    options.gamma?.set(surface, {
                        red: gammaRamp.subarray(0, channel),
                        green: gammaRamp.subarray(channel, channel * 2),
                        blue: gammaRamp.subarray(channel * 2),
                    });
                }
                return DD_OK;
            },

            /**
             * The priority the texture manager evicts by. Kept and read back;
             * nothing is evicted here, so it orders nothing.
             */
            getPriority(){
                const hr = priorityRefusal();
                return { hr, priority: hr === DD_OK ? priority : 0 };
            },
            /** @param {number} value */
            setPriority(value){
                const hr = priorityRefusal();
                if (hr === DD_OK)
                {
                    priority = value >>> 0;
                }
                return hr;
            },
        };

        /** @returns {Surface} the surface at the head of this one's flip chain */
        function chainHead(){
            let head = surface;
            while (head.flipPrev)
            {
                head = head.flipPrev;
            }
            return head;
        }

        /** @returns {Surface[]} the chain from its head, in flip order */
        function chainMembers(){
            const members = [chainHead()];
            let next = members[0].flipNext;
            while (next)
            {
                members.push(next);
                next = next.flipNext;
            }
            return members;
        }

        /** @param {Surface} candidate */
        function inChain(candidate){
            return chainMembers().includes(candidate);
        }

        /**
         * A surface with nothing attached in either direction is not part of a
         * chain any more and stops claiming to be flippable.
         *
         * @param {Surface} member
         */
        function shedFlipCap(member){
            if (member.flipNext === null && member.flipPrev === null)
            {
                member.setCaps(member.caps & ~DDSCAPS_FLIP);
            }
        }

        surfaces.add(surface);
        return surface;
    }

    /**
     * @param {SurfaceRequest | null} request
     * @param {{ version?: 1 | 2 | 4 | 7, outer?: number }} [callOptions]
     * @returns {{ hr: number, surface: Surface | null }}
     */
    function createSurface(request, callOptions = {}){
        const version = callOptions.version ?? 7;
        const generation = GENERATION_OF[version];

        // Order matters and is observable. Aggregation is refused before the
        // cooperative level is looked at, and the cooperative level before the
        // descriptor -- so a program that passed a malformed descriptor with no
        // cooperative level set never hears about the descriptor.
        if (callOptions.outer)
        {
            return { hr: CLASS_E_NOAGGREGATION, surface: null };
        }
        if (!levelSet)
        {
            return { hr: DDERR_NOCOOPERATIVELEVELSET, surface: null };
        }
        if (!request)
        {
            return { hr: DDERR_INVALIDPARAMS, surface: null };
        }

        const caps2 = request.caps2 ?? 0;
        const backBufferCount = request.backBufferCount ?? 0;
        const validity = validateSurfaceCaps({
            caps: request.caps,
            caps2,
            backBufferCount,
            hasBackBufferCount: (request.flags & DDSD_BACKBUFFERCOUNT) !== 0,
            hasMipMapCount: (request.flags & DDSD_MIPMAPCOUNT) !== 0,
            exclusive: exclusive(),
            version,
        });
        if (validity.hr !== DD_OK)
        {
            return { hr: validity.hr, surface: null };
        }

        const sizeHr = validateSurfaceSize({
            caps: request.caps,
            width: request.width ?? 0,
            height: request.height ?? 0,
            hasWidth: (request.flags & DDSD_WIDTH) !== 0,
            hasHeight: (request.flags & DDSD_HEIGHT) !== 0,
        });
        if (sizeHr !== DD_OK)
        {
            return { hr: sizeHr, surface: null };
        }
        const keys = /** @type {[number, ColorKey | undefined][]} */ ([
            [DDCKEY_SRCBLT, request.srcColorKey],
            [DDCKEY_DESTBLT, request.destColorKey],
        ]).filter(([, key])=>key !== undefined);
        // A descriptor's key is a colour space: one value is a key, a range
        // is the same refusal SetColorKey gives one under DDCKEY_COLORSPACE.
        if (keys.some(([, key])=>key && key.low >>> 0 !== key.high >>> 0))
        {
            return { hr: DDERR_NOCOLORKEYHW, surface: null };
        }

        // A primary surface is the size and format of the display mode,
        // whatever the caller wrote in the width, height and format fields.
        const primary = (request.caps & DDSCAPS_PRIMARYSURFACE) !== 0;
        const width = primary ? displayMode.width : (request.width ?? 0);
        const height = primary ? displayMode.height : (request.height ?? 0);
        const modeFormat = /** @type {import("./structs.js").PixelFormatFields} */ (
            pixelFormatForDepth(displayMode.bitCount));
        const depthRequest = (request.caps & DDSCAPS_ZBUFFER) !== 0
            && (request.flags & DDSD_ZBUFFERBITDEPTH) !== 0;
        // The descriptor's format counts only under DDSD_PIXELFORMAT: without it
        // the fields hold whatever the caller left there, zeroes as often as
        // not, and the surface is in the display mode's format.
        const named = (request.flags & DDSD_PIXELFORMAT) !== 0 ? request.pixelFormat : undefined;
        const pixelFormat = depthRequest
            ? depthFormatForDepth(request.zBufferBitDepth ?? 16)
            : (primary || !named ? modeFormat : named);
        const levels = mipLevelCount({
            caps: validity.caps,
            width,
            height,
            mipMapCount: (request.flags & DDSD_MIPMAPCOUNT) !== 0 ? request.mipMapCount ?? 0 : null,
            version,
        });
        if (levels === null)
        {
            return { hr: DDERR_INVALIDPARAMS, surface: null };
        }
        const owner = OWNING_GENERATIONS.has(generation) ? generation : null;
        if (owner)
        {
            addRef(owner);
        }

        // A primary is the screen in the mode it was made in, and its
        // buffers with it: in another mode it cannot be restored.
        const primaryMode = (validity.caps & DDSCAPS_PRIMARYSURFACE) !== 0
            ? { mode: { width: displayMode.width, height: displayMode.height,
                bitCount: displayMode.bitCount } }
            : {};
        // A cube map is its faces, the first of those asked for the one handed
        // back and the others attached to it, each with a mip chain of its own
        // and its own face's bit alone among DDSCAPS2_CUBEMAP_ALLFACES.
        const faceBits = (caps2 & DDSCAPS2_CUBEMAP) === 0 ? [0]
            : [0, 1, 2, 3, 4, 5].map(face=>DDSCAPS2_CUBEMAP_POSITIVEX << face)
                .filter(bit=>(caps2 & bit) !== 0);
        const capsOf = (/** @type {number} */ face)=>(faceBits[face] === 0 ? caps2
            : (caps2 & ~DDSCAPS2_CUBEMAP_ALLFACES) | faceBits[face]);
        /** @param {Surface} top @param {number} faceCaps2 */
        const attachLevels = (top, faceCaps2)=>{
            // Each level holds the one below it, so the chain goes with its top.
            let above = top;
            for (let index = 1; index < levels; index++)
            {
                const level = makeSurface({
                    caps: validity.caps,
                    caps2: faceCaps2 | DDSCAPS2_MIPMAPSUBLEVEL,
                    width: Math.max(1, width >>> index),
                    height: Math.max(1, height >>> index),
                    backBufferCount: 0,
                    pixelFormat,
                    owner: null,
                    implicit: true,
                    mipMapCount: levels - index,
                    version,
                });
                above.setMipNext(level);
                above = level;
            }
        };
        const front = makeSurface({
            caps: validity.caps,
            caps2: capsOf(0),
            width,
            height,
            backBufferCount: validity.flipChain ? backBufferCount : 0,
            pixelFormat,
            owner,
            implicit: false,
            mipMapCount: levels,
            ...primaryMode,
        });

        attachLevels(front, capsOf(0));
        front.setFaces(faceBits.slice(1).map((_, index)=>{
            const face = makeSurface({
                caps: validity.caps,
                caps2: capsOf(index + 1),
                width,
                height,
                backBufferCount: 0,
                pixelFormat,
                owner: null,
                implicit: true,
                mipMapCount: levels,
                version,
            });
            attachLevels(face, capsOf(index + 1));
            return face;
        }));

        if (validity.flipChain)
        {
            let previous = front;
            for (let index = 0; index < backBufferCount; index++)
            {
                const back = makeSurface({
                    caps: backBufferCaps(validity.caps, index === 0),
                    caps2,
                    width,
                    height,
                    // Only the front buffer knows how long the chain is; every
                    // buffer behind it reports zero.
                    backBufferCount: 0,
                    pixelFormat,
                    owner: null,
                    implicit: true,
                    ...primaryMode,
                });
                previous.setFlipNext(back, true);
                back.setFlipPrev(previous);
                previous = back;
            }
        }

        for (const [which, key] of keys)
        {
            front.setColorKey(which, key ?? null);
        }
        return { hr: DD_OK, surface: front };
    }

    const directDraw = {
        get destroyed(){
            return destroyed;
        },
        get cooperativeLevel(){
            return cooperativeLevel;
        },
        get cooperativeWindow(){
            return cooperativeWindow;
        },
        get surfaceCount(){
            return surfaces.size;
        },

        /**
         * @param {(surface: Surface, rect: Rect | null, value: number) => void} watcher
         * @returns {() => void} what stops it
         */
        watchDepthFills(watcher){
            depthFillWatchers.add(watcher);
            return ()=>{
                depthFillWatchers.delete(watcher);
            };
        },

        /**
         * @param {(surface: Surface, rect: Rect | null, value: number) => boolean} watcher
         * @returns {() => void} what stops it
         */
        watchColorFills(watcher){
            colorFillWatchers.add(watcher);
            return ()=>{
                colorFillWatchers.delete(watcher);
            };
        },

        /**
         * @param {PixelWatcher} watcher
         * @returns {() => void} what stops it
         */
        watchPixels(watcher){
            pixelWatchers.add(watcher);
            return ()=>{
                pixelWatchers.delete(watcher);
            };
        },

        /** @param {string} [generation] */
        refCount(generation = seed){
            return counts.get(generation) ?? 0;
        },
        /** @param {string} [generation] */
        addRef(generation = seed){
            return addRef(generation);
        },
        /** @param {string} [generation] */
        release(generation = seed){
            return release(generation);
        },
        queryInterface,
        legacyD3dGeneration: legacyD3dGenerationHeld,

        /**
         * @param {number} window
         * @param {number} flags
         */
        setCooperativeLevel(window, flags){
            // Taking the screen exclusively is what invalidates what is on it.
            // Giving it back does not: the surfaces stay valid until somebody
            // claims the screen again, which is the order a program observes.
            const takingExclusive = (flags & DDSCL_EXCLUSIVE) !== 0 && !exclusive();
            // A deactivation while the screen was held is settled before the
            // level changes, and one before it was taken is not this level's.
            noticeDeactivation();
            cooperativeLevel = flags >>> 0;
            cooperativeWindow = window;
            levelSet = true;
            if (takingExclusive)
            {
                loseVideoMemory();
            }
            return DD_OK;
        },

        /**
         * Whether the screen is this object's to draw on. Exclusive mode is
         * the screen held, lost while the application is not the active one
         * and held again once it is back; normal mode holds nothing to lose,
         * and hears only that another object holds the screen. A display
         * mode changed under a normal-mode object (DDERR_WRONGMODE) is not
         * answered: nothing here changes it behind a program's back.
         *
         * @param {{ heldElsewhere?: boolean }} [display]
         */
        testCooperativeLevel({ heldElsewhere = false } = {}){
            noticeDeactivation();
            if (exclusive())
            {
                return screenWithheld() ? DDERR_NOEXCLUSIVEMODE : DD_OK;
            }
            return heldElsewhere ? DDERR_EXCLUSIVEMODEALREADYSET : DD_OK;
        },

        createSurface,

        get displayMode(){
            return { ...displayMode };
        },

        /**
         * @param {number} width
         * @param {number} height
         * @param {number} bitCount
         * @param {number} [refreshRate]
         */
        setDisplayMode(width, height, bitCount, refreshRate = 0){
            // A zero extent is accepted and changes nothing: programs pass one
            // and expect success, and the mode they had is the mode they keep.
            // No cooperative level is needed to set a mode.
            if (!(width > 0) || !(height > 0))
            {
                return DD_OK;
            }
            if (pixelFormatForDepth(bitCount) === null)
            {
                return DDERR_INVALIDMODE;
            }
            changeDisplayMode({ width, height, bitCount, refreshRate });
            return DD_OK;
        },

        restoreDisplayMode(){
            changeDisplayMode({ ...nativeMode });
            return DD_OK;
        },

        /**
         * @param {number} paletteCaps
         * @param {number[]} entries
         * @param {{ version?: 1 | 2 | 4 | 7, outer?: number }} [callOptions]
         */
        createPalette(paletteCaps, entries, callOptions = {}){
            if (callOptions.outer)
            {
                return { hr: CLASS_E_NOAGGREGATION, palette: null };
            }
            if (!levelSet)
            {
                return { hr: DDERR_NOCOOPERATIVELEVELSET, palette: null };
            }
            const generation = GENERATION_OF[callOptions.version ?? 7];
            const owner = OWNING_GENERATIONS.has(generation) ? generation : null;
            if (owner)
            {
                addRef(owner);
            }
            return { hr: DD_OK, palette: makePalette(paletteCaps, entries, owner) };
        },

        /**
         * A clipper is the one child that does not tie itself to the object
         * that made it: DirectDraw can hand one out with no ddraw object at
         * all, so making one here takes no reference either.
         *
         * @param {number} flags
         * @param {{ outer?: number }} [callOptions]
         */
        createClipper(flags, callOptions = {}){
            void flags;
            if (callOptions.outer)
            {
                return { hr: CLASS_E_NOAGGREGATION, clipper: null };
            }
            return { hr: DD_OK, clipper: makeClipper() };
        },

        restoreAllSurfaces(){
            noticeDeactivation();
            if (screenWithheld())
            {
                return DDERR_WRONGMODE;
            }
            // Every surface that can come back does; the first that cannot
            // is what the program is told, so it does not take a lost
            // primary for a restored one.
            let answer = DD_OK;
            for (const surface of surfaces)
            {
                const hr = surface.restore();
                answer = answer === DD_OK ? hr : answer;
            }
            return answer;
        },

        /**
         * Storage from the same allocator surfaces come from, for a sibling
         * API whose objects live beside them: a Direct3D vertex buffer is a
         * guest allocation exactly as a surface is.
         *
         * @param {number} bytes
         */
        allocateStorage(bytes){
            return allocate(bytes);
        },

        /** @param {number} address  What allocateStorage handed out. */
        freeStorage(address){
            free(address);
        },

        /** @returns {Surface[]} every surface alive, in creation order */
        allSurfaces(){
            return [...surfaces];
        },

        /** @returns {Surface | null} the primary surface, if a program has made one */
        primarySurface(){
            for (const surface of surfaces)
            {
                if ((surface.caps & DDSCAPS_PRIMARYSURFACE) !== 0)
                {
                    return surface;
                }
            }
            return null;
        },

        /** @param {number} handle @returns {Surface | null} the surface a DC was taken on */
        surfaceWithDc(handle){
            for (const surface of surfaces)
            {
                if (surface.dc === (handle >>> 0))
                {
                    return surface;
                }
            }
            return null;
        },
    };
    return directDraw;
}
