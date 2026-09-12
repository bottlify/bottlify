/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The Vulkan structures a program passes by pointer, laid out the way a
 * 32-bit Windows compiler lays them out.
 *
 * Three rules produce every offset below, and every one of them is a trap for
 * a reader used to the 64-bit headers:
 *
 * - **A pointer and a `size_t` are four bytes.** So `pNext` is at 4 and the
 *   first real field at 8, and a structure of pointers and counts packs with
 *   no padding at all.
 * - **A `VkDeviceSize`, a `uint64_t` and every non-dispatchable handle are
 *   eight bytes, aligned to eight.** Non-dispatchable handles are 64-bit even
 *   on a 32-bit build -- the header says so, in a `#define` most people never
 *   read -- so `VkSwapchainCreateInfoKHR.surface` sits at 16, not 12, with four
 *   bytes of padding after `flags`. A structure containing one of these is
 *   itself eight-aligned, and its size rounds up to a multiple of eight.
 * - **A dispatchable handle is a pointer.** `VkDevice`, `VkQueue` and
 *   `VkCommandBuffer` are four bytes, so an array of command buffers is an
 *   array of dwords while an array of semaphores is an array of qwords.
 *
 * Every offset is spelled out rather than computed, because a computed one is
 * only as right as the rule that computed it and the test derives them all a
 * second time from the field types to hold this file to the registry.
 */

// --- base types ------------------------------------------------------------

export const VkExtent2D = Object.freeze({ width: 0x00, height: 0x04, SIZE: 0x08 });
export const VkExtent3D = Object.freeze({ width: 0x00, height: 0x04, depth: 0x08, SIZE: 0x0c });
export const VkOffset2D = Object.freeze({ x: 0x00, y: 0x04, SIZE: 0x08 });
export const VkRect2D = Object.freeze({ offset: 0x00, extent: 0x08, SIZE: 0x10 });
export const VkViewport = Object.freeze({
    x: 0x00, y: 0x04, width: 0x08, height: 0x0c, minDepth: 0x10, maxDepth: 0x14, SIZE: 0x18,
});

// --- instance and device creation -----------------------------------------

export const VkApplicationInfo = Object.freeze({
    sType: 0x00,
    pNext: 0x04,
    pApplicationName: 0x08,
    applicationVersion: 0x0c,
    pEngineName: 0x10,
    engineVersion: 0x14,
    apiVersion: 0x18,
    SIZE: 0x1c,
});

export const VkInstanceCreateInfo = Object.freeze({
    sType: 0x00,
    pNext: 0x04,
    flags: 0x08,
    pApplicationInfo: 0x0c,
    enabledLayerCount: 0x10,
    ppEnabledLayerNames: 0x14,
    enabledExtensionCount: 0x18,
    ppEnabledExtensionNames: 0x1c,
    SIZE: 0x20,
});

export const VkDeviceQueueCreateInfo = Object.freeze({
    sType: 0x00,
    pNext: 0x04,
    flags: 0x08,
    queueFamilyIndex: 0x0c,
    queueCount: 0x10,
    pQueuePriorities: 0x14,
    SIZE: 0x18,
});

export const VkDeviceCreateInfo = Object.freeze({
    sType: 0x00,
    pNext: 0x04,
    flags: 0x08,
    queueCreateInfoCount: 0x0c,
    pQueueCreateInfos: 0x10,
    enabledLayerCount: 0x14,
    ppEnabledLayerNames: 0x18,
    enabledExtensionCount: 0x1c,
    ppEnabledExtensionNames: 0x20,
    pEnabledFeatures: 0x24,
    SIZE: 0x28,
});

export const VkExtensionProperties = Object.freeze({
    extensionName: 0x000,
    specVersion: 0x100,
    SIZE: 0x104,
});

export const VkLayerProperties = Object.freeze({
    layerName: 0x000,
    specVersion: 0x100,
    implementationVersion: 0x104,
    description: 0x108,
    SIZE: 0x208,
});

// --- the physical device ---------------------------------------------------

