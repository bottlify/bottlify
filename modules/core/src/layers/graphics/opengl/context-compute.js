/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Compute dispatches (OpenGL 4.3 chapter 19, GL_ARB_compute_shader):
 * glDispatchCompute and glDispatchComputeIndirect run the current program's
 * compute stage over a grid of work groups, and the limits that bound them;
 * and what a shader writes to memory: shader storage blocks (4.3 section
 * 7.8, glShaderStorageBlockBinding) and atomic counters (4.2 section 7.7).
 *
 * - **A dispatch is recorded among the draws** (`gpu-compute.js`): the
 *   device runs it after the draws made before it and before those made
 *   after, so what one writes the next reads, as GL orders them.
 * - **The grid's counts are checked against GL_MAX_COMPUTE_WORK_GROUP_COUNT**
 *   for the direct form; an indirect one's are the device's to bound, as
 *   GL leaves them undefined past the limit.
 * - **The limits are WebGPU's** where they are under GL's minimums
 *   (`glsl-link.js` COMPUTE_LIMITS).
 * - **A buffer a shader wrote is read back from the device**: glGetBufferSubData
 *   on one waits, as glReadPixels does, for every command recorded before it
 *   and then for the device's bytes (`gpu.js` readBuffer).
 */

import { GL } from './constants.js';
import { BLOCK_LIMITS, COMPUTE_LIMITS } from './glsl-link.js';
import { GLSL_LIMITS } from './glsl-builtins.js';
import { counterBuffersOf } from './context-glsl.js';
import {
    COUNTER_LIMITS, IMAGE_LIMITS, IMAGE_UNIT_FORMATS, STORAGE_BUFFER_OFFSET_ALIGNMENT,
    STORAGE_LIMITS,
} from './glsl-storage.js';

/** The calls of this file a display list does not record (4.6 compatibility 21.4). */
export const COMPUTE_CALLS_NOT_COMPILED = Object.freeze([
    'glDispatchCompute', 'glDispatchComputeIndirect', 'glShaderStorageBlockBinding',
    'glBindImageTexture', 'glGetActiveAtomicCounterBufferiv',
]);

/**
 * @param {any} context
 * @param {import('./kernel.js').ContextKernel} kernel
 * @param {{ dispatchCompute?: (context: object, request: any, sceneOf: () => any)
 *     => boolean, readBuffer?: (context: object, buffer: any)
 *     => Promise<Uint8Array | null> | null } | null} gpu  the device that runs them
 */
