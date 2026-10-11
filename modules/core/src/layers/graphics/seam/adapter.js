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
 * @property {string} [presentAs]     A card from `PRESENTED_CARDS` to be told of in its
 *     place (the `adapterAs` option): a program that picks its render path from a card
 *     database it knows only those vendors' cards in.
 */

/**
 * Cards a program may be told of, for `presentAs`: their PCI vendor and
 * device ids and the shader model they had. A program knows the cards of its
 * own years -- one it does not know falls to its weakest path, a 2004 one
 * taking a GeForce 6800 for a TNT2 -- and expects the card it knows to have
 * that card's shaders: told of a Radeon 9800 with model 3 beside it, a 2004
 * shader compiler asked for the device's newest profile knows none and fails.
 *
 * @type {Readonly<Record<string, { vendorId: number, deviceId: number,
 *     shaderModel: Readonly<{ major: number, minor: number }> }>>}
 */
export const PRESENTED_CARDS = Object.freeze({
    // GeForce 6800.
    nvidia: Object.freeze({ vendorId: 0x10de, deviceId: 0x0040,
        shaderModel: Object.freeze({ major: 3, minor: 0 }) }),
    // Radeon 9800 Pro: a card the programs of its years and after know.
    amd: Object.freeze({ vendorId: 0x1002, deviceId: 0x4e48,
        shaderModel: Object.freeze({ major: 2, minor: 0 }) }),
});

/**
 * The device caps a presented card brings with it: its shader versions, or
 * nothing for an adapter told of as itself.
 *
 * @param {AdapterIdentity | null | undefined} known
 * @returns {{ vertexShaderVersion?: { major: number, minor: number },
 *     pixelShaderVersion?: { major: number, minor: number } }}
 */
export function presentedCaps(known){
    const card = PRESENTED_CARDS[known?.presentAs ?? ''];
    return card
        ? { vertexShaderVersion: card.shaderModel, pixelShaderVersion: card.shaderModel }
        : {};
}

/**
 * The PCI vendor id and the description a program is shown for an adapter:
 * the vendor the browser's adapter has, which a program's card database is
 * keyed by, and the machine's own name for its video adapter.
 *
 * @param {AdapterIdentity | null} known
 * @returns {{ vendorId: number, deviceId: number, description: string }}
 */
export function describeAdapter(known){
    const presented = PRESENTED_CARDS[known?.presentAs ?? ''];
    return {
        vendorId: presented?.vendorId
            ?? PCI_VENDOR_IDS[(known?.vendor ?? '').toLowerCase()] ?? 0,
        deviceId: presented?.deviceId ?? 0,
        description: VIDEO_ADAPTER_NAME,
    };
}
