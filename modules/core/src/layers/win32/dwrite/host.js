/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What DirectWrite is given by the layer that installs it: guest memory, the
 * heap, COM's vtables, the program's own COM objects, files, the font engine.
 * A file of its own so the library's parts name it without importing each
 * other.
 */

/**
 * @typedef {Object} DwriteHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {{ allocate: (bytes: number) => number, free: (address: number) => any }} heap
 * @property {{ publish: (object: any, interfaceId: string) => number,
 *     unpublish?: (object: any, interfaceId: string) => boolean }} vtables
 * @property {(pointer: number) => any} objectAt  the object behind a pointer published here
 * @property {(call: { entry: number, args: number[], thread?: any }) => Promise<number>}
 *     callGuest
 * @property {() => any} currentThread
 * @property {(path: string) => Promise<Uint8Array | null> | Uint8Array | null} readFile
 * @property {(path: string) => bigint | null} [modified]  a file's last write, as a FILETIME
 * @property {{ setResult: (value: number) => void } | null} [fpu]  a float answer's register
 * @property {(api: string, detail: string, kind?: 'loss') => void} [divergence]
 * @property {import('./system.js').Measurer} measure
 * @property {(name: string, args: number[]) => number} [gdi]  a gdi32 export, called: what
 *     a bitmap render target's memory context and bitmaps are made with
 */

export {};
