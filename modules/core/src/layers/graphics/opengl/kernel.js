/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The kernel: what every `context-*.js` installer is handed, as a type.
 *
 * Kept in a file of its own so that an installer can name the type without
 * importing the context that builds it -- the context imports the
 * installers, and the other direction would be a cycle.
 */

/**
 * @typedef {Object} ContextMemory
 * @property {(address: number, length: number) => Uint8Array} read
 * @property {(address: number, bytes: Uint8Array) => void} write
 * @property {(bytes: number) => number} [allocate]  guest memory a program
 *           can write through, for a mapped buffer; absent when there is none
 */

/**
 * What the entry points share: the state, the error flag, and the three
 * decisions `enter` makes. Passed to every `context-*.js` installer.
 *
 * @typedef {Object} ContextKernel
 * @property {(name: string, args: any[]) => boolean} enter
 * @property {(code: number) => void} setError
 * @property {(query: number) => import('./state.js').StateRecord} record
 * @property {(query: number, values: number[]) => void} setState
 * @property {(detail: string) => void} diverge
 * @property {() => import('./objects.js').ShareGroup} shareGroup
 * @property {() => ContextMemory | null} memory
 * @property {() => import('./raster.js').Framebuffer} framebuffer
 * @property {() => boolean} inPrimitive
 * @property {() => import('./raster.js').Box} scissorBox
 * @property {Record<string, import('./matrix.js').MatrixStack>} stacks
 * @property {(mode: number, vertices: any[]) => void} drawVertices
 * @property {((request: import('./gpu.js').DrawRequest) => boolean) | null} drawArrays
 *           A draw straight from the arrays, when a renderer takes them as
 *           they lie: true when it did, false when the vertices are to be
 *           assembled here instead. Null in a build that draws on the processor.
 * @property {() => boolean} gpuBacked   whether the framebuffer's pixels live on
 *           a device rather than in `framebuffer()`, which then holds nothing
 * @property {() => any} currentVertex  the current attributes, as a vertex
 * @property {Record<string, any>} side  state that is not a query: texture
 *           units, lights, arrays -- each installer adds its own
 */

export {};
