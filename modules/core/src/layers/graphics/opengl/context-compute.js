/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Compute dispatches (OpenGL 4.3 chapter 19, GL_ARB_compute_shader):
 * glDispatchCompute and glDispatchComputeIndirect run the current program's
 * compute stage over a grid of work groups, and the limits that bound them.
 *
 * - **A dispatch is recorded among the draws** (`gpu-compute.js`): the
 *   device runs it after the draws made before it and before those made
 *   after, so what one writes the next reads, as GL orders them.
 * - **The grid's counts are checked against GL_MAX_COMPUTE_WORK_GROUP_COUNT**
 *   for the direct form; an indirect one's are the device's to bound, as
 *   GL leaves them undefined past the limit.
 * - **The limits are WebGPU's** where they are under GL's minimums
 *   (`glsl-link.js` COMPUTE_LIMITS).
 */

import { GL } from './constants.js';
import { BLOCK_LIMITS, COMPUTE_LIMITS } from './glsl-link.js';
import { GLSL_LIMITS } from './glsl-builtins.js';

/** The calls of this file a display list does not record (4.6 compatibility 21.4). */
export const COMPUTE_CALLS_NOT_COMPILED = Object.freeze([
    'glDispatchCompute', 'glDispatchComputeIndirect',
]);

/**
 * @param {any} context
 * @param {import('./kernel.js').ContextKernel} kernel
 * @param {{ dispatchCompute?: (context: object, request: any, sceneOf: () => any)
 *     => boolean } | null} gpu  the device that runs the dispatches
 */
export function installComputeCalls(context, kernel, gpu){
    const { enter, setError, record } = kernel;

    const queries = kernel.side.queries ??= new Map();
    /** @param {number} query @param {number} value */
    const answer = (query, value)=>queries.set(query, ()=>({ kind: 'int', values: [value] }));
    answer(GL.MAX_COMPUTE_WORK_GROUP_INVOCATIONS, COMPUTE_LIMITS.invocations);
    answer(GL.MAX_COMPUTE_SHARED_MEMORY_SIZE, COMPUTE_LIMITS.sharedBytes);
    answer(GL.MAX_COMPUTE_UNIFORM_BLOCKS, BLOCK_LIMITS.perStage);
    answer(GL.MAX_COMPUTE_TEXTURE_IMAGE_UNITS, GLSL_LIMITS.textureImageUnits);
    answer(GL.MAX_COMPUTE_UNIFORM_COMPONENTS, GLSL_LIMITS.fragmentUniformComponents);
    answer(GL.MAX_COMBINED_COMPUTE_UNIFORM_COMPONENTS, GLSL_LIMITS.fragmentUniformComponents
        + BLOCK_LIMITS.perStage * BLOCK_LIMITS.size / 4);

    // The two indexed limits, by axis (glGetIntegeri_v); neither has a
    // plain form.
    const indexed = /** @type {Map<number, (index: number) => ({ kind: string,
     *     values: number[] } | null)>} */ (kernel.side.indexed ??= new Map());
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
