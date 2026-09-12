/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The path to a cleared frame, end to end: instance, device, surface,
 * swapchain, an acquired image, a command buffer whose render pass clears it,
 * a submit and a present.
 *
 * Two kinds of test, kept apart as the other drawing APIs keep them.
 * **Byte-exact**: the frame the device replayed is evaluated on the processor
 * with the software reference and compared byte for byte against a stored
 * image. **Recorded commands**: what the GPU was asked to do -- which pass,
 * with which load operation and clear value, presented from which surface --
 * is read off the recording device. Nothing here judges a frame by looking
 * at it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    VK_UNUSED, VkAttachmentLoadOp, VkAttachmentStoreOp, VkFenceCreateFlagBits, VkFormat,
    VkImageLayout, VkImageType, VkImageUsageFlagBits, VkResult, VkSampleCountFlagBits,
    VkSubpassContents,
} from './constants.js';
import {
    VkApplicationInfo, VkAttachmentDescription, VkAttachmentReference, VkClearValue,
    VkCommandBufferAllocateInfo, VkCommandBufferBeginInfo, VkCommandPoolCreateInfo,
    VkDeviceCreateInfo, VkDeviceQueueCreateInfo, VkExtent3D, VkFenceCreateInfo,
    VkFramebufferCreateInfo, VkImageCreateInfo, VkImageViewCreateInfo, VkInstanceCreateInfo,
    VkMemoryAllocateInfo, VkMemoryRequirements, VkPresentInfoKHR, VkRect2D,
    VkRenderPassBeginInfo, VkRenderPassCreateInfo, VkSemaphoreCreateInfo,
    VkShaderModuleCreateInfo, VkSubmitInfo,
    VkSubpassDescription, VkSwapchainCreateInfoKHR, VkWin32SurfaceCreateInfoKHR, writeF32,
    writeU32,
} from './structs.js';
import { createFixture, f32, u64 } from './fixture.js';
import { Op, SPIRV_MAGIC } from './spirv.js';
import {
    clear as referenceClear, createReferenceSurface, toBase64,
} from '../webgpu/internal/reference.js';

/**
 * Everything up to a swapchain with its images, as a program does it.
 *
 * @param {{ width?: number, height?: number, images?: number, format?: number }} [options]
 */
