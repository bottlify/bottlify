/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The loader surface, held to the specification's return codes: what an
 * enumeration answers when the buffer is too small, what a create answers
 * when asked for a layer, an extension, a feature or a version it does not
 * have, and which names `vkGetInstanceProcAddr` will and will not resolve.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    VK_API_VERSION_1_0, VK_FALSE, VK_TRUE, VkFormat, VkFormatFeatureFlagBits,
    VkMemoryPropertyFlagBits, VkPresentModeKHR, VkQueueFlagBits, VkResult, makeVersion,
} from './constants.js';
import {
    PHYSICAL_DEVICE_FEATURES, VkApplicationInfo, VkDeviceCreateInfo, VkDeviceQueueCreateInfo,
    VkExtensionProperties, VkFormatProperties, VkInstanceCreateInfo, VkMemoryHeap, VkMemoryType,
    VkPhysicalDeviceFeatures, VkPhysicalDeviceLimits, VkPhysicalDeviceMemoryProperties,
    VkPhysicalDeviceProperties, VkQueueFamilyProperties, VkSurfaceCapabilitiesKHR,
    VkSurfaceFormatKHR, VkWin32SurfaceCreateInfoKHR, readCString, readF32,
} from './structs.js';
import { createFixture, u64 } from './fixture.js';

/**
 * An instance with the given extensions, and its physical device.
 *
 * @param {ReturnType<typeof createFixture>} f
 * @param {string[]} [extensions]
 * @param {number} [apiVersion]
 */
function createInstance(f, extensions = [], apiVersion = VK_API_VERSION_1_0){
    const application = f.put(VkApplicationInfo, {
        pApplicationName: f.str('test'), apiVersion,
    });
    const info = f.put(VkInstanceCreateInfo, {
        pApplicationInfo: application,
        enabledExtensionCount: extensions.length,
        ppEnabledExtensionNames: f.strs(extensions),
    });
    const out = f.out();
    const result = f.call('vkCreateInstance', info, 0, out);
    const instance = f.u32(out);
    const count = f.out();
    const devices = f.out();
    if (result === VkResult.SUCCESS)
    {
        f.memory.writeMemory(count, new Uint8Array([1, 0, 0, 0]));
        assert.equal(f.call('vkEnumeratePhysicalDevices', instance, count, devices),
            VkResult.SUCCESS);
    }
    return { result, instance, physicalDevice: f.u32(devices) };
}

test('extension enumeration: the count, then the array, then VK_INCOMPLETE when short', ()=>{
    const f = createFixture();
    const count = f.out();
    assert.equal(f.call('vkEnumerateInstanceExtensionProperties', 0, count, 0),
        VkResult.SUCCESS);
    assert.equal(f.u32(count), 2);

    // Room for one of the two: one is written, the count says one, and the
    // result says there were more.
    const one = f.alloc(VkExtensionProperties.SIZE);
    f.memory.writeMemory(count, new Uint8Array([1, 0, 0, 0]));
    assert.equal(f.call('vkEnumerateInstanceExtensionProperties', 0, count, one),
        VkResult.INCOMPLETE);
    assert.equal(f.u32(count), 1);
    assert.equal(readCString(f.memory, one + VkExtensionProperties.extensionName),
        'VK_KHR_surface');
    assert.equal(f.u32(one + VkExtensionProperties.specVersion), 25);

    const two = f.alloc(VkExtensionProperties.SIZE * 2);
    f.memory.writeMemory(count, new Uint8Array([8, 0, 0, 0]));
    assert.equal(f.call('vkEnumerateInstanceExtensionProperties', 0, count, two),
        VkResult.SUCCESS);
    assert.equal(f.u32(count), 2);
    assert.equal(readCString(f.memory,
        two + VkExtensionProperties.SIZE + VkExtensionProperties.extensionName),
    'VK_KHR_win32_surface');

    // A layer's extensions: there are no layers, so the layer is the error.
    assert.equal(f.call('vkEnumerateInstanceExtensionProperties', f.str('VK_LAYER_x'), count, 0),
        VkResult.ERROR_LAYER_NOT_PRESENT);

    // Zero room with a non-null array is INCOMPLETE too, with nothing written.
    f.memory.writeMemory(count, new Uint8Array([0, 0, 0, 0]));
    assert.equal(f.call('vkEnumerateInstanceExtensionProperties', 0, count, one),
        VkResult.INCOMPLETE);
    assert.equal(f.u32(count), 0);
});

