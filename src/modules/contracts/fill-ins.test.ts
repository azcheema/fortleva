import { describe, expect, it } from "vitest";

import { addressLine, fillIn, fillInToken, remainingFillIns, splitFillIns, type FillInValues } from "./fill-ins";

const values: FillInValues = {
  client_name: "Acme AB",
  client_org_nr: null,
  client_address: "Storgatan 1, 111 22 Stockholm",
  signer_name: "Eva Ek",
  agency_name: "Naxdor AB",
  agency_org_nr: "559000-0000",
  agency_address: null,
  today: "10 October 2026",
};

const para = (...content: unknown[]) => ({ type: "paragraph", content });
const text = (t: string, marks?: unknown[]) => (marks ? { type: "text", text: t, marks } : { type: "text", text: t });
const doc = (...content: unknown[]) => ({ type: "doc", content });

describe("fillIn", () => {
  it("replaces every known token with its value", () => {
    const out = fillIn(doc(para(text("Between {{agency_name}} and {{client_name}}, {{today}}."))), values);
    expect(out).toEqual(doc(para(text("Between Naxdor AB and Acme AB, 10 October 2026."))));
  });

  it("keeps a token whose value is missing, and an unknown one", () => {
    const out = fillIn(doc(para(text("Org nr {{client_org_nr}} {{price}}"))), values);
    expect(out).toEqual(doc(para(text("Org nr {{client_org_nr}} {{price}}"))));
  });

  it("keeps the marks of the text node it fills", () => {
    const bold = [{ type: "bold" }];
    const out = fillIn(doc(para(text("{{signer_name}}", bold))), values);
    expect(out).toEqual(doc(para(text("Eva Ek", bold))));
  });

  it("does not match a token split across two text nodes", () => {
    const input = doc(para(text("{{client_"), text("name}}", [{ type: "bold" }])));
    expect(fillIn(input, values)).toEqual(input);
    // …but it is still to fill in, and a template's save names it.
    expect(remainingFillIns(input)).toEqual(["client_name"]);
    expect(splitFillIns(input)).toEqual(["client_name"]);
  });

  it("does not call a whole token split", () => {
    const input = doc(para(text("{{client_name}} and "), text("{{today}}", [{ type: "bold" }])));
    expect(splitFillIns(input)).toEqual([]);
    expect(remainingFillIns(input)).toEqual(["client_name", "today"]);
  });

  it("walks nested content (lists, quotes, headings)", () => {
    const input = doc({
      type: "bulletList",
      content: [{ type: "listItem", content: [para(text("{{client_address}}"))] }],
    });
    expect(remainingFillIns(fillIn(input, values))).toEqual([]);
  });

  it("treats an empty value as missing", () => {
    const out = fillIn(doc(para(text("{{client_name}}"))), { ...values, client_name: "" });
    expect(remainingFillIns(out)).toEqual(["client_name"]);
  });

  it("does not mutate its input", () => {
    const input = doc(para(text("{{client_name}}")));
    const copy = JSON.parse(JSON.stringify(input));
    fillIn(input, values);
    expect(input).toEqual(copy);
  });
});

describe("remainingFillIns", () => {
  it("lists known keys in list order, once each", () => {
    const input = doc(para(text("{{today}} {{client_org_nr}} {{today}} {{nope}}")));
    expect(remainingFillIns(input)).toEqual(["client_org_nr", "today"]);
  });

  it("is empty for an empty or missing document", () => {
    expect(remainingFillIns(null)).toEqual([]);
    expect(remainingFillIns(doc())).toEqual([]);
  });
});

describe("helpers", () => {
  it("writes a token", () => {
    expect(fillInToken("client_name")).toBe("{{client_name}}");
  });

  it("joins an address, skipping blanks", () => {
    expect(addressLine(["Storgatan 1", "", null, " 111 22 Stockholm "])).toBe("Storgatan 1, 111 22 Stockholm");
    expect(addressLine([null, " "])).toBeNull();
  });
});