function bootstrap(options = {}){
    const width = options.width ?? 4;
    const height = options.height ?? 4;
    const f = createFixture({ screen: { width, height } });
    const out = f.out();

    const instanceInfo = f.put(VkInstanceCreateInfo, {
        pApplicationInfo: f.put(VkApplicationInfo, { apiVersion: 0 }),
        enabledExtensionCount: 2,
        ppEnabledExtensionNames: f.strs(['VK_KHR_surface', 'VK_KHR_win32_surface']),
    });
    assert.equal(f.call('vkCreateInstance', instanceInfo, 0, out), VkResult.SUCCESS);
    const instance = f.u32(out);
    const count = f.out();
    writeU32(f.memory, count, 1);
    assert.equal(f.call('vkEnumeratePhysicalDevices', instance, count, out), VkResult.SUCCESS);
    const physicalDevice = f.u32(out);

    const deviceInfo = f.put(VkDeviceCreateInfo, {
        queueCreateInfoCount: 1,
        pQueueCreateInfos: f.put(VkDeviceQueueCreateInfo, {
            queueCount: 1, pQueuePriorities: f.u32s([0x3f800000]),
        }),
        enabledExtensionCount: 1,
        ppEnabledExtensionNames: f.strs(['VK_KHR_swapchain']),
    });
    assert.equal(f.call('vkCreateDevice', physicalDevice, deviceInfo, 0, out), VkResult.SUCCESS);
    const device = f.u32(out);
    f.call('vkGetDeviceQueue', device, 0, 0, out);
    const queue = f.u32(out);

    const surfaceInfo = f.put(VkWin32SurfaceCreateInfoKHR, { hwnd: 0x10004 });
    assert.equal(f.call('vkCreateWin32SurfaceKHR', instance, surfaceInfo, 0, out),
        VkResult.SUCCESS);
    const surface = f.u64(out);

    const format = options.format ?? VkFormat.B8G8R8A8_UNORM;
    const swapchainInfo = f.put(VkSwapchainCreateInfoKHR, {
        surface: u64(surface),
        minImageCount: options.images ?? 2,
        imageFormat: format,
        imageExtent: width,
        imageArrayLayers: 1,
        imageUsage: VkImageUsageFlagBits.COLOR_ATTACHMENT,
        clipped: 1,
    });
    writeU32(f.memory, swapchainInfo + VkSwapchainCreateInfoKHR.imageExtent + 4, height);
    assert.equal(f.call('vkCreateSwapchainKHR', device, swapchainInfo, 0, out),
        VkResult.SUCCESS);
    const swapchain = f.u64(out);

    assert.equal(f.call('vkGetSwapchainImagesKHR', device, u64(swapchain), count, 0),
        VkResult.SUCCESS);
    const imageCount = f.u32(count);
    const imagesAt = f.alloc(imageCount * 8);
    assert.equal(f.call('vkGetSwapchainImagesKHR', device, u64(swapchain), count, imagesAt),
        VkResult.SUCCESS);
    const images = Array.from({ length: imageCount }, (unused, index)=>f.u64(imagesAt + index * 8));

    /** @param {number} image @param {number} viewFormat */
    const view = (image, viewFormat)=>{
        const info = f.put(VkImageViewCreateInfo, {
            image: u64(image), viewType: 1, format: viewFormat, subresourceRange: 1,
        });
        writeU32(f.memory, info + VkImageViewCreateInfo.subresourceRange + 8, 1);
        writeU32(f.memory, info + VkImageViewCreateInfo.subresourceRange + 16, 1);
        assert.equal(f.call('vkCreateImageView', device, info, 0, out), VkResult.SUCCESS);
        return f.u64(out);
    };

    /**
     * A render pass over one colour attachment and, optionally, a depth one.
     *
     * @param {{ loadOp?: number, depthFormat?: number, depthLoadOp?: number,
     *           stencilLoadOp?: number, subpasses?: number }} [pass]
     */
    const renderPass = (pass = {})=>{
        const attachments = f.alloc(VkAttachmentDescription.SIZE * 2);
        f.putAt(attachments, VkAttachmentDescription, {
            format,
            samples: VkSampleCountFlagBits.COUNT_1,
            loadOp: pass.loadOp ?? VkAttachmentLoadOp.CLEAR,
            storeOp: VkAttachmentStoreOp.STORE,
            stencilLoadOp: VkAttachmentLoadOp.DONT_CARE,
            stencilStoreOp: VkAttachmentStoreOp.DONT_CARE,
            initialLayout: VkImageLayout.UNDEFINED,
            finalLayout: VkImageLayout.PRESENT_SRC_KHR,
        });
        if (pass.depthFormat !== undefined)
        {
            f.putAt(attachments + VkAttachmentDescription.SIZE, VkAttachmentDescription, {
                format: pass.depthFormat,
                samples: VkSampleCountFlagBits.COUNT_1,
                loadOp: pass.depthLoadOp ?? VkAttachmentLoadOp.CLEAR,
                storeOp: VkAttachmentStoreOp.DONT_CARE,
                stencilLoadOp: pass.stencilLoadOp ?? VkAttachmentLoadOp.CLEAR,
                stencilStoreOp: VkAttachmentStoreOp.DONT_CARE,
                initialLayout: VkImageLayout.UNDEFINED,
                finalLayout: VkImageLayout.DEPTH_STENCIL_ATTACHMENT_OPTIMAL,
            });
        }
        const colorRef = f.put(VkAttachmentReference, {
            attachment: 0, layout: VkImageLayout.COLOR_ATTACHMENT_OPTIMAL,
        });
        const depthRef = pass.depthFormat === undefined
            ? 0
            : f.put(VkAttachmentReference, {
                attachment: 1, layout: VkImageLayout.DEPTH_STENCIL_ATTACHMENT_OPTIMAL,
            });
        const subpassCount = pass.subpasses ?? 1;
        const subpasses = f.alloc(VkSubpassDescription.SIZE * subpassCount);
        for (let index = 0; index < subpassCount; index++)
        {
            const at = subpasses + index * VkSubpassDescription.SIZE;
            writeU32(f.memory, at + VkSubpassDescription.colorAttachmentCount, 1);
            writeU32(f.memory, at + VkSubpassDescription.pColorAttachments, colorRef);
            writeU32(f.memory, at + VkSubpassDescription.pDepthStencilAttachment, depthRef);
        }
        const info = f.put(VkRenderPassCreateInfo, {
            attachmentCount: pass.depthFormat === undefined ? 1 : 2,
            pAttachments: attachments,
            subpassCount,
            pSubpasses: subpasses,
        });
        assert.equal(f.call('vkCreateRenderPass', device, info, 0, out), VkResult.SUCCESS);
        return f.u64(out);
    };

    /** @param {number} pass @param {number[]} views */
    const framebuffer = (pass, views)=>{
        const info = f.put(VkFramebufferCreateInfo, {
            renderPass: u64(pass),
            attachmentCount: views.length,
            pAttachments: f.u64s(views),
            width,
            height,
            layers: 1,
        });
        assert.equal(f.call('vkCreateFramebuffer', device, info, 0, out), VkResult.SUCCESS);
        return f.u64(out);
    };

    const poolInfo = f.put(VkCommandPoolCreateInfo, { queueFamilyIndex: 0 });
    assert.equal(f.call('vkCreateCommandPool', device, poolInfo, 0, out), VkResult.SUCCESS);
    const pool = f.u64(out);

    /** @param {number} [n] */
    const commandBuffers = (n = 1)=>{
        const info = f.put(VkCommandBufferAllocateInfo, {
            commandPool: u64(pool), level: 0, commandBufferCount: n,
        });
        const buffers = f.alloc(n * 4);
        assert.equal(f.call('vkAllocateCommandBuffers', device, info, buffers), VkResult.SUCCESS);
        return Array.from({ length: n }, (unused, index)=>f.u32(buffers + index * 4));
    };

    /**
     * Records a render pass that clears, and ends the buffer.
     *
     * @param {number} buffer
     * @param {{ pass: number, framebuffer: number, color?: number[], depth?: number,
     *           stencil?: number, area?: number[], end?: boolean }} what
     */
    const recordClear = (buffer, what)=>{
        assert.equal(f.call('vkBeginCommandBuffer', buffer,
            f.put(VkCommandBufferBeginInfo, { flags: 1 })), VkResult.SUCCESS);
        const values = f.alloc(VkClearValue.SIZE * 2);
        const color = what.color ?? [0, 0, 0, 1];
        color.forEach((channel, index)=>writeF32(f.memory, values + index * 4, channel));
        writeF32(f.memory, values + VkClearValue.SIZE, what.depth ?? 1);
        writeU32(f.memory, values + VkClearValue.SIZE + 4, what.stencil ?? 0);
        const [x, y, w, h] = what.area ?? [0, 0, width, height];
        const begin = f.put(VkRenderPassBeginInfo, {
            renderPass: u64(what.pass),
            framebuffer: u64(what.framebuffer),
            renderArea: x,
            clearValueCount: 2,
            pClearValues: values,
        });
        writeU32(f.memory, begin + VkRenderPassBeginInfo.renderArea + 4, y);
        writeU32(f.memory, begin + VkRenderPassBeginInfo.renderArea + VkRect2D.extent, w);
        writeU32(f.memory, begin + VkRenderPassBeginInfo.renderArea + VkRect2D.extent + 4, h);
        f.call('vkCmdBeginRenderPass', buffer, begin, VkSubpassContents.INLINE);
        f.call('vkCmdEndRenderPass', buffer);
        if (what.end !== false)
        {
            assert.equal(f.call('vkEndCommandBuffer', buffer), VkResult.SUCCESS);
        }
    };

    /** @param {boolean} [signaled] */
    const fence = (signaled = false)=>{
        const info = f.put(VkFenceCreateInfo, {
            flags: signaled ? VkFenceCreateFlagBits.SIGNALED : 0,
        });
        assert.equal(f.call('vkCreateFence', device, info, 0, out), VkResult.SUCCESS);
        return f.u64(out);
    };

    const semaphore = ()=>{
        assert.equal(f.call('vkCreateSemaphore', device, f.put(VkSemaphoreCreateInfo, {}), 0,
            out), VkResult.SUCCESS);
        return f.u64(out);
    };

    /** @param {number} [sem] @param {number} [fenceHandle] */
    const acquire = (sem = 0, fenceHandle = 0)=>{
        const index = f.out();
        assert.equal(f.call('vkAcquireNextImageKHR', device, u64(swapchain), u64(0xffffffff),
            u64(sem), u64(fenceHandle), index), VkResult.SUCCESS);
        return f.u32(index);
    };

    /** @param {number[]} buffers @param {{ fence?: number, signal?: number[] }} [sync] */
    const submit = (buffers, sync = {})=>{
        const signal = sync.signal ?? [];
        const info = f.put(VkSubmitInfo, {
            commandBufferCount: buffers.length,
            pCommandBuffers: f.u32s(buffers),
            signalSemaphoreCount: signal.length,
            pSignalSemaphores: f.u64s(signal),
        });
        return f.call('vkQueueSubmit', queue, 1, info, u64(sync.fence ?? 0));
    };

    /** @param {number} index @param {{ results?: boolean }} [asked] */
    const present = (index, asked = {})=>{
        const results = asked.results ? f.out() : 0;
        const info = f.put(VkPresentInfoKHR, {
            swapchainCount: 1,
            pSwapchains: f.u64s([swapchain]),
            pImageIndices: f.u32s([index]),
            pResults: results,
        });
        const result = f.call('vkQueuePresentKHR', queue, info);
        return { result, written: results === 0 ? null : f.u32(results) | 0 };
    };

    return {
        f, instance, physicalDevice, device, queue, surface, swapchain, images, width, height,
        format, view, renderPass, framebuffer, pool, commandBuffers, recordClear, fence,
        semaphore, acquire, submit, present,
    };
}