test('there are no layers', ()=>{
    const f = createFixture();
    const count = f.out();
    assert.equal(f.call('vkEnumerateInstanceLayerProperties', count, 0), VkResult.SUCCESS);
    assert.equal(f.u32(count), 0);
});

test('vkCreateInstance answers each refusal with its own code', ()=>{
    const f = createFixture();
    const layered = f.put(VkInstanceCreateInfo, {
        enabledLayerCount: 1, ppEnabledLayerNames: f.strs(['VK_LAYER_KHRONOS_validation']),
    });
    assert.equal(f.call('vkCreateInstance', layered, 0, f.out()),
        VkResult.ERROR_LAYER_NOT_PRESENT);

    assert.equal(createInstance(f, ['VK_KHR_surface', 'VK_KHR_xcb_surface']).result,
        VkResult.ERROR_EXTENSION_NOT_PRESENT);

    // A 1.0 loader refuses 1.1, and says so.
    assert.equal(createInstance(f, [], makeVersion(1, 1, 0)).result,
        VkResult.ERROR_INCOMPATIBLE_DRIVER);
    assert.ok(f.divergences.some(each=>each.includes('apiVersion 1.1')));

    // Zero means "whatever you have", and 1.0 is what there is.
    assert.equal(createInstance(f, [], 0).result, VkResult.SUCCESS);
    const made = createInstance(f, ['VK_KHR_surface', 'VK_KHR_win32_surface']);
    assert.equal(made.result, VkResult.SUCCESS);
    assert.notEqual(made.instance, 0);
    assert.notEqual(made.physicalDevice, 0);
    assert.notEqual(made.instance, made.physicalDevice);

    // No application info at all is allowed.
    const bare = f.put(VkInstanceCreateInfo, {});
    const out = f.out();
    assert.equal(f.call('vkCreateInstance', bare, 0, out), VkResult.SUCCESS);
    assert.notEqual(f.u32(out), 0);
});

test('one physical device, and the count protocol applies to it', ()=>{
    const f = createFixture();
    const { instance } = createInstance(f);
    const count = f.out();
    assert.equal(f.call('vkEnumeratePhysicalDevices', instance, count, 0), VkResult.SUCCESS);
    assert.equal(f.u32(count), 1);
    f.memory.writeMemory(count, new Uint8Array([0, 0, 0, 0]));
    assert.equal(f.call('vkEnumeratePhysicalDevices', instance, count, f.out()),
        VkResult.INCOMPLETE);
    // Destroying the instance takes its device with it.
    f.call('vkDestroyInstance', instance, 0);
    assert.equal(f.call('vkEnumeratePhysicalDevices', instance, count, 0),
        VkResult.ERROR_INITIALIZATION_FAILED);
    assert.ok(f.divergences.some(each=>each.includes('not a VkInstance')));
});

test('the physical device properties land at their 32-bit offsets', ()=>{
    const f = createFixture();
    const { physicalDevice } = createInstance(f);
    const at = f.alloc(VkPhysicalDeviceProperties.SIZE + 16);
    // A sentinel past the end, to show the write stops at SIZE.
    f.memory.writeMemory(at + VkPhysicalDeviceProperties.SIZE, new Uint8Array([0xaa, 0xaa]));
    f.call('vkGetPhysicalDeviceProperties', physicalDevice, at);

    const P = VkPhysicalDeviceProperties;
    assert.equal(f.u32(at + P.apiVersion), VK_API_VERSION_1_0);
    assert.equal(readCString(f.memory, at + P.deviceName), 'the recording device');
    const limits = at + P.limits;
    const L = VkPhysicalDeviceLimits;
    assert.equal(f.u32(limits + L.maxImageDimension2D), 8192);
    // A VkDeviceSize: eight bytes, the high dword zero.
    assert.equal(f.u64(limits + L.minUniformBufferOffsetAlignment), 256);
    assert.equal(f.u32(limits + L.minUniformBufferOffsetAlignment + 4), 0);
    assert.equal(f.u64(limits + L.nonCoherentAtomSize), 256);
    // A float, as a float.
    assert.equal(readF32(f.memory, limits + L.maxSamplerAnisotropy), 16);
    assert.equal(readF32(f.memory, limits + L.viewportBoundsRange + 4), 16383);
    // An array of three.
    assert.equal(f.u32(limits + L.maxComputeWorkGroupSize + 8), 64);
    assert.equal(f.u32(limits + L.maxPushConstantsSize), 128);
    assert.equal(f.u32(limits + L.maxGeometryShaderInvocations), 0);
    assert.equal(f.u32(limits + L.standardSampleLocations), VK_TRUE);
    assert.equal(f.memory.readMemory(at + P.SIZE, 2)[0], 0xaa, 'nothing past SIZE');
});

