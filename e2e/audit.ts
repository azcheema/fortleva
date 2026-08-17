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

export type PageAudit = {
  h1: { count: number; texts: string[] };
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

  // ── images and icons ──────────────────────────────────────────────
  const imgs = Array.from(document.images);
  const h1s = Array.from(document.querySelectorAll("h1"));

  return {
    h1: { count: h1s.length, texts: h1s.map((h) => (h.textContent ?? "").trim().slice(0, 60)) },
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
