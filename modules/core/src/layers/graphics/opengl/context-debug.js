/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Debug output (OpenGL 4.3 chapter 20, GL_KHR_debug, GL_ARB_debug_output).
 *
 * - **The messages are the program's own**: what glDebugMessageInsert and
 *   the debug groups make. The renderer adds none of its own, which the
 *   specification allows (which messages an implementation makes is its
 *   own); what it does not do is said as divergences, not as messages.
 * - **A message goes to the callback when there is one, else to the log**,
 *   only while GL_DEBUG_OUTPUT is on and the message's rule leaves it on.
 *   The callback is the program's function; the exports call it
 *   (`exports-debug.js`) with the message this file hands back, before the
 *   call returns, which is what GL_DEBUG_OUTPUT_SYNCHRONOUS asks and allowed
 *   without it.
 * - **The rules** (glDebugMessageControl) are kept as the list the program
 *   made, the last that matches a message deciding; a message of low
 *   severity starts disabled. Each debug group keeps its own list, a copy of
 *   the one below it when pushed.
 * - **Labels** belong to the objects they name: one deleted and made again
 *   under the same name starts without one where the object can be told
 *   from its name (buffers, textures, framebuffers); the others keep the
 *   label of the name.
 */

import { GL } from './constants.js';

export const DEBUG = Object.freeze({
    DEBUG_OUTPUT: 0x92e0,
    DEBUG_OUTPUT_SYNCHRONOUS: 0x8242,
    MAX_DEBUG_MESSAGE_LENGTH: 0x9143,
    MAX_DEBUG_LOGGED_MESSAGES: 0x9144,
    DEBUG_LOGGED_MESSAGES: 0x9145,
    DEBUG_NEXT_LOGGED_MESSAGE_LENGTH: 0x8243,
    MAX_DEBUG_GROUP_STACK_DEPTH: 0x826c,
    DEBUG_GROUP_STACK_DEPTH: 0x826d,
    MAX_LABEL_LENGTH: 0x82e8,
    DEBUG_CALLBACK_FUNCTION: 0x8244,
    DEBUG_CALLBACK_USER_PARAM: 0x8245,
    SOURCE_API: 0x8246,
    SOURCE_WINDOW_SYSTEM: 0x8247,
    SOURCE_SHADER_COMPILER: 0x8248,
    SOURCE_THIRD_PARTY: 0x8249,
    SOURCE_APPLICATION: 0x824a,
    SOURCE_OTHER: 0x824b,
    TYPE_ERROR: 0x824c,
    TYPE_DEPRECATED_BEHAVIOR: 0x824d,
    TYPE_UNDEFINED_BEHAVIOR: 0x824e,
    TYPE_PORTABILITY: 0x824f,
    TYPE_PERFORMANCE: 0x8250,
    TYPE_OTHER: 0x8251,
    TYPE_MARKER: 0x8268,
    TYPE_PUSH_GROUP: 0x8269,
    TYPE_POP_GROUP: 0x826a,
    SEVERITY_HIGH: 0x9146,
    SEVERITY_MEDIUM: 0x9147,
    SEVERITY_LOW: 0x9148,
    SEVERITY_NOTIFICATION: 0x826b,
    DONT_CARE: 0x1100,
    BUFFER: 0x82e0,
    SHADER: 0x82e1,
    PROGRAM: 0x82e2,
    QUERY: 0x82e3,
    PROGRAM_PIPELINE: 0x82e4,
    SAMPLER: 0x82e6,
    VERTEX_ARRAY: 0x8074,
    TRANSFORM_FEEDBACK: 0x8e22,
});

/** The calls of this file a display list does not record: all of them. */
export const DEBUG_CALLS_NOT_COMPILED = Object.freeze([
    'glDebugMessageControl', 'glDebugMessageInsert', 'debugMessageCallback',
    'glGetDebugMessageLog', 'glPushDebugGroup', 'glPopDebugGroup', 'glObjectLabel',
    'glGetObjectLabel', 'debugCallback',
]);

/** GL_SYNC_FENCE, the identifier glObjectPtrLabel's sync is named by here. */
const SYNC_FENCE = 0x9116;

const MAX_MESSAGE_LENGTH = 1024;
const MAX_LOGGED = 64;
const MAX_GROUP_DEPTH = 64;
const MAX_LABEL_LENGTH = 256;

