import type { CredentialType } from "./fields";
import type { TotpParams } from "./totp";

/**
 * THE EXPORT FILE (Phase 3V slice 95; founder decision C63 (a)): one CSV in
 * the layout Bitwarden's importer reads — Bitwarden, Proton Pass and most
 * other password managers import it directly. SECURITY.md §6.3 promises
 * "the vault is never a lock-in", and this is the format that keeps it.
 * Pure: no database and no translations of its own — the action hands in
 * the labels — so the unit suite pins every byte.
 *
 * THE COLUMNS are Bitwarden's individual-vault export, in its order:
 * `folder,favorite,type,name,notes,fields,reprompt,login_uri,
 * login_username,login_password,login_totp`. A login becomes:
 *  - folder: its client (our own logins: the workspace), told apart by the
 *    caller when two share a name. A `/` is written as U+2215 and a `\` as
 *    U+2216, which look the same: Bitwarden reads `/` (and turns a `\`
 *    into one) as a NESTED folder, so "A/S Bolaget" would arrive as
 *    "S Bolaget" inside "A";
 *  - type: `note` for a secure note, `login` for every other type — the
 *    two types Bitwarden's CSV carries;
 *  - reprompt: `1` for a login SEALED for its client — Bitwarden's "ask for
 *    the master password again", the nearest thing it has;
 *  - login_uri: the web address, QUOTED inside the cell when it holds a
 *    comma or a quote — Bitwarden reads the column as a row of addresses
 *    and would split one at its comma;
 *  - login_password: the type's MAIN secret (`MAIN_SECRET`); every other
 *    secret part is written into the notes under its own label. The
 *    `fields` column stays empty on purpose: Bitwarden splits each of its
 *    lines at the LAST ": ", so a value holding ": " or a newline (a
 *    connection string, a private key) would arrive cut in two;
 *  - login_totp: an `otpauth://` URI, which keeps a non-default period,
 *    length or algorithm; its label is the login's name cut to
 *    `TOTP_LABEL_MAX` characters, to stay inside Bitwarden's field;
 *  - notes: a first line this file writes (what the login was here, and
 *    its project), then the login's own notes, the other secret parts,
 *    and its details — tags, expiry, how often to change it and when it
 *    last was, "Change soon", shown to the client, sealed, archived — so
 *    nothing an agency keeps about a login is dropped. (`compromisedAt` is
 *    not written: no surface of the product sets or reads it yet.)
 *
 * SPREADSHEET FORMULAS. A spreadsheet runs a cell that starts with `=`,
 * `+`, `-`, `@`, a tab or a carriage return as a formula — and anyone who
 * may ADD a login can type one into it, so a file opened in a spreadsheet
 * could hand that person every other secret in it. Since slice 96 that
 * includes people OUTSIDE the agency: a client's contact who hands a login
 * over through the portal types its name, username, web address (http(s)
 * only), notes AND its secret fields — the password column among them,
 * written unprefixed (C64; the slice's reviews). The count and the warning
 * described below cover all of it, whoever typed it.
 *
 * The SIGN-IN columns — username, password, authenticator, web address —
 * are written exactly as stored: a leading `'` would change the password or an "@handle"
 * username a password manager imports, which defeats the file. The LABEL
 * columns (folder, name) take OWASP's leading `'`; the notes cell starts
 * with the line this file writes — though a spreadsheet whose list
 * separator is `;` (a Swedish Excel) opens each LINE of a record as a row
 * and splits it at every `;` — so a line break inside ANY value, or a `;`,
 * can start a cell too — and none of those is prefixed (a private key's
 * lines would change). So the file COUNTS every place a spreadsheet split
 * either way would start a cell with one of those characters: the start of
 * a value, of a line inside it, or what follows a `;`, in every column
 * (`formulaValues` — generous on purpose: a false alarm only adds a
 * warning). The dialog warns when there are any, on top of the line it
 * always shows: import the file, never open it in a spreadsheet, delete it
 * afterwards.
 *
 * TOO LONG FOR A PASSWORD MANAGER. Bitwarden refuses a WHOLE import when
 * one item's field passes its limit, and the vault allows longer values
 * (a 5 000-character note beside a 16 KB key). `tooLong` names the logins
 * with a field past `BITWARDEN_LIMITS` — Bitwarden's limits on the
 * ENCRYPTED field, turned into plain bytes with room to spare (the folder,
 * a client's name of any length, is checked on its login) — so the member
 * can copy those by hand. The file still carries them in full.
 *
 * RFC 4180: a cell holding a comma, a quote or a line break is quoted, its
 * quotes doubled; records end in CRLF; UTF-8 with no byte-order mark (a
 * BOM would reach the importer as part of the first column's name).
 */

export const BITWARDEN_COLUMNS = [
  "folder",
  "favorite",
  "type",
  "name",
  "notes",
  "fields",
  "reprompt",
  "login_uri",
  "login_username",
  "login_password",
  "login_totp",
] as const;

