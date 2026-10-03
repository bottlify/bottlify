/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * DirectDraw, between a guest call and the object that implements it.
 *
 * As with `d3d8.js`, everything here is translation: a slot reads the words
 * the guest pushed, turns pointers into structures and interface pointers into
 * objects, calls the method `ddraw/` already has, and writes back whatever the
 * caller left room for. Two things make this seam larger than that one:
 *
 * - **Four generations of one object, five of another.** A program written
 *   against IDirectDraw2 and one written against IDirectDraw7 call the same
 *   method by different slot numbers, hand over descriptors of different
 *   sizes, and are owed different reference-counting. The tables in
 *   `vtables.js` settle the slots; the version threaded through every method
 *   here settles the rest, so a CreateSurface through the second generation
 *   takes no reference on the object and a Lock through the fourth reads the
 *   longer descriptor.
 * - **Pixels move.** A blit copies guest memory to guest memory, a lock hands
 *   out an address into it, and a device context on a surface has to be one
 *   GDI can draw through -- which is why this seam is handed a way to make one
 *   over a given address and a way to say the screen has changed, and does
 *   neither itself.
 *
 * The reference counts are the one place the seam adds a fact of its own.
 * The bridge names the interface an AddRef, Release or QueryInterface is for
 * by its identifier; the object model names a generation. The map between
 * the two lives here, and the object handed to the publisher is a facade over
 * the model that applies it -- so a reference taken through IDirectDraw7 lands
 * in IDirectDraw7's count and nowhere else.
 *
 * The three enumerations call back into guest code once per item. They are
 * asynchronous -- a call into the guest is -- and answer with a promise the
 * bridge suspends the caller on. Without a way to call the guest they report
 * success having named nothing, which is what a program with nothing to
 * enumerate would see, and is said so where each of them lives.
 */

import {
    describe, IDIRECTDRAW7_SLOTS, IDIRECTDRAW4_SLOTS, IDIRECTDRAW2_SLOTS, IDIRECTDRAW_SLOTS,
    IDIRECTDRAWSURFACE7_SLOTS, IDIRECTDRAWSURFACE4_SLOTS, IDIRECTDRAWSURFACE3_SLOTS,
    IDIRECTDRAWSURFACE2_SLOTS, IDIRECTDRAWSURFACE_SLOTS, IDIRECTDRAWPALETTE_SLOTS,
    IDIRECTDRAWCLIPPER_SLOTS,
} from './vtables.js';
import { IDIRECTDRAWGAMMACONTROL_SLOTS } from './vtables-ddraw.js';
import {
    IID_IDirectDraw, IID_IDirectDraw2, IID_IDirectDraw4, IID_IDirectDraw7,
    IID_IDirectDrawSurface, IID_IDirectDrawSurface2, IID_IDirectDrawSurface3,
    IID_IDirectDrawSurface4, IID_IDirectDrawSurface7, IID_IDirectDrawPalette,
    IID_IDirectDrawClipper, IID_IDirectDrawGammaControl, IID_IDirect3D, IID_IDirect3D2,
    IID_IDirect3D3,
} from './iids.js';
import {
    DDBLTFX, DDCAPS, DDCAPS_SIZES, DDCOLORKEY, DDSCAPS2, RECT, createFields,
} from './structs.js';
import {
    DDDEVICEIDENTIFIER2, DDSURFACEDESC, DDSURFACEDESC2, MAX_DDDEVICEID_STRING, bytesPerPixel,
    readSurfaceDesc, writePixelFormat, writeSurfaceDesc,
} from '../ddraw/structs.js';
import {
    DDBLTFAST_DESTCOLORKEY, DDBLTFAST_SRCCOLORKEY, DDBLT_DEPTHFILL, DDBLT_KEYDESTOVERRIDE,
    DDBLT_KEYSRCOVERRIDE, DDPF_ZBUFFER, DDCAPS2_CANRENDERWINDOWED, DDCAPS2_CERTIFIED,
    DDCAPS2_PRIMARYGAMMA,
    DDCAPS2_WIDESURFACES, DDCAPS_3D, DDCAPS_BLT, DDCAPS_BLTCOLORFILL, DDCAPS_BLTDEPTHFILL,
    DDCAPS_BLTSTRETCH, DDCAPS_CANBLTSYSMEM,
    DDCAPS_COLORKEY, DDCAPS_GDI, DDCAPS_PALETTE, DDCKEYCAPS_DESTBLT, DDCKEYCAPS_SRCBLT,
    DDCKEY_DESTBLT, DDCKEY_SRCBLT, DDERR_ALREADYINITIALIZED, DDERR_INVALIDPARAMS,
    DDERR_NOTAOVERLAYSURFACE, DDERR_NOTFLIPPABLE, DDERR_NOTFOUND, DDERR_SURFACEBUSY,
    DDERR_SURFACELOST, DDERR_UNSUPPORTED, DDPCAPS_1BIT, DDPCAPS_2BIT, DDPCAPS_4BIT,
    DDPCAPS_8BIT, DDPCAPS_ALLOW256,
    DDPCAPS_PRIMARYSURFACE, DDPF_RGB, DDSCAPS_3DDEVICE, DDSCAPS_BACKBUFFER, DDSCAPS_COMPLEX,
    DDSCAPS_FLIP, DDSCAPS_FRONTBUFFER, DDSCAPS_LOCALVIDMEM, DDSCAPS_MIPMAP, DDSCAPS_OFFSCREENPLAIN,
    DDSCAPS_PRIMARYSURFACE, DDSCAPS_SYSTEMMEMORY, DDSCAPS_TEXTURE, DDSCAPS_VIDEOMEMORY,
    DDSCAPS_ZBUFFER, DDSCL_EXCLUSIVE, DDSCL_FULLSCREEN, DDSD_BACKBUFFERCOUNT,
    DDSD_CAPS, DDSD_CKDESTBLT, DDSD_CKSRCBLT, DDSD_HEIGHT, DDSD_MIPMAPCOUNT, DDSD_PITCH,
    DDSD_PIXELFORMAT, DDSD_REFRESHRATE, DDSD_WIDTH, DD_OK, DDGDI_GETHOSTIDENTIFIER,
} from '../ddraw/constants.js';
import { DDBD_16, DDBD_32 } from '../d3d7/constants.js';
import { pixelFormatForDepth } from '../ddraw/objects.js';
import { blt, bltFast } from '../ddraw/blit.js';
import { ADAPTER_GUID, describeAdapter } from './adapter.js';
import { createRaster } from './raster.js';
import { DDRAW_PRIVATE_DATA, createPrivateData } from './privatedata.js';
import { REFRESH_HZ, displayModes } from '../../win32/user32/display.js';

/** The classes DDRAW.dll's DllGetClassObject makes. */
const CLSID_DirectDraw = '{D7B70EE0-4340-11CF-B063-0020AFC2CD35}';
const CLSID_DirectDraw7 = '{3C305196-50DB-11D3-9CFE-00C04FD930C5}';
const IID_IUnknown = '{00000000-0000-0000-C000-000000000046}';
const IID_IClassFactory = '{00000001-0000-0000-C000-000000000046}';
/** IClassFactory, after IUnknown's three. */
const ICLASSFACTORY_SLOTS = /** @type {[string, number][]} */ ([
    ['CreateInstance', 3],
    ['LockServer', 1],
]);
const E_POINTER = 0x80004003 | 0;
const E_NOINTERFACE = 0x80004002 | 0;
const E_OUTOFMEMORY = 0x8007000e | 0;
const CLASS_E_NOAGGREGATION = 0x80040110 | 0;
const CLASS_E_CLASSNOTAVAILABLE = 0x80040111 | 0;

/** WaitForVerticalBlank: which edge of the blank to return at. */
const DDWAITVB_BLOCKBEGIN = 0x00000001;
const DDWAITVB_BLOCKBEGINEVENT = 0x00000002;
const DDWAITVB_BLOCKEND = 0x00000004;

/** The Direct3D 7 interface, whose count is IDirectDraw7's. */
const IID_IDirect3D7 = '{F5049E77-4861-11D2-A407-00A0C90629A8}';

/** The older Direct3D interfaces, which share the count of one earlier generation. */
const LEGACY_D3D_IIDS = Object.freeze(new Set([IID_IDirect3D, IID_IDirect3D2, IID_IDirect3D3]));

/** DDGAMMARAMP: red, green and blue, 256 words each. */
const DDGAMMARAMP_BYTES = 3 * 256 * 2;

/** A pointer argument the call could not use: the generic COM refusal. */
const E_INVALIDARG = 0x80070057;

/** What the caps report as video memory: a round number nothing here measures. */
const VIDEO_MEMORY = 256 << 20;

/** The surfaces CreateSurface builds and the places it puts them. */
const SURFACE_CAPS = (DDSCAPS_BACKBUFFER | DDSCAPS_COMPLEX | DDSCAPS_FLIP | DDSCAPS_FRONTBUFFER
    | DDSCAPS_OFFSCREENPLAIN | DDSCAPS_PRIMARYSURFACE | DDSCAPS_SYSTEMMEMORY | DDSCAPS_TEXTURE
    | DDSCAPS_3DDEVICE | DDSCAPS_VIDEOMEMORY | DDSCAPS_ZBUFFER | DDSCAPS_MIPMAP
    | DDSCAPS_LOCALVIDMEM) >>> 0;

