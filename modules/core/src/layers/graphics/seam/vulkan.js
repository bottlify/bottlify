/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * `vulkan-1.dll`: the Khronos loader, as a library table.
 *
 * Vulkan is a C ABI, not COM. Every command is a plain stdcall function a
 * program reaches either by name from the library or by pointer from
 * `vkGetInstanceProcAddr`, and the second path is the one that makes this
 * seam different from the others: it has to hand back a guest address, and
 * the address it hands back has to be one that calls the same handler the
 * export does.
 *
 * So every command is placed as a trap once, through the builder the caller
 * assembling the process hands to a `guest` entry, and the table remembers
 * where. An export's target is its trap; `vkGetInstanceProcAddr` answers
 * with the same trap; there is one address per command and it is minted
 * before the program's first instruction, which is what an address taken
 * early and used late needs (a program keeps the pointer for its lifetime).
 *
 * The runtime behind the traps is built when a program first calls into it,
 * so a build that never touches Vulkan never builds a GPU.
 */

import { COMMANDS } from '../vulkan/commands.js';
import { readCString } from '../vulkan/structs.js';

/**
 * @typedef {Object} VulkanSeamOptions
 * @property {{ create: (name: string, options?: unknown) => VulkanRuntime }} graphics
 * @property {import('../vulkan/structs.js').GuestMemory} memory
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {(width: number, height: number) => void} [resolution]
 */

/**
 * What `graphics.create('vulkan')` hands back: the runtime's handlers and its
 * two visibility rules.
 *
 * @typedef {Object} VulkanRuntime
 * @property {Record<string, (args: number[]) => number>} handlers
 * @property {(instance: number, name: string) => boolean} instanceProcVisible
 * @property {(device: number, name: string) => boolean} deviceProcVisible
 * @property {() => { objects: Record<string, number>,
 *            unimplemented: Record<string, number> }} diagnostics
 */

/**
 * @typedef {Object} GuestBuilder
 * @property {(label: string, trap: { argBytes: number,
 *            handler: (args: number[]) => number }) => number} register
 */

/**
 * @param {VulkanSeamOptions} options
 */
export function createVulkanSeam({ graphics, memory, divergence, resolution }){
    /** @type {VulkanRuntime | null} */
    let runtime = null;
    const vulkan = ()=>{
        runtime ??= graphics.create('vulkan', { divergence, resolution });
        return runtime;
    };

    /** @type {Map<string, number>} command name -> its trap's guest address */
    const traps = new Map();

    /**
     * The address of a command, or zero for a name that is not one. Zero is
     * also what a name gets before the traps are placed, which only happens
     * in a build with no process to place them in.
     *
     * @param {string} name
     */
    const addressOf = name=>traps.get(name) ?? 0;

    /** @param {number} pName @returns {string} */
    const nameAt = pName=>((pName >>> 0) === 0 ? '' : readCString(memory, pName >>> 0, 256));

    /**
     * The two commands that answer with addresses. They are the seam's own,
     * because only the seam knows an address; the runtime decides whether
     * the name is visible from where it is asked.
     *
     * @type {Record<string, (args: number[]) => number>}
     */
    const addressing = {
        /** PFN_vkVoidFunction vkGetInstanceProcAddr(VkInstance, const char*) */
        vkGetInstanceProcAddr: ([instance, pName])=>{
            const name = nameAt(pName);
            return name !== '' && vulkan().instanceProcVisible(instance >>> 0, name)
                ? addressOf(name)
                : 0;
        },

        /** PFN_vkVoidFunction vkGetDeviceProcAddr(VkDevice, const char*) */
        vkGetDeviceProcAddr: ([device, pName])=>{
            const name = nameAt(pName);
            return name !== '' && vulkan().deviceProcVisible(device >>> 0, name)
                ? addressOf(name)
                : 0;
        },
    };

    /** @type {Record<string, { argBytes: number, handler: (args: number[]) => number }>} */
    const table = {};
    for (const [name, abi] of Object.entries(COMMANDS))
    {
        table[name] = {
            argBytes: abi.argBytes,
            handler: addressing[name] ?? (args=>vulkan().handlers[name](args)),
        };
    }

    /**
     * Places every trap, once. Called through whichever export the assembling
     * caller asks about first; every later one finds its address waiting.
     *
     * @param {GuestBuilder} builder
     */
    const place = builder=>{
        if (traps.size > 0)
        {
            return;
        }
        for (const [name, entry] of Object.entries(table))
        {
            traps.set(name, builder.register(`vulkan-1.dll!${name}`, entry));
        }
    };

    /** @type {Record<string, { argBytes: number, handler: (args: number[]) => number,
     *                          guest: (builder: GuestBuilder) => number }>} */
    const library = {};
    for (const [name, entry] of Object.entries(table))
    {
        library[name] = {
            ...entry,
            guest: builder=>{
                place(builder);
                return addressOf(name);
            },
        };
    }

    return {
        library,

        /**
         * The address a program is handed for a name, for whoever needs it
         * without going through guest memory.
         *
         * @param {string} name
         */
        addressOf,

        diagnostics: ()=>({
            placed: traps.size,
            ...(runtime ? runtime.diagnostics() : { objects: {}, unimplemented: {} }),
        }),
    };
}