/**
 * The software evaluation of the last frame the device presented: each pass's
 * clear, applied to a reference surface of the swapchain's size.
 *
 * @param {ReturnType<typeof bootstrap>} b
 */
function rasterise(b){
    const surface = createReferenceSurface(b.width, b.height);
    for (const entry of b.f.vulkan.lastFrame(b.device))
    {
        if (entry.kind === 'pass' && entry.clearColor)
        {
            const c = entry.clearColor;
            referenceClear(surface, {
                r: Math.round(c.r * 255), g: Math.round(c.g * 255), b: Math.round(c.b * 255),
            });
        }
    }
    return surface;
}

// --- byte-exact ---

test('byte-exact: a cleared swapchain image is the clear colour in every pixel, blue first', ()=>{
    const b = bootstrap();
    const pass = b.renderPass();
    const views = b.images.map(image=>b.view(image, b.format));
    const framebuffers = views.map(each=>b.framebuffer(pass, [each]));
    const [buffer] = b.commandBuffers();
    const index = b.acquire();
    assert.equal(index, 0);
    // Channels all different, because a channel swap is invisible in grey.
    b.recordClear(buffer, {
        pass, framebuffer: framebuffers[index], color: [0x12 / 255, 0x34 / 255, 0x56 / 255, 1],
    });
    const fence = b.fence();
    assert.equal(b.submit([buffer], { fence }), VkResult.SUCCESS);
    assert.equal(b.present(index).result, VkResult.SUCCESS);

    const surface = rasterise(b);
    assert.deepEqual([...surface.bytes.subarray(0, 4)], [0x56, 0x34, 0x12, 0xff]);
    // The whole image: sixteen pixels of the one colour.
    assert.equal(toBase64(surface),
        'VjQS/1Y0Ev9WNBL/VjQS/1Y0Ev9WNBL/VjQS/1Y0Ev9WNBL/VjQS/1Y0Ev9WNBL/VjQS/1Y0Ev9WNBL/VjQS/w==');
});

