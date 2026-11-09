/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A recording stand-in for a WebGPU device and queue.
 *
 * The backend takes its device injected precisely so this can exist: every
 * assertion about what reached the driver is made against the call log here,
 * with no browser and no adapter. It records; it does not simulate. Anything
 * that would need a real GPU to answer is not a question this double can be
 * asked -- which is also why no test may judge a frame by looking at it.
 *
 * The one thing it keeps is bytes: a buffer's, and the top level of an
 * eight-bit or a half-float colour texture's, as writes, clears and copies
 * move them -- in queue order, so a copy encoded before a submit sees the
 * write the queue took in between. A draw puts nothing in a texture; what a draw would paint is the
 * reference rasteriser's to say.
 */

import { toHalf } from '../../d3d9/half.js';

/** Bytes per pixel of the formats whose texels are kept, by name. */
const KEPT_FORMATS = /** @type {Record<string, number>} */ ({
    bgra8unorm: 4,
    rgba8unorm: 4,
    r16float: 2,
    rg16float: 4,
    rgba16float: 8,
    r32float: 4,
    rg32float: 8,
    rgba32float: 16,
});

/** The channels a half-float format has, red first. @type {Record<string, number>} */
const HALF_CHANNELS = { r16float: 1, rg16float: 2, rgba16float: 4 };
/** The channels a 32-bit float format has, red first. @type {Record<string, number>} */
const FLOAT_CHANNELS = { r32float: 1, rg32float: 2, rgba32float: 4 };

/**
 * `bytes` filled with `pixel` over and over: the first pixel set, then what is
 * filled copied onto the rest, doubling. A pixel a call, a frame of a game
 * clearing its shadow maps and its HDR targets kept the fake's worker busy
 * for longer than the engine ran, and the engine waited on it.
 *
 * @param {Uint8Array} bytes @param {ArrayLike<number>} pixel
 */
export function fillWith(bytes, pixel){
    const length = bytes.length - bytes.length % pixel.length;
    if (length === 0)
    {
        return;
    }
    bytes.set(pixel, 0);
    for (let filled = pixel.length; filled < length; filled *= 2)
    {
        bytes.copyWithin(filled, 0, Math.min(filled, length - filled));
    }
}

/**
 * WebGPU's validation of what a renderer makes, kept here so that what a real
 * device refuses -- and with a pipeline refused, every frame it is set in --
 * a test refuses too. Each rule is one a program's Direct3D or OpenGL state
 * reached and lost frames on a GPU before this double knew it: a min or max
 * blend with factors not one, a stencil test over a format with no stencil,
 * a vertex format WebGPU has not, a target it does not render into.
 * From the WebGPU specification (vertex formats; texture format capabilities;
 * createRenderPipeline's validation) and its default limits.
 */
const VERTEX_FORMATS = new Set(['uint8', 'uint8x2', 'uint8x4', 'sint8', 'sint8x2', 'sint8x4',
    'unorm8', 'unorm8x2', 'unorm8x4', 'snorm8', 'snorm8x2', 'snorm8x4', 'uint16', 'uint16x2',
    'uint16x4', 'sint16', 'sint16x2', 'sint16x4', 'unorm16', 'unorm16x2', 'unorm16x4', 'snorm16',
    'snorm16x2', 'snorm16x4', 'float16', 'float16x2', 'float16x4', 'float32', 'float32x2',
    'float32x3', 'float32x4', 'uint32', 'uint32x2', 'uint32x3', 'uint32x4', 'sint32', 'sint32x2',
    'sint32x3', 'sint32x4', 'unorm10-10-10-2', 'unorm8x4-bgra']);

/** @param {string} format a vertex format @returns {number} its bytes */
const vertexBytes = format=>{
    if (format === 'unorm10-10-10-2' || format === 'unorm8x4-bgra')
    {
        return 4;
    }
    const [, bits, count] = /(\d+)(?:x(\d))?$/.exec(format) ?? [];
    return Number(bits) / 8 * Number(count ?? 1);
};

/** Colour formats core WebGPU renders into. */
const RENDERABLE = new Set(['r8unorm', 'r8uint', 'r8sint', 'rg8unorm', 'rg8uint', 'rg8sint',
    'rgba8unorm', 'rgba8unorm-srgb', 'rgba8uint', 'rgba8sint', 'bgra8unorm', 'bgra8unorm-srgb',
    'r16uint', 'r16sint', 'r16float', 'rg16uint', 'rg16sint', 'rg16float', 'rgba16uint',
    'rgba16sint', 'rgba16float', 'r32uint', 'r32sint', 'r32float', 'rg32uint', 'rg32sint',
    'rg32float', 'rgba32uint', 'rgba32sint', 'rgba32float', 'rgb10a2uint', 'rgb10a2unorm']);
/** Those it renders into only with `texture-formats-tier1`, rg11b10ufloat with its own feature too. */
const TIER1_RENDERABLE = new Set(['r8snorm', 'rg8snorm', 'rgba8snorm', 'r16unorm', 'rg16unorm',
    'rgba16unorm', 'r16snorm', 'rg16snorm', 'rgba16snorm', 'rg11b10ufloat']);
/** Formats a device has only with `texture-formats-tier1`. */
const TIER1_FORMATS = new Set(['r16unorm', 'rg16unorm', 'rgba16unorm', 'r16snorm', 'rg16snorm',
    'rgba16snorm']);
