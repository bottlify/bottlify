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
    DDERR_DCALREADYCREATED,
    DDERR_CLIPPERISUSINGHWND,
    DDERR_INVALIDMODE,
    DDERR_INVALIDPARAMS,
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
    DDERR_SURFACEALREADYATTACHED,
    DDERR_SURFACEBUSY,
    DDERR_SURFACELOST,
    DDERR_SURFACENOTATTACHED,
    DDPCAPS_1BIT,
    DDPCAPS_2BIT,
    DDPCAPS_4BIT,
    DDPCAPS_PRIMARYSURFACE,
    DDPF_PALETTEINDEXED8,
    DDPF_RGB,
    DDPF_ZBUFFER,
    DDSCAPS_FLIP,
    DDSCAPS_PRIMARYSURFACE,
    DDSCAPS_SYSTEMMEMORY,
    DDSCAPS_VISIBLE,
    DDSCAPS_ZBUFFER,
    DDSCL_EXCLUSIVE,
    DDSD_BACKBUFFERCOUNT,
    DDSD_HEIGHT,
    DDSD_WIDTH,
    DDSD_ZBUFFERBITDEPTH,
    DD_OK,
    E_NOINTERFACE,
} from './constants.js';
import {
    acceptsMalformedLockRect,
    backBufferCaps,
    validateSurfaceCaps,
    validateSurfaceSize,
} from './caps.js';
import { bytesPerPixel } from './structs.js';

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
 * @property {number} [zBufferBitDepth]  dwZBufferBitDepth, in the older layout.
 * @property {import("./structs.js").PixelFormatFields} [pixelFormat]
 * @property {ColorKey} [srcColorKey]   ddckCKSrcBlt, when DDSD_CKSRCBLT names it.
 * @property {ColorKey} [destColorKey]  ddckCKDestBlt, when DDSD_CKDESTBLT names it.
 */

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
 * @property {() => number} addRef
 * @property {() => number} release
 * @property {number} caps
 * @property {number} caps2
 * @property {number} width
 * @property {number} height
 * @property {number} pitch
 * @property {import("./structs.js").PixelFormatFields} pixelFormat
 * @property {number} backBufferCount
 * @property {number} buffer          The pixels this surface currently shows.
 * @property {boolean} implicit       Created as part of a complex surface.
 * @property {Palette | null} palette
 * @property {Clipper | null} clipper
 * @property {number} bytesPerPixel
 * @property {boolean} locked
 * @property {number | null} dc
 * @property {() => void} present
 * @property {(rect: Rect | null, value: number) => void} depthFilled
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
 * @property {(rect?: Rect | null) => LockResult} lock
 * @property {(rect?: Rect | null) => number} unlock
 * @property {() => { hr: number, dc: number | null }} getDC
 * @property {(handle: number) => number} releaseDC
 * @property {(other: Surface) => number} addAttachedSurface
 * @property {(other: Surface | null) => number} deleteAttachedSurface
 * @property {(wanted: number, wanted2?: number) => { hr: number, surface: Surface | null }}
 *           getAttachedSurface
 * @property {() => Surface[]} enumAttachedSurfaces
 * @property {(target?: Surface | null, flags?: number) => number} flip
 */

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
 * @property {(attributes: DcAttributes) => number} [createDc]
 *           A device context handle for GetDC, over the surface's own pixels.
 *           This layer records that one was handed out and nothing more --
 *           what a DC *is* belongs to gdi, which is told where the pixels are.
 * @property {(handle: number) => void} [releaseDc]
 *           The other end of `createDc`.
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
        return {
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
     *   owner: string | null, implicit: boolean }} spec
     * @returns {Surface}
     */
    function makeSurface(spec){
        let caps = spec.caps >>> 0;
        const bpp = bytesPerPixel(spec.pixelFormat);
        const pitch = spec.width * (bpp > 0 ? bpp : 1);
        let buffer = allocate(pitch * spec.height);

        /** @type {Surface | null} */
        let flipNext = null;
        /** @type {Surface | null} */
        let flipPrev = null;
        /** True when the forward link was made by the runtime and is not the guest's to undo. */
        let flipImplicit = false;
        /** @type {Surface | null} */
        let depth = null;
        /** @type {Palette | null} */
        let palette = null;
        /** @type {Clipper | null} */
        let clipper = null;
        /** @type {Rect[]} */
        const locks = [];
        /** @type {number | null} */
        let dc = null;
        let lost = false;
        /** Colour keys by the DDCKEY flag that names them. @type {Map<number, ColorKey>} */
        const colorKeys = new Map();
        let uniqueness = 1;

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
            if (spec.owner)
            {
                release(spec.owner);
            }
        });

        const surface = {
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
            get caps2(){
                return spec.caps2;
            },
            width: spec.width,
            height: spec.height,
            pitch,
            pixelFormat: spec.pixelFormat,
            get backBufferCount(){
                return spec.backBufferCount;
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
                return lost ? DDERR_SURFACELOST : DD_OK;
            },

            restore(){
                lost = false;
                return DD_OK;
            },

            /** @param {Palette | null} next */
            setPalette(next){
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
             * @returns {{ hr: number, surfacePointer: number | null, pitch: number }}
             */
            lock(rect = null){
                // Every failure below leaves the surface pointer null. A caller
                // that ignores the return code and follows the pointer anyway
                // then faults instead of writing into a surface it does not own.
                const fail = /** @param {number} hr */ hr=>(
                    { hr, surfacePointer: null, pitch });
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
                const area = wholeSurface(rect, spec.width, spec.height);
                if (locks.some(held=>sameRect(held, area)))
                {
                    return fail(DDERR_SURFACEBUSY);
                }
                if (!rectIsValid(area, spec.width, spec.height)
                    && !acceptsMalformedLockRect(caps, spec.caps2))
                {
                    return fail(DDERR_INVALIDPARAMS);
                }
                locks.push(area);
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
                    : locks.findIndex(held=>sameRect(held, rect));
                if (index < 0)
                {
                    return DDERR_NOTLOCKED;
                }
                locks.splice(index, 1);
                uniqueness++;
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
                if (lost)
                {
                    return { hr: DDERR_SURFACELOST, dc: null };
                }
                dc = createDc({
                    width: spec.width,
                    height: spec.height,
                    pitch,
                    bitCount: bpp * 8,
                    bits: buffer,
                    // The palette's own live array: a program that animates its
                    // palette while holding the DC draws in the new colours. A
                    // surface with none of its own draws in the primary's, the
                    // colours its pixels are shown in once blitted there.
                    palette: bpp === 1 ? (palette ?? primaryPalette())?.pixels ?? null : null,
                    format: spec.pixelFormat.greenMask === 0x07e0 ? '565' : '555',
                });
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
                if (other.width !== spec.width || other.height !== spec.height)
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
                const next = flipNext ?? (flipPrev ? chainHead() : null);
                const found = [next, depth].find(candidate=>candidate !== null
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
                if (flipNext)
                {
                    found.push(flipNext);
                }
                if (depth)
                {
                    found.push(depth);
                }
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
        const pixelFormat = depthRequest
            ? depthFormatForDepth(request.zBufferBitDepth ?? 16)
            : (primary || !request.pixelFormat ? modeFormat : request.pixelFormat);
        const owner = OWNING_GENERATIONS.has(generation) ? generation : null;
        if (owner)
        {
            addRef(owner);
        }

        const front = makeSurface({
            caps: validity.caps,
            caps2,
            width,
            height,
            backBufferCount: validity.flipChain ? backBufferCount : 0,
            pixelFormat,
            owner,
            implicit: false,
        });

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

    return {
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

        /**
         * @param {number} window
         * @param {number} flags
         */
        setCooperativeLevel(window, flags){
            // Taking the screen exclusively is what invalidates what is on it.
            // Giving it back does not: the surfaces stay valid until somebody
            // claims the screen again, which is the order a program observes.
            const takingExclusive = (flags & DDSCL_EXCLUSIVE) !== 0 && !exclusive();
            cooperativeLevel = flags >>> 0;
            cooperativeWindow = window;
            levelSet = true;
            if (takingExclusive)
            {
                for (const surface of surfaces)
                {
                    surface.markLost();
                }
            }
            return DD_OK;
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
            displayMode = { width, height, bitCount, refreshRate };
            return DD_OK;
        },

        restoreDisplayMode(){
            displayMode = { ...nativeMode };
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
            for (const surface of surfaces)
            {
                surface.restore();
            }
            return DD_OK;
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
}