test('byte-exact: a pass that loads clears nothing, and the frame before it stands', ()=>{
    const b = bootstrap();
    const clearing = b.renderPass();
    const loading = b.renderPass({ loadOp: VkAttachmentLoadOp.LOAD });
    const views = b.images.map(image=>b.view(image, b.format));
    const [first, second] = b.commandBuffers(2);

    let index = b.acquire();
    b.recordClear(first, {
        pass: clearing, framebuffer: b.framebuffer(clearing, [views[index]]),
        color: [1, 0, 0, 1],
    });
    b.submit([first]);
    b.present(index);
    assert.deepEqual([...rasterise(b).bytes.subarray(0, 4)], [0, 0, 255, 255]);

    index = b.acquire();
    b.recordClear(second, {
        pass: loading, framebuffer: b.framebuffer(loading, [views[index]]),
        color: [0, 1, 0, 1],
    });
    b.submit([second]);
    b.present(index);
    const journal = b.f.vulkan.lastFrame(b.device);
    assert.equal(journal[0].kind, 'pass');
    assert.equal(journal[0].clearColor, undefined, 'a load op does not clear');
    assert.deepEqual([...rasterise(b).bytes.subarray(0, 4)], [0, 0, 0, 0],
        'the reference is untouched: nothing in this frame paints');
});