/**
 * The limits. Three `VkDeviceSize` fields in the middle and three at the end
 * are what make this structure's layout differ from a list of dwords: the
 * first of each run is preceded by four bytes of padding, and everything after
 * it moves.
 */
export const VkPhysicalDeviceLimits = Object.freeze({
    maxImageDimension1D: 0x000,
    maxImageDimension2D: 0x004,
    maxImageDimension3D: 0x008,
    maxImageDimensionCube: 0x00c,
    maxImageArrayLayers: 0x010,
    maxTexelBufferElements: 0x014,
    maxUniformBufferRange: 0x018,
    maxStorageBufferRange: 0x01c,
    maxPushConstantsSize: 0x020,
    maxMemoryAllocationCount: 0x024,
    maxSamplerAllocationCount: 0x028,
    bufferImageGranularity: 0x030,
    sparseAddressSpaceSize: 0x038,
    maxBoundDescriptorSets: 0x040,
    maxPerStageDescriptorSamplers: 0x044,
    maxPerStageDescriptorUniformBuffers: 0x048,
    maxPerStageDescriptorStorageBuffers: 0x04c,
    maxPerStageDescriptorSampledImages: 0x050,
    maxPerStageDescriptorStorageImages: 0x054,
    maxPerStageDescriptorInputAttachments: 0x058,
    maxPerStageResources: 0x05c,
    maxDescriptorSetSamplers: 0x060,
    maxDescriptorSetUniformBuffers: 0x064,
    maxDescriptorSetUniformBuffersDynamic: 0x068,
    maxDescriptorSetStorageBuffers: 0x06c,
    maxDescriptorSetStorageBuffersDynamic: 0x070,
    maxDescriptorSetSampledImages: 0x074,
    maxDescriptorSetStorageImages: 0x078,
    maxDescriptorSetInputAttachments: 0x07c,
    maxVertexInputAttributes: 0x080,
    maxVertexInputBindings: 0x084,
    maxVertexInputAttributeOffset: 0x088,
    maxVertexInputBindingStride: 0x08c,
    maxVertexOutputComponents: 0x090,
    maxTessellationGenerationLevel: 0x094,
    maxTessellationPatchSize: 0x098,
    maxTessellationControlPerVertexInputComponents: 0x09c,
    maxTessellationControlPerVertexOutputComponents: 0x0a0,
    maxTessellationControlPerPatchOutputComponents: 0x0a4,
    maxTessellationControlTotalOutputComponents: 0x0a8,
    maxTessellationEvaluationInputComponents: 0x0ac,
    maxTessellationEvaluationOutputComponents: 0x0b0,
    maxGeometryShaderInvocations: 0x0b4,
    maxGeometryInputComponents: 0x0b8,
    maxGeometryOutputComponents: 0x0bc,
    maxGeometryOutputVertices: 0x0c0,
    maxGeometryTotalOutputComponents: 0x0c4,
    maxFragmentInputComponents: 0x0c8,
    maxFragmentOutputAttachments: 0x0cc,
    maxFragmentDualSrcAttachments: 0x0d0,
    maxFragmentCombinedOutputResources: 0x0d4,
    maxComputeSharedMemorySize: 0x0d8,
    maxComputeWorkGroupCount: 0x0dc,
    maxComputeWorkGroupInvocations: 0x0e8,
    maxComputeWorkGroupSize: 0x0ec,
    subPixelPrecisionBits: 0x0f8,
    subTexelPrecisionBits: 0x0fc,
    mipmapPrecisionBits: 0x100,
    maxDrawIndexedIndexValue: 0x104,
    maxDrawIndirectCount: 0x108,
    maxSamplerLodBias: 0x10c,
    maxSamplerAnisotropy: 0x110,
    maxViewports: 0x114,
    maxViewportDimensions: 0x118,
    viewportBoundsRange: 0x120,
    viewportSubPixelBits: 0x128,
    minMemoryMapAlignment: 0x12c,
    minTexelBufferOffsetAlignment: 0x130,
    minUniformBufferOffsetAlignment: 0x138,
    minStorageBufferOffsetAlignment: 0x140,
    minTexelOffset: 0x148,
    maxTexelOffset: 0x14c,
    minTexelGatherOffset: 0x150,
    maxTexelGatherOffset: 0x154,
    minInterpolationOffset: 0x158,
    maxInterpolationOffset: 0x15c,
    subPixelInterpolationOffsetBits: 0x160,
    maxFramebufferWidth: 0x164,
    maxFramebufferHeight: 0x168,
    maxFramebufferLayers: 0x16c,
    framebufferColorSampleCounts: 0x170,
    framebufferDepthSampleCounts: 0x174,
    framebufferStencilSampleCounts: 0x178,
    framebufferNoAttachmentsSampleCounts: 0x17c,
    maxColorAttachments: 0x180,
    sampledImageColorSampleCounts: 0x184,
    sampledImageIntegerSampleCounts: 0x188,
    sampledImageDepthSampleCounts: 0x18c,
    sampledImageStencilSampleCounts: 0x190,
    storageImageSampleCounts: 0x194,
    maxSampleMaskWords: 0x198,
    timestampComputeAndGraphics: 0x19c,
    timestampPeriod: 0x1a0,
    maxClipDistances: 0x1a4,
    maxCullDistances: 0x1a8,
    maxCombinedClipAndCullDistances: 0x1ac,
    discreteQueuePriorities: 0x1b0,
    pointSizeRange: 0x1b4,
    lineWidthRange: 0x1bc,
    pointSizeGranularity: 0x1c4,
    lineWidthGranularity: 0x1c8,
    strictLines: 0x1cc,
    standardSampleLocations: 0x1d0,
    optimalBufferCopyOffsetAlignment: 0x1d8,
    optimalBufferCopyRowPitchAlignment: 0x1e0,
    nonCoherentAtomSize: 0x1e8,
    SIZE: 0x1f0,
});

