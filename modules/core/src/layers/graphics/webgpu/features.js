/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The optional WebGPU features a device for this layer asks for, each only
 * where its adapter has it, and one list for every place a device is made --
 * the graphics worker's and the page's -- so a draw does not take one path
 * on one and another on the other:
 *
 *  - texture-compression-bc: DXT textures stay compressed on the GPU;
 *  - texture-compression-astc: where there is no BC, a phone's GPU, DXT1
 *    textures stay compressed as ASTC (`internal/astc.js`);
 *  - depth-clip-control: a draw can leave depth unclipped (D3D10's
 *    DepthClipEnable = FALSE);
 *  - clip-distances: the user clip planes are the rasteriser's; without it a
 *    clipped draw's fragment stage discards instead;
 *  - float32-filterable and float32-blendable: with both, a 32-bit float
 *    surface keeps its 32 bits; without them it is kept at half precision;
 *  - texture-formats-tier1: the 16-bit normalised formats, among others;
 *  - depth32float-stencil8: a 32-bit depth with stencil keeps its 32 bits;
 *    without it it is kept as depth24plus-stencil8;
 *  - indirect-first-instance: an indirect draw whose arguments a shader wrote
 *    may start past instance zero;
 *  - bgra8unorm-storage: a compute shader may write a BGRA texture;
 *  - timestamp-query, in a diagnostics build only: the GPU's time for each
 *    pass (`internal/gputime.js`).
 */
export const OPTIONAL_GPU_FEATURES = Object.freeze(['texture-compression-bc',
    'texture-compression-astc', 'depth-clip-control', 'clip-distances', 'float32-filterable',
    'float32-blendable', 'depth32float-stencil8', 'texture-formats-tier1',
    'indirect-first-instance', 'bgra8unorm-storage',
    ...(import.meta.BOTTLIFY_DIAGNOSTICS !== false ? ['timestamp-query'] : [])]);

/**
 * The optional features an adapter has.
 *
 * @param {{ features: { has: (name: string) => boolean } }} adapter
 * @returns {string[]}
 */
export const gpuFeaturesOf = adapter=>OPTIONAL_GPU_FEATURES
    .filter(feature=>adapter.features.has(feature));
