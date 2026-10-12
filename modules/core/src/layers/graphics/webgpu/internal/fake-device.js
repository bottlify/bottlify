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
 * @param {{ compilationMessages?: Record<string, any[]>,
 *           refusePipeline?: (descriptor: any) => string | null | undefined,
 *           occlusionSamples?: (index: number) => number,
 *           workDone?: boolean, features?: string[] }} [options]
 *        `occlusionSamples` is what the occlusion query at each slot of a query
 *        set resolves to, standing in for the rasteriser; zero when absent.
 *        `workDone` gives the queue an `onSubmittedWorkDone` whose answers the
 *        test decides: the device finishes submits, in order, only when told
 *        to (`finish`). Without it the queue has none, as a double that
 *        cannot say when anything is done should not pretend to.
 *        `features` are the optional features the device says it was made with.
 */
export function createFakeDevice(options = {}){
    /** @type {any[]} */
    const calls = [];
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
        const written = [...(descriptor.colorAttachments ?? []), descriptor.depthStencilAttachment]
            .map(attachment=>attachment?.view).filter(view=>view?.texture);
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
                deferred.push(()=>{
                    for (let at = 0; at < texture.bytes.length; at += pixel.length)
                    {
                        texture.bytes.set(pixel, at);
                    }
                });
            }
        }
        /** @param {string} op @param {any} args */
        const record = (op, args)=>calls.push({ op, pass, ...args });
        pass.setViewport = (/** @type {number[]} */ ...rect)=>record('setViewport', { rect });
        pass.setScissorRect = (/** @type {number[]} */ ...rect)=>record('setScissorRect', { rect });
        pass.setStencilReference = (/** @type {number} */ reference)=>
            record('setStencilReference', { reference });
        pass.setBlendConstant = (/** @type {any} */ color)=>record('setBlendConstant', { color });
        pass.beginOcclusionQuery = (/** @type {number} */ index)=>
            record('beginOcclusionQuery', { index });
        pass.endOcclusionQuery = ()=>record('endOcclusionQuery', {});
        pass.setPipeline = (/** @type {any} */ pipeline)=>record('setPipeline', { pipeline });
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
            const both = /** @type {any[]} */ (group?.entries ?? [])
                .find(entry=>entry.resource?.texture && written.some(view=>
                    overlaps(view, entry.resource)));
            if (both && !encoder.invalid)
            {
                encoder.invalid = true;
                refuse(`[Texture "${both.resource.texture.descriptor?.label ?? ''}"] usage`
                    + ' (TextureBinding|RenderAttachment) includes writable usage and another'
                    + ' usage in the same synchronization scope.');
            }
            const dynamic = /** @type {any[]} */ (group?.entries ?? [])
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
        pass.setVertexBuffer = (/** @type {number} */ slot, /** @type {any} */ buffer,
            /** @type {number} */ offset)=>record('setVertexBuffer', { slot, buffer, offset });
        pass.setIndexBuffer = (/** @type {any} */ buffer, /** @type {string} */ format,
            /** @type {number} */ offset)=>record('setIndexBuffer', { buffer, format, offset });
        pass.draw = (/** @type {number[]} */ ...args)=>record('draw', { args });
        pass.drawIndexed = (/** @type {number[]} */ ...args)=>record('drawIndexed', { args });
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
        features: new Set(options.features ?? []),
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
            const group = object('createBindGroup', {
                descriptor, entries: descriptor.entries,
            });
            calls.push({ op: 'createBindGroup', createBindGroup: group, descriptor });
            return group;
        },
        createRenderPipeline: recorder('createRenderPipeline'),
        // Recorded under the same name, so a test counts pipelines one way.
        // `options.refusePipeline` names the validation message a descriptor
        // is refused with, for a test of a build that fails.
        /** @param {any} descriptor */
        createRenderPipelineAsync: descriptor=>{
            const refused = options.refusePipeline?.(descriptor);
            if (refused)
            {
                return Promise.reject(new Error(refused));
            }
            return Promise.resolve(recorder('createRenderPipeline')(descriptor));
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
