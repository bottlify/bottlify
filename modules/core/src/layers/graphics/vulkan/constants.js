/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The Vulkan enumerations a program hands across and reads back, with the
 * values the Khronos registry (`vk.xml`) assigns them.
 *
 * Only what the loader surface and the first frame need is here. An extension
 * enum is `1000000000 + 1000 * (extension number - 1) + offset`, which is why
 * the swapchain and surface values look the way they do rather than being
 * arbitrary.
 */

/** `VK_MAKE_VERSION`: ten bits of major, ten of minor, twelve of patch. */
export const makeVersion = (/** @type {number} */ major, /** @type {number} */ minor,
    /** @type {number} */ patch)=>((major << 22) | (minor << 12) | patch) >>> 0;
export const versionMajor = (/** @type {number} */ version)=>version >>> 22;
export const versionMinor = (/** @type {number} */ version)=>(version >>> 12) & 0x3ff;

/** The version this loader implements. Nothing above it is promised. */
export const VK_API_VERSION_1_0 = makeVersion(1, 0, 0);

export const VK_TRUE = 1;
export const VK_FALSE = 0;
export const VK_NULL_HANDLE = 0;
/** `~0U`, which several counts use to mean "no such thing". */
export const VK_UNUSED = 0xffffffff;
export const VK_MAX_PHYSICAL_DEVICE_NAME_SIZE = 256;
export const VK_MAX_EXTENSION_NAME_SIZE = 256;
export const VK_MAX_DESCRIPTION_SIZE = 256;
export const VK_UUID_SIZE = 16;
export const VK_MAX_MEMORY_TYPES = 32;
export const VK_MAX_MEMORY_HEAPS = 16;

export const VkResult = Object.freeze({
    SUCCESS: 0,
    NOT_READY: 1,
    TIMEOUT: 2,
    EVENT_SET: 3,
    EVENT_RESET: 4,
    INCOMPLETE: 5,
    ERROR_OUT_OF_HOST_MEMORY: -1,
    ERROR_OUT_OF_DEVICE_MEMORY: -2,
    ERROR_INITIALIZATION_FAILED: -3,
    ERROR_DEVICE_LOST: -4,
    ERROR_MEMORY_MAP_FAILED: -5,
    ERROR_LAYER_NOT_PRESENT: -6,
    ERROR_EXTENSION_NOT_PRESENT: -7,
    ERROR_FEATURE_NOT_PRESENT: -8,
    ERROR_INCOMPATIBLE_DRIVER: -9,
    ERROR_TOO_MANY_OBJECTS: -10,
    ERROR_FORMAT_NOT_SUPPORTED: -11,
    ERROR_FRAGMENTED_POOL: -12,
    ERROR_SURFACE_LOST_KHR: -1000000000,
    ERROR_NATIVE_WINDOW_IN_USE_KHR: -1000000001,
    SUBOPTIMAL_KHR: 1000001003,
    ERROR_OUT_OF_DATE_KHR: -1000001004,
});

export const VkStructureType = Object.freeze({
    APPLICATION_INFO: 0,
    INSTANCE_CREATE_INFO: 1,
    DEVICE_QUEUE_CREATE_INFO: 2,
    DEVICE_CREATE_INFO: 3,
    SUBMIT_INFO: 4,
    MEMORY_ALLOCATE_INFO: 5,
    MAPPED_MEMORY_RANGE: 6,
    BIND_SPARSE_INFO: 7,
    FENCE_CREATE_INFO: 8,
    SEMAPHORE_CREATE_INFO: 9,
    EVENT_CREATE_INFO: 10,
    QUERY_POOL_CREATE_INFO: 11,
    BUFFER_CREATE_INFO: 12,
    BUFFER_VIEW_CREATE_INFO: 13,
    IMAGE_CREATE_INFO: 14,
    IMAGE_VIEW_CREATE_INFO: 15,
    SHADER_MODULE_CREATE_INFO: 16,
    PIPELINE_CACHE_CREATE_INFO: 17,
    PIPELINE_SHADER_STAGE_CREATE_INFO: 18,
    PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO: 19,
    PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO: 20,
    PIPELINE_TESSELLATION_STATE_CREATE_INFO: 21,
    PIPELINE_VIEWPORT_STATE_CREATE_INFO: 22,
    PIPELINE_RASTERIZATION_STATE_CREATE_INFO: 23,
    PIPELINE_MULTISAMPLE_STATE_CREATE_INFO: 24,
    PIPELINE_DEPTH_STENCIL_STATE_CREATE_INFO: 25,
    PIPELINE_COLOR_BLEND_STATE_CREATE_INFO: 26,
    PIPELINE_DYNAMIC_STATE_CREATE_INFO: 27,
    GRAPHICS_PIPELINE_CREATE_INFO: 28,
    COMPUTE_PIPELINE_CREATE_INFO: 29,
    PIPELINE_LAYOUT_CREATE_INFO: 30,
    SAMPLER_CREATE_INFO: 31,
    DESCRIPTOR_SET_LAYOUT_CREATE_INFO: 32,
    DESCRIPTOR_POOL_CREATE_INFO: 33,
    DESCRIPTOR_SET_ALLOCATE_INFO: 34,
    WRITE_DESCRIPTOR_SET: 35,
    COPY_DESCRIPTOR_SET: 36,
    FRAMEBUFFER_CREATE_INFO: 37,
    RENDER_PASS_CREATE_INFO: 38,
    COMMAND_POOL_CREATE_INFO: 39,
    COMMAND_BUFFER_ALLOCATE_INFO: 40,
    COMMAND_BUFFER_INHERITANCE_INFO: 41,
    COMMAND_BUFFER_BEGIN_INFO: 42,
    RENDER_PASS_BEGIN_INFO: 43,
    BUFFER_MEMORY_BARRIER: 44,
    IMAGE_MEMORY_BARRIER: 45,
    MEMORY_BARRIER: 46,
    LOADER_INSTANCE_CREATE_INFO: 47,
    LOADER_DEVICE_CREATE_INFO: 48,
    SWAPCHAIN_CREATE_INFO_KHR: 1000001000,
    PRESENT_INFO_KHR: 1000001001,
    WIN32_SURFACE_CREATE_INFO_KHR: 1000009000,
});