/** Colour formats blended into: core, and the 32-bit floats with `float32-blendable`. */
const BLENDED = new Set(['r8unorm', 'rg8unorm', 'rgba8unorm', 'rgba8unorm-srgb', 'bgra8unorm',
    'bgra8unorm-srgb', 'r16float', 'rg16float', 'rgba16float', 'rgb10a2unorm']);
const TIER1_BLENDED = new Set(['r8snorm', 'rg8snorm', 'rgba8snorm', 'r16unorm', 'rg16unorm',
    'rgba16unorm', 'r16snorm', 'rg16snorm', 'rgba16snorm', 'rg11b10ufloat']);
const FLOAT32 = new Set(['r32float', 'rg32float', 'rgba32float']);
const STENCIL_FORMATS = new Set(['stencil8', 'depth24plus-stencil8', 'depth32float-stencil8']);
/** GPUTextureUsage.RENDER_ATTACHMENT. */
const RENDER_ATTACHMENT = 0x10;

/**
 * Why WebGPU refuses a colour format as a render target on a device with
 * `features`, or null.
 *
 * @param {string} format @param {Set<string>} features
 */
const unrenderable = (format, features)=>{
    if (RENDERABLE.has(format))
    {
        return null;
    }
    const tier1 = features.has('texture-formats-tier1');
    if (TIER1_RENDERABLE.has(format) && (tier1 || (format === 'rg11b10ufloat'
        && features.has('rg11b10ufloat-renderable'))))
    {
        return null;
    }
    return `${format} is not a renderable format on this device`;
};

/** WebGPU's default limits on a texture's size, what a device has unless made with more. */
export const DEFAULT_LIMITS = Object.freeze({ maxTextureDimension1D: 8192,
    maxTextureDimension2D: 8192, maxTextureDimension3D: 2048, maxTextureArrayLayers: 256 });

/**
 * Why a texture of this size is past a device's limits, or null.
 *
 * @param {string} dimension
 * @param {{ width: number, height: number, depthOrArrayLayers: number }} size
 * @param {Record<string, number>} limits
 */
function sizeRefusal(dimension, size, limits){
    const [largest, layers] = dimension === '1d'
        ? [limits.maxTextureDimension1D, 1]
        : dimension === '3d'
            ? [limits.maxTextureDimension3D, limits.maxTextureDimension3D]
            : [limits.maxTextureDimension2D, limits.maxTextureArrayLayers];
    if (Math.max(size.width, size.height) > largest || size.depthOrArrayLayers > layers)
    {
        return `${size.width}x${size.height}x${size.depthOrArrayLayers} (${dimension})`
            + ` exceeds the device's ${largest} a side and ${layers} layers`;
    }
    return null;
}

/**
 * Why WebGPU refuses a texture descriptor, or null.
 *
 * @param {any} descriptor @param {Set<string>} features
 * @param {Record<string, number>} [limits]
 */
export function textureRefusal(descriptor, features, limits = DEFAULT_LIMITS){
    const { format } = descriptor;
    const size = Array.isArray(descriptor.size)
        ? { width: descriptor.size[0], height: descriptor.size[1] ?? 1,
            depthOrArrayLayers: descriptor.size[2] ?? 1 }
        : { height: 1, depthOrArrayLayers: 1, ...descriptor.size };
    const tooLarge = sizeRefusal(descriptor.dimension ?? '2d', size, limits);
    if (tooLarge)
    {
        return tooLarge;
    }
    if (TIER1_FORMATS.has(format) && !features.has('texture-formats-tier1'))
    {
        return `${format} needs texture-formats-tier1`;
    }
    if (((descriptor.usage ?? 0) & RENDER_ATTACHMENT) !== 0 && !/depth|stencil/.test(format))
    {
        return unrenderable(format, features);
    }
    return null;
}

/**
 * Why WebGPU refuses a render pipeline descriptor, or null.
 *
 * @param {any} descriptor @param {Set<string>} features
 */
