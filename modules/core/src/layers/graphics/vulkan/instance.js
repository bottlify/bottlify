/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The instance level: what a program can do before it has a device.
 *
 * There is one physical device, and it is the GPU the backend draws on; what
 * it says about itself is in `physical.js`. This file is the commands: making
 * an instance, asking the device about itself, making a device, and the
 * surface half of presentation.
 */

import {
    DEVICE_EXTENSIONS, INSTANCE_EXTENSIONS, VK_API_VERSION_1_0, VK_FALSE, VK_TRUE,
    VkCompositeAlphaFlagBitsKHR, VkPhysicalDeviceType, VkResult, VkSurfaceTransformFlagBitsKHR,
    versionMajor, versionMinor,
} from './constants.js';
import {
    PHYSICAL_DEVICE_FEATURES, VkApplicationInfo, VkDeviceCreateInfo, VkDeviceQueueCreateInfo,
    VkExtensionProperties, VkExtent3D, VkFormatProperties, VkInstanceCreateInfo,
    VkLayerProperties, VkMemoryHeap, VkMemoryType,
    VkPhysicalDeviceMemoryProperties, VkPhysicalDeviceProperties,
    VkPhysicalDeviceSparseProperties, VkQueueFamilyProperties, VkSurfaceCapabilitiesKHR,
    VkSurfaceFormatKHR, VkWin32SurfaceCreateInfoKHR, readStringArray, readU32, joinU64,
    writeExtent2D, writeFixedString, writeU32, writeU64,
} from './structs.js';
import { COMMANDS } from './commands.js';
import { createDevice } from './device.js';
import {
    MEMORY, PRESENT_MODES, QUEUE_FAMILY, SURFACE_FORMATS, SURFACE_USAGE, enumerate,
    formatFeatures, supportedFeatures, writeLimits,
} from './physical.js';

/**
 * @typedef {Object} Instance
 * @property {'instance'} kind
 * @property {Set<string>} extensions
 * @property {number} physicalDevice   the handle
 * @property {string} applicationName
 */

/**
 * @typedef {Object} PhysicalDevice
 * @property {'physicalDevice'} kind
 * @property {number} instance   the handle
 */

/**
 * @typedef {Object} Surface
 * @property {'surface'} kind
 * @property {number} instance
 * @property {number} hwnd
 */

/**
 * @param {import('./physical.js').VulkanContext} context
 */
