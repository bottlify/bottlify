/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Every layout in `structs.js` is spelled out by hand. This derives each one a
 * second time from its registry field list under the 32-bit rules -- four-byte
 * pointers, eight-byte eight-aligned 64-bit fields -- and holds the two to each
 * other, so a slip in either the arithmetic or the rules shows up as a named
 * field at the wrong offset rather than as a picture that is merely wrong.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as S from './structs.js';

/** @typedef {{ size: number, align: number }} Shape */

/** The scalar types of the 32-bit ABI. */
const T = Object.freeze({
    u32: { size: 4, align: 4 },
    i32: { size: 4, align: 4 },
    f32: { size: 4, align: 4 },
    bool32: { size: 4, align: 4 },
    enum: { size: 4, align: 4 },
    flags: { size: 4, align: 4 },
    ptr: { size: 4, align: 4 },
    size_t: { size: 4, align: 4 },
    dispatchable: { size: 4, align: 4 },
    u64: { size: 8, align: 8 },
    deviceSize: { size: 8, align: 8 },
    handle: { size: 8, align: 8 },
    char: { size: 1, align: 1 },
});

/**
 * @param {[string, Shape, number?][]} fields  name, type, array length
 * @returns {Record<string, number> & { SIZE: number }}
 */
function layout(fields){
    /** @type {Record<string, number>} */
    const offsets = {};
    let at = 0;
    let align = 1;
    for (const [name, type, count = 1] of fields)
    {
        at = Math.ceil(at / type.align) * type.align;
        offsets[name] = at;
        at += type.size * count;
        align = Math.max(align, type.align);
    }
    return { ...offsets, SIZE: Math.ceil(at / align) * align };
}

/** @param {[string, Shape, number?][]} fields */
const shape = fields=>{
    const laid = layout(fields);
    return { size: laid.SIZE, align: Math.max(...fields.map(field=>field[1].align)) };
};

/** A structure that begins with a type and a chain pointer. */
const header = /** @type {[string, Shape][]} */ ([['sType', T.enum], ['pNext', T.ptr]]);

/** @param {string} name @param {Record<string, number>} table @param {Record<string, number>} derived */
function same(name, table, derived){
    assert.deepEqual(table, derived, `${name} disagrees with its field list`);
}

const extent2D = shape([['width', T.u32], ['height', T.u32]]);
const extent3D = shape([['width', T.u32], ['height', T.u32], ['depth', T.u32]]);
const offset2D = shape([['x', T.i32], ['y', T.i32]]);
const rect2D = shape([['offset', offset2D], ['extent', extent2D]]);

test('the base types', ()=>{
    same('VkExtent2D', S.VkExtent2D, layout([['width', T.u32], ['height', T.u32]]));
    same('VkExtent3D', S.VkExtent3D,
        layout([['width', T.u32], ['height', T.u32], ['depth', T.u32]]));
    same('VkOffset2D', S.VkOffset2D, layout([['x', T.i32], ['y', T.i32]]));
    same('VkRect2D', S.VkRect2D, layout([['offset', offset2D], ['extent', extent2D]]));
    same('VkViewport', S.VkViewport, layout([['x', T.f32], ['y', T.f32], ['width', T.f32],
        ['height', T.f32], ['minDepth', T.f32], ['maxDepth', T.f32]]));
});

test('instance and device creation pack with no padding: pointers are four bytes', ()=>{
    same('VkApplicationInfo', S.VkApplicationInfo, layout([...header,
        ['pApplicationName', T.ptr], ['applicationVersion', T.u32], ['pEngineName', T.ptr],
        ['engineVersion', T.u32], ['apiVersion', T.u32]]));
    same('VkInstanceCreateInfo', S.VkInstanceCreateInfo, layout([...header, ['flags', T.flags],
        ['pApplicationInfo', T.ptr], ['enabledLayerCount', T.u32], ['ppEnabledLayerNames', T.ptr],
        ['enabledExtensionCount', T.u32], ['ppEnabledExtensionNames', T.ptr]]));
    same('VkDeviceQueueCreateInfo', S.VkDeviceQueueCreateInfo, layout([...header,
        ['flags', T.flags], ['queueFamilyIndex', T.u32], ['queueCount', T.u32],
        ['pQueuePriorities', T.ptr]]));
    same('VkDeviceCreateInfo', S.VkDeviceCreateInfo, layout([...header, ['flags', T.flags],
        ['queueCreateInfoCount', T.u32], ['pQueueCreateInfos', T.ptr],
        ['enabledLayerCount', T.u32], ['ppEnabledLayerNames', T.ptr],
        ['enabledExtensionCount', T.u32], ['ppEnabledExtensionNames', T.ptr],
        ['pEnabledFeatures', T.ptr]]));
    same('VkExtensionProperties', S.VkExtensionProperties,
        layout([['extensionName', T.char, 256], ['specVersion', T.u32]]));
    same('VkLayerProperties', S.VkLayerProperties, layout([['layerName', T.char, 256],
        ['specVersion', T.u32], ['implementationVersion', T.u32], ['description', T.char, 256]]));
});