export const VkPhysicalDeviceSparseProperties = Object.freeze({
    residencyStandard2DBlockShape: 0x00,
    residencyStandard2DMultisampleBlockShape: 0x04,
    residencyStandard3DBlockShape: 0x08,
    residencyAlignedMipSize: 0x0c,
    residencyNonResidentStrict: 0x10,
    SIZE: 0x14,
});

export const VkPhysicalDeviceProperties = Object.freeze({
    apiVersion: 0x000,
    driverVersion: 0x004,
    vendorID: 0x008,
    deviceID: 0x00c,
    deviceType: 0x010,
    deviceName: 0x014,
    pipelineCacheUUID: 0x114,
    limits: 0x128,
    sparseProperties: 0x318,
    SIZE: 0x330,
});

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

export const VkPhysicalDeviceFeatures = Object.freeze({
    SIZE: PHYSICAL_DEVICE_FEATURES.length * 4,
    /** @param {string} name */
    offsetOf: name=>PHYSICAL_DEVICE_FEATURES.indexOf(name) * 4,
});

export const VkFormatProperties = Object.freeze({
    linearTilingFeatures: 0x00,
    optimalTilingFeatures: 0x04,
    bufferFeatures: 0x08,
    SIZE: 0x0c,
});

export const VkQueueFamilyProperties = Object.freeze({
    queueFlags: 0x00,
    queueCount: 0x04,
    timestampValidBits: 0x08,
    minImageTransferGranularity: 0x0c,
    SIZE: 0x18,
});

export const VkMemoryType = Object.freeze({ propertyFlags: 0x00, heapIndex: 0x04, SIZE: 0x08 });
/** A `VkDeviceSize` then a dword: sixteen bytes, four of them padding. */
export const VkMemoryHeap = Object.freeze({ size: 0x00, flags: 0x08, SIZE: 0x10 });

export const VkPhysicalDeviceMemoryProperties = Object.freeze({
    memoryTypeCount: 0x000,
    memoryTypes: 0x004,
    memoryHeapCount: 0x104,
    memoryHeaps: 0x108,
    SIZE: 0x208,
});

// --- surface and swapchain -------------------------------------------------

