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
    D3DERR_INVALIDCALL, D3DFMT, D3DRTYPE, D3D_OK, FORMAT_INFO, offsetOfRect, surfaceBytes,
    surfacePitch,
} from './constants.js';
import { SURFACE_TYPE, surfaceIsLockable } from './validity.js';

/**
 * D3DLOCK_READONLY, which is the same number in both versions of the API. Here
 * rather than imported because it decides which half of a lock's divergence is
 * being reported, and that is this file's own business.
 */
const D3DLOCK_READONLY = 0x00000010;

/**
 * @typedef {Object} ReferenceCount
 * @property {number} value
 * @property {boolean} destroyed
 * @property {() => number} addRef
 * @property {() => number} release
 */

/**
 * @param {{ implicit?: boolean, onFirstRef?: () => void, onLastRef?: () => void }} [options]
 * @returns {ReferenceCount}
 */
export function createReferenceCount(options = {}){
    const implicit = options.implicit === true;
    let count = implicit ? 0 : 1;
    let destroyed = false;

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
            if (count === 0)
            {
                options.onLastRef?.();
                // An implicit resource outlives its own count: the device owns
                // it, so the pointer a program kept stays the same one.
                destroyed = !implicit;
            }
            return count;
        },
    };
}

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
 * @property {() => number} addRef
 * @property {() => number} release
 * @property {(out: LockedRect, rect?: LockRectangle | null, flags?: number)
 *            => number | Promise<number>} LockRect
 *           A promise when the surface is a render target whose pixels are
 *           read back first; the bridge suspends the caller on it.
 * @property {() => number} UnlockRect
 * @property {(out: { desc?: SurfaceDesc }) => number} GetDesc
 * @property {number} lockFlags   The flags of the lock in force, if one is.
 */

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
            if (locked || !lockable)
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
                return forgivesDoubleUnlock ? D3D_OK : D3DERR_INVALIDCALL;
            }
            locked = false;
            if (options.type === SURFACE_TYPE.RENDER_TARGET && options.pixels
                && (lockFlags & D3DLOCK_READONLY) === 0)
            {
                options.pixels.written(self);
            }
            return D3D_OK;
        },

        /** Only meaningful while the surface is locked. */
        get lockFlags(){
            return lockFlags;
        },
    };
    return self;
}

/**
 * One pixel of a D3DCOLOR in a format's own layout, little-endian.
 *
 * @param {number} format @param {number} colour
 * @returns {Uint8Array}
 */
export function packColour(format, colour){
    const a = (colour >>> 24) & 0xff;
    const r = (colour >>> 16) & 0xff;
    const g = (colour >>> 8) & 0xff;
    const b = colour & 0xff;
    /** @param {number} bits */
    const word = bits=>Uint8Array.from([bits & 0xff, (bits >>> 8) & 0xff]);
    switch (format)
    {
        case D3DFMT.A8R8G8B8:
        case D3DFMT.X8R8G8B8:
            return Uint8Array.from([b, g, r, a]);
        case D3DFMT.R5G6B5:
            return word(((r >>> 3) << 11) | ((g >>> 2) << 5) | (b >>> 3));
        case D3DFMT.X1R5G5B5:
        case D3DFMT.A1R5G5B5:
            return word(((a >>> 7) << 15) | ((r >>> 3) << 10) | ((g >>> 3) << 5) | (b >>> 3));
        case D3DFMT.A4R4G4B4:
        case D3DFMT.X4R4G4B4:
            return word(((a >>> 4) << 12) | ((r >>> 4) << 8) | ((g >>> 4) << 4) | (b >>> 4));
        case D3DFMT.A8:
            return Uint8Array.from([a]);
        // Luminance is the colour: the red byte stands in for it, the same
        // way a sample replicates it into the channels it fills.
        case D3DFMT.L8:
            return Uint8Array.from([r]);
        case D3DFMT.A8L8:
            return Uint8Array.from([r, a]);
        case D3DFMT.A4L4:
            return Uint8Array.from([((a >>> 4) << 4) | (r >>> 4)]);
        // A format with no layout here still gets a pixel of its own width,
        // so that a row packed from it is the row's length and nothing else.
        default:
            return Uint8Array.from([b, g, r, a])
                .subarray(0, FORMAT_INFO[format]?.bytesPerPixel ?? 4);
    }
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
    const row = new Uint8Array(desc.Width * bytesPerPixel);
    for (let y = 0; y < desc.Height; y++)
    {
        for (let x = 0; x < desc.Width; x++)
        {
            const at = (y * desc.Width + x) * 4;
            if (bytesPerPixel === 4)
            {
                row.set(pixels.subarray(at, at + 4), x * 4);
                continue;
            }
            row.set(packColour(desc.Format, ((pixels[at + 3] << 24) | (pixels[at + 2] << 16)
                | (pixels[at + 1] << 8) | pixels[at]) >>> 0), x * bytesPerPixel);
        }
        writeMemory(surface.base + y * pitch, row);
    }
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
            base: options.allocate(surfaceBytes(options.format, width, height)),
            count: options.count,
            // Only a surface reached through a 2D texture forgives an unlock it
            // does not owe; a cube face does not, and that difference is
            // measured rather than reasoned about.
            forgivesDoubleUnlock: !cube,
            rejectsMalformedRects: options.rejectsMalformedRects,
        });
        surfaces.set(key, surface);
        return surface;
    };

    return {
        levels: options.levels,
        cube,
        type: cube ? D3DRTYPE.CUBETEXTURE : D3DRTYPE.TEXTURE,
        get refCount(){
            return options.count.value;
        },
        addRef: ()=>options.count.addRef(),

        /**
         * Gives the storage back when the last reference goes.
         *
         * A texture's pixels come out of the one arena everything the guest is
         * handed comes out of, and a program sizes its own asset cache from
         * what that arena reports free. Keeping the pixels of a texture nobody
         * holds does not merely leak address space -- it tells the program it
         * is running out of memory, and a program told that evicts what it has
         * and loads it again, for ever.
         */
        release(){
            const left = options.count.release();
            if (options.count.destroyed)
            {
                for (const surface of surfaces.values())
                {
                    options.free?.(surface.base);
                }
                surfaces.clear();
            }
            return left;
        },

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
}