/** The registry's field list for the limits, in order. */
const LIMITS = /** @type {[string, Shape, number?][]} */ ([
    ['maxImageDimension1D', T.u32], ['maxImageDimension2D', T.u32],
    ['maxImageDimension3D', T.u32], ['maxImageDimensionCube', T.u32],
    ['maxImageArrayLayers', T.u32], ['maxTexelBufferElements', T.u32],
    ['maxUniformBufferRange', T.u32], ['maxStorageBufferRange', T.u32],
    ['maxPushConstantsSize', T.u32], ['maxMemoryAllocationCount', T.u32],
    ['maxSamplerAllocationCount', T.u32], ['bufferImageGranularity', T.deviceSize],
    ['sparseAddressSpaceSize', T.deviceSize], ['maxBoundDescriptorSets', T.u32],
    ['maxPerStageDescriptorSamplers', T.u32], ['maxPerStageDescriptorUniformBuffers', T.u32],
    ['maxPerStageDescriptorStorageBuffers', T.u32], ['maxPerStageDescriptorSampledImages', T.u32],
    ['maxPerStageDescriptorStorageImages', T.u32],
    ['maxPerStageDescriptorInputAttachments', T.u32], ['maxPerStageResources', T.u32],
    ['maxDescriptorSetSamplers', T.u32], ['maxDescriptorSetUniformBuffers', T.u32],
    ['maxDescriptorSetUniformBuffersDynamic', T.u32], ['maxDescriptorSetStorageBuffers', T.u32],
    ['maxDescriptorSetStorageBuffersDynamic', T.u32], ['maxDescriptorSetSampledImages', T.u32],
    ['maxDescriptorSetStorageImages', T.u32], ['maxDescriptorSetInputAttachments', T.u32],
    ['maxVertexInputAttributes', T.u32], ['maxVertexInputBindings', T.u32],
    ['maxVertexInputAttributeOffset', T.u32], ['maxVertexInputBindingStride', T.u32],
    ['maxVertexOutputComponents', T.u32], ['maxTessellationGenerationLevel', T.u32],
    ['maxTessellationPatchSize', T.u32],
    ['maxTessellationControlPerVertexInputComponents', T.u32],
    ['maxTessellationControlPerVertexOutputComponents', T.u32],
    ['maxTessellationControlPerPatchOutputComponents', T.u32],
    ['maxTessellationControlTotalOutputComponents', T.u32],
    ['maxTessellationEvaluationInputComponents', T.u32],
    ['maxTessellationEvaluationOutputComponents', T.u32],
    ['maxGeometryShaderInvocations', T.u32], ['maxGeometryInputComponents', T.u32],
    ['maxGeometryOutputComponents', T.u32], ['maxGeometryOutputVertices', T.u32],
    ['maxGeometryTotalOutputComponents', T.u32], ['maxFragmentInputComponents', T.u32],
    ['maxFragmentOutputAttachments', T.u32], ['maxFragmentDualSrcAttachments', T.u32],
    ['maxFragmentCombinedOutputResources', T.u32], ['maxComputeSharedMemorySize', T.u32],
    ['maxComputeWorkGroupCount', T.u32, 3], ['maxComputeWorkGroupInvocations', T.u32],
    ['maxComputeWorkGroupSize', T.u32, 3], ['subPixelPrecisionBits', T.u32],
    ['subTexelPrecisionBits', T.u32], ['mipmapPrecisionBits', T.u32],
    ['maxDrawIndexedIndexValue', T.u32], ['maxDrawIndirectCount', T.u32],
    ['maxSamplerLodBias', T.f32], ['maxSamplerAnisotropy', T.f32], ['maxViewports', T.u32],
    ['maxViewportDimensions', T.u32, 2], ['viewportBoundsRange', T.f32, 2],
    ['viewportSubPixelBits', T.u32], ['minMemoryMapAlignment', T.size_t],
    ['minTexelBufferOffsetAlignment', T.deviceSize],
    ['minUniformBufferOffsetAlignment', T.deviceSize],
    ['minStorageBufferOffsetAlignment', T.deviceSize], ['minTexelOffset', T.i32],
    ['maxTexelOffset', T.u32], ['minTexelGatherOffset', T.i32], ['maxTexelGatherOffset', T.u32],
    ['minInterpolationOffset', T.f32], ['maxInterpolationOffset', T.f32],
    ['subPixelInterpolationOffsetBits', T.u32], ['maxFramebufferWidth', T.u32],
    ['maxFramebufferHeight', T.u32], ['maxFramebufferLayers', T.u32],
    ['framebufferColorSampleCounts', T.flags], ['framebufferDepthSampleCounts', T.flags],
    ['framebufferStencilSampleCounts', T.flags],
    ['framebufferNoAttachmentsSampleCounts', T.flags], ['maxColorAttachments', T.u32],
    ['sampledImageColorSampleCounts', T.flags], ['sampledImageIntegerSampleCounts', T.flags],
    ['sampledImageDepthSampleCounts', T.flags], ['sampledImageStencilSampleCounts', T.flags],
    ['storageImageSampleCounts', T.flags], ['maxSampleMaskWords', T.u32],
    ['timestampComputeAndGraphics', T.bool32], ['timestampPeriod', T.f32],
    ['maxClipDistances', T.u32], ['maxCullDistances', T.u32],
    ['maxCombinedClipAndCullDistances', T.u32], ['discreteQueuePriorities', T.u32],
    ['pointSizeRange', T.f32, 2], ['lineWidthRange', T.f32, 2], ['pointSizeGranularity', T.f32],
    ['lineWidthGranularity', T.f32], ['strictLines', T.bool32],
    ['standardSampleLocations', T.bool32], ['optimalBufferCopyOffsetAlignment', T.deviceSize],
    ['optimalBufferCopyRowPitchAlignment', T.deviceSize], ['nonCoherentAtomSize', T.deviceSize],
]);

