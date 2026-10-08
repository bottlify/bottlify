/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * CLSID_VBScript, ProgID "VBScript" (and "VBS"): the engine as a program
 * hosts it, through the shared Active Scripting host
 * (`script/active-script.js`) -- the same IActiveScript, IActiveScriptParse
 * and IObjectSafety JScript is hosted through. What is VBScript's here is
 * only which engine the host makes, how its objects cross into COM, and
 * that GetScriptDispatch answers the script's global namespace.
 *
 * MsgBox and InputBox need the site's window (IActiveScriptSiteWindow),
 * which is not asked for: in a hosted script both are error 70, as in a
 * host that lends no window.
 */

import { activeScript as hostedScript } from '../script/active-script.js';
import { createScriptCom, globalTarget } from './dispatch.js';
import { createVBScriptEngine } from './engine.js';

/**
 * @typedef {import('../script/active-script.js').ActiveScriptHost} ActiveScriptHost
 * @typedef {import('./engine.js').VBScriptEngine} VBScriptEngine
 * @typedef {import('../ole32/objects.js').ComClassDefinition} ComClassDefinition
 */

export const CLSID_VBSCRIPT = '{B54F3741-5B07-11CF-A4B0-00AA004A55E8}';
export const PROGID_VBSCRIPT = 'VBScript';
/** The names CLSIDFromProgID finds the class by. */
export const VBSCRIPT_PROGIDS = Object.freeze(['VBScript', 'VBS']);

/** @type {import('../script/active-script.js').ActiveScriptLanguage<VBScriptEngine>} */
export const VBSCRIPT_LANGUAGE = Object.freeze({
    clsid: CLSID_VBSCRIPT,
    caseInsensitive: true,
    createEngine: options=>createVBScriptEngine({
        version: options.version,
        now: options.now,
        localOffset: options.localOffset,
        checkpoint: options.checkpoint,
        divergence: options.divergence,
        createObject: options.createObject,
    }),
    createCom: createScriptCom,
    exportGlobal: (engine, { server })=>server.export(engine.interpreter,
        ()=>globalTarget(engine)),
});

/**
 * Puts CLSID_VBScript where CoCreateInstance finds it.
 *
 * @param {ActiveScriptHost} host
 */
export function registerVBScriptClass(host){
    host.registry.registerClass(CLSID_VBSCRIPT, ()=>activeScript(host));
}

/**
 * One engine instance as a COM object.
 *
 * @param {ActiveScriptHost} host @returns {ComClassDefinition}
 */
export function activeScript(host){
    return hostedScript(host, VBSCRIPT_LANGUAGE);
}
