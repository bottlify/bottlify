/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { assembleModules } from '../../src/core.js';

const core = await assembleModules({});
const modules = core.diagnostics().map(entry=>`${entry.name}[${entry.status}]`);

self.onmessage = event=>{
    const message = event.data;
    if (message && message.peer === 'bottlify-probe' && message.verb === 'ping')
    {
        self.postMessage({
            peer: 'bottlify-probe',
            verb: 'pong',
            modules,
            coreVersion: '0.0.0',
        });
    }
};
