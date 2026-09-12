/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The one physical device, described.
 *
 * What it reports about itself is what WebGPU guarantees of every adapter,
 * not what this machine's adapter happens to offer -- a limit a program reads
 * here is a promise the whole path underneath keeps, and the defaults are the
 * only numbers that promise holds on every machine.
 *
 * The count-then-array protocol every enumeration uses lives here too. It has
 * exactly one shape: a null array asks for the count; an array with room for
 * fewer than there are gets that many and `VK_INCOMPLETE`.
 */

import {
    VK_FALSE, VK_TRUE, VkColorSpaceKHR, VkFormat, VkFormatFeatureFlagBits, VkImageUsageFlagBits,
    VkMemoryHeapFlagBits, VkMemoryPropertyFlagBits, VkPresentModeKHR, VkQueueFlagBits, VkResult,
    GPU_FORMAT,
} from './constants.js';
import { VkPhysicalDeviceLimits, readU32, writeF32, writeU32, writeU64 } from './structs.js';

/**
 * The part of the rendering backend the device level uses.
 *
 * @typedef {Object} Backend
 * @property {(descriptor: { count: number, width: number, height: number, format: string,
 *            label: string }) => { surfaces: import('../webgpu/contract.js').Surface[] }}
 *           createSwapChain
 * @property {(descriptor: { width: number, height: number, format: string, usage?: number,
 *            label: string }) => import('../webgpu/contract.js').Surface} createSurface
 * @property {() => Frame} beginFrame
 * @property {() => void} markPresent
 */

/**
 * @typedef {Object} Frame
 * @property {(descriptor: { target: import('../webgpu/contract.js').Surface, clear: boolean,
 *            clearValue?: { r: number, g: number, b: number, a: number },
 *            depthStencilAttachment?: DepthAttachment, label?: string }) => unknown} beginPass
 * @property {(surface: import('../webgpu/contract.js').Surface) => void} present
 * @property {() => void} end
 */

/**
 * A depth-stencil attachment as WebGPU takes it.
 *
 * @typedef {Object} DepthAttachment
 * @property {unknown} view
 * @property {'load' | 'clear'} depthLoadOp
 * @property {'store' | 'discard'} depthStoreOp
 * @property {number} [depthClearValue]
 * @property {'load' | 'clear'} [stencilLoadOp]
 * @property {'store' | 'discard'} [stencilStoreOp]
 * @property {number} [stencilClearValue]
 */

/**
 * Everything a command handler needs from outside the API.
 *
 * @typedef {Object} VulkanContext
 * @property {import('./structs.js').GuestMemory} memory
 * @property {ReturnType<import('./handles.js').createHandles>} handles
 * @property {(detail: string) => void} diverge
 *           Where behaviour differs from the specification, said once per
 *           distinct message.
 * @property {() => Backend} backend
 *           The GPU, built when first asked for; throws when there is none.
 * @property {() => { width: number, height: number }} screen
 * @property {(width: number, height: number) => void} [resolution]
 *           Told the extent a swapchain is created at, which becomes the screen.
 * @property {boolean} compressedTextures
 * @property {() => { vendor?: string, description?: string } | null} adapter
 */

/**
 * The count-then-array protocol.
 *
 * @template T
 * @param {VulkanContext} context
 * @param {number} pCount
 * @param {number} pArray
 * @param {readonly T[]} items
 * @param {number} stride
 * @param {(address: number, item: T) => void} write
 * @returns {number} VkResult
 */
export function enumerate(context, pCount, pArray, items, stride, write){
    const { memory } = context;
    if (pCount === 0)
    {
        context.diverge('an enumeration was asked to write its count through a null pointer');
        return VkResult.ERROR_INITIALIZATION_FAILED;
    }
    if (pArray === 0)
    {
        writeU32(memory, pCount, items.length);
        return VkResult.SUCCESS;
    }
    const room = readU32(memory, pCount);
    const count = Math.min(room, items.length);
    for (let index = 0; index < count; index++)
    {
        write(pArray + index * stride, items[index]);
    }
    writeU32(memory, pCount, count);
    return count < items.length ? VkResult.INCOMPLETE : VkResult.SUCCESS;
}

