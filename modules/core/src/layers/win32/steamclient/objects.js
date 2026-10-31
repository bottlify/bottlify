/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The client's interfaces as a game holds them: a C++ object whose first word
 * points at its vtable, every slot a thiscall method placed by the engine,
 * laid out by the version the game asked for (`interfaces.js`). What a method
 * does is decided by its name, the same in every version that has it; a
 * method no behaviour answers returns zero, which every Steamworks method
 * reads as "no", "none" or "not yet", and says so once.
 */

import { INTERFACES } from './interfaces.js';
import { pointerWidth } from '../common/pointers.js';

/**
 * @typedef {Object} SteamObjectsHost
 * @property {(name: string, fn: { convention: 'thiscall', argBytes: number,
 *     handler: (args: number[]) => number, quadwords?: number[],
 *     floats?: Record<number, 'f32' | 'f64'> }) => number} register
 * @property {(bytes: number) => number} allocate
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(high: number) => void} answerHigh  EDX of a method returning eight bytes.
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {4 | 8} [pointerSize]  8 in a 64-bit process: its vtables' slots
 *     and an object's word are eight bytes.
 */

/**
 * What a method answers: a number for EAX, a bigint for eight bytes (EDX:EAX
 * or the class a hidden pointer receives), or undefined for zero.
 *
 * @typedef {(args: number[], version: string) => number | bigint | undefined} Behaviour
 */

/**
 * @param {SteamObjectsHost} host
 * @param {Record<string, Behaviour>} behaviours  By method name.
 */
export function createSteamObjects(host, behaviours){
    /** @type {Map<string, number>} each version's object, made once */
    const objects = new Map();
    const width = pointerWidth(host.pointerSize ?? 4);
    /** @type {Set<string>} */
    const said = new Set();

    /** @param {number} address @param {bigint} value */
    const writeQword = (address, value)=>{
        const bytes = new Uint8Array(8);
        new DataView(bytes.buffer).setBigUint64(0, BigInt.asUintN(64, value), true);
        host.writeMemory(address >>> 0, bytes);
    };

    /**
     * One vtable slot.
     *
     * @param {string} version @param {string} entry  `name:bytes:return`.
     */
    const slot = (version, entry)=>{
        const [name, bytesText, kind, wideText = ''] = entry.split(':');
        const throughPointer = kind.startsWith('s');
        // `this` counted, and a hidden return pointer pushed before the rest.
        const argBytes = 4 + Number(bytesText) + (throughPointer ? 4 : 0);
        // What an x86-64 caller passes whole in one slot or in an XMM
        // register, by the dword it starts at among all the handler's.
        const first = throughPointer ? 2 : 1;
        const wide = wideText === '' ? [] : wideText.split('.')
            .map(each=>({ word: first + Number.parseInt(each, 10), kind: each.at(-1) }));
        const quadwords = wide.filter(each=>each.kind === 'q').map(each=>each.word);
        /** @type {Record<number, 'f32' | 'f64'>} */
        const floats = Object.fromEntries(wide.filter(each=>each.kind !== 'q')
            .map(each=>[each.word, each.kind === 'd' ? 'f64' : 'f32']));
        return host.register(`${version}.${name}`, {
            convention: 'thiscall',
            argBytes,
            ...quadwords.length > 0 ? { quadwords } : {},
            ...Object.keys(floats).length > 0 ? { floats } : {},
            handler: args=>{
                const behaviour = behaviours[name];
                const given = throughPointer ? args.slice(2) : args.slice(1);
                const answer = behaviour ? behaviour(given, version) : undefined;
                // A void method -- a setter, a notification -- has nothing to
                // answer; only one whose answer is our zero is said.
                if (!behaviour && kind !== 'v' && !said.has(`${version}.${name}`))
                {
                    said.add(`${version}.${name}`);
                    host.divergence?.(`${version}.${name}`, 'not answered yet: zero');
                }
                if (throughPointer)
                {
                    const out = args[1] >>> 0;
                    writeQword(out, typeof answer === 'bigint' ? answer : 0n);
                    return out;
                }
                if (kind === 'q')
                {
                    const value = BigInt.asUintN(64, BigInt(answer ?? 0));
                    host.answerHigh(Number(value >> 32n));
                    return Number(value & 0xffffffffn);
                }
                return typeof answer === 'bigint' ? Number(answer & 0xffffffffn) : (answer ?? 0);
            },
        });
    };

    return {
        /**
         * The object for a version string, or 0 for a version nobody declared.
         *
         * @param {string} version
         */
        objectFor(version){
            if (objects.has(version))
            {
                return /** @type {number} */ (objects.get(version));
            }
            const layout = INTERFACES[version];
            if (!layout)
            {
                return 0;
            }
            const methods = layout.split(',').map(entry=>slot(version, entry));
            const table = host.allocate(methods.length * width.size) >>> 0;
            host.writeMemory(table, width.array(methods).subarray(0, methods.length * width.size));
            // The object: its vtable pointer, and room past it nobody reads.
            const object = host.allocate(16) >>> 0;
            host.writeMemory(object, width.bytes(table));
            objects.set(version, object);
            return object;
        },
    };
}