// --- recorded commands ---

test('the GPU is asked for one pass with a clear load op, and the acquired surface is shown', ()=>{
    const b = bootstrap({ width: 8, height: 6, images: 3 });
    assert.deepEqual(b.f.resolutions, [[8, 6]], 'the swapchain extent became the screen');
    assert.equal(b.images.length, 3);
    const pass = b.renderPass();
    const views = b.images.map(image=>b.view(image, b.format));
    const framebuffers = views.map(each=>b.framebuffer(pass, [each]));
    const [buffer] = b.commandBuffers();
    const semaphore = b.semaphore();
    const index = b.acquire(semaphore);
    b.recordClear(buffer, {
        pass, framebuffer: framebuffers[index], color: [0.25, 0.5, 0.75, 1],
    });
    assert.equal(b.f.gpu.count('beginRenderPass'), 0, 'nothing reaches the GPU while recording');
    assert.equal(b.submit([buffer]), VkResult.SUCCESS);
    assert.equal(b.f.gpu.count('beginRenderPass'), 1);
    assert.equal(b.f.gpu.count('submit'), 0, 'the frame is not submitted until presented');

    const { result, written } = b.present(index, { results: true });
    assert.equal(result, VkResult.SUCCESS);
    assert.equal(written, VkResult.SUCCESS);
    assert.equal(b.f.gpu.count('submit'), 1);
    assert.equal(b.f.presented.length, 1);

    const [pass0] = b.f.gpu.of('beginRenderPass');
    const [attachment] = pass0.descriptor.colorAttachments;
    assert.equal(attachment.loadOp, 'clear');
    assert.equal(attachment.storeOp, 'store');
    assert.deepEqual(attachment.clearValue, { r: 0.25, g: 0.5, b: 0.75, a: 1 });
    assert.equal(pass0.descriptor.depthStencilAttachment, undefined);
    // The surface the pass drew into is the surface that was presented, and it
    // is the swapchain's first: acquisition is round-robin from zero.
    assert.equal(attachment.view, b.f.presented[0].surface.view);
    assert.equal(b.f.presented[0].surface.label, 'swapchain[0]');
    assert.equal(b.f.presented[0].surface.width, 8);
    assert.equal(b.f.presented[0].surface.height, 6);
    assert.equal(b.f.presented[0].surface.format, 'bgra8unorm');

    // The next two acquisitions walk the chain, then it wraps.
    assert.equal(b.acquire(), 1);
    assert.equal(b.acquire(), 2);
    assert.equal(b.acquire(), 0);
    assert.deepEqual(b.f.divergences, []);
});

