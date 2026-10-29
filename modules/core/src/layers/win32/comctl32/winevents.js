/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The accessibility events the common controls raise: a change a screen
 * reader would want to hear of, told through NotifyWinEvent about the
 * control's client area (OBJID_CLIENT). The child is an item by its index
 * plus one, and zero is the control itself -- or, for a selection, no item.
 */

export const EVENT_OBJECT_CREATE = 0x8000;
export const EVENT_OBJECT_DESTROY = 0x8001;
export const EVENT_OBJECT_FOCUS = 0x8005;
export const EVENT_OBJECT_SELECTION = 0x8006;
export const EVENT_OBJECT_REORDER = 0x8004;
export const EVENT_OBJECT_VALUECHANGE = 0x800e;
export const OBJID_CLIENT = -4;
export const CHILDID_SELF = 0;

/**
 * Raises an event about a control; a build with nobody to tell it to answers
 * at once.
 *
 * @param {{ winEvent?: (event: number, hwnd: number, object: number, child: number,
 *     thread?: unknown) => number | Promise<number> }} host
 * @param {{ hwnd: number }} record @param {number} event @param {number} child
 * @param {unknown} [thread]
 * @returns {number | Promise<number>}
 */
export const raiseEvent = (host, record, event, child, thread)=>(host.winEvent
    ? host.winEvent(event, record.hwnd >>> 0, OBJID_CLIENT, child, thread) : 0);
