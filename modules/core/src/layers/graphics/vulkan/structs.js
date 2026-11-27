/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The Vulkan structures a program passes by pointer, each declared once as
 * vulkan_core.h (and vulkan_win32.h for the surface) declares it and laid
 * out by `system/layout.js`. The runtime serves 32-bit programs - its
 * commands are stdcall traps - so each export is the structure at four
 * bytes a pointer; `layoutOf(table).at(8)` is the same declaration in a
 * 64-bit process.
 *
 * Three rules of the header produce every offset, and every one of them is a
 * trap for a reader used to the 64-bit build:
 *
 * - **A pointer and a `size_t` are a pointer's size** (`ptr`). So in a 32-bit
 *   process `pNext` is at 4 and the first real field at 8, and a structure of
 *   pointers and counts packs with no padding at all.
 * - **A `VkDeviceSize`, a `uint64_t` and every non-dispatchable handle are
 *   eight bytes, aligned to eight, at either width.** Non-dispatchable
 *   handles are 64-bit even on a 32-bit build - the header says so, in a
 *   `#define` most people never read - so `VkSwapchainCreateInfoKHR.surface`
 *   sits at 16, not 12, with four bytes of padding after `flags`. A
 *   structure holding one is eight-aligned, its size a multiple of eight.
 * - **A dispatchable handle is a pointer.** `VkDevice`, `VkQueue` and
 *   `VkCommandBuffer` are four bytes in a 32-bit process, so an array of
 *   command buffers is an array of dwords while an array of semaphores is an
 *   array of qwords.
 */

import { layoutOf, struct, union } from '../../../system/layout.js';
import { readToTerminator } from '../../win32/common/scan-windows.js';

/** @typedef {import('../../../system/layout.js').Declared} Declared */

/** A non-dispatchable handle: a 64-bit value at either width. */
const HANDLE = 'u64';
/** VkDeviceSize. */
const DEVICE_SIZE = 'u64';

/** The two fields every extensible structure begins with. */
const HEAD = /** @type {const} */ ([['sType', 'u32'], ['pNext', 'ptr']]);

/** @param {readonly Declared[]} fields */
const at4 = fields=>struct(fields).at(4);
/** @param {readonly string[]} names @param {'u32' | 'i32' | 'f32'} kind @returns {Declared[]} */
const all = (names, kind)=>names.map(name=>[name, kind]);

// --- base types ------------------------------------------------------------

export const VkExtent2D = at4(all(['width', 'height'], 'u32'));
export const VkExtent3D = at4(all(['width', 'height', 'depth'], 'u32'));
export const VkOffset2D = at4(all(['x', 'y'], 'i32'));
export const VkRect2D = at4([['offset', layoutOf(VkOffset2D)],
    ['extent', layoutOf(VkExtent2D)]]);
export const VkViewport = at4(all(['x', 'y', 'width', 'height', 'minDepth', 'maxDepth'],
    'f32'));

// --- instance and device creation -----------------------------------------

/** VK_MAX_EXTENSION_NAME_SIZE and VK_MAX_DESCRIPTION_SIZE. */
const MAX_NAME = 256;

export const VkApplicationInfo = at4([...HEAD, ['pApplicationName', 'ptr'],
    ['applicationVersion', 'u32'], ['pEngineName', 'ptr'], ['engineVersion', 'u32'],
    ['apiVersion', 'u32']]);

export const VkInstanceCreateInfo = at4([...HEAD, ['flags', 'u32'],
    ['pApplicationInfo', 'ptr'], ['enabledLayerCount', 'u32'], ['ppEnabledLayerNames', 'ptr'],
    ['enabledExtensionCount', 'u32'], ['ppEnabledExtensionNames', 'ptr']]);

export const VkDeviceQueueCreateInfo = at4([...HEAD, ['flags', 'u32'],
    ['queueFamilyIndex', 'u32'], ['queueCount', 'u32'], ['pQueuePriorities', 'ptr']]);

