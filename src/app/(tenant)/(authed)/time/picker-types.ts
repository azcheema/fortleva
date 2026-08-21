/**
 * The project / task / agreement picker's data shapes (ids + labels only,
 * never a rate — UI.md rule 14). A neutral module so the quick start, the
 * New-entry form, the page and the shared options hook import the types
 * from one place without pointing at each other.
 */
export type PickerProject = { id: string; key: string; name: string; clientId: string; clientName: string };
export type PickerOption = { id: string; name: string };
export type PickerOptions = { items: PickerOption[]; services: PickerOption[] };