export function pipelineRefusal(descriptor, features){
    const buffers = (descriptor.vertex?.buffers ?? []).filter(Boolean);
    if (buffers.length > 8)
    {
        return `${buffers.length} vertex buffers, past the limit of 8`;
    }
    let attributes = 0;
    for (const buffer of buffers)
    {
        const stride = buffer.arrayStride ?? 0;
        if (stride % 4 !== 0 || stride > 2048)
        {
            return `a vertex buffer stride of ${stride}`;
        }
        for (const attribute of buffer.attributes ?? [])
        {
            attributes++;
            if (!VERTEX_FORMATS.has(attribute.format))
            {
                return `vertex format ${attribute.format} does not exist`;
            }
            if (stride > 0 && attribute.offset + vertexBytes(attribute.format) > stride)
            {
                return `a ${attribute.format} at ${attribute.offset} past a stride of ${stride}`;
            }
        }
    }
    if (attributes > 16)
    {
        return `${attributes} vertex attributes, past the limit of 16`;
    }
    const targets = (descriptor.fragment?.targets ?? []).filter(Boolean);
    if (targets.length > 8)
    {
        return `${targets.length} colour targets, past the limit of 8`;
    }
    for (const target of targets)
    {
        const refused = unrenderable(target.format, features);
        if (refused)
        {
            return refused;
        }
        const blend = target.blend;
        if (!blend)
        {
            continue;
        }
        const blended = BLENDED.has(target.format)
            || (TIER1_BLENDED.has(target.format) && features.has('texture-formats-tier1'))
            || (FLOAT32.has(target.format) && features.has('float32-blendable'));
        if (!blended)
        {
            return `${target.format} is not blendable on this device`;
        }
        for (const part of [blend.color, blend.alpha])
        {
            if ((part?.operation === 'min' || part?.operation === 'max')
                && ((part.srcFactor ?? 'one') !== 'one' || (part.dstFactor ?? 'zero') !== 'one'))
            {
                return `a ${part.operation} blend with factors ${part.srcFactor},`
                    + ` ${part.dstFactor}`;
            }
        }
    }
    const depth = descriptor.depthStencil;
    if (depth && !STENCIL_FORMATS.has(depth.format))
    {
        for (const face of [depth.stencilFront, depth.stencilBack])
        {
            if (face && ((face.compare ?? 'always') !== 'always'
                || [face.failOp, face.depthFailOp, face.passOp]
                    .some(op=>(op ?? 'keep') !== 'keep')))
            {
                return `a stencil test over ${depth.format}, which has no stencil`;
            }
        }
    }
    return null;
}

/**
 * @param {{ compilationMessages?: Record<string, any[]>,
 *           refusePipeline?: (descriptor: any) => string | null | undefined,
 *           occlusionSamples?: (index: number) => number,
 *           workDone?: boolean, features?: string[], pipelineDelayMs?: number,
 *           quiet?: boolean, limits?: Record<string, number> }} [options]
 *        `occlusionSamples` is what the occlusion query at each slot of a query
 *        set resolves to, standing in for the rasteriser; zero when absent.
 *        `workDone` gives the queue an `onSubmittedWorkDone` whose answers the
 *        test decides: the device finishes submits, in order, only when told
 *        to (`finish`). Without it the queue has none, as a double that
 *        cannot say when anything is done should not pretend to.
 *        `features` are the optional features the device says it was made with,
 *        `limits` the limits it was made with past WebGPU's defaults.
 *        `quiet` keeps no log of calls and does no more per call than a
 *        device that renders must: what a buffer or texture holds is still
 *        kept, so read-backs answer, but nothing a test would look at. For a
 *        run that measures the engine over it (`--fake-gpu`, the replay of a
 *        capture), where the log's copies and records were a third of the
 *        played side's time.
 */