test('the features are honest: what WebGPU has is true and the rest is false', ()=>{
    const f = createFixture({ compressedTextures: true });
    const { physicalDevice } = createInstance(f);
    const at = f.alloc(VkPhysicalDeviceFeatures.SIZE);
    f.call('vkGetPhysicalDeviceFeatures', physicalDevice, at);
    /** @param {string} name */
    const feature = name=>f.u32(at + VkPhysicalDeviceFeatures.offsetOf(name));
    assert.equal(feature('robustBufferAccess'), VK_TRUE);
    assert.equal(feature('geometryShader'), VK_FALSE);
    assert.equal(feature('tessellationShader'), VK_FALSE);
    assert.equal(feature('sparseBinding'), VK_FALSE);
    assert.equal(feature('textureCompressionBC'), VK_TRUE);
    assert.equal(feature('inheritedQueries'), VK_FALSE);

    const without = createFixture({ compressedTextures: false });
    const other = createInstance(without);
    const at2 = without.alloc(VkPhysicalDeviceFeatures.SIZE);
    without.call('vkGetPhysicalDeviceFeatures', other.physicalDevice, at2);
    assert.equal(without.u32(at2 + VkPhysicalDeviceFeatures.offsetOf('textureCompressionBC')),
        VK_FALSE);
    assert.equal(PHYSICAL_DEVICE_FEATURES.length * 4, VkPhysicalDeviceFeatures.SIZE);
});

test('one queue family that does everything, and the memory a discrete card has', ()=>{
    const f = createFixture();
    const { physicalDevice } = createInstance(f);
    const count = f.out();
    f.call('vkGetPhysicalDeviceQueueFamilyProperties', physicalDevice, count, 0);
    assert.equal(f.u32(count), 1);
    const family = f.alloc(VkQueueFamilyProperties.SIZE);
    f.call('vkGetPhysicalDeviceQueueFamilyProperties', physicalDevice, count, family);
    assert.equal(f.u32(family + VkQueueFamilyProperties.queueFlags),
        VkQueueFlagBits.GRAPHICS | VkQueueFlagBits.COMPUTE | VkQueueFlagBits.TRANSFER);
    assert.equal(f.u32(family + VkQueueFamilyProperties.queueCount), 1);
    assert.equal(f.u32(family + VkQueueFamilyProperties.minImageTransferGranularity + 8), 1);

    const memory = f.alloc(VkPhysicalDeviceMemoryProperties.SIZE);
    f.call('vkGetPhysicalDeviceMemoryProperties', physicalDevice, memory);
    const M = VkPhysicalDeviceMemoryProperties;
    assert.equal(f.u32(memory + M.memoryTypeCount), 3);
    assert.equal(f.u32(memory + M.memoryHeapCount), 2);
    assert.equal(f.u32(memory + M.memoryTypes + VkMemoryType.SIZE + VkMemoryType.propertyFlags),
        VkMemoryPropertyFlagBits.HOST_VISIBLE | VkMemoryPropertyFlagBits.HOST_COHERENT);
    assert.equal(f.u32(memory + M.memoryTypes + VkMemoryType.SIZE + VkMemoryType.heapIndex), 1);
    // The heap array starts eight-aligned, and each heap's size is a qword.
    assert.equal(M.memoryHeaps % 8, 0);
    assert.equal(f.u64(memory + M.memoryHeaps + VkMemoryHeap.size), 1024 * 1024 * 1024);
    assert.equal(f.u32(memory + M.memoryHeaps + VkMemoryHeap.SIZE + VkMemoryHeap.flags), 0);
});

