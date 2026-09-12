/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The device level: what a program does with a `VkDevice`, mapped onto the
 * one frame the backend draws.
 *
 * Vulkan records commands into a buffer now and submits it later; the backend
 * has one command encoder per frame and reaches the queue once, when the
 * frame ends. The two meet like this:
 *
 * - A command buffer records into a list on this side. Nothing touches the
 *   GPU while recording.
 * - `vkQueueSubmit` replays each buffer into the open frame, opening one if
 *   there is none. A render pass becomes a backend pass; a clear is the
 *   pass's load operation.
 * - `vkQueuePresentKHR` is where the frame ends: the acquired image is what
 *   the frame presents, and ending it is the one submission to the queue.
 * - Fences and semaphores are signalled at submit, because by the time the
 *   replay has returned the work is ordered on the queue and nothing can
 *   overtake it; a wait therefore never blocks. This is the specification's
 *   observable behaviour on a queue that never runs ahead of the host.
 *
 * What this cut refuses, visibly: more than one subpass, more than one
 * colour attachment, and a render area smaller than the framebuffer (the
 * clear covers the whole attachment either way). Every draw command is
 * refused too, because a draw needs a pipeline and a pipeline needs SPIR-V
 * translated -- that is the next piece of work, and its absence is reported
 * by name rather than drawn as nothing.
 */

import {
    DEVICE_EXTENSIONS, GPU_FORMAT, VK_UNUSED, VkAttachmentLoadOp, VkAttachmentStoreOp,
    VkCommandBufferLevel, VkFenceCreateFlagBits, VkFormat, VkImageType, VkResult,
    VkSampleCountFlagBits, formatName,
} from './constants.js';
import {
    VkAttachmentDescription, VkAttachmentReference, VkClearDepthStencilValue, VkClearValue,
    VkCommandBufferAllocateInfo, VkExtent2D, VkExtent3D, VkFenceCreateInfo,
    VkFramebufferCreateInfo, VkImageCreateInfo, VkImageViewCreateInfo, VkMemoryAllocateInfo,
    VkMemoryRequirements, VkPresentInfoKHR, VkRenderPassBeginInfo, VkRenderPassCreateInfo,
    VkShaderModuleCreateInfo, VkSubmitInfo, VkSubpassDescription, VkSwapchainCreateInfoKHR,
    VkViewport, joinU64,
    readF32, readF32Array, readRect2D, readU32, readU32Array, readU64, readU64Array, writeU32,
    writeU64,
} from './structs.js';
import { COMMANDS } from './commands.js';
import { SURFACE_FORMATS, enumerate } from './physical.js';
import { EXECUTION_MODELS, decodeSpirv, unsupportedCapabilities, versionString } from './spirv.js';

/** `GPUTextureUsage.RENDER_ATTACHMENT`, spelled out so nothing here reads a global. */
const RENDER_ATTACHMENT = 0x10;

/**
 * @typedef {Object} Device
 * @property {'device'} kind
 * @property {number} handle
 * @property {number} physicalDevice
 * @property {Set<string>} extensions
 * @property {number} queue   the handle
 * @property {import('./physical.js').Frame | null} frame
 *           the open frame, between the first submit and the present
 * @property {JournalEntry[]} journal   what the open frame has been given
 * @property {JournalEntry[]} lastFrame   what the last presented frame was given
 */

/**
 * One thing a frame was given, as a diagnostic and as what the byte-exact
 * tests evaluate.
 *
 * @typedef {Object} JournalEntry
 * @property {'pass' | 'present'} kind
 * @property {string} target
 * @property {{ r: number, g: number, b: number, a: number }} [clearColor]
 * @property {number} [clearDepth]
 * @property {number} [clearStencil]
 * @property {{ x: number, y: number, width: number, height: number }} [renderArea]
 */

/**
 * @typedef {Object} Image
 * @property {'image'} kind
 * @property {import('../webgpu/contract.js').Surface} surface
 * @property {number} width
 * @property {number} height
 * @property {number} format   VkFormat
 * @property {number | null} swapchain   the handle, for a presentable image
 */

/**
 * @typedef {Object} Swapchain
 * @property {'swapchain'} kind
 * @property {number} surface
 * @property {number[]} images   handles
 * @property {number} next
 * @property {boolean} retired
 */

/**
 * @typedef {Object} RenderPass
 * @property {'renderPass'} kind
 * @property {{ format: number, loadOp: number, storeOp: number, stencilLoadOp: number,
 *             stencilStoreOp: number }[]} attachments
 * @property {{ color: number[], depth: number | null }[]} subpasses   attachment indices
 */

/**
 * @typedef {Object} Framebuffer
 * @property {'framebuffer'} kind
 * @property {number} renderPass
 * @property {number[]} attachments   image view handles
 * @property {number} width
 * @property {number} height
 */

/**
 * @typedef {Object} RecordedCommand
 * @property {string} kind
 * @property {number} [renderPass]
 * @property {number} [framebuffer]
 * @property {{ x: number, y: number, width: number, height: number }} [renderArea]
 * @property {{ floats: number[], depth: number, stencil: number }[]} [clearValues]
 * @property {{ x: number, y: number, width: number, height: number,
 *             minDepth: number, maxDepth: number }} [viewport]
 * @property {{ x: number, y: number, width: number, height: number }} [scissor]
 */

/**
 * @typedef {Object} CommandBuffer
 * @property {'commandBuffer'} kind
 * @property {number} pool
 * @property {'initial' | 'recording' | 'executable'} state
 * @property {RecordedCommand[]} commands
 */

/** Which formats carry a stencil aspect, which decides what WebGPU is told. */
/** @type {Set<number>} */
const STENCIL_FORMATS = new Set([VkFormat.D24_UNORM_S8_UINT, VkFormat.D32_SFLOAT_S8_UINT]);
/** @type {Set<number>} */
const DEPTH_FORMATS = new Set([
    VkFormat.D16_UNORM, VkFormat.D32_SFLOAT, ...STENCIL_FORMATS,
]);

/** Bytes per texel, for the size a memory requirement reports. */
const BYTES_PER_TEXEL = 4;

/** @param {number} loadOp @returns {'load' | 'clear'} */
const loadOpOf = loadOp=>(loadOp === VkAttachmentLoadOp.LOAD ? 'load' : 'clear');
/** @param {number} storeOp @returns {'store' | 'discard'} */
const storeOpOf = storeOp=>(storeOp === VkAttachmentStoreOp.STORE ? 'store' : 'discard');