/** The formats this loader can put a name to. The registry numbers them. */
export const VkFormat = Object.freeze({
    UNDEFINED: 0,
    R8G8B8A8_UNORM: 37,
    R8G8B8A8_SRGB: 43,
    B8G8R8A8_UNORM: 44,
    B8G8R8A8_SRGB: 50,
    R16_UINT: 74,
    R32_UINT: 98,
    R32_SFLOAT: 100,
    R32G32_SFLOAT: 103,
    R32G32B32_SFLOAT: 106,
    R32G32B32A32_SFLOAT: 109,
    D16_UNORM: 124,
    D32_SFLOAT: 126,
    D24_UNORM_S8_UINT: 129,
    D32_SFLOAT_S8_UINT: 130,
});

export const VkFormatFeatureFlagBits = Object.freeze({
    SAMPLED_IMAGE: 0x0001,
    STORAGE_IMAGE: 0x0002,
    VERTEX_BUFFER: 0x0040,
    COLOR_ATTACHMENT: 0x0080,
    COLOR_ATTACHMENT_BLEND: 0x0100,
    DEPTH_STENCIL_ATTACHMENT: 0x0200,
    BLIT_SRC: 0x0400,
    BLIT_DST: 0x0800,
    SAMPLED_IMAGE_FILTER_LINEAR: 0x1000,
});

export const VkColorSpaceKHR = Object.freeze({ SRGB_NONLINEAR_KHR: 0 });

export const VkPresentModeKHR = Object.freeze({
    IMMEDIATE_KHR: 0,
    MAILBOX_KHR: 1,
    FIFO_KHR: 2,
    FIFO_RELAXED_KHR: 3,
});

export const VkSurfaceTransformFlagBitsKHR = Object.freeze({ IDENTITY_BIT_KHR: 1 });
export const VkCompositeAlphaFlagBitsKHR = Object.freeze({ OPAQUE_BIT_KHR: 1 });

export const VkImageUsageFlagBits = Object.freeze({
    TRANSFER_SRC: 0x01,
    TRANSFER_DST: 0x02,
    SAMPLED: 0x04,
    STORAGE: 0x08,
    COLOR_ATTACHMENT: 0x10,
    DEPTH_STENCIL_ATTACHMENT: 0x20,
    TRANSIENT_ATTACHMENT: 0x40,
    INPUT_ATTACHMENT: 0x80,
});

export const VkQueueFlagBits = Object.freeze({
    GRAPHICS: 0x1,
    COMPUTE: 0x2,
    TRANSFER: 0x4,
    SPARSE_BINDING: 0x8,
});

export const VkMemoryPropertyFlagBits = Object.freeze({
    DEVICE_LOCAL: 0x01,
    HOST_VISIBLE: 0x02,
    HOST_COHERENT: 0x04,
    HOST_CACHED: 0x08,
    LAZILY_ALLOCATED: 0x10,
});

export const VkMemoryHeapFlagBits = Object.freeze({ DEVICE_LOCAL: 0x1 });

export const VkPhysicalDeviceType = Object.freeze({
    OTHER: 0,
    INTEGRATED_GPU: 1,
    DISCRETE_GPU: 2,
    VIRTUAL_GPU: 3,
    CPU: 4,
});