test('format properties say what a format is for, and all zeros for one it is not', ()=>{
    const f = createFixture();
    const { physicalDevice } = createInstance(f);
    const at = f.alloc(VkFormatProperties.SIZE);
    f.call('vkGetPhysicalDeviceFormatProperties', physicalDevice, VkFormat.B8G8R8A8_UNORM, at);
    assert.ok(f.u32(at + VkFormatProperties.optimalTilingFeatures)
        & VkFormatFeatureFlagBits.COLOR_ATTACHMENT);
    f.call('vkGetPhysicalDeviceFormatProperties', physicalDevice, VkFormat.D24_UNORM_S8_UINT, at);
    assert.ok(f.u32(at + VkFormatProperties.optimalTilingFeatures)
        & VkFormatFeatureFlagBits.DEPTH_STENCIL_ATTACHMENT);
    f.call('vkGetPhysicalDeviceFormatProperties', physicalDevice, VkFormat.R32G32B32_SFLOAT, at);
    assert.equal(f.u32(at + VkFormatProperties.bufferFeatures),
        VkFormatFeatureFlagBits.VERTEX_BUFFER);
    f.call('vkGetPhysicalDeviceFormatProperties', physicalDevice, 9999, at);
    assert.equal(f.u32(at + VkFormatProperties.optimalTilingFeatures), 0);
    assert.equal(f.u32(at + VkFormatProperties.bufferFeatures), 0);
});

/**
 * @param {ReturnType<typeof createFixture>} f
 * @param {number} physicalDevice
 * @param {{ extensions?: string[], family?: number, queues?: number,
 *           features?: string[] }} [options]
 */
function createDevice(f, physicalDevice, options = {}){
    const queue = f.put(VkDeviceQueueCreateInfo, {
        queueFamilyIndex: options.family ?? 0,
        queueCount: options.queues ?? 1,
        pQueuePriorities: f.u32s([0x3f800000]),
    });
    let features = 0;
    if (options.features)
    {
        features = f.alloc(VkPhysicalDeviceFeatures.SIZE);
        for (const name of options.features)
        {
            f.memory.writeMemory(features + VkPhysicalDeviceFeatures.offsetOf(name),
                new Uint8Array([1, 0, 0, 0]));
        }
    }
    const extensions = options.extensions ?? [];
    const info = f.put(VkDeviceCreateInfo, {
        queueCreateInfoCount: 1,
        pQueueCreateInfos: queue,
        enabledExtensionCount: extensions.length,
        ppEnabledExtensionNames: f.strs(extensions),
        pEnabledFeatures: features,
    });
    const out = f.out();
    const result = f.call('vkCreateDevice', physicalDevice, info, 0, out);
    return { result, device: f.u32(out) };
}

test('vkCreateDevice refuses what the device lacks, and hands out its one queue', ()=>{
    const f = createFixture();
    const { physicalDevice } = createInstance(f);
    assert.equal(createDevice(f, physicalDevice, { extensions: ['VK_KHR_maintenance1'] }).result,
        VkResult.ERROR_EXTENSION_NOT_PRESENT);
    assert.equal(createDevice(f, physicalDevice, { features: ['geometryShader'] }).result,
        VkResult.ERROR_FEATURE_NOT_PRESENT);
    assert.ok(f.divergences.some(each=>each.includes('geometryShader')));
    assert.equal(createDevice(f, physicalDevice, { family: 1 }).result,
        VkResult.ERROR_INITIALIZATION_FAILED);
    assert.equal(createDevice(f, physicalDevice, { queues: 2 }).result,
        VkResult.ERROR_INITIALIZATION_FAILED);
    // A supported feature is fine.
    assert.equal(createDevice(f, physicalDevice, { features: ['robustBufferAccess'] }).result,
        VkResult.SUCCESS);

    const { result, device } = createDevice(f, physicalDevice, {
        extensions: ['VK_KHR_swapchain'],
    });
    assert.equal(result, VkResult.SUCCESS);
    const out = f.out();
    f.call('vkGetDeviceQueue', device, 0, 0, out);
    const queue = f.u32(out);
    assert.notEqual(queue, 0);
    f.call('vkGetDeviceQueue', device, 0, 0, out);
    assert.equal(f.u32(out), queue, 'the same queue every time');
    f.call('vkGetDeviceQueue', device, 1, 0, out);
    assert.equal(f.u32(out), 0, 'no second family');
    assert.equal(f.call('vkDeviceWaitIdle', device), VkResult.SUCCESS);
    f.call('vkDestroyDevice', device, 0);
    assert.equal(f.call('vkDeviceWaitIdle', device), VkResult.ERROR_DEVICE_LOST);
});