export const VkWin32SurfaceCreateInfoKHR = Object.freeze({
    sType: 0x00,
    pNext: 0x04,
    flags: 0x08,
    hinstance: 0x0c,
    hwnd: 0x10,
    SIZE: 0x14,
});

export const VkSurfaceCapabilitiesKHR = Object.freeze({
    minImageCount: 0x00,
    maxImageCount: 0x04,
    currentExtent: 0x08,
    minImageExtent: 0x10,
    maxImageExtent: 0x18,
    maxImageArrayLayers: 0x20,
    supportedTransforms: 0x24,
    currentTransform: 0x28,
    supportedCompositeAlpha: 0x2c,
    supportedUsageFlags: 0x30,
    SIZE: 0x34,
});

export const VkSurfaceFormatKHR = Object.freeze({ format: 0x00, colorSpace: 0x04, SIZE: 0x08 });

export const VkSwapchainCreateInfoKHR = Object.freeze({
    sType: 0x00,
    pNext: 0x04,
    flags: 0x08,
    surface: 0x10,
    minImageCount: 0x18,
    imageFormat: 0x1c,
    imageColorSpace: 0x20,
    imageExtent: 0x24,
    imageArrayLayers: 0x2c,
    imageUsage: 0x30,
    imageSharingMode: 0x34,
    queueFamilyIndexCount: 0x38,
    pQueueFamilyIndices: 0x3c,
    preTransform: 0x40,
    compositeAlpha: 0x44,
    presentMode: 0x48,
    clipped: 0x4c,
    oldSwapchain: 0x50,
    SIZE: 0x58,
});

export const VkPresentInfoKHR = Object.freeze({
    sType: 0x00,
    pNext: 0x04,
    waitSemaphoreCount: 0x08,
    pWaitSemaphores: 0x0c,
    swapchainCount: 0x10,
    pSwapchains: 0x14,
    pImageIndices: 0x18,
    pResults: 0x1c,
    SIZE: 0x20,
});

// --- images ----------------------------------------------------------------

export const VkImageCreateInfo = Object.freeze({
    sType: 0x00,
    pNext: 0x04,
    flags: 0x08,
    imageType: 0x0c,
    format: 0x10,
    extent: 0x14,
    mipLevels: 0x20,
    arrayLayers: 0x24,
    samples: 0x28,
    tiling: 0x2c,
    usage: 0x30,
    sharingMode: 0x34,
    queueFamilyIndexCount: 0x38,
    pQueueFamilyIndices: 0x3c,
    initialLayout: 0x40,
    SIZE: 0x44,
});

export const VkComponentMapping = Object.freeze({ r: 0x00, g: 0x04, b: 0x08, a: 0x0c, SIZE: 0x10 });

export const VkImageSubresourceRange = Object.freeze({
    aspectMask: 0x00,
    baseMipLevel: 0x04,
    levelCount: 0x08,
    baseArrayLayer: 0x0c,
    layerCount: 0x10,
    SIZE: 0x14,
});

export const VkImageViewCreateInfo = Object.freeze({
    sType: 0x00,
    pNext: 0x04,
    flags: 0x08,
    image: 0x10,
    viewType: 0x18,
    format: 0x1c,
    components: 0x20,
    subresourceRange: 0x30,
    SIZE: 0x48,
});

export const VkMemoryRequirements = Object.freeze({
    size: 0x00,
    alignment: 0x08,
    memoryTypeBits: 0x10,
    SIZE: 0x18,
});

export const VkMemoryAllocateInfo = Object.freeze({
    sType: 0x00,
    pNext: 0x04,
    allocationSize: 0x08,
    memoryTypeIndex: 0x10,
    SIZE: 0x18,
});

export const VkBufferCreateInfo = Object.freeze({
    sType: 0x00,
    pNext: 0x04,
    flags: 0x08,
    size: 0x10,
    usage: 0x18,
    sharingMode: 0x1c,
    queueFamilyIndexCount: 0x20,
    pQueueFamilyIndices: 0x24,
    SIZE: 0x28,
});

// --- render passes and framebuffers ---------------------------------------