export const VkDeviceCreateInfo = at4([...HEAD, ['flags', 'u32'],
    ['queueCreateInfoCount', 'u32'], ['pQueueCreateInfos', 'ptr'],
    ['enabledLayerCount', 'u32'], ['ppEnabledLayerNames', 'ptr'],
    ['enabledExtensionCount', 'u32'], ['ppEnabledExtensionNames', 'ptr'],
    ['pEnabledFeatures', 'ptr']]);

export const VkExtensionProperties = at4([['extensionName', 'u8', MAX_NAME],
    ['specVersion', 'u32']]);

export const VkLayerProperties = at4([['layerName', 'u8', MAX_NAME], ['specVersion', 'u32'],
    ['implementationVersion', 'u32'], ['description', 'u8', MAX_NAME]]);

// --- the physical device ---------------------------------------------------

/**
 * The limits. Three `VkDeviceSize` fields in the middle and three at the end
 * are what make this structure's layout differ from a list of dwords: the
 * first of each run is preceded by four bytes of padding, and everything after
 * it moves. `minMemoryMapAlignment` is the one `size_t`, which is why the
 * 32-bit structure is eight bytes shorter than the 64-bit one.
 */
export const VkPhysicalDeviceLimits = at4([
    ...all(['maxImageDimension1D', 'maxImageDimension2D', 'maxImageDimension3D',
        'maxImageDimensionCube', 'maxImageArrayLayers', 'maxTexelBufferElements',
        'maxUniformBufferRange', 'maxStorageBufferRange', 'maxPushConstantsSize',
        'maxMemoryAllocationCount', 'maxSamplerAllocationCount'], 'u32'),
    ['bufferImageGranularity', DEVICE_SIZE], ['sparseAddressSpaceSize', DEVICE_SIZE],
    ...all(['maxBoundDescriptorSets', 'maxPerStageDescriptorSamplers',
        'maxPerStageDescriptorUniformBuffers', 'maxPerStageDescriptorStorageBuffers',
        'maxPerStageDescriptorSampledImages', 'maxPerStageDescriptorStorageImages',
        'maxPerStageDescriptorInputAttachments', 'maxPerStageResources',
        'maxDescriptorSetSamplers', 'maxDescriptorSetUniformBuffers',
        'maxDescriptorSetUniformBuffersDynamic', 'maxDescriptorSetStorageBuffers',
        'maxDescriptorSetStorageBuffersDynamic', 'maxDescriptorSetSampledImages',
        'maxDescriptorSetStorageImages', 'maxDescriptorSetInputAttachments',
        'maxVertexInputAttributes', 'maxVertexInputBindings', 'maxVertexInputAttributeOffset',
        'maxVertexInputBindingStride', 'maxVertexOutputComponents',
        'maxTessellationGenerationLevel', 'maxTessellationPatchSize',
        'maxTessellationControlPerVertexInputComponents',
        'maxTessellationControlPerVertexOutputComponents',
        'maxTessellationControlPerPatchOutputComponents',
        'maxTessellationControlTotalOutputComponents',
        'maxTessellationEvaluationInputComponents', 'maxTessellationEvaluationOutputComponents',
        'maxGeometryShaderInvocations', 'maxGeometryInputComponents',
        'maxGeometryOutputComponents', 'maxGeometryOutputVertices',
        'maxGeometryTotalOutputComponents', 'maxFragmentInputComponents',
        'maxFragmentOutputAttachments', 'maxFragmentDualSrcAttachments',
        'maxFragmentCombinedOutputResources', 'maxComputeSharedMemorySize'], 'u32'),
    ['maxComputeWorkGroupCount', 'u32', 3], ['maxComputeWorkGroupInvocations', 'u32'],
    ['maxComputeWorkGroupSize', 'u32', 3],
    ...all(['subPixelPrecisionBits', 'subTexelPrecisionBits', 'mipmapPrecisionBits',
        'maxDrawIndexedIndexValue', 'maxDrawIndirectCount'], 'u32'),
    ['maxSamplerLodBias', 'f32'], ['maxSamplerAnisotropy', 'f32'], ['maxViewports', 'u32'],
    ['maxViewportDimensions', 'u32', 2], ['viewportBoundsRange', 'f32', 2],
    ['viewportSubPixelBits', 'u32'], ['minMemoryMapAlignment', 'ptr'],
    ['minTexelBufferOffsetAlignment', DEVICE_SIZE],
    ['minUniformBufferOffsetAlignment', DEVICE_SIZE],
    ['minStorageBufferOffsetAlignment', DEVICE_SIZE], ['minTexelOffset', 'i32'],
    ['maxTexelOffset', 'u32'], ['minTexelGatherOffset', 'i32'], ['maxTexelGatherOffset', 'u32'],
    ['minInterpolationOffset', 'f32'], ['maxInterpolationOffset', 'f32'],
    ...all(['subPixelInterpolationOffsetBits', 'maxFramebufferWidth', 'maxFramebufferHeight',
        'maxFramebufferLayers', 'framebufferColorSampleCounts', 'framebufferDepthSampleCounts',
        'framebufferStencilSampleCounts', 'framebufferNoAttachmentsSampleCounts',
        'maxColorAttachments', 'sampledImageColorSampleCounts',
        'sampledImageIntegerSampleCounts', 'sampledImageDepthSampleCounts',
        'sampledImageStencilSampleCounts', 'storageImageSampleCounts', 'maxSampleMaskWords',
        'timestampComputeAndGraphics'], 'u32'),
    ['timestampPeriod', 'f32'],
    ...all(['maxClipDistances', 'maxCullDistances', 'maxCombinedClipAndCullDistances',
        'discreteQueuePriorities'], 'u32'),
    ['pointSizeRange', 'f32', 2], ['lineWidthRange', 'f32', 2], ['pointSizeGranularity', 'f32'],
    ['lineWidthGranularity', 'f32'], ['strictLines', 'u32'], ['standardSampleLocations', 'u32'],
    ['optimalBufferCopyOffsetAlignment', DEVICE_SIZE],
    ['optimalBufferCopyRowPitchAlignment', DEVICE_SIZE], ['nonCoherentAtomSize', DEVICE_SIZE],
]);