export function createFakeDevice(options = {}){
    const quiet = options.quiet === true;
    /**
     * What a renderer asked of the device, counted however quiet: draws, bind
     * groups set, and what the queue was handed to copy.
     */
    const stats = { draws: 0, bindGroups: 0, writes: 0, written: 0, textureWrites: 0,
        texels: 0, submits: 0 };
    /** @type {any[]} */
    const calls = [];
    if (quiet)
    {
        // Every site below logs through this; quiet, it keeps nothing.
        calls.push = ()=>0;
    }
    /** Submits made, and how many of them the device has finished. */
    const work = { submitted: 0, finished: 0 };
    /** @type {{ mark: number, resolve: () => void }[]} answers owed, oldest first */
    const workWaiters = [];
    const messages = /** @type {Record<string, any[]>} */ (options.compilationMessages || {});
    /**
     * What a real device would have reported as validation errors, oldest
     * first: the one rule kept here is the one a draw breaks without any other
     * sign, a texture sampled in a pass that also renders into it, which makes
     * the encoder's whole command buffer invalid and its submit do nothing.
     * Each is also dispatched as an `uncapturederror`, as a device does.
     *
     * @type {string[]}
     */
    const errors = [];
    /** @type {((event: any) => void)[]} */
    const errorListeners = [];
    /** @param {string} message */
    const refuse = message=>{
        errors.push(message);
        for (const listener of errorListeners)
        {
            listener({ error: { message } });
        }
    };
    let nextId = 0;
    /** The optional features the device was made with. */
    const features = new Set(options.features ?? []);
    /** The limits the device was made with: WebGPU's defaults unless a test raises them. */
    const limits = Object.freeze({ ...DEFAULT_LIMITS, ...options.limits });

    /** @param {string} kind @param {any} extra @returns {any} */
    const object = (kind, extra = {})=>({ kind, id: `${kind}-${nextId++}`, ...extra });

    /**
     * A GPUExtent3D as WebGPU takes it, a dictionary or a sequence, as the
     * dictionary.
     *
     * @param {any} size @returns {{ width: number, height: number }}
     */
    const extentOf = size=>(Array.isArray(size)
        ? { width: size[0], height: size[1] ?? 1 }
        : { width: size.width, height: size.height ?? 1 });

    /** @param {any} descriptor */
    const createTexture = descriptor=>{
        const textureRefused = textureRefusal(descriptor, features, limits);
        if (textureRefused)
        {
            refuse(`createTexture: ${textureRefused}`);
        }
        // What a GPUTexture says of itself, read by whoever decides how to use one.
        const texture = object('texture', { descriptor, usage: descriptor.usage ?? 0,
            format: descriptor.format, sampleCount: descriptor.sampleCount ?? 1 });
        const kept = KEPT_FORMATS[descriptor.format];
        if (kept)
        {
            const { width, height } = extentOf(descriptor.size);
            texture.extent = { width, height };
            texture.bytes = new Uint8Array(width * height * kept);
            texture.bytesPerPixel = kept;
        }
        texture.createView = (/** @type {any} */ viewDescriptor)=>{
            const view = object('view', { texture, viewDescriptor });
            calls.push({ op: 'createView', texture, view });
            return view;
        };
        texture.destroy = ()=>{
            calls.push({ op: 'destroyTexture', texture });
        };
        calls.push({ op: 'createTexture', texture, descriptor });
        return texture;
    };

    /**
     * A row-by-row move between the kept bytes of textures and buffers. A
     * texture is addressed at its top level only; a copy that names another
     * level moves nothing, which is what a double that keeps no chain can say.
     *
     * @param {{ texture?: any, buffer?: any, origin?: any, mipLevel?: number,
     *           offset?: number, bytesPerRow?: number }} from
     * @param {{ texture?: any, buffer?: any, origin?: any, mipLevel?: number,
     *           offset?: number, bytesPerRow?: number }} to
     * @param {{ width: number, height: number }} size
     */
    const moveTexels = (from, to, size)=>{
        /** @param {any} side */
        const rowOf = side=>{
            if (side.texture)
            {
                const texture = side.texture;
                if (!texture.bytes || (side.mipLevel ?? 0) !== 0)
                {
                    return null;
                }
                const pitch = texture.extent.width * texture.bytesPerPixel;
                const x = side.origin?.x ?? 0;
                const y = side.origin?.y ?? 0;
                return { bytes: texture.bytes, pitch, at: y * pitch + x * texture.bytesPerPixel,
                    bytesPerPixel: texture.bytesPerPixel };
            }
            return { bytes: side.buffer.bytes, pitch: side.bytesPerRow ?? 0,
                at: side.offset ?? 0, bytesPerPixel: 0 };
        };
        const source = rowOf(from);
        const destination = rowOf(to);
        if (!source || !destination)
        {
            return;
        }
        const { width, height } = extentOf(size);
        const rowBytes = width * (source.bytesPerPixel || destination.bytesPerPixel);
        for (let row = 0; row < height; row++)
        {
            const start = source.at + row * source.pitch;
            destination.bytes.set(source.bytes.subarray(start, start + rowBytes),
                destination.at + row * destination.pitch);
        }
    };

    /**
     * The mip levels and array layers a view reaches, as WebGPU defaults them:
     * from its base to the texture's last.
     *
     * @param {any} view
     */
    const rangeOf = view=>{
        const made = view.texture.descriptor ?? {};
        const asked = view.viewDescriptor ?? {};
        const level = asked.baseMipLevel ?? 0;
        const layer = asked.baseArrayLayer ?? 0;
        const layers = made.size?.depthOrArrayLayers ?? made.size?.[2] ?? 1;
        return {
            level, levels: asked.mipLevelCount ?? (made.mipLevelCount ?? 1) - level,
            layer, layers: asked.arrayLayerCount ?? layers - layer,
        };
    };

    /** Whether two views of a texture share a subresource. @param {any} a @param {any} b */
    const overlaps = (a, b)=>{
        if (a.texture !== b.texture)
        {
            return false;
        }
        const one = rangeOf(a);
        const other = rangeOf(b);
        return one.level < other.level + other.levels && other.level < one.level + one.levels
            && one.layer < other.layer + other.layers && other.layer < one.layer + one.layers;
    };

    /**
     * @param {any} descriptor
     * @param {(() => void)[]} deferred  the encoder's, run at submit
     * @param {any} encoder
     */
    const beginRenderPass = (descriptor, deferred, encoder)=>{
        const pass = object('pass', { descriptor });
        // The levels and layers this pass writes: a bind group whose view
        // reaches one of them uses it both ways in one synchronisation scope.
        // WebGPU tells them apart by subresource, so a pass that draws a level
        // from the one above it is not this.
        // A depth attachment read-only in every aspect it has is read, not
        // written, and may be sampled in the same pass.
        const depthAttachment = descriptor.depthStencilAttachment;
        const depthFormat = depthAttachment?.view?.texture?.format ?? '';
        const depthReadOnly = depthAttachment?.depthReadOnly === true;
        const stencilReadOnly = depthAttachment?.stencilReadOnly === true;
        const readOnly = depthReadOnly && (stencilReadOnly || !STENCIL_FORMATS.has(depthFormat));
        const written = [...(descriptor.colorAttachments ?? []), readOnly ? null : depthAttachment]
            .map(attachment=>attachment?.view).filter(view=>view?.texture);
        // A read-only aspect takes no load or store operation.
        if (((depthReadOnly && (depthAttachment.depthLoadOp || depthAttachment.depthStoreOp))
            || (stencilReadOnly && (depthAttachment.stencilLoadOp
                || depthAttachment.stencilStoreOp))) && !encoder.invalid)
        {
            encoder.invalid = true;
            refuse('A read-only depth or stencil aspect is given a load or store operation.');
        }
        // Every attachment one size, as WebGPU refuses the frame otherwise.
        const sizes = written.filter(view=>view.texture.descriptor?.size).map(view=>{
            const { width, height } = extentOf(view.texture.descriptor.size);
            const level = view.viewDescriptor?.baseMipLevel ?? 0;
            return `${Math.max(1, width >> level)}x${Math.max(1, height >> level)}`;
        });
        if (new Set(sizes).size > 1 && !encoder.invalid)
        {
            encoder.invalid = true;
            refuse(`Attachments of different sizes (${sizes.join(', ')}) in one pass.`);
        }
        for (const attachment of descriptor.colorAttachments ?? [])
        {
            // A location left empty is a null, as WebGPU takes it.
            const texture = attachment?.view?.texture;
            if (attachment?.loadOp === 'clear' && texture?.bytes)
            {
                const value = attachment.clearValue ?? { r: 0, g: 0, b: 0, a: 1 };
                /** @param {number} channel */
                const byte = channel=>Math.round(Math.max(0, Math.min(1, channel)) * 255);
                const halves = HALF_CHANNELS[texture.format];
                const floats = FLOAT_CHANNELS[texture.format];
                const pixel = halves
                    ? new Uint8Array(Uint16Array.from([value.r, value.g, value.b, value.a]
                        .slice(0, halves), toHalf).buffer)
                    : floats
                        ? new Uint8Array(Float32Array.from([value.r, value.g, value.b, value.a]
                            .slice(0, floats)).buffer)
                        : texture.format === 'bgra8unorm'
                            ? [byte(value.b), byte(value.g), byte(value.r), byte(value.a)]
                            : [byte(value.r), byte(value.g), byte(value.b), byte(value.a)];
                deferred.push(()=>fillWith(texture.bytes, pixel));
            }
        }
        /** @type {(op: string, args: any) => void} */
        const record = quiet ? ()=>{} : (op, args)=>{
            calls.push({ op, pass, ...args });
        };
        pass.setViewport = (/** @type {number[]} */ ...rect)=>record('setViewport', { rect });
        pass.setScissorRect = (/** @type {number[]} */ ...rect)=>record('setScissorRect', { rect });
        pass.setStencilReference = (/** @type {number} */ reference)=>
            record('setStencilReference', { reference });
        pass.setBlendConstant = (/** @type {any} */ color)=>record('setBlendConstant', { color });
        pass.beginOcclusionQuery = (/** @type {number} */ index)=>
            record('beginOcclusionQuery', { index });
        pass.endOcclusionQuery = ()=>record('endOcclusionQuery', {});
        /** The pipeline set, and the vertex slots given a buffer. @type {any} */
        let bound = null;
        /** @type {Set<number>} */
        const vertexSlots = new Set();
        pass.setPipeline = (/** @type {any} */ pipeline)=>{
            bound = pipeline;
            const stencil = pipeline?.descriptor?.depthStencil;
            const writesStencil = (stencil?.stencilWriteMask ?? 0xffffffff) !== 0
                && [stencil?.stencilFront, stencil?.stencilBack].some(face=>face
                    && [face.failOp, face.depthFailOp, face.passOp]
                        .some(op=>op !== undefined && op !== 'keep'));
            if (((depthReadOnly && stencil?.depthWriteEnabled)
                || (stencilReadOnly && writesStencil)) && !encoder.invalid)
            {
                encoder.invalid = true;
                refuse('The pipeline writes a depth or stencil aspect the pass has read-only.');
            }
            record('setPipeline', { pipeline });
        };
        // WebGPU's rule a renderer has to keep: every vertex buffer slot the
        // pipeline reads has a buffer set before the draw, which a real
        // device refuses the frame over and this one refuses too.
        const slotsSet = ()=>{
            const wanted = bound?.descriptor?.vertex?.buffers?.length ?? 0;
            for (let slot = 0; slot < wanted; slot++)
            {
                if (!vertexSlots.has(slot) && !encoder.invalid)
                {
                    encoder.invalid = true;
                    refuse(`Vertex buffer slot ${slot} required by the pipeline was not set.`);
                }
            }
        };
        // A dynamic binding resolves to the byte range the shader would read:
        // the offsets arrive in binding order, and the resource names the
        // buffer and the block's declared size. Recording that, not only the
        // call, is what lets a test check the bytes a draw was given -- as the
        // buffer holds them once the frame is submitted.
        /**
         * @param {number} index
         * @param {any} group
         * @param {number[] | undefined} offsets
         */
        pass.setBindGroup = (index, group, offsets)=>{
            stats.bindGroups++;
            const both =/** @type {any[]} */ (group?.entries ?? [])
                .find(entry=>entry.resource?.texture && written.some(view=>
                    overlaps(view, entry.resource)));
            if (both && !encoder.invalid)
            {
                encoder.invalid = true;
                refuse(`[Texture "${both.resource.texture.descriptor?.label ?? ''}"] usage`
                    + ' (TextureBinding|RenderAttachment) includes writable usage and another'
                    + ' usage in the same synchronization scope.');
            }
            if (quiet)
            {
                return;
            }
            const dynamic =/** @type {any[]} */ (group?.entries ?? [])
                .filter(entry=>entry.resource && entry.resource.buffer)
                .sort((left, right)=>left.binding - right.binding);
            const resolved = dynamic.map((entry, k)=>{
                const resource = entry.resource;
                const at = (offsets === undefined ? 0 : offsets[k]) + (resource.offset ?? 0);
                const size = resource.size === undefined
                    ? resource.buffer.descriptor.size : resource.size;
                // Read when asked, not now: the bytes reach the buffer at the
                // frame's submit, after the draws that name them are recorded.
                return {
                    binding: entry.binding, buffer: resource.buffer, offset: at, size,
                    get range(){
                        return resource.buffer.bytes
                            ? resource.buffer.bytes.slice(at, at + size) : null;
                    },
                };
            });
            // Copied, as a device copies them: the caller may write the
            // same array again for its next draw.
            record('setBindGroup', { index, group, offsets: offsets && [...offsets], resolved });
        };
        /** @param {number} slot @param {any} buffer @param {number} offset */
        pass.setVertexBuffer = (slot, buffer, offset)=>{
            vertexSlots.add(slot);
            record('setVertexBuffer', { slot, buffer, offset });
        };
        pass.setIndexBuffer = (/** @type {any} */ buffer, /** @type {string} */ format,
            /** @type {number} */ offset)=>record('setIndexBuffer', { buffer, format, offset });
        pass.draw = (/** @type {number[]} */ ...args)=>{
            stats.draws++;
            slotsSet();
            record('draw', { args });
        };
        pass.drawIndexed = (/** @type {number[]} */ ...args)=>{
            stats.draws++;
            slotsSet();
            record('drawIndexed', { args });
        };
        pass.drawIndirect = (/** @type {any} */ buffer, /** @type {number} */ offset)=>{
            stats.draws++;
            slotsSet();
            record('drawIndirect', { buffer, offset });
        };
        pass.drawIndexedIndirect = (/** @type {any} */ buffer, /** @type {number} */ offset)=>{
            stats.draws++;
            slotsSet();
            record('drawIndexedIndirect', { buffer, offset });
        };
        pass.end = ()=>record('endPass', {});
        calls.push({ op: 'beginRenderPass', pass, descriptor });
        return pass;
    };

    /** @param {any} descriptor */
    const createCommandEncoder = (descriptor = {})=>{
        const encoder = object('encoder', { descriptor });
        // A copy lands when its command buffer is submitted, not when it is
        // encoded: a write the queue takes between the two is seen by the copy,
        // which is the ordering a read-back at the end of a frame relies on.
        /** @type {(() => void)[]} */
        const deferred = [];
        encoder.beginRenderPass = (/** @type {any} */ passDescriptor)=>
            beginRenderPass(passDescriptor, deferred, encoder);
        /** @param {any} source @param {any} destination @param {any} size */
        encoder.copyBufferToTexture = (source, destination, size)=>{
            deferred.push(()=>moveTexels(source, destination, size));
            calls.push({ op: 'copyBufferToTexture', encoder, source, destination, size });
        };
        /** A compute pass: its pipeline, its group, and its grid, recorded. @param {any} label */
        encoder.beginComputePass = label=>{
            const pass = object('computePass', { descriptor: label });
            /** @type {any} */
            let pipeline = null;
            /** @type {any} */
            let group = null;
            /** @type {any[]} every group, by its number */
            const groups = [];
            pass.setPipeline = (/** @type {any} */ next)=>{
                pipeline = next;
            };
            pass.setBindGroup = (/** @type {number} */ index, /** @type {any} */ next)=>{
                groups[index] = next;
                group = groups[0] ?? next;
            };
            pass.dispatchWorkgroups = (/** @type {number[]} */ ...grid)=>{
                calls.push({ op: 'dispatchWorkgroups', encoder, pipeline, group,
                    groups: [...groups], grid });
            };
            /** @param {any} buffer @param {number} offset */
            pass.dispatchWorkgroupsIndirect = (buffer, offset)=>{
                calls.push({ op: 'dispatchWorkgroups', encoder, pipeline, group,
                    groups: [...groups], indirect: { buffer, offset } });
            };
            pass.end = ()=>{};
            return pass;
        };
        /**
         * @param {any} source @param {number} sourceOffset @param {any} destination
         * @param {number} destinationOffset @param {number} size
         */
        encoder.copyBufferToBuffer = (source, sourceOffset, destination, destinationOffset, size)=>{
            deferred.push(()=>destination.bytes.set(
                source.bytes.subarray(sourceOffset, sourceOffset + size), destinationOffset));
            calls.push({ op: 'copyBufferToBuffer', encoder, source, sourceOffset,
                destination, destinationOffset, size });
        };
        /** @param {any} source @param {any} destination @param {any} size */
        encoder.copyTextureToBuffer = (source, destination, size)=>{
            deferred.push(()=>moveTexels(source, destination, size));
            calls.push({ op: 'copyTextureToBuffer', encoder, source, destination, size });
        };
        /**
         * @param {any} querySet @param {number} firstQuery @param {number} queryCount
         * @param {any} destination @param {number} at
         */
        encoder.resolveQuerySet = (querySet, firstQuery, queryCount, destination, at)=>{
            const destinationOffset = at;
            deferred.push(()=>{
                const view = new DataView(destination.bytes.buffer);
                for (let index = 0; index < queryCount; index++)
                {
                    view.setBigUint64(destinationOffset + index * 8,
                        BigInt(options.occlusionSamples?.(firstQuery + index) ?? 0), true);
                }
            });
            calls.push({ op: 'resolveQuerySet', encoder, querySet, firstQuery, queryCount,
                destination, destinationOffset });
        };
        /** @param {any} source @param {any} destination @param {any} size */
        encoder.copyTextureToTexture = (source, destination, size)=>{
            deferred.push(()=>moveTexels(source, destination, size));
            calls.push({ op: 'copyTextureToTexture', encoder, source, destination, size });
        };
        encoder.finish = ()=>{
            const buffer = object('commandBuffer', { encoder, deferred });
            calls.push({ op: 'finish', encoder, buffer });
            return buffer;
        };
        calls.push({ op: 'createCommandEncoder', encoder, descriptor });
        return encoder;
    };

    /** @param {any} descriptor */
    const createShaderModule = descriptor=>{
        const module = object('shaderModule', { descriptor });
        module.getCompilationInfo = async()=>{
            calls.push({ op: 'getCompilationInfo', module });
            return { messages: messages[descriptor.label] || [] };
        };
        calls.push({ op: 'createShaderModule', module, descriptor });
        return module;
    };

    /** @param {string} op */
    const recorder = op=>(/** @type {any} */ descriptor)=>{
        const made = object(op, { descriptor });
        calls.push({ op, [op]: made, descriptor });
        return made;
    };

    /**
     * A buffer holds its bytes, so that what a queue wrote and an encoder
     * copied can be mapped and read back the way a real one is.
     *
     * @param {any} descriptor
     */
    const createBuffer = descriptor=>{
        const buffer = object('createBuffer',
            { descriptor, bytes: new Uint8Array(descriptor.size) });
        buffer.mapAsync = async()=>{
            calls.push({ op: 'mapAsync', buffer });
        };
        buffer.getMappedRange = ()=>buffer.bytes.buffer;
        buffer.unmap = ()=>{};
        buffer.destroy = ()=>{
            calls.push({ op: 'destroy', buffer });
        };
        calls.push({ op: 'createBuffer', createBuffer: buffer, descriptor });
        return buffer;
    };

    const device = {
        calls,
        features,
        limits,
        /** @param {string} type @param {(event: any) => void} listener */
        addEventListener(type, listener){
            if (type === 'uncapturederror')
            {
                errorListeners.push(listener);
            }
        },
        createTexture,
        createCommandEncoder,
        createShaderModule,
        createBuffer,
        createBindGroupLayout: recorder('createBindGroupLayout'),
        /** @param {any} descriptor */
        createQuerySet: descriptor=>{
            const querySet = object('createQuerySet', { descriptor });
            querySet.destroy = ()=>{
                calls.push({ op: 'destroyQuerySet', querySet });
            };
            calls.push({ op: 'createQuerySet', createQuerySet: querySet, descriptor });
            return querySet;
        },
        createPipelineLayout: recorder('createPipelineLayout'),
        /** @param {any} descriptor */
        createBindGroup: descriptor=>{
            // WebGPU's rule a renderer has to keep: a buffer binding is no
            // smaller than its layout says the shader reads. A real device
            // refuses the frame the group is used in; this one refuses the
            // call, so a test cannot pass over it.
            for (const entry of descriptor.entries ?? [])
            {
                const declared = descriptor.layout?.descriptor?.entries?.find(
                    (/** @type {any} */ one)=>one.binding === entry.binding)?.buffer
                    ?.minBindingSize ?? 0;
                const buffer = entry.resource?.buffer;
                const size = entry.resource?.size
                    ?? (buffer ? (buffer.descriptor?.size ?? 0) - (entry.resource.offset ?? 0) : 0);
                if (buffer && size < declared)
                {
                    throw new Error(`a buffer bound with size ${size} at binding ${entry.binding}`
                        + ` is too small: the layout reads ${declared}`);
                }
            }
            const group = object('createBindGroup', {
                descriptor, entries: descriptor.entries,
            });
            calls.push({ op: 'createBindGroup', createBindGroup: group, descriptor });
            return group;
        },
        /** @param {any} descriptor */
        createRenderPipeline: descriptor=>{
            const refused = pipelineRefusal(descriptor, features);
            if (refused)
            {
                refuse(`createRenderPipeline: ${refused}`);
            }
            return recorder('createRenderPipeline')(descriptor);
        },
        /** @param {any} descriptor */
        createComputePipelineAsync: async descriptor=>{
            const made = object('createComputePipeline', { descriptor });
            calls.push({ op: 'createComputePipeline', createComputePipeline: made, descriptor });
            return made;
        },
        // Recorded under the same name, so a test counts pipelines one way.
        // `options.refusePipeline` names the validation message a descriptor
        // is refused with, for a test of a build that fails;
        // `options.pipelineDelayMs` how long a build takes, as a GPU that
        // compiles the pipeline's shaders does.
        /** @param {any} descriptor */
        createRenderPipelineAsync: descriptor=>{
            const refused = options.refusePipeline?.(descriptor)
                ?? pipelineRefusal(descriptor, features);
            if (refused)
            {
                return Promise.reject(new Error(refused));
            }
            const made = recorder('createRenderPipeline')(descriptor);
            return (options.pipelineDelayMs ?? 0) > 0
                ? new Promise(resolve=>setTimeout(()=>resolve(made), options.pipelineDelayMs))
                : Promise.resolve(made);
        },
    };

    const queue = {
        /**
         * The copy matters: the backend hands over a live view on its shadow copy,
         * and a later write through that view must not rewrite history here.
         *
         * @param {any} buffer @param {number} bufferOffset @param {any} data
         * @param {number} [dataOffset] @param {number} [size]
         */
        writeBuffer(buffer, bufferOffset, data, dataOffset = 0, size = undefined){
            const length = size === undefined ? data.byteLength - dataOffset : size;
            stats.writes++;
            stats.written += length;
            if (quiet)
            {
                // One copy, as a device makes of what it is handed.
                buffer.bytes?.set(ArrayBuffer.isView(data)
                    ? new Uint8Array(data.buffer, data.byteOffset + dataOffset, length)
                    : new Uint8Array(data, dataOffset, length), bufferOffset);
                return;
            }
            if (buffer.bytes)
            {
                buffer.bytes.set(
                    Uint8Array.prototype.slice.call(data, dataOffset, dataOffset + length),
                    bufferOffset);
            }
            calls.push({
                op: 'writeBuffer',
                buffer,
                bufferOffset,
                dataOffset,
                size: length,
                bytes: Uint8Array.prototype.slice.call(data, dataOffset, dataOffset + length),
            });
        },
        /**
         * @param {any} destination @param {any} data @param {any} layout @param {any} size
         */
        writeTexture(destination, data, layout, size){
            stats.textureWrites++;
            stats.texels += data.byteLength;
            if (quiet)
            {
                moveTexels({ buffer: { bytes: ArrayBuffer.isView(data)
                    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
                    : new Uint8Array(data) },
                offset: layout.offset ?? 0, bytesPerRow: layout.bytesPerRow }, destination, size);
                return;
            }
            moveTexels({ buffer: { bytes: Uint8Array.prototype.slice.call(data) },
                offset: layout.offset ?? 0, bytesPerRow: layout.bytesPerRow },
            destination, size);
            calls.push({
                op: 'writeTexture',
                destination,
                layout,
                size,
                bytes: Uint8Array.prototype.slice.call(data),
            });
        },
        /** @param {any[]} buffers */
        submit(buffers){
            stats.submits++;
            for (const buffer of buffers)
            {
                // An invalid command buffer is refused whole, as a device
                // refuses it: none of its copies or clears land.
                if (buffer.encoder?.invalid)
                {
                    refuse('[Invalid CommandBuffer] is invalid.');
                    continue;
                }
                for (const copy of buffer.deferred ?? [])
                {
                    copy();
                }
            }
            calls.push({ op: 'submit', buffers });
            work.submitted++;
        },
    };
    if (options.workDone)
    {
        // Settled once every submit made before the call is finished.
        /** @type {any} */ (queue).onSubmittedWorkDone = ()=>new Promise(resolve=>{
            const mark = work.submitted;
            if (work.finished >= mark)
            {
                resolve(undefined);
                return;
            }
            workWaiters.push({ mark, resolve: ()=>resolve(undefined) });
        });
    }

    /**
     * The canvas the presenter configures and copies into. Recorded like the
     * device, so "the canvas was configured once" is a count and not a claim:
     * a presenter handed to two machine lifetimes must configure it on the
     * first frame of the run and never again.
     */
    const screenTexture = object('canvasTexture');
    screenTexture.createView = (/** @type {any} */ viewDescriptor)=>{
        const view = object('view', { texture: screenTexture, viewDescriptor });
        calls.push({ op: 'createView', texture: screenTexture, view });
        return view;
    };
    const canvas = { width: 0, height: 0, getContext: ()=>screen };
    const screen = {
        canvas,
        /** @param {any} descriptor */
        configure(descriptor){
            calls.push({ op: 'configure', descriptor });
            screenTexture.format = descriptor.format;
        },
        getCurrentTexture(){
            calls.push({ op: 'getCurrentTexture' });
            // In a kept format, the canvas keeps its texels too, so what
            // reached the screen can be read: a new size starts a new picture.
            const kept = KEPT_FORMATS[screenTexture.format];
            const extent = screenTexture.extent;
            if (kept && (extent?.width !== canvas.width || extent?.height !== canvas.height))
            {
                screenTexture.extent = { width: canvas.width, height: canvas.height };
                screenTexture.bytes = new Uint8Array(canvas.width * canvas.height * kept);
                screenTexture.bytesPerPixel = kept;
            }
            return screenTexture;
        },
    };

    return {
        device,
        queue,
        calls,
        stats,
        errors,
        screen,
        canvas,
        /** @param {string} op @returns {any[]} */
        of: op=>calls.filter(call=>call.op === op),
        /** @param {string} op @returns {number} */
        count: op=>calls.filter(call=>call.op === op).length,
        reset(){
            calls.length = 0;
        },
        /**
         * The device finishes the oldest `count` submits it has not finished
         * yet, or every one of them, and answers whoever asked after them.
         *
         * @param {number} [count]
         */
        finish(count = Infinity){
            work.finished = Math.min(work.submitted, work.finished + count);
            while (workWaiters.length > 0 && workWaiters[0].mark <= work.finished)
            {
                /** @type {typeof workWaiters[number]} */ (workWaiters.shift()).resolve();
            }
        },
        /** Submits the device has not finished. */
        unfinished: ()=>work.submitted - work.finished,
    };
}
