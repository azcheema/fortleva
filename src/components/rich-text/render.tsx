import { Fragment } from "react";

import { MENTION_NODE } from "@/lib/rich-text/mention-node";
import { cn } from "@/lib/utils";

/**
 * The static renderer (panel slice 10): a stored ProseMirror document as
 * React elements, with NO editor behind it. A comment is read a hundred
 * times for every time it is written, and the editor is 386 KB of
 * client JavaScript that the description already loads on demand; a
 * list of twenty comments must not mount twenty of them. A server
 * component can render this, so the reading path ships no Tiptap at
 * all.
 *
 * It renders ONLY what the normaliser stores (`src/lib/rich-text/
 * normalize.ts`): the node types both schemas declare and the marks
 * StarterKit ships. An unknown node renders nothing — never its raw
 * text, which is how a type the normaliser refused would still be
 * printed if a row were ever written past it — and an attribute is read
 * only where the allow-list keeps one. The link is the one place a
 * stored value becomes an attribute: `href` is already http(s)/mailto
 * (the normaliser's `safeHref`), and it is rendered with `rel` and
 * `target` decided HERE, never stored.
 *
 * Headings map to h3–h5, not h1–h3: the page's h1 is the project shell's
 * and the panel's title is its h2, so a heading typed into a body must
 * sit under both (the craft audit fails a stop with two h1s). Nothing
 * here is keyed by content — positions are stable for a static tree.
 *
 * AN @MENTION (slice 125) stores a member id and no name. It renders as
 * "@Name" ONLY when the caller passes `mentions` — the member panel, from
 * the names its own read resolved — and as NOTHING without one. The portal
 * and View-as never pass the map: a member's name must never reach a
 * client (C42), and the database refuses a client-visible body holding a
 * mention at all (the CHECK `comment_visible_no_mention`), so this is the second belt. An
 * id the map has no name for reads as the caller's `unknownMention`.
 */

type JsonNode = {
  type?: unknown;
  attrs?: Record<string, unknown>;
  content?: unknown;
  marks?: unknown;
  text?: unknown;
};

const isNode = (v: unknown): v is JsonNode => typeof v === "object" && v !== null;

/** What a mention renders with — passed down the walk; absent on every client-facing surface. */
type Ctx = {
  readonly mentions?: Readonly<Record<string, string | null>>;
  readonly unknownMention?: string;
};

const children = (node: JsonNode, ctx: Ctx): React.ReactNode[] =>
  Array.isArray(node.content) ? node.content.map((child, i) => renderNode(child, i, ctx)) : [];

/** Marks wrap the text inside-out in the order stored; `link` outermost so the whole run is one anchor. */
function renderText(node: JsonNode, key: number): React.ReactNode {
  let out: React.ReactNode = typeof node.text === "string" ? node.text : "";
  const marks = Array.isArray(node.marks) ? node.marks.filter(isNode) : [];
  // Inline marks first, the link last, so a bold link is <a><strong>.
  for (const mark of marks) {
    switch (mark.type) {
      case "bold":
        out = <strong>{out}</strong>;
        break;
      case "italic":
        out = <em>{out}</em>;
        break;
      case "strike":
        out = <s>{out}</s>;
        break;
      case "underline":
        out = <u>{out}</u>;
        break;
      case "code":
        out = <code>{out}</code>;
        break;
      default:
        break;
    }
  }
  const link = marks.find((m) => m.type === "link");
  const href = link && typeof link.attrs?.["href"] === "string" ? link.attrs["href"] : null;
  if (href) {
    out = (
      // A stored body can be CLIENT_VISIBLE: the link opens off the app
      // and never carries the referrer or a window handle back.
      <a href={href} target="_blank" rel="noopener noreferrer nofollow">
        {out}
      </a>
    );
  }
  return <Fragment key={key}>{out}</Fragment>;
}

function renderNode(raw: unknown, key: number, ctx: Ctx): React.ReactNode {
  if (!isNode(raw)) return null;
  const node = raw;
  switch (node.type) {
    case "text":
      return renderText(node, key);
    case MENTION_NODE: {
      // No map, no mention — see the header.
      if (!ctx.mentions) return null;
      const id = typeof node.attrs?.["id"] === "string" ? node.attrs["id"] : null;
      const name = id ? ctx.mentions[id] : null;
      // `data-id` (member surfaces only — the portal never gets here) so a
      // chip copied from a posted note pastes back as the same mention.
      return (
        <span key={key} data-type={MENTION_NODE} data-id={id ?? undefined}>
          @{name ?? ctx.unknownMention ?? ""}
        </span>
      );
    }
    case "paragraph":
      return <p key={key}>{children(node, ctx)}</p>;
    case "heading": {
      const level = node.attrs?.["level"];
      // Under the page's h1 and the panel's h2 (see the header).
      if (level === 1) return <h3 key={key}>{children(node, ctx)}</h3>;
      if (level === 2) return <h4 key={key}>{children(node, ctx)}</h4>;
      return <h5 key={key}>{children(node, ctx)}</h5>;
    }
    case "bulletList":
      return <ul key={key}>{children(node, ctx)}</ul>;
    case "orderedList": {
      const start = node.attrs?.["start"];
      const type = node.attrs?.["type"];
      return (
        <ol
          key={key}
          start={typeof start === "number" && start !== 1 ? start : undefined}
          type={typeof type === "string" ? (type as "a" | "A" | "i" | "I" | "1") : undefined}
        >
          {children(node, ctx)}
        </ol>
      );
    }
    case "listItem":
      return <li key={key}>{children(node, ctx)}</li>;
    case "taskList":
      return (
        <ul key={key} data-type="taskList">
          {children(node, ctx)}
        </ul>
      );
    case "taskItem": {
      const checked = node.attrs?.["checked"] === true;
      return (
        <li key={key} data-type="taskItem" data-checked={checked ? "true" : "false"}>
          <label>
            {/* Read-only by construction: a static body has no save path. */}
            <input type="checkbox" checked={checked} disabled readOnly />
          </label>
          <div>{children(node, ctx)}</div>
        </li>
      );
    }
    case "blockquote":
      return <blockquote key={key}>{children(node, ctx)}</blockquote>;
    case "codeBlock":
      return (
        <pre key={key}>
          <code>{children(node, ctx)}</code>
        </pre>
      );
    case "hardBreak":
      return <br key={key} />;
    case "horizontalRule":
      return <hr key={key} />;
    case "doc":
      return children(node, ctx);
    default:
      return null;
  }
}

/** A stored document as the `prose-body` block every rich-text surface wears. */
export function RichText({
  doc,
  className,
  mentions,
  unknownMention,
  ...rest
}: {
  doc: unknown;
  className?: string;
  /** Member id → name, for an @mention (slice 125). MEMBER SURFACES ONLY — never pass it on the portal. */
  mentions?: Readonly<Record<string, string | null>>;
  /** What a mention of an id with no name reads as ("Unknown"). */
  unknownMention?: string;
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("prose-body", className)} {...rest}>
      {isNode(doc) ? renderNode(doc, 0, { mentions, unknownMention }) : null}
    </div>
  );
}
