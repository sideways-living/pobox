import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";

const boundaries = new Set(["br", "p", "div", "tr", "td", "th", "table", "li", "section", "hr"]);
const ignored = new Set(["script", "style", "head", "template"]);

export function mailText(value: string): string {
  function text(node: DefaultTreeAdapterTypes.Node): string {
    if ("value" in node) return node.value;
    if (!("childNodes" in node)) return "";
    const tag = "tagName" in node ? node.tagName : "";
    if (ignored.has(tag)) return "";
    const content = node.childNodes.map(text).join("");
    return boundaries.has(tag) ? `\n${content}\n` : content;
  }
  // HTML parsing decodes named/numeric entities and preserves cell/line edges.
  return text(parseFragment(value)).normalize("NFKC").replace(/\r\n?/g, "\n")
    .replace(/[\t\u00a0 ]+/g, " ").replace(/ *\n */g, "\n").trim();
}