test('the physical device properties: the limits move after each VkDeviceSize', ()=>{
    same('VkPhysicalDeviceLimits', S.VkPhysicalDeviceLimits, layout(LIMITS));
    // The 64-bit build is documented at 504 bytes; the 32-bit one is eight
    // less, because only minMemoryMapAlignment shrinks and it drags a
    // four-byte pad with it.
    assert.equal(S.VkPhysicalDeviceLimits.SIZE, 496);

    const sparse = layout([['residencyStandard2DBlockShape', T.bool32],
        ['residencyStandard2DMultisampleBlockShape', T.bool32],
        ['residencyStandard3DBlockShape', T.bool32], ['residencyAlignedMipSize', T.bool32],
        ['residencyNonResidentStrict', T.bool32]]);
    same('VkPhysicalDeviceSparseProperties', S.VkPhysicalDeviceSparseProperties, sparse);

    same('VkPhysicalDeviceProperties', S.VkPhysicalDeviceProperties, layout([
        ['apiVersion', T.u32], ['driverVersion', T.u32], ['vendorID', T.u32], ['deviceID', T.u32],
        ['deviceType', T.enum], ['deviceName', T.char, 256], ['pipelineCacheUUID', T.char, 16],
        ['limits', { size: S.VkPhysicalDeviceLimits.SIZE, align: 8 }],
        ['sparseProperties', { size: sparse.SIZE, align: 4 }]]));
    assert.equal(S.VkPhysicalDeviceProperties.SIZE, 816);
});

