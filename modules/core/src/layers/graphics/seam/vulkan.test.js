/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVulkanSeam } from './vulkan.js';
import { COMMANDS } from '../vulkan/commands.js';
import { VkResult } from '../vulkan/constants.js';
import { VkInstanceCreateInfo } from '../vulkan/structs.js';
import { createFixture } from '../vulkan/fixture.js';

/** A builder that hands out addresses the way the assembling caller's does. */
function createBuilder(){
    /** @type {Map<number, { label: string, argBytes: number, handler: Function }>} */
    const placed = new Map();
    let next = 0x0e100000;
    return {
        placed,
        /** @param {string} label @param {{ argBytes: number, handler: Function }} trap */
        register(label, trap){
            const address = next;
            next += 16;
            placed.set(address, { label, ...trap });
            return address;
        },
    };
}

/** The seam over the fixture's runtime, with its traps placed. */
function harness(){
    const f = createFixture();
    const seam = createVulkanSeam({
        graphics: { create: ()=>f.vulkan },
        memory: f.memory,
        divergence: (api, detail)=>f.divergences.push(`${api}: ${detail}`),
    });
    const builder = createBuilder();
    /** @type {Record<string, number>} export name -> the target the caller would bind */
    const targets = {};
    for (const [name, entry] of Object.entries(seam.library))
    {
        targets[name] = entry.guest(builder);
    }
    return { f, seam, builder, targets };
}

test('every command is exported with the argument size the ABI table declares', ()=>{
    const { seam } = harness();
    assert.deepEqual(Object.keys(seam.library).sort(), Object.keys(COMMANDS).sort());
    for (const [name, abi] of Object.entries(COMMANDS))
    {
        assert.equal(seam.library[name].argBytes, abi.argBytes, name);
    }
    assert.equal(seam.library.vkAcquireNextImageKHR.argBytes, 40);
    assert.equal(seam.library.vkGetInstanceProcAddr.argBytes, 8);
});

test('one trap per command, placed once, and the export targets it', ()=>{
    const { seam, builder, targets } = harness();
    assert.equal(builder.placed.size, Object.keys(COMMANDS).length);
    for (const name of Object.keys(COMMANDS))
    {
        assert.equal(targets[name], seam.addressOf(name));
        assert.equal(builder.placed.get(targets[name])?.label, `vulkan-1.dll!${name}`);
    }
    // Asking again places nothing more and answers the same address.
    assert.equal(seam.library.vkCreateInstance.guest(builder), targets.vkCreateInstance);
    assert.equal(builder.placed.size, Object.keys(COMMANDS).length);
});

test('vkGetInstanceProcAddr answers the export address, by the visibility rules', ()=>{
    const { f, seam, targets } = harness();
    const gipa = seam.library.vkGetInstanceProcAddr.handler;
    assert.equal(gipa([0, f.str('vkCreateInstance')]), targets.vkCreateInstance);
    assert.equal(gipa([0, f.str('vkGetInstanceProcAddr')]), targets.vkGetInstanceProcAddr);
    assert.equal(gipa([0, f.str('vkCreateDevice')]), 0, 'instance-level without an instance');
    assert.equal(gipa([0, f.str('vkNotACommand')]), 0);
    assert.equal(gipa([0, 0]), 0, 'a null name');

    // Through the trap the program would actually call, the same answer.
    const trap = seam.library.vkCreateInstance;
    const out = f.out();
    assert.equal(trap.handler([f.put(VkInstanceCreateInfo, {}), 0, out]), VkResult.SUCCESS);
    const instance = f.u32(out);
    assert.equal(gipa([instance, f.str('vkCreateDevice')]), targets.vkCreateDevice);
    assert.equal(gipa([instance, f.str('vkCmdDraw')]), targets.vkCmdDraw);
    assert.equal(gipa([instance, f.str('vkCreateWin32SurfaceKHR')]), 0,
        'the extension was not enabled');
    assert.equal(gipa([instance, f.str('vkCreateSwapchainKHR')]), targets.vkCreateSwapchainKHR);
    assert.equal(gipa([0x1234, f.str('vkCreateDevice')]), 0, 'not an instance');
});

test('vkGetDeviceProcAddr answers device-level names only', ()=>{
    const { f, seam, targets } = harness();
    const gdpa = seam.library.vkGetDeviceProcAddr.handler;
    assert.equal(gdpa([0, f.str('vkCmdDraw')]), 0, 'no device');
    assert.equal(gdpa([0, 0]), 0);
    // A device made through the seam's own exports.
    const out = f.out();
    seam.library.vkCreateInstance.handler([f.put(VkInstanceCreateInfo, {}), 0, out]);
    const count = f.out();
    f.memory.writeMemory(count, new Uint8Array([1, 0, 0, 0]));
    seam.library.vkEnumeratePhysicalDevices.handler([f.u32(out), count, out]);
    const physical = f.u32(out);
    const queue = f.alloc(24);
    f.memory.writeMemory(queue + 16, new Uint8Array([1, 0, 0, 0]));
    const info = f.alloc(40);
    f.memory.writeMemory(info + 12, new Uint8Array([1, 0, 0, 0]));
    f.memory.writeMemory(info + 16, new Uint8Array([
        queue & 0xff, (queue >>> 8) & 0xff, (queue >>> 16) & 0xff, queue >>> 24]));
    assert.equal(seam.library.vkCreateDevice.handler([physical, info, 0, out]), VkResult.SUCCESS);
    const device = f.u32(out);
    assert.equal(gdpa([device, f.str('vkCmdDraw')]), targets.vkCmdDraw);
    assert.equal(gdpa([device, f.str('vkCreateInstance')]), 0);
    assert.equal(gdpa([device, f.str('vkCreateSwapchainKHR')]), 0, 'not enabled on the device');
});

test('the runtime is built on the first call, and the diagnostics say what was asked of it', ()=>{
    const f = createFixture();
    let created = 0;
    const seam = createVulkanSeam({
        graphics: {
            create: ()=>{
                created++;
                return f.vulkan;
            },
        },
        memory: f.memory,
    });
    assert.equal(created, 0);
    assert.deepEqual(seam.diagnostics(), { placed: 0, objects: {}, unimplemented: {} });
    assert.equal(seam.library.vkCmdDraw.handler([0, 3, 1, 0, 0]),
        VkResult.ERROR_FEATURE_NOT_PRESENT);
    assert.equal(created, 1);
    seam.library.vkCmdDraw.handler([0, 3, 1, 0, 0]);
    assert.equal(created, 1, 'once');
    assert.deepEqual(seam.diagnostics().unimplemented, { vkCmdDraw: 2 });
    // With no traps placed, an address is zero rather than a lie.
    assert.equal(seam.library.vkGetInstanceProcAddr.handler([0, f.str('vkCreateInstance')]), 0);
});
