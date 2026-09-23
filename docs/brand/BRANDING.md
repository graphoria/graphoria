# Graphoria brand assets

The mark is a hub with three nodes on a ported ring, blades under torque — a graph
being generated, not a diagram of one. Direction `2a Tuned`.

## Files

| File                           | Use                                                                |
| ------------------------------ | ------------------------------------------------------------------ |
| `graphoria-mark.svg`           | The mark, for light backgrounds. Vector, no text.                  |
| `graphoria-mark-dark.svg`      | The mark, for dark backgrounds.                                    |
| `graphoria-mark-mono.svg`      | Single-colour, inherits `currentColor`. For embeds and stamps.     |
| `graphoria-lockup-light.png`   | Mark + wordmark, transparent, for light backgrounds. 830×176 (2×). |
| `graphoria-lockup-dark.png`    | Mark + wordmark, transparent, for dark backgrounds. 830×176 (2×).  |
| `graphoria-banner.png`         | README header. 2560×640 (2×).                                      |
| `graphoria-social-preview.png` | GitHub social preview. 1280×640 — upload under Settings → General. |
| `graphoria-avatar-dark.png`    | Org / repo avatar. 512×512. Default.                               |
| `graphoria-avatar-light.png`   | Avatar for light contexts. 512×512.                                |
| `favicon.svg`                  | Favicon, switches on `prefers-color-scheme`.                       |
| `favicon-32.png`               | Fallback favicon.                                                  |
| `apple-touch-icon.png`         | 180×180.                                                           |

The favicon and touch icon use a heavier cut of the mark — thicker ring, larger nodes —
because the standard weights close up below 20px.

## Palette

| Token    | Hex       | Use                                     |
| -------- | --------- | --------------------------------------- |
| Ink      | `#0F1720` | Blades, wordmark on light, avatar field |
| Ink deep | `#0A1017` | Banner and social fields                |
| Teal     | `#12A3BF` | Ring and nodes. The primary.            |
| Mint     | `#14B389` | Hub only. One accent, one job.          |
| Paper    | `#FBFCFC` | Wordmark on dark, blades on dark        |
| Slate    | `#8FA0AB` | Taglines, secondary type                |

Teal and mint share lightness and chroma and differ only in hue, so they hold the same
weight next to each other. Deliberately not GraphQL magenta — Graphoria is not affiliated
with the GraphQL Foundation and the identity should not imply it.

## Type

- **Wordmark and headings** — Space Grotesk 600.
- **Taglines, labels, code** — IBM Plex Mono 400.

The wordmark is optically kerned: `Gr` −0.030em, `ri` −0.040em, `ia` −0.024em, with
smaller corrections on the remaining pairs. Retyping it in stock Space Grotesk will
not match — use the supplied files.

## Clear space and minimum size

- **Clear space** on all sides equals the hub diameter — one quarter of the mark's height.
- **Minimum size**: mark 20px, lockup 140px wide, banner 640px wide.
- Below 20px use `favicon.svg`, not the mark.

## Don't

- Don't recolour the mark outside the palette, or fill the ring.
- Don't add gradients, glows, or shadows.
- Don't rebuild the lockup by typing the name — spacing is hand-set.
- Don't rotate the mark. The blade direction is fixed.
- Don't place the mark on a mid-tone; it needs either ink or paper behind it.

## README snippet

```html
<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/graphoria-lockup-dark.png" />
    <img src="docs/brand/graphoria-lockup-light.png" alt="Graphoria" width="360" />
  </picture>
</p>
```

Or with the full banner:

```html
<p align="center">
  <img
    src="docs/brand/graphoria-banner.png"
    alt="Graphoria — instant GraphQL &amp; REST from your database"
    width="880"
  />
</p>
```

## Docs site / console `<head>`

```html
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<link rel="icon" href="/favicon-32.png" sizes="32x32" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
```

## Getting an SVG lockup

The PNG lockups carry live type, not outlines. For a vector lockup, place
`graphoria-mark.svg` next to `Graphoria` set in Space Grotesk 600 with the kerning above,
convert the text to outlines, and export. Mark height = 1.29 × the wordmark's font size;
gap between them = 0.26 × font size.
