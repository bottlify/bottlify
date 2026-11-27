/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Debug output's entry points (OpenGL 4.3 chapter 20, GL_KHR_debug, and
 * GL_ARB_debug_output's spellings), over `context-debug.js`.
 *
 * A message the program's callback is to see is shown to it before the call
 * that made it returns: its text is put in guest memory and the callback
 * called with the seven arguments of GLDEBUGPROC, stdcall like every GL
 * callback. Those calls may wait, so they are answered as the swaps are.
 */

/** GL_SYNC_FENCE, the identifier a sync's label is kept under (`context-debug.js`). */
const SYNC_FENCE = 0x9116;

/**
 * @typedef {Object} DebugHelpers
 * @property {() => any} current
 * @property {(body: (context: any) => any) => number} call
 * @property {(value: any) => number} answer
 * @property {(type: string, address: number, count: number) => number[]} readTyped
 * @property {(address: number, values: number[]) => void} writeU32s
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number) => string} readText  to its terminator
 * @property {((call: { entry: number, args: number[] }) => Promise<number>) | undefined}
 *     callGuest
 * @property {((bytes: number) => number) | undefined} allocate
 * @property {((address: number) => void) | undefined} free
 * @property {(detail: string, severity?: 'loss') => void} divergence
 */

/**
 * @param {DebugHelpers} h
 * @returns {{ plain: Record<string, (args: number[]) => number>,
 *     waiting: Record<string, (args: number[]) => number | Promise<number>> }}
 */
export function debugEntryPoints(h){
    const { current, call, answer, readTyped, writeU32s } = h;

    /** @param {number} address @param {number} length  negative: to its terminator */
    const textAt = (address, length)=>{
        if ((address >>> 0) === 0)
        {
            return null;
        }
        if ((length | 0) < 0)
        {
            return h.readText(address >>> 0);
        }
        return String.fromCharCode(...h.readMemory(address >>> 0, length | 0));
    };

    /** @param {string} text @returns {Uint8Array} its bytes and a terminator */
    const bytesOf = text=>{
        const bytes = new Uint8Array(text.length + 1);
        for (let k = 0; k < text.length; k++)
        {
            bytes[k] = text.charCodeAt(k) & 0xff;
        }
        return bytes;
    };

    /**
     * Shows the program's callback a message, if the call made one for it.
     *
     * @param {{ message: import('./context-debug.js').DebugMessage, entry: number,
     *     parameter: number } | null | undefined} delivered
     * @returns {number | Promise<number>}
     */
    const show = delivered=>{
        if (!delivered)
        {
            return 0;
        }
        const address = h.callGuest && h.allocate
            ? h.allocate(delivered.message.text.length + 1) : 0;
        if (!h.callGuest || address === 0)
        {
            h.divergence('a debug message was not shown to the program\'s callback: no way'
                + ' into guest code or memory for its text', 'loss');
            return 0;
        }
        const { message } = delivered;
        h.writeMemory(address, bytesOf(message.text));
        return h.callGuest({ entry: delivered.entry, args: [message.source, message.type,
            message.id, message.severity, message.text.length, address, delivered.parameter] })
            .then(()=>{
                h.free?.(address);
                return 0;
            });
    };

    /**
     * A label answered into the caller's buffer as the GL's string getters
     * answer: at most `size` bytes with the terminator.
     *
     * @param {string | null} text @param {number} size @param {number} lengthOut
     * @param {number} out
     */
    const answerLabel = (text, size, lengthOut, out)=>{
        if (text === null)
        {
            return;
        }
        const kept = text.slice(0, Math.max(0, (size | 0) - 1));
        if ((size | 0) > 0 && (out >>> 0) !== 0)
        {
            h.writeMemory(out >>> 0, bytesOf(kept));
        }
        if ((lengthOut >>> 0) !== 0)
        {
            writeU32s(lengthOut, [(out >>> 0) === 0 ? text.length : kept.length]);
        }
    };

    /** @type {Record<string, (args: number[]) => number>} */
    const plain = {
        glDebugMessageControl: ([source, type, severity, count, ids, enabled])=>call(context=>
            context.glDebugMessageControl(source >>> 0, type >>> 0, severity >>> 0,
                (count | 0) > 0 && (ids >>> 0) !== 0 ? readTyped('ui', ids, count | 0) : [],
                (enabled & 0xff) !== 0)),
        glDebugMessageCallback: ([entry, parameter])=>answer(current()?.debugMessageCallback(
            entry >>> 0, parameter >>> 0)),
        glGetDebugMessageLog: ([count, size, sources, types, ids, severities, lengths, log])=>{
            const context = current();
            const messages = context?.glGetDebugMessageLog(Math.max(0, count | 0),
                (log >>> 0) !== 0 ? size | 0 : null);
            if (!messages)
            {
                return 0;
            }
            /** @param {number} address @param {(m: any) => number} pick */
            const fill = (address, pick)=>{
                if ((address >>> 0) !== 0 && messages.length > 0)
                {
                    writeU32s(address, messages.map(pick));
                }
            };
            fill(sources, m=>m.source);
            fill(types, m=>m.type);
            fill(ids, m=>m.id);
            fill(severities, m=>m.severity);
            fill(lengths, m=>m.text.length + 1);
            if ((log >>> 0) !== 0 && messages.length > 0)
            {
                const joined = messages.map(
                    (/** @type {import('./context-debug.js').DebugMessage} */ m)=>bytesOf(m.text));
                const all = new Uint8Array(joined.reduce(
                    (/** @type {number} */ sum, /** @type {Uint8Array} */ b)=>sum + b.length, 0));
                let at = 0;
                for (const bytes of joined)
                {
                    all.set(bytes, at);
                    at += bytes.length;
                }
                h.writeMemory(log >>> 0, all);
            }
            return messages.length;
        },
        glObjectLabel: ([identifier, name, length, label])=>answer(current()?.glObjectLabel(
            identifier >>> 0, name >>> 0, textAt(label, length))),
        glGetObjectLabel: ([identifier, name, size, length, out])=>call(context=>answerLabel(
            context.glGetObjectLabel(identifier >>> 0, name >>> 0), size, length, out)),
        glObjectPtrLabel: ([sync, length, label])=>answer(current()?.glObjectLabel(SYNC_FENCE,
            sync >>> 0, textAt(label, length))),
        glGetObjectPtrLabel: ([sync, size, length, out])=>call(context=>answerLabel(
            context.glGetObjectLabel(SYNC_FENCE, sync >>> 0), size, length, out)),
    };

    /** @type {Record<string, (args: number[]) => number | Promise<number>>} */
    const waiting = {
        glDebugMessageInsert: ([source, type, id, severity, length, text])=>show(
            current()?.glDebugMessageInsert(source >>> 0, type >>> 0, id >>> 0, severity >>> 0,
                textAt(text, length) ?? '')),
        glPushDebugGroup: ([source, id, length, text])=>show(current()?.glPushDebugGroup(
            source >>> 0, id >>> 0, textAt(text, length) ?? '')),
        glPopDebugGroup: ()=>show(current()?.glPopDebugGroup()),
    };

    // GL_ARB_debug_output's spellings of the same four.
    plain.glDebugMessageControlARB = plain.glDebugMessageControl;
    plain.glDebugMessageCallbackARB = plain.glDebugMessageCallback;
    plain.glGetDebugMessageLogARB = plain.glGetDebugMessageLog;
    waiting.glDebugMessageInsertARB = waiting.glDebugMessageInsert;
    return { plain, waiting };
}