/** @type {ReadonlySet<number>} */
const SOURCES = new Set([DEBUG.SOURCE_API, DEBUG.SOURCE_WINDOW_SYSTEM,
    DEBUG.SOURCE_SHADER_COMPILER, DEBUG.SOURCE_THIRD_PARTY, DEBUG.SOURCE_APPLICATION,
    DEBUG.SOURCE_OTHER]);
/** @type {ReadonlySet<number>} */
const TYPES = new Set([DEBUG.TYPE_ERROR, DEBUG.TYPE_DEPRECATED_BEHAVIOR,
    DEBUG.TYPE_UNDEFINED_BEHAVIOR, DEBUG.TYPE_PORTABILITY, DEBUG.TYPE_PERFORMANCE,
    DEBUG.TYPE_OTHER, DEBUG.TYPE_MARKER, DEBUG.TYPE_PUSH_GROUP, DEBUG.TYPE_POP_GROUP]);
/** @type {ReadonlySet<number>} */
const SEVERITIES = new Set([DEBUG.SEVERITY_HIGH, DEBUG.SEVERITY_MEDIUM, DEBUG.SEVERITY_LOW,
    DEBUG.SEVERITY_NOTIFICATION]);

/**
 * One message: what the log keeps and what the callback is shown.
 *
 * @typedef {{ source: number, type: number, id: number, severity: number,
 *     text: string }} DebugMessage
 */

/**
 * One rule of glDebugMessageControl; a field null matches anything.
 *
 * @typedef {{ source: number | null, type: number | null, severity: number | null,
 *     ids: ReadonlySet<number> | null, enabled: boolean }} DebugRule
 */

/**
 * @param {any} context
 * @param {import('./kernel.js').ContextKernel} kernel
 */