test('a depth attachment reaches the GPU with its own load ops, stencil only when it has one', ()=>{
    const b = bootstrap();
    /** @param {number} format */
    const depthImage = format=>{
        const out = b.f.out();
        const info = b.f.put(VkImageCreateInfo, {
            imageType: VkImageType.TYPE_2D,
            format,
            extent: b.width,
            mipLevels: 1,
            arrayLayers: 1,
            samples: VkSampleCountFlagBits.COUNT_1,
            usage: VkImageUsageFlagBits.DEPTH_STENCIL_ATTACHMENT,
        });
        writeU32(b.f.memory, info + VkImageCreateInfo.extent + VkExtent3D.height, b.height);
        writeU32(b.f.memory, info + VkImageCreateInfo.extent + VkExtent3D.depth, 1);
        assert.equal(b.f.call('vkCreateImage', b.device, info, 0, out), VkResult.SUCCESS);
        const image = b.f.u64(out);
        // The memory dance, as a program does it before it may use the image.
        const requirements = b.f.alloc(VkMemoryRequirements.SIZE);
        b.f.call('vkGetImageMemoryRequirements', b.device, u64(image), requirements);
        assert.equal(b.f.u64(requirements + VkMemoryRequirements.size), b.width * b.height * 4);
        assert.equal(b.f.u32(requirements + VkMemoryRequirements.memoryTypeBits) & 1, 1);
        const allocation = b.f.put(VkMemoryAllocateInfo, {
            allocationSize: u64(b.f.u64(requirements)), memoryTypeIndex: 0,
        });
        assert.equal(b.f.call('vkAllocateMemory', b.device, allocation, 0, out), VkResult.SUCCESS);
        assert.equal(b.f.call('vkBindImageMemory', b.device, u64(image), u64(b.f.u64(out)),
            u64(0)), VkResult.SUCCESS);
        return image;
    };

    /** @param {number} format */
    const frameWith = format=>{
        const pass = b.renderPass({ depthFormat: format });
        const index = b.acquire();
        const views = [b.view(b.images[index], b.format), b.view(depthImage(format), format)];
        const [buffer] = b.commandBuffers();
        b.recordClear(buffer, {
            pass, framebuffer: b.framebuffer(pass, views), depth: 0.5, stencil: 7,
        });
        b.submit([buffer]);
        b.present(index);
        const passes = b.f.gpu.of('beginRenderPass');
        return passes[passes.length - 1].descriptor.depthStencilAttachment;
    };

    const withStencil = frameWith(VkFormat.D24_UNORM_S8_UINT);
    assert.equal(withStencil.depthLoadOp, 'clear');
    assert.equal(withStencil.depthStoreOp, 'discard');
    assert.equal(withStencil.depthClearValue, 0.5);
    assert.equal(withStencil.stencilLoadOp, 'clear');
    assert.equal(withStencil.stencilClearValue, 7);
    const journal = b.f.vulkan.lastFrame(b.device);
    assert.equal(journal[0].clearDepth, 0.5);
    assert.equal(journal[0].clearStencil, 7);

    // A depth-only format must not be given stencil operations: WebGPU
    // refuses the pass if it is.
    const without = frameWith(VkFormat.D32_SFLOAT);
    assert.equal(without.depthClearValue, 0.5);
    assert.equal('stencilLoadOp' in without, false);
    assert.equal('stencilClearValue' in without, false);

    // The depth texture was made with attachment usage only.
    const depthTexture = b.f.gpu.of('createTexture')
        .find((/** @type {any} */ call)=>call.descriptor.format === 'depth24plus-stencil8');
    assert.equal(depthTexture.descriptor.usage, 0x10);
    assert.deepEqual(b.f.divergences, []);
});

test('fences and semaphores are signalled by the work that names them', ()=>{
    const b = bootstrap();
    const fence = b.fence();
    const fences = b.f.u64s([fence]);
    assert.equal(b.f.call('vkGetFenceStatus', b.device, u64(fence)), VkResult.NOT_READY);
    assert.equal(b.f.call('vkWaitForFences', b.device, 1, fences, 1, u64(0)), VkResult.TIMEOUT);
    assert.equal(b.f.call('vkWaitForFences', b.device, 1, fences, 1, u64(1000000)),
        VkResult.TIMEOUT, 'nothing will signal it later either');

    const pass = b.renderPass();
    const index = b.acquire();
    const [buffer] = b.commandBuffers();
    b.recordClear(buffer, {
        pass, framebuffer: b.framebuffer(pass, [b.view(b.images[index], b.format)]),
    });
    const done = b.semaphore();
    assert.equal(b.submit([buffer], { fence, signal: [done] }), VkResult.SUCCESS);
    assert.equal(b.f.call('vkGetFenceStatus', b.device, u64(fence)), VkResult.SUCCESS);
    assert.equal(b.f.call('vkWaitForFences', b.device, 1, fences, 1, u64(0)), VkResult.SUCCESS);
    assert.equal(b.f.call('vkResetFences', b.device, 1, fences), VkResult.SUCCESS);
    assert.equal(b.f.call('vkGetFenceStatus', b.device, u64(fence)), VkResult.NOT_READY);

    // A fence made signalled starts that way, and an acquire signals too.
    const ready = b.fence(true);
    assert.equal(b.f.call('vkGetFenceStatus', b.device, u64(ready)), VkResult.SUCCESS);
    const acquired = b.fence();
    b.acquire(0, acquired);
    assert.equal(b.f.call('vkGetFenceStatus', b.device, u64(acquired)), VkResult.SUCCESS);

    // Waiting on a semaphore with the fence commands is the wrong kind, and is said.
    assert.equal(b.f.call('vkGetFenceStatus', b.device, u64(done)), VkResult.ERROR_DEVICE_LOST);
    assert.ok(b.f.divergences.some(each=>
        each.includes('expected a "fence" handle and was given a "semaphore" one')));
    b.f.call('vkDestroyFence', b.device, u64(fence), 0);
    b.f.call('vkDestroySemaphore', b.device, u64(done), 0);
    assert.equal(b.f.call('vkGetFenceStatus', b.device, u64(fence)), VkResult.ERROR_DEVICE_LOST);
});

