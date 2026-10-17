/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Where a module finds its executor's state block and tables.
 *
 * Under a layout of one executor's own (`ownLayout`, `executorLayout`) both are
 * constants of the layout: an access is `i32.const 0` and the field's address
 * as its offset, and the module runs on that executor alone. Under the
 * process's shared layout (`sharedLayout`) the fields are offsets from two
 * bases each instance is given as immutable globals, `stateBase` and
 * `tablesBase`: the bytes of a translation are then the same for every
 * executor of the process, so a region is translated, stored and compiled once
 * and every executor instantiates it over its own state.
 *
 * An access that adds a computed index to a field's offset -- a slot of the
 * entry hash, a frame of the call stack -- moves the computed address to the
 * executor's (`intoTables`, `intoState`); under one executor's layout that is
 * nothing at all, and its bytes are what they were.
 */

import { ValType } from '../wasm/encoder.js';

/** i32.add. */
const I32_ADD = 0x6a;

/**
 * @typedef {{ stateBase?: number, tablesBase?: number }} Bases
 *     the globals' indices, absent under a layout of one executor's own
 * @typedef {import('../wasm/encoder.js').Body} Body
 */

/**
 * The two globals, imported under the shared layout; none otherwise. Called
 * before the module defines a global of its own.
 *
 * @param {import('../wasm/encoder.js').ModuleBuilder} m
 * @param {{ shared?: boolean }} layout
 * @returns {Bases}
 */
export function importBases(m, layout){
    if (layout.shared !== true)
    {
        return {};
    }
    return {
        stateBase: m.importGlobal('env', 'stateBase', ValType.i32, false),
        tablesBase: m.importGlobal('env', 'tablesBase', ValType.i32, false),
    };
}

/**
 * The address a state field's offset is taken from: 0, or the instance's state base.
 *
 * @param {Bases} bases @param {Body} b
 */
export const atState = (bases, b)=>(bases.stateBase === undefined
    ? b.i32const(0) : b.globalGet(bases.stateBase));

/**
 * The address a table's offset is taken from: 0, or the instance's tables.
 *
 * @param {Bases} bases @param {Body} b
 */
export const atTables = (bases, b)=>(bases.tablesBase === undefined
    ? b.i32const(0) : b.globalGet(bases.tablesBase));

/**
 * An address computed from a table's offset, on the stack, moved to the
 * instance's tables: nothing under one executor's layout.
 *
 * @param {Bases} bases @param {Body} b
 */
export const intoTables = (bases, b)=>(bases.tablesBase === undefined
    ? b : b.globalGet(bases.tablesBase).op(I32_ADD));

/**
 * The same for an address computed from a state field's offset.
 *
 * @param {Bases} bases @param {Body} b
 */
export const intoState = (bases, b)=>(bases.stateBase === undefined
    ? b : b.globalGet(bases.stateBase).op(I32_ADD));