/** What an enumeration callback answers to go on, and to stop. */
const DDENUMRET_CANCEL = 0;

/** DirectDrawEnumerateEx flags: which devices besides the primary to name. */
const DDENUM_KNOWN = 0x00000007;

/** EnumSurfaces flags: which surfaces the caller wants named. */
const DDENUMSURFACES_ALL = 0x00000001;
const DDENUMSURFACES_MATCH = 0x00000002;
const DDENUMSURFACES_NOMATCH = 0x00000004;

/** The depths a display mode can be set to; the sizes are the display's (user32/display.js). */
const DEPTHS = Object.freeze([8, 16, 32]);

/** RGNDATAHEADER: a size, a type that is always rectangles, a count, a byte size, a bound. */
const RGNDATAHEADER = Object.freeze({
    dwSize: 0x00,
    iType: 0x04,
    nCount: 0x08,
    nRgnSize: 0x0c,
    rcBound: 0x10,
    SIZE: 0x20,
});
const RDH_RECTANGLES = 1;

/**
 * Which generation an IDirectDraw version number names, and which surface
 * generation a surface made through it is handed back as. A program that asks
 * IDirectDraw2 for a surface gets IDirectDrawSurface (the first), not the
 * second: the two numberings never lined up.
 */
const GENERATIONS = Object.freeze({
    1: { id: IID_IDirectDraw, name: 'IDirectDraw', slots: IDIRECTDRAW_SLOTS,
        surface: IID_IDirectDrawSurface, layout: DDSURFACEDESC },
    2: { id: IID_IDirectDraw2, name: 'IDirectDraw2', slots: IDIRECTDRAW2_SLOTS,
        surface: IID_IDirectDrawSurface, layout: DDSURFACEDESC },
    4: { id: IID_IDirectDraw4, name: 'IDirectDraw4', slots: IDIRECTDRAW4_SLOTS,
        surface: IID_IDirectDrawSurface4, layout: DDSURFACEDESC2 },
    7: { id: IID_IDirectDraw7, name: 'IDirectDraw7', slots: IDIRECTDRAW7_SLOTS,
        surface: IID_IDirectDrawSurface7, layout: DDSURFACEDESC2 },
});

/** The surface generations, with the descriptor each takes and the ddraw interface it names. */
const SURFACE_GENERATIONS = Object.freeze([
    { id: IID_IDirectDrawSurface, slots: IDIRECTDRAWSURFACE_SLOTS, layout: DDSURFACEDESC,
        ddraw: 'IDirectDraw' },
    { id: IID_IDirectDrawSurface2, slots: IDIRECTDRAWSURFACE2_SLOTS, layout: DDSURFACEDESC,
        ddraw: 'IDirectDraw' },
    { id: IID_IDirectDrawSurface3, slots: IDIRECTDRAWSURFACE3_SLOTS, layout: DDSURFACEDESC,
        ddraw: 'IDirectDraw' },
    { id: IID_IDirectDrawSurface4, slots: IDIRECTDRAWSURFACE4_SLOTS, layout: DDSURFACEDESC2,
        ddraw: 'IDirectDraw4' },
    { id: IID_IDirectDrawSurface7, slots: IDIRECTDRAWSURFACE7_SLOTS, layout: DDSURFACEDESC2,
        ddraw: 'IDirectDraw7' },
]);

/**
 * A GUID as the braced string the interface tables are keyed by: three
 * little-endian integers and eight raw bytes, which is not a flat read.
 *
 * @param {any} memory
 * @param {number} address
 * @returns {string}
 */