export const VkPhysicalDeviceSparseProperties = at4(all(['residencyStandard2DBlockShape',
    'residencyStandard2DMultisampleBlockShape', 'residencyStandard3DBlockShape',
    'residencyAlignedMipSize', 'residencyNonResidentStrict'], 'u32'));

/** VK_UUID_SIZE. */
const UUID_SIZE = 16;

export const VkPhysicalDeviceProperties = at4([
    ...all(['apiVersion', 'driverVersion', 'vendorID', 'deviceID', 'deviceType'], 'u32'),
    ['deviceName', 'u8', MAX_NAME], ['pipelineCacheUUID', 'u8', UUID_SIZE],
    ['limits', layoutOf(VkPhysicalDeviceLimits)],
    ['sparseProperties', layoutOf(VkPhysicalDeviceSparseProperties)],
]);

/**
 * Fifty-five `VkBool32`s, in registry order. The order is the layout, so it
 * is listed rather than described.
 */
export const PHYSICAL_DEVICE_FEATURES = Object.freeze([
    'robustBufferAccess', 'fullDrawIndexUint32', 'imageCubeArray', 'independentBlend',
    'geometryShader', 'tessellationShader', 'sampleRateShading', 'dualSrcBlend', 'logicOp',
    'multiDrawIndirect', 'drawIndirectFirstInstance', 'depthClamp', 'depthBiasClamp',
    'fillModeNonSolid', 'depthBounds', 'wideLines', 'largePoints', 'alphaToOne',
    'multiViewport', 'samplerAnisotropy', 'textureCompressionETC2',
    'textureCompressionASTC_LDR', 'textureCompressionBC', 'occlusionQueryPrecise',
    'pipelineStatisticsQuery', 'vertexPipelineStoresAndAtomics', 'fragmentStoresAndAtomics',
    'shaderTessellationAndGeometryPointSize', 'shaderImageGatherExtended',
    'shaderStorageImageExtendedFormats', 'shaderStorageImageMultisample',
    'shaderStorageImageReadWithoutFormat', 'shaderStorageImageWriteWithoutFormat',
    'shaderUniformBufferArrayDynamicIndexing', 'shaderSampledImageArrayDynamicIndexing',
    'shaderStorageBufferArrayDynamicIndexing', 'shaderStorageImageArrayDynamicIndexing',
    'shaderClipDistance', 'shaderCullDistance', 'shaderFloat64', 'shaderInt64', 'shaderInt16',
    'shaderResourceResidency', 'shaderResourceMinLod', 'sparseBinding',
    'sparseResidencyBuffer', 'sparseResidencyImage2D', 'sparseResidencyImage3D',
    'sparseResidency2Samples', 'sparseResidency4Samples', 'sparseResidency8Samples',
    'sparseResidency16Samples', 'sparseResidencyAliased', 'variableMultisampleRate',
    'inheritedQueries',
]);

