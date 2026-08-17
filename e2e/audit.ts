/**
 * The in-page audit run at every stop of the visual sweep.
 *
 * These are the defects a screenshot alone does not prove and a unit
 * test structurally cannot see: text the same colour as what is behind
 * it, a page that scrolls sideways on a phone, a heading outline with
 * no h1 or two, a translation key rendered as prose, a broken image.
 *
 * It is one function because it runs inside the browser: everything it
 * needs must be serialisable into page.evaluate().
 */

export type ColorClash = {
  selector: string;
  text: string;
  color: string;
  background: string;
};

/**
 * The craft half of the audit: the refinement pass's acceptance
 * criteria, expressed as things the DOM either does or does not
 * contain. A screenshot proves them once; these prove them on all 128
 * stops, every run, so none of the three founder mandates can quietly
 * come back.
 */
export type CraftAudit = {
  /** MANDATE 1 — a text/date/select control visible in a resting row. */
  restingRowControls: string[];
  /** MANDATE 2 — a destructive-weight control inside a table row. */
  destructiveInRows: string[];
  /** MANDATE 2 — a solid --destructive fill outside a confirm group. */
  destructiveFills: string[];
  /** MANDATE 3 — the OS file input, showing. */
  visibleFileInputs: string[];
  /** Rows whose measured height is not the --row-h they promise. */
  rowPitch: { selector: string; expected: number; actual: number }[];
  /** `variant="empty"` with nothing to do — a dead end (§5.8). */
  deadEndEmptyStates: string[];
  /** A scroll region a keyboard cannot enter or AT cannot name. */
  unnamedScrollRegions: string[];
  /** A bordered DataTable inside a padded SectionCard (§10.15.1). */
  doubleHairlines: string[];
  /** An inline-edit trigger that is not a named <button>. */
  badInlineEdits: string[];
  /** A row's actions parked outside the visible box of its own table. */
  offscreenRowActions: string[];
  /**
   * aria-current="page" entries in the phone tab bar — exactly one when
   * there IS a bar. `null` means this route has no app shell at all
   * (the root 404 and the auth lockup render outside it).
   */
  tabBarCurrent: number | null;
  /** The current tab's box, and the strip's, at this viewport. */
  tabStrip: { current: number; visible: boolean } | null;
};

export type PageAudit = {
  h1: { count: number; texts: string[] };
  /** The tenant name belongs HERE, never in the h1 (§10.7). */
  documentTitle: string;
  craft: CraftAudit;
  /** Elements whose text colour composites to exactly their backdrop. */
  invisibleText: ColorClash[];
  /** Raw next-intl keys rendered as visible prose. */
  rawKeys: string[];
  overflow: { scrollWidth: number; clientWidth: number; offenders: string[] };
  images: { imgs: number; brokenImgs: string[]; svgs: number };
  /** Every visible control, for the "is anything invisible?" report. */
  counts: { buttons: number; links: number; inputs: number };
};

/**
 * Serialised into the page by e2e/visual.spec.ts. Keep it dependency
 * free and side-effect free — it must not perturb what it measures.
 */
