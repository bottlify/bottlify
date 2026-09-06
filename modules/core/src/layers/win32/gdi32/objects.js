/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

/**
 * The GDI object table: pens, brushes, fonts, bitmaps, regions and palettes.
 *
 * A GDI object is nothing but a type, the attributes it was created from, and
 * the number of places that currently point at it. That count is the whole
 * reason this is a table rather than a map: Windows refuses to delete an object
 * while a device context has it selected, and it refuses because the DC would
 * otherwise be left naming a handle that has been handed out again to somebody
 * else. Everything a drawing layer will eventually need lives in `attributes`;
 * nothing here knows what a pen looks like.
 *
 * Handles come from the process handle table, and are closed only when the last
 * reference goes -- so a table that recycles handle values can never hand out
 * one that something still refers to.
 */

/**
 * @typedef {'pen' | 'brush' | 'font' | 'bitmap' | 'region' | 'palette'} GdiObjectType
 */

/**
 * @typedef {Object} GdiObject
 * @property {number} handle
 * @property {GdiObjectType} type
 * @property {any} attributes         What the object was created from.
 * @property {number} selectCount     DCs and saved DC states pointing at it.
 * @property {boolean} stock          Stock objects outlive every process that uses them.
 */

/**
 * @typedef {Object} HandleTable
 * @property {(type: string, object: any) => number} open
 * @property {(handle: number) => any} close
 */

/**
 * @param {HandleTable} handles
 */
export function createGdiObjects(handles){
    /** @type {Map<number, GdiObject>} */
    const objects = new Map();

    /**
     * @param {GdiObjectType} type
     * @param {any} attributes
     * @param {boolean} stock
     * @returns {number}
     */
    const add = (type, attributes, stock)=>{
        /** @type {GdiObject} */
        const record = { handle: 0, type, attributes, selectCount: 0, stock };
        record.handle = handles.open('gdi', record);
        objects.set(record.handle, record);
        return record.handle;
    };

    return {
        /**
         * @param {GdiObjectType} type
         * @param {any} attributes
         * @returns {number} the handle the guest names it by
         */
        create: (type, attributes)=>add(type, attributes, false),

        /**
         * @param {GdiObjectType} type
         * @param {any} attributes
         * @returns {number}
         */
        defineStock: (type, attributes)=>add(type, attributes, true),

        /** @param {number} handle @returns {GdiObject | null} */
        get: handle=>objects.get(handle >>> 0) ?? null,

        /** @param {number} handle */
        retain(handle){
            const record = objects.get(handle >>> 0);
            if (record)
            {
                record.selectCount++;
            }
        },

        /** @param {number} handle */
        release(handle){
            const record = objects.get(handle >>> 0);
            if (record && record.selectCount > 0)
            {
                record.selectCount--;
            }
        },

        /**
         * DeleteObject's whole contract.
         *
         * @param {number} handle
         * @returns {boolean} what DeleteObject reports
         */
        remove(handle){
            const record = objects.get(handle >>> 0);
            if (!record)
            {
                return false;
            }
            if (record.stock)
            {
                // Documented as harmless rather than as an error: programs delete
                // whatever SelectObject handed back to them, stock or not.
                return true;
            }
            if (record.selectCount > 0)
            {
                return false;
            }
            objects.delete(record.handle);
            handles.close(record.handle);
            return true;
        },

        /** @returns {number} how many objects are alive, for diagnostics */
        count: ()=>objects.size,
    };
}
