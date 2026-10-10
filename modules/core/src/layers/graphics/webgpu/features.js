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
 *  - depth-clip-control: a draw can leave depth unclipped (D3D10's
 *    DepthClipEnable = FALSE);
 *  - clip-distances: the user clip planes are the rasteriser's; without it a
 *    clipped draw's fragment stage discards instead.
 */
export const OPTIONAL_GPU_FEATURES = Object.freeze(
    ['texture-compression-bc', 'depth-clip-control', 'clip-distances']);

/**
 * The optional features an adapter has.
 *
 * @param {{ features: { has: (name: string) => boolean } }} adapter
 * @returns {string[]}
 */
export const gpuFeaturesOf = adapter=>OPTIONAL_GPU_FEATURES
    .filter(feature=>adapter.features.has(feature));