export const VkPhysicalDeviceFeatures = at4(all(PHYSICAL_DEVICE_FEATURES, 'u32'));

export const VkFormatProperties = at4(all(['linearTilingFeatures', 'optimalTilingFeatures',
    'bufferFeatures'], 'u32'));

export const VkQueueFamilyProperties = at4([
    ...all(['queueFlags', 'queueCount', 'timestampValidBits'], 'u32'),
    ['minImageTransferGranularity', layoutOf(VkExtent3D)],
]);

export const VkMemoryType = at4(all(['propertyFlags', 'heapIndex'], 'u32'));
/** A `VkDeviceSize` then a dword: sixteen bytes, four of them padding. */
export const VkMemoryHeap = at4([['size', DEVICE_SIZE], ['flags', 'u32']]);

/** VK_MAX_MEMORY_TYPES and VK_MAX_MEMORY_HEAPS. */
const MAX_MEMORY_TYPES = 32;
const MAX_MEMORY_HEAPS = 16;

export const VkPhysicalDeviceMemoryProperties = at4([['memoryTypeCount', 'u32'],
    ['memoryTypes', layoutOf(VkMemoryType), MAX_MEMORY_TYPES], ['memoryHeapCount', 'u32'],
    ['memoryHeaps', layoutOf(VkMemoryHeap), MAX_MEMORY_HEAPS]]);

// --- surface and swapchain -------------------------------------------------

/** vulkan_win32.h's: the module and the window are a HINSTANCE and an HWND. */
export const VkWin32SurfaceCreateInfoKHR = at4([...HEAD, ['flags', 'u32'],
    ['hinstance', 'handle'], ['hwnd', 'handle']]);

export const VkSurfaceCapabilitiesKHR = at4([['minImageCount', 'u32'],
    ['maxImageCount', 'u32'], ['currentExtent', layoutOf(VkExtent2D)],
    ['minImageExtent', layoutOf(VkExtent2D)], ['maxImageExtent', layoutOf(VkExtent2D)],
    ...all(['maxImageArrayLayers', 'supportedTransforms', 'currentTransform',
        'supportedCompositeAlpha', 'supportedUsageFlags'], 'u32')]);

export const VkSurfaceFormatKHR = at4(all(['format', 'colorSpace'], 'u32'));

export const VkSwapchainCreateInfoKHR = at4([...HEAD, ['flags', 'u32'], ['surface', HANDLE],
    ...all(['minImageCount', 'imageFormat', 'imageColorSpace'], 'u32'),
    ['imageExtent', layoutOf(VkExtent2D)],
    ...all(['imageArrayLayers', 'imageUsage', 'imageSharingMode', 'queueFamilyIndexCount'],
        'u32'),
    ['pQueueFamilyIndices', 'ptr'],
    ...all(['preTransform', 'compositeAlpha', 'presentMode', 'clipped'], 'u32'),
    ['oldSwapchain', HANDLE]]);

export const VkPresentInfoKHR = at4([...HEAD, ['waitSemaphoreCount', 'u32'],
    ['pWaitSemaphores', 'ptr'], ['swapchainCount', 'u32'], ['pSwapchains', 'ptr'],
    ['pImageIndices', 'ptr'], ['pResults', 'ptr']]);