test('the features are fifty-five booleans and the memory properties two fixed arrays', ()=>{
    assert.equal(S.PHYSICAL_DEVICE_FEATURES.length, 55);
    assert.equal(S.VkPhysicalDeviceFeatures.SIZE, 220);
    assert.equal(S.VkPhysicalDeviceFeatures.offsetOf('robustBufferAccess'), 0);
    assert.equal(S.VkPhysicalDeviceFeatures.offsetOf('geometryShader'), 16);
    assert.equal(S.VkPhysicalDeviceFeatures.offsetOf('inheritedQueries'), 216);

    same('VkFormatProperties', S.VkFormatProperties, layout([['linearTilingFeatures', T.flags],
        ['optimalTilingFeatures', T.flags], ['bufferFeatures', T.flags]]));
    same('VkQueueFamilyProperties', S.VkQueueFamilyProperties, layout([['queueFlags', T.flags],
        ['queueCount', T.u32], ['timestampValidBits', T.u32],
        ['minImageTransferGranularity', extent3D]]));
    const memoryType = shape([['propertyFlags', T.flags], ['heapIndex', T.u32]]);
    const memoryHeap = shape([['size', T.deviceSize], ['flags', T.flags]]);
    same('VkMemoryType', S.VkMemoryType,
        layout([['propertyFlags', T.flags], ['heapIndex', T.u32]]));
    same('VkMemoryHeap', S.VkMemoryHeap, layout([['size', T.deviceSize], ['flags', T.flags]]));
    same('VkPhysicalDeviceMemoryProperties', S.VkPhysicalDeviceMemoryProperties, layout([
        ['memoryTypeCount', T.u32], ['memoryTypes', memoryType, 32],
        ['memoryHeapCount', T.u32], ['memoryHeaps', memoryHeap, 16]]));
    assert.equal(S.VkPhysicalDeviceMemoryProperties.SIZE, 520);
});

test('surface and swapchain: the surface handle is the first eight-byte field', ()=>{
    same('VkWin32SurfaceCreateInfoKHR', S.VkWin32SurfaceCreateInfoKHR, layout([...header,
        ['flags', T.flags], ['hinstance', T.ptr], ['hwnd', T.ptr]]));
    same('VkSurfaceCapabilitiesKHR', S.VkSurfaceCapabilitiesKHR, layout([
        ['minImageCount', T.u32], ['maxImageCount', T.u32], ['currentExtent', extent2D],
        ['minImageExtent', extent2D], ['maxImageExtent', extent2D],
        ['maxImageArrayLayers', T.u32], ['supportedTransforms', T.flags],
        ['currentTransform', T.enum], ['supportedCompositeAlpha', T.flags],
        ['supportedUsageFlags', T.flags]]));
    same('VkSurfaceFormatKHR', S.VkSurfaceFormatKHR,
        layout([['format', T.enum], ['colorSpace', T.enum]]));
    same('VkSwapchainCreateInfoKHR', S.VkSwapchainCreateInfoKHR, layout([...header,
        ['flags', T.flags], ['surface', T.handle], ['minImageCount', T.u32],
        ['imageFormat', T.enum], ['imageColorSpace', T.enum], ['imageExtent', extent2D],
        ['imageArrayLayers', T.u32], ['imageUsage', T.flags], ['imageSharingMode', T.enum],
        ['queueFamilyIndexCount', T.u32], ['pQueueFamilyIndices', T.ptr],
        ['preTransform', T.enum], ['compositeAlpha', T.enum], ['presentMode', T.enum],
        ['clipped', T.bool32], ['oldSwapchain', T.handle]]));
    assert.equal(S.VkSwapchainCreateInfoKHR.surface, 16, 'four bytes of padding after flags');
    same('VkPresentInfoKHR', S.VkPresentInfoKHR, layout([...header,
        ['waitSemaphoreCount', T.u32], ['pWaitSemaphores', T.ptr], ['swapchainCount', T.u32],
        ['pSwapchains', T.ptr], ['pImageIndices', T.ptr], ['pResults', T.ptr]]));
});

