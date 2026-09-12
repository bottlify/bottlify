/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The Vulkan runtime: every command `vulkan-1.dll` exports, as a handler over
 * guest memory.
 *
 * A command nothing implements yet is still here, because the export must
 * exist with the right argument size (see `commands.js`). It reports itself
 * by name the first time it is called and answers
 * `VK_ERROR_FEATURE_NOT_PRESENT`, which a program that checks results treats
 * as the failure it is, and which a void command's caller never sees -- for
 * those the report is the whole point.
 *
 * `vkGetInstanceProcAddr` and `vkGetDeviceProcAddr` are not handlers here:
 * they answer with guest addresses, which only the seam that placed the
 * exports knows. This runtime decides *whether* a name is visible; the seam
 * turns that into an address.
 */

import { VkResult } from './constants.js';
import { COMMANDS } from './commands.js';
import { createHandles } from './handles.js';
import { createInstanceCommands } from './instance.js';
import { createDeviceCommands } from './device.js';

/**
 * @typedef {Object} VulkanServices
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {() => import('./physical.js').Backend} backend
 *           The GPU, reached when a program first needs one.
 * @property {() => { width: number, height: number }} screen
 * @property {(width: number, height: number) => void} [resolution]
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {boolean} [compressedTextures]
 * @property {() => { vendor?: string, description?: string } | null} [adapter]
 */

/**
 * @param {VulkanServices} services
 */
export function createVulkan(services){
    const handles = createHandles();
    /** @type {Set<string>} what has been said, so each is said once */
    const said = new Set();
    /** @type {Map<string, number>} what a program called that is not implemented */
    const unimplemented = new Map();

    /** @type {import('./physical.js').VulkanContext} */
    const context = {
        memory: { readMemory: services.readMemory, writeMemory: services.writeMemory },
        handles,
        diverge: detail=>{
            if (said.has(detail))
            {
                return;
            }
            said.add(detail);
            services.divergence?.('Vulkan', detail);
        },
        backend: services.backend,
        screen: services.screen,
        resolution: services.resolution,
        compressedTextures: services.compressedTextures === true,
        adapter: services.adapter ?? (()=>null),
    };

    const instance = createInstanceCommands(context);
    const device = createDeviceCommands(context);

    /** @type {Record<string, (args: number[]) => number>} */
    const handlers = {};
    for (const name of Object.keys(COMMANDS))
    {
        handlers[name] = ()=>{
            unimplemented.set(name, (unimplemented.get(name) ?? 0) + 1);
            context.diverge(`${name} is not implemented: the call did nothing and answered`
                + ' VK_ERROR_FEATURE_NOT_PRESENT');
            return VkResult.ERROR_FEATURE_NOT_PRESENT;
        };
    }
    for (const [name, handler] of Object.entries({ ...instance.commands, ...device.commands }))
    {
        if (!COMMANDS[name])
        {
            // The two lists are the same specification seen twice, and a
            // name in one and not the other means its argument size was
            // never written down -- the failure `commands.js` exists to
            // prevent, so it is loud.
            throw new Error(`vulkan: ${name} is implemented but its argument size is not declared`);
        }
        handlers[name] = handler;
    }

    return {
        handlers,
        instanceProcVisible: instance.instanceProcVisible,
        deviceProcVisible: device.deviceProcVisible,
        lastFrame: device.lastFrame,

        diagnostics: ()=>({
            objects: handles.census(),
            // What a program reached for and did not get is the most useful
            // thing this layer can say about a run that drew nothing.
            unimplemented: Object.fromEntries(unimplemented),
        }),
    };
}