// --- images ----------------------------------------------------------------

export const VkImageCreateInfo = at4([...HEAD,
    ...all(['flags', 'imageType', 'format'], 'u32'), ['extent', layoutOf(VkExtent3D)],
    ...all(['mipLevels', 'arrayLayers', 'samples', 'tiling', 'usage', 'sharingMode',
        'queueFamilyIndexCount'], 'u32'),
    ['pQueueFamilyIndices', 'ptr'], ['initialLayout', 'u32']]);

export const VkComponentMapping = at4(all(['r', 'g', 'b', 'a'], 'u32'));

export const VkImageSubresourceRange = at4(all(['aspectMask', 'baseMipLevel', 'levelCount',
    'baseArrayLayer', 'layerCount'], 'u32'));

export const VkImageViewCreateInfo = at4([...HEAD, ['flags', 'u32'], ['image', HANDLE],
    ['viewType', 'u32'], ['format', 'u32'], ['components', layoutOf(VkComponentMapping)],
    ['subresourceRange', layoutOf(VkImageSubresourceRange)]]);

export const VkMemoryRequirements = at4([['size', DEVICE_SIZE], ['alignment', DEVICE_SIZE],
    ['memoryTypeBits', 'u32']]);

export const VkMemoryAllocateInfo = at4([...HEAD, ['allocationSize', DEVICE_SIZE],
    ['memoryTypeIndex', 'u32']]);

export const VkBufferCreateInfo = at4([...HEAD, ['flags', 'u32'], ['size', DEVICE_SIZE],
    ...all(['usage', 'sharingMode', 'queueFamilyIndexCount'], 'u32'),
    ['pQueueFamilyIndices', 'ptr']]);

// --- render passes and framebuffers ---------------------------------------

export const VkAttachmentDescription = at4(all(['flags', 'format', 'samples', 'loadOp',
    'storeOp', 'stencilLoadOp', 'stencilStoreOp', 'initialLayout', 'finalLayout'], 'u32'));

export const VkAttachmentReference = at4(all(['attachment', 'layout'], 'u32'));

export const VkSubpassDescription = at4([
    ...all(['flags', 'pipelineBindPoint', 'inputAttachmentCount'], 'u32'),
    ['pInputAttachments', 'ptr'], ['colorAttachmentCount', 'u32'], ['pColorAttachments', 'ptr'],
    ['pResolveAttachments', 'ptr'], ['pDepthStencilAttachment', 'ptr'],
    ['preserveAttachmentCount', 'u32'], ['pPreserveAttachments', 'ptr'],
]);

export const VkSubpassDependency = at4(all(['srcSubpass', 'dstSubpass', 'srcStageMask',
    'dstStageMask', 'srcAccessMask', 'dstAccessMask', 'dependencyFlags'], 'u32'));

export const VkRenderPassCreateInfo = at4([...HEAD, ['flags', 'u32'],
    ['attachmentCount', 'u32'], ['pAttachments', 'ptr'], ['subpassCount', 'u32'],
    ['pSubpasses', 'ptr'], ['dependencyCount', 'u32'], ['pDependencies', 'ptr']]);

export const VkFramebufferCreateInfo = at4([...HEAD, ['flags', 'u32'],
    ['renderPass', HANDLE], ['attachmentCount', 'u32'], ['pAttachments', 'ptr'],
    ...all(['width', 'height', 'layers'], 'u32')]);

// --- command buffers -------------------------------------------------------

export const VkCommandPoolCreateInfo = at4([...HEAD, ['flags', 'u32'],
    ['queueFamilyIndex', 'u32']]);

export const VkCommandBufferAllocateInfo = at4([...HEAD, ['commandPool', HANDLE],
    ['level', 'u32'], ['commandBufferCount', 'u32']]);

export const VkCommandBufferInheritanceInfo = at4([...HEAD, ['renderPass', HANDLE],
    ['subpass', 'u32'], ['framebuffer', HANDLE],
    ...all(['occlusionQueryEnable', 'queryFlags', 'pipelineStatistics'], 'u32')]);

