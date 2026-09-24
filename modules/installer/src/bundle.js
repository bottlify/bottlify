/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Reading a bundle on the host, for a server that has to hand a page a file
 * out of one before the engine exists -- a launcher serving a program's entry
 * image. The reader is the one the bundle tools use.
 */

export { openBundle } from '../../../tools/btl.mjs';
