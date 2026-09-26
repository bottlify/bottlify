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
 */

/**
 * The PCI vendor id and the description a program is shown for an adapter.
 *
 * @param {AdapterIdentity | null} known
 * @returns {{ vendorId: number, description: string }}
 */
export function describeAdapter(known){
    return {
        vendorId: PCI_VENDOR_IDS[(known?.vendor ?? '').toLowerCase()] ?? 0,
        description: known?.description
            || [known?.vendor, known?.architecture].filter(Boolean).join(' ')
            || 'WebGPU adapter',
    };
}
