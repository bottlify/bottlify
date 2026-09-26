/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The rendering backend's contract. Typedefs only, no runtime exports.
 *
 * Every guest-facing graphics API sits on this. The device and queue arrive
 * injected, so the whole backend runs headless in a test with a recording
 * double; nothing here reads a global, and nothing here knows what a guest
 * API is.
 *
 * The semantics decided here, which the facades above must not relitigate:
 *
 * - **One encoder, one submit per frame.** There is no submit anywhere on the
 *   surface. A frame owns the only encoder; ending the frame is the only thing
 *   that reaches the queue, and it can happen once. Switching render targets
 *   opens a new pass on the same encoder.
 * - **Locking a dynamic buffer.** `DISCARD` means the old contents are gone, so
 *   only the bytes the guest wrote have to travel. `NOOVERWRITE` means the guest
 *   promises not to touch bytes recorded draws still read, so the buffer is not
 *   renamed and the newly written ranges are enough. A lock with neither flag
 *   renames -- a write into a buffer earlier draws in this frame already read is
 *   otherwise a hazard -- and a rename leaves the old contents observable, so
 *   the whole buffer travels. Uploaded ranges round outward to the API's
 *   alignment and are sent from their own offset.
 * - **Bindings.** Bind-group layouts are explicit; a pipeline with an automatic
 *   layout is refused. Uniform blocks live in one ring buffer and are bound at
 *   a dynamic offset, so a group names a texture, a sampler and the ring and
 *   nothing that changes per draw; the bind-group cache is keyed on those
 *   identities and lives as long as the backend.
 * - **Textures.** Block-compressed uploads go through a staging buffer with rows
 *   repacked to the copy alignment; a direct write is used only for uncompressed
 *   formats, and can be forced either way.
 * - **The viewport is two halves and this backend implements both** -- see
 *   `internal/viewport.js`, which is the one place that pairing is expressed.
 * - **Presentation.** A finished frame leaves through `presentTo` and nowhere
 *   else, and `lastPresented()` hands back exactly that object, so a diagnostic
 *   read-back cannot take a shortcut past the composition the user sees.
 *
 * @typedef {Object} GpuDeviceLike
 * @property {(desc: any)=>any} createBuffer
 * @property {(desc: any)=>any} createTexture
 * @property {(desc: any)=>any} createBindGroupLayout
 * @property {(desc: any)=>any} createPipelineLayout
 * @property {(desc: any)=>any} createBindGroup
 * @property {(desc: any)=>any} createShaderModule
 * @property {(desc: any)=>any} createRenderPipeline
 * @property {(desc: any)=>Promise<any>} createRenderPipelineAsync
 * @property {(desc?: any)=>GpuCommandEncoderLike} createCommandEncoder
 * @property {(desc: any)=>any} createQuerySet
 */

/**
 * @typedef {Object} GpuQueueLike
 * @property {(buffer: any, bufferOffset: number, data: any, dataOffset?: number,
 *            size?: number)=>void} writeBuffer
 * @property {(destination: any, data: any, layout: any, size: any)=>void} writeTexture
 * @property {(buffers: any[])=>void} submit
 */

/**
 * @typedef {Object} GpuCommandEncoderLike
 * @property {(desc: any)=>any} beginRenderPass
 * @property {(source: any, destination: any, size: any)=>void} copyBufferToTexture
 * @property {(source: any, destination: any, size: any)=>void} copyTextureToBuffer
 * @property {(source: any, sourceOffset: number, destination: any, destinationOffset: number,
 *            size: number)=>void} copyBufferToBuffer
 * @property {(source: any, destination: any, size: any)=>void} copyTextureToTexture
 * @property {(querySet: any, firstQuery: number, queryCount: number, destination: any,
 *            destinationOffset: number)=>void} resolveQuerySet
 * @property {(desc?: any)=>any} finish
 */

/**
 * A colour target the backend owns: a texture plus the view passes attach.
 *
 * @typedef {Object} Surface
 * @property {any} texture
 * @property {any} view
 * @property {number} width
 * @property {number} height
 * @property {string} format
 * @property {number} [mipLevelCount]  One unless the surface carries a chain.
 * @property {number} [layers]         Array layers; six for a cube map.
 * @property {number} [mipLevel]       The level of `texture` this is a view of; zero unless said.
 * @property {number} [layer]          The array layer -- a cube's face -- this is a view of.
 * @property {string} label
 */

/**
 * What `presentTo` receives, and what `lastPresented()` returns.
 *
 * @typedef {Object} PresentedFrame
 * @property {Surface} surface
 * @property {number} frameIndex
 */

/**
 * A viewport rectangle in target pixels. Depth defaults to the full range.
 *
 * @typedef {Object} ViewportRect
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 * @property {number} [minDepth]
 * @property {number} [maxDepth]
 */

/**
 * Both halves of the viewport contract, produced together and never apart.
 *
 * @typedef {Object} ViewportState
 * @property {Required<ViewportRect>} rect      what the hardware viewport is set to
 * @property {[number, number]} offset          the vertex stage's inverse offset
 * @property {[number, number]} scale           the vertex stage's inverse extent
 */

/**
 * A lease over part of a dynamic buffer. `data` is a view on the host shadow
 * copy: writing through it is what makes the range dirty.
 *
 * @typedef {Object} BufferLock
 * @property {Uint8Array} data
 * @property {number} offset
 * @property {number} length
 * @property {number} flags
 */

/**
 * @typedef {Object} BackendOptions
 * @property {GpuDeviceLike} device
 * @property {GpuQueueLike} queue
 * @property {(frame: PresentedFrame)=>void} presentTo
 * @property {()=>number} [now]            clock for the frame profiler
 * @property {number} [frameHistory]       how many frame records to keep
 */

// Intentionally no runtime exports: types are used through JSDoc-import.