export function readGuid(memory, address){
    const bytes = memory.readMemory(address >>> 0, 16);
    const hex = (/** @type {number} */ value, /** @type {number} */ width)=>
        value.toString(16).toUpperCase().padStart(width, '0');
    const data1 = (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
    const data2 = bytes[4] | (bytes[5] << 8);
    const data3 = bytes[6] | (bytes[7] << 8);
    const tail = [...bytes.slice(8)].map(byte=>hex(byte, 2)).join('');
    return `{${hex(data1, 8)}-${hex(data2, 4)}-${hex(data3, 4)}-`
        + `${tail.slice(0, 4)}-${tail.slice(4)}}`;
}

/**
 * The generation an interface identifier names, or null.
 *
 * @param {string} id
 * @returns {1 | 2 | 4 | 7 | null}
 */
export function versionOf(id){
    const found = /** @type {(1 | 2 | 4 | 7)[]} */ ([1, 2, 4, 7]).find(
        version=>GENERATIONS[version].id === id);
    return found ?? null;
}

/**
 * @typedef {Object} SurfaceDcServices
 *     How a device context over a surface's own pixels is made and unmade.
 *     GDI owns device contexts; this seam only knows where the pixels are.
 * @property {(attributes: import('../ddraw/objects.js').DcAttributes) => number} createSurfaceDc
 * @property {(handle: number) => void} deleteSurfaceDc
 */

/**
 * @typedef {Object} PresentedSurface
 *     What the primary surface shows, for whoever puts it on the screen.
 * @property {number} buffer     Guest address of row zero.
 * @property {number} width
 * @property {number} height
 * @property {number} pitch
 * @property {number} bitCount
 * @property {number[] | null} palette  256 PALETTEENTRY dwords when the surface is indexed.
 */

/**
 * @param {Object} deps
 * @param {any} deps.publisher    From createPublisher.
 * @param {any} deps.memory       readMemory/writeMemory.
 * @param {() => any} deps.screen The display this build is configured for.
 * @param {SurfaceDcServices} [deps.gdi]
 * @param {(surface: PresentedSurface, window: number, exclusive: boolean) => void}
 *     [deps.present]  Shows the primary, told whose window it is.
 * @param {() => Promise<void> | null} [deps.flipQueued]
 *     A flip queued a frame of the primary: what the call waits on before it
 *     answers, or null. Absent, a flip never waits.
 * @param {(call: { entry: number, args: number[], thread?: any })
 *          => Promise<number>} [deps.callGuest]
 * @param {() => any} [deps.currentThread]
 *        The bridge's way into guest code, for the enumerations.
 * @param {{ allocate: (bytes: number) => number }} [deps.scratch]
 *        Guest memory for the descriptor a callback is shown. One block is
 *        taken and reused: a descriptor is the callback's to read while it
 *        runs and nobody's afterwards.
 * @param {import('./com.js').InterfaceDescriptor[]} [deps.extraInterfaces]
 *        Interfaces other seams put on the DirectDraw object -- IDirect3D7 is
 *        reached by QueryInterface from it, not made by an entry point.
 * @param {import('./com.js').InterfaceDescriptor[]} [deps.extraSurfaceInterfaces]
 *        And on every surface: the texture interfaces of the Direct3D before
 *        the seventh, which a surface answers a QueryInterface for.
 * @param {() => number} [deps.now]  The clock the raster runs on, in milliseconds.
 * @param {(ms: number, run: () => void) => void} [deps.schedule]
 *        How a wait for the vertical blank is woken.
 * @param {() => import('./adapter.js').AdapterIdentity | null} [deps.identity]
 *        The hardware behind the display, as the assembling caller knows it.
 * @param {import('../webgpu/internal/presenter.js').DisplayGamma} [deps.gamma]
 *        Where a primary surface's gamma ramp reaches the picture.
 * @param {() => boolean} [deps.deactivated]
 *        Whether the application has been told it is not the active one.
 *        Absent, it always is.
 * @param {() => number} [deps.deactivations]
 *        How many times it has been told so: an exclusive owner loses its
 *        video memory each time.
 * @param {(width: number, height: number,
 *     where?: { window?: number, fullscreen?: boolean }) => void} [deps.resolution]
 *        The screen is this size now, and a fullscreen window is placed over it.
 */
export function createDirectDrawSeam(
    { publisher, memory, screen, gdi, present, flipQueued, callGuest, currentThread, scratch,
        extraInterfaces = [], extraSurfaceInterfaces = [], now = ()=>performance.now(),
        schedule = (ms, run)=>{
            setTimeout(run, ms);
        }, identity, gamma, deactivated, deactivations, resolution },
)
{
    const fields = createFields(memory);
    /**
     * The objects that took exclusive mode, for another one's
     * TestCooperativeLevel: the screen is one, whichever object holds it.
     *
     * @type {Set<any>}
     */
    const exclusiveHolders = new Set();

    const privateData = createPrivateData({ memory, publisher, rules: DDRAW_PRIVATE_DATA });

    /**
     * Objects CoCreateInstance made, which wait for Initialize as COM leaves them.
     *
     * @type {WeakSet<any>}
     */
    const uninitialized = new WeakSet();

    /** The raster of a DirectDraw object's display mode. @param {any} root */
    const rasterOf = root=>createRaster({
        now, refresh: ()=>REFRESH_HZ, height: ()=>root.displayMode.height,
    });

    /** @type {number} the descriptor block, taken on the first enumeration */
    let descriptorBlock = 0;
    const descriptorScratch = ()=>{
        if (descriptorBlock === 0 && scratch)
        {
            descriptorBlock = scratch.allocate(DDSURFACEDESC2.SIZE);
        }
        return descriptorBlock;
    };
    /** Whether an enumeration can reach the program at all. */
    const canEnumerate = ()=>callGuest !== undefined && descriptorScratch() !== 0;

    /** One facade per model, so one object is one identity. */
    /** @type {WeakMap<object, any>} */
    const facades = new WeakMap();
    /**
     * Every DirectDraw object made, for the export that finds a surface by
     * its DC without naming one.
     *
     * @type {Set<WeakRef<any>>}
     */
    const roots = new Set();

    /**
     * The model, with its counts addressed by interface identifier.
     *
     * A prototype rather than a copy: every method and getter the model has
     * stays reachable, and only the two that take a generation are replaced.
     * An identifier that names no generation -- IUnknown, say -- counts
     * against the generation the object was created as, which is what the
     * model does when told nothing.
     *
     * @param {any} root
     */
    const facadeOf = root=>{
        const existing = facades.get(root);
        if (existing)
        {
            return existing;
        }
        // Either an identifier or a generation name arrives here: the bridge
        // sends identifiers, and the sibling APIs name the generation they
        // share a count with. IDirect3D7 is IDirectDraw7's count; the older
        // Direct3D interfaces share the one the model binds them to.
        const generationOf = (/** @type {string | undefined} */ id)=>{
            if (id === undefined)
            {
                return undefined;
            }
            if (id === IID_IDirect3D7)
            {
                return GENERATIONS[7].name;
            }
            if (LEGACY_D3D_IIDS.has(id))
            {
                return root.legacyD3dGeneration();
            }
            const version = versionOf(id);
            if (version !== null)
            {
                return GENERATIONS[version].name;
            }
            return GENERATION_BY_NAME[id] ? id : undefined;
        };
        const facade = Object.create(root, {
            addRef: { value: (/** @type {string} */ id)=>root.addRef(generationOf(id)) },
            release: { value: (/** @type {string} */ id)=>root.release(generationOf(id)) },
        });
        facades.set(root, facade);
        roots.add(new WeakRef(root));
        return facade;
    };

    /**
     * The DirectDraw object that made a surface, as it was published -- a
     * back buffer or a mip level included, which no CreateSurface handed out.
     *
     * @param {any} surface
     */
    const ownerOf = surface=>(surface?.directDraw ? facadeOf(surface.directDraw) : null);

    /**
     * A RECT at an address. Typed loosely on purpose: the field reader answers
     * a record of dwords, and the four names are the rectangle.
     *
     * @param {number} address @returns {any}
     */
    const rectAt = address=>fields.readStruct(address >>> 0, RECT);

    /** @param {number} pointer @returns {import('../ddraw/objects.js').Rect | null} */
    const readRect = pointer=>((pointer >>> 0) === 0 ? null : rectAt(pointer));

    /** @param {number} pointer @returns {any} a low and a high value */
    const readColorKey = pointer=>fields.readStruct(pointer >>> 0, DDCOLORKEY);

    /**
     * A resource, published as whichever interface it is, with the reference
     * the out-parameter carries.
     *
     * @param {any} object
     * @param {import('./com.js').InterfaceDescriptor[]} interfaces
     * @param {string} id
     * @param {number} out
     */
    const handBack = (object, interfaces, id, out)=>{
        const pointer = publisher.publish(object, interfaces, id);
        fields.writeU32(out, pointer);
        return pointer;
    };

    // --- palette ---

    /** @param {number} caps @returns {number} how many entries such a palette holds */
    const paletteEntryCount = caps=>{
        if ((caps & DDPCAPS_1BIT) !== 0)
        {
            return 2;
        }
        if ((caps & DDPCAPS_2BIT) !== 0)
        {
            return 4;
        }
        if ((caps & DDPCAPS_4BIT) !== 0)
        {
            return 16;
        }
        return 256;
    };

    /** @param {number} pointer @param {number} count @returns {number[]} PALETTEENTRY dwords */
    const readEntries = (pointer, count)=>Array.from({ length: count },
        (_, index)=>fields.readU32((pointer >>> 0) + index * 4));

    const paletteInterfaces = [describe(IID_IDirectDrawPalette, IDIRECTDRAWPALETTE_SLOTS, {
        /** @param {any} palette @param {number[]} args */
        GetCaps: (palette, [out])=>{
            if ((out >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            fields.writeU32(out >>> 0, palette.caps);
            return DD_OK;
        },
        /** @param {any} palette @param {number[]} args */
        GetEntries: (palette, [, start, count, out])=>{
            if ((out >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            const got = palette.getEntries(start >>> 0, count >>> 0);
            if (got.hr !== DD_OK)
            {
                return got.hr;
            }
            got.entries.forEach((/** @type {number} */ entry, /** @type {number} */ index)=>{
                fields.writeU32((out >>> 0) + index * 4, entry);
            });
            return DD_OK;
        },
        Initialize: ()=>DDERR_ALREADYINITIALIZED,
        /** @param {any} palette @param {number[]} args */
        SetEntries: (palette, [, start, count, entries])=>((entries >>> 0) === 0
            ? DDERR_INVALIDPARAMS
            : palette.setEntries(start >>> 0, readEntries(entries, count >>> 0))),
    })];

    // --- clipper ---

    /**
     * A clip list travels as RGNDATA: a header and then the rectangles. Only
     * rectangle regions exist here, and a program that hands over any other
     * kind has handed over one this cannot read.
     *
     * @param {number} pointer
     * @returns {import('../ddraw/objects.js').Rect[] | null}
     */
    const readRegion = pointer=>{
        const at = pointer >>> 0;
        if (fields.readU32(at + RGNDATAHEADER.iType) !== RDH_RECTANGLES)
        {
            return null;
        }
        const count = fields.readU32(at + RGNDATAHEADER.nCount);
        return Array.from({ length: count },
            (_, index)=>rectAt(at + RGNDATAHEADER.SIZE + index * RECT.SIZE));
    };

    /**
     * @param {number} pointer
     * @param {import('../ddraw/objects.js').Rect[]} rects
     */
    const writeRegion = (pointer, rects)=>{
        const at = pointer >>> 0;
        const bound = rects.reduce((box, rect)=>({
            left: Math.min(box.left, rect.left),
            top: Math.min(box.top, rect.top),
            right: Math.max(box.right, rect.right),
            bottom: Math.max(box.bottom, rect.bottom),
        }), rects[0] ?? { left: 0, top: 0, right: 0, bottom: 0 });
        fields.writeU32(at + RGNDATAHEADER.dwSize, RGNDATAHEADER.SIZE);
        fields.writeU32(at + RGNDATAHEADER.iType, RDH_RECTANGLES);
        fields.writeU32(at + RGNDATAHEADER.nCount, rects.length);
        fields.writeU32(at + RGNDATAHEADER.nRgnSize, rects.length * RECT.SIZE);
        fields.writeStruct(at + RGNDATAHEADER.rcBound, RECT, bound);
        rects.forEach((rect, index)=>{
            fields.writeStruct(at + RGNDATAHEADER.SIZE + index * RECT.SIZE, RECT, rect);
        });
    };

    const clipperInterfaces = [describe(IID_IDirectDrawClipper, IDIRECTDRAWCLIPPER_SLOTS, {
        /**
         * A null region buffer asks how large one has to be; a size too small
         * for the list is answered the same way, with the size and no list.
         *
         * @param {any} clipper @param {number[]} args
         */
        GetClipList: (clipper, [rect, region, size])=>{
            if ((size >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            const bounds = readRect(rect);
            const rects = bounds
                ? clipper.clipList.filter((/** @type {any} */ item)=>
                    item.left < bounds.right && item.right > bounds.left
                        && item.top < bounds.bottom && item.bottom > bounds.top)
                : clipper.clipList;
            const needed = RGNDATAHEADER.SIZE + rects.length * RECT.SIZE;
            if ((region >>> 0) === 0 || fields.readU32(size >>> 0) < needed)
            {
                fields.writeU32(size >>> 0, needed);
                return (region >>> 0) === 0 ? DD_OK : DDERR_INVALIDPARAMS;
            }
            writeRegion(region, rects);
            fields.writeU32(size >>> 0, needed);
            return DD_OK;
        },
        /** @param {any} clipper @param {number[]} args */
        GetHWnd: (clipper, [out])=>{
            if ((out >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            fields.writeU32(out >>> 0, clipper.window);
            return DD_OK;
        },
        Initialize: ()=>DDERR_ALREADYINITIALIZED,
        /** @param {any} clipper @param {number[]} args */
        IsClipListChanged: (clipper, [out])=>{
            if ((out >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            fields.writeU32(out >>> 0, clipper.isClipListChanged() ? 1 : 0);
            return DD_OK;
        },
        /** @param {any} clipper @param {number[]} args */
        SetClipList: (clipper, [region])=>{
            if ((region >>> 0) === 0)
            {
                return clipper.setClipList([]);
            }
            const rects = readRegion(region);
            return rects === null ? DDERR_INVALIDPARAMS : clipper.setClipList(rects);
        },
        /** @param {any} clipper @param {number[]} args */
        SetHWnd: (clipper, [, window])=>clipper.setHWnd(window >>> 0),
    })];

    // --- surface ---

    /**
     * A key is compared on the colour a pixel shows: an RGB format's unused
     * bits take no part in it, and are copied with the rest of the pixel.
     *
     * @param {any} surface @returns {import('../ddraw/blit.js').BlitSurface}
     */
    const blitView = surface=>{
        const format = surface.pixelFormat;
        const colour = (format.flags & DDPF_RGB) !== 0
            ? (format.redMask | format.greenMask | format.blueMask) >>> 0
            : 0;
        return {
            buffer: surface.buffer,
            pitch: surface.pitch,
            width: surface.width,
            height: surface.height,
            bytesPerPixel: surface.bytesPerPixel,
            depth: (surface.caps & DDSCAPS_ZBUFFER) !== 0,
            // DDPIXELFORMAT keeps dwZBitMask where an RGB format keeps green.
            ...((format.flags & DDPF_ZBUFFER) !== 0 && format.greenMask !== 0
                ? { depthMask: format.greenMask >>> 0 }
                : {}),
            ...(colour !== 0 ? { keyMask: colour } : {}),
        };
    };

    /**
     * The colour keys a blit uses. A key named on the surface is the default;
     * an override flag takes the one in the effects structure instead.
     *
     * @param {any} surface @param {number} which DDCKEY
     * @param {boolean} override @param {number} fx address of a DDBLTFX, or zero
     * @param {number} offset the key's offset inside it
     */
    const keyFor = (surface, which, override, fx, offset)=>{
        if (override && (fx >>> 0) !== 0)
        {
            return readColorKey((fx >>> 0) + offset);
        }
        return surface.getColorKey(which).key ?? undefined;
    };

    /**
     * Exclusive full screen takes the cooperative window over the whole
     * display, as DirectDraw places it: at the origin, the mode's size. A
     * window left where the program made it offsets every rectangle the
     * program computes from it with ClientToScreen, and a blit to the primary
     * then falls off the screen.
     *
     * @param {any} root
     */
    const coverScreen = root=>{
        const both = DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN;
        if ((root.cooperativeLevel & both) === both && root.cooperativeWindow)
        {
            const mode = root.displayMode;
            resolution?.(mode.width, mode.height,
                { window: root.cooperativeWindow, fullscreen: true });
        }
    };

    /**
     * What every blit refuses before a pixel moves: a lost surface, a locked
     * one, and a depth this layer has no arithmetic for.
     *
     * @param {any} dest @param {any} source
     */
    const blitPreconditions = (dest, source)=>{
        for (const surface of source ? [dest, source] : [dest])
        {
            if (surface.isLost() !== DD_OK)
            {
                return DDERR_SURFACELOST;
            }
            if (surface.locked || surface.dc !== null)
            {
                return DDERR_SURFACEBUSY;
            }
            if (surface.bytesPerPixel === 3 || surface.bytesPerPixel === 0)
            {
                return DDERR_UNSUPPORTED;
            }
        }
        return DD_OK;
    };

    /**
     * Runs a call once every surface it reads has its pixels in guest memory:
     * a render target the GPU draws into has them there only once they are
     * read back, and the caller is parked until then. At once, and as a plain
     * answer, when nobody keeps a copy elsewhere.
     *
     * @param {any[]} surfaces @param {() => number} run
     * @returns {number | Promise<number>}
     */
    const whenCurrent = (surfaces, run)=>{
        const pending = surfaces.map(surface=>surface.pixelsCurrent())
            .filter(answer=>answer !== null);
        return pending.length === 0 ? run() : Promise.all(pending).then(run);
    };

    /** @param {any} surface @returns {import('../ddraw/objects.js').Rect[] | undefined} */
    const clipListOf = surface=>{
        const clipper = surface.clipper;
        return clipper && clipper.window === 0 && clipper.clipList.length > 0
            ? clipper.clipList
            : undefined;
    };

    /**
     * The descriptor a surface reports. Every field a surface has is marked
     * present, so a program that tests dwFlags before reading a field finds it.
     *
     * @param {any} surface
     * @param {number} [surfacePointer]
     */
    const descriptorOf = (surface, surfacePointer)=>{
        const srcColorKey = surface.getColorKey(DDCKEY_SRCBLT).key ?? undefined;
        const destColorKey = surface.getColorKey(DDCKEY_DESTBLT).key ?? undefined;
        return {
            flags: DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT | DDSD_PITCH | DDSD_PIXELFORMAT
                | (surface.backBufferCount > 0 ? DDSD_BACKBUFFERCOUNT : 0)
                | (surface.mipMapCount > 0 ? DDSD_MIPMAPCOUNT : 0)
                | (srcColorKey ? DDSD_CKSRCBLT : 0) | (destColorKey ? DDSD_CKDESTBLT : 0),
            srcColorKey,
            destColorKey,
            width: surface.width,
            height: surface.height,
            pitch: surface.pitch,
            backBufferCount: surface.backBufferCount,
            mipMapCount: surface.mipMapCount,
            caps: surface.caps,
            caps2: surface.caps2,
            pixelFormat: surface.pixelFormat,
            surfacePointer,
        };
    };

    /**
     * The methods of one surface generation.
     *
     * @param {typeof SURFACE_GENERATIONS[number]} generation
     */
    const surfaceMethods = generation=>{
        const layout = generation.layout;
        const wide = layout === DDSURFACEDESC2;

        /** @param {number} pointer DDSCAPS or DDSCAPS2, by generation */
        const readCaps = pointer=>fields.readU32((pointer >>> 0) + (wide ? DDSCAPS2.dwCaps : 0));

        return {
            ...privateData.methods,
            /** @param {any} surface @param {number[]} args */
            AddAttachedSurface: (surface, [other])=>{
                const attached = publisher.objectAt(other);
                return attached ? surface.addAttachedSurface(attached) : DDERR_INVALIDPARAMS;
            },

            /** @param {any} surface @param {number[]} args */
            Blt: (surface, [destRect, source, sourceRect, flags, fx])=>{
                const from = publisher.objectAt(source);
                const hr = blitPreconditions(surface, from);
                if (hr !== DD_OK)
                {
                    return hr;
                }
                // dwFillDepth shares dwFillColor's place in the structure.
                const fill = (fx >>> 0) === 0
                    ? 0
                    : fields.readU32((fx >>> 0) + DDBLTFX.dwFillColor);
                const rect = readRect(destRect);
                const request = {
                    memory,
                    destRect: rect,
                    srcRect: readRect(sourceRect),
                    flags: flags >>> 0,
                    fx: {
                        fillColor: fill,
                        fillDepth: fill,
                        srcColorKey: from
                            ? keyFor(from, DDCKEY_SRCBLT,
                                (flags & DDBLT_KEYSRCOVERRIDE) !== 0, fx, DDBLTFX.ddckSrcColorkey)
                            : undefined,
                        destColorKey: keyFor(surface, DDCKEY_DESTBLT,
                            (flags & DDBLT_KEYDESTOVERRIDE) !== 0, fx, DDBLTFX.ddckDestColorkey),
                    },
                    clipList: clipListOf(surface),
                };
                return whenCurrent(from ? [surface, from] : [surface], ()=>{
                    const outcome = blt({
                        ...request,
                        dest: blitView(surface),
                        src: from ? blitView(from) : undefined,
                    });
                    if (outcome === DD_OK)
                    {
                        surface.changeUniquenessValue();
                        surface.present();
                        if ((flags & DDBLT_DEPTHFILL) !== 0)
                        {
                            surface.depthFilled(rect, fill);
                        }
                    }
                    return outcome;
                });
            },

            /** @param {any} surface @param {number[]} args */
            BltFast: (surface, [x, y, source, sourceRect, flags])=>{
                const from = publisher.objectAt(source);
                if (!from)
                {
                    return DDERR_INVALIDPARAMS;
                }
                const hr = blitPreconditions(surface, from);
                if (hr !== DD_OK)
                {
                    return hr;
                }
                const request = {
                    memory,
                    x: x | 0,
                    y: y | 0,
                    srcRect: readRect(sourceRect),
                    flags: flags >>> 0,
                    srcColorKey: (flags & DDBLTFAST_SRCCOLORKEY) !== 0
                        ? from.getColorKey(DDCKEY_SRCBLT).key ?? undefined
                        : undefined,
                    destColorKey: (flags & DDBLTFAST_DESTCOLORKEY) !== 0
                        ? surface.getColorKey(DDCKEY_DESTBLT).key ?? undefined
                        : undefined,
                };
                return whenCurrent([surface, from], ()=>{
                    const outcome = bltFast({
                        ...request, dest: blitView(surface), src: blitView(from),
                    });
                    if (outcome === DD_OK)
                    {
                        surface.changeUniquenessValue();
                        surface.present();
                    }
                    return outcome;
                });
            },

            /** @param {any} surface @param {number[]} args */
            DeleteAttachedSurface: (surface, [, other])=>{
                if ((other >>> 0) === 0)
                {
                    return surface.deleteAttachedSurface(null);
                }
                const attached = publisher.objectAt(other);
                return attached ? surface.deleteAttachedSurface(attached) : DDERR_INVALIDPARAMS;
            },

            /**
             * Each attached surface is handed to the callback with a
             * reference of its own, which the program releases, and with its
             * descriptor written into the scratch block for the duration.
             *
             * @param {any} surface @param {number[]} args
             */
            EnumAttachedSurfaces: (surface, [context, callback])=>{
                if ((callback >>> 0) === 0)
                {
                    return DDERR_INVALIDPARAMS;
                }
                if (!canEnumerate())
                {
                    return DD_OK;
                }
                return enumerateSurfaces(surface.enumAttachedSurfaces(), generation,
                    callback >>> 0, context >>> 0);
            },

            /**
             * A flip is the end of a frame, and like a present it waits, once
             * the device is enough frames behind, for the oldest to finish.
             * Only the flip does: a blit or an unlock onto the primary is as
             * often one piece of a frame as the whole of it.
             *
             * @param {any} surface @param {number[]} args
             */
            Flip: (surface, [target, flags])=>{
                const hr = surface.flip(publisher.objectAt(target), flags >>> 0);
                const held = hr === DD_OK ? flipQueued?.() ?? null : null;
                return held ? held.then(()=>hr) : hr;
            },

            /** @param {any} surface @param {number[]} args */
            GetAttachedSurface: (surface, [caps, out])=>{
                if ((caps >>> 0) === 0 || (out >>> 0) === 0)
                {
                    return DDERR_INVALIDPARAMS;
                }
                const found = surface.getAttachedSurface(readCaps(caps),
                    wide ? fields.readU32((caps >>> 0) + DDSCAPS2.dwCaps2) : 0);
                if (found.hr === DD_OK)
                {
                    handBack(found.surface, surfaceInterfaces, generation.id, out >>> 0);
                }
                return found.hr;
            },

            GetBltStatus: ()=>DD_OK,

            /** @param {any} surface @param {number[]} args */
            GetCaps: (surface, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return DDERR_INVALIDPARAMS;
                }
                if (wide)
                {
                    fields.writeStruct(out >>> 0, DDSCAPS2, {
                        dwCaps: surface.caps, dwCaps2: surface.caps2, dwCaps3: 0, dwCaps4: 0,
                    });
                }
                else
                {
                    fields.writeU32(out >>> 0, surface.caps);
                }
                return DD_OK;
            },

            /** @param {any} surface @param {number[]} args */
            GetClipper: (surface, [out])=>{
                const got = surface.getClipper();
                if (got.hr === DD_OK && (out >>> 0) !== 0)
                {
                    handBack(got.clipper, clipperInterfaces, IID_IDirectDrawClipper, out >>> 0);
                }
                return got.hr;
            },

            /** @param {any} surface @param {number[]} args */
            GetColorKey: (surface, [which, out])=>{
                const got = surface.getColorKey(which >>> 0);
                if (got.hr === DD_OK && (out >>> 0) !== 0)
                {
                    fields.writeStruct(out >>> 0, DDCOLORKEY, got.key);
                }
                return got.hr;
            },

            /**
             * The handle is written only on success: a refused second GetDC
             * leaves the caller's variable exactly as it was.
             *
             * @param {any} surface @param {number[]} args
             */
            GetDC: (surface, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return DDERR_INVALIDPARAMS;
                }
                const got = surface.getDC();
                if (got.hr !== DD_OK)
                {
                    return got.hr;
                }
                return whenCurrent([surface], ()=>{
                    fields.writeU32(out >>> 0, got.dc);
                    return DD_OK;
                });
            },

            GetFlipStatus: ()=>DD_OK,

            /** @param {any} surface @param {number[]} args */
            GetPalette: (surface, [out])=>{
                const got = surface.getPalette();
                if (got.hr === DD_OK && (out >>> 0) !== 0)
                {
                    handBack(got.palette, paletteInterfaces, IID_IDirectDrawPalette, out >>> 0);
                }
                else if ((out >>> 0) !== 0)
                {
                    fields.writeU32(out >>> 0, 0);
                }
                return got.hr;
            },

            /** @param {any} surface @param {number[]} args */
            GetPixelFormat: (surface, [out])=>{
                if ((out >>> 0) === 0 || fields.readU32(out >>> 0) !== 0x20)
                {
                    return DDERR_INVALIDPARAMS;
                }
                writePixelFormat(memory, out >>> 0, surface.pixelFormat);
                return DD_OK;
            },

            /** @param {any} surface @param {number[]} args */
            GetSurfaceDesc: (surface, [out])=>{
                if ((out >>> 0) === 0 || fields.readU32(out >>> 0) !== layout.SIZE)
                {
                    return DDERR_INVALIDPARAMS;
                }
                writeSurfaceDesc(memory, out >>> 0, layout, descriptorOf(surface));
                return DD_OK;
            },

            Initialize: ()=>DDERR_ALREADYINITIALIZED,

            /** @param {any} surface */
            IsLost: (/** @type {any} */ surface)=>surface.isLost(),

            /**
             * The descriptor is written on success with the address of the
             * locked corner in lpSurface, and on failure with a null there:
             * a caller that follows the pointer without reading the code
             * then faults rather than writing into memory it does not own.
             *
             * @param {any} surface @param {number[]} args
             */
            Lock: (surface, [rect, desc, flags])=>{
                if ((desc >>> 0) === 0 || fields.readU32(desc >>> 0) !== layout.SIZE)
                {
                    return DDERR_INVALIDPARAMS;
                }
                const locked = surface.lock(readRect(rect), flags >>> 0);
                if (locked.hr === DDERR_SURFACELOST)
                {
                    // Refused before anything is written: the descriptor the
                    // program passed comes back as it went (Wine's ddraw7
                    // test_coop_level_d3d_state).
                    return locked.hr;
                }
                if (locked.hr !== DD_OK)
                {
                    fields.writeU32((desc >>> 0) + layout.lpSurface, 0);
                    return locked.hr;
                }
                writeSurfaceDesc(memory, desc >>> 0, layout,
                    descriptorOf(surface, locked.surfacePointer));
                return whenCurrent([surface], ()=>DD_OK);
            },

            /** @param {any} surface @param {number[]} args */
            ReleaseDC: (surface, [handle])=>surface.releaseDC(handle >>> 0),

            /** @param {any} surface */
            Restore: (/** @type {any} */ surface)=>surface.restore(),

            /** @param {any} surface @param {number[]} args */
            SetClipper: (surface, [clipper])=>surface.setClipper(publisher.objectAt(clipper)),

            /** @param {any} surface @param {number[]} args */
            SetColorKey: (surface, [which, key])=>surface.setColorKey(which >>> 0,
                (key >>> 0) === 0 ? null : readColorKey(key)),

            /** @param {any} surface @param {number[]} args */
            SetPalette: (surface, [palette])=>surface.setPalette(publisher.objectAt(palette)),

            // The older generations take the address the lock handed out, the
            // newer ones the rectangle; only a rectangle names which lock to
            // release, and the address form releases the latest one.
            /** @param {any} surface @param {number[]} args */
            Unlock: (surface, [argument])=>surface.unlock(wide ? readRect(argument) : null),

            /** @param {any} surface @param {number[]} args */
            GetDDInterface: (surface, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return DDERR_INVALIDPARAMS;
                }
                const root = ownerOf(surface);
                if (!root)
                {
                    return DDERR_INVALIDPARAMS;
                }
                const queried = root.queryInterface(generation.ddraw);
                if (queried.hr !== DD_OK)
                {
                    return queried.hr;
                }
                handBack(root, ddrawInterfaces, GENERATION_BY_NAME[generation.ddraw].id,
                    out >>> 0);
                return DD_OK;
            },

            PageLock: ()=>DD_OK,
            PageUnlock: ()=>DD_OK,

            // No surface is an overlay -- creating one is refused for want of
            // the hardware -- so every call that works on one is answered as
            // it is for any other surface, and the call that lists the
            // overlays over a surface lists none.
            UpdateOverlay: ()=>DDERR_NOTAOVERLAYSURFACE,
            GetOverlayPosition: ()=>DDERR_NOTAOVERLAYSURFACE,
            SetOverlayPosition: ()=>DDERR_NOTAOVERLAYSURFACE,
            UpdateOverlayZOrder: ()=>DDERR_NOTAOVERLAYSURFACE,
            UpdateOverlayDisplay: ()=>DDERR_NOTAOVERLAYSURFACE,
            /** @param {any} surface @param {number[]} args */
            EnumOverlayZOrders: (surface, [, , callback])=>((callback >>> 0) === 0
                ? DDERR_INVALIDPARAMS
                : DD_OK),

            /** @param {any} surface @param {number[]} args */
            SetPriority: (surface, [value])=>surface.setPriority(value >>> 0),

            /**
             * A refusal leaves the caller's variable as it was.
             *
             * @param {any} surface @param {number[]} args
             */
            GetPriority: (surface, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return DDERR_INVALIDPARAMS;
                }
                const got = surface.getPriority();
                if (got.hr === DD_OK)
                {
                    fields.writeU32(out >>> 0, got.priority);
                }
                return got.hr;
            },

            /** @param {any} surface @param {number[]} args */
            SetSurfaceDesc: (surface, [desc, flags])=>{
                const request = (desc >>> 0) === 0
                    ? null
                    : readSurfaceDesc(memory, desc >>> 0, layout);
                return request ? surface.setSurfaceDesc(request, flags >>> 0) : DDERR_INVALIDPARAMS;
            },

            /** @param {any} surface @param {number[]} args */
            GetUniquenessValue: (surface, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return DDERR_INVALIDPARAMS;
                }
                fields.writeU32(out >>> 0, surface.uniquenessValue());
                return DD_OK;
            },

            /** @param {any} surface */
            ChangeUniquenessValue: (/** @type {any} */ surface)=>{
                surface.changeUniquenessValue();
                return DD_OK;
            },
        };
    };

    /**
     * The gamma control a surface answers for: a DDGAMMARAMP, three channels
     * of 256 little-endian words, read and written whole. Both flags are
     * taken as the runtime takes them -- the calibration flag asks for a
     * calibrator there is none of -- so only a missing ramp is refused.
     */
    const gammaInterface = describe(IID_IDirectDrawGammaControl, IDIRECTDRAWGAMMACONTROL_SLOTS, {
        /** @param {any} surface @param {number[]} args */
        GetGammaRamp: (surface, [, out])=>{
            if ((out >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            const ramp = surface.getGammaRamp();
            memory.writeMemory(out >>> 0, new Uint8Array(ramp.buffer, ramp.byteOffset,
                ramp.byteLength));
            return DD_OK;
        },
        /** @param {any} surface @param {number[]} args */
        SetGammaRamp: (surface, [, ramp])=>{
            if ((ramp >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            const bytes = memory.readMemory(ramp >>> 0, DDGAMMARAMP_BYTES);
            return surface.setGammaRamp(new Uint16Array(bytes.slice().buffer));
        },
    });

    /** Every surface generation, so a QueryInterface across them succeeds. */
    const surfaceInterfaces = [
        ...SURFACE_GENERATIONS.map(generation=>
            describe(generation.id, generation.slots, surfaceMethods(generation), {},
                privateData.released)),
        gammaInterface,
        ...extraSurfaceInterfaces,
    ];

    /**
     * Names each surface to the callback in turn, stopping when it says so.
     *
     * @param {any[]} list
     * @param {{ id: string, layout: any }} generation  Which interface and descriptor to show.
     * @param {number} callback
     * @param {number} context
     */
    async function enumerateSurfaces(list, generation, callback, context){
        const call = /** @type {NonNullable<typeof callGuest>} */ (callGuest);
        // Whose call this is, before the loop awaits anything: only the first
        // callback of an enumeration runs on the thread standing here.
        const asked = currentThread?.();
        for (const surface of list)
        {
            surface.addRef();
            const pointer = publisher.publish(surface, surfaceInterfaces, generation.id);
            const desc = descriptorScratch();
            writeSurfaceDesc(memory, desc, generation.layout, descriptorOf(surface));
            const answer = await call({
                entry: callback, args: [pointer, desc, context], thread: asked,
            });
            if ((answer >>> 0) === DDENUMRET_CANCEL)
            {
                break;
            }
        }
        return DD_OK;
    }

    // --- the ddraw object ---

    /** @type {Record<string, typeof GENERATIONS[keyof typeof GENERATIONS]>} */
    const GENERATION_BY_NAME = Object.fromEntries(
        Object.values(GENERATIONS).map(generation=>[generation.name, generation]));

    /**
     * The capabilities this build reports, for the hardware and the emulation
     * layer alike: one backend answers as both, and a program that branches on
     * the difference finds none. 3D is among them -- DirectDraw carries
     * Direct3D 7, and a DirectX 7 program looks for DDCAPS_3D here before it
     * asks Direct3D anything -- with the depth fill Blt does and the depths of
     * the z-buffer formats Direct3D enumerates.
     *
     * @param {number} pointer
     */
    const writeCaps = pointer=>{
        const at = pointer >>> 0;
        const size = fields.readU32(at + DDCAPS.dwSize);
        if (!DDCAPS_SIZES.includes(size))
        {
            return DDERR_INVALIDPARAMS;
        }
        memory.writeMemory(at, new Uint8Array(size));
        fields.writeStruct(at, DDCAPS, {
            dwSize: size,
            dwCaps: (DDCAPS_3D | DDCAPS_BLT | DDCAPS_BLTSTRETCH | DDCAPS_BLTCOLORFILL
                | DDCAPS_BLTDEPTHFILL | DDCAPS_COLORKEY | DDCAPS_GDI | DDCAPS_PALETTE
                | DDCAPS_CANBLTSYSMEM) >>> 0,
            // A primary's gamma ramp is claimed where the display applies it.
            dwCaps2: DDCAPS2_CERTIFIED | DDCAPS2_WIDESURFACES | DDCAPS2_CANRENDERWINDOWED
                | (gamma?.applies() ? DDCAPS2_PRIMARYGAMMA : 0),
            dwCKeyCaps: DDCKEYCAPS_SRCBLT | DDCKEYCAPS_DESTBLT,
            dwPalCaps: DDPCAPS_8BIT | DDPCAPS_PRIMARYSURFACE | DDPCAPS_ALLOW256,
            dwZBufferBitDepths: DDBD_16 | DDBD_32,
            dwVidMemTotal: VIDEO_MEMORY,
            dwVidMemFree: VIDEO_MEMORY,
            ddsOldCaps: SURFACE_CAPS,
        });
        if (size >= DDCAPS.SIZE)
        {
            fields.writeU32(at + DDCAPS.ddsCaps, SURFACE_CAPS);
        }
        return DD_OK;
    };

    /**
     * DDDEVICEIDENTIFIER, or its second form with the WHQL level after it,
     * from what the assembling caller knows of the hardware -- the answer
     * Direct3D's adapter identifier gives, so a program asking both finds one
     * card. The driver is named as a DLL because that is what the field holds
     * on Windows and what a program parsing it looks for. Only the structure's
     * own bytes are written: rounded up to its alignment it would run four
     * bytes into whatever the caller keeps after it.
     *
     * @param {number} address @param {boolean} withWhql
     */
    const writeDeviceIdentifier = (address, withWhql)=>{
        const { vendorId, description } = describeAdapter(identity?.() ?? null);
        const block = new Uint8Array(withWhql
            ? DDDEVICEIDENTIFIER2.SIZE
            : DDDEVICEIDENTIFIER2.dwWHQLLevel);
        /** @param {string} text @param {number} at */
        const ascii = (text, at)=>{
            for (let index = 0; index < Math.min(text.length, MAX_DDDEVICEID_STRING - 1); index++)
            {
                block[at + index] = text.charCodeAt(index) & 0x7f;
            }
        };
        ascii('webgpu.dll', DDDEVICEIDENTIFIER2.szDriver);
        ascii(description, DDDEVICEIDENTIFIER2.szDescription);
        const view = new DataView(block.buffer);
        // Version 1.0.0.0: the product word is the LARGE_INTEGER's high dword.
        view.setUint32(DDDEVICEIDENTIFIER2.liDriverVersion + 4, 0x00010000, true);
        view.setUint32(DDDEVICEIDENTIFIER2.dwVendorId, vendorId, true);
        block.set(ADAPTER_GUID, DDDEVICEIDENTIFIER2.guidDeviceIdentifier);
        if (withWhql)
        {
            view.setUint32(DDDEVICEIDENTIFIER2.dwWHQLLevel, 1, true);
        }
        memory.writeMemory(address, block);
    };

    /**
     * The methods of one ddraw generation.
     *
     * @param {typeof GENERATIONS[keyof typeof GENERATIONS]} generation
     * @param {1 | 2 | 4 | 7} version
     */
    const ddrawMethods = (generation, version)=>({
        Compact: ()=>DD_OK,

        /** @param {any} root @param {number[]} args */
        CreateClipper: (root, [flags, out, outer])=>{
            if ((out >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            const made = root.createClipper(flags >>> 0, { outer: outer >>> 0 });
            if (made.hr === DD_OK)
            {
                handBack(made.clipper, clipperInterfaces, IID_IDirectDrawClipper, out >>> 0);
            }
            return made.hr;
        },

        /** @param {any} root @param {number[]} args */
        CreatePalette: (root, [flags, entries, out, outer])=>{
            if ((out >>> 0) === 0 || (entries >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            const made = root.createPalette(flags >>> 0,
                readEntries(entries, paletteEntryCount(flags >>> 0)),
                { version, outer: outer >>> 0 });
            if (made.hr === DD_OK)
            {
                handBack(made.palette, paletteInterfaces, IID_IDirectDrawPalette, out >>> 0);
            }
            return made.hr;
        },

        /**
         * The descriptor is read after the checks the object makes first:
         * a malformed one under no cooperative level is never mentioned,
         * which is why null is passed through rather than refused here.
         *
         * @param {any} root @param {number[]} args
         */
        CreateSurface: (root, [desc, out, outer])=>{
            if ((out >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            // The pointer is probed before anything is made: one the program
            // cannot write through is refused rather than written through
            // (Wine's ddraw test_surface_qi, every version).
            if (memory.writable && !memory.writable(out >>> 0, 4))
            {
                return E_INVALIDARG;
            }
            const request = (desc >>> 0) === 0
                ? null
                : readSurfaceDesc(memory, desc >>> 0, generation.layout);
            const made = root.createSurface(request, { version, outer: outer >>> 0 });
            if (made.hr !== DD_OK)
            {
                return made.hr;
            }
            handBack(made.surface, surfaceInterfaces, generation.surface, out >>> 0);
            return DD_OK;
        },

        /**
         * Every size the display lists, at every depth, and the screen's own size
         * if the table lacks it. Without a way into the guest this reports
         * success having named nothing.
         *
         * @param {any} root @param {number[]} args
         */
        EnumDisplayModes: (root, [, , context, callback])=>{
            if ((callback >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            if (!canEnumerate())
            {
                return DD_OK;
            }
            const call = /** @type {NonNullable<typeof callGuest>} */ (callGuest);
            // Whose call this is, before the loop awaits anything: only the
            // first callback of an enumeration runs on the thread standing here.
            const asked = currentThread?.();
            // The same sizes user32 and Direct3D list, each once whatever the
            // rates it is listed at there.
            const sizes = [...new Map(displayModes(screen())
                .map(mode=>[`${mode.width}x${mode.height}`, [mode.width, mode.height]])).values()];
            return (async()=>{
                for (const [width, height] of sizes)
                {
                    for (const depth of DEPTHS)
                    {
                        const pixelFormat =
                            /** @type {import('../ddraw/structs.js').PixelFormatFields} */ (
                                pixelFormatForDepth(depth));
                        const desc = descriptorScratch();
                        writeSurfaceDesc(memory, desc, generation.layout, {
                            flags: DDSD_WIDTH | DDSD_HEIGHT | DDSD_PITCH | DDSD_PIXELFORMAT
                                | DDSD_REFRESHRATE,
                            width,
                            height,
                            pitch: width * bytesPerPixel(pixelFormat),
                            backBufferCount: 0,
                            mipMapCount: 0,
                            caps: 0,
                            caps2: 0,
                            pixelFormat,
                        });
                        const answer = await call({ entry: callback >>> 0,
                            args: [desc, context >>> 0], thread: asked });
                        if ((answer >>> 0) === DDENUMRET_CANCEL)
                        {
                            return DD_OK;
                        }
                    }
                }
                return DD_OK;
            })();
        },

        /**
         * Every surface this object made, or those whose capabilities match
         * (or do not match) the ones described. Surfaces that could be created
         * but do not exist are not enumerated: there is no table of them.
         *
         * @param {any} root @param {number[]} args
         */
        EnumSurfaces: (root, [flags, desc, context, callback])=>{
            if ((callback >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            if (!canEnumerate())
            {
                return DD_OK;
            }
            const wanted = (desc >>> 0) === 0
                ? 0
                : (fields.readU32((desc >>> 0) + generation.layout.dwCaps) >>> 0);
            const matches = (/** @type {any} */ surface)=>(surface.caps & wanted) === wanted;
            const chosen = root.allSurfaces().filter((/** @type {any} */ surface)=>{
                if ((flags & DDENUMSURFACES_ALL) !== 0)
                {
                    return true;
                }
                if ((flags & DDENUMSURFACES_NOMATCH) !== 0)
                {
                    return !matches(surface);
                }
                return (flags & DDENUMSURFACES_MATCH) === 0 || matches(surface);
            });
            return enumerateSurfaces(chosen, { id: generation.surface, layout: generation.layout },
                callback >>> 0, context >>> 0);
        },

        /**
         * The primary is what GDI draws on, so flipping to it needs one, and
         * one that flips.
         *
         * @param {any} root
         */
        FlipToGDISurface: root=>{
            const primary = root.primarySurface();
            if (!primary)
            {
                return DDERR_NOTFOUND;
            }
            return (primary.caps & DDSCAPS_FLIP) !== 0 ? DD_OK : DDERR_NOTFLIPPABLE;
        },

        /** @param {any} root @param {number[]} args */
        GetCaps: (root, [hal, hel])=>{
            if ((hal >>> 0) === 0 && (hel >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            for (const pointer of [hal, hel])
            {
                if ((pointer >>> 0) !== 0)
                {
                    const hr = writeCaps(pointer);
                    if (hr !== DD_OK)
                    {
                        return hr;
                    }
                }
            }
            return DD_OK;
        },

        /** @param {any} root @param {number[]} args */
        GetDisplayMode: (root, [out])=>{
            if ((out >>> 0) === 0 || fields.readU32(out >>> 0) !== generation.layout.SIZE)
            {
                return DDERR_INVALIDPARAMS;
            }
            const mode = root.displayMode;
            const pixelFormat = /** @type {import('../ddraw/structs.js').PixelFormatFields} */ (
                pixelFormatForDepth(mode.bitCount));
            writeSurfaceDesc(memory, out >>> 0, generation.layout, {
                flags: DDSD_WIDTH | DDSD_HEIGHT | DDSD_PITCH | DDSD_PIXELFORMAT | DDSD_REFRESHRATE,
                width: mode.width,
                height: mode.height,
                pitch: mode.width * bytesPerPixel(pixelFormat),
                backBufferCount: 0,
                mipMapCount: mode.refreshRate,
                caps: 0,
                caps2: 0,
                pixelFormat,
            });
            return DD_OK;
        },

        /** @param {any} root @param {number[]} args */
        GetFourCCCodes: (root, [count])=>{
            if ((count >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            fields.writeU32(count >>> 0, 0);
            return DD_OK;
        },

        /** @param {any} root @param {number[]} args */
        GetGDISurface: (root, [out])=>{
            if ((out >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            const primary = root.primarySurface();
            if (!primary)
            {
                fields.writeU32(out >>> 0, 0);
                return DDERR_NOTFOUND;
            }
            primary.addRef();
            handBack(primary, surfaceInterfaces, generation.surface, out >>> 0);
            return DD_OK;
        },

        /** @param {any} root @param {number[]} args */
        GetMonitorFrequency: (root, [out])=>{
            if ((out >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            fields.writeU32(out >>> 0, REFRESH_HZ);
            return DD_OK;
        },

        // The scan line counts on through the blank, past the last visible
        // line, the way the documentation's example numbers it.
        /** @param {any} root @param {number[]} args */
        GetScanLine: (root, [out])=>{
            if ((out >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            fields.writeU32(out >>> 0, rasterOf(root).position().line);
            return DD_OK;
        },

        /** @param {any} root @param {number[]} args */
        GetVerticalBlankStatus: (root, [out])=>{
            if ((out >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            fields.writeU32(out >>> 0, rasterOf(root).position().inBlank ? 1 : 0);
            return DD_OK;
        },

        /** One a class factory made waits for this call; every other is born ready. */
        Initialize: (/** @type {any} */ root)=>(uninitialized.delete(root)
            ? DD_OK : DDERR_ALREADYINITIALIZED),

        /** @param {any} root */
        RestoreDisplayMode: (/** @type {any} */ root)=>root.restoreDisplayMode(),

        /** @param {any} root @param {number[]} args */
        SetCooperativeLevel: (root, [window, flags])=>{
            const hr = root.setCooperativeLevel(window >>> 0, flags >>> 0);
            if (hr === DD_OK)
            {
                coverScreen(root);
            }
            if ((root.cooperativeLevel & DDSCL_EXCLUSIVE) !== 0)
            {
                exclusiveHolders.add(root);
            }
            else
            {
                exclusiveHolders.delete(root);
            }
            return hr;
        },

        // The first generation takes width, height and depth; every later one
        // adds a refresh rate and flags after them.
        /** @param {any} root @param {number[]} args */
        SetDisplayMode: (root, [width, height, depth, refresh])=>{
            const hr = root.setDisplayMode(
                width >>> 0, height >>> 0, depth >>> 0, version === 1 ? 0 : (refresh >>> 0));
            if (hr === DD_OK)
            {
                coverScreen(root);
            }
            return hr;
        },

        /**
         * Parks the caller until the blank begins, or ends. The event form is
         * the one the documentation says is not supported.
         *
         * @param {any} root @param {number[]} args
         */
        WaitForVerticalBlank: (root, [flags])=>{
            const edge = (flags >>> 0) === DDWAITVB_BLOCKBEGIN ? 'begin'
                : (flags >>> 0) === DDWAITVB_BLOCKEND ? 'end' : null;
            if (edge === null)
            {
                return (flags >>> 0) === DDWAITVB_BLOCKBEGINEVENT
                    ? DDERR_UNSUPPORTED
                    : DDERR_INVALIDPARAMS;
            }
            return new Promise(resolve=>{
                schedule(rasterOf(root).untilBlank(edge), ()=>resolve(DD_OK));
            });
        },

        /** @param {any} root @param {number[]} args */
        GetAvailableVidMem: (root, [, total, free])=>{
            if ((total >>> 0) === 0 && (free >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            for (const pointer of [total, free])
            {
                if ((pointer >>> 0) !== 0)
                {
                    fields.writeU32(pointer >>> 0, VIDEO_MEMORY);
                }
            }
            return DD_OK;
        },

        /** @param {any} root @param {number[]} args */
        GetSurfaceFromDC: (root, [handle, out])=>{
            const surface = root.surfaceWithDc(handle >>> 0);
            if (!surface || (out >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            surface.addRef();
            handBack(surface, surfaceInterfaces, generation.surface, out >>> 0);
            return DD_OK;
        },

        /** @param {any} root */
        RestoreAllSurfaces: (/** @type {any} */ root)=>root.restoreAllSurfaces(),

        /** @param {any} root */
        TestCooperativeLevel: root=>{
            for (const holder of exclusiveHolders)
            {
                if (holder.destroyed || (holder.cooperativeLevel & DDSCL_EXCLUSIVE) === 0)
                {
                    exclusiveHolders.delete(holder);
                }
            }
            return root.testCooperativeLevel({
                heldElsewhere: [...exclusiveHolders].some(holder=>holder !== root),
            });
        },

        /**
         * The host flag asks after the adapter a 3D-only card is attached to,
         * and the one adapter here is its own host.
         *
         * @param {any} root @param {number[]} args
         */
        GetDeviceIdentifier: (root, [out, flags])=>{
            if ((out >>> 0) === 0 || (flags & ~DDGDI_GETHOSTIDENTIFIER) !== 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            writeDeviceIdentifier(out >>> 0, version === 7);
            return DD_OK;
        },
    });

    /**
     * Names the one DirectDraw device there is to a program's callback: the
     * primary display driver, which a program then creates by passing a null
     * GUID. The Ex form's callback takes a monitor handle as well, and the
     * primary device's is null -- it is the whole desktop, not one monitor.
     * Without a way into the guest nothing is named, and the program sees a
     * machine with no devices to choose between.
     *
     * @param {number} callback @param {number} context @param {boolean} withMonitor
     * @returns {number | Promise<number>}
     */
    const enumerateDevices = (callback, context, withMonitor)=>{
        if (!canEnumerate())
        {
            return DD_OK;
        }
        const call = /** @type {NonNullable<typeof callGuest>} */ (callGuest);
        const at = descriptorScratch();
        const name = at + 0x40;
        for (const [where, text] of /** @type {const} */ ([
            [at, 'Primary Display Driver'], [name, 'display'],
        ]))
        {
            memory.writeMemory(where, Uint8Array.from([...text, '\0'], c=>c.charCodeAt(0)));
        }
        return call({
            entry: callback,
            args: [0, at, name, context, ...(withMonitor ? [0] : [])],
            thread: currentThread?.(),
        }).then(()=>DD_OK);
    };

    /** Every generation, so a QueryInterface across them succeeds. */
    const ddrawInterfaces = [
        .../** @type {[1, 2, 4, 7]} */ ([1, 2, 4, 7]).map(version=>
            describe(GENERATIONS[version].id, GENERATIONS[version].slots,
                ddrawMethods(GENERATIONS[version], version))),
        ...extraInterfaces,
    ];

    /**
     * The class object DllGetClassObject hands out for DirectDraw and
     * DirectDraw7: its CreateInstance makes an object that waits for
     * Initialize, answering any of the object's own interfaces.
     *
     * @param {(version: 1 | 7) => any} create
     * @param {1 | 7} version
     */
    const factoryFor = (create, version)=>{
        let references = 1;
        return {
            create,
            version,
            addRef: ()=>++references,
            release: ()=>(references = Math.max(0, references - 1)),
            get destroyed(){
                return references === 0;
            },
        };
    };
    const factoryInterfaces = [describe(IID_IClassFactory, ICLASSFACTORY_SLOTS, {
        /** @param {any} factory @param {number[]} args */
        CreateInstance: (factory, [outer, riid, out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            fields.writeU32(out >>> 0, 0);
            if ((outer >>> 0) !== 0)
            {
                return CLASS_E_NOAGGREGATION;
            }
            const wanted = (riid >>> 0) === 0 ? '' : readGuid(memory, riid >>> 0);
            if (!ddrawInterfaces.some(entry=>entry.id === wanted))
            {
                return E_NOINTERFACE;
            }
            const root = factory.create(factory.version);
            if (!root)
            {
                return E_OUTOFMEMORY;
            }
            const facade = facadeOf(root);
            uninitialized.add(facade);
            fields.writeU32(out >>> 0, publisher.publish(facade, ddrawInterfaces, wanted));
            return DD_OK;
        },
        LockServer: ()=>DD_OK,
    })];

    return {
        /**
         * HRESULT DllGetClassObject(REFCLSID, REFIID, LPVOID *ppv): the class
         * object for DirectDraw or DirectDraw7, which CoCreateInstance reaches
         * through the class's InprocServer32 key.
         *
         * @param {number} clsid @param {number} riid @param {number} out
         * @param {(version: 1 | 7) => any} create
         */
        classObject(clsid, riid, out, create){
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            fields.writeU32(out >>> 0, 0);
            const asked = (clsid >>> 0) === 0 ? '' : readGuid(memory, clsid >>> 0);
            const version = asked === CLSID_DirectDraw ? 1 : asked === CLSID_DirectDraw7 ? 7 : 0;
            if (version === 0)
            {
                return CLASS_E_CLASSNOTAVAILABLE;
            }
            const wanted = (riid >>> 0) === 0 ? '' : readGuid(memory, riid >>> 0);
            if (wanted !== IID_IClassFactory && wanted !== IID_IUnknown)
            {
                return E_NOINTERFACE;
            }
            fields.writeU32(out >>> 0,
                publisher.publish(factoryFor(create, version), factoryInterfaces, wanted));
            return DD_OK;
        },

        /**
         * HRESULT GetSurfaceFromDC(HDC hdc, IDirectDrawSurface **surface, HDC *device_dc)
         *
         * DDRAW.dll's own export: the surface a GetDC handed this DC out
         * of, whichever DirectDraw object made it, as its first generation.
         *
         * @param {number} hdc @param {number} out @param {number} deviceOut
         */
        surfaceFromDc(hdc, out, deviceOut){
            if ((out >>> 0) === 0 || (deviceOut >>> 0) === 0)
            {
                if ((out >>> 0) !== 0)
                {
                    fields.writeU32(out >>> 0, 0);
                }
                return E_INVALIDARG;
            }
            for (const reference of roots)
            {
                const root = reference.deref();
                if (!root)
                {
                    roots.delete(reference);
                    continue;
                }
                const surface = root.surfaceWithDc?.(hdc >>> 0);
                if (surface)
                {
                    surface.addRef();
                    handBack(surface, surfaceInterfaces, IID_IDirectDrawSurface, out >>> 0);
                    fields.writeU32(deviceOut >>> 0, hdc >>> 0);
                    return DD_OK;
                }
            }
            fields.writeU32(out >>> 0, 0);
            fields.writeU32(deviceOut >>> 0, 0);
            return DDERR_NOTFOUND;
        },

        /**
         * The options a ddraw object is created with so that its device
         * contexts are GDI's and its screen changes are seen.
         *
         * @param {1 | 2 | 4 | 7} version
         * @returns {import('../ddraw/objects.js').DirectDrawOptions}
         */
        rootOptions(version){
            /** @type {import('../ddraw/objects.js').DirectDrawOptions} */
            const options = {
                version,
                onPresent: (surface, window, exclusive)=>{
                    if (present)
                    {
                        present({
                            buffer: surface.buffer,
                            width: surface.width,
                            height: surface.height,
                            pitch: surface.pitch,
                            bitCount: surface.bytesPerPixel * 8,
                            palette: surface.palette ? surface.palette.entries : null,
                        }, window, exclusive);
                    }
                },
            };
            if (gdi)
            {
                options.createDc = attributes=>gdi.createSurfaceDc(attributes);
                options.releaseDc = handle=>gdi.deleteSurfaceDc(handle);
            }
            if (gamma)
            {
                options.gamma = gamma;
            }
            if (deactivated)
            {
                options.application = {
                    deactivated,
                    deactivations: deactivations ?? (()=>0),
                };
            }
            const display = screen();
            options.screenWidth = display.width;
            options.screenHeight = display.height;
            return options;
        },

        /**
         * Publishes the object DirectDrawCreate hands back, as the generation
         * the entry point promises.
         *
         * @param {any} root  What graphics.create('ddraw') returned.
         * @param {1 | 2 | 4 | 7} version
         * @returns {number}
         */
        publishRoot: (root, version)=>
            publisher.publish(facadeOf(root), ddrawInterfaces, GENERATIONS[version].id),

        /**
         * DirectDrawEnumerate, in the four forms DDRAW.dll exports. The wide
         * ones were never implemented by the runtime and answer that they are
         * not, having called nothing; a null callback is refused first.
         */
        enumerate: {
            /** @param {number} callback @param {number} context */
            ansi: (callback, context)=>((callback >>> 0) === 0
                ? DDERR_INVALIDPARAMS
                : enumerateDevices(callback >>> 0, context >>> 0, false)),
            /** @param {number} callback @param {number} context @param {number} flags */
            ansiEx: (callback, context, flags)=>((callback >>> 0) === 0
                || (flags & ~DDENUM_KNOWN) !== 0
                ? DDERR_INVALIDPARAMS
                : enumerateDevices(callback >>> 0, context >>> 0, true)),
            /** @param {number} callback */
            wide: callback=>((callback >>> 0) === 0 ? DDERR_INVALIDPARAMS : DDERR_UNSUPPORTED),
            wideEx: ()=>DDERR_UNSUPPORTED,
        },

        ownerOf,

        /** For tests, which have no guest to call through. */
        interfaces: {
            ddraw: ddrawInterfaces,
            surface: surfaceInterfaces,
            palette: paletteInterfaces,
            clipper: clipperInterfaces,
        },
    };
}
