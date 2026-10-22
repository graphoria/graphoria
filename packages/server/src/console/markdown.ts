const align = (value?: "left" | "center" | "right") =>
  value ? ` style="text-align:${value}"` : "";

// Every raw leaf (text, inline and block HTML, code, alt text) reaches `text`,
// so its escape is the only one needed: the other callbacks write fixed tags,
// and links and images keep their text alone.
const callbacks: Bun.markdown.RenderCallbacks = {
  text: (text) => Bun.escapeHTML(text),
  paragraph: (children) => `<p>${children}</p>`,
  heading: (children, { level }) => `<h${level}>${children}</h${level}>`,
  blockquote: (children) => `<blockquote>${children}</blockquote>`,
  list: (children, { ordered, start }) =>
    ordered ? `<ol start="${start ?? 1}">${children}</ol>` : `<ul>${children}</ul>`,
  listItem: (children, { checked }) =>
    `<li>${checked === undefined ? "" : checked ? "☑ " : "☐ "}${children}</li>`,
  code: (children) => `<pre><code>${children}</code></pre>`,
  codespan: (children) => `<code>${children}</code>`,
  strong: (children) => `<strong>${children}</strong>`,
  emphasis: (children) => `<em>${children}</em>`,
  strikethrough: (children) => `<del>${children}</del>`,
  hr: () => "<hr>",
  table: (children) => `<table>${children}</table>`,
  thead: (children) => `<thead>${children}</thead>`,
  tbody: (children) => `<tbody>${children}</tbody>`,
  tr: (children) => `<tr>${children}</tr>`,
  th: (children, meta) => `<th${align(meta?.align)}>${children}</th>`,
  td: (children, meta) => `<td${align(meta?.align)}>${children}</td>`,
  link: (children) => children,
  image: (children) => children,
  html: (children) => children,
};

/** The agent's Markdown answer as HTML holding only the tags and attributes written here. */
export const renderAnswerHtml = (markdown: string): string =>
  Bun.markdown.render(markdown, callbacks);
