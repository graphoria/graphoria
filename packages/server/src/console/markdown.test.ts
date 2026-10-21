import { describe, expect, it } from "bun:test";

import { renderAnswerHtml } from "./markdown";

const TAG = /<\/?([a-z][a-z0-9]*)([^>]*)>/g;
const TAGS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "ul",
  "ol",
  "li",
  "pre",
  "code",
  "strong",
  "em",
  "del",
  "hr",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
]);
const ATTRIBUTES = /^(?: start="\d+"| style="text-align:(?:left|center|right)")?$/;

/** Only tags the renderer writes, only its attributes, and no bare `<` or `>` in the text. */
const onlyRendererMarkup = (html: string) =>
  [...html.matchAll(TAG)].every(
    ([, tag = "", attributes = ""]) => TAGS.has(tag) && ATTRIBUTES.test(attributes),
  ) && !/[<>]/.test(html.replace(TAG, ""));

describe("renderAnswerHtml", () => {
  it("renders a GFM table with its column alignment", () => {
    expect(renderAnswerHtml("| status | n |\n|:--|--:|\n| open | 3 |")).toBe(
      '<table><thead><tr><th style="text-align:left">status</th><th style="text-align:right">n</th></tr></thead><tbody><tr><td style="text-align:left">open</td><td style="text-align:right">3</td></tr></tbody></table>',
    );
  });

  it("renders lists, task items, code, emphasis, headings, quotes and rules", () => {
    expect(renderAnswerHtml("- a\n- b\n\n3. x\n4. y")).toBe(
      '<ul><li>a</li><li>b</li></ul><ol start="3"><li>x</li><li>y</li></ol>',
    );
    expect(renderAnswerHtml("- [x] done\n- [ ] todo")).toBe(
      "<ul><li>☑ done</li><li>☐ todo</li></ul>",
    );
    expect(renderAnswerHtml("Run `count(*)`:\n\n```sql\nSELECT 1 < 2;\n```")).toBe(
      "<p>Run <code>count(*)</code>:</p><pre><code>SELECT 1 &lt; 2;\n</code></pre>",
    );
    expect(renderAnswerHtml("# Total\n\n**3** *open* ~~closed~~\n\n> note\n\n---")).toBe(
      "<h1>Total</h1><p><strong>3</strong> <em>open</em> <del>closed</del></p><blockquote><p>note</p></blockquote><hr>",
    );
  });

  it.each([
    ["an HTML block", "<img src=x onerror=alert(1)>", "&lt;img src=x onerror=alert(1)&gt;\n"],
    [
      "inline HTML",
      "hi <script>alert(1)</script> there",
      "<p>hi &lt;script&gt;alert(1)&lt;/script&gt; there</p>",
    ],
    [
      "an entity-encoded tag",
      "&lt;script&gt;alert(1)&lt;/script&gt;",
      "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>",
    ],
    ["a javascript: link", "[click](javascript:alert(1))", "<p>click</p>"],
    ["a data: link", "[x](data:text/html;base64,PHNjcmlwdD4=)", "<p>x</p>"],
    [
      "angle autolinks",
      "<javascript:alert(1)> <https://example.com>",
      "<p>javascript:alert(1) https://example.com</p>",
    ],
    [
      "images",
      '![<b>alt</b>](x.png "t" ) ![a](javascript:alert(1))',
      "<p>&lt;b&gt;alt&lt;/b&gt; a</p>",
    ],
    [
      "a quote-breaking link title",
      '[x](https://e.com "a\\" onmouseover=\\"alert(1)")',
      "<p>x</p>",
    ],
    [
      "HTML inside a code block",
      "```\n<img src=x onerror=alert(1)>\n```",
      "<pre><code>&lt;img src=x onerror=alert(1)&gt;\n</code></pre>",
    ],
  ])("writes no markup of the input's own for %s", (_, markdown, html) => {
    const rendered = renderAnswerHtml(markdown);
    expect(rendered).toBe(html);
    expect(onlyRendererMarkup(rendered)).toBe(true);
  });
});
