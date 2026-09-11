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
 */

/**
 * @param {{ compilationMessages?: Record<string, any[]> }} [options]
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
        texture.createView = (/** @type {any} */ viewDescriptor)=>{
            const view = object('view', { texture, viewDescriptor });
            calls.push({ op: 'createView', texture, view });
            return view;
        };
        calls.push({ op: 'createTexture', texture, descriptor });
        return texture;
    };

    /** @param {any} descriptor */
    const beginRenderPass = descriptor=>{
        const pass = object('pass', { descriptor });
        /** @param {string} op @param {any} args */
        const record = (op, args)=>calls.push({ op, pass, ...args });
        pass.setViewport = (/** @type {number[]} */ ...rect)=>record('setViewport', { rect });
        pass.setScissorRect = (/** @type {number[]} */ ...rect)=>record('setScissorRect', { rect });
        pass.setPipeline = (/** @type {any} */ pipeline)=>record('setPipeline', { pipeline });
        pass.setBindGroup = (/** @type {number} */ index, /** @type {any} */ group,
            /** @type {number[] | undefined} */ offsets)=>
            record('setBindGroup', { index, group, offsets });
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
        encoder.beginRenderPass = beginRenderPass;
        encoder.copyBufferToTexture = (/** @type {any} */ source, /** @type {any} */ destination,
            /** @type {any} */ size)=>calls.push(
            { op: 'copyBufferToTexture', encoder, source, destination, size });
        // A copy lands when its command buffer is submitted, not when it is
        // encoded: a write the queue takes between the two is seen by the copy,
        // which is the ordering a read-back at the end of a frame relies on.
        /** @type {(() => void)[]} */
        const deferred = [];
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
        // This device keeps no texels, so a texture read back is zeros of the
        // right size: enough for a caller to be exercised end to end.
        encoder.copyTextureToBuffer = (/** @type {any} */ source, /** @type {any} */ destination,
            /** @type {any} */ size)=>calls.push(
            { op: 'copyTextureToBuffer', encoder, source, destination, size });
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
        buffer.destroy = ()=>{};
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
        createBindGroup: recorder('createBindGroup'),
        createRenderPipeline: recorder('createRenderPipeline'),
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

    return {
        device,
        queue,
        calls,
        /** @param {string} op @returns {any[]} */
        of: op=>calls.filter(call=>call.op === op),
        /** @param {string} op @returns {number} */
        count: op=>calls.filter(call=>call.op === op).length,
        reset(){
            calls.length = 0;
        },
    };
}
