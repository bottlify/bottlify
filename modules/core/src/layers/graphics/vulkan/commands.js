/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Every command `vulkan-1.dll` exports, with the size of its argument list on
 * the 32-bit ABI and the level `vkGetInstanceProcAddr` sorts it under.
 *
 * **Every export is declared, whether or not it does anything.** `VKAPI_CALL`
 * is `__stdcall` on 32-bit Windows, so the callee pops its own arguments; a
 * name bound to a stub that pops the wrong number of bytes does not fail at
 * the call, it fails wherever the caller's stack happens to land next. The
 * size is therefore written down per command rather than derived from a
 * JavaScript signature, and two things make deriving it wrong:
 *
 * - **A non-dispatchable handle is two words.** `VkSwapchainKHR`, `VkFence`,
 *   `VkSemaphore`, `VkBuffer` -- all of them -- are 64-bit on every platform.
 *   `vkAcquireNextImageKHR` takes a device, a swapchain, a timeout, a
 *   semaphore, a fence and a pointer: 4 + 8 + 8 + 8 + 8 + 4 = 40 bytes.
 * - **A dispatchable handle is one.** `VkDevice`, `VkQueue`, `VkCommandBuffer`
 *   are pointers.
 *
 * The level is what `vkGetInstanceProcAddr` and `vkGetDeviceProcAddr` answer
 * from: a global command is reachable with no instance, an instance-level one
 * takes a `VkInstance` or `VkPhysicalDevice` first, and a device-level one
 * takes a `VkDevice`, `VkQueue` or `VkCommandBuffer`. A command that belongs to
 * an extension names it, so that a program which did not enable the extension
 * is not handed the pointer.
 */

/**
 * @typedef {'global' | 'instance' | 'device'} CommandLevel
 */

/**
 * @typedef {Object} CommandAbi
 * @property {number} argBytes
 * @property {CommandLevel} level
 * @property {string} [extension]
 */

/**
 * @param {CommandLevel} level
 * @param {Record<string, number>} sizes  command name -> argument bytes
 * @param {string} [extension]
 * @returns {Record<string, CommandAbi>}
 */
const group = (level, sizes, extension)=>Object.fromEntries(Object.entries(sizes)
    .map(([name, argBytes])=>[name, extension
        ? { argBytes, level, extension }
        : { argBytes, level }]));

