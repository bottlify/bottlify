/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Surfaces and textures: how long they live, and what a lock does.
 *
 * Lifetime first, because it is the part that differs from ordinary COM and
 * therefore the part that gets recreated wrongly. Three rules that are not
 * derivable from the usual counting:
 *
 * - A texture and the surfaces of its levels share one count. Releasing the
 *   texture is visible on the surface and the other way round; they are one
 *   object with several faces, not a parent and its children.
 * - An implicit resource (the back buffer, the automatic depth stencil, the
 *   implicit swap chain) starts at zero and is never destroyed by reaching zero
 *   again. What its count actually drives is the *device's* count: the first
 *   reference takes one on the device, the last one gives it back. So `AddRef`
 *   on one whose count is zero is legal, and it increments the device.
 * - Binding is not owning. Setting a texture, an index buffer or a stream
 *   source changes no count, in either direction.
 *
 * The lock rules are in the same file because they are the other thing a
 * surface is for. The asymmetry of a double unlock cannot be derived: a surface
 * obtained from a texture forgives it, an offscreen plain surface and a cube
 * face do not.
 *
 * The reference-count methods are spelled `addRef`/`release` to match the COM
 * object model these are published through; everything else keeps its Direct3D
 * name, because that is the name the caller compiled against.
 */

import {
    D3DERR_INVALIDCALL, D3DFMT, D3DPOOL, D3DRTYPE, D3DUSAGE, D3D_OK, FORMAT_INFO, offsetOfRect,
    surfaceBytes, surfacePitch,
} from './constants.js';
import { SURFACE_TYPE, surfaceIsLockable } from './validity.js';

/**
 * D3DLOCK_READONLY, which is the same number in both versions of the API. Here
 * rather than imported because it decides which half of a lock's divergence is
 * being reported, and that is this file's own business.
 */
const D3DLOCK_READONLY = 0x00000010;

/**
 * D3DLOCK_NO_DIRTY_UPDATE: a lock whose writes the texture's dirty region does
 * not record, the same number in both versions.
 */
export const D3DLOCK_NO_DIRTY_UPDATE = 0x00008000;

/**
 * @typedef {Object} ReferenceCount
 * @property {number} value
 * @property {boolean} destroyed
 * @property {() => number} addRef
 * @property {() => number} release
 * @property {() => void} [hold]   The device's own reference, kept while the
 *           resource is bound and never counted in `value` (see below).
 * @property {() => void} [letGo]
 */

/**
 * @param {{ implicit?: boolean, onFirstRef?: () => void, onLastRef?: () => void }} [options]
 * @returns {ReferenceCount}
 */
export function createReferenceCount(options = {}){
    const implicit = options.implicit === true;
    let count = implicit ? 0 : 1;
    let destroyed = false;
    // The device's references to a resource bound to it. Windows keeps a
    // bound resource alive past the program's last Release, with a count of
    // zero, and hands the same object back when asked for what is bound; it
    // goes once it is unbound too.
    let held = 0;
    const gone = ()=>{
        options.onLastRef?.();
        destroyed = !implicit;
    };

    return {
        get value(){
            return count;
        },
        // Whether the last reference has gone for good. An implicit resource
        // never reaches this: the device owns it and hands out the same pointer
        // for as long as it lives, so its storage must not be reclaimed.
        get destroyed(){
            return destroyed;
        },
        addRef(){
            if (destroyed)
            {
                throw new Error('AddRef on a resource whose last reference was released');
            }
            if (count === 0)
            {
                options.onFirstRef?.();
            }
            count++;
            return count;
        },
        release(){
            if (count === 0)
            {
                return 0;
            }
            count--;
            // An implicit resource outlives its own count: the device owns
            // it, so the pointer a program kept stays the same one.
            if (count === 0 && held === 0)
            {
                gone();
            }
            return count;
        },
        hold(){
            held++;
        },
        letGo(){
            if (held === 0)
            {
                return;
            }
            held--;
            if (held === 0 && count === 0 && !destroyed)
            {
                gone();
            }
        },
    };
}

/**
 * A container's count as its levels share it, with what the container gives
 * back when the count is over. A level holds a reference on its container, so
 * the last one can go through a level -- a program releases the texture and
 * then the surface it asked for -- and the storage has to go whichever it is.
 *
 * @param {ReturnType<typeof createReferenceCount>} count
 * @param {() => void} retire
 */
function sharedCount(count, retire){
    return {
        get value(){
            return count.value;
        },
        get destroyed(){
            return count.destroyed;
        },
        addRef: ()=>count.addRef(),
        release(){
            const left = count.release();
            if (count.destroyed)
            {
                retire();
            }
            return left;
        },
    };
}

/**
 * A resource's priority, which a managed resource alone keeps: it is a hint
 * to the manager that evicts, and nothing else is ever evicted, so every
 * other pool reads back zero whatever it was told (Wine's d3d8 and d3d9
 * test_resource_priority). Setting answers the priority before.
 *
 * @param {number} pool  D3DPOOL
 */
export function createPriority(pool){
    let priority = 0;
    return {
        /** @param {number} next @returns {number} */
        SetPriority(next){
            const was = priority;
            if (pool === D3DPOOL.MANAGED)
            {
                priority = next >>> 0;
            }
            return was;
        },
        /** @returns {number} */
        GetPriority: ()=>priority,
    };
}

/**
 * The filter a texture's generated levels are made with (Wine's d3d9
 * test_mipmap_gen): linear until told otherwise, and D3DTEXF_NONE refused,
 * since a level has to be made somehow. GenerateMipSubLevels is the
 * renderer's to answer; here it does nothing.
 */
export function createAutoGenFilter(){
    let filter = D3DTEXF_LINEAR;
    return {
        /** @param {number} next @returns {number} */
        SetAutoGenFilterType(next){
            if (next === D3DTEXF_NONE)
            {
                return D3DERR_INVALIDCALL;
            }
            filter = next;
            return D3D_OK;
        },
        /** @returns {number} */
        GetAutoGenFilterType: ()=>filter,
        GenerateMipSubLevels(){},
    };
}

/** D3DTEXF_NONE and D3DTEXF_LINEAR, the same numbers in both versions. */
const D3DTEXF_NONE = 0;
const D3DTEXF_LINEAR = 2;