export const VkCommandBufferBeginInfo = at4([...HEAD, ['flags', 'u32'],
    ['pInheritanceInfo', 'ptr']]);

/** A union of four floats, four ints or four uints: sixteen bytes either way. */
const CLEAR_COLOR = union([['float32', 'f32', 4], ['int32', 'i32', 4], ['uint32', 'u32', 4]]);
export const VkClearColorValue = CLEAR_COLOR.at(4);
export const VkClearDepthStencilValue = at4([['depth', 'f32'], ['stencil', 'u32']]);
/** The larger of the two members, which is the colour. */
export const VkClearValue = union([['color', CLEAR_COLOR],
    ['depthStencil', layoutOf(VkClearDepthStencilValue)]]).at(4);

export const VkRenderPassBeginInfo = at4([...HEAD, ['renderPass', HANDLE],
    ['framebuffer', HANDLE], ['renderArea', layoutOf(VkRect2D)], ['clearValueCount', 'u32'],
    ['pClearValues', 'ptr']]);

export const VkSubmitInfo = at4([...HEAD, ['waitSemaphoreCount', 'u32'],
    ['pWaitSemaphores', 'ptr'], ['pWaitDstStageMask', 'ptr'], ['commandBufferCount', 'u32'],
    ['pCommandBuffers', 'ptr'], ['signalSemaphoreCount', 'u32'], ['pSignalSemaphores', 'ptr']]);

export const VkFenceCreateInfo = at4([...HEAD, ['flags', 'u32']]);
export const VkSemaphoreCreateInfo = at4([...HEAD, ['flags', 'u32']]);

// --- pipelines ---------------------------------------------------------------

export const VkShaderModuleCreateInfo = at4([...HEAD, ['flags', 'u32'], ['codeSize', 'ptr'],
    ['pCode', 'ptr']]);

export const VkPipelineShaderStageCreateInfo = at4([...HEAD, ['flags', 'u32'],
    ['stage', 'u32'], ['module', HANDLE], ['pName', 'ptr'], ['pSpecializationInfo', 'ptr']]);

export const VkVertexInputBindingDescription = at4(all(['binding', 'stride', 'inputRate'],
    'u32'));

export const VkVertexInputAttributeDescription = at4(all(['location', 'binding', 'format',
    'offset'], 'u32'));

export const VkPipelineVertexInputStateCreateInfo = at4([...HEAD, ['flags', 'u32'],
    ['vertexBindingDescriptionCount', 'u32'], ['pVertexBindingDescriptions', 'ptr'],
    ['vertexAttributeDescriptionCount', 'u32'], ['pVertexAttributeDescriptions', 'ptr']]);

export const VkPipelineInputAssemblyStateCreateInfo = at4([...HEAD,
    ...all(['flags', 'topology', 'primitiveRestartEnable'], 'u32')]);

export const VkPipelineTessellationStateCreateInfo = at4([...HEAD,
    ...all(['flags', 'patchControlPoints'], 'u32')]);

export const VkPipelineViewportStateCreateInfo = at4([...HEAD, ['flags', 'u32'],
    ['viewportCount', 'u32'], ['pViewports', 'ptr'], ['scissorCount', 'u32'],
    ['pScissors', 'ptr']]);

export const VkPipelineRasterizationStateCreateInfo = at4([...HEAD,
    ...all(['flags', 'depthClampEnable', 'rasterizerDiscardEnable', 'polygonMode', 'cullMode',
        'frontFace', 'depthBiasEnable'], 'u32'),
    ...all(['depthBiasConstantFactor', 'depthBiasClamp', 'depthBiasSlopeFactor', 'lineWidth'],
        'f32')]);

export const VkPipelineMultisampleStateCreateInfo = at4([...HEAD,
    ...all(['flags', 'rasterizationSamples', 'sampleShadingEnable'], 'u32'),
    ['minSampleShading', 'f32'], ['pSampleMask', 'ptr'],
    ...all(['alphaToCoverageEnable', 'alphaToOneEnable'], 'u32')]);