export function installComputeCalls(context, kernel, gpu){
    const { enter, setError, record } = kernel;

    const queries = kernel.side.queries ??= new Map();
    const indexed = /** @type {Map<number, (index: number) => ({ kind: string,
     *     values: number[] } | null)>} */ (kernel.side.indexed ??= new Map());
    /** @param {number} query @param {number} value */
    const answer = (query, value)=>queries.set(query, ()=>({ kind: 'int', values: [value] }));
    answer(GL.MAX_COMPUTE_WORK_GROUP_INVOCATIONS, COMPUTE_LIMITS.invocations);
    answer(GL.MAX_COMPUTE_SHARED_MEMORY_SIZE, COMPUTE_LIMITS.sharedBytes);
    answer(GL.MAX_COMPUTE_UNIFORM_BLOCKS, BLOCK_LIMITS.perStage);
    answer(GL.MAX_COMPUTE_TEXTURE_IMAGE_UNITS, GLSL_LIMITS.textureImageUnits);
    answer(GL.MAX_COMPUTE_UNIFORM_COMPONENTS, GLSL_LIMITS.fragmentUniformComponents);
    answer(GL.MAX_COMBINED_COMPUTE_UNIFORM_COMPONENTS, GLSL_LIMITS.fragmentUniformComponents
        + BLOCK_LIMITS.perStage * BLOCK_LIMITS.size / 4);
    // Storage and counters in the fragment and compute stages alone (`glsl-storage.js`).
    for (const query of [GL.MAX_VERTEX_SHADER_STORAGE_BLOCKS, GL.MAX_GEOMETRY_SHADER_STORAGE_BLOCKS,
        GL.MAX_TESS_CONTROL_SHADER_STORAGE_BLOCKS, GL.MAX_TESS_EVALUATION_SHADER_STORAGE_BLOCKS,
        GL.MAX_VERTEX_ATOMIC_COUNTER_BUFFERS, GL.MAX_GEOMETRY_ATOMIC_COUNTER_BUFFERS,
        GL.MAX_TESS_CONTROL_ATOMIC_COUNTER_BUFFERS, GL.MAX_TESS_EVALUATION_ATOMIC_COUNTER_BUFFERS,
        GL.MAX_VERTEX_ATOMIC_COUNTERS, GL.MAX_GEOMETRY_ATOMIC_COUNTERS,
        GL.MAX_TESS_CONTROL_ATOMIC_COUNTERS, GL.MAX_TESS_EVALUATION_ATOMIC_COUNTERS])
    {
        answer(query, 0);
    }
    for (const query of [GL.MAX_FRAGMENT_SHADER_STORAGE_BLOCKS,
        GL.MAX_COMPUTE_SHADER_STORAGE_BLOCKS])
    {
        answer(query, STORAGE_LIMITS.perStage);
    }
    answer(GL.MAX_COMBINED_SHADER_STORAGE_BLOCKS, STORAGE_LIMITS.combined);
    answer(GL.MAX_SHADER_STORAGE_BUFFER_BINDINGS, STORAGE_LIMITS.bindings);
    answer(GL.MAX_SHADER_STORAGE_BLOCK_SIZE, STORAGE_LIMITS.size);
    answer(GL.SHADER_STORAGE_BUFFER_OFFSET_ALIGNMENT, STORAGE_BUFFER_OFFSET_ALIGNMENT);
    answer(GL.MAX_COMBINED_SHADER_OUTPUT_RESOURCES, STORAGE_LIMITS.combined
        + GLSL_LIMITS.drawBuffers);
    for (const query of [GL.MAX_FRAGMENT_ATOMIC_COUNTER_BUFFERS,
        GL.MAX_COMPUTE_ATOMIC_COUNTER_BUFFERS, GL.MAX_COMBINED_ATOMIC_COUNTER_BUFFERS])
    {
        answer(query, COUNTER_LIMITS.buffersPerStage);
    }
    for (const query of [GL.MAX_FRAGMENT_ATOMIC_COUNTERS, GL.MAX_COMPUTE_ATOMIC_COUNTERS,
        GL.MAX_COMBINED_ATOMIC_COUNTERS])
    {
        answer(query, COUNTER_LIMITS.perStage);
    }
    answer(GL.MAX_ATOMIC_COUNTER_BUFFER_BINDINGS, COUNTER_LIMITS.bindings);
    answer(GL.MAX_ATOMIC_COUNTER_BUFFER_SIZE, COUNTER_LIMITS.bufferBytes);
    // What glBindBuffersBase and glBindBuffersRange check a first point and a
    // count against (`context-later.js`).
    (kernel.side.bufferBindingLimits ??= new Map())
        .set(GL.SHADER_STORAGE_BUFFER, GL.MAX_SHADER_STORAGE_BUFFER_BINDINGS)
        .set(GL.ATOMIC_COUNTER_BUFFER, GL.MAX_ATOMIC_COUNTER_BUFFER_BINDINGS);

    // Images: units GL's 8, but WebGPU's 4 storage textures a stage.
    answer(GL.MAX_IMAGE_UNITS, IMAGE_LIMITS.units);
    answer(GL.MAX_IMAGE_SAMPLES, 0);
    for (const query of [GL.MAX_VERTEX_IMAGE_UNIFORMS, GL.MAX_TESS_CONTROL_IMAGE_UNIFORMS,
        GL.MAX_TESS_EVALUATION_IMAGE_UNIFORMS, GL.MAX_GEOMETRY_IMAGE_UNIFORMS])
    {
        answer(query, 0);
    }
    for (const query of [GL.MAX_FRAGMENT_IMAGE_UNIFORMS, GL.MAX_COMPUTE_IMAGE_UNIFORMS,
        GL.MAX_COMBINED_IMAGE_UNIFORMS])
    {
        answer(query, IMAGE_LIMITS.perStage);
    }

    /**
     * What each image unit binds (glBindImageTexture): the context's, as the
     * texture units are.
     *
     * @type {{ name: number, level: number, layered: boolean, layer: number, access: number,
     *     format: number }[]}
     */
    const units = Array.from({ length: IMAGE_LIMITS.units }, ()=>({ name: 0, level: 0,
        layered: false, layer: 0, access: GL.READ_ONLY, format: 0x8058 /* RGBA8 */ }));
    /** @param {number} name */
    const textureNamed = name=>(name === 0 ? undefined
        : kernel.shareGroup().textures.objects.get(name));
    /** @param {(unit: typeof units[0]) => number} read */
    const unitQuery = read=>(/** @type {number} */ index)=>(index < 0 || index >= units.length
        ? null : { kind: 'int', values: [read(units[index])] });
    // A deleted texture's name answers 0 (4.2 section 8.26).
    indexed.set(GL.IMAGE_BINDING_NAME, unitQuery(unit=>(textureNamed(unit.name) ? unit.name
        : 0)));
    indexed.set(GL.IMAGE_BINDING_LEVEL, unitQuery(unit=>unit.level));
    indexed.set(GL.IMAGE_BINDING_LAYERED, unitQuery(unit=>(unit.layered ? 1 : 0)));
    indexed.set(GL.IMAGE_BINDING_LAYER, unitQuery(unit=>unit.layer));
    indexed.set(GL.IMAGE_BINDING_ACCESS, unitQuery(unit=>unit.access));
    indexed.set(GL.IMAGE_BINDING_FORMAT, unitQuery(unit=>unit.format));
    kernel.side.imageUnits = ()=>units.map(unit=>{
        const texture = textureNamed(unit.name);
        return texture ? { texture, level: unit.level, layered: unit.layered,
            layer: unit.layer, access: unit.access, format: unit.format } : null;
    });

    // A buffer a shader wrote, read on this side (`context-arrays.js`).
    kernel.side.readDeviceBuffer = (/** @type {any} */ buffer)=>gpu?.readBuffer?.(context,
        buffer) ?? null;

    // The two indexed limits, by axis (glGetIntegeri_v); neither has a
    // plain form.
    indexed.set(GL.MAX_COMPUTE_WORK_GROUP_COUNT, index=>(index >= 0 && index < 3
        ? { kind: 'int', values: [COMPUTE_LIMITS.count[index]] } : null));
    indexed.set(GL.MAX_COMPUTE_WORK_GROUP_SIZE, index=>(index >= 0 && index < 3
        ? { kind: 'int', values: [COMPUTE_LIMITS.size[index]] } : null));

    /**
     * Whether the current program can be dispatched: one with a compute
     * stage (INVALID_OPERATION otherwise, 4.3 section 19.1).
     */
    const computing = ()=>{
        if (kernel.side.glslExecutable?.()?.linked.compute)
        {
            return true;
        }
        setError(GL.INVALID_OPERATION);
        return false;
    };

    /** @param {any} request */
    const run = request=>{
        if (!gpu?.dispatchCompute)
        {
            kernel.lose('a compute dispatch ran nothing: no device runs this context\'s work');
            return;
        }
        if (!gpu.dispatchCompute(context, request, ()=>kernel.side.scene()))
        {
            kernel.lose('a compute dispatch ran nothing: the context has no drawable on the'
                + ' device');
        }
    };

    Object.assign(context, {
        /**
         * glBindImageTexture (4.2 section 8.26): a texture's level, all its
         * layers or one, bound to an image unit for loads and stores.
         *
         * @param {number} unit @param {number} name @param {number} level
         * @param {boolean} layered @param {number} layer @param {number} access
         * @param {number} format
         */
        glBindImageTexture(unit, name, level, layered, layer, access, format){
            if (!enter('glBindImageTexture', [unit, name, level, layered, layer, access, format]))
            {
                return;
            }
            if (unit < 0 || unit >= units.length || level < 0 || layer < 0
                || (name !== 0 && !textureNamed(name)) || !IMAGE_UNIT_FORMATS.has(format))
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            if (access !== GL.READ_ONLY && access !== GL.WRITE_ONLY && access !== GL.READ_WRITE)
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            units[unit] = { name, level, layered, layer, access, format };
        },

        /**
         * glGetActiveAtomicCounterBufferiv (4.2 section 7.3.1): what a
         * program's counter buffer, by its index among them, holds.
         *
         * @param {number} programName @param {number} index @param {number} pname
         * @returns {number[] | null}
         */
        glGetActiveAtomicCounterBufferiv(programName, index, pname){
            if (!enter('glGetActiveAtomicCounterBufferiv', [programName, index, pname]))
            {
                return null;
            }
            const program = kernel.side.programObject?.(programName);
            if (!program)
            {
                return null;
            }
            const linked = program.linked ? program.executable?.linked : null;
            const buffers = linked ? counterBuffersOf(linked) : [];
            if (!linked || index < 0 || index >= buffers.length)
            {
                setError(GL.INVALID_VALUE);
                return null;
            }
            const binding = buffers[index];
            /** @type {import('./glsl-storage.js').AtomicCounter[]} */
            const all = linked.counters ?? [];
            const counters = all.filter(c=>c.binding === binding);
            /** @param {'vertex' | 'geometry' | 'fragment' | 'compute'} stage */
            const referenced = stage=>[counters.some(c=>c.stages[stage]) ? 1 : 0];
            // The counters' indices among the active uniforms, which list
            // them after every other (`context-glsl.js` activeUniforms).
            const first = linked.uniforms.length + (linked.blockUniforms ?? []).length;
            switch (pname)
            {
                case GL.ATOMIC_COUNTER_BUFFER_BINDING:
                    return [binding];
                case GL.ATOMIC_COUNTER_BUFFER_DATA_SIZE:
                    return [Math.max(...counters.map(c=>c.offset + 4 * c.count))];
                case GL.ATOMIC_COUNTER_BUFFER_ACTIVE_ATOMIC_COUNTERS:
                    return [counters.length];
                case GL.ATOMIC_COUNTER_BUFFER_ACTIVE_ATOMIC_COUNTER_INDICES:
                    return all.flatMap((c, k)=>(c.binding === binding
                        ? [first + k] : []));
                case GL.ATOMIC_COUNTER_BUFFER_REFERENCED_BY_VERTEX_SHADER:
                    return referenced('vertex');
                case GL.ATOMIC_COUNTER_BUFFER_REFERENCED_BY_GEOMETRY_SHADER:
                    return referenced('geometry');
                case GL.ATOMIC_COUNTER_BUFFER_REFERENCED_BY_FRAGMENT_SHADER:
                    return referenced('fragment');
                case GL.ATOMIC_COUNTER_BUFFER_REFERENCED_BY_COMPUTE_SHADER:
                    return referenced('compute');
                case GL.ATOMIC_COUNTER_BUFFER_REFERENCED_BY_TESS_CONTROL_SHADER:
                case GL.ATOMIC_COUNTER_BUFFER_REFERENCED_BY_TESS_EVALUATION_SHADER:
                    return [0];
                default:
                    setError(GL.INVALID_ENUM);
                    return null;
            }
        },

        /**
         * @param {number} programName @param {number} index @param {number} binding
         */
        glShaderStorageBlockBinding(programName, index, binding){
            if (!enter('glShaderStorageBlockBinding', [programName, index, binding]))
            {
                return;
            }
            const program = kernel.side.programObject?.(programName);
            if (!program)
            {
                return;
            }
            const executable = program.executable;
            const blocks = executable?.linked.storageBlocks ?? [];
            if (!executable || index < 0 || index >= blocks.length
                || binding < 0 || binding >= STORAGE_LIMITS.bindings)
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            /** @type {Int32Array} */ (executable.storageBindings)[index] = binding;
        },

        /** @param {number} x @param {number} y @param {number} z */
        glDispatchCompute(x, y, z){
            if (!enter('glDispatchCompute', [x, y, z]) || !computing())
            {
                return;
            }
            const grid = [x >>> 0, y >>> 0, z >>> 0];
            if (grid.some((count, axis)=>count > COMPUTE_LIMITS.count[axis]))
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            // An empty grid runs no group (section 19.1).
            if (grid.every(count=>count > 0))
            {
                run({ grid });
            }
        },

        /** @param {number} offset  into the DISPATCH_INDIRECT_BUFFER */
        glDispatchComputeIndirect(offset){
            if (!enter('glDispatchComputeIndirect', [offset]))
            {
                return;
            }
            if (offset < 0 || offset % 4 !== 0)
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            if (!computing())
            {
                return;
            }
            const name = record(GL.DISPATCH_INDIRECT_BUFFER_BINDING).values[0];
            const buffer = name === 0 ? undefined : kernel.shareGroup().buffers.objects.get(name);
            // No buffer, three words past its end, or a buffer mapped without
            // persistence (section 6.3.2).
            if (!buffer || offset + 12 > buffer.size
                || (buffer.mapped !== 0 && (buffer.accessFlags & GL.MAP_PERSISTENT_BIT) === 0))
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            run({ indirect: { buffer, offset } });
        },
    });
}
