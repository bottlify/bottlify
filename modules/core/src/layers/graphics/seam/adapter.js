/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a program is told about the hardware behind a device.
 *
 * Every generation asks the same question -- DirectDraw's GetDeviceIdentifier,
 * Direct3D's GetAdapterIdentifier -- and has to hear the same answer: a
 * program that asks through two of them and compares the vendors is asking
 * whether it is on one card.
 */

import { VIDEO_ADAPTER_NAME } from '../../win32/devices.js';

/**
 * WebGPU's word for a vendor against the PCI id a program's card database is
 * keyed by. Only vendors with a WebGPU spelling appear; anything else is
 * reported as zero, an unknown card.
 *
 * @type {Readonly<Record<string, number>>}
 */
export const PCI_VENDOR_IDS = Object.freeze({
    nvidia: 0x10de,
    amd: 0x1002,
    intel: 0x8086,
    apple: 0x106b,
    qualcomm: 0x5143,
    arm: 0x13b5,
    microsoft: 0x1414,
});

/**
 * The identifier's GUID: one per adapter and driver on Windows, and one for
 * this engine here -- a program keeps it to recognise the same hardware next
 * run, and the same engine is the same hardware for that purpose.
 */
export const ADAPTER_GUID = Uint8Array.from([
    0x7a, 0x1b, 0x6c, 0x0d, 0x3e, 0x9f, 0x40, 0x11,
    0x8a, 0x2b, 0x5c, 0x6d, 0x7e, 0x8f, 0x90, 0xa1,
]);

/**
 * @typedef {Object} AdapterIdentity
 *     The hardware behind the device, as WebGPU describes it.
 * @property {string} [vendor]        WebGPU's vendor word, e.g. "nvidia".
 * @property {string} [architecture]  WebGPU's architecture word, e.g. "ampere".
 * @property {string} [description]   A human-readable name, when the browser gives one.
 * @property {string} [profile]       One of `GPU_PROFILES`, the profile the adapter is
 *     shown with (the `gpuProfile` option); absent, it is shown as the browser's.
 */

/**
 * @typedef {{ major: number, minor: number }} ShaderVersion
 * @typedef {{ vendorId: number, deviceId: number, vertexShader: ShaderVersion,
 *     pixelShader: ShaderVersion }} GpuProfile
 */

/** @param {number} major @param {number} minor @returns {ShaderVersion} */
const version = (major, minor)=>Object.freeze({ major, minor });

/**
 * The profiles the adapter may be shown with, by shader model: each the PCI
 * vendor and device ids of a card of that model and its shader versions.
 *
 * A program that picks its render path from a card database knows the cards
 * of its own years. One it does not know falls to its weakest path -- a 2004
 * one took a GeForce 6800 for a TNT2 -- and the card it knows has to come with
 * that card's shaders: shown a Radeon 9800 with model 3 beside it, a 2004
 * shader compiler asked for the device's newest profile knew none and failed.
 * So each is a card the programs of its years and after know.
 *
 * @type {Readonly<Record<string, GpuProfile>>}
 */
export const GPU_PROFILES = Object.freeze({
    // GeForce4 Ti 4600.
    sm1: Object.freeze({ vendorId: 0x10de, deviceId: 0x0250,
        vertexShader: version(1, 1), pixelShader: version(1, 3) }),
    // Radeon 9800 Pro.
    sm2: Object.freeze({ vendorId: 0x1002, deviceId: 0x4e48,
        vertexShader: version(2, 0), pixelShader: version(2, 0) }),
    // GeForce 7800 GTX.
    sm3: Object.freeze({ vendorId: 0x10de, deviceId: 0x0091,
        vertexShader: version(3, 0), pixelShader: version(3, 0) }),
    // GeForce 8800 GTX: model 4 under Direct3D 10, 3.0 under Direct3D 9.
    sm4: Object.freeze({ vendorId: 0x10de, deviceId: 0x0191,
        vertexShader: version(3, 0), pixelShader: version(3, 0) }),
});

/**
 * The Direct3D 9 caps a profile brings: its shader versions, or nothing for an
 * adapter shown as the browser's.
 *
 * @param {AdapterIdentity | null | undefined} known
 * @returns {{ vertexShaderVersion?: ShaderVersion, pixelShaderVersion?: ShaderVersion }}
 */
export function profileCaps(known){
    const profile = GPU_PROFILES[known?.profile ?? ''];
    return profile
        ? { vertexShaderVersion: profile.vertexShader, pixelShaderVersion: profile.pixelShader }
        : {};
}

/**
 * The PCI vendor and device ids and the description a program is shown for
 * the adapter: its profile's card, or the vendor the browser's adapter has --
 * which a program's card database is keyed by -- and the machine's own name
 * for its video adapter either way.
 *
 * @param {AdapterIdentity | null} known
 * @returns {{ vendorId: number, deviceId: number, description: string }}
 */
export function describeAdapter(known){
    const profile = GPU_PROFILES[known?.profile ?? ''];
    return {
        vendorId: profile?.vendorId
            ?? PCI_VENDOR_IDS[(known?.vendor ?? '').toLowerCase()] ?? 0,
        deviceId: profile?.deviceId ?? 0,
        description: VIDEO_ADAPTER_NAME,
    };
}