test('images, views and memory', ()=>{
    same('VkImageCreateInfo', S.VkImageCreateInfo, layout([...header, ['flags', T.flags],
        ['imageType', T.enum], ['format', T.enum], ['extent', extent3D], ['mipLevels', T.u32],
        ['arrayLayers', T.u32], ['samples', T.enum], ['tiling', T.enum], ['usage', T.flags],
        ['sharingMode', T.enum], ['queueFamilyIndexCount', T.u32],
        ['pQueueFamilyIndices', T.ptr], ['initialLayout', T.enum]]));
    const mapping = shape([['r', T.enum], ['g', T.enum], ['b', T.enum], ['a', T.enum]]);
    const range = shape([['aspectMask', T.flags], ['baseMipLevel', T.u32], ['levelCount', T.u32],
        ['baseArrayLayer', T.u32], ['layerCount', T.u32]]);
    same('VkComponentMapping', S.VkComponentMapping,
        layout([['r', T.enum], ['g', T.enum], ['b', T.enum], ['a', T.enum]]));
    same('VkImageSubresourceRange', S.VkImageSubresourceRange, layout([['aspectMask', T.flags],
        ['baseMipLevel', T.u32], ['levelCount', T.u32], ['baseArrayLayer', T.u32],
        ['layerCount', T.u32]]));
    same('VkImageViewCreateInfo', S.VkImageViewCreateInfo, layout([...header, ['flags', T.flags],
        ['image', T.handle], ['viewType', T.enum], ['format', T.enum], ['components', mapping],
        ['subresourceRange', range]]));
    assert.equal(S.VkImageViewCreateInfo.SIZE, 72, 'rounded up to eight for the handle');
    same('VkMemoryRequirements', S.VkMemoryRequirements, layout([['size', T.deviceSize],
        ['alignment', T.deviceSize], ['memoryTypeBits', T.u32]]));
    same('VkMemoryAllocateInfo', S.VkMemoryAllocateInfo, layout([...header,
        ['allocationSize', T.deviceSize], ['memoryTypeIndex', T.u32]]));
    same('VkBufferCreateInfo', S.VkBufferCreateInfo, layout([...header, ['flags', T.flags],
        ['size', T.deviceSize], ['usage', T.flags], ['sharingMode', T.enum],
        ['queueFamilyIndexCount', T.u32], ['pQueueFamilyIndices', T.ptr]]));
});

test('render passes and framebuffers', ()=>{
    same('VkAttachmentDescription', S.VkAttachmentDescription, layout([['flags', T.flags],
        ['format', T.enum], ['samples', T.enum], ['loadOp', T.enum], ['storeOp', T.enum],
        ['stencilLoadOp', T.enum], ['stencilStoreOp', T.enum], ['initialLayout', T.enum],
        ['finalLayout', T.enum]]));
    same('VkAttachmentReference', S.VkAttachmentReference,
        layout([['attachment', T.u32], ['layout', T.enum]]));
    same('VkSubpassDescription', S.VkSubpassDescription, layout([['flags', T.flags],
        ['pipelineBindPoint', T.enum], ['inputAttachmentCount', T.u32],
        ['pInputAttachments', T.ptr], ['colorAttachmentCount', T.u32],
        ['pColorAttachments', T.ptr], ['pResolveAttachments', T.ptr],
        ['pDepthStencilAttachment', T.ptr], ['preserveAttachmentCount', T.u32],
        ['pPreserveAttachments', T.ptr]]));
    same('VkSubpassDependency', S.VkSubpassDependency, layout([['srcSubpass', T.u32],
        ['dstSubpass', T.u32], ['srcStageMask', T.flags], ['dstStageMask', T.flags],
        ['srcAccessMask', T.flags], ['dstAccessMask', T.flags], ['dependencyFlags', T.flags]]));
    same('VkRenderPassCreateInfo', S.VkRenderPassCreateInfo, layout([...header,
        ['flags', T.flags], ['attachmentCount', T.u32], ['pAttachments', T.ptr],
        ['subpassCount', T.u32], ['pSubpasses', T.ptr], ['dependencyCount', T.u32],
        ['pDependencies', T.ptr]]));
    same('VkFramebufferCreateInfo', S.VkFramebufferCreateInfo, layout([...header,
        ['flags', T.flags], ['renderPass', T.handle], ['attachmentCount', T.u32],
        ['pAttachments', T.ptr], ['width', T.u32], ['height', T.u32], ['layers', T.u32]]));
});