test('what the first cut refuses is said by name, and never drawn as nothing', ()=>{
    const b = bootstrap();
    const views = b.images.map(image=>b.view(image, b.format));

    // A render area smaller than the framebuffer.
    const pass = b.renderPass();
    let index = b.acquire();
    let [buffer] = b.commandBuffers();
    b.recordClear(buffer, {
        pass, framebuffer: b.framebuffer(pass, [views[index]]), area: [1, 1, 2, 2],
    });
    b.submit([buffer]);
    assert.ok(b.f.divergences.some(each=>each.includes('render area smaller')));
    b.present(index);

    // Two subpasses run as the first.
    const two = b.renderPass({ subpasses: 2 });
    index = b.acquire();
    [buffer] = b.commandBuffers();
    b.recordClear(buffer, { pass: two, framebuffer: b.framebuffer(two, [views[index]]) });
    b.submit([buffer]);
    assert.ok(b.f.divergences.some(each=>each.includes('2 subpasses')));
    b.present(index);

    // A buffer that was never ended is not submitted.
    index = b.acquire();
    [buffer] = b.commandBuffers();
    const before = b.f.gpu.count('beginRenderPass');
    b.recordClear(buffer, {
        pass, framebuffer: b.framebuffer(pass, [views[index]]), end: false,
    });
    assert.equal(b.submit([buffer]), VkResult.SUCCESS);
    assert.equal(b.f.gpu.count('beginRenderPass'), before);
    assert.ok(b.f.divergences.some(each=>each.includes('never ended')));

    // The wrong kind of handle: an image where a view goes.
    const wrong = b.framebuffer(pass, [b.images[0]]);
    [buffer] = b.commandBuffers();
    b.recordClear(buffer, { pass, framebuffer: wrong });
    b.submit([buffer]);
    assert.ok(b.f.divergences.some(each=>
        each.includes('expected a "imageView" handle and was given a "image" one')));

    // A draw: not implemented, and said so.
    b.f.call('vkBeginCommandBuffer', buffer, b.f.put(VkCommandBufferBeginInfo, {}));
    b.f.call('vkCmdDraw', buffer, 3, 1, 0, 0);
    assert.ok(b.f.divergences.some(each=>each.includes('vkCmdDraw is not implemented')));

    // An image this cut cannot make.
    const out = b.f.out();
    const info = b.f.put(VkImageCreateInfo, {
        imageType: VkImageType.TYPE_2D, format: VkFormat.B8G8R8A8_UNORM, extent: 4,
        mipLevels: 4, arrayLayers: 1, samples: 1,
    });
    assert.equal(b.f.call('vkCreateImage', b.device, info, 0, out),
        VkResult.ERROR_FEATURE_NOT_PRESENT);
    assert.ok(b.f.divergences.some(each=>each.includes('more than one mip level')));
    writeU32(b.f.memory, info + VkImageCreateInfo.mipLevels, 1);
    writeU32(b.f.memory, info + VkImageCreateInfo.format, 9999);
    assert.equal(b.f.call('vkCreateImage', b.device, info, 0, out),
        VkResult.ERROR_FEATURE_NOT_PRESENT);
    assert.ok(b.f.divergences.some(each=>each.includes('format 9999')));

    // A swapchain in a format the surface did not offer.
    const chain = b.f.put(VkSwapchainCreateInfoKHR, {
        surface: u64(b.surface), minImageCount: 2, imageFormat: VkFormat.R32_SFLOAT,
        imageExtent: 4,
    });
    assert.equal(b.f.call('vkCreateSwapchainKHR', b.device, chain, 0, out),
        VkResult.ERROR_INITIALIZATION_FAILED);
    assert.ok(b.f.divergences.some(each=>each.includes('VK_FORMAT_R32_SFLOAT')));
});

