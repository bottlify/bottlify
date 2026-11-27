/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Program interface queries (OpenGL 4.3 section 7.3.1,
 * GL_ARB_program_interface_query): every list of a linked program's active
 * resources - uniforms, blocks, inputs, outputs, captured varyings, buffer
 * variables - by one set of calls, glGetProgramInterfaceiv,
 * glGetProgramResourceIndex, Name, iv, Location and LocationIndex.
 *
 * - **The lists are the older queries' lists.** Each resource the older calls
 *   also answer (glGetActiveUniform and glGetActiveUniformsiv, the uniform
 *   block calls, glGetActiveAttrib, glGetFragDataLocation and Index,
 *   glGetTransformFeedbackVarying, glGetActiveAtomicCounterBufferiv) is read
 *   through them, so the two ways of asking cannot part (4.6 section 7.3.1.2
 *   defines the older calls as these).
 * - **What has no older call** - buffer variables and storage blocks, the
 *   transform feedback buffers, inputs and outputs of stages other than the
 *   vertex and fragment ones - is read from the link (`glsl-link.js`).
 * - **Subroutines** are the link's tables (`glsl-link.js` StageSubroutines),
 *   asked as the others are.
 * - **A program never linked, or last linked unsuccessfully, has no active
 *   resource**: its lists are empty, and a location asked of it is
 *   GL_INVALID_OPERATION.
 */

import { GL } from './constants.js';
import { activeAttributes, activeUniforms, counterBuffersOf, glTypeOf } from './context-glsl.js';
import { TESS } from './context-tessellation.js';
import { blockVariables } from './glsl-layout.js';

/** The enumerants of 4.3's program interface queries. */
export const INTERFACE = Object.freeze({
    UNIFORM: 0x92e1,
    UNIFORM_BLOCK: 0x92e2,
    PROGRAM_INPUT: 0x92e3,
    PROGRAM_OUTPUT: 0x92e4,
    BUFFER_VARIABLE: 0x92e5,
    SHADER_STORAGE_BLOCK: 0x92e6,
    ATOMIC_COUNTER_BUFFER: 0x92c0,
    VERTEX_SUBROUTINE: 0x92e8,
    TESS_CONTROL_SUBROUTINE: 0x92e9,
    TESS_EVALUATION_SUBROUTINE: 0x92ea,
    GEOMETRY_SUBROUTINE: 0x92eb,
    FRAGMENT_SUBROUTINE: 0x92ec,
    COMPUTE_SUBROUTINE: 0x92ed,
    VERTEX_SUBROUTINE_UNIFORM: 0x92ee,
    TESS_CONTROL_SUBROUTINE_UNIFORM: 0x92ef,
    TESS_EVALUATION_SUBROUTINE_UNIFORM: 0x92f0,
    GEOMETRY_SUBROUTINE_UNIFORM: 0x92f1,
    FRAGMENT_SUBROUTINE_UNIFORM: 0x92f2,
    COMPUTE_SUBROUTINE_UNIFORM: 0x92f3,
    TRANSFORM_FEEDBACK_VARYING: 0x92f4,
    TRANSFORM_FEEDBACK_BUFFER: 0x8c8e,
    ACTIVE_RESOURCES: 0x92f5,
    MAX_NAME_LENGTH: 0x92f6,
    MAX_NUM_ACTIVE_VARIABLES: 0x92f7,
    MAX_NUM_COMPATIBLE_SUBROUTINES: 0x92f8,
    NAME_LENGTH: 0x92f9,
    TYPE: 0x92fa,
    ARRAY_SIZE: 0x92fb,
    OFFSET: 0x92fc,
    BLOCK_INDEX: 0x92fd,
    ARRAY_STRIDE: 0x92fe,
    MATRIX_STRIDE: 0x92ff,
    IS_ROW_MAJOR: 0x9300,
    ATOMIC_COUNTER_BUFFER_INDEX: 0x9301,
    BUFFER_BINDING: 0x9302,
    BUFFER_DATA_SIZE: 0x9303,
    NUM_ACTIVE_VARIABLES: 0x9304,
    ACTIVE_VARIABLES: 0x9305,
    REFERENCED_BY_VERTEX_SHADER: 0x9306,
    REFERENCED_BY_TESS_CONTROL_SHADER: 0x9307,
    REFERENCED_BY_TESS_EVALUATION_SHADER: 0x9308,
    REFERENCED_BY_GEOMETRY_SHADER: 0x9309,
    REFERENCED_BY_FRAGMENT_SHADER: 0x930a,
    REFERENCED_BY_COMPUTE_SHADER: 0x930b,
    TOP_LEVEL_ARRAY_SIZE: 0x930c,
    TOP_LEVEL_ARRAY_STRIDE: 0x930d,
    LOCATION: 0x930e,
    LOCATION_INDEX: 0x930f,
    IS_PER_PATCH: 0x92e7,
    NUM_COMPATIBLE_SUBROUTINES: 0x8e4a,
    COMPATIBLE_SUBROUTINES: 0x8e4b,
    LOCATION_COMPONENT: 0x934a,
    TRANSFORM_FEEDBACK_BUFFER_INDEX: 0x934b,
    TRANSFORM_FEEDBACK_BUFFER_STRIDE: 0x934c,
});

