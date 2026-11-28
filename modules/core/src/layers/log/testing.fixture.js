/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { createLogModule } from './module.js';

/**
 * A log layer of its own, as a test that builds another layer alone hands
 * it: the real one, its journal and tables in memory.
 */
export const testLog = ()=>createLogModule().create({});

/**
 * A module host for a test that builds a layer requiring only the log, with
 * a real one.
 */
export const logHost = async()=>{
    const log = await testLog();
    return { requireApi: (/** @type {string} */ name)=>{
        if (name !== 'log')
        {
            throw new Error(`requireApi("${name}") of a host that holds only a log`);
        }
        return log;
    }, provide: ()=>{} };
};