export function auditPage(): PageAudit {
  type Rgb = { r: number; g: number; b: number; a: number };

  const parse = (value: string): Rgb | null => {
    const match = /^rgba?\(([^)]+)\)$/.exec(value.trim());
    if (!match) return null;
    const parts = match[1]!.split(/[,/]/).map((p) => parseFloat(p));
    if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
    return { r: parts[0]!, g: parts[1]!, b: parts[2]!, a: parts.length > 3 ? parts[3]! : 1 };
  };

  /** Composite `top` over `bottom` (both premultiplied-free sRGB). */
  const over = (top: Rgb, bottom: Rgb): Rgb => ({
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
    a: 1,
  });

  /** What is actually behind an element once the stack is flattened. */
  const backdrop = (el: Element): Rgb => {
    const stack: Rgb[] = [];
    let node: Element | null = el.parentElement;
    while (node) {
      const c = parse(getComputedStyle(node).backgroundColor);
      if (c && c.a > 0) {
        stack.push(c);
        if (c.a >= 0.999) break;
      }
      node = node.parentElement;
    }
    // The canvas under everything: whatever <html> resolved to, else white.
    let base = stack.pop() ?? { r: 255, g: 255, b: 255, a: 1 };
    while (stack.length > 0) base = over(stack.pop()!, base);
    return base;
  };

  const near = (a: Rgb, b: Rgb): boolean =>
    Math.round(a.r) === Math.round(b.r) &&
    Math.round(a.g) === Math.round(b.g) &&
    Math.round(a.b) === Math.round(b.b);

  const describe = (el: Element): string => {
    const cls = (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean).slice(0, 3).join(".");
    const id = el.id ? `#${el.id}` : "";
    const slot = el.getAttribute("data-slot");
    return `${el.tagName.toLowerCase()}${id}${slot ? `[${slot}]` : ""}${cls ? `.${cls}` : ""}`;
  };

  const visible = (el: Element): boolean => {
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    if (parseFloat(style.opacity) < 0.05) return false;
    const rect = el.getBoundingClientRect();
    // Anything smaller than 4px is a screen-reader affordance or a hairline.
    return rect.width >= 4 && rect.height >= 4;
  };

  const ownText = (el: Element): string => {
    let text = "";
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) text += node.textContent ?? "";
    }
    return text.trim();
  };

  // ── invisible text ────────────────────────────────────────────────
  const invisibleText: ColorClash[] = [];
  for (const el of Array.from(document.body.querySelectorAll("*"))) {
    const text = ownText(el);
    if (!text || !visible(el)) continue;
    const style = getComputedStyle(el);
    const fg = parse(style.color);
    if (!fg) continue;
    if (fg.a < 0.05) {
      invisibleText.push({ selector: describe(el), text: text.slice(0, 40), color: style.color, background: "—" });
      continue;
    }
    const bg = backdrop(el);
    const flat = fg.a >= 0.999 ? fg : over(fg, bg);
    if (near(flat, bg)) {
      invisibleText.push({
        selector: describe(el),
        text: text.slice(0, 40),
        color: style.color,
        background: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})`,
      });
    }
  }

  // ── raw i18n keys rendered as prose ───────────────────────────────
  const KEY = /^[a-z]+\.[a-z.]+$/;
  const rawKeys: string[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.textContent ?? "").trim();
    if (!KEY.test(text)) continue;
    const parent = node.parentElement;
    if (!parent || !visible(parent)) continue;
    rawKeys.push(text);
  }

  // ── horizontal overflow ───────────────────────────────────────────
  const clientWidth = document.documentElement.clientWidth;
  const offenders: string[] = [];
  for (const el of Array.from(document.body.querySelectorAll("*"))) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (rect.right <= clientWidth + 1 && rect.left >= -1) continue;
    // A wide child of a scroll container is the point of a scroll container.
    let parent: Element | null = el.parentElement;
    let clipped = false;
    while (parent) {
      const ox = getComputedStyle(parent).overflowX;
      if (ox === "auto" || ox === "scroll" || ox === "hidden") {
        clipped = true;
        break;
      }
      parent = parent.parentElement;
    }
    if (!clipped) offenders.push(`${describe(el)} → ${Math.round(rect.right)}px`);
  }

  // ── the craft audit ───────────────────────────────────────────────
  // Founder mandates 1-3 and the pass's acceptance criteria, measured
  // rather than eyeballed. Everything here reads; the one write (the
  // --destructive probe) appends a 0x0 element and removes it in the
  // same synchronous turn, after the screenshot has already been taken.

  /** The one solid --destructive fill the product allows is a confirm's "Yes". */
  const inConfirm = (el: Element): boolean => el.closest('[role="group"]') !== null;

  // MANDATE 1: a value that should read as text must not sit in a box.
  // Toggles are excluded on purpose — a checkbox IS its value, and the
  // roles permission matrix is a control panel, not content (§3.7).
  const ROW_CONTROL =
    'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file]), select, textarea';
  const restingRowControls: string[] = [];
  for (const row of Array.from(document.querySelectorAll("[data-slot=table-row]"))) {
    for (const control of Array.from(row.querySelectorAll(ROW_CONTROL))) {
      if (visible(control)) restingRowControls.push(`${describe(row)} > ${describe(control)}`);
    }
  }

  // MANDATE 2: no destructive WEIGHT in a row — the menu carries it.
  const destructiveInRows: string[] = [];
  for (const el of Array.from(
    document.querySelectorAll('[data-slot=table-row] [data-variant="destructive"]'),
  )) {
    if (!inConfirm(el)) destructiveInRows.push(describe(el));
  }

  // The same rule stated in pixels rather than in attributes, so a
  // hand-rolled red button is caught too.
  const destructiveFills: string[] = [];
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;width:0;height:0;background:var(--destructive)";
  document.body.appendChild(probe);
  const destructive = parse(getComputedStyle(probe).backgroundColor);
  probe.remove();
  if (destructive && destructive.a > 0) {
    for (const el of Array.from(document.querySelectorAll("button, a, [role=button]"))) {
      if (!visible(el) || inConfirm(el)) continue;
      const bg = parse(getComputedStyle(el).backgroundColor);
      if (bg && bg.a > 0.5 && near(bg, destructive)) destructiveFills.push(describe(el));
    }
  }

  // MANDATE 3: the OS file input never shows. `.sr-only` keeps it
  // focusable and in the AT tree, which `hidden` would not.
  const visibleFileInputs = Array.from(document.querySelectorAll("input[type=file]"))
    .filter((el) => !el.classList.contains("sr-only") && visible(el))
    .map(describe);

  // Row pitch: --row-h is a promise the row either keeps or breaks.
  const rowPitch: { selector: string; expected: number; actual: number }[] = [];
  for (const row of Array.from(document.querySelectorAll("[data-slot=table-row]"))) {
    const expected = parseFloat(getComputedStyle(row).getPropertyValue("--row-h"));
    if (!Number.isFinite(expected)) continue;
    const actual = Math.round(row.getBoundingClientRect().height * 100) / 100;
    if (Math.abs(actual - expected) > 1) rowPitch.push({ selector: describe(row), expected, actual });
  }

  // §5.8: "nothing here yet" always offers the verb that changes that.
  const deadEndEmptyStates = Array.from(
    document.querySelectorAll('[data-slot=empty-state][data-variant="empty"]'),
  )
    .filter((el) => el.querySelector("button, a[href], select, input, [role=button]") === null)
    .map(describe);

  // A scroll container only a mouse can reach is content a keyboard
  // user cannot read; an unnamed one is announced as "region".
  const unnamedScrollRegions = Array.from(document.querySelectorAll("[data-slot=data-table]"))
    .filter((el) => el.scrollWidth > el.clientWidth + 1)
    .filter(
      (el) =>
        el.getAttribute("role") !== "region" ||
        el.getAttribute("tabindex") === null ||
        (el.getAttribute("aria-label") ?? "").trim() === "",
    )
    .map(describe);

  // §10.15.1: a bordered table inside a padded card draws two hairlines
  // 16px apart. `contentClassName="p-0"` + <DataTable flush> is the fix.
  const doubleHairlines: string[] = [];
  for (const table of Array.from(document.querySelectorAll("[data-slot=data-table]"))) {
    if (parseFloat(getComputedStyle(table).borderTopWidth) < 0.5) continue;
    const card = table.closest("[data-slot=section-card]");
    if (!card) continue;
    // The card's content box is the ancestor chain between the two.
    let node: Element | null = table;
    let padded = false;
    while (node && node !== card) {
      if (parseFloat(getComputedStyle(node).paddingLeft) > 0.5) {
        padded = true;
        break;
      }
      node = node.parentElement;
    }
    if (padded) doubleHairlines.push(describe(table));
  }

  // The rest state of an inline edit is a real, named button — the only
  // tab stop for its value, and the thing AT announces.
  const badInlineEdits = Array.from(document.querySelectorAll("[data-slot=inline-edit]"))
    .filter((el) => {
      const name = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim();
      return el.tagName !== "BUTTON" || name === "";
    })
    .map(describe);

  // A row's verbs must be ON SCREEN, not behind a horizontal scroll the
  // page never advertises. Column priority is what makes room for them;
  // this is the assertion that the priorities are actually enough.
  const offscreenRowActions: string[] = [];
  for (const actions of Array.from(document.querySelectorAll("[data-slot=row-actions]"))) {
    const box = actions.closest("[data-slot=data-table]");
    if (!box) continue;
    const a = actions.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    if (a.width === 0) continue;
    if (a.right > b.right + 1 || a.left < b.left - 1) {
      offscreenRowActions.push(`${describe(actions)} → ${Math.round(a.right - b.right)}px past`);
    }
  }

  const tabBar = document.querySelector("[data-slot=tab-bar]");
  const tabBarCurrent = tabBar ? tabBar.querySelectorAll('[aria-current="page"]').length : null;

  // The current tab must be ON SCREEN inside its own strip — at 390px
  // the project Team tab used to sit past the right edge, which reads as
  // "this page has no tabs".
  const strip = document.querySelector("[data-slot=tab-strip]");
  const current = strip?.querySelector('[aria-current="page"]') ?? null;
  const tabStrip =
    strip && current
      ? (() => {
          const s = strip.getBoundingClientRect();
          const c = current.getBoundingClientRect();
          return {
            current: Math.round(c.left - s.left),
            visible: c.left >= s.left - 1 && c.right <= s.right + 1,
          };
        })()
      : null;

  // ── images and icons ──────────────────────────────────────────────
  const imgs = Array.from(document.images);
  const h1s = Array.from(document.querySelectorAll("h1"));

  return {
    h1: { count: h1s.length, texts: h1s.map((h) => (h.textContent ?? "").trim().slice(0, 60)) },
    documentTitle: document.title,
    craft: {
      restingRowControls,
      destructiveInRows,
      destructiveFills,
      visibleFileInputs,
      rowPitch,
      deadEndEmptyStates,
      unnamedScrollRegions,
      doubleHairlines,
      badInlineEdits,
      offscreenRowActions,
      tabBarCurrent,
      tabStrip,
    },
    invisibleText,
    rawKeys: Array.from(new Set(rawKeys)),
    overflow: {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth,
      offenders: Array.from(new Set(offenders)).slice(0, 12),
    },
    images: {
      imgs: imgs.length,
      brokenImgs: imgs.filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.currentSrc || i.src),
      svgs: document.querySelectorAll("svg").length,
    },
    counts: {
      buttons: document.querySelectorAll("button").length,
      links: document.querySelectorAll("a").length,
      inputs: document.querySelectorAll("input, select, textarea").length,
    },
  };
}