export const VkAttachmentDescription = Object.freeze({
    flags: 0x00,
    format: 0x04,
    samples: 0x08,
    loadOp: 0x0c,
    storeOp: 0x10,
    stencilLoadOp: 0x14,
    stencilStoreOp: 0x18,
    initialLayout: 0x1c,
    finalLayout: 0x20,
    SIZE: 0x24,
});

export const VkAttachmentReference = Object.freeze({ attachment: 0x00, layout: 0x04, SIZE: 0x08 });

export const VkSubpassDescription = Object.freeze({
    flags: 0x00,
    pipelineBindPoint: 0x04,
    inputAttachmentCount: 0x08,
    pInputAttachments: 0x0c,
    colorAttachmentCount: 0x10,
    pColorAttachments: 0x14,
    pResolveAttachments: 0x18,
    pDepthStencilAttachment: 0x1c,
    preserveAttachmentCount: 0x20,
    pPreserveAttachments: 0x24,
    SIZE: 0x28,
});

export const VkSubpassDependency = Object.freeze({
    srcSubpass: 0x00,
    dstSubpass: 0x04,
    srcStageMask: 0x08,
    dstStageMask: 0x0c,
    srcAccessMask: 0x10,
    dstAccessMask: 0x14,
    dependencyFlags: 0x18,
    SIZE: 0x1c,
});

export const VkRenderPassCreateInfo = Object.freeze({
    sType: 0x00,
    pNext: 0x04,
    flags: 0x08,
    attachmentCount: 0x0c,
    pAttachments: 0x10,
    subpassCount: 0x14,
    pSubpasses: 0x18,
    dependencyCount: 0x1c,
    pDependencies: 0x20,
    SIZE: 0x24,
});

export const VkFramebufferCreateInfo = Object.freeze({
    sType: 0x00,
    pNext: 0x04,
    flags: 0x08,
    renderPass: 0x10,
    attachmentCount: 0x18,
    pAttachments: 0x1c,
    width: 0x20,
    height: 0x24,
    layers: 0x28,
    SIZE: 0x30,
});

// --- command buffers -------------------------------------------------------

export const VkCommandPoolCreateInfo = Object.freeze({
    sType: 0x00,
    pNext: 0x04,
    flags: 0x08,
    queueFamilyIndex: 0x0c,
    SIZE: 0x10,
});

export const VkCommandBufferAllocateInfo = Object.freeze({
    sType: 0x00,
    pNext: 0x04,
    commandPool: 0x08,
    level: 0x10,
    commandBufferCount: 0x14,
    SIZE: 0x18,
});

export const VkCommandBufferInheritanceInfo = Object.freeze({
    sType: 0x00,
    pNext: 0x04,
    renderPass: 0x08,
    subpass: 0x10,
    framebuffer: 0x18,
    occlusionQueryEnable: 0x20,
    queryFlags: 0x24,
    pipelineStatistics: 0x28,
    SIZE: 0x30,
});

export const VkCommandBufferBeginInfo = Object.freeze({
    sType: 0x00,
    pNext: 0x04,
    flags: 0x08,
    pInheritanceInfo: 0x0c,
    SIZE: 0x10,
});

/** A union of four floats, four ints or four uints: sixteen bytes either way. */
export const VkClearColorValue = Object.freeze({ SIZE: 0x10 });
export const VkClearDepthStencilValue = Object.freeze({ depth: 0x00, stencil: 0x04, SIZE: 0x08 });
/** The larger of the two members, which is the colour. */
export const VkClearValue = Object.freeze({ color: 0x00, depthStencil: 0x00, SIZE: 0x10 });

export const VkRenderPassBeginInfo = Object.freeze({
    sType: 0x00,
    pNext: 0x04,
    renderPass: 0x08,
    framebuffer: 0x10,
    renderArea: 0x18,
    clearValueCount: 0x28,
    pClearValues: 0x2c,
    SIZE: 0x30,
});

