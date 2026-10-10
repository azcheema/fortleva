/**
 * Element ids the bookkeeping page and its client parts share — in a plain
 * module, never a "use client" one: a client module's export read by the
 * server page would be a client reference, not a string (AGENTS.md).
 */

/** The newest file's List link — where focus goes once Book the year end has unmounted its own trigger. */
export const NEWEST_FILE_LINK_ID = "bookkeeping-newest-list";
