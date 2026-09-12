/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The reading side of the log, for whoever holds the memory the engine
 * publishes into: a page, a worker of the reader's own. Imported by the host
 * without the rest of the layer, since the reader is built over memory, not
 * over the module.
 */

export { createLogReader } from './internal/reader.js';
