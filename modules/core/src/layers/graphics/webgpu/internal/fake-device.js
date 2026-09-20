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
 * The one thing it keeps is bytes: a buffer's, and the top level of a
 * four-byte-per-pixel texture's, as writes, clears and copies move them -- in
 * queue order, so a copy encoded before a submit sees the write the queue took
 * in between. A draw puts nothing in a texture; what a draw would paint is the
 * reference rasteriser's to say.
 */

/** Bytes per pixel of the formats whose texels are kept, by name. */
const KEPT_FORMATS = /** @type {Record<string, number>} */ ({
    bgra8unorm: 4,
    rgba8unorm: 4,
});

/**
 * @param {{ compilationMessages?: Record<string, any[]>,
 *           refusePipeline?: (descriptor: any) => string | null | undefined }} [options]
 */
export function createFakeDevice(options = {}){
    /** @type {any[]} */
    const calls = [];
    const messages = /** @type {Record<string, any[]>} */ (options.compilationMessages || {});
    let nextId = 0;

    /** @param {string} kind @param {any} extra @returns {any} */
    const object = (kind, extra = {})=>({ kind, id: `${kind}-${nextId++}`, ...extra });

    /** @param {any} descriptor */
    const createTexture = descriptor=>{
        const texture = object('texture', { descriptor });
        const kept = KEPT_FORMATS[descriptor.format];
        if (kept)
        {
            texture.bytes = new Uint8Array(descriptor.size.width * descriptor.size.height * kept);
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
                const pitch = texture.descriptor.size.width * texture.bytesPerPixel;
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
        const rowBytes = size.width * (source.bytesPerPixel || destination.bytesPerPixel);
        for (let row = 0; row < size.height; row++)
        {
            const start = source.at + row * source.pitch;
            destination.bytes.set(source.bytes.subarray(start, start + rowBytes),
                destination.at + row * destination.pitch);
        }
    };

    /**
     * @param {any} descriptor
     * @param {(() => void)[]} deferred  the encoder's, run at submit
     */
    const beginRenderPass = (descriptor, deferred)=>{
        const pass = object('pass', { descriptor });
        for (const attachment of descriptor.colorAttachments ?? [])
        {
            const texture = attachment.view?.texture;
            if (attachment.loadOp === 'clear' && texture?.bytes)
            {
                const value = attachment.clearValue ?? { r: 0, g: 0, b: 0, a: 1 };
                /** @param {number} channel */
                const byte = channel=>Math.round(Math.max(0, Math.min(1, channel)) * 255);
                const pixel = texture.descriptor.format === 'bgra8unorm'
                    ? [byte(value.b), byte(value.g), byte(value.r), byte(value.a)]
                    : [byte(value.r), byte(value.g), byte(value.b), byte(value.a)];
                deferred.push(()=>{
                    for (let at = 0; at < texture.bytes.length; at += 4)
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
        pass.setPipeline = (/** @type {any} */ pipeline)=>record('setPipeline', { pipeline });
        // A dynamic binding resolves to the byte range the shader would read:
        // the offsets arrive in binding order, and the resource names the
        // buffer and the block's declared size. Recording that, not only the
        // call, is what lets a test check the bytes a draw was given.
        /**
         * @param {number} index
         * @param {any} group
         * @param {number[] | undefined} offsets
         */
        pass.setBindGroup = (index, group, offsets)=>{
            const dynamic = /** @type {any[]} */ (group?.entries ?? [])
                .filter(entry=>entry.resource && entry.resource.buffer)
                .sort((left, right)=>left.binding - right.binding);
            const resolved = dynamic.map((entry, k)=>{
                const resource = entry.resource;
                const at = (offsets === undefined ? 0 : offsets[k]) + (resource.offset ?? 0);
                const size = resource.size === undefined
                    ? resource.buffer.descriptor.size : resource.size;
                const range = resource.buffer.bytes
                    ? resource.buffer.bytes.slice(at, at + size) : null;
                return { binding: entry.binding, buffer: resource.buffer, offset: at, size, range };
            });
            record('setBindGroup', { index, group, offsets, resolved });
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
            beginRenderPass(passDescriptor, deferred);
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
        createTexture,
        createCommandEncoder,
        createShaderModule,
        createBuffer,
        createBindGroupLayout: recorder('createBindGroupLayout'),
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
                for (const copy of buffer.deferred ?? [])
                {
                    copy();
                }
            }
            calls.push({ op: 'submit', buffers });
        },
    };

    /**
     * The canvas the presenter configures and copies into. Recorded like the
     * device, so "the canvas was configured once" is a count and not a claim:
     * a presenter handed to two machine lifetimes must configure it on the
     * first frame of the run and never again.
     */
    const screenTexture = object('canvasTexture');
    const canvas = { width: 0, height: 0, getContext: ()=>screen };
    const screen = {
        canvas,
        /** @param {any} descriptor */
        configure(descriptor){
            calls.push({ op: 'configure', descriptor });
        },
        getCurrentTexture(){
            calls.push({ op: 'getCurrentTexture' });
            return screenTexture;
        },
    };

    return {
        device,
        queue,
        calls,
        screen,
        canvas,
        /** @param {string} op @returns {any[]} */
        of: op=>calls.filter(call=>call.op === op),
        /** @param {string} op @returns {number} */
        count: op=>calls.filter(call=>call.op === op).length,
        reset(){
            calls.length = 0;
        },
    };
}