test('device extensions and layers enumerate like the instance ones', ()=>{
    const f = createFixture();
    const { physicalDevice } = createInstance(f);
    const count = f.out();
    assert.equal(f.call('vkEnumerateDeviceExtensionProperties', physicalDevice, 0, count, 0),
        VkResult.SUCCESS);
    assert.equal(f.u32(count), 1);
    const one = f.alloc(VkExtensionProperties.SIZE);
    assert.equal(f.call('vkEnumerateDeviceExtensionProperties', physicalDevice, 0, count, one),
        VkResult.SUCCESS);
    assert.equal(readCString(f.memory, one), 'VK_KHR_swapchain');
    assert.equal(f.u32(one + VkExtensionProperties.specVersion), 70);
    assert.equal(f.call('vkEnumerateDeviceExtensionProperties', physicalDevice, f.str('L'),
        count, 0), VkResult.ERROR_LAYER_NOT_PRESENT);
    assert.equal(f.call('vkEnumerateDeviceLayerProperties', physicalDevice, count, 0),
        VkResult.SUCCESS);
    assert.equal(f.u32(count), 0);
});

test('vkGetInstanceProcAddr: global names without an instance, everything with one', ()=>{
    const f = createFixture();
    const visible = f.vulkan.instanceProcVisible;
    assert.equal(visible(0, 'vkCreateInstance'), true);
    assert.equal(visible(0, 'vkEnumerateInstanceExtensionProperties'), true);
    assert.equal(visible(0, 'vkGetInstanceProcAddr'), true);
    assert.equal(visible(0, 'vkDestroyInstance'), false);
    assert.equal(visible(0, 'vkCreateDevice'), false);
    assert.equal(visible(0, 'vkCmdDraw'), false);
    assert.equal(visible(0, 'vkNotACommand'), false);

    const plain = createInstance(f).instance;
    assert.equal(visible(plain, 'vkCreateDevice'), true);
    assert.equal(visible(plain, 'vkCmdDraw'), true, 'a device-level command through the instance');
    assert.equal(visible(plain, 'vkCreateInstance'), true);
    assert.equal(visible(plain, 'vkNotACommand'), false);
    assert.equal(visible(plain, 'vkCreateWin32SurfaceKHR'), false,
        'an instance extension that was not enabled');
    assert.equal(visible(plain, 'vkGetPhysicalDeviceSurfaceFormatsKHR'), false);
    assert.equal(visible(plain, 'vkCreateSwapchainKHR'), true,
        'a device extension this loader offers');

    const surfaced = createInstance(f, ['VK_KHR_surface', 'VK_KHR_win32_surface']).instance;
    assert.equal(visible(surfaced, 'vkCreateWin32SurfaceKHR'), true);
    assert.equal(visible(surfaced, 'vkGetPhysicalDeviceSurfaceFormatsKHR'), true);
    assert.equal(visible(0x12345, 'vkCreateDevice'), false, 'not an instance');
});

test('vkGetDeviceProcAddr: device-level names, and an extension only when enabled', ()=>{
    const f = createFixture();
    const { physicalDevice } = createInstance(f);
    const visible = f.vulkan.deviceProcVisible;
    const plain = createDevice(f, physicalDevice).device;
    assert.equal(visible(plain, 'vkCmdDraw'), true);
    assert.equal(visible(plain, 'vkQueueSubmit'), true);
    assert.equal(visible(plain, 'vkGetDeviceQueue'), true);
    assert.equal(visible(plain, 'vkCreateInstance'), false);
    assert.equal(visible(plain, 'vkEnumeratePhysicalDevices'), false);
    assert.equal(visible(plain, 'vkCreateSwapchainKHR'), false, 'not enabled on this device');
    const swapchained = createDevice(f, physicalDevice, {
        extensions: ['VK_KHR_swapchain'],
    }).device;
    assert.equal(visible(swapchained, 'vkCreateSwapchainKHR'), true);
    assert.equal(visible(swapchained, 'vkQueuePresentKHR'), true);
    assert.equal(visible(0, 'vkCmdDraw'), false);
});