test('command buffers, submission and synchronisation', ()=>{
    same('VkCommandPoolCreateInfo', S.VkCommandPoolCreateInfo,
        layout([...header, ['flags', T.flags], ['queueFamilyIndex', T.u32]]));
    same('VkCommandBufferAllocateInfo', S.VkCommandBufferAllocateInfo, layout([...header,
        ['commandPool', T.handle], ['level', T.enum], ['commandBufferCount', T.u32]]));
    same('VkCommandBufferInheritanceInfo', S.VkCommandBufferInheritanceInfo, layout([...header,
        ['renderPass', T.handle], ['subpass', T.u32], ['framebuffer', T.handle],
        ['occlusionQueryEnable', T.bool32], ['queryFlags', T.flags],
        ['pipelineStatistics', T.flags]]));
    same('VkCommandBufferBeginInfo', S.VkCommandBufferBeginInfo,
        layout([...header, ['flags', T.flags], ['pInheritanceInfo', T.ptr]]));
    same('VkClearDepthStencilValue', S.VkClearDepthStencilValue,
        layout([['depth', T.f32], ['stencil', T.u32]]));
    assert.equal(S.VkClearValue.SIZE, 16);
    same('VkRenderPassBeginInfo', S.VkRenderPassBeginInfo, layout([...header,
        ['renderPass', T.handle], ['framebuffer', T.handle], ['renderArea', rect2D],
        ['clearValueCount', T.u32], ['pClearValues', T.ptr]]));
    same('VkSubmitInfo', S.VkSubmitInfo, layout([...header, ['waitSemaphoreCount', T.u32],
        ['pWaitSemaphores', T.ptr], ['pWaitDstStageMask', T.ptr], ['commandBufferCount', T.u32],
        ['pCommandBuffers', T.ptr], ['signalSemaphoreCount', T.u32],
        ['pSignalSemaphores', T.ptr]]));
    same('VkFenceCreateInfo', S.VkFenceCreateInfo, layout([...header, ['flags', T.flags]]));
    same('VkSemaphoreCreateInfo', S.VkSemaphoreCreateInfo,
        layout([...header, ['flags', T.flags]]));
});

