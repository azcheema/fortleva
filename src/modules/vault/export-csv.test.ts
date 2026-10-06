import { describe, expect, it } from "vitest";

import {
  BITWARDEN_COLUMNS,
  BITWARDEN_LIMITS,
  csvCell,
  folderName,
  formulaStarts,
  MAIN_SECRET,
  neutraliseFormula,
  otpauthUri,
  TOTP_LABEL_MAX,
  toBitwardenCsv,
  uriCell,
  type ExportLabels,
  type ExportRow,
} from "./export-csv";
import { CREDENTIAL_TYPES, SECRET_FIELDS } from "./fields";

const LABELS: ExportLabels = {
  product: "Fortleva",
  types: {
    LOGIN: "Login",
    SECURE_NOTE: "Secure note",
    API_KEY: "API key",
    SSH_KEY: "SSH key",
    DATABASE: "Database",
    SERVER: "Server",
    WIFI: "Wi-Fi",
    SOFTWARE_LICENSE: "Software licence",
    OTHER: "Other",
  },
  fields: {
    password: "Password",
    note: "Note",
    apiKey: "API key",
    apiSecret: "API secret",
    privateKey: "Private key",
    passphrase: "Passphrase",
    connectionString: "Connection string",
    licenseKey: "Licence key",
    secret: "Secret",
  },
  project: "Project",
  username: "Username",
  url: "Web address",
  totp: "Authenticator",
  tags: "Tags",
  expires: "Expires",
  rotateEvery: (days) => `Change every ${days} days`,
  lastChanged: "Last changed",
  changeSoon: "Change soon",
  shownToClient: "Shown to the client",
  sealed: "Sealed for the client",
  archived: "Archived",
};

const csvOf = (rows: readonly ExportRow[], labels: ExportLabels) => toBitwardenCsv(rows, labels).csv;

const row = (over: Partial<ExportRow> = {}): ExportRow => ({
  type: "LOGIN",
  name: "Hosting",
  username: "admin@acme.se",
  url: "https://panel.example.com",
  notes: null,
  tags: [],
  expiresAt: null,
  rotateEveryDays: null,
  lastRotatedAt: null,
  needsRotation: false,
  shownToClient: false,
  sealed: false,
  archived: false,
  folder: "Acme",
  project: null,
  secret: { password: "hunter2" },
  totp: null,
  ...over,
});

/** A tiny RFC 4180 reader — enough to read our own output back cell by cell. */
function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let cell = "";
  let rec: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      rec.push(cell);
      cell = "";
    } else if (ch === "\r" && text[i + 1] === "\n") {
      rec.push(cell);
      records.push(rec);
      rec = [];
      cell = "";
      i++;
    } else cell += ch;
  }
  return records;
}

const cellsOf = (csv: string, n = 1) => {
  const records = parseCsv(csv);
  const header = records[0]!;
  const r = records[n]!;
  return Object.fromEntries(header.map((h, i) => [h, r[i]!])) as Record<(typeof BITWARDEN_COLUMNS)[number], string>;
};

