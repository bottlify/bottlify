/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A view of the backend for one owner of GPU memory that ends before the
 * backend does - a Direct3D device the program lets go of: what the owner
 * made through it and did not give back itself is given back when it ends.
 *
 * The backend is the module's and outlives every device; a renderer gives
 * back a texture or a buffer as the program releases it, at the present that
 * finds it bound nowhere. A device let go of has no present after it, so
 * what it still held - its back buffers and depth, textures released in its
 * last frame, its rings - stayed on the GPU for the rest of the run, one
 * device's worth per device a program made and dropped (a benchmark makes
 * one a test).
 *
 * @param {any} backend
 * @param {(surface: any) => void} forget  the backend no longer counts on the surface
 *     (the frame it presented last)
 * @returns {any}  the backend's calls, and `giveBack()`
 */
export function scopeOf(backend, forget){
    /** @type {Set<any>} */
    const surfaces = new Set();
    /** @type {Set<any>} */
    const buffers = new Set();
    const scope = Object.create(backend);
    /** @param {any} descriptor */
    scope.createSurface = descriptor=>{
        const made = backend.createSurface(descriptor);
        surfaces.add(made);
        return made;
    };
    /** @param {any} surface */
    scope.destroySurface = surface=>{
        surfaces.delete(surface);
        backend.destroySurface(surface);
    };
    /** @param {any} descriptor */
    scope.createDynamicBuffer = descriptor=>{
        const made = backend.createDynamicBuffer(descriptor);
        buffers.add(made);
        return made;
    };
    /** @param {any} buffer */
    scope.releaseDynamicBuffer = buffer=>{
        buffers.delete(buffer);
        backend.releaseDynamicBuffer(buffer);
    };
    /** What the owner still holds, given back; the scope may make more after. */
    scope.giveBack = ()=>{
        for (const surface of surfaces)
        {
            forget(surface);
            backend.destroySurface(surface);
        }
        surfaces.clear();
        for (const buffer of buffers)
        {
            backend.releaseDynamicBuffer(buffer);
        }
        buffers.clear();
    };
    /** How many of each the owner holds now. */
    scope.held = ()=>({ surfaces: surfaces.size, buffers: buffers.size });
    return scope;
}