/**
 * @typedef {Object} LockedRect
 * @property {number} pBits   Byte address of the first pixel of the locked area.
 * @property {number} Pitch   Bytes between two rows, unchanged by a partial lock.
 */

/**
 * @typedef {Object} LockRectangle
 * @property {number} left
 * @property {number} top
 * @property {number} right
 * @property {number} bottom
 */

/**
 * A surface's description, complete.
 *
 * Every field either version of the structure has a slot for, whether or not
 * anything here varies it, because a descriptor is written into memory the
 * program supplied -- usually a local -- and a field nobody fills keeps
 * whatever was on that stack. The program then reads a number we never gave
 * it. `Size` is the dangerous one: it is the surface's length in bytes, D3D8's
 * structure has a slot for it, and a program sizing a copy from it was sizing
 * it from its own stack garbage.
 *
 * @typedef {Object} SurfaceDesc
 * @property {number} Type
 * @property {number} Format
 * @property {number} Usage
 * @property {number} Pool
 * @property {number} Size    In bytes. D3D8's structure only; D3D9 dropped it.
 * @property {number} MultiSampleType
 * @property {number} MultiSampleQuality  D3D9's structure only; D3D8 has no slot.
 * @property {number} Width
 * @property {number} Height
 */

/**
 * @typedef {Object} Surface
 * @property {number} base            Byte address the surface's own storage starts at.
 * @property {string} kind            A SURFACE_TYPE.
 * @property {number} refCount
 * @property {boolean} destroyed      Whether its last reference has gone for good.
 * @property {() => boolean} reachable  Whether a pointer to it still reaches it at a count
 *           of zero: while its device or chain owns it.
 * @property {() => number} addRef
 * @property {() => number} release
 * @property {(out: LockedRect, rect?: LockRectangle | null, flags?: number)
 *            => number | Promise<number>} LockRect
 *           A promise when the surface is a render target whose pixels are
 *           read back first; the bridge suspends the caller on it.
 * @property {() => number} UnlockRect
 * @property {(out: { desc?: SurfaceDesc }) => number} GetDesc
 * @property {number} lockFlags   The flags of the lock in force, if one is.
 * @property {any} [container]    The texture a level belongs to; absent for a surface of its own.
 * @property {(rect: LockRectangle | null) => void} noteWritten
 * @property {(gdi: SurfaceGdi, out: { dc?: number }) => number | Promise<number>} GetDC
 * @property {(handle: number, gdi: SurfaceGdi) => number} ReleaseDC
 */

/**
 * @typedef {Object} SurfaceGdi  How a device context over guest pixels is made and unmade.
 * @property {(attributes: { width: number, height: number, pitch: number, bitCount: number,
 *   bits: number, palette: null, format: '565' | '555' }) => number} createSurfaceDc
 * @property {(handle: number) => void} deleteSurfaceDc
 *
 * @typedef {Object} SurfaceFamily
 *     What the surfaces of one resource share: a device context held on any
 *     of them is the whole resource's, so it and a lock exclude each other.
 * @property {number} locks
 * @property {Surface | null} dc
 */

/**
 * The formats a device context is handed out for (Wine's d3d9 test_getdc):
 * the bit count GDI is told, and for sixteen bits which layout. R8G8B8 is on
 * that list too, and no surface here is made in it.
 *
 * @type {Readonly<Record<number, { bitCount: number, format: '565' | '555' }>>}
 */
const DC_FORMATS = Object.freeze({
    [D3DFMT.A8R8G8B8]: { bitCount: 32, format: '555' },
    [D3DFMT.X8R8G8B8]: { bitCount: 32, format: '555' },
    [D3DFMT.R5G6B5]: { bitCount: 16, format: '565' },
    [D3DFMT.X1R5G5B5]: { bitCount: 16, format: '555' },
    [D3DFMT.A1R5G5B5]: { bitCount: 16, format: '555' },
});

/**
 * @typedef {Object} SurfaceOptions
 * @property {string} type            A SURFACE_TYPE.
 * @property {number} width
 * @property {number} height
 * @property {number} format
 * @property {number} pool
 * @property {number} usage
 * @property {number} base
 * @property {ReferenceCount} count
 * @property {boolean} [lockable]     Only a render target is asked this at creation.
 * @property {boolean} [forgivesDoubleUnlock]
 * @property {boolean} [rejectsMalformedRects]
 *           Whether a lock rectangle outside the surface, or with its edges
 *           the wrong way round, is refused. The later runtime refuses it;
 *           the earlier accepted it and programs relied on that, so which
 *           applies is the device's to say.
 * @property {number} [resourceType]  D3DRTYPE_SURFACE unless a texture level says otherwise.
 * @property {((api: string, detail: string) => void) | null} [divergence]
 *           Where "this call succeeded and did not do all of what it promises"
 *           goes. A render target lives on the GPU; without `pixels` its bytes
 *           are not read back into the guest's copy, so a lock of one hands out
 *           somewhere to read that holds something other than what was drawn.
 * @property {TargetPixels} [pixels]
 *           How a render target's pixels cross between the GPU and its guest
 *           bytes. Given, a lock reads them back first and the caller waits;
 *           an unlock after a write hands the bytes over.
 * @property {SurfaceFamily} [family]  Shared by the surfaces of one texture.
 * @property {(rect: LockRectangle | null) => void} [dirtied]
 *           Told at an unlock what the lock may have written -- its
 *           rectangle, or null for all of it -- unless the lock was read-only
 *           or asked for no dirty update.
 */

/**
 * @typedef {Object} TargetPixels
 * @property {(surface: Surface) => Promise<void>} readBack
 *           Settles once the surface's guest bytes hold what the GPU holds.
 * @property {(surface: Surface) => void} written
 *           The guest bytes are newer than the GPU's now.
 */

/**
 * @param {SurfaceOptions} options
 * @returns {Surface}
 */