/**
 * The limits reported, in the registry's field names. Arrays are the registry's
 * arrays. Every number is WebGPU's default limit or the specification's
 * required minimum, whichever this path actually keeps.
 *
 * @type {Readonly<Record<string, number | readonly number[]>>}
 */
export const LIMITS = Object.freeze({
    maxImageDimension1D: 8192,
    maxImageDimension2D: 8192,
    maxImageDimension3D: 2048,
    maxImageDimensionCube: 8192,
    maxImageArrayLayers: 256,
    maxTexelBufferElements: 65536,
    maxUniformBufferRange: 65536,
    maxStorageBufferRange: 134217728,
    // Push constants are carried in a uniform block, so the specification's
    // minimum is what the block is sized to.
    maxPushConstantsSize: 128,
    maxMemoryAllocationCount: 4096,
    maxSamplerAllocationCount: 4000,
    bufferImageGranularity: 1,
    sparseAddressSpaceSize: 0,
    maxBoundDescriptorSets: 4,
    maxPerStageDescriptorSamplers: 16,
    maxPerStageDescriptorUniformBuffers: 12,
    maxPerStageDescriptorStorageBuffers: 8,
    maxPerStageDescriptorSampledImages: 16,
    maxPerStageDescriptorStorageImages: 4,
    maxPerStageDescriptorInputAttachments: 0,
    maxPerStageResources: 128,
    maxDescriptorSetSamplers: 96,
    maxDescriptorSetUniformBuffers: 72,
    maxDescriptorSetUniformBuffersDynamic: 8,
    maxDescriptorSetStorageBuffers: 24,
    maxDescriptorSetStorageBuffersDynamic: 4,
    maxDescriptorSetSampledImages: 96,
    maxDescriptorSetStorageImages: 24,
    maxDescriptorSetInputAttachments: 0,
    maxVertexInputAttributes: 16,
    maxVertexInputBindings: 8,
    maxVertexInputAttributeOffset: 2047,
    maxVertexInputBindingStride: 2048,
    maxVertexOutputComponents: 64,
    maxTessellationGenerationLevel: 0,
    maxTessellationPatchSize: 0,
    maxTessellationControlPerVertexInputComponents: 0,
    maxTessellationControlPerVertexOutputComponents: 0,
    maxTessellationControlPerPatchOutputComponents: 0,
    maxTessellationControlTotalOutputComponents: 0,
    maxTessellationEvaluationInputComponents: 0,
    maxTessellationEvaluationOutputComponents: 0,
    maxGeometryShaderInvocations: 0,
    maxGeometryInputComponents: 0,
    maxGeometryOutputComponents: 0,
    maxGeometryOutputVertices: 0,
    maxGeometryTotalOutputComponents: 0,
    maxFragmentInputComponents: 64,
    maxFragmentOutputAttachments: 8,
    maxFragmentDualSrcAttachments: 0,
    maxFragmentCombinedOutputResources: 8,
    maxComputeSharedMemorySize: 16384,
    maxComputeWorkGroupCount: [65535, 65535, 65535],
    maxComputeWorkGroupInvocations: 256,
    maxComputeWorkGroupSize: [256, 256, 64],
    subPixelPrecisionBits: 4,
    subTexelPrecisionBits: 4,
    mipmapPrecisionBits: 4,
    maxDrawIndexedIndexValue: 0xffffffff,
    maxDrawIndirectCount: 1,
    maxSamplerLodBias: 2,
    maxSamplerAnisotropy: 16,
    maxViewports: 1,
    maxViewportDimensions: [8192, 8192],
    viewportBoundsRange: [-16384, 16383],
    viewportSubPixelBits: 0,
    minMemoryMapAlignment: 64,
    minTexelBufferOffsetAlignment: 256,
    minUniformBufferOffsetAlignment: 256,
    minStorageBufferOffsetAlignment: 256,
    minTexelOffset: -8,
    maxTexelOffset: 7,
    minTexelGatherOffset: 0,
    maxTexelGatherOffset: 0,
    minInterpolationOffset: 0,
    maxInterpolationOffset: 0,
    subPixelInterpolationOffsetBits: 0,
    maxFramebufferWidth: 8192,
    maxFramebufferHeight: 8192,
    maxFramebufferLayers: 1,
    framebufferColorSampleCounts: 0x5,
    framebufferDepthSampleCounts: 0x5,
    framebufferStencilSampleCounts: 0x5,
    framebufferNoAttachmentsSampleCounts: 0x5,
    maxColorAttachments: 8,
    sampledImageColorSampleCounts: 0x5,
    sampledImageIntegerSampleCounts: 0x1,
    sampledImageDepthSampleCounts: 0x5,
    sampledImageStencilSampleCounts: 0x5,
    storageImageSampleCounts: 0x1,
    maxSampleMaskWords: 1,
    timestampComputeAndGraphics: VK_FALSE,
    timestampPeriod: 1,
    maxClipDistances: 0,
    maxCullDistances: 0,
    maxCombinedClipAndCullDistances: 0,
    discreteQueuePriorities: 2,
    pointSizeRange: [1, 1],
    lineWidthRange: [1, 1],
    pointSizeGranularity: 0,
    lineWidthGranularity: 0,
    strictLines: VK_FALSE,
    standardSampleLocations: VK_TRUE,
    optimalBufferCopyOffsetAlignment: 4,
    optimalBufferCopyRowPitchAlignment: 256,
    nonCoherentAtomSize: 256,
});