test('a surface is the screen: its capabilities, formats and present modes', ()=>{
    const f = createFixture({ screen: { width: 640, height: 480 } });
    const { instance, physicalDevice } = createInstance(f,
        ['VK_KHR_surface', 'VK_KHR_win32_surface']);
    const info = f.put(VkWin32SurfaceCreateInfoKHR, { hinstance: 0x400000, hwnd: 0x10004 });
    const out = f.out();
    assert.equal(f.call('vkCreateWin32SurfaceKHR', instance, info, 0, out), VkResult.SUCCESS);
    const surface = f.u64(out);
    assert.notEqual(surface, 0);

    assert.equal(f.call('vkGetPhysicalDeviceWin32PresentationSupportKHR', physicalDevice, 0),
        VK_TRUE);
    assert.equal(f.call('vkGetPhysicalDeviceWin32PresentationSupportKHR', physicalDevice, 1),
        VK_FALSE);
    const supported = f.out();
    assert.equal(f.call('vkGetPhysicalDeviceSurfaceSupportKHR', physicalDevice, 0, u64(surface),
        supported), VkResult.SUCCESS);
    assert.equal(f.u32(supported), VK_TRUE);

    const caps = f.alloc(VkSurfaceCapabilitiesKHR.SIZE);
    assert.equal(f.call('vkGetPhysicalDeviceSurfaceCapabilitiesKHR', physicalDevice, u64(surface),
        caps), VkResult.SUCCESS);
    const C = VkSurfaceCapabilitiesKHR;
    assert.equal(f.u32(caps + C.minImageCount), 2);
    assert.equal(f.u32(caps + C.currentExtent), 640);
    assert.equal(f.u32(caps + C.currentExtent + 4), 480);
    assert.equal(f.u32(caps + C.maxImageExtent), 640);
    assert.equal(f.u32(caps + C.maxImageArrayLayers), 1);

    const count = f.out();
    assert.equal(f.call('vkGetPhysicalDeviceSurfaceFormatsKHR', physicalDevice, u64(surface),
        count, 0), VkResult.SUCCESS);
    assert.equal(f.u32(count), 4);
    const formats = f.alloc(VkSurfaceFormatKHR.SIZE * 4);
    assert.equal(f.call('vkGetPhysicalDeviceSurfaceFormatsKHR', physicalDevice, u64(surface),
        count, formats), VkResult.SUCCESS);
    assert.equal(f.u32(formats + VkSurfaceFormatKHR.format), VkFormat.B8G8R8A8_UNORM);
    assert.equal(f.u32(formats + VkSurfaceFormatKHR.SIZE + VkSurfaceFormatKHR.format),
        VkFormat.B8G8R8A8_SRGB);

    assert.equal(f.call('vkGetPhysicalDeviceSurfacePresentModesKHR', physicalDevice,
        u64(surface), count, 0), VkResult.SUCCESS);
    assert.equal(f.u32(count), 1);
    const modes = f.out();
    f.call('vkGetPhysicalDeviceSurfacePresentModesKHR', physicalDevice, u64(surface), count,
        modes);
    assert.equal(f.u32(modes), VkPresentModeKHR.FIFO_KHR);

    // A stale surface is reported as lost, and named in the divergence.
    f.call('vkDestroySurfaceKHR', instance, u64(surface), 0);
    assert.equal(f.call('vkGetPhysicalDeviceSurfaceCapabilitiesKHR', physicalDevice,
        u64(surface), caps), VkResult.ERROR_SURFACE_LOST_KHR);
    assert.ok(f.divergences.some(each=>each.includes('not a VkSurfaceKHR')));
});

test('a command nothing implements is refused by name, once, and counted', ()=>{
    const f = createFixture();
    assert.equal(f.call('vkCmdDraw', 0, 3, 1, 0, 0), VkResult.ERROR_FEATURE_NOT_PRESENT);
    assert.equal(f.call('vkCmdDraw', 0, 3, 1, 0, 0), VkResult.ERROR_FEATURE_NOT_PRESENT);
    assert.deepEqual(f.divergences.filter(each=>each.includes('vkCmdDraw')),
        ['Vulkan: vkCmdDraw is not implemented: the call did nothing and answered'
            + ' VK_ERROR_FEATURE_NOT_PRESENT']);
    assert.deepEqual(f.vulkan.diagnostics().unimplemented, { vkCmdDraw: 2 });
    assert.throws(()=>f.call('vkNotACommand'), TypeError);
});