export function createSurface(options){
    const pitch = surfacePitch(options.format, options.width);
    const lockable = surfaceIsLockable(options);
    const forgivesDoubleUnlock = options.forgivesDoubleUnlock === true;
    const rejectsMalformedRects = options.rejectsMalformedRects === true;
    let locked = false;
    let lockFlags = 0;
    /** @type {LockRectangle | null} */
    let lockRect = null;
    /** @type {number | null} */
    let dc = null;
    /** @type {SurfaceFamily} */
    const family = options.family ?? { locks: 0, dc: null };

    /** @type {SurfaceDesc} */
    const desc = {
        Type: options.resourceType ?? D3DRTYPE.SURFACE,
        Format: options.format,
        Usage: options.usage,
        Pool: options.pool,
        // The same arithmetic the storage was allocated with, so a program that
        // reads the surface by this length reads inside it.
        Size: surfaceBytes(options.format, options.width, options.height),
        // Nothing here creates a multisampled surface. Said rather than left
        // unwritten: D3DMULTISAMPLE_NONE is zero, and a program reading a
        // stack-garbage sample type off its own frame concludes anything.
        MultiSampleType: 0,
        MultiSampleQuality: 0,
        Width: options.width,
        Height: options.height,
    };

    /** @type {Surface} */
    const self = {
        base: options.base,
        /** Which of the five shapes this is: what a copy or a fill may do depends on it. */
        kind: options.type,
        get refCount(){
            return options.count.value;
        },
        // Whether the last reference has gone for good: a surface its device
        // or chain owns outlives a count of zero, and the pointer a program
        // kept must still reach it (Wine's d3d8 and d3d9 test_refcount).
        get destroyed(){
            return options.count.destroyed;
        },
        reachable: ()=>!options.count.destroyed,
        addRef: ()=>options.count.addRef(),
        release: ()=>options.count.release(),

        /** @param {{ desc?: SurfaceDesc }} out */
        GetDesc(out){
            out.desc = desc;
            return D3D_OK;
        },

        /**
         * A rectangle outside the surface, or with its edges the wrong way
         * round, is accepted unless the device says otherwise: the later
         * runtime rejects it, the earlier did not, and programs were written
         * against each.
         *
         * @param {LockedRect} out
         *        Left exactly as it was when the lock fails -- callers read it
         *        back unconditionally and would otherwise follow a pointer the
         *        failed call invented.
         * @param {LockRectangle | null} [rect]
         * @param {number} [flags]
         */
        LockRect(out, rect = null, flags = 0){
            if (locked || !lockable || family.dc !== null)
            {
                return D3DERR_INVALIDCALL;
            }
            if (rect && rejectsMalformedRects
                && !(rect.left >= 0 && rect.top >= 0 && rect.left < rect.right
                    && rect.top < rect.bottom && rect.right <= options.width
                    && rect.bottom <= options.height))
            {
                return D3DERR_INVALIDCALL;
            }
            // A surface that lives on the GPU is not copied back into the
            // guest's own bytes, and the guest's bytes are not copied onto the
            // GPU when the lock ends. The lock is right to succeed -- refusing
            // it sends a program that asked for a lockable surface down a path
            // it was not written for -- but it is two different wrongs
            // depending on which way the program means to use it, and only one
            // of them is a lost picture.
            //
            // Said apart because a read-only lock discards nothing, and warning
            // that it does would be a false report of the more serious fault. A
            // texture level is neither: its unlock uploads what was written.
            const target = options.type === SURFACE_TYPE.RENDER_TARGET;
            if (target || options.type === SURFACE_TYPE.DEPTH_STENCIL)
            {
                if (!(target && options.pixels))
                {
                    options.divergence?.('Direct3D', (flags & D3DLOCK_READONLY) !== 0
                        ? `a read of a ${options.type} surface is accepted and hands out guest`
                            + ' memory that the rendered pixels are never copied into'
                        : `a write to a ${options.type} surface is accepted and goes into guest`
                            + ' memory that the unlock never copies to the surface, so what the'
                            + ' program draws by hand is discarded');
                }
            }
            locked = true;
            family.locks++;
            lockRect = rect;
            out.Pitch = pitch;
            out.pBits = options.base
                + (rect ? offsetOfRect(options.format, pitch, rect) : 0);
            // The flags decide whether the backend may rename the storage or
            // must write into it; whoever consumes this must see them.
            lockFlags = flags;
            if (target && options.pixels)
            {
                // The pointer is handed out only once the bytes behind it
                // are the target's pixels; the caller is suspended until then.
                return options.pixels.readBack(self).then(()=>D3D_OK);
            }
            return D3D_OK;
        },

        UnlockRect(){
            if (!locked)
            {
                // A context held on another surface of the resource is the
                // resource's lock, and this is one of its surfaces.
                return forgivesDoubleUnlock || (family.dc !== null && family.dc !== self)
                    ? D3D_OK
                    : D3DERR_INVALIDCALL;
            }
            locked = false;
            family.locks--;
            if (options.type === SURFACE_TYPE.RENDER_TARGET && options.pixels
                && (lockFlags & D3DLOCK_READONLY) === 0)
            {
                options.pixels.written(self);
            }
            if ((lockFlags & (D3DLOCK_READONLY | D3DLOCK_NO_DIRTY_UPDATE)) === 0)
            {
                options.dirtied?.(lockRect);
            }
            return D3D_OK;
        },

        /** Only meaningful while the surface is locked. */
        get lockFlags(){
            return lockFlags;
        },

        /**
         * Something other than a lock wrote a rectangle of the surface -- a
         * copy into it -- which a texture's dirty region records as a lock's
         * write would be.
         *
         * @param {LockRectangle | null} rect
         */
        noteWritten(rect){
            options.dirtied?.(rect);
        },

        /**
         * A device context over the surface's own bytes. A render target's
         * pixels are read back first, as a lock's are, and the caller waits.
         *
         * @param {SurfaceGdi} gdi @param {{ dc?: number }} out  Written only on success.
         */
        GetDC(gdi, out){
            const layout = DC_FORMATS[options.format];
            if (!layout || locked || family.dc !== null || family.locks > 0)
            {
                return D3DERR_INVALIDCALL;
            }
            const handle = gdi.createSurfaceDc({
                width: options.width, height: options.height, pitch,
                bitCount: layout.bitCount, bits: options.base, palette: null,
                format: layout.format,
            });
            if (handle === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            dc = handle;
            family.dc = self;
            const answer = ()=>{
                out.dc = handle;
                return D3D_OK;
            };
            return options.type === SURFACE_TYPE.RENDER_TARGET && options.pixels
                ? options.pixels.readBack(self).then(answer)
                : answer();
        },

        /**
         * Whatever was drawn through the context is taken up the way an
         * unlock after a write takes it up, through whichever unlock the
         * surface has now -- a renderer tracking a texture level puts its own
         * in place.
         *
         * @param {number} handle @param {SurfaceGdi} gdi
         */
        ReleaseDC(handle, gdi){
            if (family.dc !== self || handle !== dc)
            {
                return D3DERR_INVALIDCALL;
            }
            gdi.deleteSurfaceDc(handle);
            dc = null;
            family.dc = null;
            locked = true;
            family.locks++;
            lockFlags = 0;
            lockRect = null;
            return self.UnlockRect();
        },
    };
    return self;
}

/**
 * @typedef {Object} SurfaceMove
 *     One rectangle of one copy, as addresses in the guest's own memory.
 * @property {number} from
 * @property {number} to
 * @property {number} rowBytes
 * @property {number} rows
 * @property {number} fromPitch
 * @property {number} toPitch
 */

/**
 * One rectangle of one surface moved to a point of another, as addresses. A
 * compressed format moves whole blocks: the rectangle is taken outward to them.
 *
 * @param {Surface} source @param {LockRectangle} rect
 * @param {Surface} destination @param {{ x: number, y: number }} point
 * @returns {SurfaceMove}
 */
export function rectMoveOf(source, rect, destination, point){
    /** @type {{ desc?: SurfaceDesc }} */
    const described = {};
    source.GetDesc(described);
    const from = /** @type {SurfaceDesc} */ (described.desc);
    destination.GetDesc(described);
    const to = /** @type {SurfaceDesc} */ (described.desc);
    const info = FORMAT_INFO[from.Format];
    const block = info.blockSize ?? 1;
    const blockBytes = info.blockBytes ?? info.bytesPerPixel;
    const fromPitch = surfacePitch(from.Format, from.Width);
    const toPitch = surfacePitch(to.Format, to.Width);
    return {
        from: source.base + Math.floor(rect.top / block) * fromPitch
            + Math.floor(rect.left / block) * blockBytes,
        to: destination.base + Math.floor(point.y / block) * toPitch
            + Math.floor(point.x / block) * blockBytes,
        rowBytes: Math.ceil((rect.right - rect.left) / block) * blockBytes,
        rows: Math.ceil((rect.bottom - rect.top) / block),
        fromPitch,
        toPitch,
    };
}

/**
 * A texture's dirty region, a rectangle of its top level, as it covers one
 * level: shrunk with the level and taken outward to whole texels.
 *
 * @param {LockRectangle} region @param {number} level
 * @param {number} width @param {number} height  The level's own extent.
 * @returns {LockRectangle}
 */
export function regionAtLevel(region, level, width, height){
    const round = (/** @type {number} */ edge)=>(edge + (1 << level) - 1) >>> level;
    return {
        left: Math.min(region.left >>> level, width - 1),
        top: Math.min(region.top >>> level, height - 1),
        right: Math.max(1, Math.min(width, round(region.right))),
        bottom: Math.max(1, Math.min(height, round(region.bottom))),
    };
}

/**
 * One pixel of a D3DCOLOR in a format's own layout, as the little-endian
 * number its bytes spell: the format's width decides how many of them count.
 *
 * @param {number} format @param {number} colour
 * @returns {number}
 */
export function packBits(format, colour){
    const a = (colour >>> 24) & 0xff;
    const r = (colour >>> 16) & 0xff;
    const g = (colour >>> 8) & 0xff;
    const b = colour & 0xff;
    switch (format)
    {
        case D3DFMT.R5G6B5:
            return ((r >>> 3) << 11) | ((g >>> 2) << 5) | (b >>> 3);
        case D3DFMT.X1R5G5B5:
        case D3DFMT.A1R5G5B5:
            return ((a >>> 7) << 15) | ((r >>> 3) << 10) | ((g >>> 3) << 5) | (b >>> 3);
        case D3DFMT.A4R4G4B4:
        case D3DFMT.X4R4G4B4:
            return ((a >>> 4) << 12) | ((r >>> 4) << 8) | ((g >>> 4) << 4) | (b >>> 4);
        case D3DFMT.A8:
            return a;
        // Luminance is the colour: the red byte stands in for it, the same
        // way a sample replicates it into the channels it fills.
        case D3DFMT.L8:
            return r;
        case D3DFMT.A8L8:
            return r | (a << 8);
        case D3DFMT.A4L4:
            return ((a >>> 4) << 4) | (r >>> 4);
        // The 32-bit layouts, and a format with no layout here, which still
        // gets a pixel of its own width so that a row packed from it is the
        // row's length and nothing else.
        default:
            return ((a << 24) | (r << 16) | (g << 8) | b) >>> 0;
    }
}

/**
 * One pixel of a D3DCOLOR in a format's own layout, little-endian.
 *
 * @param {number} format @param {number} colour
 * @returns {Uint8Array}
 */
export function packColour(format, colour){
    const width = FORMAT_INFO[format]?.bytesPerPixel ?? 4;
    const bits = packBits(format, colour);
    return Uint8Array.from({ length: width }, (_, index)=>(bits >>> (index * 8)) & 0xff);
}

/**
 * Pixels read back off the GPU -- four bytes each, blue first, the surface's
 * whole extent -- into the surface's guest bytes, packed the way its format
 * lays a pixel out.
 *
 * @param {Surface} surface
 * @param {Uint8Array} pixels
 * @param {(address: number, bytes: Uint8Array) => void} writeMemory
 */
export function writePixels(surface, pixels, writeMemory){
    /** @type {{ desc?: SurfaceDesc }} */
    const out = {};
    surface.GetDesc(out);
    const desc = /** @type {SurfaceDesc} */ (out.desc);
    const bytesPerPixel = FORMAT_INFO[desc.Format].bytesPerPixel;
    const pitch = surfacePitch(desc.Format, desc.Width);
    // A four-byte surface is laid out exactly as the read-back is, rows at
    // the pitch and pixels blue first, so the read-back is written as it is.
    if (bytesPerPixel === 4 && pitch === desc.Width * 4)
    {
        writeMemory(surface.base, pixels);
        return;
    }
    const row = new Uint8Array(pitch);
    for (let y = 0; y < desc.Height; y++)
    {
        for (let x = 0; x < desc.Width; x++)
        {
            const at = (y * desc.Width + x) * 4;
            const bits = packBits(desc.Format, ((pixels[at + 3] << 24) | (pixels[at + 2] << 16)
                | (pixels[at + 1] << 8) | pixels[at]) >>> 0);
            for (let byte = 0; byte < bytesPerPixel; byte++)
            {
                row[x * bytesPerPixel + byte] = (bits >>> (byte * 8)) & 0xff;
            }
        }
        writeMemory(surface.base + y * pitch, row);
    }
}

/**
 * The front buffer -- four bytes a pixel, blue first, as a read-back hands it
 * over -- into an A8R8G8B8 surface's guest bytes from its top-left corner,
 * as much of it as the surface holds. What is shown is opaque, whatever the
 * back buffer's own alpha bytes held; with nothing shown yet the surface is
 * black.
 *
 * @param {Surface} surface
 * @param {{ width: number, height: number, data: Uint8Array } | null} image
 * @param {(address: number, bytes: Uint8Array) => void} writeMemory
 */
export function writeFrontBuffer(surface, image, writeMemory){
    /** @type {{ desc?: SurfaceDesc }} */
    const out = {};
    surface.GetDesc(out);
    const desc = /** @type {SurfaceDesc} */ (out.desc);
    const pitch = surfacePitch(desc.Format, desc.Width);
    const row = new Uint8Array(desc.Width * 4);
    for (let y = 0; y < desc.Height; y++)
    {
        row.fill(0);
        const within = image && y < image.height ? Math.min(desc.Width, image.width) : 0;
        if (image && within > 0)
        {
            row.set(image.data.subarray(y * image.width * 4, (y * image.width + within) * 4));
        }
        for (let x = 0; x < desc.Width; x++)
        {
            row[x * 4 + 3] = 0xff;
        }
        writeMemory(surface.base + y * pitch, row);
    }
    surface.noteWritten(null);
}

/**
 * @param {number} size
 * @param {number} level
 * @returns {number} the extent of a mip level, never smaller than one texel
 */
export function levelExtent(size, level){
    return Math.max(1, size >>> level);
}

/**
 * @typedef {Object} TextureOptions
 * @property {number} width
 * @property {number} height
 * @property {number} levels
 * @property {number} format
 * @property {number} pool
 * @property {number} usage
 * @property {ReferenceCount} count
 * @property {(bytes: number) => number} allocate
 * @property {(address: number) => void} [free]
 *     Gives a level's storage back when the last reference goes. Absent in a
 *     build whose storage is a fabricated address rather than guest memory.
 * @property {boolean} [cube]
 * @property {boolean} [rejectsMalformedRects]  Passed to every level's surface.
 */

/**
 * A texture and its levels, sharing one count.
 *
 * Locking through the texture and locking through the level's surface are the
 * same lock: a program that holds one and takes the other is asking twice for
 * the same storage, and gets told so.
 *
 * @param {TextureOptions} options
 */
export function createTexture(options){
    const cube = options.cube === true;
    const faces = cube ? 6 : 1;
    /** @type {Map<string, Surface>} */
    const surfaces = new Map();
    // Each face's levels lie one after another in one block, as Windows lays
    // a texture's chain out: a program that locks the top level and writes
    // on past its end writes the next levels (Wine's d3d8 test_mipmap_upload).
    /** @type {number[]} */
    const chains = new Array(faces).fill(0);
    /** @param {number} level @returns {number} bytes before it in its face's block */
    const offsetOf = level=>{
        let bytes = 0;
        for (let before = 0; before < level; before++)
        {
            bytes += surfaceBytes(options.format, levelExtent(options.width, before),
                levelExtent(options.height, before));
        }
        return bytes;
    };
    const count = sharedCount(options.count, ()=>{
        for (const base of chains)
        {
            if (base)
            {
                options.free?.(base);
            }
        }
        chains.fill(0);
        surfaces.clear();
    });
    /** @type {SurfaceFamily} */
    const family = { locks: 0, dc: null };

    /** @returns {LockRectangle} the whole top level */
    const whole = ()=>({ left: 0, top: 0, right: options.width, bottom: options.height });
    /**
     * Per face, what UpdateTexture carries from this texture, in texels of
     * the top level: all of it at first, then what locks and AddDirtyRect
     * add, until an update takes it (Wine's d3d8 and d3d9 add_dirty_rect_test).
     *
     * @type {(LockRectangle | null)[]}
     */
    const dirty = Array.from({ length: faces }, whole);
    /** @param {number} face @param {LockRectangle} rect */
    const addDirty = (face, rect)=>{
        const held = dirty[face];
        dirty[face] = held
            ? {
                left: Math.min(held.left, rect.left), top: Math.min(held.top, rect.top),
                right: Math.max(held.right, rect.right),
                bottom: Math.max(held.bottom, rect.bottom),
            }
            : { ...rect };
    };
    /** @param {LockRectangle} rect @param {number} width @param {number} height */
    const within = (rect, width, height)=>rect.left >= 0 && rect.top >= 0
        && rect.left < rect.right && rect.top < rect.bottom
        && rect.right <= width && rect.bottom <= height;

    /**
     * @param {number} face
     * @param {number} level
     * @returns {Surface | null}
     */
    const surfaceFor = (face, level)=>{
        if (face < 0 || face >= faces || level < 0 || level >= options.levels)
        {
            return null;
        }
        const key = `${face}:${level}`;
        const existing = surfaces.get(key);
        if (existing)
        {
            return existing;
        }
        const width = levelExtent(options.width, level);
        const height = levelExtent(options.height, level);
        const surface = createSurface({
            type: cube ? SURFACE_TYPE.CUBE : SURFACE_TYPE.TEXTURE_2D,
            width,
            height,
            format: options.format,
            pool: options.pool,
            usage: options.usage,
            base: (chains[face] ||= options.allocate(offsetOf(options.levels)))
                + offsetOf(level),
            count,
            // Only a surface reached through a 2D texture forgives an unlock it
            // does not owe; a cube face does not, and that difference is
            // measured rather than reasoned about.
            forgivesDoubleUnlock: !cube,
            rejectsMalformedRects: options.rejectsMalformedRects,
            family,
            // A level's rectangle is a region of the top level scaled up; a
            // rectangle that is not one is all of it.
            dirtied: rect=>addDirty(face, rect && within(rect, width, height)
                ? {
                    left: rect.left << level, top: rect.top << level,
                    right: Math.min(options.width, rect.right << level),
                    bottom: Math.min(options.height, rect.bottom << level),
                }
                : whole()),
        });
        surface.container = texture;
        surfaces.set(key, surface);
        return surface;
    };

    /** The most detailed level a managed texture lets a sample reach. */
    let lod = 0;

    const texture = {
        levels: options.levels,
        cube,
        pool: options.pool,
        type: cube ? D3DRTYPE.CUBETEXTURE : D3DRTYPE.TEXTURE,
        // Its lower levels are the device's to make, and the program sees
        // the top one alone.
        autoGen: (options.usage & D3DUSAGE.AUTOGENMIPMAP) !== 0,
        ...createPriority(options.pool),
        ...createAutoGenFilter(),

        /**
         * Only a managed texture keeps its level of detail; the call returns
         * no HRESULT, so for any other pool it is ignored and reads back as
         * zero (Wine's d3d9 test_lod). A level past the last is the last.
         *
         * @param {number} next
         * @returns {number} the level before
         */
        SetLOD(next){
            const was = lod;
            if (options.pool === D3DPOOL.MANAGED)
            {
                lod = Math.min(next >>> 0, options.levels - 1);
            }
            return was;
        },

        /** @returns {number} */
        GetLOD: ()=>lod,

        /**
         * Adds to what UpdateTexture carries from this texture: a rectangle
         * of the top level, or all of it for none. One that is empty or leaves
         * the level is refused.
         *
         * @param {LockRectangle | null} rect
         * @param {number} [face]
         */
        AddDirtyRect(rect, face = 0){
            if (face < 0 || face >= faces || (rect && !within(rect, options.width, options.height)))
            {
                return D3DERR_INVALIDCALL;
            }
            addDirty(face, rect ?? whole());
            return D3D_OK;
        },

        /**
         * What an update carries from one face, which it then no longer
         * holds; null when nothing was written since the last.
         *
         * @param {number} [face]
         * @returns {LockRectangle | null}
         */
        takeDirtyRegion(face = 0){
            const region = dirty[face] ?? null;
            dirty[face] = null;
            return region;
        },

        get refCount(){
            return options.count.value;
        },
        addRef: ()=>options.count.addRef(),

        /**
         * Gives the storage back when the last reference goes, here or
         * through a level (`sharedCount`).
         *
         * A texture's pixels come out of the one arena everything the guest is
         * handed comes out of, and a program sizes its own asset cache from
         * what that arena reports free. Keeping the pixels of a texture nobody
         * holds does not merely leak address space -- it tells the program it
         * is running out of memory, and a program told that evicts what it has
         * and loads it again, for ever.
         */
        release: ()=>count.release(),

        /**
         * @param {number} level
         * @param {{ surface?: Surface }} out
         */
        GetSurfaceLevel(level, out){
            const surface = cube ? null : surfaceFor(0, level);
            if (!surface)
            {
                return D3DERR_INVALIDCALL;
            }
            surface.addRef();
            out.surface = surface;
            return D3D_OK;
        },

        /**
         * @param {number} face
         * @param {number} level
         * @param {{ surface?: Surface }} out
         */
        GetCubeMapSurface(face, level, out){
            const surface = cube ? surfaceFor(face, level) : null;
            if (!surface)
            {
                return D3DERR_INVALIDCALL;
            }
            surface.addRef();
            out.surface = surface;
            return D3D_OK;
        },

        /**
         * @param {number} level
         * @param {LockedRect} out
         * @param {LockRectangle | null} [rect]
         * @param {number} [flags]
         */
        LockRect(level, out, rect = null, flags = 0){
            const surface = surfaceFor(0, level);
            return surface ? surface.LockRect(out, rect, flags) : D3DERR_INVALIDCALL;
        },

        /** @param {number} level */
        UnlockRect(level){
            const surface = surfaceFor(0, level);
            return surface ? surface.UnlockRect() : D3DERR_INVALIDCALL;
        },

        /**
         * @param {number} face
         * @param {number} level
         * @param {LockedRect} out
         * @param {LockRectangle | null} [rect]
         * @param {number} [flags]
         */
        LockCubeRect(face, level, out, rect = null, flags = 0){
            const surface = surfaceFor(face, level);
            return surface ? surface.LockRect(out, rect, flags) : D3DERR_INVALIDCALL;
        },

        /**
         * @param {number} face
         * @param {number} level
         */
        UnlockCubeRect(face, level){
            const surface = surfaceFor(face, level);
            return surface ? surface.UnlockRect() : D3DERR_INVALIDCALL;
        },
    };
    return texture;
}

/**
 * @typedef {Object} LockBox  A box of a volume in texels, its far edges exclusive.
 * @property {number} left
 * @property {number} top
 * @property {number} right
 * @property {number} bottom
 * @property {number} front
 * @property {number} back
 */

/**
 * @typedef {Object} LockedBox
 * @property {number} RowPitch    Bytes between two rows of a slice.
 * @property {number} SlicePitch  Bytes between two slices.
 * @property {number} pBits       Byte address of the first texel of the locked box.
 */

/**
 * A volume's description, every field either version's structure has.
 *
 * @typedef {Object} VolumeDesc
 * @property {number} Format
 * @property {number} Type    D3DRTYPE_VOLUME.
 * @property {number} Usage
 * @property {number} Pool
 * @property {number} Size    In bytes. D3D8's structure only.
 * @property {number} Width
 * @property {number} Height
 * @property {number} Depth
 */

/**
 * Whether a box lies inside a volume of this extent and is not empty along
 * any axis. A volume checks every box it is handed, in both versions (Wine's
 * d3d8 and d3d9 test_lockbox_invalid), where a surface's rectangle is checked
 * only by the later runtime.
 *
 * @param {LockBox} box @param {number} width @param {number} height @param {number} depth
 */
export function boxWithin(box, width, height, depth){
    return box.left < box.right && box.top < box.bottom && box.front < box.back
        && box.right <= width && box.bottom <= height && box.back <= depth;
}

/**
 * A volume texture's dirty box, a box of its top level, as it covers one
 * level: shrunk with the level and taken outward to whole texels.
 *
 * @param {LockBox} box @param {number} level
 * @param {number} width @param {number} height @param {number} depth  The level's own extent.
 * @returns {LockBox}
 */
export function boxAtLevel(box, level, width, height, depth){
    const round = (/** @type {number} */ edge)=>(edge + (1 << level) - 1) >>> level;
    return {
        left: Math.min(box.left >>> level, width - 1),
        top: Math.min(box.top >>> level, height - 1),
        front: Math.min(box.front >>> level, depth - 1),
        right: Math.max(1, Math.min(width, round(box.right))),
        bottom: Math.max(1, Math.min(height, round(box.bottom))),
        back: Math.max(1, Math.min(depth, round(box.back))),
    };
}

/**
 * @typedef {Object} VolumeOptions
 * @property {number} width
 * @property {number} height
 * @property {number} depth
 * @property {number} format   Uncompressed: a volume in blocks is never made here.
 * @property {number} pool
 * @property {number} usage
 * @property {number} base
 * @property {ReferenceCount} count  The texture's: a level is not counted apart from it.
 * @property {(box: LockBox | null) => void} [dirtied]
 *           Told at an unlock what the lock may have written, unless it was
 *           read-only or asked for no dirty update.
 */

/**
 * One level of a volume texture: slices of rows, each slice a surface's
 * worth, one after another.
 *
 * @param {VolumeOptions} options
 */
export function createVolume(options){
    const rowPitch = surfacePitch(options.format, options.width);
    const slicePitch = rowPitch * options.height;
    const texelBytes = FORMAT_INFO[options.format]?.bytesPerPixel ?? 4;
    // Wine's d3d8 and d3d9 test_volume_locking: a default-pool volume locks
    // only when it was made dynamic; every other pool's always does.
    const lockable = options.pool !== D3DPOOL.DEFAULT
        || (options.usage & D3DUSAGE.DYNAMIC) !== 0;
    let locked = false;
    let lockFlags = 0;
    /** @type {LockBox | null} */
    let lockBox = null;
    /** @type {VolumeDesc} */
    const desc = {
        Format: options.format,
        Type: D3DRTYPE.VOLUME,
        Usage: options.usage,
        Pool: options.pool,
        Size: slicePitch * options.depth,
        Width: options.width,
        Height: options.height,
        Depth: options.depth,
    };
    return {
        base: options.base,
        width: options.width,
        height: options.height,
        depth: options.depth,
        rowPitch,
        slicePitch,
        texelBytes,
        /** @type {any} the volume texture this is a level of */
        container: null,
        get refCount(){
            return options.count.value;
        },
        get destroyed(){
            return options.count.destroyed;
        },
        reachable: ()=>!options.count.destroyed,
        addRef: ()=>options.count.addRef(),
        release: ()=>options.count.release(),

        /** @param {{ desc?: VolumeDesc }} out */
        GetDesc(out){
            out.desc = desc;
            return D3D_OK;
        },

        /**
         * @param {LockedBox} out  Written only when the lock succeeds.
         * @param {LockBox | null} [box]
         * @param {number} [flags]
         */
        LockBox(out, box = null, flags = 0){
            if (locked || !lockable
                || (box && !boxWithin(box, options.width, options.height, options.depth)))
            {
                return D3DERR_INVALIDCALL;
            }
            locked = true;
            lockFlags = flags;
            lockBox = box;
            out.RowPitch = rowPitch;
            out.SlicePitch = slicePitch;
            out.pBits = options.base + (box
                ? box.front * slicePitch + box.top * rowPitch + box.left * texelBytes
                : 0);
            return D3D_OK;
        },

        UnlockBox(){
            if (!locked)
            {
                return D3DERR_INVALIDCALL;
            }
            locked = false;
            if ((lockFlags & (D3DLOCK_READONLY | D3DLOCK_NO_DIRTY_UPDATE)) === 0)
            {
                options.dirtied?.(lockBox);
            }
            return D3D_OK;
        },

        /** Only meaningful while the volume is locked. */
        get lockFlags(){
            return lockFlags;
        },
    };
}

/**
 * @typedef {Object} VolumeTextureOptions
 * @property {number} width
 * @property {number} height
 * @property {number} depth
 * @property {number} levels
 * @property {number} format
 * @property {number} pool
 * @property {number} usage
 * @property {ReferenceCount} count
 * @property {(bytes: number) => number} allocate
 * @property {(address: number) => void} [free]
 */

/**
 * A volume texture and its levels, sharing one count as a texture and its
 * surfaces do.
 *
 * @param {VolumeTextureOptions} options
 */
export function createVolumeTexture(options){
    /** @type {Map<number, ReturnType<typeof createVolume>>} */
    const volumes = new Map();
    const count = sharedCount(options.count, ()=>{
        for (const volume of volumes.values())
        {
            options.free?.(volume.base);
        }
        volumes.clear();
    });
    /** @returns {LockBox} the whole top level */
    const whole = ()=>({
        left: 0, top: 0, front: 0,
        right: options.width, bottom: options.height, back: options.depth,
    });
    /**
     * What UpdateTexture carries from this texture, in texels of the top
     * level: all of it at first, then what locks and AddDirtyBox add.
     *
     * @type {LockBox | null}
     */
    let dirty = whole();
    /** @param {LockBox} box */
    const addDirty = box=>{
        dirty = dirty
            ? {
                left: Math.min(dirty.left, box.left), top: Math.min(dirty.top, box.top),
                front: Math.min(dirty.front, box.front),
                right: Math.max(dirty.right, box.right),
                bottom: Math.max(dirty.bottom, box.bottom),
                back: Math.max(dirty.back, box.back),
            }
            : { ...box };
    };

    /** @param {number} level */
    const volumeFor = level=>{
        if (level < 0 || level >= options.levels)
        {
            return null;
        }
        const existing = volumes.get(level);
        if (existing)
        {
            return existing;
        }
        const width = levelExtent(options.width, level);
        const height = levelExtent(options.height, level);
        const depth = levelExtent(options.depth, level);
        const volume = createVolume({
            width,
            height,
            depth,
            format: options.format,
            pool: options.pool,
            usage: options.usage,
            base: options.allocate(surfacePitch(options.format, width) * height * depth),
            count,
            // A level's box is a box of the top level scaled up.
            dirtied: box=>addDirty(box
                ? {
                    left: box.left << level, top: box.top << level, front: box.front << level,
                    right: Math.min(options.width, box.right << level),
                    bottom: Math.min(options.height, box.bottom << level),
                    back: Math.min(options.depth, box.back << level),
                }
                : whole()),
        });
        volume.container = texture;
        volumes.set(level, volume);
        return volume;
    };

    let lod = 0;

    const texture = {
        levels: options.levels,
        volume: true,
        format: options.format,
        pool: options.pool,
        width: options.width,
        height: options.height,
        depth: options.depth,
        type: D3DRTYPE.VOLUMETEXTURE,
        ...createPriority(options.pool),
        ...createAutoGenFilter(),

        /**
         * As a texture's: a managed texture's alone, the last level at most.
         *
         * @param {number} next
         * @returns {number} the level before
         */
        SetLOD(next){
            const was = lod;
            if (options.pool === D3DPOOL.MANAGED)
            {
                lod = Math.min(next >>> 0, options.levels - 1);
            }
            return was;
        },

        /** @returns {number} */
        GetLOD: ()=>lod,

        /**
         * Adds a box of the top level, or all of it for none, to what
         * UpdateTexture carries; one that is empty or leaves the level is
         * refused.
         *
         * @param {LockBox | null} box
         */
        AddDirtyBox(box){
            if (box && !boxWithin(box, options.width, options.height, options.depth))
            {
                return D3DERR_INVALIDCALL;
            }
            addDirty(box ?? whole());
            return D3D_OK;
        },

        /**
         * What an update carries, which the texture then no longer holds;
         * null when nothing was written since the last.
         *
         * @returns {LockBox | null}
         */
        takeDirtyRegion(){
            const region = dirty;
            dirty = null;
            return region;
        },

        get refCount(){
            return options.count.value;
        },
        addRef: ()=>options.count.addRef(),

        /** Gives the levels' storage back when the last reference goes, here or through one. */
        release: ()=>count.release(),

        /**
         * @param {number} level
         * @param {{ volume?: ReturnType<typeof createVolume> }} out
         */
        GetVolumeLevel(level, out){
            const volume = volumeFor(level);
            if (!volume)
            {
                return D3DERR_INVALIDCALL;
            }
            volume.addRef();
            out.volume = volume;
            return D3D_OK;
        },

        /**
         * @param {number} level
         * @param {LockedBox} out
         * @param {LockBox | null} [box]
         * @param {number} [flags]
         */
        LockBox(level, out, box = null, flags = 0){
            const volume = volumeFor(level);
            return volume ? volume.LockBox(out, box, flags) : D3DERR_INVALIDCALL;
        },

        /** @param {number} level */
        UnlockBox(level){
            const volume = volumeFor(level);
            return volume ? volume.UnlockBox() : D3DERR_INVALIDCALL;
        },
    };
    return texture;
}

/**
 * What UpdateTexture moves from one volume texture into another: each level
 * the destination has, from the source's matching one -- its top levels
 * skipped when the destination has fewer -- as much of each as the source's
 * dirty box covers, a slice at a time. Null when the two cannot be matched:
 * two formats, or levels of two sizes. The source's dirty box is taken only
 * when they can.
 *
 * `bySize` is Direct3D 8's reading: the source's levels larger than the
 * destination are skipped by size rather than by count, levels of two sizes
 * carry where they overlap (`overlapped` says so), and a format of the same
 * texel size is carried as bytes; one of another size carries nothing
 * (`converted` says so).
 *
 * @param {any} source @param {any} destination  Both volume textures.
 * @param {{ bySize?: boolean }} [options]
 * @returns {{ moves: SurfaceMove[], written: any[], overlapped?: boolean, converted?: boolean }
 *     | null}
 */
export function volumeUpdate(source, destination, { bySize = false } = {}){
    if (source.format !== destination.format && !bySize)
    {
        return null;
    }
    /** @param {any} texture @param {number} level */
    const levelOf = (texture, level)=>{
        /** @type {{ volume?: any }} */
        const held = {};
        if (texture.GetVolumeLevel(level, held) !== D3D_OK || !held.volume)
        {
            return null;
        }
        held.volume.release();
        return held.volume;
    };
    /** @param {any} volume */
    const largest = volume=>Math.max(volume.width, volume.height, volume.depth);
    const top = levelOf(destination, 0);
    let skipped = Math.max(0, source.levels - destination.levels);
    if (bySize && top)
    {
        skipped = 0;
        while (skipped < source.levels - 1 && largest(levelOf(source, skipped)) > largest(top))
        {
            skipped++;
        }
    }
    let overlapped = false;
    /** @type {{ one: any, other: any, level: number }[]} */
    const pairs = [];
    for (let level = 0; level + skipped < source.levels && level < destination.levels; level++)
    {
        const one = levelOf(source, level + skipped);
        const other = levelOf(destination, level);
        if (!one || !other)
        {
            return null;
        }
        if (one.width !== other.width || one.height !== other.height || one.depth !== other.depth)
        {
            if (!bySize)
            {
                return null;
            }
            overlapped = true;
        }
        pairs.push({ one, other, level: level + skipped });
    }
    const region = source.takeDirtyRegion();
    const carried = source.format === destination.format
        || pairs.every(({ one, other })=>one.texelBytes === other.texelBytes);
    /** @type {SurfaceMove[]} */
    const moves = [];
    for (const { one, other, level } of region && carried ? pairs : [])
    {
        const box = boxAtLevel(region, level, Math.min(one.width, other.width),
            Math.min(one.height, other.height), Math.min(one.depth, other.depth));
        const offset = box.top * one.rowPitch + box.left * one.texelBytes;
        for (let slice = box.front; slice < box.back; slice++)
        {
            moves.push({
                from: one.base + slice * one.slicePitch + offset,
                to: other.base + slice * other.slicePitch + box.top * other.rowPitch
                    + box.left * other.texelBytes,
                rowBytes: (box.right - box.left) * one.texelBytes,
                rows: box.bottom - box.top,
                fromPitch: one.rowPitch,
                toPitch: other.rowPitch,
            });
        }
    }
    return {
        moves, written: region && carried ? pairs.map(pair=>pair.other) : [],
        ...(bySize ? { overlapped, converted: !carried } : {}),
    };
}
