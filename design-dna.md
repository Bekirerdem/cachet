# Design DNA: Cachet, "frosted glass"

Written from the built app (`web/src/style.css`, `web/src/main.js`), not from intent. It is the
"frosted glass" direction, chosen from three that were explored. Phone first: the design is one
column, 390 px wide by 844 px tall; on a wide screen it stays a phone column (max 430 px)
centred on a darker ground.

The idea in one sentence: the paper is frosted to everyone, and clear only under the lens,
on the line you are checking.

## PALETTE

| Token | Hex | Coverage | Job |
|---|---|---|---|
| night | `#151531` | about 78% | the ground of every screen |
| night deep | `#0d0c22` | outside the column, overlays | what is behind the phone |
| glass | `rgba(255,255,255,.075)` over night, blur 16 px | about 14% | plates: every grouped piece of content |
| glass clear | `rgba(255,255,255,.13)`, blur 3 px | part of the 14% | a plate that has been confirmed or has passed a check |
| text | `#f1eeff` | about 6% | headings and values |
| soft | `#cfcbf2` | within text | body copy on night |
| mut | `#a9a5d8` | within text | labels, footers, general-knowledge text |
| rim | `#ffb48a` | about 2% | the one accent: the single primary button, plate rims, status words, the lens ring |
| paper | `#f4f2fb` with ink `#22203f` | only where a paper is shown | the copied text, the doctor's sheet |

Accent rule: one filled peach surface per screen (the primary button, or the pair
"Same / Correct it" where the ghost button carries no fill). Status words and rims are peach
lines and text, never fills.

## TYPE

| Role | Face | Weight and size | Used for |
|---|---|---|---|
| display | Geologica Variable | 300 with the key phrase at 600; 33 to 40 px, line height 1.03, tracking -0.03em | one heading per screen; the wordmark at 600, 18 px |
| body | Schibsted Grotesk Variable | 400 to 650; 15.5 px for copy, 17 px on buttons, 13 px for footers | everything a person reads as sentences |
| label | JetBrains Mono Variable | 400, 11 to 11.5 px | plate labels, status words, hashes |
| quote | JetBrains Mono Variable | 400, 11 to 12 px, line height 1.55 to 1.75 | anything copied from the paper, always in this face |
| general knowledge | body, italic, mut colour | 13 px | what the model knows in general (kind of medicine, what a test measures); never the same look as text from the paper |

Fonts are bundled with the app (no font request leaves for a third party). Sentence case
everywhere; no all-caps labels.

## SPACING

- Gutter 20 px left and right; plates span the full column between gutters.
- Plates: radius 20 px, padding 14 by 16 px, 10 px between plates.
- Rows inside a plate: 10 px above and below a 1 px inner line.
- Hit targets: 44 px minimum; primary button 60 px, paired buttons 54 px.
- Radii in use: 20 (plates), 16 (buttons), 14 (lens), 12 (inputs, page chips), 6 (paper). Nothing else.

## LAYOUTS

- **FRAME** (every screen): step line of five segments on top; one row under it with the way
  back on the left (the wordmark where there is no way back) and the language switch on the
  right; scrolling content; a dock at the bottom holding the one action within thumb reach.
- **HERO** (start): heading, two lines of copy, the rendered glass slab filling the middle.
- **STAGE** (hide your name): the photo, centred, with black boxes the person draws; page chips above it.
- **SLAB + CHECKS** (sending, writing): the person's own page behind a frosted slab, three plates below that fill in as each real check passes.
- **PAPER + LENS** (same as the paper?): the copied text, blurred, in a paper panel; a clear band over the line being checked; one plate under it with that line's fields; the two decisions in the dock.
- **PLATES** (plan, proof, how it works): a column of plates, each with a mono label; rows open to show the line from the paper.
- **SHEET** (copied text, photo, sheet for the doctor): a paper-coloured sheet rising over a dimmed, blurred app; the doctor's sheet is the only thing that prints.

## MOTION

Four easings, nothing else:

```css
--e-land:  cubic-bezier(0.16, 1, 0.3, 1);     /* arrive and settle */
--e-pop:   cubic-bezier(0.34, 1.56, 0.64, 1); /* a status word landing, about 8% overshoot */
--e-shift: cubic-bezier(0.76, 0, 0.24, 1);    /* the lens, frost clearing, the step line */
--e-leave: cubic-bezier(0.7, 0, 0.84, 0);     /* exits, shorter than entrances */
```

- Plates **arrive**: 34 px from the right with a clip reveal, 560 ms, 70 ms stagger, 3 px overshoot. No fade.
- The entry plate **swaps in place**: the old one leaves left in 220 ms, the next arrives.
- The **lens sweeps**: position, size and the clear area move together in 700 ms; the paper scrolls under it so the line stays in view.
- **Frost clears**: a plate that passes or is confirmed goes from blur 16 px to blur 3 px in 600 ms.
- Status words **pop** once when a check passes (scale 1.9 to 1 with a small turn).
- The slab **drifts** (7 s) and **glows** (5 s) on the browser's plain `ease-in-out`; with the breathing status word of a running check these are the only loops, and the only ambient layer.
- `prefers-reduced-motion`: every animation and transition is off; waits between screens drop to zero.

## THE MOVE

The lens. One clear band on a blurred page, with a white ring, a soft halo and a peach
edge. It is the only place where the paper is sharp, and it appears on exactly one screen.
Everything else stays behind frost.

## REFUSALS

- No drawn icons, no emoji, no illustration made of shapes. The only image is the rendered glass object.
- No card with a solid fill, no drop shadow that is not part of a glass plate, no gradient background.
- No second accent colour. Red appears only as the word of a failed check.
- No neon, no pure black, no pure white outside the paper.
- No all-caps labels, no letter-spaced eyebrow text, no arrows appended to button text.
- No centred body copy; only the dock's footer line and links are centred.
- No fade-only transition for anything that matters.
- Text from the paper is never set in the body face, and general knowledge is never set in the upright body style.
- No number, medicine or date on screen that the checks in `core/` rejected.

## TESTS

A copy that fails any of these is a bad copy.

1. Count filled peach surfaces on any screen: more than the primary action (or its pair) fails.
2. Find a line copied from the paper that is not in JetBrains Mono, or an italic grey line that came from the paper: fails.
3. Grep the stylesheet for `cubic-bezier(`: more than four distinct curves fails.
4. Blur the screenshot: if the lens is not the first thing the eye lands on in the comparison screen, it fails.
5. Tap targets: any button, link or chip under 44 px tall fails.
6. Turn on reduced motion: anything still moving fails.
7. Look for an icon, an emoji or an uppercase label: any one fails.