/** @type {Readonly<Record<string, CommandAbi>>} */
export const COMMANDS = Object.freeze({
    ...group('global', {
        vkCreateInstance: 12,
        vkEnumerateInstanceExtensionProperties: 12,
        vkEnumerateInstanceLayerProperties: 8,
        vkGetInstanceProcAddr: 8,
    }),

    ...group('instance', {
        vkDestroyInstance: 8,
        vkEnumeratePhysicalDevices: 12,
        vkGetPhysicalDeviceFeatures: 8,
        vkGetPhysicalDeviceFormatProperties: 12,
        vkGetPhysicalDeviceImageFormatProperties: 28,
        vkGetPhysicalDeviceProperties: 8,
        vkGetPhysicalDeviceQueueFamilyProperties: 12,
        vkGetPhysicalDeviceMemoryProperties: 8,
        vkGetDeviceProcAddr: 8,
        vkCreateDevice: 16,
        vkEnumerateDeviceExtensionProperties: 16,
        vkEnumerateDeviceLayerProperties: 12,
        vkGetPhysicalDeviceSparseImageFormatProperties: 32,
    }),

    ...group('device', {
        vkDestroyDevice: 8,
        vkGetDeviceQueue: 16,
        vkQueueSubmit: 20,
        vkQueueWaitIdle: 4,
        vkDeviceWaitIdle: 4,
        vkAllocateMemory: 16,
        vkFreeMemory: 16,
        vkMapMemory: 36,
        vkUnmapMemory: 12,
        vkFlushMappedMemoryRanges: 12,
        vkInvalidateMappedMemoryRanges: 12,
        vkGetDeviceMemoryCommitment: 16,
        vkBindBufferMemory: 28,
        vkBindImageMemory: 28,
        vkGetBufferMemoryRequirements: 16,
        vkGetImageMemoryRequirements: 16,
        vkGetImageSparseMemoryRequirements: 20,
        vkQueueBindSparse: 20,
        vkCreateFence: 16,
        vkDestroyFence: 16,
        vkResetFences: 12,
        vkGetFenceStatus: 12,
        vkWaitForFences: 24,
        vkCreateSemaphore: 16,
        vkDestroySemaphore: 16,
        vkCreateEvent: 16,
        vkDestroyEvent: 16,
        vkGetEventStatus: 12,
        vkSetEvent: 12,
        vkResetEvent: 12,
        vkCreateQueryPool: 16,
        vkDestroyQueryPool: 16,
        vkGetQueryPoolResults: 40,
        vkCreateBuffer: 16,
        vkDestroyBuffer: 16,
        vkCreateBufferView: 16,
        vkDestroyBufferView: 16,
        vkCreateImage: 16,
        vkDestroyImage: 16,
        vkGetImageSubresourceLayout: 20,
        vkCreateImageView: 16,
        vkDestroyImageView: 16,
        vkCreateShaderModule: 16,
        vkDestroyShaderModule: 16,
        vkCreatePipelineCache: 16,
        vkDestroyPipelineCache: 16,
        vkGetPipelineCacheData: 20,
        vkMergePipelineCaches: 20,
        vkCreateGraphicsPipelines: 28,
        vkCreateComputePipelines: 28,
        vkDestroyPipeline: 16,
        vkCreatePipelineLayout: 16,
        vkDestroyPipelineLayout: 16,
        vkCreateSampler: 16,
        vkDestroySampler: 16,
        vkCreateDescriptorSetLayout: 16,
        vkDestroyDescriptorSetLayout: 16,
        vkCreateDescriptorPool: 16,
        vkDestroyDescriptorPool: 16,
        vkResetDescriptorPool: 16,
        vkAllocateDescriptorSets: 12,
        vkFreeDescriptorSets: 20,
        vkUpdateDescriptorSets: 20,
        vkCreateFramebuffer: 16,
        vkDestroyFramebuffer: 16,
        vkCreateRenderPass: 16,
        vkDestroyRenderPass: 16,
        vkGetRenderAreaGranularity: 16,
        vkCreateCommandPool: 16,
        vkDestroyCommandPool: 16,
        vkResetCommandPool: 16,
        vkAllocateCommandBuffers: 12,
        vkFreeCommandBuffers: 20,
        vkBeginCommandBuffer: 8,
        vkEndCommandBuffer: 4,
        vkResetCommandBuffer: 8,
        vkCmdBindPipeline: 16,
        vkCmdSetViewport: 16,
        vkCmdSetScissor: 16,
        vkCmdSetLineWidth: 8,
        vkCmdSetDepthBias: 16,
        vkCmdSetBlendConstants: 8,
        vkCmdSetDepthBounds: 12,
        vkCmdSetStencilCompareMask: 12,
        vkCmdSetStencilWriteMask: 12,
        vkCmdSetStencilReference: 12,
        vkCmdBindDescriptorSets: 36,
        vkCmdBindIndexBuffer: 24,
        vkCmdBindVertexBuffers: 20,
        vkCmdDraw: 20,
        vkCmdDrawIndexed: 24,
        vkCmdDrawIndirect: 28,
        vkCmdDrawIndexedIndirect: 28,
        vkCmdDispatch: 16,
        vkCmdDispatchIndirect: 20,
        vkCmdCopyBuffer: 28,
        vkCmdCopyImage: 36,
        vkCmdBlitImage: 40,
        vkCmdCopyBufferToImage: 32,
        vkCmdCopyImageToBuffer: 32,
        vkCmdUpdateBuffer: 32,
        vkCmdFillBuffer: 32,
        vkCmdClearColorImage: 28,
        vkCmdClearDepthStencilImage: 28,
        vkCmdClearAttachments: 20,
        vkCmdResolveImage: 36,
        vkCmdSetEvent: 16,
        vkCmdResetEvent: 16,
        vkCmdWaitEvents: 44,
        vkCmdPipelineBarrier: 40,
        vkCmdBeginQuery: 20,
        vkCmdEndQuery: 16,
        vkCmdResetQueryPool: 20,
        vkCmdWriteTimestamp: 20,
        vkCmdCopyQueryPoolResults: 48,
        vkCmdPushConstants: 28,
        vkCmdBeginRenderPass: 12,
        vkCmdNextSubpass: 8,
        vkCmdEndRenderPass: 4,
        vkCmdExecuteCommands: 12,
    }),

    ...group('instance', {
        vkDestroySurfaceKHR: 16,
        vkGetPhysicalDeviceSurfaceSupportKHR: 20,
        vkGetPhysicalDeviceSurfaceCapabilitiesKHR: 16,
        vkGetPhysicalDeviceSurfaceFormatsKHR: 20,
        vkGetPhysicalDeviceSurfacePresentModesKHR: 20,
    }, 'VK_KHR_surface'),

    ...group('instance', {
        vkCreateWin32SurfaceKHR: 16,
        vkGetPhysicalDeviceWin32PresentationSupportKHR: 8,
    }, 'VK_KHR_win32_surface'),

    ...group('device', {
        vkCreateSwapchainKHR: 16,
        vkDestroySwapchainKHR: 16,
        vkGetSwapchainImagesKHR: 20,
        vkAcquireNextImageKHR: 40,
        vkQueuePresentKHR: 8,
    }, 'VK_KHR_swapchain'),
});