export function installDebugCalls(context, kernel){
    const { enter, setError, record } = kernel;

    /** @type {DebugMessage[]} */
    const log = [];
    /** Each group's rules, the first the context's own. @type {DebugRule[][]} */
    const groups = [[]];
    /** The pushed groups, for the pop's message. @type {DebugMessage[]} */
    const pushed = [];
    /** The program's callback and its parameter, zero for none. */
    let callback = { entry: 0, parameter: 0 };
    /** Labels kept on the objects themselves. @type {WeakMap<object, string>} */
    const ownLabels = new WeakMap();
    /** Labels kept by name. @type {Map<string, string>} */
    const namedLabels = new Map();

    const queries = kernel.side.queries ??= new Map();
    const pointers = kernel.side.pointerQueries ??= new Map();
    pointers.set(DEBUG.DEBUG_CALLBACK_FUNCTION, ()=>callback.entry);
    pointers.set(DEBUG.DEBUG_CALLBACK_USER_PARAM, ()=>callback.parameter);
    queries.set(DEBUG.DEBUG_LOGGED_MESSAGES, ()=>({ kind: 'int', values: [log.length] }));
    queries.set(DEBUG.DEBUG_NEXT_LOGGED_MESSAGE_LENGTH, ()=>({ kind: 'int',
        values: [log.length > 0 ? log[0].text.length + 1 : 0] }));
    queries.set(DEBUG.DEBUG_GROUP_STACK_DEPTH, ()=>({ kind: 'int', values: [groups.length] }));

    /** @param {DebugMessage} message @returns {boolean} whether its rules leave it on */
    const enabled = message=>{
        let on = message.severity !== DEBUG.SEVERITY_LOW;
        for (const rule of groups[groups.length - 1])
        {
            if ((rule.source === null || rule.source === message.source)
                && (rule.type === null || rule.type === message.type)
                && (rule.severity === null || rule.severity === message.severity)
                && (rule.ids === null || rule.ids.has(message.id)))
            {
                on = rule.enabled;
            }
        }
        return on;
    };

    /**
     * A message made: logged, or handed back for the callback; null when
     * debug output is off or its rules leave it off, or the log is full.
     *
     * @param {DebugMessage} message
     * @returns {{ message: DebugMessage, entry: number, parameter: number } | null}
     */
    const deliver = message=>{
        if (record(DEBUG.DEBUG_OUTPUT).values[0] === 0 || !enabled(message))
        {
            return null;
        }
        if (callback.entry !== 0)
        {
            return { message, entry: callback.entry, parameter: callback.parameter };
        }
        if (log.length < MAX_LOGGED)
        {
            log.push(message);
        }
        return null;
    };

    /** @param {number} value @param {ReadonlySet<number>} known */
    const orDontCare = (value, known)=>value === DEBUG.DONT_CARE || known.has(value);

    /**
     * The object a label names: itself where it can be told from its name,
     * its name otherwise; undefined for none.
     *
     * @param {number} identifier @param {number} name
     * @returns {object | string | undefined}
     */
    const labelled = (identifier, name)=>{
        const group = kernel.shareGroup();
        switch (identifier)
        {
            case DEBUG.BUFFER:
                return group.buffers.objects.get(name);
            case GL.TEXTURE:
                return group.textures.objects.get(name);
            case GL.FRAMEBUFFER:
                return context.framebufferNamed?.(name) ?? undefined;
            default: {
                const is = {
                    [DEBUG.SHADER]: 'glIsShader', [DEBUG.PROGRAM]: 'glIsProgram',
                    [DEBUG.VERTEX_ARRAY]: 'glIsVertexArray', [DEBUG.QUERY]: 'glIsQuery',
                    [DEBUG.SAMPLER]: 'glIsSampler', [GL.RENDERBUFFER]: 'glIsRenderbuffer',
                    [DEBUG.TRANSFORM_FEEDBACK]: 'glIsTransformFeedback',
                    [SYNC_FENCE]: 'glIsSync',
                }[identifier];
                if (!is || typeof context[is] !== 'function')
                {
                    return undefined;
                }
                return context[is](name) === GL.TRUE ? `${identifier}:${name}` : undefined;
            }
        }
    };

    Object.assign(context, {
        /**
         * @param {number} source @param {number} type @param {number} severity
         * @param {readonly number[]} ids @param {boolean} on
         */
        glDebugMessageControl(source, type, severity, ids, on){
            if (!enter('glDebugMessageControl', [source, type, severity, ids, on]))
            {
                return;
            }
            if (!orDontCare(source, SOURCES) || !orDontCare(type, TYPES)
                || !orDontCare(severity, SEVERITIES))
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            if (ids.length > 0 && (source === DEBUG.DONT_CARE || type === DEBUG.DONT_CARE
                || severity !== DEBUG.DONT_CARE))
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            groups[groups.length - 1].push({
                source: source === DEBUG.DONT_CARE ? null : source,
                type: type === DEBUG.DONT_CARE ? null : type,
                severity: severity === DEBUG.DONT_CARE ? null : severity,
                ids: ids.length > 0 ? new Set(ids) : null,
                enabled: on,
            });
        },

        /**
         * @param {number} source @param {number} type @param {number} id
         * @param {number} severity @param {string} text
         * @returns {{ message: DebugMessage, entry: number, parameter: number } | null}
         *     the message for the program's callback, if it goes there
         */
        glDebugMessageInsert(source, type, id, severity, text){
            if (!enter('glDebugMessageInsert', [source, type, id, severity, text]))
            {
                return null;
            }
            if ((source !== DEBUG.SOURCE_APPLICATION && source !== DEBUG.SOURCE_THIRD_PARTY)
                || !TYPES.has(type) || !SEVERITIES.has(severity))
            {
                setError(GL.INVALID_ENUM);
                return null;
            }
            if (text.length >= MAX_MESSAGE_LENGTH)
            {
                setError(GL.INVALID_VALUE);
                return null;
            }
            return deliver({ source, type, id, severity, text });
        },

        /**
         * glDebugMessageCallback: the program's function and its parameter.
         *
         * @param {number} entry @param {number} parameter
         */
        debugMessageCallback(entry, parameter){
            if (enter('debugMessageCallback', [entry, parameter]))
            {
                callback = { entry, parameter };
            }
        },

        /** @returns {{ entry: number, parameter: number }} the callback, for glGetPointerv */
        debugCallback(){
            return { ...callback };
        },

        /**
         * Takes up to `count` messages from the log, oldest first, stopping
         * at the first whose text does not fit what is left of `room`.
         *
         * @param {number} count @param {number | null} room  null: no text is asked for
         * @returns {DebugMessage[] | null}
         */
        glGetDebugMessageLog(count, room){
            if (!enter('glGetDebugMessageLog', [count, room]))
            {
                return null;
            }
            if (room !== null && room < 0)
            {
                setError(GL.INVALID_VALUE);
                return null;
            }
            const taken = [];
            let left = room;
            while (taken.length < count && log.length > 0)
            {
                const size = log[0].text.length + 1;
                if (left !== null)
                {
                    if (size > left)
                    {
                        break;
                    }
                    left -= size;
                }
                taken.push(/** @type {DebugMessage} */ (log.shift()));
            }
            return taken;
        },

        /**
         * @param {number} source @param {number} id @param {string} text
         * @returns {{ message: DebugMessage, entry: number, parameter: number } | null}
         */
        glPushDebugGroup(source, id, text){
            if (!enter('glPushDebugGroup', [source, id, text]))
            {
                return null;
            }
            if (source !== DEBUG.SOURCE_APPLICATION && source !== DEBUG.SOURCE_THIRD_PARTY)
            {
                setError(GL.INVALID_ENUM);
                return null;
            }
            if (text.length >= MAX_MESSAGE_LENGTH)
            {
                setError(GL.INVALID_VALUE);
                return null;
            }
            if (groups.length >= MAX_GROUP_DEPTH)
            {
                setError(GL.STACK_OVERFLOW);
                return null;
            }
            /** @type {DebugMessage} */
            const message = { source, type: DEBUG.TYPE_PUSH_GROUP, id,
                severity: DEBUG.SEVERITY_NOTIFICATION, text };
            const delivered = deliver(message);
            groups.push([...groups[groups.length - 1]]);
            pushed.push(message);
            return delivered;
        },

        /** @returns {{ message: DebugMessage, entry: number, parameter: number } | null} */
        glPopDebugGroup(){
            if (!enter('glPopDebugGroup', []))
            {
                return null;
            }
            if (groups.length === 1)
            {
                setError(GL.STACK_UNDERFLOW);
                return null;
            }
            groups.pop();
            const group = /** @type {DebugMessage} */ (pushed.pop());
            return deliver({ ...group, type: DEBUG.TYPE_POP_GROUP });
        },

        /**
         * glObjectLabel and glObjectPtrLabel (a sync's, `identifier` its
         * GL_SYNC_FENCE): `text` null takes the label away.
         *
         * @param {number} identifier @param {number} name @param {string | null} text
         */
        glObjectLabel(identifier, name, text){
            if (!enter('glObjectLabel', [identifier, name, text]))
            {
                return;
            }
            const object = labelled(identifier, name);
            if (object === undefined)
            {
                setError(identifier === GL.TEXTURE || identifier === DEBUG.BUFFER
                    || identifier === GL.FRAMEBUFFER || identifier === DEBUG.SHADER
                    || identifier === DEBUG.PROGRAM || identifier === DEBUG.VERTEX_ARRAY
                    || identifier === DEBUG.QUERY || identifier === DEBUG.SAMPLER
                    || identifier === GL.RENDERBUFFER || identifier === DEBUG.TRANSFORM_FEEDBACK
                    || identifier === DEBUG.PROGRAM_PIPELINE || identifier === SYNC_FENCE
                    ? GL.INVALID_VALUE : GL.INVALID_ENUM);
                return;
            }
            if (text !== null && text.length >= MAX_LABEL_LENGTH)
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            if (typeof object === 'string')
            {
                if (text === null || text === '')
                {
                    namedLabels.delete(object);
                }
                else
                {
                    namedLabels.set(object, text);
                }
            }
            else if (object)
            {
                if (text === null || text === '')
                {
                    ownLabels.delete(object);
                }
                else
                {
                    ownLabels.set(object, text);
                }
            }
        },

        /**
         * @param {number} identifier @param {number} name
         * @returns {string | null}  the label, empty for none
         */
        glGetObjectLabel(identifier, name){
            if (!enter('glGetObjectLabel', [identifier, name]))
            {
                return null;
            }
            const object = labelled(identifier, name);
            if (object === undefined)
            {
                setError(GL.INVALID_VALUE);
                return null;
            }
            return typeof object === 'string' ? namedLabels.get(object) ?? ''
                : object ? ownLabels.get(object) ?? '' : '';
        },
    });
}
