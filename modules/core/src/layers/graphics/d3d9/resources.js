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
    D3DERR_INVALIDCALL, D3DRTYPE, D3D_OK, offsetOfRect, surfaceBytes, surfacePitch,
} from './constants.js';
import { SURFACE_TYPE, surfaceIsLockable } from './validity.js';

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
 * @typedef {Object} SurfaceDesc
 * @property {number} Type
 * @property {number} Format
 * @property {number} Usage
 * @property {number} Pool
 * @property {number} Width
 * @property {number} Height
 */

/**
 * @typedef {Object} Surface
 * @property {number} base            Byte address the surface's own storage starts at.
 * @property {number} refCount
 * @property {() => number} addRef
 * @property {() => number} release
 * @property {(out: LockedRect, rect?: LockRectangle | null, flags?: number) => number} LockRect
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
 * @property {number} [resourceType]  D3DRTYPE_SURFACE unless a texture level says otherwise.
 * @property {((api: string, detail: string) => void) | null} [divergence]
 *           Where "this call succeeded and did not do all of what it promises"
 *           goes. A render target lives on the GPU and its bytes are not read
 *           back into the guest's copy, so a lock of one hands out somewhere to
 *           read that holds something other than what was drawn.
 */

/**
 * @param {SurfaceOptions} options
 * @returns {Surface}
 */
export function createSurface(options){
    const pitch = surfacePitch(options.format, options.width);
    const lockable = surfaceIsLockable(options);
    const forgivesDoubleUnlock = options.forgivesDoubleUnlock === true;
    let locked = false;
    let lockFlags = 0;

    /** @type {SurfaceDesc} */
    const desc = {
        Type: options.resourceType ?? D3DRTYPE.SURFACE,
        Format: options.format,
        Usage: options.usage,
        Pool: options.pool,
        Width: options.width,
        Height: options.height,
    };

    return {
        base: options.base,
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
         * round, is accepted: a later Windows rejected those, but programs were
         * written against the version that did not, and rejecting them breaks
         * them for no gain.
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
            // What is drawn lives on the GPU, and nothing copies it back into
            // the guest's own bytes. The lock is right to succeed -- refusing
            // it sends a program that asked for a lockable surface down a path
            // it was not written for -- but what it hands out is not the
            // picture, and reading a surface back is the only way to know what
            // is in it.
            if (options.type === SURFACE_TYPE.RENDER_TARGET
                || options.type === SURFACE_TYPE.DEPTH_STENCIL)
            {
                options.divergence?.('Direct3D',
                    `a lock of a ${options.type} surface is accepted and hands out guest`
                    + ' memory that the rendered pixels are never copied into');
            }
            locked = true;
            out.Pitch = pitch;
            out.pBits = options.base
                + (rect ? offsetOfRect(options.format, pitch, rect) : 0);
            // The flags decide whether the backend may rename the storage or
            // must write into it; whoever consumes this must see them.
            lockFlags = flags;
            return D3D_OK;
        },

        UnlockRect(){
            if (!locked)
            {
                return forgivesDoubleUnlock ? D3D_OK : D3DERR_INVALIDCALL;
            }
            locked = false;
            return D3D_OK;
        },

        /** Only meaningful while the surface is locked. */
        get lockFlags(){
            return lockFlags;
        },
    };
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
        });
        surfaces.set(key, surface);
        return surface;
    };

    return {
        levels: options.levels,
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