/** The limits that are `VkDeviceSize`, and so written as eight bytes. */
const LIMITS_U64 = new Set([
    'bufferImageGranularity', 'sparseAddressSpaceSize', 'minTexelBufferOffsetAlignment',
    'minUniformBufferOffsetAlignment', 'minStorageBufferOffsetAlignment',
    'optimalBufferCopyOffsetAlignment', 'optimalBufferCopyRowPitchAlignment',
    'nonCoherentAtomSize',
]);

/** The limits that are floats. */
const LIMITS_F32 = new Set([
    'maxSamplerLodBias', 'maxSamplerAnisotropy', 'viewportBoundsRange', 'minInterpolationOffset',
    'maxInterpolationOffset', 'timestampPeriod', 'pointSizeRange', 'lineWidthRange',
    'pointSizeGranularity', 'lineWidthGranularity',
]);

/**
 * The limits, written where a program asked for them.
 *
 * @param {import('./structs.js').GuestMemory} memory @param {number} address
 */
export function writeLimits(memory, address){
    for (const [name, offset] of Object.entries(VkPhysicalDeviceLimits))
    {
        if (name === 'SIZE')
        {
            continue;
        }
        const value = LIMITS[name];
        const values = typeof value === 'number' ? [value] : value;
        values.forEach((each, index)=>{
            if (LIMITS_U64.has(name))
            {
                writeU64(memory, address + offset + index * 8, each);
            }
            else if (LIMITS_F32.has(name))
            {
                writeF32(memory, address + offset + index * 4, each);
            }
            else
            {
                writeU32(memory, address + offset + index * 4, each);
            }
        });
    }
}

/**
 * The features that are true. Everything the registry lists and this does not
 * is reported false, and a device created asking for one of those is refused
 * with `VK_ERROR_FEATURE_NOT_PRESENT`, as the specification says.
 *
 * @param {boolean} compressedTextures
 * @returns {Set<string>}
 */
export function supportedFeatures(compressedTextures){
    const features = new Set([
        'robustBufferAccess', 'fullDrawIndexUint32', 'imageCubeArray', 'independentBlend',
        'depthBiasClamp', 'samplerAnisotropy', 'fragmentStoresAndAtomics',
        'shaderUniformBufferArrayDynamicIndexing', 'shaderSampledImageArrayDynamicIndexing',
        'shaderStorageBufferArrayDynamicIndexing', 'shaderStorageImageArrayDynamicIndexing',
    ]);
    if (compressedTextures)
    {
        features.add('textureCompressionBC');
    }
    return features;
}

/**
 * The one queue family: graphics, compute and transfer on one queue, which is
 * what WebGPU's single queue is.
 */
export const QUEUE_FAMILY = Object.freeze({
    queueFlags: VkQueueFlagBits.GRAPHICS | VkQueueFlagBits.COMPUTE | VkQueueFlagBits.TRANSFER,
    queueCount: 1,
    timestampValidBits: 0,
    minImageTransferGranularity: { width: 1, height: 1, depth: 1 },
});