test('a swapchain replaced through oldSwapchain is out of date, and its images are its own', ()=>{
    const b = bootstrap();
    const out = b.f.out();
    const info = b.f.put(VkSwapchainCreateInfoKHR, {
        surface: u64(b.surface), minImageCount: 2, imageFormat: b.format, imageExtent: 4,
        imageArrayLayers: 1, oldSwapchain: u64(b.swapchain),
    });
    writeU32(b.f.memory, info + VkSwapchainCreateInfoKHR.imageExtent + 4, 4);
    assert.equal(b.f.call('vkCreateSwapchainKHR', b.device, info, 0, out), VkResult.SUCCESS);
    const replacement = b.f.u64(out);
    const index = b.f.out();
    assert.equal(b.f.call('vkAcquireNextImageKHR', b.device, u64(b.swapchain), u64(0), u64(0),
        u64(0), index), VkResult.ERROR_OUT_OF_DATE_KHR);
    assert.equal(b.f.call('vkAcquireNextImageKHR', b.device, u64(replacement), u64(0), u64(0),
        u64(0), index), VkResult.SUCCESS);
    // The old chain presents as out of date too, and says so per swapchain.
    const { result, written } = b.present(0, { results: true });
    assert.equal(result, VkResult.ERROR_OUT_OF_DATE_KHR);
    assert.equal(written, VkResult.ERROR_OUT_OF_DATE_KHR);

    // A swapchain image cannot be destroyed on its own.
    b.f.call('vkDestroyImage', b.device, u64(b.images[0]), 0);
    assert.ok(b.f.divergences.some(each=>each.includes('owned by a swapchain')));
    b.f.call('vkDestroySwapchainKHR', b.device, u64(b.swapchain), 0);
    assert.equal(b.f.vulkan.diagnostics().objects.image, 2, 'the replacement\'s two remain');
    assert.equal(VK_UNUSED, 0xffffffff);
});

test('vkDeviceWaitIdle submits an open frame without presenting; a later present shows it', ()=>{
    const b = bootstrap();
    const pass = b.renderPass();
    const index = b.acquire();
    const [buffer] = b.commandBuffers();
    b.recordClear(buffer, {
        pass, framebuffer: b.framebuffer(pass, [b.view(b.images[index], b.format)]),
        color: [0, 0, 1, 1],
    });
    b.submit([buffer]);
    assert.equal(b.f.call('vkDeviceWaitIdle', b.device), VkResult.SUCCESS);
    assert.equal(b.f.gpu.count('submit'), 1);
    assert.equal(b.f.presented.length, 0);
    assert.equal(b.present(index).result, VkResult.SUCCESS);
    assert.equal(b.f.gpu.count('submit'), 2, 'a second, empty frame carries the present');
    assert.equal(b.f.presented.length, 1);
    assert.equal(b.f.presented[0].surface.label, 'swapchain[0]');
    assert.equal(b.f.call('vkQueueWaitIdle', b.queue), VkResult.SUCCESS);
    assert.equal(f32(1).f32, 1);
});

test('a shader module is decoded at creation, and what it declares is said there', ()=>{
    const b = bootstrap();
    const out = b.f.out();
    /** @param {number[]} body */
    const module = body=>{
        const all = [SPIRV_MAGIC, 0x00010000, 0, 8, 0, ...body];
        const at = b.f.alloc(all.length * 4);
        all.forEach((word, index)=>writeU32(b.f.memory, at + index * 4, word));
        return b.f.put(VkShaderModuleCreateInfo, { codeSize: all.length * 4, pCode: at });
    };
    const capability = (/** @type {number} */ which)=>[(2 << 16) | Op.Capability, which];
    // "main", then the pad word, in an entry point of the Vertex model.
    const entry = [(6 << 16) | Op.EntryPoint, 0, 4, 0x6e69616d, 0, 9];

    assert.equal(b.f.call('vkCreateShaderModule', b.device, module([...capability(1), ...entry]),
        0, out), VkResult.SUCCESS);
    const fine = b.f.u64(out);
    assert.notEqual(fine, 0);
    assert.equal(b.f.divergences.length, 0);

    assert.equal(b.f.call('vkCreateShaderModule', b.device,
        module([...capability(1), ...capability(2), ...entry]), 0, out), VkResult.SUCCESS,
    'a module that declares Geometry is still a module');
    assert.ok(b.f.divergences.some(each=>each.includes('(Vertex "main") declares Geometry')));

    const garbage = b.f.put(VkShaderModuleCreateInfo, { codeSize: 8, pCode: b.f.u32s([1, 2]) });
    assert.equal(b.f.call('vkCreateShaderModule', b.device, garbage, 0, out),
        VkResult.ERROR_INITIALIZATION_FAILED);
    assert.ok(b.f.divergences.some(each=>each.includes('refused 8 bytes')));

    b.f.call('vkDestroyShaderModule', b.device, u64(fine), 0);
    assert.equal(b.f.vulkan.diagnostics().objects.shaderModule, 1);
});