export const VkSubmitInfo = Object.freeze({
    sType: 0x00,
    pNext: 0x04,
    waitSemaphoreCount: 0x08,
    pWaitSemaphores: 0x0c,
    pWaitDstStageMask: 0x10,
    commandBufferCount: 0x14,
    pCommandBuffers: 0x18,
    signalSemaphoreCount: 0x1c,
    pSignalSemaphores: 0x20,
    SIZE: 0x24,
});

export const VkFenceCreateInfo = Object.freeze({
    sType: 0x00, pNext: 0x04, flags: 0x08, SIZE: 0x0c,
});
export const VkSemaphoreCreateInfo = Object.freeze({
    sType: 0x00, pNext: 0x04, flags: 0x08, SIZE: 0x0c,
});

// --- pipelines ---------------------------------------------------------------

export const VkShaderModuleCreateInfo = Object.freeze({
    sType: 0x00,
    pNext: 0x04,
    flags: 0x08,
    codeSize: 0x0c,
    pCode: 0x10,
    SIZE: 0x14,
});

export const VkPipelineShaderStageCreateInfo = Object.freeze({
    sType: 0x00,
    pNext: 0x04,
    flags: 0x08,
    stage: 0x0c,
    module: 0x10,
    pName: 0x18,
    pSpecializationInfo: 0x1c,
    SIZE: 0x20,
});

export const VkVertexInputBindingDescription = Object.freeze({
    binding: 0x00, stride: 0x04, inputRate: 0x08, SIZE: 0x0c,
});

export const VkVertexInputAttributeDescription = Object.freeze({
    location: 0x00, binding: 0x04, format: 0x08, offset: 0x0c, SIZE: 0x10,
});

export const VkPipelineVertexInputStateCreateInfo = Object.freeze({
    sType: 0x00,
    pNext: 0x04,
    flags: 0x08,
    vertexBindingDescriptionCount: 0x0c,
    pVertexBindingDescriptions: 0x10,
    vertexAttributeDescriptionCount: 0x14,
    pVertexAttributeDescriptions: 0x18,
    SIZE: 0x1c,
});

export const VkPipelineInputAssemblyStateCreateInfo = Object.freeze({
    sType: 0x00,
    pNext: 0x04,
    flags: 0x08,
    topology: 0x0c,
    primitiveRestartEnable: 0x10,
    SIZE: 0x14,
});

export const VkPipelineTessellationStateCreateInfo = Object.freeze({
    sType: 0x00, pNext: 0x04, flags: 0x08, patchControlPoints: 0x0c, SIZE: 0x10,
});

export const VkPipelineViewportStateCreateInfo = Object.freeze({
    sType: 0x00,
    pNext: 0x04,
    flags: 0x08,
    viewportCount: 0x0c,
    pViewports: 0x10,
    scissorCount: 0x14,
    pScissors: 0x18,
    SIZE: 0x1c,
});

export const VkPipelineRasterizationStateCreateInfo = Object.freeze({
    sType: 0x00,
    pNext: 0x04,
    flags: 0x08,
    depthClampEnable: 0x0c,
    rasterizerDiscardEnable: 0x10,
    polygonMode: 0x14,
    cullMode: 0x18,
    frontFace: 0x1c,
    depthBiasEnable: 0x20,
    depthBiasConstantFactor: 0x24,
    depthBiasClamp: 0x28,
    depthBiasSlopeFactor: 0x2c,
    lineWidth: 0x30,
    SIZE: 0x34,
});

export const VkPipelineMultisampleStateCreateInfo = Object.freeze({
    sType: 0x00,
    pNext: 0x04,
    flags: 0x08,
    rasterizationSamples: 0x0c,
    sampleShadingEnable: 0x10,
    minSampleShading: 0x14,
    pSampleMask: 0x18,
    alphaToCoverageEnable: 0x1c,
    alphaToOneEnable: 0x20,
    SIZE: 0x24,
});

export const VkStencilOpState = Object.freeze({
    failOp: 0x00,
    passOp: 0x04,
    depthFailOp: 0x08,
    compareOp: 0x0c,
    compareMask: 0x10,
    writeMask: 0x14,
    reference: 0x18,
    SIZE: 0x1c,
});