const I = INTERFACE;

/** The calls of this file a display list does not record. */
export const INTERFACE_CALLS_NOT_COMPILED = Object.freeze([
    'glGetProgramInterfaceiv', 'glGetProgramResourceIndex', 'glGetProgramResourceName',
    'glGetProgramResourceiv', 'glGetProgramResourceLocation',
    'glGetProgramResourceLocationIndex',
]);

/**
 * @typedef {'vertex' | 'tessControl' | 'tessEvaluation' | 'geometry' | 'fragment'
 *     | 'compute'} Stage
 */

/** The stages in the order the pipeline runs them, each with its REFERENCED_BY property. */
const STAGES = Object.freeze(/** @type {const} */ ([
    ['vertex', I.REFERENCED_BY_VERTEX_SHADER],
    ['tessControl', I.REFERENCED_BY_TESS_CONTROL_SHADER],
    ['tessEvaluation', I.REFERENCED_BY_TESS_EVALUATION_SHADER],
    ['geometry', I.REFERENCED_BY_GEOMETRY_SHADER],
    ['fragment', I.REFERENCED_BY_FRAGMENT_SHADER],
    ['compute', I.REFERENCED_BY_COMPUTE_SHADER],
]));

/** The uniform block query answering each stage's REFERENCED_BY. */
const BLOCK_REFERENCED = Object.freeze({
    vertex: GL.UNIFORM_BLOCK_REFERENCED_BY_VERTEX_SHADER,
    tessControl: TESS.UNIFORM_BLOCK_REFERENCED_BY_TESS_CONTROL_SHADER,
    tessEvaluation: TESS.UNIFORM_BLOCK_REFERENCED_BY_TESS_EVALUATION_SHADER,
    geometry: GL.UNIFORM_BLOCK_REFERENCED_BY_GEOMETRY_SHADER,
    fragment: GL.UNIFORM_BLOCK_REFERENCED_BY_FRAGMENT_SHADER,
    compute: GL.UNIFORM_BLOCK_REFERENCED_BY_COMPUTE_SHADER,
});

/** The atomic counter buffer query answering each stage's REFERENCED_BY. */
const COUNTER_REFERENCED = Object.freeze({
    vertex: GL.ATOMIC_COUNTER_BUFFER_REFERENCED_BY_VERTEX_SHADER,
    tessControl: GL.ATOMIC_COUNTER_BUFFER_REFERENCED_BY_TESS_CONTROL_SHADER,
    tessEvaluation: GL.ATOMIC_COUNTER_BUFFER_REFERENCED_BY_TESS_EVALUATION_SHADER,
    geometry: GL.ATOMIC_COUNTER_BUFFER_REFERENCED_BY_GEOMETRY_SHADER,
    fragment: GL.ATOMIC_COUNTER_BUFFER_REFERENCED_BY_FRAGMENT_SHADER,
    compute: GL.ATOMIC_COUNTER_BUFFER_REFERENCED_BY_COMPUTE_SHADER,
});

/** The stages the subroutine interfaces below name, in their order. */
const SUBROUTINE_STAGE_NAMES = ['vertex', 'tessControl', 'tessEvaluation', 'geometry',
    'fragment', 'compute'];
/** The subroutine interfaces. @type {Set<number>} */
const SUBROUTINES = new Set([I.VERTEX_SUBROUTINE, I.TESS_CONTROL_SUBROUTINE,
    I.TESS_EVALUATION_SUBROUTINE, I.GEOMETRY_SUBROUTINE, I.FRAGMENT_SUBROUTINE,
    I.COMPUTE_SUBROUTINE]);
/** The subroutine uniform interfaces. @type {Set<number>} */
const SUBROUTINE_UNIFORMS = new Set([I.VERTEX_SUBROUTINE_UNIFORM,
    I.TESS_CONTROL_SUBROUTINE_UNIFORM, I.TESS_EVALUATION_SUBROUTINE_UNIFORM,
    I.GEOMETRY_SUBROUTINE_UNIFORM, I.FRAGMENT_SUBROUTINE_UNIFORM,
    I.COMPUTE_SUBROUTINE_UNIFORM]);