export const VkAttachmentLoadOp = Object.freeze({ LOAD: 0, CLEAR: 1, DONT_CARE: 2 });
export const VkAttachmentStoreOp = Object.freeze({ STORE: 0, DONT_CARE: 1 });

export const VkImageLayout = Object.freeze({
    UNDEFINED: 0,
    GENERAL: 1,
    COLOR_ATTACHMENT_OPTIMAL: 2,
    DEPTH_STENCIL_ATTACHMENT_OPTIMAL: 3,
    DEPTH_STENCIL_READ_ONLY_OPTIMAL: 4,
    SHADER_READ_ONLY_OPTIMAL: 5,
    TRANSFER_SRC_OPTIMAL: 6,
    TRANSFER_DST_OPTIMAL: 7,
    PREINITIALIZED: 8,
    PRESENT_SRC_KHR: 1000001002,
});

export const VkPipelineBindPoint = Object.freeze({ GRAPHICS: 0, COMPUTE: 1 });
export const VkCommandBufferLevel = Object.freeze({ PRIMARY: 0, SECONDARY: 1 });
export const VkSubpassContents = Object.freeze({ INLINE: 0, SECONDARY_COMMAND_BUFFERS: 1 });
export const VkImageType = Object.freeze({ TYPE_1D: 0, TYPE_2D: 1, TYPE_3D: 2 });
export const VkImageViewType = Object.freeze({
    TYPE_1D: 0, TYPE_2D: 1, TYPE_3D: 2, CUBE: 3, ARRAY_1D: 4, ARRAY_2D: 5, CUBE_ARRAY: 6,
});
export const VkImageTiling = Object.freeze({ OPTIMAL: 0, LINEAR: 1 });
export const VkImageAspectFlagBits = Object.freeze({ COLOR: 0x1, DEPTH: 0x2, STENCIL: 0x4 });
export const VkSharingMode = Object.freeze({ EXCLUSIVE: 0, CONCURRENT: 1 });
export const VkSampleCountFlagBits = Object.freeze({ COUNT_1: 0x1 });
export const VkCommandPoolCreateFlagBits = Object.freeze({
    TRANSIENT: 0x1, RESET_COMMAND_BUFFER: 0x2,
});
export const VkCommandBufferUsageFlagBits = Object.freeze({
    ONE_TIME_SUBMIT: 0x1, RENDER_PASS_CONTINUE: 0x2, SIMULTANEOUS_USE: 0x4,
});
export const VkFenceCreateFlagBits = Object.freeze({ SIGNALED: 0x1 });
export const VkShaderStageFlagBits = Object.freeze({
    VERTEX: 0x01,
    TESSELLATION_CONTROL: 0x02,
    TESSELLATION_EVALUATION: 0x04,
    GEOMETRY: 0x08,
    FRAGMENT: 0x10,
    COMPUTE: 0x20,
});
export const VkPrimitiveTopology = Object.freeze({
    POINT_LIST: 0,
    LINE_LIST: 1,
    LINE_STRIP: 2,
    TRIANGLE_LIST: 3,
    TRIANGLE_STRIP: 4,
    TRIANGLE_FAN: 5,
});

/**
 * The extensions this loader offers, with the specification revision each
 * reports. Nothing not listed here is enumerable or enableable.
 */
export const INSTANCE_EXTENSIONS = Object.freeze({
    VK_KHR_surface: 25,
    VK_KHR_win32_surface: 6,
});
export const DEVICE_EXTENSIONS = Object.freeze({
    VK_KHR_swapchain: 70,
});

/**
 * What a Vulkan format is called on the GPU underneath. A format missing here
 * is one the swapchain and attachments refuse, by name.
 *
 * @type {Readonly<Record<number, string>>}
 */
export const GPU_FORMAT = Object.freeze({
    [VkFormat.R8G8B8A8_UNORM]: 'rgba8unorm',
    [VkFormat.R8G8B8A8_SRGB]: 'rgba8unorm-srgb',
    [VkFormat.B8G8R8A8_UNORM]: 'bgra8unorm',
    [VkFormat.B8G8R8A8_SRGB]: 'bgra8unorm-srgb',
    [VkFormat.D16_UNORM]: 'depth16unorm',
    [VkFormat.D32_SFLOAT]: 'depth32float',
    [VkFormat.D24_UNORM_S8_UINT]: 'depth24plus-stencil8',
    [VkFormat.D32_SFLOAT_S8_UINT]: 'depth32float-stencil8',
});

/** @param {number} format @returns {string} the registry's name, or the number */
export function formatName(format){
    const found = Object.entries(VkFormat).find(entry=>entry[1] === format);
    return found ? `VK_FORMAT_${found[0]}` : `format ${format}`;
}
