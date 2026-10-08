/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * CLSID_JScript, ProgID "JScript": the engine as a program hosts it, through
 * the shared Active Scripting host (`script/active-script.js`). What is
 * JScript's here is only which engine the host makes, how its objects cross
 * into COM, and that GetScriptDispatch answers the global object.
 */

import { activeScript as hostedScript } from '../script/active-script.js';
import { createScriptCom, objectTarget } from './dispatch.js';
import { createJScriptEngine } from './engine.js';

/**
 * @typedef {import('../script/active-script.js').ActiveScriptHost} ActiveScriptHost
 * @typedef {import('./engine.js').JScriptEngine} JScriptEngine
 * @typedef {import('../ole32/objects.js').ComClassDefinition} ComClassDefinition
 */

export {
    IID_IACTIVESCRIPT, IID_IACTIVESCRIPTERROR, IID_IACTIVESCRIPTPARSE32, IID_IACTIVESCRIPTSITE,
    IID_IOBJECTSAFETY, SCRIPTITEM_GLOBALMEMBERS, SCRIPTITEM_ISVISIBLE, SCRIPTSTATE_CLOSED,
    SCRIPTSTATE_CONNECTED, SCRIPTSTATE_DISCONNECTED, SCRIPTSTATE_INITIALIZED, SCRIPTSTATE_STARTED,
    SCRIPTSTATE_UNINITIALIZED, SCRIPTTEXT_ISEXPRESSION, SCRIPT_E_REPORTED,
} from '../script/active-script.js';

export const CLSID_JSCRIPT = '{F414C260-6AC0-11CF-B6D1-00AA00BBBB58}';
export const PROGID_JSCRIPT = 'JScript';

/** @type {import('../script/active-script.js').ActiveScriptLanguage<JScriptEngine>} */
export const JSCRIPT_LANGUAGE = Object.freeze({
    clsid: CLSID_JSCRIPT,
    createEngine: options=>createJScriptEngine({
        version: options.version,
        now: options.now,
        localOffset: options.localOffset,
        checkpoint: options.checkpoint,
        divergence: options.divergence,
        createObject: /** @type {any} */ (options.createObject),
    }),
    createCom: createScriptCom,
    exportGlobal: (engine, { server })=>{
        const global = engine.global;
        return server.export(global, ()=>objectTarget(engine, global));
    },
});

/**
 * Puts CLSID_JScript where CoCreateInstance finds it.
 *
 * @param {ActiveScriptHost} host
 */
export function registerJScriptClass(host){
    host.registry.registerClass(CLSID_JSCRIPT, ()=>activeScript(host));
}

/**
 * One engine instance as a COM object.
 *
 * @param {ActiveScriptHost} host @returns {ComClassDefinition}
 */
export function activeScript(host){
    return hostedScript(host, JSCRIPT_LANGUAGE);
}