/** Every interface the calls take. @type {Set<number>} */
const INTERFACES = new Set([I.UNIFORM, I.UNIFORM_BLOCK, I.PROGRAM_INPUT, I.PROGRAM_OUTPUT,
    I.BUFFER_VARIABLE, I.SHADER_STORAGE_BLOCK, I.ATOMIC_COUNTER_BUFFER,
    I.TRANSFORM_FEEDBACK_VARYING, I.TRANSFORM_FEEDBACK_BUFFER, ...SUBROUTINES,
    ...SUBROUTINE_UNIFORMS]);

/** The interfaces whose resources have no name (4.3 section 7.3.1). @type {Set<number>} */
const NAMELESS = new Set([I.ATOMIC_COUNTER_BUFFER, I.TRANSFORM_FEEDBACK_BUFFER]);

/** The interfaces whose resources hold active variables. @type {Set<number>} */
const HOLDERS = new Set([I.UNIFORM_BLOCK, I.ATOMIC_COUNTER_BUFFER, I.SHADER_STORAGE_BLOCK,
    I.TRANSFORM_FEEDBACK_BUFFER]);

/** The interfaces glGetProgramResourceLocation takes. @type {Set<number>} */
const LOCATED = new Set([I.UNIFORM, I.PROGRAM_INPUT, I.PROGRAM_OUTPUT, ...SUBROUTINE_UNIFORMS]);

/**
 * Every property of table 7.2, which an interface may not have (INVALID_OPERATION).
 *
 * @type {Set<number>}
 */
const PROPERTIES = new Set([I.NAME_LENGTH, I.TYPE, I.ARRAY_SIZE, I.OFFSET, I.BLOCK_INDEX,
    I.ARRAY_STRIDE, I.MATRIX_STRIDE, I.IS_ROW_MAJOR, I.ATOMIC_COUNTER_BUFFER_INDEX,
    I.BUFFER_BINDING, I.BUFFER_DATA_SIZE, I.NUM_ACTIVE_VARIABLES, I.ACTIVE_VARIABLES,
    ...STAGES.map(([, property])=>property), I.TOP_LEVEL_ARRAY_SIZE,
    I.TOP_LEVEL_ARRAY_STRIDE, I.LOCATION, I.LOCATION_INDEX, I.IS_PER_PATCH,
    I.NUM_COMPATIBLE_SUBROUTINES, I.COMPATIBLE_SUBROUTINES, I.LOCATION_COMPONENT,
    I.TRANSFORM_FEEDBACK_BUFFER_INDEX, I.TRANSFORM_FEEDBACK_BUFFER_STRIDE]);

/**
 * An active resource: its name (null for the nameless interfaces) and the
 * answer to each property its interface has.
 *
 * @typedef {Object} Resource
 * @property {string | null} name
 * @property {Map<number, () => number[]>} properties
 */

/**
 * @param {string | null} name
 * @param {[number, () => number[]][]} properties
 * @returns {Resource}
 */
const resource = (name, properties)=>({ name, properties: new Map(properties) });

/**
 * Each stage's REFERENCED_BY property, by whether it references the resource.
 *
 * @param {(stage: Stage) => boolean} used
 * @returns {[number, () => number[]][]}
 */
const referenced = used=>STAGES.map(([stage, property])=>[property, ()=>[used(stage) ? 1 : 0]]);

/**
 * A type as a resource lists it: an array's element and its length, 1 for
 * anything else.
 *
 * @param {import('./glsl-types.js').GlslType} type
 * @returns {{ element: import('./glsl-types.js').GlslType, size: number }}
 */
const elementOf = type=>(type.kind === 'array' ? { element: type.element, size: type.length }
    : { element: type, size: 1 });

/**
 * A name with its array suffix and element: `a[2]` is `a` element 2.
 *
 * @param {string} name @returns {{ base: string, element: number, indexed: boolean }}
 */
const parseName = name=>{
    const match = /^(.+?)\[(\d+)\]$/.exec(name);
    return match ? { base: match[1], element: Number(match[2]), indexed: true }
        : { base: name, element: 0, indexed: false };
};

/**
 * @param {any} context
 * @param {import('./kernel.js').ContextKernel} kernel
 */