export const VkStencilOpState = at4(all(['failOp', 'passOp', 'depthFailOp', 'compareOp',
    'compareMask', 'writeMask', 'reference'], 'u32'));

export const VkPipelineDepthStencilStateCreateInfo = at4([...HEAD,
    ...all(['flags', 'depthTestEnable', 'depthWriteEnable', 'depthCompareOp',
        'depthBoundsTestEnable', 'stencilTestEnable'], 'u32'),
    ['front', layoutOf(VkStencilOpState)], ['back', layoutOf(VkStencilOpState)],
    ...all(['minDepthBounds', 'maxDepthBounds'], 'f32')]);

export const VkPipelineColorBlendAttachmentState = at4(all(['blendEnable',
    'srcColorBlendFactor', 'dstColorBlendFactor', 'colorBlendOp', 'srcAlphaBlendFactor',
    'dstAlphaBlendFactor', 'alphaBlendOp', 'colorWriteMask'], 'u32'));

export const VkPipelineColorBlendStateCreateInfo = at4([...HEAD,
    ...all(['flags', 'logicOpEnable', 'logicOp', 'attachmentCount'], 'u32'),
    ['pAttachments', 'ptr'], ['blendConstants', 'f32', 4]]);

export const VkPipelineDynamicStateCreateInfo = at4([...HEAD, ['flags', 'u32'],
    ['dynamicStateCount', 'u32'], ['pDynamicStates', 'ptr']]);

export const VkPushConstantRange = at4(all(['stageFlags', 'offset', 'size'], 'u32'));

export const VkPipelineLayoutCreateInfo = at4([...HEAD, ['flags', 'u32'],
    ['setLayoutCount', 'u32'], ['pSetLayouts', 'ptr'], ['pushConstantRangeCount', 'u32'],
    ['pPushConstantRanges', 'ptr']]);

export const VkDescriptorSetLayoutBinding = at4([
    ...all(['binding', 'descriptorType', 'descriptorCount', 'stageFlags'], 'u32'),
    ['pImmutableSamplers', 'ptr'],
]);

export const VkDescriptorSetLayoutCreateInfo = at4([...HEAD, ['flags', 'u32'],
    ['bindingCount', 'u32'], ['pBindings', 'ptr']]);

/**
 * Ten pointers to state blocks, then two handles: in a 32-bit process
 * `layout` is the first eight-byte field and sits at 56 after the pointers
 * pack with no gap.
 */
export const VkGraphicsPipelineCreateInfo = at4([...HEAD, ['flags', 'u32'],
    ['stageCount', 'u32'], ['pStages', 'ptr'], ['pVertexInputState', 'ptr'],
    ['pInputAssemblyState', 'ptr'], ['pTessellationState', 'ptr'], ['pViewportState', 'ptr'],
    ['pRasterizationState', 'ptr'], ['pMultisampleState', 'ptr'],
    ['pDepthStencilState', 'ptr'], ['pColorBlendState', 'ptr'], ['pDynamicState', 'ptr'],
    ['layout', HANDLE], ['renderPass', HANDLE], ['subpass', 'u32'],
    ['basePipelineHandle', HANDLE], ['basePipelineIndex', 'i32']]);

// --- reading and writing ----------------------------------------------------

/**
 * @typedef {Object} GuestMemory
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 */

const scratch = new DataView(new ArrayBuffer(8));