export function createInstanceCommands(context){
    const { memory, handles } = context;
    const features = supportedFeatures(context.compressedTextures);

    /**
     * @param {number} handle @param {string} command
     * @returns {Instance | null}
     */
    const instanceOf = (handle, command)=>{
        const instance = /** @type {Instance | null} */ (handles.get(handle, 'instance'));
        if (!instance)
        {
            context.diverge(`${command} was given something that is not a VkInstance`);
        }
        return instance;
    };

    /**
     * @param {number} handle @param {string} command
     * @returns {PhysicalDevice | null}
     */
    const physicalDeviceOf = (handle, command)=>{
        const device = /** @type {PhysicalDevice | null} */ (handles.get(handle, 'physicalDevice'));
        if (!device)
        {
            context.diverge(`${command} was given something that is not a VkPhysicalDevice`);
        }
        return device;
    };

    /**
     * @param {number} handle @param {string} command
     * @returns {Surface | null}
     */
    const surfaceOf = (handle, command)=>{
        const surface = /** @type {Surface | null} */ (handles.get(handle, 'surface'));
        if (!surface)
        {
            context.diverge(`${command} was given something that is not a VkSurfaceKHR`);
        }
        return surface;
    };

    /** @param {number} address @param {{ name: string, version: number }} extension */
    const writeExtension = (address, extension)=>{
        writeFixedString(memory, address + VkExtensionProperties.extensionName, extension.name,
            256);
        writeU32(memory, address + VkExtensionProperties.specVersion, extension.version);
    };

    /** @param {Readonly<Record<string, number>>} table */
    const extensionList = table=>Object.entries(table)
        .map(([name, version])=>({ name, version }));

    /**
     * The features a program asked for that this device does not have.
     *
     * @param {number} address  VkPhysicalDeviceFeatures, or zero for none
     * @returns {string[]}
     */
    const missingFeatures = address=>((address === 0)
        ? []
        : PHYSICAL_DEVICE_FEATURES.filter((name, index)=>
            readU32(memory, address + index * 4) !== 0 && !features.has(name)));

    const commands = {
        /**
         * VkResult vkCreateInstance(const VkInstanceCreateInfo*, const VkAllocationCallbacks*,
         *     VkInstance*)
         */
        vkCreateInstance: (/** @type {number[]} */ [pCreateInfo, , pInstance])=>{
            const info = pCreateInfo >>> 0;
            const layers = readStringArray(memory,
                readU32(memory, info + VkInstanceCreateInfo.enabledLayerCount),
                readU32(memory, info + VkInstanceCreateInfo.ppEnabledLayerNames));
            if (layers.length > 0)
            {
                return VkResult.ERROR_LAYER_NOT_PRESENT;
            }
            const extensions = readStringArray(memory,
                readU32(memory, info + VkInstanceCreateInfo.enabledExtensionCount),
                readU32(memory, info + VkInstanceCreateInfo.ppEnabledExtensionNames));
            if (extensions.some(name=>!(name in INSTANCE_EXTENSIONS)))
            {
                return VkResult.ERROR_EXTENSION_NOT_PRESENT;
            }
            const application = readU32(memory, info + VkInstanceCreateInfo.pApplicationInfo);
            let applicationName = '';
            if (application !== 0)
            {
                // A 1.0 loader refuses a program built for a newer version:
                // that is the specification's rule for 1.0, and the honest
                // answer, since nothing above 1.0 is implemented here.
                const apiVersion = readU32(memory, application + VkApplicationInfo.apiVersion);
                if (apiVersion !== 0 && (versionMajor(apiVersion) > 1
                    || (versionMajor(apiVersion) === 1 && versionMinor(apiVersion) > 0)))
                {
                    context.diverge('vkCreateInstance refused apiVersion '
                        + `${versionMajor(apiVersion)}.${versionMinor(apiVersion)}: this loader`
                        + ' implements 1.0 only');
                    return VkResult.ERROR_INCOMPATIBLE_DRIVER;
                }
                applicationName = readStringArray(memory, 1,
                    application + VkApplicationInfo.pApplicationName)[0];
            }
            /** @type {Instance} */
            const instance = {
                kind: 'instance', extensions: new Set(extensions), physicalDevice: 0,
                applicationName,
            };
            const handle = handles.mintDispatchable(instance);
            instance.physicalDevice = handles.mintDispatchable(
                /** @type {PhysicalDevice} */ ({ kind: 'physicalDevice', instance: handle }));
            writeU32(memory, pInstance >>> 0, handle);
            return VkResult.SUCCESS;
        },

        /** void vkDestroyInstance(VkInstance, const VkAllocationCallbacks*) */
        vkDestroyInstance: (/** @type {number[]} */ [handle])=>{
            if ((handle >>> 0) === 0)
            {
                return 0;
            }
            const instance = instanceOf(handle >>> 0, 'vkDestroyInstance');
            if (instance)
            {
                handles.release(instance.physicalDevice);
                handles.release(handle >>> 0);
            }
            return 0;
        },

        /**
         * VkResult vkEnumerateInstanceExtensionProperties(const char* pLayerName,
         *     uint32_t* pPropertyCount, VkExtensionProperties* pProperties)
         *
         * A layer name asks about that layer's extensions, and there are no
         * layers -- so the answer is the error, not an empty list.
         */
        vkEnumerateInstanceExtensionProperties: (/** @type {number[]} */ [pLayerName, pCount,
            pProperties])=>((pLayerName >>> 0) !== 0
            ? VkResult.ERROR_LAYER_NOT_PRESENT
            : enumerate(context, pCount >>> 0, pProperties >>> 0,
                extensionList(INSTANCE_EXTENSIONS), VkExtensionProperties.SIZE, writeExtension)),

        /** VkResult vkEnumerateInstanceLayerProperties(uint32_t*, VkLayerProperties*) */
        vkEnumerateInstanceLayerProperties: (/** @type {number[]} */ [pCount, pProperties])=>
            enumerate(context, pCount >>> 0, pProperties >>> 0, [], VkLayerProperties.SIZE,
                ()=>{}),

        /** VkResult vkEnumeratePhysicalDevices(VkInstance, uint32_t*, VkPhysicalDevice*) */
        vkEnumeratePhysicalDevices: (/** @type {number[]} */ [handle, pCount, pDevices])=>{
            const instance = instanceOf(handle >>> 0, 'vkEnumeratePhysicalDevices');
            if (!instance)
            {
                return VkResult.ERROR_INITIALIZATION_FAILED;
            }
            return enumerate(context, pCount >>> 0, pDevices >>> 0, [instance.physicalDevice], 4,
                (address, device)=>writeU32(memory, address, device));
        },

        /** void vkGetPhysicalDeviceProperties(VkPhysicalDevice, VkPhysicalDeviceProperties*) */
        vkGetPhysicalDeviceProperties: (/** @type {number[]} */ [handle, pProperties])=>{
            if (!physicalDeviceOf(handle >>> 0, 'vkGetPhysicalDeviceProperties'))
            {
                return 0;
            }
            const at = pProperties >>> 0;
            const P = VkPhysicalDeviceProperties;
            writeU32(memory, at + P.apiVersion, VK_API_VERSION_1_0);
            writeU32(memory, at + P.driverVersion, 1);
            writeU32(memory, at + P.vendorID, 0);
            writeU32(memory, at + P.deviceID, 0);
            // There is one device, so how a program ranks it changes nothing;
            // discrete is the type nothing deprioritises.
            writeU32(memory, at + P.deviceType, VkPhysicalDeviceType.DISCRETE_GPU);
            const adapter = context.adapter();
            writeFixedString(memory, at + P.deviceName,
                adapter?.description || adapter?.vendor || 'WebGPU', 256);
            memory.writeMemory(at + P.pipelineCacheUUID, new Uint8Array(16));
            writeLimits(memory, at + P.limits);
            memory.writeMemory(at + P.sparseProperties,
                new Uint8Array(VkPhysicalDeviceSparseProperties.SIZE));
            return 0;
        },

        /** void vkGetPhysicalDeviceFeatures(VkPhysicalDevice, VkPhysicalDeviceFeatures*) */
        vkGetPhysicalDeviceFeatures: (/** @type {number[]} */ [handle, pFeatures])=>{
            if (!physicalDeviceOf(handle >>> 0, 'vkGetPhysicalDeviceFeatures'))
            {
                return 0;
            }
            PHYSICAL_DEVICE_FEATURES.forEach((name, index)=>writeU32(memory,
                (pFeatures >>> 0) + index * 4, features.has(name) ? VK_TRUE : VK_FALSE));
            return 0;
        },

        /**
         * void vkGetPhysicalDeviceQueueFamilyProperties(VkPhysicalDevice, uint32_t*,
         *     VkQueueFamilyProperties*)
         *
         * The count protocol without the result: this one returns void.
         */
        vkGetPhysicalDeviceQueueFamilyProperties: (/** @type {number[]} */ [handle, pCount,
            pProperties])=>{
            if (!physicalDeviceOf(handle >>> 0, 'vkGetPhysicalDeviceQueueFamilyProperties'))
            {
                return 0;
            }
            enumerate(context, pCount >>> 0, pProperties >>> 0, [QUEUE_FAMILY],
                VkQueueFamilyProperties.SIZE, (address, family)=>{
                    const Q = VkQueueFamilyProperties;
                    writeU32(memory, address + Q.queueFlags, family.queueFlags);
                    writeU32(memory, address + Q.queueCount, family.queueCount);
                    writeU32(memory, address + Q.timestampValidBits, family.timestampValidBits);
                    const granularity = address + Q.minImageTransferGranularity;
                    writeU32(memory, granularity + VkExtent3D.width,
                        family.minImageTransferGranularity.width);
                    writeU32(memory, granularity + VkExtent3D.height,
                        family.minImageTransferGranularity.height);
                    writeU32(memory, granularity + VkExtent3D.depth,
                        family.minImageTransferGranularity.depth);
                });
            return 0;
        },

        /**
         * void vkGetPhysicalDeviceMemoryProperties(VkPhysicalDevice,
         *     VkPhysicalDeviceMemoryProperties*)
         */
        vkGetPhysicalDeviceMemoryProperties: (/** @type {number[]} */ [handle, pProperties])=>{
            if (!physicalDeviceOf(handle >>> 0, 'vkGetPhysicalDeviceMemoryProperties'))
            {
                return 0;
            }
            const at = pProperties >>> 0;
            const M = VkPhysicalDeviceMemoryProperties;
            memory.writeMemory(at, new Uint8Array(M.SIZE));
            writeU32(memory, at + M.memoryTypeCount, MEMORY.types.length);
            MEMORY.types.forEach((type, index)=>{
                const entry = at + M.memoryTypes + index * VkMemoryType.SIZE;
                writeU32(memory, entry + VkMemoryType.propertyFlags, type.propertyFlags);
                writeU32(memory, entry + VkMemoryType.heapIndex, type.heapIndex);
            });
            writeU32(memory, at + M.memoryHeapCount, MEMORY.heaps.length);
            MEMORY.heaps.forEach((heap, index)=>{
                const entry = at + M.memoryHeaps + index * VkMemoryHeap.SIZE;
                writeU64(memory, entry + VkMemoryHeap.size, heap.size);
                writeU32(memory, entry + VkMemoryHeap.flags, heap.flags);
            });
            return 0;
        },

        /** void vkGetPhysicalDeviceFormatProperties(VkPhysicalDevice, VkFormat, VkFormatProperties*) */
        vkGetPhysicalDeviceFormatProperties: (/** @type {number[]} */ [handle, format,
            pProperties])=>{
            if (!physicalDeviceOf(handle >>> 0, 'vkGetPhysicalDeviceFormatProperties'))
            {
                return 0;
            }
            const found = formatFeatures(format >>> 0);
            const at = pProperties >>> 0;
            writeU32(memory, at + VkFormatProperties.linearTilingFeatures, found.linear);
            writeU32(memory, at + VkFormatProperties.optimalTilingFeatures, found.optimal);
            writeU32(memory, at + VkFormatProperties.bufferFeatures, found.buffer);
            return 0;
        },

        /**
         * VkResult vkEnumerateDeviceExtensionProperties(VkPhysicalDevice, const char*,
         *     uint32_t*, VkExtensionProperties*)
         */
        vkEnumerateDeviceExtensionProperties: (/** @type {number[]} */ [handle, pLayerName,
            pCount, pProperties])=>{
            if (!physicalDeviceOf(handle >>> 0, 'vkEnumerateDeviceExtensionProperties'))
            {
                return VkResult.ERROR_INITIALIZATION_FAILED;
            }
            if ((pLayerName >>> 0) !== 0)
            {
                return VkResult.ERROR_LAYER_NOT_PRESENT;
            }
            return enumerate(context, pCount >>> 0, pProperties >>> 0,
                extensionList(DEVICE_EXTENSIONS), VkExtensionProperties.SIZE, writeExtension);
        },

        /** VkResult vkEnumerateDeviceLayerProperties(VkPhysicalDevice, uint32_t*, VkLayerProperties*) */
        vkEnumerateDeviceLayerProperties: (/** @type {number[]} */ [handle, pCount,
            pProperties])=>{
            if (!physicalDeviceOf(handle >>> 0, 'vkEnumerateDeviceLayerProperties'))
            {
                return VkResult.ERROR_INITIALIZATION_FAILED;
            }
            return enumerate(context, pCount >>> 0, pProperties >>> 0, [],
                VkLayerProperties.SIZE, ()=>{});
        },

        /**
         * VkResult vkCreateDevice(VkPhysicalDevice, const VkDeviceCreateInfo*,
         *     const VkAllocationCallbacks*, VkDevice*)
         */
        vkCreateDevice: (/** @type {number[]} */ [handle, pCreateInfo, , pDevice])=>{
            const physical = physicalDeviceOf(handle >>> 0, 'vkCreateDevice');
            if (!physical)
            {
                return VkResult.ERROR_INITIALIZATION_FAILED;
            }
            const info = pCreateInfo >>> 0;
            const D = VkDeviceCreateInfo;
            const layers = readStringArray(memory, readU32(memory, info + D.enabledLayerCount),
                readU32(memory, info + D.ppEnabledLayerNames));
            if (layers.length > 0)
            {
                return VkResult.ERROR_LAYER_NOT_PRESENT;
            }
            const extensions = readStringArray(memory,
                readU32(memory, info + D.enabledExtensionCount),
                readU32(memory, info + D.ppEnabledExtensionNames));
            if (extensions.some(name=>!(name in DEVICE_EXTENSIONS)))
            {
                return VkResult.ERROR_EXTENSION_NOT_PRESENT;
            }
            const missing = missingFeatures(readU32(memory, info + D.pEnabledFeatures));
            if (missing.length > 0)
            {
                context.diverge(`vkCreateDevice refused features this device lacks: `
                    + missing.join(', '));
                return VkResult.ERROR_FEATURE_NOT_PRESENT;
            }
            const queueCount = readU32(memory, info + D.queueCreateInfoCount);
            const queueInfos = readU32(memory, info + D.pQueueCreateInfos);
            for (let index = 0; index < queueCount; index++)
            {
                const each = queueInfos + index * VkDeviceQueueCreateInfo.SIZE;
                const family = readU32(memory, each + VkDeviceQueueCreateInfo.queueFamilyIndex);
                const count = readU32(memory, each + VkDeviceQueueCreateInfo.queueCount);
                if (family !== 0 || count !== 1)
                {
                    context.diverge(`vkCreateDevice asked for ${count} queue(s) of family `
                        + `${family}: there is one family with one queue`);
                    return VkResult.ERROR_INITIALIZATION_FAILED;
                }
            }
            const device = createDevice(context, {
                physicalDevice: handle >>> 0,
                extensions: new Set(extensions),
            });
            writeU32(memory, pDevice >>> 0, device.handle);
            return VkResult.SUCCESS;
        },

        // --- VK_KHR_surface and VK_KHR_win32_surface ---

        /**
         * VkResult vkCreateWin32SurfaceKHR(VkInstance, const VkWin32SurfaceCreateInfoKHR*,
         *     const VkAllocationCallbacks*, VkSurfaceKHR*)
         */
        vkCreateWin32SurfaceKHR: (/** @type {number[]} */ [handle, pCreateInfo, , pSurface])=>{
            const instance = instanceOf(handle >>> 0, 'vkCreateWin32SurfaceKHR');
            if (!instance)
            {
                return VkResult.ERROR_INITIALIZATION_FAILED;
            }
            if (!instance.extensions.has('VK_KHR_win32_surface'))
            {
                context.diverge('vkCreateWin32SurfaceKHR was called on an instance that did not'
                    + ' enable VK_KHR_win32_surface');
            }
            const surface = handles.mint(/** @type {Surface} */ ({
                kind: 'surface',
                instance: handle >>> 0,
                hwnd: readU32(memory, (pCreateInfo >>> 0) + VkWin32SurfaceCreateInfoKHR.hwnd),
            }));
            writeU64(memory, pSurface >>> 0, surface);
            return VkResult.SUCCESS;
        },

        /** void vkDestroySurfaceKHR(VkInstance, VkSurfaceKHR, const VkAllocationCallbacks*) */
        vkDestroySurfaceKHR: (/** @type {number[]} */ [, low, high])=>{
            const handle = joinU64(low, high);
            if (handle !== 0 && surfaceOf(handle, 'vkDestroySurfaceKHR'))
            {
                handles.release(handle);
            }
            return 0;
        },

        /** VkBool32 vkGetPhysicalDeviceWin32PresentationSupportKHR(VkPhysicalDevice, uint32_t) */
        vkGetPhysicalDeviceWin32PresentationSupportKHR: (/** @type {number[]} */ [handle,
            family])=>(physicalDeviceOf(handle >>> 0,
            'vkGetPhysicalDeviceWin32PresentationSupportKHR') && family === 0
            ? VK_TRUE
            : VK_FALSE),

        /**
         * VkResult vkGetPhysicalDeviceSurfaceSupportKHR(VkPhysicalDevice, uint32_t,
         *     VkSurfaceKHR, VkBool32*)
         */
        vkGetPhysicalDeviceSurfaceSupportKHR: (/** @type {number[]} */ [handle, family, low, high,
            pSupported])=>{
            if (!physicalDeviceOf(handle >>> 0, 'vkGetPhysicalDeviceSurfaceSupportKHR')
                || !surfaceOf(joinU64(low, high), 'vkGetPhysicalDeviceSurfaceSupportKHR'))
            {
                return VkResult.ERROR_SURFACE_LOST_KHR;
            }
            writeU32(memory, pSupported >>> 0, family === 0 ? VK_TRUE : VK_FALSE);
            return VkResult.SUCCESS;
        },

        /**
         * VkResult vkGetPhysicalDeviceSurfaceCapabilitiesKHR(VkPhysicalDevice, VkSurfaceKHR,
         *     VkSurfaceCapabilitiesKHR*)
         *
         * The extent is the screen and nothing else: minimum, maximum and
         * current are all the same size, because the display is not resizable
         * from inside.
         */
        vkGetPhysicalDeviceSurfaceCapabilitiesKHR: (/** @type {number[]} */ [handle, low, high,
            pCapabilities])=>{
            if (!physicalDeviceOf(handle >>> 0, 'vkGetPhysicalDeviceSurfaceCapabilitiesKHR')
                || !surfaceOf(joinU64(low, high), 'vkGetPhysicalDeviceSurfaceCapabilitiesKHR'))
            {
                return VkResult.ERROR_SURFACE_LOST_KHR;
            }
            const at = pCapabilities >>> 0;
            const C = VkSurfaceCapabilitiesKHR;
            const screen = context.screen();
            writeU32(memory, at + C.minImageCount, 2);
            writeU32(memory, at + C.maxImageCount, 0);
            writeExtent2D(memory, at + C.currentExtent, screen);
            writeExtent2D(memory, at + C.minImageExtent, screen);
            writeExtent2D(memory, at + C.maxImageExtent, screen);
            writeU32(memory, at + C.maxImageArrayLayers, 1);
            writeU32(memory, at + C.supportedTransforms,
                VkSurfaceTransformFlagBitsKHR.IDENTITY_BIT_KHR);
            writeU32(memory, at + C.currentTransform,
                VkSurfaceTransformFlagBitsKHR.IDENTITY_BIT_KHR);
            writeU32(memory, at + C.supportedCompositeAlpha,
                VkCompositeAlphaFlagBitsKHR.OPAQUE_BIT_KHR);
            writeU32(memory, at + C.supportedUsageFlags, SURFACE_USAGE);
            return VkResult.SUCCESS;
        },

        /**
         * VkResult vkGetPhysicalDeviceSurfaceFormatsKHR(VkPhysicalDevice, VkSurfaceKHR,
         *     uint32_t*, VkSurfaceFormatKHR*)
         */
        vkGetPhysicalDeviceSurfaceFormatsKHR: (/** @type {number[]} */ [handle, low, high, pCount,
            pFormats])=>{
            if (!physicalDeviceOf(handle >>> 0, 'vkGetPhysicalDeviceSurfaceFormatsKHR')
                || !surfaceOf(joinU64(low, high), 'vkGetPhysicalDeviceSurfaceFormatsKHR'))
            {
                return VkResult.ERROR_SURFACE_LOST_KHR;
            }
            return enumerate(context, pCount >>> 0, pFormats >>> 0, SURFACE_FORMATS,
                VkSurfaceFormatKHR.SIZE, (address, each)=>{
                    writeU32(memory, address + VkSurfaceFormatKHR.format, each.format);
                    writeU32(memory, address + VkSurfaceFormatKHR.colorSpace, each.colorSpace);
                });
        },

        /**
         * VkResult vkGetPhysicalDeviceSurfacePresentModesKHR(VkPhysicalDevice, VkSurfaceKHR,
         *     uint32_t*, VkPresentModeKHR*)
         */
        vkGetPhysicalDeviceSurfacePresentModesKHR: (/** @type {number[]} */ [handle, low, high,
            pCount, pModes])=>{
            if (!physicalDeviceOf(handle >>> 0, 'vkGetPhysicalDeviceSurfacePresentModesKHR')
                || !surfaceOf(joinU64(low, high), 'vkGetPhysicalDeviceSurfacePresentModesKHR'))
            {
                return VkResult.ERROR_SURFACE_LOST_KHR;
            }
            return enumerate(context, pCount >>> 0, pModes >>> 0, PRESENT_MODES, 4,
                (address, mode)=>writeU32(memory, address, mode));
        },
    };

    return {
        commands,

        /**
         * Whether `vkGetInstanceProcAddr` answers for a name.
         *
         * The rules are the specification's: with no instance only the global
         * commands exist; with one, every core command at any level does, and
         * an extension command only when the extension is enabled on that
         * instance -- or, for a device extension, whenever this loader offers
         * it, since the instance cannot know which device will be made.
         *
         * @param {number} instanceHandle
         * @param {string} name
         * @returns {boolean}
         */
        instanceProcVisible(instanceHandle, name){
            const command = COMMANDS[name];
            if (!command)
            {
                return false;
            }
            if (instanceHandle === 0)
            {
                return command.level === 'global';
            }
            const instance = /** @type {Instance | null} */ (
                handles.get(instanceHandle, 'instance'));
            if (!instance)
            {
                return false;
            }
            if (!command.extension)
            {
                return true;
            }
            return command.extension in DEVICE_EXTENSIONS
                || instance.extensions.has(command.extension);
        },
    };
}
