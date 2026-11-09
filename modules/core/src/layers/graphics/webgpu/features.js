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
 *  - rg11b10ufloat-renderable: a target of R11G11B10_FLOAT, the HDR target a
 *    Direct3D 10 or 11 program draws into (tier1 brings it too, where an
 *    adapter has that); without either, every frame drawn into one is refused;
 *  - depth32float-stencil8: a 32-bit depth with stencil keeps its 32 bits;
 *    without it it is kept as depth24plus-stencil8;
 *  - indirect-first-instance: an indirect draw whose arguments a shader wrote
 *    may start past instance zero;
 *  - bgra8unorm-storage: a compute shader may write a BGRA texture;
 *  - dual-source-blending: a blend by the pixel shader's second output
 *    (D3D11_BLEND_SRC1_*); without it such a state's draws are refused;
 *  - timestamp-query, in a diagnostics build only: the GPU's time for each
 *    pass (`internal/gputime.js`).
 */
export const OPTIONAL_GPU_FEATURES = Object.freeze(['texture-compression-bc',
    'texture-compression-astc', 'depth-clip-control', 'clip-distances', 'float32-filterable',
    'float32-blendable', 'depth32float-stencil8', 'texture-formats-tier1',
    'rg11b10ufloat-renderable',
    'indirect-first-instance', 'bgra8unorm-storage', 'dual-source-blending',
    ...(import.meta.BOTTLIFY_DIAGNOSTICS !== false ? ['timestamp-query'] : [])]);

/**
 * The optional features an adapter has.
 *
 * @param {{ features: { has: (name: string) => boolean } }} adapter
 * @returns {string[]}
 */
export const gpuFeaturesOf = adapter=>OPTIONAL_GPU_FEATURES
    .filter(feature=>adapter.features.has(feature));

/**
 * The limits a device is asked for at the most its adapter has, rather than
 * WebGPU's defaults: what Direct3D 10 and 11 promise their programs and the
 * defaults fall short of: textures of 16384 a side, 128 shader resources
 * and 16 samplers a stage, compute groups of 1024 threads and 32 KiB shared,
 * eight unordered views, sixteen vertex streams for Direct3D 9; and with
 * them every limit of the same kind, so a program is refused only where the
 * hardware under it would refuse it.
 */
export const RAISED_GPU_LIMITS = Object.freeze(['maxTextureDimension1D', 'maxTextureDimension2D',
    'maxTextureDimension3D', 'maxTextureArrayLayers', 'maxBindGroups', 'maxBindingsPerBindGroup',
    'maxSampledTexturesPerShaderStage', 'maxSamplersPerShaderStage',
    'maxStorageBuffersPerShaderStage', 'maxStorageTexturesPerShaderStage',
    'maxUniformBuffersPerShaderStage', 'maxUniformBufferBindingSize',
    'maxStorageBufferBindingSize', 'maxDynamicUniformBuffersPerPipelineLayout',
    'maxDynamicStorageBuffersPerPipelineLayout', 'maxVertexBuffers', 'maxVertexAttributes',
    'maxVertexBufferArrayStride', 'maxInterStageShaderVariables', 'maxColorAttachments',
    'maxColorAttachmentBytesPerSample', 'maxBufferSize', 'maxComputeWorkgroupStorageSize',
    'maxComputeInvocationsPerWorkgroup', 'maxComputeWorkgroupSizeX', 'maxComputeWorkgroupSizeY',
    'maxComputeWorkgroupSizeZ', 'maxComputeWorkgroupsPerDimension']);

/**
 * Those limits at what the adapter has, for `requestDevice`'s requiredLimits;
 * a limit the adapter does not name is left at its default.
 *
 * @param {{ limits?: Record<string, number> }} adapter
 * @returns {Record<string, number>}
 */
export const gpuLimitsOf = adapter=>Object.fromEntries(RAISED_GPU_LIMITS
    .filter(name=>typeof adapter.limits?.[name] === 'number')
    .map(name=>[name, /** @type {Record<string, number>} */ (adapter.limits)[name]]));

/**
 * What of a texture's size is past a device's limits, or null. A device
 * refuses such a texture only when the frame it was made in is submitted,
 * and with it that frame and every later one that writes or reads the
 * texture; a renderer asks this first and keeps the texture off the device.
 *
 * @param {{ width: number, height: number, depthOrArrayLayers: number }} size
 * @param {string} dimension  '1d', '2d' or '3d'
 * @param {(name: string) => number | null | undefined} limit  the device's limit by name;
 *     null where it does not say, which nothing is past
 * @returns {string | null}
 */
export const textureBreach = (size, dimension, limit)=>{
    const largest = limit(dimension === '3d' ? 'maxTextureDimension3D'
        : dimension === '1d' ? 'maxTextureDimension1D' : 'maxTextureDimension2D') ?? Infinity;
    const layers = dimension === '3d' ? largest
        : dimension === '1d' ? 1 : limit('maxTextureArrayLayers') ?? Infinity;
    return Math.max(size.width, size.height) > largest || size.depthOrArrayLayers > layers
        ? `${size.width}x${size.height}x${size.depthOrArrayLayers}, past its ${largest}`
            + ` texels a side and ${layers} ${dimension === '3d' ? 'deep' : 'layers'}`
        : null;
};