/** The secret a password manager's "password" field gets, per type; null = a note (its text goes in the notes). */
export const MAIN_SECRET: Readonly<Record<CredentialType, string | null>> = {
  LOGIN: "password",
  SECURE_NOTE: null,
  API_KEY: "apiKey",
  SSH_KEY: "passphrase",
  DATABASE: "password",
  SERVER: "password",
  WIFI: "password",
  SOFTWARE_LICENSE: "licenseKey",
  OTHER: "secret",
};

/**
 * The most plain UTF-8 bytes a field may hold and still fit Bitwarden's
 * limit on its ENCRYPTED form (notes 10 000 characters, password 5 000;
 * name, username, authenticator and folder 1 000). An encrypted field is
 * `2.` + a 24-character IV + `|` + the base64 of the AES-CBC ciphertext
 * (the plaintext padded up to a whole 16-byte block) + `|` + a
 * 44-character MAC: 1 000 characters hold at most 687 plain bytes, 5 000
 * hold 3 695 and 10 000 hold 7 439 (the code review's arithmetic). These
 * sit a little under each.
 */
export const BITWARDEN_LIMITS = { notes: 7000, password: 3500, name: 680, username: 680, totp: 680, folder: 680 } as const;

/** The authenticator URI's label: the login's name, cut so the URI stays inside its field. */
export const TOTP_LABEL_MAX = 32;

/** The words the file is written in — the exporting member's language, translated by the caller. */
export type ExportLabels = {
  /** The first line's lead, "Fortleva". */
  readonly product: string;
  readonly types: Readonly<Record<CredentialType, string>>;
  /** Each secret field's name, by key ("apiSecret" → "API secret"). */
  readonly fields: Readonly<Record<string, string>>;
  readonly project: string;
  /** For a note, whose username, web address and authenticator a `note` item would drop. */
  readonly username: string;
  readonly url: string;
  readonly totp: string;
  readonly tags: string;
  readonly expires: string;
  readonly rotateEvery: (days: number) => string;
  readonly lastChanged: string;
  readonly changeSoon: string;
  readonly shownToClient: string;
  readonly sealed: string;
  readonly archived: string;
};

/** One login as the file carries it — its secret parts decrypted. */
export type ExportRow = {
  readonly type: CredentialType;
  readonly name: string;
  readonly username: string | null;
  readonly url: string | null;
  readonly notes: string | null;
  readonly tags: readonly string[];
  readonly expiresAt: Date | null;
  readonly rotateEveryDays: number | null;
  /** When a secret value was last replaced — the schedule's rotation. */
  readonly lastRotatedAt: Date | null;
  readonly needsRotation: boolean;
  /** Shown to the client's main contacts in their portal (slice 91). */
  readonly shownToClient: boolean;
  readonly sealed: boolean;
  readonly archived: boolean;
  /** The folder: the client's name, or the workspace's for our own logins — already told apart. */
  readonly folder: string;
  readonly project: string | null;
  readonly secret: Readonly<Record<string, string>>;
  readonly totp: TotpParams | null;
};

/** The file, and what the member should be told about it. */
export type ExportCsv = {
  readonly csv: string;
  /** How many values in it would start a spreadsheet cell with a formula character (see the file's comment). */
  readonly formulaValues: number;
  /** The names of the logins with a field too long for Bitwarden to import. */
  readonly tooLong: readonly string[];
};

const FORMULA_LEAD = /^[=+\-@\t\r]/;
/**
 * Where a spreadsheet split on lines and on `;` could start a cell with a
 * formula character — after any quotes, which such a spreadsheet reads as
 * a quoted field's opening (the fix-round review).
 */
const FORMULA_START = /(?:^|\r\n?|\n|;)"*[=+\-@\t]/g;

/** How many cells a value could start with a formula in a spreadsheet split on lines or `;` (the file's comment). */
export function formulaStarts(value: string): number {
  return value.match(FORMULA_START)?.length ?? 0;
}
const LOOKALIKE_SLASH = String.fromCharCode(0x2215);
const LOOKALIKE_BACKSLASH = String.fromCharCode(0x2216);

/** RFC 4180: quoted only when it must be, quotes doubled. */
export function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** OWASP's CSV-injection guard, for the label columns only (see the file's comment). */
export function neutraliseFormula(value: string): string {
  return FORMULA_LEAD.test(value) ? `'${value}` : value;
}

/** A folder name Bitwarden will not read as nested folders. */
export function folderName(name: string): string {
  return neutraliseFormula(name.replaceAll("/", LOOKALIKE_SLASH).replaceAll("\\", LOOKALIKE_BACKSLASH));
}

/**
 * The web address as Bitwarden's `login_uri` wants it: the column is read
 * as a ROW of addresses, so one holding a comma or a quote is quoted (and
 * its quotes doubled) inside the cell.
 */
