import { Fragment } from "react";

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
 */

type JsonNode = {
  type?: unknown;
  attrs?: Record<string, unknown>;
  content?: unknown;
  marks?: unknown;
  text?: unknown;
};

const isNode = (v: unknown): v is JsonNode => typeof v === "object" && v !== null;

const children = (node: JsonNode): React.ReactNode[] =>
  Array.isArray(node.content) ? node.content.map((child, i) => renderNode(child, i)) : [];

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

function renderNode(raw: unknown, key: number): React.ReactNode {
  if (!isNode(raw)) return null;
  const node = raw;
  switch (node.type) {
    case "text":
      return renderText(node, key);
    case "paragraph":
      return <p key={key}>{children(node)}</p>;
    case "heading": {
      const level = node.attrs?.["level"];
      // Under the page's h1 and the panel's h2 (see the header).
      if (level === 1) return <h3 key={key}>{children(node)}</h3>;
      if (level === 2) return <h4 key={key}>{children(node)}</h4>;
      return <h5 key={key}>{children(node)}</h5>;
    }
    case "bulletList":
      return <ul key={key}>{children(node)}</ul>;
    case "orderedList": {
      const start = node.attrs?.["start"];
      const type = node.attrs?.["type"];
      return (
        <ol
          key={key}
          start={typeof start === "number" && start !== 1 ? start : undefined}
          type={typeof type === "string" ? (type as "a" | "A" | "i" | "I" | "1") : undefined}
        >
          {children(node)}
        </ol>
      );
    }
    case "listItem":
      return <li key={key}>{children(node)}</li>;
    case "taskList":
      return (
        <ul key={key} data-type="taskList">
          {children(node)}
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
          <div>{children(node)}</div>
        </li>
      );
    }
    case "blockquote":
      return <blockquote key={key}>{children(node)}</blockquote>;
    case "codeBlock":
      return (
        <pre key={key}>
          <code>{children(node)}</code>
        </pre>
      );
    case "hardBreak":
      return <br key={key} />;
    case "horizontalRule":
      return <hr key={key} />;
    case "doc":
      return children(node);
    default:
      return null;
  }
}

/** A stored document as the `prose-body` block every rich-text surface wears. */
export function RichText({ doc, className, ...rest }: { doc: unknown; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("prose-body", className)} {...rest}>
      {isNode(doc) ? renderNode(doc, 0) : null}
    </div>
  );
}