/**
 * Makes a device and its queue.
 *
 * @param {import('./physical.js').VulkanContext} context
 * @param {{ physicalDevice: number, extensions: Set<string> }} options
 * @returns {Device}
 */
export function createDevice(context, options){
    /** @type {Device} */
    const device = {
        kind: 'device',
        handle: 0,
        physicalDevice: options.physicalDevice,
        extensions: options.extensions,
        queue: 0,
        frame: null,
        journal: [],
        lastFrame: [],
    };
    device.handle = context.handles.mintDispatchable(device);
    device.queue = context.handles.mintDispatchable({ kind: 'queue', device: device.handle });
    return device;
}

/**
 * @param {import('./physical.js').VulkanContext} context
 */
export function createDeviceCommands(context){
    const { memory, handles } = context;

    /**
     * @template T
     * @param {number} handle @param {string} kind @param {string} command
     * @returns {T | null}
     */
    const objectOf = (handle, kind, command)=>{
        const object = handles.get(handle, kind);
        if (!object)
        {
            const actual = handles.kindOf(handle);
            context.diverge(`${command} expected a "${kind}" handle and was given `
                + (actual ? `a "${actual}" one` : 'a stale one'));
        }
        return /** @type {T | null} */ (/** @type {unknown} */ (object));
    };

    /** @param {number} handle @param {string} command @returns {Device | null} */
    const deviceOf = (handle, command)=>objectOf(handle >>> 0, 'device', command);

    /** @param {number} handle @param {string} command @returns {Device | null} */
    const deviceOfQueue = (handle, command)=>{
        /** @type {{ device: number } | null} */
        const queue = objectOf(handle >>> 0, 'queue', command);
        return queue ? deviceOf(queue.device, command) : null;
    };

    /**
     * @param {number} handle @param {string} command
     * @returns {CommandBuffer | null} only when it is recording
     */
    const recording = (handle, command)=>{
        /** @type {CommandBuffer | null} */
        const buffer = objectOf(handle >>> 0, 'commandBuffer', command);
        if (buffer && buffer.state !== 'recording')
        {
            context.diverge(`${command} was called on a command buffer that is not recording`);
            return null;
        }
        return buffer;
    };

    /** @param {Device} device */
    const openFrame = device=>{
        if (!device.frame)
        {
            device.frame = context.backend().beginFrame();
            device.journal = [];
        }
        return device.frame;
    };

    /**
     * Ends the open frame without presenting: the work reaches the queue,
     * and the surfaces keep what was drawn for a later present.
     *
     * @param {Device} device
     */
    const flushFrame = device=>{
        if (device.frame)
        {
            device.frame.end();
            device.frame = null;
            device.lastFrame = device.journal;
        }
    };

    /**
     * The backend surface behind an attachment of a framebuffer.
     *
     * @param {Framebuffer} framebuffer @param {number} index
     * @returns {Image | null}
     */
    const imageOfAttachment = (framebuffer, index)=>{
        /** @type {{ image: number } | null} */
        const view = objectOf(framebuffer.attachments[index], 'imageView', 'vkCmdBeginRenderPass');
        return view ? objectOf(view.image, 'image', 'vkCmdBeginRenderPass') : null;
    };

    /**
     * A recorded render pass, as a backend pass on the open frame.
     *
     * @param {Device} device @param {RecordedCommand} command
     */
    const replayRenderPass = (device, command)=>{
        /** @type {RenderPass | null} */
        const renderPass = objectOf(command.renderPass ?? 0, 'renderPass', 'vkQueueSubmit');
        /** @type {Framebuffer | null} */
        const framebuffer = objectOf(command.framebuffer ?? 0, 'framebuffer', 'vkQueueSubmit');
        if (!renderPass || !framebuffer)
        {
            return;
        }
        if (renderPass.subpasses.length > 1)
        {
            context.diverge(`a render pass with ${renderPass.subpasses.length} subpasses runs`
                + ' as its first subpass only');
        }
        const subpass = renderPass.subpasses[0];
        if (subpass.color.length > 1)
        {
            context.diverge(`a subpass with ${subpass.color.length} colour attachments draws`
                + ' into the first only');
        }
        const colorIndex = subpass.color[0];
        if (colorIndex === undefined)
        {
            context.diverge('a subpass with no colour attachment is not run');
            return;
        }
        const color = imageOfAttachment(framebuffer, colorIndex);
        if (!color)
        {
            return;
        }
        const clearValues = command.clearValues ?? [];
        const area = command.renderArea;
        if (area && (area.x !== 0 || area.y !== 0 || area.width !== framebuffer.width
            || area.height !== framebuffer.height))
        {
            context.diverge('a render area smaller than the framebuffer clears the whole'
                + ' attachment: WebGPU has no render area');
        }
        const attachment = renderPass.attachments[colorIndex];
        const clear = attachment.loadOp !== VkAttachmentLoadOp.LOAD;
        const floats = clearValues[colorIndex]?.floats;
        const clearValue = attachment.loadOp === VkAttachmentLoadOp.CLEAR && floats
            ? { r: floats[0], g: floats[1], b: floats[2], a: floats[3] }
            : undefined;

        /** @type {import('./physical.js').DepthAttachment | undefined} */
        let depthStencilAttachment;
        /** @type {JournalEntry} */
        const entry = { kind: 'pass', target: color.surface.label, renderArea: area };
        if (clear)
        {
            entry.clearColor = clearValue ?? { r: 0, g: 0, b: 0, a: 1 };
        }
        if (subpass.depth !== null)
        {
            const depth = imageOfAttachment(framebuffer, subpass.depth);
            const description = renderPass.attachments[subpass.depth];
            if (depth)
            {
                const value = clearValues[subpass.depth];
                depthStencilAttachment = {
                    view: depth.surface.view,
                    depthLoadOp: loadOpOf(description.loadOp),
                    depthStoreOp: storeOpOf(description.storeOp),
                    depthClearValue: value ? value.depth : 1,
                };
                if (description.loadOp !== VkAttachmentLoadOp.LOAD)
                {
                    entry.clearDepth = depthStencilAttachment.depthClearValue;
                }
                if (STENCIL_FORMATS.has(depth.format))
                {
                    depthStencilAttachment.stencilLoadOp = loadOpOf(description.stencilLoadOp);
                    depthStencilAttachment.stencilStoreOp = storeOpOf(description.stencilStoreOp);
                    depthStencilAttachment.stencilClearValue = value ? value.stencil : 0;
                    if (description.stencilLoadOp !== VkAttachmentLoadOp.LOAD)
                    {
                        entry.clearStencil = depthStencilAttachment.stencilClearValue;
                    }
                }
            }
        }
        openFrame(device).beginPass({
            target: color.surface,
            clear,
            clearValue,
            depthStencilAttachment,
        });
        device.journal.push(entry);
    };

    /**
     * @param {Device} device @param {CommandBuffer} buffer
     */
    const replay = (device, buffer)=>{
        for (const command of buffer.commands)
        {
            if (command.kind === 'beginRenderPass')
            {
                replayRenderPass(device, command);
            }
            // Viewport, scissor and the end of a pass carry nothing until
            // there is a draw for them to apply to.
        }
    };

    /** @param {number} handle @param {string} command */
    const signal = (handle, command)=>{
        if (handle === 0)
        {
            return;
        }
        const object = /** @type {{ signaled: boolean } | null} */ (/** @type {unknown} */ (
            handles.get(handle, 'fence') ?? handles.get(handle, 'semaphore')));
        if (!object)
        {
            context.diverge(`${command} was asked to signal something that is neither a fence`
                + ' nor a semaphore');
            return;
        }
        object.signaled = true;
    };

    /**
     * A create that only makes a handle: the object has no GPU side until it
     * is used, and using it is where anything can go wrong.
     *
     * @param {string} kind @param {string} command
     * @param {(info: number) => Record<string, unknown>} read
     */
    const simpleCreate = (kind, command, read)=>
        (/** @type {number[]} */ [handle, pCreateInfo, , pOut])=>{
            if (!deviceOf(handle, command))
            {
                return VkResult.ERROR_INITIALIZATION_FAILED;
            }
            writeU64(memory, pOut >>> 0, handles.mint({ kind, ...read(pCreateInfo >>> 0) }));
            return VkResult.SUCCESS;
        };

    /** @param {string} kind @param {string} command */
    const simpleDestroy = (kind, command)=>(/** @type {number[]} */ [, low, high])=>{
        const handle = joinU64(low, high);
        if (handle !== 0 && objectOf(handle, kind, command))
        {
            handles.release(handle);
        }
        return 0;
    };

    const commands = {
        /** void vkDestroyDevice(VkDevice, const VkAllocationCallbacks*) */
        vkDestroyDevice: (/** @type {number[]} */ [handle])=>{
            const device = (handle >>> 0) === 0 ? null : deviceOf(handle, 'vkDestroyDevice');
            if (device)
            {
                flushFrame(device);
                handles.release(device.queue);
                handles.release(device.handle);
            }
            return 0;
        },

        /** void vkGetDeviceQueue(VkDevice, uint32_t family, uint32_t index, VkQueue*) */
        vkGetDeviceQueue: (/** @type {number[]} */ [handle, family, index, pQueue])=>{
            const device = deviceOf(handle, 'vkGetDeviceQueue');
            if (!device)
            {
                return 0;
            }
            if (family !== 0 || index !== 0)
            {
                context.diverge(`vkGetDeviceQueue asked for queue ${index} of family ${family}:`
                    + ' there is one queue in one family');
                writeU32(memory, pQueue >>> 0, 0);
                return 0;
            }
            writeU32(memory, pQueue >>> 0, device.queue);
            return 0;
        },

        /**
         * VkResult vkQueueSubmit(VkQueue, uint32_t, const VkSubmitInfo*, VkFence)
         *
         * Wait semaphores are not waited on: the queue never runs ahead of the
         * order it was given work in, so what a semaphore guards has happened
         * by the time the submit that waits on it arrives.
         */
        vkQueueSubmit: (/** @type {number[]} */ [handle, count, pSubmits, low, high])=>{
            const device = deviceOfQueue(handle, 'vkQueueSubmit');
            if (!device)
            {
                return VkResult.ERROR_DEVICE_LOST;
            }
            for (let index = 0; index < count; index++)
            {
                const submit = (pSubmits >>> 0) + index * VkSubmitInfo.SIZE;
                const buffers = readU32Array(memory,
                    readU32(memory, submit + VkSubmitInfo.pCommandBuffers),
                    readU32(memory, submit + VkSubmitInfo.commandBufferCount));
                for (const each of buffers)
                {
                    /** @type {CommandBuffer | null} */
                    const buffer = objectOf(each, 'commandBuffer', 'vkQueueSubmit');
                    if (!buffer)
                    {
                        continue;
                    }
                    if (buffer.state !== 'executable')
                    {
                        context.diverge('vkQueueSubmit was given a command buffer that was'
                            + ' never ended');
                        continue;
                    }
                    replay(device, buffer);
                }
                const semaphores = readU64Array(memory,
                    readU32(memory, submit + VkSubmitInfo.pSignalSemaphores),
                    readU32(memory, submit + VkSubmitInfo.signalSemaphoreCount));
                semaphores.forEach(each=>signal(each, 'vkQueueSubmit'));
            }
            signal(joinU64(low, high), 'vkQueueSubmit');
            return VkResult.SUCCESS;
        },

        /** VkResult vkQueueWaitIdle(VkQueue) */
        vkQueueWaitIdle: (/** @type {number[]} */ [handle])=>{
            const device = deviceOfQueue(handle, 'vkQueueWaitIdle');
            if (!device)
            {
                return VkResult.ERROR_DEVICE_LOST;
            }
            flushFrame(device);
            return VkResult.SUCCESS;
        },

        /** VkResult vkDeviceWaitIdle(VkDevice) */
        vkDeviceWaitIdle: (/** @type {number[]} */ [handle])=>{
            const device = deviceOf(handle, 'vkDeviceWaitIdle');
            if (!device)
            {
                return VkResult.ERROR_DEVICE_LOST;
            }
            flushFrame(device);
            return VkResult.SUCCESS;
        },

        // --- fences and semaphores ---

        vkCreateFence: simpleCreate('fence', 'vkCreateFence', info=>({
            signaled: (readU32(memory, info + VkFenceCreateInfo.flags)
                & VkFenceCreateFlagBits.SIGNALED) !== 0,
        })),
        vkDestroyFence: simpleDestroy('fence', 'vkDestroyFence'),
        vkCreateSemaphore: simpleCreate('semaphore', 'vkCreateSemaphore', ()=>({
            signaled: false,
        })),
        vkDestroySemaphore: simpleDestroy('semaphore', 'vkDestroySemaphore'),

        /** VkResult vkResetFences(VkDevice, uint32_t, const VkFence*) */
        vkResetFences: (/** @type {number[]} */ [handle, count, pFences])=>{
            if (!deviceOf(handle, 'vkResetFences'))
            {
                return VkResult.ERROR_DEVICE_LOST;
            }
            for (const each of readU64Array(memory, pFences >>> 0, count))
            {
                /** @type {{ signaled: boolean } | null} */
                const fence = objectOf(each, 'fence', 'vkResetFences');
                if (fence)
                {
                    fence.signaled = false;
                }
            }
            return VkResult.SUCCESS;
        },

        /** VkResult vkGetFenceStatus(VkDevice, VkFence) */
        vkGetFenceStatus: (/** @type {number[]} */ [handle, low, high])=>{
            /** @type {{ signaled: boolean } | null} */
            const fence = deviceOf(handle, 'vkGetFenceStatus')
                ? objectOf(joinU64(low, high), 'fence', 'vkGetFenceStatus')
                : null;
            if (!fence)
            {
                return VkResult.ERROR_DEVICE_LOST;
            }
            return fence.signaled ? VkResult.SUCCESS : VkResult.NOT_READY;
        },

        /**
         * VkResult vkWaitForFences(VkDevice, uint32_t, const VkFence*, VkBool32 waitAll,
         *     uint64_t timeout)
         *
         * Nothing here is asynchronous, so a fence that is not signalled now
         * will not be signalled by waiting: the honest answer is the timeout,
         * whatever the timeout was.
         */
        vkWaitForFences: (/** @type {number[]} */ [handle, count, pFences, waitAll])=>{
            if (!deviceOf(handle, 'vkWaitForFences'))
            {
                return VkResult.ERROR_DEVICE_LOST;
            }
            const states = readU64Array(memory, pFences >>> 0, count).map(each=>{
                /** @type {{ signaled: boolean } | null} */
                const fence = objectOf(each, 'fence', 'vkWaitForFences');
                return fence ? fence.signaled : false;
            });
            const done = waitAll !== 0 ? states.every(Boolean) : states.some(Boolean);
            return done ? VkResult.SUCCESS : VkResult.TIMEOUT;
        },

        // --- memory ---

        /**
         * VkResult vkAllocateMemory(VkDevice, const VkMemoryAllocateInfo*,
         *     const VkAllocationCallbacks*, VkDeviceMemory*)
         *
         * An allocation is bookkeeping: the image or buffer it will be bound
         * to already has, or will make, its own GPU storage.
         */
        vkAllocateMemory: simpleCreate('deviceMemory', 'vkAllocateMemory', info=>({
            size: readU64(memory, info + VkMemoryAllocateInfo.allocationSize),
            typeIndex: readU32(memory, info + VkMemoryAllocateInfo.memoryTypeIndex),
        })),
        vkFreeMemory: simpleDestroy('deviceMemory', 'vkFreeMemory'),

        /** void vkGetImageMemoryRequirements(VkDevice, VkImage, VkMemoryRequirements*) */
        vkGetImageMemoryRequirements: (/** @type {number[]} */ [handle, low, high,
            pRequirements])=>{
            /** @type {Image | null} */
            const image = deviceOf(handle, 'vkGetImageMemoryRequirements')
                ? objectOf(joinU64(low, high), 'image', 'vkGetImageMemoryRequirements')
                : null;
            if (!image)
            {
                return 0;
            }
            const at = pRequirements >>> 0;
            writeU64(memory, at + VkMemoryRequirements.size,
                image.width * image.height * BYTES_PER_TEXEL);
            writeU64(memory, at + VkMemoryRequirements.alignment, 256);
            // Device-local types only: an image is never mapped.
            writeU32(memory, at + VkMemoryRequirements.memoryTypeBits, 0b101);
            return 0;
        },

        /** VkResult vkBindImageMemory(VkDevice, VkImage, VkDeviceMemory, VkDeviceSize) */
        vkBindImageMemory: (/** @type {number[]} */ [handle, low, high, memoryLow,
            memoryHigh])=>{
            if (!deviceOf(handle, 'vkBindImageMemory')
                || !objectOf(joinU64(low, high), 'image', 'vkBindImageMemory')
                || !objectOf(joinU64(memoryLow, memoryHigh), 'deviceMemory', 'vkBindImageMemory'))
            {
                return VkResult.ERROR_DEVICE_LOST;
            }
            return VkResult.SUCCESS;
        },

        // --- images and views ---

        /**
         * VkResult vkCreateImage(VkDevice, const VkImageCreateInfo*,
         *     const VkAllocationCallbacks*, VkImage*)
         *
         * A two-dimensional single-level single-sample image in a format the
         * GPU has a name for. Anything else is refused by name, because the
         * program will go on to draw with it and a wrong image is a wrong
         * picture with no trace.
         */
        vkCreateImage: (/** @type {number[]} */ [handle, pCreateInfo, , pImage])=>{
            if (!deviceOf(handle, 'vkCreateImage'))
            {
                return VkResult.ERROR_INITIALIZATION_FAILED;
            }
            const info = pCreateInfo >>> 0;
            const I = VkImageCreateInfo;
            const format = readU32(memory, info + I.format);
            const gpuFormat = GPU_FORMAT[format];
            const width = readU32(memory, info + I.extent + VkExtent3D.width);
            const height = readU32(memory, info + I.extent + VkExtent3D.height);
            const refusals = [
                [readU32(memory, info + I.imageType) !== VkImageType.TYPE_2D, 'is not 2D'],
                [gpuFormat === undefined, `is in ${formatName(format)}`],
                [readU32(memory, info + I.mipLevels) !== 1, 'has more than one mip level'],
                [readU32(memory, info + I.arrayLayers) !== 1, 'has more than one layer'],
                [readU32(memory, info + I.samples) !== VkSampleCountFlagBits.COUNT_1,
                    'is multisampled'],
            ].filter(([refused])=>refused).map(([, why])=>why);
            if (refusals.length > 0)
            {
                context.diverge(`vkCreateImage refused an image that ${refusals.join(', ')}`);
                return VkResult.ERROR_FEATURE_NOT_PRESENT;
            }
            const surface = context.backend().createSurface({
                width,
                height,
                format: gpuFormat,
                usage: DEPTH_FORMATS.has(format) ? RENDER_ATTACHMENT : undefined,
                label: `image:${formatName(format)}`,
            });
            writeU64(memory, pImage >>> 0, handles.mint(/** @type {Image} */ ({
                kind: 'image', surface, width, height, format, swapchain: null,
            })));
            return VkResult.SUCCESS;
        },

        /**
         * void vkDestroyImage(VkDevice, VkImage, const VkAllocationCallbacks*)
         *
         * A swapchain's images belong to the swapchain, and destroying one
         * directly is a program error the specification leaves undefined.
         */
        vkDestroyImage: (/** @type {number[]} */ [, low, high])=>{
            const handle = joinU64(low, high);
            /** @type {Image | null} */
            const image = handle === 0 ? null : objectOf(handle, 'image', 'vkDestroyImage');
            if (image && image.swapchain !== null)
            {
                context.diverge('vkDestroyImage was given an image owned by a swapchain');
                return 0;
            }
            if (image)
            {
                handles.release(handle);
            }
            return 0;
        },

        /**
         * VkResult vkCreateImageView(VkDevice, const VkImageViewCreateInfo*,
         *     const VkAllocationCallbacks*, VkImageView*)
         */
        vkCreateImageView: (/** @type {number[]} */ [handle, pCreateInfo, , pView])=>{
            if (!deviceOf(handle, 'vkCreateImageView'))
            {
                return VkResult.ERROR_INITIALIZATION_FAILED;
            }
            const info = pCreateInfo >>> 0;
            const image = readU64(memory, info + VkImageViewCreateInfo.image);
            if (!objectOf(image, 'image', 'vkCreateImageView'))
            {
                return VkResult.ERROR_INITIALIZATION_FAILED;
            }
            writeU64(memory, pView >>> 0, handles.mint({
                kind: 'imageView',
                image,
                format: readU32(memory, info + VkImageViewCreateInfo.format),
            }));
            return VkResult.SUCCESS;
        },
        vkDestroyImageView: simpleDestroy('imageView', 'vkDestroyImageView'),

        // --- shader modules ---

        /**
         * VkResult vkCreateShaderModule(VkDevice, const VkShaderModuleCreateInfo*,
         *     const VkAllocationCallbacks*, VkShaderModule*)
         *
         * The module is decoded now and kept decoded: creation is where a
         * program hands the bytes over, and what it declares -- a capability
         * with no WebGPU counterpart, an entry point for a stage that does
         * not exist -- is said here, once, where the log can tie it to the
         * pipeline that later cannot be made from it.
         */
        vkCreateShaderModule: (/** @type {number[]} */ [handle, pCreateInfo, , pModule])=>{
            if (!deviceOf(handle, 'vkCreateShaderModule'))
            {
                return VkResult.ERROR_INITIALIZATION_FAILED;
            }
            const info = pCreateInfo >>> 0;
            const size = readU32(memory, info + VkShaderModuleCreateInfo.codeSize);
            const code = readU32(memory, info + VkShaderModuleCreateInfo.pCode);
            const decoded = decodeSpirv(memory.readMemory(code, size));
            if ('error' in decoded)
            {
                context.diverge(`vkCreateShaderModule refused ${size} bytes: ${decoded.error}`);
                return VkResult.ERROR_INITIALIZATION_FAILED;
            }
            const { module } = decoded;
            const refused = unsupportedCapabilities(module);
            const stages = module.entryPoints
                .map(entry=>`${EXECUTION_MODELS[entry.model] ?? `model ${entry.model}`}`
                    + ` "${entry.name}"`);
            if (refused.length > 0)
            {
                context.diverge(`a SPIR-V ${versionString(module.version)} module`
                    + ` (${stages.join(', ')}) declares ${refused.join(', ')}: no pipeline`
                    + ' can be made from it on WebGPU');
            }
            writeU64(memory, pModule >>> 0, handles.mint({
                kind: 'shaderModule', module, refused,
            }));
            return VkResult.SUCCESS;
        },
        vkDestroyShaderModule: simpleDestroy('shaderModule', 'vkDestroyShaderModule'),

        // --- render passes and framebuffers ---

        /**
         * VkResult vkCreateRenderPass(VkDevice, const VkRenderPassCreateInfo*,
         *     const VkAllocationCallbacks*, VkRenderPass*)
         *
         * Dependencies are read and dropped: WebGPU orders passes itself.
         */
        vkCreateRenderPass: simpleCreate('renderPass', 'vkCreateRenderPass', info=>{
            const R = VkRenderPassCreateInfo;
            const attachmentCount = readU32(memory, info + R.attachmentCount);
            const attachmentsAt = readU32(memory, info + R.pAttachments);
            const attachments = Array.from({ length: attachmentCount }, (unused, index)=>{
                const at = attachmentsAt + index * VkAttachmentDescription.SIZE;
                const A = VkAttachmentDescription;
                return {
                    format: readU32(memory, at + A.format),
                    loadOp: readU32(memory, at + A.loadOp),
                    storeOp: readU32(memory, at + A.storeOp),
                    stencilLoadOp: readU32(memory, at + A.stencilLoadOp),
                    stencilStoreOp: readU32(memory, at + A.stencilStoreOp),
                };
            });
            const subpassCount = readU32(memory, info + R.subpassCount);
            const subpassesAt = readU32(memory, info + R.pSubpasses);
            const subpasses = Array.from({ length: subpassCount }, (unused, index)=>{
                const at = subpassesAt + index * VkSubpassDescription.SIZE;
                const P = VkSubpassDescription;
                const colorCount = readU32(memory, at + P.colorAttachmentCount);
                const colorsAt = readU32(memory, at + P.pColorAttachments);
                const color = Array.from({ length: colorCount }, (unused2, each)=>readU32(memory,
                    colorsAt + each * VkAttachmentReference.SIZE
                        + VkAttachmentReference.attachment))
                    .filter(reference=>reference !== VK_UNUSED);
                const depthAt = readU32(memory, at + P.pDepthStencilAttachment);
                const depth = depthAt === 0
                    ? VK_UNUSED
                    : readU32(memory, depthAt + VkAttachmentReference.attachment);
                return { color, depth: depth === VK_UNUSED ? null : depth };
            });
            return { attachments, subpasses };
        }),
        vkDestroyRenderPass: simpleDestroy('renderPass', 'vkDestroyRenderPass'),

        /**
         * VkResult vkCreateFramebuffer(VkDevice, const VkFramebufferCreateInfo*,
         *     const VkAllocationCallbacks*, VkFramebuffer*)
         */
        vkCreateFramebuffer: simpleCreate('framebuffer', 'vkCreateFramebuffer', info=>{
            const F = VkFramebufferCreateInfo;
            return {
                renderPass: readU64(memory, info + F.renderPass),
                attachments: readU64Array(memory, readU32(memory, info + F.pAttachments),
                    readU32(memory, info + F.attachmentCount)),
                width: readU32(memory, info + F.width),
                height: readU32(memory, info + F.height),
            };
        }),
        vkDestroyFramebuffer: simpleDestroy('framebuffer', 'vkDestroyFramebuffer'),

        // --- command pools and buffers ---

        vkCreateCommandPool: simpleCreate('commandPool', 'vkCreateCommandPool',
            ()=>({ buffers: new Set() })),

        /** void vkDestroyCommandPool(VkDevice, VkCommandPool, const VkAllocationCallbacks*) */
        vkDestroyCommandPool: (/** @type {number[]} */ [, low, high])=>{
            const handle = joinU64(low, high);
            /** @type {{ buffers: Set<number> } | null} */
            const pool = handle === 0
                ? null
                : objectOf(handle, 'commandPool', 'vkDestroyCommandPool');
            if (pool)
            {
                pool.buffers.forEach(each=>handles.release(each));
                handles.release(handle);
            }
            return 0;
        },

        /** VkResult vkResetCommandPool(VkDevice, VkCommandPool, VkCommandPoolResetFlags) */
        vkResetCommandPool: (/** @type {number[]} */ [handle, low, high])=>{
            /** @type {{ buffers: Set<number> } | null} */
            const pool = deviceOf(handle, 'vkResetCommandPool')
                ? objectOf(joinU64(low, high), 'commandPool', 'vkResetCommandPool')
                : null;
            if (!pool)
            {
                return VkResult.ERROR_DEVICE_LOST;
            }
            for (const each of pool.buffers)
            {
                /** @type {CommandBuffer | null} */
                const buffer = objectOf(each, 'commandBuffer', 'vkResetCommandPool');
                if (buffer)
                {
                    buffer.state = 'initial';
                    buffer.commands = [];
                }
            }
            return VkResult.SUCCESS;
        },

        /**
         * VkResult vkAllocateCommandBuffers(VkDevice, const VkCommandBufferAllocateInfo*,
         *     VkCommandBuffer*)
         *
         * Command buffers are dispatchable: the out-array is an array of
         * pointers, four bytes each, unlike every other handle array here.
         */
        vkAllocateCommandBuffers: (/** @type {number[]} */ [handle, pAllocateInfo, pBuffers])=>{
            if (!deviceOf(handle, 'vkAllocateCommandBuffers'))
            {
                return VkResult.ERROR_INITIALIZATION_FAILED;
            }
            const info = pAllocateInfo >>> 0;
            const A = VkCommandBufferAllocateInfo;
            const poolHandle = readU64(memory, info + A.commandPool);
            /** @type {{ buffers: Set<number> } | null} */
            const pool = objectOf(poolHandle, 'commandPool', 'vkAllocateCommandBuffers');
            if (!pool)
            {
                return VkResult.ERROR_INITIALIZATION_FAILED;
            }
            if (readU32(memory, info + A.level) !== VkCommandBufferLevel.PRIMARY)
            {
                context.diverge('vkAllocateCommandBuffers refused secondary command buffers');
                return VkResult.ERROR_FEATURE_NOT_PRESENT;
            }
            const count = readU32(memory, info + A.commandBufferCount);
            for (let index = 0; index < count; index++)
            {
                const buffer = handles.mintDispatchable(/** @type {CommandBuffer} */ ({
                    kind: 'commandBuffer', pool: poolHandle, state: 'initial', commands: [],
                }));
                pool.buffers.add(buffer);
                writeU32(memory, (pBuffers >>> 0) + index * 4, buffer);
            }
            return VkResult.SUCCESS;
        },

        /** void vkFreeCommandBuffers(VkDevice, VkCommandPool, uint32_t, const VkCommandBuffer*) */
        vkFreeCommandBuffers: (/** @type {number[]} */ [, low, high, count, pBuffers])=>{
            /** @type {{ buffers: Set<number> } | null} */
            const pool = objectOf(joinU64(low, high), 'commandPool', 'vkFreeCommandBuffers');
            if (!pool)
            {
                return 0;
            }
            for (const each of readU32Array(memory, pBuffers >>> 0, count))
            {
                if (each !== 0 && objectOf(each, 'commandBuffer', 'vkFreeCommandBuffers'))
                {
                    pool.buffers.delete(each);
                    handles.release(each);
                }
            }
            return 0;
        },

        /**
         * VkResult vkBeginCommandBuffer(VkCommandBuffer, const VkCommandBufferBeginInfo*)
         *
         * Beginning a buffer that was recorded before resets it. The
         * specification makes that conditional on the pool's reset flag; a
         * program that begins without it has a bug a validation layer would
         * catch, and the useful behaviour here is the one it meant.
         */
        vkBeginCommandBuffer: (/** @type {number[]} */ [handle])=>{
            /** @type {CommandBuffer | null} */
            const buffer = objectOf(handle >>> 0, 'commandBuffer', 'vkBeginCommandBuffer');
            if (!buffer)
            {
                return VkResult.ERROR_INITIALIZATION_FAILED;
            }
            buffer.state = 'recording';
            buffer.commands = [];
            return VkResult.SUCCESS;
        },

        /** VkResult vkEndCommandBuffer(VkCommandBuffer) */
        vkEndCommandBuffer: (/** @type {number[]} */ [handle])=>{
            const buffer = recording(handle, 'vkEndCommandBuffer');
            if (!buffer)
            {
                return VkResult.ERROR_INITIALIZATION_FAILED;
            }
            buffer.state = 'executable';
            return VkResult.SUCCESS;
        },

        /** VkResult vkResetCommandBuffer(VkCommandBuffer, VkCommandBufferResetFlags) */
        vkResetCommandBuffer: (/** @type {number[]} */ [handle])=>{
            /** @type {CommandBuffer | null} */
            const buffer = objectOf(handle >>> 0, 'commandBuffer', 'vkResetCommandBuffer');
            if (!buffer)
            {
                return VkResult.ERROR_INITIALIZATION_FAILED;
            }
            buffer.state = 'initial';
            buffer.commands = [];
            return VkResult.SUCCESS;
        },

        /**
         * void vkCmdBeginRenderPass(VkCommandBuffer, const VkRenderPassBeginInfo*,
         *     VkSubpassContents)
         *
         * The clear values are copied now: the structure is the program's and
         * is gone by the time the buffer is submitted.
         */
        vkCmdBeginRenderPass: (/** @type {number[]} */ [handle, pBeginInfo])=>{
            const buffer = recording(handle, 'vkCmdBeginRenderPass');
            if (!buffer)
            {
                return 0;
            }
            const info = pBeginInfo >>> 0;
            const B = VkRenderPassBeginInfo;
            const count = readU32(memory, info + B.clearValueCount);
            const valuesAt = readU32(memory, info + B.pClearValues);
            const clearValues = Array.from({ length: count }, (unused, index)=>{
                const at = valuesAt + index * VkClearValue.SIZE;
                return {
                    floats: readF32Array(memory, at, 4),
                    depth: readF32(memory, at + VkClearDepthStencilValue.depth),
                    stencil: readU32(memory, at + VkClearDepthStencilValue.stencil),
                };
            });
            buffer.commands.push({
                kind: 'beginRenderPass',
                renderPass: readU64(memory, info + B.renderPass),
                framebuffer: readU64(memory, info + B.framebuffer),
                renderArea: readRect2D(memory, info + B.renderArea),
                clearValues,
            });
            return 0;
        },

        /** void vkCmdEndRenderPass(VkCommandBuffer) */
        vkCmdEndRenderPass: (/** @type {number[]} */ [handle])=>{
            recording(handle, 'vkCmdEndRenderPass')?.commands.push({ kind: 'endRenderPass' });
            return 0;
        },

        /** void vkCmdNextSubpass(VkCommandBuffer, VkSubpassContents) */
        vkCmdNextSubpass: (/** @type {number[]} */ [handle])=>{
            if (recording(handle, 'vkCmdNextSubpass'))
            {
                context.diverge('vkCmdNextSubpass does nothing: a render pass runs as its'
                    + ' first subpass only');
            }
            return 0;
        },

        /**
         * void vkCmdSetViewport(VkCommandBuffer, uint32_t first, uint32_t count,
         *     const VkViewport*)
         */
        vkCmdSetViewport: (/** @type {number[]} */ [handle, first, count, pViewports])=>{
            const buffer = recording(handle, 'vkCmdSetViewport');
            if (!buffer)
            {
                return 0;
            }
            if (first !== 0 || count !== 1)
            {
                context.diverge('vkCmdSetViewport set a viewport other than the first: there'
                    + ' is one viewport');
            }
            const at = pViewports >>> 0;
            buffer.commands.push({
                kind: 'viewport',
                viewport: {
                    x: readF32(memory, at + VkViewport.x),
                    y: readF32(memory, at + VkViewport.y),
                    width: readF32(memory, at + VkViewport.width),
                    height: readF32(memory, at + VkViewport.height),
                    minDepth: readF32(memory, at + VkViewport.minDepth),
                    maxDepth: readF32(memory, at + VkViewport.maxDepth),
                },
            });
            return 0;
        },

        /** void vkCmdSetScissor(VkCommandBuffer, uint32_t first, uint32_t count, const VkRect2D*) */
        vkCmdSetScissor: (/** @type {number[]} */ [handle, first, count, pScissors])=>{
            const buffer = recording(handle, 'vkCmdSetScissor');
            if (!buffer)
            {
                return 0;
            }
            if (first !== 0 || count !== 1)
            {
                context.diverge('vkCmdSetScissor set a scissor other than the first: there is'
                    + ' one viewport');
            }
            buffer.commands.push({ kind: 'scissor', scissor: readRect2D(memory, pScissors >>> 0) });
            return 0;
        },

        /**
         * void vkCmdPipelineBarrier(...)
         *
         * Nothing to do: WebGPU tracks every hazard itself, and a layout
         * transition has no counterpart. Accepted silently because a program
         * issues these on every frame and a divergence per barrier would
         * drown the ones that matter.
         */
        vkCmdPipelineBarrier: (/** @type {number[]} */ [handle])=>{
            recording(handle, 'vkCmdPipelineBarrier');
            return 0;
        },

        // --- VK_KHR_swapchain ---

        /**
         * VkResult vkCreateSwapchainKHR(VkDevice, const VkSwapchainCreateInfoKHR*,
         *     const VkAllocationCallbacks*, VkSwapchainKHR*)
         *
         * The extent becomes the screen: a swapchain is the display, and a
         * program that asks for 1024x768 has decided the resolution the way
         * a Direct3D program decides it with its back buffer.
         */
        vkCreateSwapchainKHR: (/** @type {number[]} */ [handle, pCreateInfo, , pSwapchain])=>{
            const device = deviceOf(handle, 'vkCreateSwapchainKHR');
            if (!device)
            {
                return VkResult.ERROR_INITIALIZATION_FAILED;
            }
            if (!device.extensions.has('VK_KHR_swapchain'))
            {
                context.diverge('vkCreateSwapchainKHR was called on a device that did not'
                    + ' enable VK_KHR_swapchain');
            }
            const info = pCreateInfo >>> 0;
            const S = VkSwapchainCreateInfoKHR;
            const surface = readU64(memory, info + S.surface);
            if (!objectOf(surface, 'surface', 'vkCreateSwapchainKHR'))
            {
                return VkResult.ERROR_SURFACE_LOST_KHR;
            }
            const format = readU32(memory, info + S.imageFormat);
            if (!SURFACE_FORMATS.some(each=>each.format === format))
            {
                context.diverge(`vkCreateSwapchainKHR refused ${formatName(format)}: the`
                    + ' surface did not offer it');
                return VkResult.ERROR_INITIALIZATION_FAILED;
            }
            const width = readU32(memory, info + S.imageExtent + VkExtent2D.width);
            const height = readU32(memory, info + S.imageExtent + VkExtent2D.height);
            const count = Math.max(1, readU32(memory, info + S.minImageCount));
            const old = readU64(memory, info + S.oldSwapchain);
            if (old !== 0)
            {
                /** @type {Swapchain | null} */
                const retired = objectOf(old, 'swapchain', 'vkCreateSwapchainKHR');
                if (retired)
                {
                    retired.retired = true;
                }
            }
            context.resolution?.(width, height);
            const chain = context.backend().createSwapChain({
                count, width, height, format: GPU_FORMAT[format], label: 'swapchain',
            });
            /** @type {Swapchain} */
            const swapchain = { kind: 'swapchain', surface, images: [], next: 0, retired: false };
            const swapchainHandle = handles.mint(swapchain);
            swapchain.images = chain.surfaces.map(each=>handles.mint(/** @type {Image} */ ({
                kind: 'image', surface: each, width, height, format, swapchain: swapchainHandle,
            })));
            writeU64(memory, pSwapchain >>> 0, swapchainHandle);
            return VkResult.SUCCESS;
        },

        /** void vkDestroySwapchainKHR(VkDevice, VkSwapchainKHR, const VkAllocationCallbacks*) */
        vkDestroySwapchainKHR: (/** @type {number[]} */ [, low, high])=>{
            const handle = joinU64(low, high);
            /** @type {Swapchain | null} */
            const swapchain = handle === 0
                ? null
                : objectOf(handle, 'swapchain', 'vkDestroySwapchainKHR');
            if (swapchain)
            {
                swapchain.images.forEach(each=>handles.release(each));
                handles.release(handle);
            }
            return 0;
        },

        /** VkResult vkGetSwapchainImagesKHR(VkDevice, VkSwapchainKHR, uint32_t*, VkImage*) */
        vkGetSwapchainImagesKHR: (/** @type {number[]} */ [handle, low, high, pCount,
            pImages])=>{
            /** @type {Swapchain | null} */
            const swapchain = deviceOf(handle, 'vkGetSwapchainImagesKHR')
                ? objectOf(joinU64(low, high), 'swapchain', 'vkGetSwapchainImagesKHR')
                : null;
            if (!swapchain)
            {
                return VkResult.ERROR_DEVICE_LOST;
            }
            return enumerate(context, pCount >>> 0, pImages >>> 0, swapchain.images, 8,
                (address, image)=>writeU64(memory, address, image));
        },

        /**
         * VkResult vkAcquireNextImageKHR(VkDevice, VkSwapchainKHR, uint64_t timeout,
         *     VkSemaphore, VkFence, uint32_t* pImageIndex)
         *
         * An image is always available: the backend serialises frames, so the
         * image presented last time is free again by the time this is asked.
         * The semaphore and fence are signalled here and now for the same
         * reason.
         */
        vkAcquireNextImageKHR: (/** @type {number[]} */ [handle, low, high, , , semaphoreLow,
            semaphoreHigh, fenceLow, fenceHigh, pIndex])=>{
            /** @type {Swapchain | null} */
            const swapchain = deviceOf(handle, 'vkAcquireNextImageKHR')
                ? objectOf(joinU64(low, high), 'swapchain', 'vkAcquireNextImageKHR')
                : null;
            if (!swapchain)
            {
                return VkResult.ERROR_DEVICE_LOST;
            }
            if (swapchain.retired)
            {
                return VkResult.ERROR_OUT_OF_DATE_KHR;
            }
            writeU32(memory, pIndex >>> 0, swapchain.next);
            swapchain.next = (swapchain.next + 1) % swapchain.images.length;
            signal(joinU64(semaphoreLow, semaphoreHigh), 'vkAcquireNextImageKHR');
            signal(joinU64(fenceLow, fenceHigh), 'vkAcquireNextImageKHR');
            return VkResult.SUCCESS;
        },

        /**
         * VkResult vkQueuePresentKHR(VkQueue, const VkPresentInfoKHR*)
         *
         * The one place the frame ends. There is one display, so one swapchain
         * is presented per call; a program presenting to several at once is
         * told the others were not.
         */
        vkQueuePresentKHR: (/** @type {number[]} */ [handle, pPresentInfo])=>{
            const device = deviceOfQueue(handle, 'vkQueuePresentKHR');
            if (!device)
            {
                return VkResult.ERROR_DEVICE_LOST;
            }
            const info = pPresentInfo >>> 0;
            const P = VkPresentInfoKHR;
            const count = readU32(memory, info + P.swapchainCount);
            const swapchains = readU64Array(memory, readU32(memory, info + P.pSwapchains), count);
            const indices = readU32Array(memory, readU32(memory, info + P.pImageIndices), count);
            const pResults = readU32(memory, info + P.pResults);
            /** @type {number} */
            let result = VkResult.SUCCESS;
            swapchains.forEach((each, index)=>{
                /** @type {Swapchain | null} */
                const swapchain = objectOf(each, 'swapchain', 'vkQueuePresentKHR');
                /** @type {number} */
                let outcome = VkResult.SUCCESS;
                if (!swapchain)
                {
                    outcome = VkResult.ERROR_DEVICE_LOST;
                }
                else if (swapchain.retired)
                {
                    outcome = VkResult.ERROR_OUT_OF_DATE_KHR;
                }
                else if (index > 0)
                {
                    context.diverge('vkQueuePresentKHR presented the first swapchain only:'
                        + ' there is one display');
                    outcome = VkResult.ERROR_OUT_OF_DATE_KHR;
                }
                else
                {
                    /** @type {Image | null} */
                    const image = objectOf(swapchain.images[indices[index]] ?? 0, 'image',
                        'vkQueuePresentKHR');
                    if (!image)
                    {
                        outcome = VkResult.ERROR_OUT_OF_DATE_KHR;
                    }
                    else
                    {
                        const frame = openFrame(device);
                        frame.present(image.surface);
                        device.journal.push({ kind: 'present', target: image.surface.label });
                        flushFrame(device);
                        context.backend().markPresent();
                    }
                }
                if (pResults !== 0)
                {
                    writeU32(memory, pResults + index * 4, outcome);
                }
                if (outcome !== VkResult.SUCCESS && result === VkResult.SUCCESS)
                {
                    result = outcome;
                }
            });
            return result;
        },
    };

    return {
        commands,

        /**
         * Whether `vkGetDeviceProcAddr` answers for a name: device-level
         * commands only, and an extension's only when the device enabled it.
         *
         * @param {number} deviceHandle
         * @param {string} name
         * @returns {boolean}
         */
        deviceProcVisible(deviceHandle, name){
            const command = COMMANDS[name];
            const device = /** @type {Device | null} */ (handles.get(deviceHandle, 'device'));
            if (!command || !device || command.level !== 'device')
            {
                return false;
            }
            return !command.extension || (command.extension in DEVICE_EXTENSIONS
                && device.extensions.has(command.extension));
        },

        /**
         * The journal of the last presented frame on a device, for a report and
         * for the tests that evaluate it.
         *
         * @param {number} deviceHandle
         * @returns {JournalEntry[]}
         */
        lastFrame(deviceHandle){
            const device = /** @type {Device | null} */ (handles.get(deviceHandle, 'device'));
            return device ? device.lastFrame : [];
        },
    };
}