test('the graphics pipeline and everything it points to', ()=>{
    same('VkShaderModuleCreateInfo', S.VkShaderModuleCreateInfo,
        layout([...header, ['flags', T.flags], ['codeSize', T.size_t], ['pCode', T.ptr]]));
    same('VkPipelineShaderStageCreateInfo', S.VkPipelineShaderStageCreateInfo, layout([...header,
        ['flags', T.flags], ['stage', T.enum], ['module', T.handle], ['pName', T.ptr],
        ['pSpecializationInfo', T.ptr]]));
    same('VkVertexInputBindingDescription', S.VkVertexInputBindingDescription,
        layout([['binding', T.u32], ['stride', T.u32], ['inputRate', T.enum]]));
    same('VkVertexInputAttributeDescription', S.VkVertexInputAttributeDescription,
        layout([['location', T.u32], ['binding', T.u32], ['format', T.enum],
            ['offset', T.u32]]));
    same('VkPipelineVertexInputStateCreateInfo', S.VkPipelineVertexInputStateCreateInfo,
        layout([...header, ['flags', T.flags], ['vertexBindingDescriptionCount', T.u32],
            ['pVertexBindingDescriptions', T.ptr], ['vertexAttributeDescriptionCount', T.u32],
            ['pVertexAttributeDescriptions', T.ptr]]));
    same('VkPipelineInputAssemblyStateCreateInfo', S.VkPipelineInputAssemblyStateCreateInfo,
        layout([...header, ['flags', T.flags], ['topology', T.enum],
            ['primitiveRestartEnable', T.bool32]]));
    same('VkPipelineTessellationStateCreateInfo', S.VkPipelineTessellationStateCreateInfo,
        layout([...header, ['flags', T.flags], ['patchControlPoints', T.u32]]));
    same('VkPipelineViewportStateCreateInfo', S.VkPipelineViewportStateCreateInfo,
        layout([...header, ['flags', T.flags], ['viewportCount', T.u32], ['pViewports', T.ptr],
            ['scissorCount', T.u32], ['pScissors', T.ptr]]));
    same('VkPipelineRasterizationStateCreateInfo', S.VkPipelineRasterizationStateCreateInfo,
        layout([...header, ['flags', T.flags], ['depthClampEnable', T.bool32],
            ['rasterizerDiscardEnable', T.bool32], ['polygonMode', T.enum],
            ['cullMode', T.flags], ['frontFace', T.enum], ['depthBiasEnable', T.bool32],
            ['depthBiasConstantFactor', T.f32], ['depthBiasClamp', T.f32],
            ['depthBiasSlopeFactor', T.f32], ['lineWidth', T.f32]]));
    same('VkPipelineMultisampleStateCreateInfo', S.VkPipelineMultisampleStateCreateInfo,
        layout([...header, ['flags', T.flags], ['rasterizationSamples', T.enum],
            ['sampleShadingEnable', T.bool32], ['minSampleShading', T.f32],
            ['pSampleMask', T.ptr], ['alphaToCoverageEnable', T.bool32],
            ['alphaToOneEnable', T.bool32]]));
    const stencil = layout([['failOp', T.enum], ['passOp', T.enum], ['depthFailOp', T.enum],
        ['compareOp', T.enum], ['compareMask', T.u32], ['writeMask', T.u32],
        ['reference', T.u32]]);
    same('VkStencilOpState', S.VkStencilOpState, stencil);
    const stencilShape = { size: stencil.SIZE, align: 4 };
    same('VkPipelineDepthStencilStateCreateInfo', S.VkPipelineDepthStencilStateCreateInfo,
        layout([...header, ['flags', T.flags], ['depthTestEnable', T.bool32],
            ['depthWriteEnable', T.bool32], ['depthCompareOp', T.enum],
            ['depthBoundsTestEnable', T.bool32], ['stencilTestEnable', T.bool32],
            ['front', stencilShape], ['back', stencilShape], ['minDepthBounds', T.f32],
            ['maxDepthBounds', T.f32]]));
    same('VkPipelineColorBlendAttachmentState', S.VkPipelineColorBlendAttachmentState,
        layout([['blendEnable', T.bool32], ['srcColorBlendFactor', T.enum],
            ['dstColorBlendFactor', T.enum], ['colorBlendOp', T.enum],
            ['srcAlphaBlendFactor', T.enum], ['dstAlphaBlendFactor', T.enum],
            ['alphaBlendOp', T.enum], ['colorWriteMask', T.flags]]));
    same('VkPipelineColorBlendStateCreateInfo', S.VkPipelineColorBlendStateCreateInfo,
        layout([...header, ['flags', T.flags], ['logicOpEnable', T.bool32], ['logicOp', T.enum],
            ['attachmentCount', T.u32], ['pAttachments', T.ptr], ['blendConstants', T.f32, 4]]));
    same('VkPipelineDynamicStateCreateInfo', S.VkPipelineDynamicStateCreateInfo,
        layout([...header, ['flags', T.flags], ['dynamicStateCount', T.u32],
            ['pDynamicStates', T.ptr]]));
    same('VkPushConstantRange', S.VkPushConstantRange,
        layout([['stageFlags', T.flags], ['offset', T.u32], ['size', T.u32]]));
    same('VkPipelineLayoutCreateInfo', S.VkPipelineLayoutCreateInfo,
        layout([...header, ['flags', T.flags], ['setLayoutCount', T.u32], ['pSetLayouts', T.ptr],
            ['pushConstantRangeCount', T.u32], ['pPushConstantRanges', T.ptr]]));
    same('VkDescriptorSetLayoutBinding', S.VkDescriptorSetLayoutBinding,
        layout([['binding', T.u32], ['descriptorType', T.enum], ['descriptorCount', T.u32],
            ['stageFlags', T.flags], ['pImmutableSamplers', T.ptr]]));
    same('VkDescriptorSetLayoutCreateInfo', S.VkDescriptorSetLayoutCreateInfo,
        layout([...header, ['flags', T.flags], ['bindingCount', T.u32], ['pBindings', T.ptr]]));
    same('VkGraphicsPipelineCreateInfo', S.VkGraphicsPipelineCreateInfo, layout([...header,
        ['flags', T.flags], ['stageCount', T.u32], ['pStages', T.ptr],
        ['pVertexInputState', T.ptr], ['pInputAssemblyState', T.ptr],
        ['pTessellationState', T.ptr], ['pViewportState', T.ptr],
        ['pRasterizationState', T.ptr], ['pMultisampleState', T.ptr],
        ['pDepthStencilState', T.ptr], ['pColorBlendState', T.ptr], ['pDynamicState', T.ptr],
        ['layout', T.handle], ['renderPass', T.handle], ['subpass', T.u32],
        ['basePipelineHandle', T.handle], ['basePipelineIndex', T.i32]]));
    assert.equal(S.VkGraphicsPipelineCreateInfo.layout, 56);
    assert.equal(S.VkGraphicsPipelineCreateInfo.SIZE, 96);
});

