/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * Two symbols the compiler references directly rather than through an import,
 * which the C runtime's own static library would otherwise have supplied: the
 * vtable every type descriptor's first word points at, and the marker that
 * says the program uses floating point. Neither is read by anything the
 * fixtures exercise.
 */

const void *type_info_vftable[2] __asm__("??_7type_info@@6B@") = { 0, 0 };
int _fltused = 0;