export const VkPipelineDepthStencilStateCreateInfo = Object.freeze({
    sType: 0x00,
    pNext: 0x04,
    flags: 0x08,
    depthTestEnable: 0x0c,
    depthWriteEnable: 0x10,
    depthCompareOp: 0x14,
    depthBoundsTestEnable: 0x18,
    stencilTestEnable: 0x1c,
    front: 0x20,
    back: 0x3c,
    minDepthBounds: 0x58,
    maxDepthBounds: 0x5c,
    SIZE: 0x60,
});

export const VkPipelineColorBlendAttachmentState = Object.freeze({
    blendEnable: 0x00,
    srcColorBlendFactor: 0x04,
    dstColorBlendFactor: 0x08,
    colorBlendOp: 0x0c,
    srcAlphaBlendFactor: 0x10,
    dstAlphaBlendFactor: 0x14,
    alphaBlendOp: 0x18,
    colorWriteMask: 0x1c,
    SIZE: 0x20,
});

export const VkPipelineColorBlendStateCreateInfo = Object.freeze({
    sType: 0x00,
    pNext: 0x04,
    flags: 0x08,
    logicOpEnable: 0x0c,
    logicOp: 0x10,
    attachmentCount: 0x14,
    pAttachments: 0x18,
    blendConstants: 0x1c,
    SIZE: 0x2c,
});

export const VkPipelineDynamicStateCreateInfo = Object.freeze({
    sType: 0x00,
    pNext: 0x04,
    flags: 0x08,
    dynamicStateCount: 0x0c,
    pDynamicStates: 0x10,
    SIZE: 0x14,
});

export const VkPushConstantRange = Object.freeze({
    stageFlags: 0x00, offset: 0x04, size: 0x08, SIZE: 0x0c,
});

export const VkPipelineLayoutCreateInfo = Object.freeze({
    sType: 0x00,
    pNext: 0x04,
    flags: 0x08,
    setLayoutCount: 0x0c,
    pSetLayouts: 0x10,
    pushConstantRangeCount: 0x14,
    pPushConstantRanges: 0x18,
    SIZE: 0x1c,
});

export const VkDescriptorSetLayoutBinding = Object.freeze({
    binding: 0x00,
    descriptorType: 0x04,
    descriptorCount: 0x08,
    stageFlags: 0x0c,
    pImmutableSamplers: 0x10,
    SIZE: 0x14,
});

export const VkDescriptorSetLayoutCreateInfo = Object.freeze({
    sType: 0x00,
    pNext: 0x04,
    flags: 0x08,
    bindingCount: 0x0c,
    pBindings: 0x10,
    SIZE: 0x14,
});

/**
 * Ten pointers to state blocks, then two handles: `layout` is the first
 * eight-byte field and sits at 56 after the pointers pack with no gap.
 */
export const VkGraphicsPipelineCreateInfo = Object.freeze({
    sType: 0x00,
    pNext: 0x04,
    flags: 0x08,
    stageCount: 0x0c,
    pStages: 0x10,
    pVertexInputState: 0x14,
    pInputAssemblyState: 0x18,
    pTessellationState: 0x1c,
    pViewportState: 0x20,
    pRasterizationState: 0x24,
    pMultisampleState: 0x28,
    pDepthStencilState: 0x2c,
    pColorBlendState: 0x30,
    pDynamicState: 0x34,
    layout: 0x38,
    renderPass: 0x40,
    subpass: 0x48,
    basePipelineHandle: 0x50,
    basePipelineIndex: 0x58,
    SIZE: 0x60,
});

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
 * A NUL-terminated string, read up to `max` bytes. Vulkan strings are UTF-8;
 * the names that matter here are ASCII.
 *
 * @param {GuestMemory} memory @param {number} address @param {number} [max]
 * @returns {string}
 */
export function readCString(memory, address, max = 256){
    if ((address >>> 0) === 0)
    {
        return '';
    }
    const bytes = memory.readMemory(address >>> 0, max);
    let end = 0;
    while (end < bytes.length && bytes[end] !== 0)
    {
        end++;
    }
    return new TextDecoder().decode(bytes.subarray(0, end));
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