// --- the readers and writers ---

/** @param {number} [size] */
function createMemory(size = 0x1000){
    const bytes = new Uint8Array(size);
    return {
        bytes,
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>bytes.subarray(address, address + length),
        /** @param {number} address @param {Uint8Array} source */
        writeMemory: (address, source)=>bytes.set(source, address),
    };
}

test('a 64-bit value is written low word first and read back whole', ()=>{
    const memory = createMemory();
    S.writeU64(memory, 0x10, 0x1_2345_6789);
    assert.deepEqual([...memory.bytes.subarray(0x10, 0x18)],
        [0x89, 0x67, 0x45, 0x23, 0x01, 0, 0, 0]);
    assert.equal(S.readU64(memory, 0x10), 0x1_2345_6789);
    assert.equal(S.joinU64(0x2345_6789, 1), 0x1_2345_6789);
    // The high bit of the low word must not sign-extend into the high word.
    S.writeU64(memory, 0x20, 0xffff_ffff);
    assert.equal(S.readU64(memory, 0x20), 0xffff_ffff);
    assert.equal(S.readU32(memory, 0x24), 0);
});

test('a float shares its four bytes with a dword', ()=>{
    const memory = createMemory();
    S.writeF32(memory, 0x40, 1.5);
    assert.equal(S.readU32(memory, 0x40), 0x3fc00000);
    assert.equal(S.readF32(memory, 0x40), 1.5);
    assert.equal(S.readI32(memory, 0x40), 0x3fc00000);
    S.writeU32(memory, 0x44, 0xffffffff);
    assert.equal(S.readI32(memory, 0x44), -1);
});

test('strings: a fixed field is NUL-padded, and a pointer array reads each name', ()=>{
    const memory = createMemory();
    memory.bytes.fill(0xaa, 0x100, 0x200);
    S.writeFixedString(memory, 0x100, 'VK_KHR_surface', 256);
    assert.equal(S.readCString(memory, 0x100), 'VK_KHR_surface');
    assert.equal(memory.bytes[0x100 + 14], 0);
    assert.equal(memory.bytes[0x1ff], 0, 'the whole field was written');
    // Longer than the field: truncated, and still terminated.
    S.writeFixedString(memory, 0x300, 'abcdefgh', 4);
    assert.equal(S.readCString(memory, 0x300), 'abc');

    memory.bytes.set(new TextEncoder().encode('one\0two\0'), 0x400);
    S.writeU32(memory, 0x500, 0x400);
    S.writeU32(memory, 0x504, 0x404);
    assert.deepEqual(S.readStringArray(memory, 2, 0x500), ['one', 'two']);
    assert.equal(S.readCString(memory, 0), '', 'a null pointer is the empty string');
});

test('a rectangle and an extent go through their nested offsets', ()=>{
    const memory = createMemory();
    S.writeU32(memory, 0x10, -3 >>> 0);
    S.writeU32(memory, 0x14, 7);
    S.writeExtent2D(memory, 0x18, { width: 640, height: 480 });
    assert.deepEqual(S.readRect2D(memory, 0x10), { x: -3, y: 7, width: 640, height: 480 });
    assert.deepEqual(S.readU32Array(memory, 0x18, 2), [640, 480]);
    S.writeU64(memory, 0x20, 5);
    S.writeU64(memory, 0x28, 6);
    assert.deepEqual(S.readU64Array(memory, 0x20, 2), [5, 6]);
    S.writeF32(memory, 0x30, 0.25);
    assert.deepEqual(S.readF32Array(memory, 0x30, 1), [0.25]);
});