/** @param {GuestMemory} memory @param {number} address @returns {number} */
export function readU32(memory, address){
    const bytes = memory.readMemory(address >>> 0, 4);
    return (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
}

/** @param {GuestMemory} memory @param {number} address @returns {number} */
export function readI32(memory, address){
    return readU32(memory, address) | 0;
}

/** @param {GuestMemory} memory @param {number} address @returns {number} */
export function readF32(memory, address){
    scratch.setUint32(0, readU32(memory, address), true);
    return scratch.getFloat32(0, true);
}

/**
 * A 64-bit value as a number. Handles and sizes this loader hands out are far
 * below 2^53, and a value above it is one the program did not get from here,
 * so it is read exactly rather than truncated and the caller's lookup fails
 * honestly.
 *
 * @param {GuestMemory} memory @param {number} address @returns {number}
 */
export function readU64(memory, address){
    return readU32(memory, address) + readU32(memory, address + 4) * 0x100000000;
}

/** @param {number} low @param {number} high @returns {number} two stack words as one */
export function joinU64(low, high){
    return (low >>> 0) + (high >>> 0) * 0x100000000;
}

/** @param {GuestMemory} memory @param {number} address @param {number} value */
export function writeU32(memory, address, value){
    const word = value >>> 0;
    memory.writeMemory(address >>> 0, new Uint8Array([
        word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff, (word >>> 24) & 0xff,
    ]));
}

/** @param {GuestMemory} memory @param {number} address @param {number} value */
export function writeF32(memory, address, value){
    scratch.setFloat32(0, value, true);
    writeU32(memory, address, scratch.getUint32(0, true));
}

/** @param {GuestMemory} memory @param {number} address @param {number} value */
export function writeU64(memory, address, value){
    writeU32(memory, address, value >>> 0);
    writeU32(memory, address + 4, Math.floor(value / 0x100000000));
}

/**
 * A NUL-terminated string, read up to `max` bytes a window at a time, so one
 * at the end of what the program allocated is not read past. Vulkan strings
 * are UTF-8; the names that matter here are ASCII.
 *
 * @param {GuestMemory} memory @param {number} address @param {number} [max]
 * @returns {string}
 */
export function readCString(memory, address, max = 256){
    if ((address >>> 0) === 0)
    {
        return '';
    }
    return new TextDecoder().decode(readToTerminator(memory, address, 1, max).bytes);
}

/**
 * A string into a fixed field, NUL-padded to the field's width so that a
 * program reading the whole field finds nothing stale after the terminator.
 *
 * @param {GuestMemory} memory @param {number} address @param {string} value
 * @param {number} width
 */
export function writeFixedString(memory, address, value, width){
    const field = new Uint8Array(width);
    field.set(new TextEncoder().encode(value).subarray(0, width - 1));
    memory.writeMemory(address >>> 0, field);
}

/**
 * The array of string pointers behind an `enabled*Count`/`ppEnabled*Names`
 * pair.
 *
 * @param {GuestMemory} memory @param {number} count @param {number} array
 * @returns {string[]}
 */
export function readStringArray(memory, count, array){
    const names = [];
    for (let index = 0; index < count; index++)
    {
        names.push(readCString(memory, readU32(memory, array + index * 4)));
    }
    return names;
}

/** @param {GuestMemory} memory @param {number} address @param {number} count */
export function readU32Array(memory, address, count){
    return Array.from({ length: count }, (unused, index)=>readU32(memory, address + index * 4));
}

/** @param {GuestMemory} memory @param {number} address @param {number} count */
export function readU64Array(memory, address, count){
    return Array.from({ length: count }, (unused, index)=>readU64(memory, address + index * 8));
}

/** @param {GuestMemory} memory @param {number} address @param {number} count */
export function readF32Array(memory, address, count){
    return Array.from({ length: count }, (unused, index)=>readF32(memory, address + index * 4));
}

/**
 * @param {GuestMemory} memory @param {number} address
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
export function readRect2D(memory, address){
    return {
        x: readI32(memory, address + VkRect2D.offset + VkOffset2D.x),
        y: readI32(memory, address + VkRect2D.offset + VkOffset2D.y),
        width: readU32(memory, address + VkRect2D.extent + VkExtent2D.width),
        height: readU32(memory, address + VkRect2D.extent + VkExtent2D.height),
    };
}

/**
 * @param {GuestMemory} memory @param {number} address
 * @param {{ width: number, height: number }} extent
 */
export function writeExtent2D(memory, address, extent){
    writeU32(memory, address + VkExtent2D.width, extent.width);
    writeU32(memory, address + VkExtent2D.height, extent.height);
}