describe("the export file (slice 95, C63 (a))", () => {
  it("is Bitwarden's header, then one CRLF-terminated record per login, with no byte-order mark", () => {
    const csv = csvOf([row(), row({ name: "Mail" })], LABELS);
    expect(csv.startsWith("folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\r\n")).toBe(true);
    expect(csv.charCodeAt(0)).not.toBe(0xfeff);
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(parseCsv(csv)).toHaveLength(3);
  });

  it("puts a login's username, web address and password in Bitwarden's columns", () => {
    const c = cellsOf(csvOf([row()], LABELS));
    expect(c).toMatchObject({
      folder: "Acme",
      favorite: "",
      type: "login",
      name: "Hosting",
      fields: "",
      reprompt: "",
      login_uri: "https://panel.example.com",
      login_username: "admin@acme.se",
      login_password: "hunter2",
      login_totp: "",
    });
    expect(c.notes).toBe("Fortleva · Login");
  });

  it("names a main secret for every type that is one of the type's own fields", () => {
    for (const type of CREDENTIAL_TYPES) {
      const main = MAIN_SECRET[type];
      if (main !== null) expect(SECRET_FIELDS[type]).toContain(main);
    }
    expect(MAIN_SECRET.SECURE_NOTE).toBeNull();
  });

  it("writes the other secret parts into the notes, labelled, a private key keeping its lines", () => {
    const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk=\n-----END OPENSSH PRIVATE KEY-----";
    const c = cellsOf(csvOf([row({ type: "SSH_KEY", secret: { privateKey: key, passphrase: "pp" } })], LABELS));
    expect(c.login_password).toBe("pp");
    expect(c.notes).toBe(`Fortleva · SSH key\n\nPrivate key:\n${key}`);
    expect(c.fields).toBe("");
  });

  it("keeps a value holding ': ', commas, quotes and newlines exactly (the reason `fields` stays empty)", () => {
    const conn = 'postgres://u:p@h/db?x="1", y: 2\nline two';
    const c = cellsOf(csvOf([row({ type: "DATABASE", secret: { password: "a,b\"c", connectionString: conn } })], LABELS));
    expect(c.login_password).toBe('a,b"c');
    expect(c.notes).toBe(`Fortleva · Database\n\nConnection string:\n${conn}`);
  });

  it("an SSH key with no passphrase leaves the password empty and keeps the key in the notes", () => {
    const c = cellsOf(csvOf([row({ type: "SSH_KEY", secret: { privateKey: "KEY" } })], LABELS));
    expect(c.login_password).toBe("");
    expect(c.notes).toContain("Private key:\nKEY");
  });

  it("makes a secure note a `note`: its text first, and what a note has no column for kept in the notes", () => {
    const c = cellsOf(
      csvOf(
        [
          row({
            type: "SECURE_NOTE",
            name: "Alarm code",
            notes: "Front door",
            secret: { note: "1234#" },
            totp: { secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1", digits: 6, period: 30 },
          }),
        ],
        LABELS,
      ),
    );
    expect(c.type).toBe("note");
    expect(c.login_uri + c.login_username + c.login_password + c.login_totp).toBe("");
    expect(c.notes).toBe(
      [
        "Fortleva · Secure note",
        "1234#",
        "Front door",
        "Username: admin@acme.se\nWeb address: https://panel.example.com\nAuthenticator: otpauth://totp/Alarm%20code?secret=JBSWY3DPEHPK3PXP&algorithm=SHA1&digits=6&period=30",
      ].join("\n\n"),
    );
  });

  it("writes the authenticator as an otpauth URI that keeps a non-default period, length and algorithm", () => {
    const totp = { secret: "GEZDGNBVGY3TQOJQ", algorithm: "SHA256", digits: 8, period: 60 } as const;
    const c = cellsOf(csvOf([row({ name: "Acme: admin", totp })], LABELS));
    expect(c.login_totp).toBe("otpauth://totp/Acme%3A%20admin?secret=GEZDGNBVGY3TQOJQ&algorithm=SHA256&digits=8&period=60");
    expect(otpauthUri("x", totp)).toContain("digits=8");
  });

  it("keeps the project, the login's own notes and every detail in the notes", () => {
    const c = cellsOf(
      csvOf(
        [
          row({
            project: "Website relaunch",
            notes: "Billing contact is Eva",
            tags: ["hosting", "prod"],
            expiresAt: new Date("2027-01-31T00:00:00Z"),
            rotateEveryDays: 90,
            lastRotatedAt: new Date("2026-09-01T10:00:00Z"),
            needsRotation: true,
            shownToClient: true,
            sealed: true,
            archived: true,
          }),
        ],
        LABELS,
      ),
    );
    expect(c.notes).toBe(
      [
        "Fortleva · Login · Project: Website relaunch",
        "Billing contact is Eva",
        "Tags: hosting, prod\nExpires: 2027-01-31\nChange every 90 days\nLast changed: 2026-09-01\nChange soon\nShown to the client\nSealed for the client\nArchived",
      ].join("\n\n"),
    );
  });

  it("writes a folder's slash and backslash as look-alikes, so a client called A/S is not a nested folder", () => {
    const slash = String.fromCharCode(0x2215);
    const backslash = String.fromCharCode(0x2216);
    expect(cellsOf(csvOf([row({ folder: "Bygg A/S" })], LABELS)).folder).toBe(`Bygg A${slash}S`);
    expect(folderName("a\\b/c\\d")).toBe(`a${backslash}b${slash}c${backslash}d`);
    expect(folderName("=1+1")).toBe("'=1+1");
  });

  it("quotes a web address holding a comma or a quote inside its cell — Bitwarden reads the column as a row of addresses", () => {
    const url = 'https://x.se/?a=1,2&b="q"';
    expect(uriCell("https://x.se/a")).toBe("https://x.se/a");
    expect(uriCell(url)).toBe('"https://x.se/?a=1,2&b=""q"""');
    // …and the cell itself is quoted again around that, so the file reads back to the inner form.
    expect(cellsOf(csvOf([row({ url })], LABELS)).login_uri).toBe(uriCell(url));
  });

  it("asks a password manager to re-prompt for a login sealed for its client", () => {
    expect(cellsOf(csvOf([row({ sealed: true })], LABELS)).reprompt).toBe("1");
    expect(cellsOf(csvOf([row()], LABELS)).reprompt).toBe("");
  });

  it("cuts the authenticator label to TOTP_LABEL_MAX characters, never the seed", () => {
    const totp = { secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1", digits: 6, period: 30 } as const;
    const uri = otpauthUri("å".repeat(200), totp);
    expect(decodeURIComponent(uri.slice("otpauth://totp/".length, uri.indexOf("?")))).toBe("å".repeat(TOTP_LABEL_MAX));
    expect(uri).toContain("secret=JBSWY3DPEHPK3PXP");
  });

  it("counts every place a spreadsheet could start a formula cell — in any column, after a line break or a `;` — never the file's own lines", () => {
    expect(toBitwardenCsv([row()], LABELS).formulaValues).toBe(0);
    // The labels are neutralised, so their first character does not count.
    expect(toBitwardenCsv([row({ name: "=x", folder: "@y" })], LABELS).formulaValues).toBe(0);
    expect(toBitwardenCsv([row({ username: "@handle", secret: { password: "=cmd" } })], LABELS).formulaValues).toBe(2);
    expect(toBitwardenCsv([row({ notes: "fine\n+46 70 123" })], LABELS).formulaValues).toBe(1);
    expect(toBitwardenCsv([row({ type: "SSH_KEY", secret: { privateKey: "-----BEGIN\nAAAA\n-----END" } })], LABELS).formulaValues).toBe(2);
    // A spreadsheet split on `;` (a Swedish Excel) opens a cell after every `;` and every line break.
    expect(toBitwardenCsv([row({ secret: { password: "x;=WEBSERVICE(1)" } })], LABELS).formulaValues).toBe(1);
    expect(toBitwardenCsv([row({ name: "x\n=HYPERLINK(1)" })], LABELS).formulaValues).toBe(1);
    expect(toBitwardenCsv([row({ username: "a\r@b" })], LABELS).formulaValues).toBe(1);
    expect(formulaStarts("plain; text, - here")).toBe(0);
    expect(formulaStarts("=a;+b\n-c\r\n@d")).toBe(4);
    // A `;`-separated spreadsheet reads a field opening with quotes as quoted — the formula still runs.
    expect(formulaStarts('x;"=a\n""+b')).toBe(2);
  });

  it("names the logins with a field too long for Bitwarden to import — and still writes them in full", () => {
    const long = "x".repeat(BITWARDEN_LIMITS.notes + 1);
    const out = toBitwardenCsv([row({ name: "Fits" }), row({ name: "Huge note", notes: long }), row({ name: "Huge pw", secret: { password: "p".repeat(BITWARDEN_LIMITS.password + 1) } })], LABELS);
    expect(out.tooLong).toEqual(["Huge note", "Huge pw"]);
    expect(out.csv).toContain(long);
    // Bytes, not characters: a Swedish letter is two.
    expect(toBitwardenCsv([row({ secret: { password: "å".repeat(BITWARDEN_LIMITS.password / 2 + 1) } })], LABELS).tooLong).toHaveLength(1);
    // A client's name has no cap of its own, and a folder has Bitwarden's limit too.
    expect(toBitwardenCsv([row({ name: "In a long folder", folder: "f".repeat(BITWARDEN_LIMITS.folder + 1) })], LABELS).tooLong).toEqual([
      "In a long folder",
    ]);
  });

  it("neutralises a formula in the label columns, never in the sign-in columns", () => {
    const c = cellsOf(
      csvOf(
        [row({ folder: "=HYPERLINK(1)", name: "@SUM(A1)", username: "@naxdor", url: "https://x.se", secret: { password: "-+=@pw" } })],
        LABELS,
      ),
    );
    expect(c.folder).toBe("'=HYPERLINK(1)");
    expect(c.name).toBe("'@SUM(A1)");
    // A password manager imports these as they are: a changed character is a wrong password.
    expect(c.login_username).toBe("@naxdor");
    expect(c.login_password).toBe("-+=@pw");
    // The notes cell always opens with the file's own line.
    expect(c.notes.startsWith("Fortleva")).toBe(true);
    for (const lead of ["=", "+", "-", "@", "\t", "\r"]) expect(neutraliseFormula(`${lead}x`)).toBe(`'${lead}x`);
    expect(neutraliseFormula("Acme")).toBe("Acme");
  });

  it("quotes a cell only when it must, doubling its quotes", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    expect(csvCell("cr\rhere")).toBe('"cr\rhere"');
  });
});