export function installInterfaceCalls(context, kernel){
    const { enter, setError } = kernel;

    /**
     * The linked program a call names, or null with the error set: no such
     * object, or a shader's name.
     *
     * @param {number} programName
     * @returns {{ program: any, linked: import('./glsl-link.js').LinkedProgram | null,
     *     executable: import('./glsl-link.js').Executable | null } | null}
     */
    const programOf = programName=>{
        const program = kernel.side.programObject?.(programName);
        if (!program)
        {
            return null;
        }
        const executable = program.linked ? program.executable ?? null : null;
        return { program, linked: executable?.linked ?? null, executable };
    };

    /**
     * A stage's own inputs or outputs, for a program whose first stage is not
     * the vertex one or whose last is not the fragment one: its user
     * variables of that direction and the built-ins it reads or writes. A
     * per-vertex array is listed by its element, as a vertex's.
     *
     * @param {import('./glsl-link.js').LinkedStage} stage @param {'in' | 'out'} direction
     * @returns {Resource[]}
     */
    const ownVariables = (stage, direction)=>{
        /** @type {Resource[]} */
        const out = [];
        const legacy = direction === 'out' ? stage.stage === 'vertex' : stage.stage === 'fragment';
        /**
         * @param {string} name @param {import('./glsl-types.js').GlslType} type
         * @param {any} qualifiers @param {boolean} builtin
         */
        const add = (name, type, qualifiers, builtin)=>{
            const patch = !!qualifiers?.patch;
            const perVertex = !patch && type.kind === 'array'
                && ((direction === 'in' && (stage.stage === 'geometry'
                    || stage.stage === 'tessControl' || stage.stage === 'tessEvaluation'))
                    || (direction === 'out' && stage.stage === 'tessControl'));
            const shown = perVertex && type.kind === 'array' ? type.element : type;
            const { element, size } = elementOf(shown);
            const layout = qualifiers?.layout ?? {};
            const location = builtin || typeof layout.location !== 'number' ? -1
                : layout.location;
            const listed = shown.kind === 'array' ? `${name}[0]` : name;
            out.push(resource(listed, [
                [I.NAME_LENGTH, ()=>[listed.length + 1]],
                [I.TYPE, ()=>[glTypeOf(element)]],
                [I.ARRAY_SIZE, ()=>[size]],
                ...referenced(s=>s === stage.stage),
                [I.LOCATION, ()=>[location]],
                [I.IS_PER_PATCH, ()=>[patch ? 1 : 0]],
                [I.LOCATION_COMPONENT, ()=>[typeof layout.component === 'number'
                    ? layout.component : 0]],
                ...direction === 'out' ? /** @type {[number, () => number[]][]} */ ([
                    [I.LOCATION_INDEX, ()=>[-1]]]) : [],
            ]));
        };
        for (const symbol of stage.globals)
        {
            const storage = symbol.storage;
            if ((storage === direction || (legacy && storage === 'varying')) && !symbol.block
                && stage.uses.has(symbol.name))
            {
                add(symbol.name, symbol.type, symbol.qualifiers, false);
            }
        }
        for (const [name, symbol] of stage.builtins ?? [])
        {
            if (symbol.builtin?.role === direction && stage.uses.has(name))
            {
                add(name, symbol.type, null, true);
            }
        }
        return out;
    };

    /**
     * The active resources of an interface, in the order their indices run.
     *
     * @param {number} programName
     * @param {import('./glsl-link.js').LinkedProgram} linked
     * @param {import('./glsl-link.js').Executable} executable
     * @param {number} programInterface
     * @returns {Resource[]}
     */
    const resourcesOf = (programName, linked, executable, programInterface)=>{
        switch (programInterface)
        {
            case I.UNIFORM: {
                const own = linked.uniforms.length;
                const inBlocks = (linked.blockUniforms ?? []).length;
                /** @param {number} k @param {Stage} stage */
                const usedBy = (k, stage)=>{
                    if (k < own)
                    {
                        return !!linked[stage]?.uses.has(linked.uniforms[k].root);
                    }
                    if (k < own + inBlocks)
                    {
                        const block = linked.blocks[(linked.blockUniforms ?? [])[k - own].block];
                        return !!/** @type {any} */ (block.stages)[stage];
                    }
                    return !!/** @type {any} */ ((linked.counters ?? [])[k - own - inBlocks]
                        .stages)[stage];
                };
                return activeUniforms(linked).map((u, k)=>{
                    /** @param {number} pname */
                    const older = pname=>context.glGetActiveUniformsiv(programName, [k], pname)
                        ?? [];
                    return resource(u.name, [
                        [I.NAME_LENGTH, ()=>[u.name.length + 1]],
                        [I.TYPE, ()=>older(GL.UNIFORM_TYPE)],
                        [I.ARRAY_SIZE, ()=>older(GL.UNIFORM_SIZE)],
                        [I.OFFSET, ()=>older(GL.UNIFORM_OFFSET)],
                        [I.BLOCK_INDEX, ()=>older(GL.UNIFORM_BLOCK_INDEX)],
                        [I.ARRAY_STRIDE, ()=>older(GL.UNIFORM_ARRAY_STRIDE)],
                        [I.MATRIX_STRIDE, ()=>older(GL.UNIFORM_MATRIX_STRIDE)],
                        [I.IS_ROW_MAJOR, ()=>older(GL.UNIFORM_IS_ROW_MAJOR)],
                        [I.ATOMIC_COUNTER_BUFFER_INDEX,
                            ()=>older(GL.UNIFORM_ATOMIC_COUNTER_BUFFER_INDEX)],
                        ...referenced(stage=>usedBy(k, stage)),
                        // Only the default block's uniforms have locations.
                        [I.LOCATION, ()=>[k < own
                            ? context.glGetUniformLocation(programName, u.name) : -1]],
                    ]);
                });
            }
            case I.UNIFORM_BLOCK:
                return linked.blocks.map((block, k)=>{
                    /** @param {number} pname */
                    const older = pname=>context.glGetActiveUniformBlockiv(programName, k, pname)
                        ?? [];
                    return resource(block.name, [
                        [I.NAME_LENGTH, ()=>[block.name.length + 1]],
                        [I.BUFFER_BINDING, ()=>older(GL.UNIFORM_BLOCK_BINDING)],
                        [I.BUFFER_DATA_SIZE, ()=>older(GL.UNIFORM_BLOCK_DATA_SIZE)],
                        [I.NUM_ACTIVE_VARIABLES, ()=>older(GL.UNIFORM_BLOCK_ACTIVE_UNIFORMS)],
                        [I.ACTIVE_VARIABLES, ()=>older(GL.UNIFORM_BLOCK_ACTIVE_UNIFORM_INDICES)],
                        ...referenced(stage=>older(BLOCK_REFERENCED[stage])[0] === 1),
                    ]);
                });
            case I.ATOMIC_COUNTER_BUFFER:
                return counterBuffersOf(linked).map((unused, k)=>{
                    /** @param {number} pname */
                    const older = pname=>context.glGetActiveAtomicCounterBufferiv(programName, k,
                        pname) ?? [];
                    return resource(null, [
                        [I.BUFFER_BINDING, ()=>older(GL.ATOMIC_COUNTER_BUFFER_BINDING)],
                        [I.BUFFER_DATA_SIZE, ()=>older(GL.ATOMIC_COUNTER_BUFFER_DATA_SIZE)],
                        [I.NUM_ACTIVE_VARIABLES,
                            ()=>older(GL.ATOMIC_COUNTER_BUFFER_ACTIVE_ATOMIC_COUNTERS)],
                        [I.ACTIVE_VARIABLES,
                            ()=>older(GL.ATOMIC_COUNTER_BUFFER_ACTIVE_ATOMIC_COUNTER_INDICES)],
                        ...referenced(stage=>older(COUNTER_REFERENCED[stage])[0] === 1),
                    ]);
                });
            case I.PROGRAM_INPUT: {
                if (linked.vertex)
                {
                    return activeAttributes(linked).map((attribute, k)=>{
                        const older = context.glGetActiveAttrib(programName, k);
                        return resource(attribute.name, [
                            [I.NAME_LENGTH, ()=>[attribute.name.length + 1]],
                            [I.TYPE, ()=>[older?.type ?? 0]],
                            [I.ARRAY_SIZE, ()=>[older?.size ?? 0]],
                            ...referenced(stage=>stage === 'vertex'),
                            [I.LOCATION, ()=>[context.glGetAttribLocation(programName,
                                attribute.name)]],
                            [I.IS_PER_PATCH, ()=>[0]],
                            [I.LOCATION_COMPONENT, ()=>[0]],
                        ]);
                    });
                }
                const first = STAGES.map(([stage])=>linked[stage]).find(Boolean);
                return first ? ownVariables(first, 'in') : [];
            }
            case I.PROGRAM_OUTPUT: {
                if (linked.compute)
                {
                    return [];
                }
                if (!linked.fragment)
                {
                    const last = [...STAGES].reverse().map(([stage])=>linked[stage])
                        .find(Boolean);
                    return last ? ownVariables(last, 'out') : [];
                }
                const fragment = linked.fragment;
                return [
                    ...linked.outputs.map(output=>{
                        const { element, size } = elementOf(output.type);
                        const name = output.type.kind === 'array' ? `${output.name}[0]`
                            : output.name;
                        return resource(name, [
                            [I.NAME_LENGTH, ()=>[name.length + 1]],
                            [I.TYPE, ()=>[glTypeOf(element)]],
                            [I.ARRAY_SIZE, ()=>[size]],
                            ...referenced(stage=>stage === 'fragment'),
                            [I.LOCATION, ()=>[context.fragData(programName, name, 'location')]],
                            [I.LOCATION_INDEX, ()=>[context.fragData(programName, name,
                                'index')]],
                            [I.IS_PER_PATCH, ()=>[0]],
                            [I.LOCATION_COMPONENT, ()=>[0]],
                        ]);
                    }),
                    // The built-in outputs it writes, which have no location.
                    ...ownVariables(fragment, 'out').filter(r=>r.name?.startsWith('gl_')),
                ];
            }
            case I.TRANSFORM_FEEDBACK_VARYING:
                return (linked.feedback?.varyings ?? []).map((varying, k)=>{
                    const older = context.glGetTransformFeedbackVarying(programName, k);
                    return resource(varying.name, [
                        [I.NAME_LENGTH, ()=>[varying.name.length + 1]],
                        [I.TYPE, ()=>[older?.type ?? 0]],
                        [I.ARRAY_SIZE, ()=>[older?.size ?? 0]],
                        [I.OFFSET, ()=>[varying.word * 4]],
                        [I.TRANSFORM_FEEDBACK_BUFFER_INDEX, ()=>[varying.buffer]],
                    ]);
                });
            case I.TRANSFORM_FEEDBACK_BUFFER: {
                const varyings = linked.feedback?.varyings ?? [];
                return (linked.feedback?.strides ?? []).map((stride, buffer)=>{
                    // A gap (gl_SkipComponents, gl_NextBuffer) is no variable.
                    const held = varyings.flatMap((v, k)=>(v.buffer === buffer && v.type
                        ? [k] : []));
                    return resource(null, [
                        [I.BUFFER_BINDING, ()=>[buffer]],
                        [I.NUM_ACTIVE_VARIABLES, ()=>[held.length]],
                        [I.ACTIVE_VARIABLES, ()=>held],
                        [I.TRANSFORM_FEEDBACK_BUFFER_STRIDE, ()=>[stride * 4]],
                    ]);
                });
            }
            case I.BUFFER_VARIABLE:
                return bufferVariablesOf(linked).map(variable=>{
                    const block = (linked.storageBlocks ?? [])[variable.block];
                    return resource(variable.name, [
                        [I.NAME_LENGTH, ()=>[variable.name.length + 1]],
                        [I.TYPE, ()=>[glTypeOf(variable.type)]],
                        [I.ARRAY_SIZE, ()=>[variable.arraySize]],
                        [I.OFFSET, ()=>[variable.offset]],
                        [I.BLOCK_INDEX, ()=>[variable.block]],
                        [I.ARRAY_STRIDE, ()=>[variable.arrayStride]],
                        [I.MATRIX_STRIDE, ()=>[variable.matrixStride]],
                        [I.IS_ROW_MAJOR, ()=>[variable.rowMajor ? 1 : 0]],
                        ...referenced(stage=>!!/** @type {any} */ (block.stages)[stage]),
                        [I.TOP_LEVEL_ARRAY_SIZE, ()=>[variable.topSize]],
                        [I.TOP_LEVEL_ARRAY_STRIDE, ()=>[variable.topStride]],
                    ]);
                });
            case I.SHADER_STORAGE_BLOCK: {
                const variables = bufferVariablesOf(linked);
                return (linked.storageBlocks ?? []).map((block, k)=>{
                    // An array of blocks lists its variables once, with its first element.
                    const first = k - block.element;
                    const held = variables.flatMap((v, at)=>(v.block === first ? [at] : []));
                    return resource(block.name, [
                        [I.NAME_LENGTH, ()=>[block.name.length + 1]],
                        [I.BUFFER_BINDING, ()=>[executable.storageBindings?.[k] ?? 0]],
                        // A last member sized at run time counts one element
                        // (4.3 section 7.6.2.2).
                        [I.BUFFER_DATA_SIZE, ()=>[block.size + block.runtimeStride]],
                        [I.NUM_ACTIVE_VARIABLES, ()=>[held.length]],
                        [I.ACTIVE_VARIABLES, ()=>held],
                        ...referenced(stage=>!!/** @type {any} */ (block.stages)[stage]),
                    ]);
                });
            }
            default: {
                // The subroutine interfaces: a stage's subroutine functions in
                // the order of their indices, its subroutine uniforms with the
                // locations they take (4.0 section 7.9).
                const order = SUBROUTINES.has(programInterface) ? [...SUBROUTINES]
                    : [...SUBROUTINE_UNIFORMS];
                const stage = SUBROUTINE_STAGE_NAMES[order.indexOf(programInterface)];
                const table = linked.subroutines?.[stage];
                if (!table)
                {
                    return [];
                }
                if (SUBROUTINES.has(programInterface))
                {
                    return [...table.functions].sort((a, b)=>a.index - b.index).map(fn=>
                        resource(fn.name, [[I.NAME_LENGTH, ()=>[fn.name.length + 1]]]));
                }
                return table.uniforms.map(uniform=>resource(uniform.name, [
                    [I.NAME_LENGTH, ()=>[uniform.name.length + 1]],
                    [I.ARRAY_SIZE, ()=>[1]],
                    [I.NUM_COMPATIBLE_SUBROUTINES, ()=>[uniform.compatible.length]],
                    [I.COMPATIBLE_SUBROUTINES, ()=>[...uniform.compatible]],
                    [I.LOCATION, ()=>[uniform.location]],
                ]));
            }
        }
    };

    /**
     * A program's buffer variables (4.3 section 7.3.1.1): each storage block
     * declaration's members by leaf, named as uniform blocks' are, with the
     * array its top-level member is.
     *
     * @param {import('./glsl-link.js').LinkedProgram} linked
     */
    const bufferVariablesOf = linked=>(linked.storageBlocks ?? []).flatMap((block, k)=>{
        if (block.element !== 0)
        {
            return [];
        }
        const prefix = block.instance ? `${block.blockName}.` : '';
        return block.members.flatMap(member=>{
            const top = member.type.kind === 'array'
                ? { topSize: member.type.length, topStride: member.arrayStride ?? 0 }
                : { topSize: 1, topStride: 0 };
            return blockVariables({ members: [member] }, block.packing).map(v=>({ ...v,
                name: `${prefix}${v.name}`, block: k, ...top }));
        });
    });

    /**
     * The resources of a call's program and interface, or null with the
     * error set; a program with no successful link has none.
     *
     * @param {number} programName @param {number} programInterface
     * @returns {Resource[] | null}
     */
    const listOf = (programName, programInterface)=>{
        const named = programOf(programName);
        if (!named)
        {
            return null;
        }
        if (!INTERFACES.has(programInterface))
        {
            setError(GL.INVALID_ENUM);
            return null;
        }
        return named.linked && named.executable
            ? resourcesOf(programName, named.linked, named.executable, programInterface) : [];
    };

    /**
     * The resource whose name a call gives: the name itself, or an array's
     * without its `[0]` (4.3 section 7.3.1.1).
     *
     * @param {Resource[]} list @param {string} name @returns {number}
     */
    const indexNamed = (list, name)=>{
        const exact = list.findIndex(r=>r.name === name);
        return exact >= 0 ? exact : list.findIndex(r=>r.name === `${name}[0]`);
    };

    Object.assign(context, {
        /**
         * @param {number} programName @param {number} programInterface @param {number} pname
         * @returns {number[] | null}
         */
        glGetProgramInterfaceiv(programName, programInterface, pname){
            if (!enter('glGetProgramInterfaceiv', [programName, programInterface, pname]))
            {
                return null;
            }
            const list = listOf(programName, programInterface);
            if (!list)
            {
                return null;
            }
            switch (pname)
            {
                case I.ACTIVE_RESOURCES:
                    return [list.length];
                case I.MAX_NAME_LENGTH:
                    if (NAMELESS.has(programInterface))
                    {
                        setError(GL.INVALID_OPERATION);
                        return null;
                    }
                    return [Math.max(0, ...list.map(r=>(r.name ?? '').length + 1))];
                case I.MAX_NUM_ACTIVE_VARIABLES:
                    if (!HOLDERS.has(programInterface))
                    {
                        setError(GL.INVALID_OPERATION);
                        return null;
                    }
                    return [Math.max(0, ...list.map(r=>r.properties.get(I.NUM_ACTIVE_VARIABLES)
                        ?.()[0] ?? 0))];
                case I.MAX_NUM_COMPATIBLE_SUBROUTINES:
                    if (!SUBROUTINE_UNIFORMS.has(programInterface))
                    {
                        setError(GL.INVALID_OPERATION);
                        return null;
                    }
                    return [0];
                default:
                    setError(GL.INVALID_ENUM);
                    return null;
            }
        },

        /**
         * @param {number} programName @param {number} programInterface @param {string} name
         * @returns {number}
         */
        glGetProgramResourceIndex(programName, programInterface, name){
            if (!enter('glGetProgramResourceIndex', [programName, programInterface, name]))
            {
                return GL.INVALID_INDEX;
            }
            if (NAMELESS.has(programInterface))
            {
                if (programOf(programName))
                {
                    setError(GL.INVALID_ENUM);
                }
                return GL.INVALID_INDEX;
            }
            const list = listOf(programName, programInterface);
            const index = list ? indexNamed(list, name) : -1;
            return index < 0 ? GL.INVALID_INDEX : index;
        },

        /**
         * @param {number} programName @param {number} programInterface @param {number} index
         * @param {number} size  the program's buffer, a negative one refused
         * @returns {string | null}
         */
        glGetProgramResourceName(programName, programInterface, index, size){
            if (!enter('glGetProgramResourceName', [programName, programInterface, index, size]))
            {
                return null;
            }
            const list = listOf(programName, programInterface);
            if (!list)
            {
                return null;
            }
            if (NAMELESS.has(programInterface))
            {
                setError(GL.INVALID_ENUM);
                return null;
            }
            if (index < 0 || index >= list.length || size < 0)
            {
                setError(GL.INVALID_VALUE);
                return null;
            }
            return list[index].name;
        },

        /**
         * glGetProgramResourceiv: each property's values in turn, as many as
         * `size` takes (the caller writes them and their count).
         *
         * @param {number} programName @param {number} programInterface @param {number} index
         * @param {readonly number[]} props @param {number} size
         * @returns {number[] | null}
         */
        glGetProgramResourceiv(programName, programInterface, index, props, size){
            if (!enter('glGetProgramResourceiv', [programName, programInterface, index, props,
                size]))
            {
                return null;
            }
            const list = listOf(programName, programInterface);
            if (!list)
            {
                return null;
            }
            if (index < 0 || index >= list.length || props.length <= 0 || size < 0)
            {
                setError(GL.INVALID_VALUE);
                return null;
            }
            const unknown = props.find(prop=>!PROPERTIES.has(prop));
            if (unknown !== undefined)
            {
                setError(GL.INVALID_ENUM);
                return null;
            }
            const answers = list[index].properties;
            if (props.some(prop=>!answers.has(prop)))
            {
                setError(GL.INVALID_OPERATION);
                return null;
            }
            return props.flatMap(prop=>/** @type {() => number[]} */ (answers.get(prop))())
                .slice(0, size);
        },

        /**
         * @param {number} programName @param {number} programInterface @param {string} name
         * @returns {number}
         */
        glGetProgramResourceLocation(programName, programInterface, name){
            if (!enter('glGetProgramResourceLocation', [programName, programInterface, name]))
            {
                return -1;
            }
            return locate(programName, programInterface, name, false);
        },

        /**
         * @param {number} programName @param {number} programInterface @param {string} name
         * @returns {number}
         */
        glGetProgramResourceLocationIndex(programName, programInterface, name){
            if (!enter('glGetProgramResourceLocationIndex', [programName, programInterface,
                name]))
            {
                return -1;
            }
            return locate(programName, programInterface, name, true);
        },
    });

    /**
     * glGetProgramResourceLocation and LocationIndex: a name's location, an
     * array's element by its suffix, -1 for a name that is no resource or
     * one with no location.
     *
     * @param {number} programName @param {number} programInterface @param {string} name
     * @param {boolean} wantIndex
     * @returns {number}
     */
    const locate = (programName, programInterface, name, wantIndex)=>{
        const named = programOf(programName);
        if (!named)
        {
            return -1;
        }
        if (wantIndex ? programInterface !== I.PROGRAM_OUTPUT : !LOCATED.has(programInterface))
        {
            setError(GL.INVALID_ENUM);
            return -1;
        }
        if (!named.linked || !named.executable)
        {
            setError(GL.INVALID_OPERATION);
            return -1;
        }
        if (name.startsWith('gl_'))
        {
            return -1;
        }
        if (programInterface === I.UNIFORM)
        {
            return context.glGetUniformLocation(programName, name);
        }
        if (programInterface === I.PROGRAM_OUTPUT && named.linked.fragment)
        {
            return context.fragData(programName, name, wantIndex ? 'index' : 'location');
        }
        if (programInterface === I.PROGRAM_INPUT && named.linked.vertex)
        {
            return context.glGetAttribLocation(programName, name);
        }
        const list = resourcesOf(programName, named.linked, named.executable, programInterface);
        const parsed = parseName(name);
        const at = list.findIndex(r=>r.name === name || r.name === `${parsed.base}[0]`);
        const found = list[at];
        if (!found)
        {
            return -1;
        }
        const size = found.properties.get(I.ARRAY_SIZE)?.()[0] ?? 1;
        if (parsed.indexed && (found.name === name ? parsed.element !== 0
            : parsed.element >= size))
        {
            return -1;
        }
        if (wantIndex)
        {
            return found.properties.get(I.LOCATION_INDEX)?.()[0] ?? -1;
        }
        const location = found.properties.get(I.LOCATION)?.()[0] ?? -1;
        return location < 0 ? -1 : location + parsed.element;
    };
}
