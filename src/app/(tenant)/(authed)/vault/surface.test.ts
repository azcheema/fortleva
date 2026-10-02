import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AGENCY_WHERE,
  clientSurface,
  clientWhere,
  projectSurface,
  projectWhere,
  SURFACE_PROJECT_KEY,
  TENANT_SURFACE,
  vaultPathOf,
  vaultWhereOf,
} from "./surface";

const ID = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

describe("a vault form's surface — the page it revalidates and the step-up returns to", () => {
  it("names exactly the three vault pages", () => {
    expect(vaultPathOf(TENANT_SURFACE)).toBe("/vault");
    expect(vaultPathOf(clientSurface(ID))).toBe(`/clients/${ID}/vault`);
    expect(vaultPathOf(projectSurface("ACME2"))).toBe("/projects/ACME2/vault");
  });

  it("is never a free path: anything else is refused, whatever it would have redirected to", () => {
    for (const raw of [
      null,
      undefined,
      42,
      "",
      "/vault",
      "//evil.test",
      "https://evil.test/",
      "client:",
      "client:not-a-uuid",
      `client:${ID}/../../settings`,
      `client:${ID}:x`,
      "project:acme",
      "project:ACME/../x",
      "project:TOOLONGKEY",
      `project:${ID}`,
      `tenant:${ID}`,
      `member:${ID}`,
      "x".repeat(100),
    ]) {
      expect(vaultPathOf(raw), String(raw)).toBeNull();
    }
  });

  it("restates the project key rule exactly — the browser bundle cannot import it", () => {
    // Read from the SOURCE: importing the projects service reaches the
    // database client, which a unit test has no URL for.
    const source = readFileSync(join(process.cwd(), "src", "projects", "service.ts"), "utf8");
    const declared = /export const PROJECT_KEY_RE = (\/.+\/[a-z]*);/.exec(source)?.[1];
    expect(declared).toBeDefined();
    expect(String(SURFACE_PROJECT_KEY)).toBe(declared);
  });
});

describe("a new login's where — the agency, a client or a project", () => {
  it("reads the three shapes", () => {
    expect(vaultWhereOf(AGENCY_WHERE)).toEqual({ clientId: null, projectId: null });
    expect(vaultWhereOf(clientWhere(ID))).toEqual({ clientId: ID, projectId: null });
    expect(vaultWhereOf(projectWhere(ID))).toEqual({ clientId: null, projectId: ID });
  });

  it("refuses anything else rather than reading it as the agency's own", () => {
    for (const raw of [null, undefined, "", "client", "client:", "project:ACME", `client:${ID}:x`, `vault:${ID}`, ID, "Agency"]) {
      expect(vaultWhereOf(raw), String(raw)).toBeNull();
    }
  });
});