/**
 * Memory as a program sees it. Two heaps and three types is the shape of a
 * discrete card, and it is the shape every allocator handles: device-local
 * for what the GPU owns, host-visible for what the program writes, and a type
 * that is both for the small things a program maps and draws from directly.
 */
export const MEMORY = Object.freeze({
    heaps: [
        { size: 1024 * 1024 * 1024, flags: VkMemoryHeapFlagBits.DEVICE_LOCAL },
        { size: 512 * 1024 * 1024, flags: 0 },
    ],
    types: [
        { propertyFlags: VkMemoryPropertyFlagBits.DEVICE_LOCAL, heapIndex: 0 },
        {
            propertyFlags: VkMemoryPropertyFlagBits.HOST_VISIBLE
                | VkMemoryPropertyFlagBits.HOST_COHERENT,
            heapIndex: 1,
        },
        {
            propertyFlags: VkMemoryPropertyFlagBits.DEVICE_LOCAL
                | VkMemoryPropertyFlagBits.HOST_VISIBLE | VkMemoryPropertyFlagBits.HOST_COHERENT,
            heapIndex: 0,
        },
    ],
});

/** What a surface offers, in the order a program that takes the first gets. */
export const SURFACE_FORMATS = Object.freeze([
    { format: VkFormat.B8G8R8A8_UNORM, colorSpace: VkColorSpaceKHR.SRGB_NONLINEAR_KHR },
    { format: VkFormat.B8G8R8A8_SRGB, colorSpace: VkColorSpaceKHR.SRGB_NONLINEAR_KHR },
    { format: VkFormat.R8G8B8A8_UNORM, colorSpace: VkColorSpaceKHR.SRGB_NONLINEAR_KHR },
    { format: VkFormat.R8G8B8A8_SRGB, colorSpace: VkColorSpaceKHR.SRGB_NONLINEAR_KHR },
]);

/**
 * FIFO alone. It is the one mode every implementation must offer, and the
 * only one this path can be honest about: when a frame is shown is the pacer's
 * decision, and the pacer is a queue.
 */
export const PRESENT_MODES = Object.freeze([VkPresentModeKHR.FIFO_KHR]);

export const SURFACE_USAGE = VkImageUsageFlagBits.COLOR_ATTACHMENT
    | VkImageUsageFlagBits.TRANSFER_SRC | VkImageUsageFlagBits.TRANSFER_DST;

/** The formats with a vertex-buffer use: the float and integer attribute types. */
/** @type {Set<number>} */
const VERTEX_FORMATS = new Set([
    VkFormat.R32_SFLOAT, VkFormat.R32G32_SFLOAT, VkFormat.R32G32B32_SFLOAT,
    VkFormat.R32G32B32A32_SFLOAT, VkFormat.R32_UINT, VkFormat.R16_UINT,
]);

/** The formats with depth in them. */
/** @type {Set<number>} */
const DEPTH_FORMATS = new Set([
    VkFormat.D16_UNORM, VkFormat.D32_SFLOAT, VkFormat.D24_UNORM_S8_UINT,
    VkFormat.D32_SFLOAT_S8_UINT,
]);

/**
 * What a format can be used for. All zeros is how the specification says
 * "not supported", so an unknown format needs no special case.
 *
 * @param {number} format
 * @returns {{ linear: number, optimal: number, buffer: number }}
 */
export function formatFeatures(format){
    const F = VkFormatFeatureFlagBits;
    if (DEPTH_FORMATS.has(format))
    {
        return { linear: 0, optimal: F.DEPTH_STENCIL_ATTACHMENT | F.SAMPLED_IMAGE, buffer: 0 };
    }
    if (GPU_FORMAT[format] !== undefined)
    {
        return {
            linear: 0,
            optimal: F.SAMPLED_IMAGE | F.SAMPLED_IMAGE_FILTER_LINEAR | F.COLOR_ATTACHMENT
                | F.COLOR_ATTACHMENT_BLEND | F.BLIT_SRC | F.BLIT_DST,
            buffer: 0,
        };
    }
    if (VERTEX_FORMATS.has(format))
    {
        return { linear: 0, optimal: 0, buffer: F.VERTEX_BUFFER };
    }
    return { linear: 0, optimal: 0, buffer: 0 };
}

