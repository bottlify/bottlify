/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The window classes a process registered, as Windows keeps them: a local
 * class is one module's - two modules may each register one of a name - and
 * a global class (CS_GLOBALCLASS at registration) is the process's, one of a
 * name. Windows looks a name up in the module's local classes, then the
 * global ones, then the system's ("How the System Locates a Window Class");
 * a module is told apart by its handle's high word, so a handle that differs
 * in the low word is the same module. The newest registration is found first.
 *
 * What each call asks of the instance is Wine's class test's
 * (test_instances), as Windows answers it:
 *   - registering: none is the program's own module; user32's is refused;
 *   - GetClassInfo: none is user32's, whose local classes are only those a
 *     program moved there with SetClassLongPtr(GCLP_HMODULE);
 *   - CreateWindow: none takes the newest local class of the name, any module's;
 *   - UnregisterClass: none is the program's own module.
 * A class's module may be changed after it is registered and is looked up by
 * its current one; whether it is global is decided once, at registration.
 */

import { wholeAddress } from '../common/pointers.js';

const CS_GLOBALCLASS = 0x4000;

const ERROR_INVALID_PARAMETER = 87;
const ERROR_CLASS_ALREADY_EXISTS = 1410;

/** @typedef {'register' | 'info' | 'create' | 'unregister'} Asking */

/**
 * @param {Object} options
 * @param {() => number} options.main    the program's own module handle
 * @param {() => number} options.user32  user32's module handle
 * @param {(name: string) => boolean} options.isSystem  a system class of the name exists
 */
export function createClassRegistry({ main, user32, isSystem }){
    /** Newest first. @type {any[]} */
    const list = [];

    /** @param {number} a @param {number} b */
    const sameModule = (a, b)=>Math.floor(wholeAddress(a) / 0x10000)
        === Math.floor(wholeAddress(b) / 0x10000);

    /** @param {any} cls @param {string} folded */
    const named = (cls, folded)=>cls.name.toLowerCase() === folded;

    /**
     * The module a call's instance stands for, for that call.
     *
     * @param {number} instance @param {Asking} asking
     * @returns {number | null}  null: any module's
     */
    const moduleFor = (instance, asking)=>{
        if (instance !== 0)
        {
            return wholeAddress(instance);
        }
        return asking === 'info' ? user32() : asking === 'create' ? null : main();
    };

    /**
     * A program class by name for a call: the module's local class, else the
     * global one; null when neither - the caller then looks among the
     * system's.
     *
     * @param {string} name @param {number} instance @param {Asking} asking
     */
    const find = (name, instance, asking)=>{
        const folded = name.toLowerCase();
        const module = moduleFor(instance, asking);
        return list.find(cls=>!cls.global && named(cls, folded)
            && (module === null || sameModule(cls.instance, module)))
            ?? list.find(cls=>cls.global && named(cls, folded)) ?? null;
    };

    return {
        find,

        /**
         * Files a class, or says why it cannot be: an error code. The class
         * object is the caller's, with `name`, `style` and `instance`; its
         * instance is settled here.
         *
         * @param {any} cls
         * @returns {number}  0, or the error code
         */
        add(cls){
            const instance = cls.instance === 0 ? main() : wholeAddress(cls.instance);
            if (user32() !== 0 && sameModule(instance, user32()))
            {
                return ERROR_INVALID_PARAMETER;
            }
            const global = (cls.style & CS_GLOBALCLASS) !== 0;
            const folded = cls.name.toLowerCase();
            const taken = list.some(other=>named(other, folded)
                && (other.global || (!global && sameModule(other.instance, instance))))
                || (global && isSystem(cls.name));
            if (taken)
            {
                return ERROR_CLASS_ALREADY_EXISTS;
            }
            cls.instance = instance;
            cls.global = global;
            list.unshift(cls);
            return 0;
        },

        /** @param {any} cls */
        remove(cls){
            const at = list.indexOf(cls);
            if (at >= 0)
            {
                list.splice(at, 1);
            }
        },

        /** @param {any} cls */
        has: cls=>list.includes(cls),

        /**
         * The instance GetClassInfo reports: a local class's own module; for
         * a global or system class the one asked by, user32's reading as none.
         *
         * @param {any} cls @param {number} asked
         */
        reportedInstance: (cls, asked)=>{
            if (list.includes(cls) && !cls.global)
            {
                return wholeAddress(cls.instance);
            }
            return user32() !== 0 && sameModule(asked, user32()) ? 0 : wholeAddress(asked);
        },

        /** Every class, newest first. */
        all: ()=>[...list],
    };
}
