/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * `_pipe`'s pipes: a queue of bytes with a descriptor at each end, inside the
 * process.
 *
 * A pipe stands where a file's node stands, so the descriptors on it are
 * read and written by the same code as a file's: the volume the runtime
 * reads through is wrapped, and a node that is a pipe is answered here. Each
 * end keeps its position as a file descriptor does. The reading end's is the
 * count of bytes taken, so a read at it takes what was written after them,
 * and the byte text mode looks at past a CR -- which the runtime keeps aside
 * for a pipe, since a pipe cannot seek back -- is looked at without being
 * taken. The writing end adds to the end whatever its position.
 *
 * A read of an empty pipe answers nothing at once rather than waiting for a
 * writer: the pipe has no second thread of the process to wait on, and the
 * end of the data is what a reader of a closed pipe sees.
 */

/** The bytes a pipe drops once read past, so a long-lived one does not grow. */
const KEEP = 4096;

/** A pipe: the bytes not yet dropped, and where the first of them is. */
export class Pipe {
    /** The offset of `bytes[0]` in everything ever written. */
    base = 0;

    bytes = new Uint8Array(0);

    /** The ends open, each descriptor's hold counted. */
    holds = 2;

    /** The bytes written and not taken by a read at `position`. @param {number} position */
    available(position){
        return Math.max(0, this.base + this.bytes.length - position);
    }
}

/**
 * The volume with pipes in it: a node that is a Pipe is read, written,
 * held and closed here, everything else is the volume's.
 *
 * @template {{ read: Function, write: Function, close: Function, retain?: Function }} T
 * @param {T} files
 * @returns {T}
 */
export function withPipes(files){
    const own = {
        /** @param {any} node @param {number} offset @param {number} length */
        read(node, offset, length){
            if (!(node instanceof Pipe))
            {
                return files.read(node, offset, length);
            }
            const start = Math.max(0, offset - node.base);
            const taken = node.bytes.slice(start, start + length);
            if (start > KEEP)
            {
                node.bytes = node.bytes.slice(start);
                node.base += start;
            }
            return taken;
        },

        /** @param {any} node @param {number} offset @param {Uint8Array} bytes */
        write(node, offset, bytes){
            if (!(node instanceof Pipe))
            {
                return files.write(node, offset, bytes);
            }
            const grown = new Uint8Array(node.bytes.length + bytes.length);
            grown.set(node.bytes);
            grown.set(bytes, node.bytes.length);
            node.bytes = grown;
            return offset + bytes.length;
        },

        /** @param {any} node */
        retain(node){
            if (node instanceof Pipe)
            {
                node.holds++;
                return;
            }
            files.retain?.(node);
        },

        /** @param {any} node */
        close(node){
            if (!(node instanceof Pipe))
            {
                return files.close(node);
            }
            node.holds = Math.max(0, node.holds - 1);
            if (node.holds === 0)
            {
                node.bytes = new Uint8Array(0);
            }
            return true;
        },
    };
    // The volume's other calls are its own, bound to it, whatever kind of
    // object it is.
    return /** @type {T} */ (new Proxy(files, {
        get(target, key){
            if (Object.hasOwn(own, key))
            {
                return own[/** @type {keyof typeof own} */ (key)];
            }
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    }));
}