export function uriCell(url: string): string {
  return /[",]/.test(url) ? `"${url.replaceAll('"', '""')}"` : url;
}

/** The seed as a password manager imports it — `otpauth://totp/<name>?secret=…`, the label cut to `TOTP_LABEL_MAX`. */
export function otpauthUri(name: string, totp: TotpParams): string {
  const query = new URLSearchParams({
    secret: totp.secret,
    algorithm: totp.algorithm,
    digits: String(totp.digits),
    period: String(totp.period),
  });
  const label = [...name].slice(0, TOTP_LABEL_MAX).join("");
  return `otpauth://totp/${encodeURIComponent(label)}?${query.toString()}`;
}

/** A calendar day as `YYYY-MM-DD` — expiry dates are stored as UTC midnight. */
const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

const bytes = (s: string): number => Buffer.byteLength(s, "utf8");

/** The notes cell: never empty, and always opening with the line this file writes. */
function notesOf(row: ExportRow, labels: ExportLabels): string {
  const isNote = MAIN_SECRET[row.type] === null;
  const head = [labels.product, labels.types[row.type], ...(row.project === null ? [] : [`${labels.project}: ${row.project}`])];
  const sections: string[] = [head.join(" · ")];

  // A note's own text first: it is what the item IS.
  const noteText = row.secret["note"];
  if (isNote && noteText !== undefined) sections.push(noteText);
  if (row.notes !== null && row.notes !== "") sections.push(row.notes);

  // What a `note` item has no column for.
  if (isNote) {
    const lines = [
      ...(row.username === null ? [] : [`${labels.username}: ${row.username}`]),
      ...(row.url === null ? [] : [`${labels.url}: ${row.url}`]),
      ...(row.totp === null ? [] : [`${labels.totp}: ${otpauthUri(row.name, row.totp)}`]),
    ];
    if (lines.length > 0) sections.push(lines.join("\n"));
  }

  // Every secret part but the main one (and a note's text, already written),
  // in the order the vault stores them — each under its name, the value on
  // its own lines so a private key keeps its shape.
  const main = MAIN_SECRET[row.type];
  for (const [key, value] of Object.entries(row.secret)) {
    if (key === main || (isNote && key === "note")) continue;
    sections.push(`${labels.fields[key] ?? key}:\n${value}`);
  }

  const details = [
    ...(row.tags.length === 0 ? [] : [`${labels.tags}: ${row.tags.join(", ")}`]),
    ...(row.expiresAt === null ? [] : [`${labels.expires}: ${isoDay(row.expiresAt)}`]),
    ...(row.rotateEveryDays === null ? [] : [labels.rotateEvery(row.rotateEveryDays)]),
    ...(row.lastRotatedAt === null ? [] : [`${labels.lastChanged}: ${isoDay(row.lastRotatedAt)}`]),
    ...(row.needsRotation ? [labels.changeSoon] : []),
    ...(row.shownToClient ? [labels.shownToClient] : []),
    ...(row.sealed ? [labels.sealed] : []),
    ...(row.archived ? [labels.archived] : []),
  ];
  if (details.length > 0) sections.push(details.join("\n"));
  return sections.join("\n\n");
}

type Written = { readonly cells: readonly string[]; readonly formulaValues: number; readonly tooLong: boolean };

/** One record, in `BITWARDEN_COLUMNS`' order, with what it adds to the warnings. */
function recordOf(row: ExportRow, labels: ExportLabels): Written {
  const main = MAIN_SECRET[row.type];
  const isNote = main === null;
  const notes = notesOf(row, labels);
  const username = isNote ? "" : (row.username ?? "");
  const password = isNote ? "" : (row.secret[main] ?? "");
  const totp = isNote || row.totp === null ? "" : otpauthUri(row.name, row.totp);
  const folder = folderName(row.folder);
  const cells = [
    folder,
    "",
    isNote ? "note" : "login",
    neutraliseFormula(row.name),
    notes,
    "",
    row.sealed ? "1" : "",
    isNote || row.url === null ? "" : uriCell(row.url),
    username,
    password,
    totp,
  ];
  const tooLong =
    bytes(notes) > BITWARDEN_LIMITS.notes ||
    bytes(password) > BITWARDEN_LIMITS.password ||
    bytes(row.name) > BITWARDEN_LIMITS.name ||
    bytes(username) > BITWARDEN_LIMITS.username ||
    bytes(totp) > BITWARDEN_LIMITS.totp ||
    bytes(folder) > BITWARDEN_LIMITS.folder;
  // Every cell as written — a neutralised label no longer starts with a
  // formula, the notes' first line is the file's own — counted at every
  // place a spreadsheet split on lines or `;` could start a cell.
  return { cells, formulaValues: cells.reduce((n, c) => n + formulaStarts(c), 0), tooLong };
}

/** The whole file — the header and one record per login, CRLF after each — and its warnings. */
export function toBitwardenCsv(rows: readonly ExportRow[], labels: ExportLabels): ExportCsv {
  const records = rows.map((r) => ({ name: r.name, ...recordOf(r, labels) }));
  const lines = [BITWARDEN_COLUMNS.join(","), ...records.map((r) => r.cells.map(csvCell).join(","))];
  return {
    csv: `${lines.join("\r\n")}\r\n`,
    formulaValues: records.reduce((n, r) => n + r.formulaValues, 0),
    tooLong: records.filter((r) => r.tooLong).map((r) => r.name),
  };
}
