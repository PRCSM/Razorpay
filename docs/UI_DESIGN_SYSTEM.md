# UI_DESIGN_SYSTEM

Two surfaces, one visual language: a landing page and a dashboard.

**Design intent:** the palette deliberately sits in the same family as Razorpay's own buildathon site — warm near-black, cream type, amber accent. A judge opening this should feel it belongs in their world. That's a free, subtle signal, and it costs nothing to take.

---

## Tokens

### Colour

```css
--bg:          #0D0C0B;   /* warm near-black. not #000, not blue-black */
--surface:     #171513;   /* cards, panels */
--surface-2:   #1F1C19;   /* hover, nested */
--border:      rgba(242, 234, 217, 0.08);
--border-str:  rgba(242, 234, 217, 0.16);

--text:        #F2EAD9;   /* cream, not white */
--text-muted:  #8B857C;
--text-faint:  #5A554E;

--accent:      #C88B3E;   /* amber */
--accent-dim:  rgba(200, 139, 62, 0.12);

--recovered:   #4A9D6E;
--pending:     #C88B3E;
--blocked:     #C4614A;
--stopped:     #6B6660;
```

Warmth is the whole point. A cool grey dashboard looks like every other dashboard; the warm black plus cream reads as considered.

**Never use pure white or pure black.** `#FFF` on `#000` vibrates and looks cheap.

### Type

```css
--font-sans: 'Geist', 'Inter Tight', system-ui, sans-serif;
--font-mono: 'Geist Mono', 'JetBrains Mono', monospace;
```

**Every number renders in mono with `font-variant-numeric: tabular-nums`.** Money, percentages, counts, timestamps, durations. Non-negotiable — proportional figures shift width as values update, and a KPI row that jitters on refresh looks broken.

| Role | Size / weight / tracking |
|---|---|
| Display (landing hero) | 72–96px · 500 · −0.02em · 1.05 |
| H1 | 32px · 500 · −0.01em |
| H2 | 24px · 500 |
| H3 | 18px · 500 |
| Body | 15px · 400 · 1.6 |
| Small | 13px · 400 |
| Label | 12px · 500 · 0.08em · UPPERCASE · muted |
| Metric | 28–36px · mono · tabular |

### Shape and space

```css
--r-card: 12px;  --r-input: 8px;  --r-pill: 999px;
```

4px base scale: `4 8 12 16 24 32 48 64 96`.
Card padding 24px. Section gap 32px. Page padding 32px.

**No drop shadows.** Dark UIs read elevation through surface lift plus a 1px border. Shadows on dark just look like smudges.

### Icons

Lucide. 1.5px stroke. 16px inline, 20px standalone. `--text-muted` unless conveying state.

---

## Landing page

Reference language: heavy negative space, **hairline rules doing the structural work instead of cards**, asymmetric two-column text, small-caps letterspaced links.

**The landing page uses almost no cards.** Structure comes from 1px horizontal rules and whitespace. This is the deliberate contrast with the dashboard — same palette, opposite density.

### Sections

**1. Hero** — full viewport
- 72–96px headline, left-aligned, max 2 lines
- One-line subhead in `--text-muted` below a 1px rule
- Thin-stroke SVG line diagram of the recovery flow: `failure → diagnose → decide → gate → act → measure`. Stroke `--accent` at 40% opacity, 1.5px. Animated draw-in on load.
- Two links: `VIEW DASHBOARD →` and `GITHUB →` in label style

**2. The problem** — one number, huge
- A single stat in 96px mono, three lines of supporting copy beside it
- Asymmetric: stat left 40%, copy right 45%, 15% gutter

**3. How it works** — four steps
- Numbered `01`–`04` in mono muted, separated by 1px rules
- Each: title, two lines. No cards, no icons.

**4. Results** — the table
- Pulled from `eval/RESULTS.md`
- Mono tabular throughout, minimal chrome, rules between rows only
- **This is the most important block on the page.** Give it room.

**5. Guardrails**
- Eight gates as a numbered list with rules between
- Small note: "defined in policy.yaml, readable in the repo"

**6. Footer CTA**
- Dashboard · GitHub · Video

### Landing rules

- Max content width 1200px, generous side padding
- One accent colour, used sparingly — if amber appears more than five times, cut some
- Body copy never exceeds ~65 characters per line
- Mobile: single column, hero drops to 40px, diagram scrolls horizontally

---

## Dashboard

Reference language: fixed dark sidebar, KPI tiles with sparklines, dense tables with status pills, a config panel. Built on shadcn/ui — the dark theme already matches, so the visual work is mostly token overrides.

### Layout

```
┌────────────┬──────────────────────────────────────┐
│  SIDEBAR   │  Topbar: page title · time range      │
│  240px     ├──────────────────────────────────────┤
│  fixed     │                                       │
│            │  Content, 32px padding, 24px gaps     │
│            │                                       │
└────────────┴──────────────────────────────────────┘
```

Sidebar: logo, nav, kill-switch status at the bottom. No "Upgrade to Pro" furniture — that's SaaS template noise and it undercuts the product.

Nav: Overview · Cases · Exceptions · Policy · Eval

### Overview

**KPI row** — 5 tiles, equal width
```
┌──────────────┐
│ MONEY AT RISK│  ← label style
│ ₹4,28,500    │  ← 32px mono tabular
│ ▁▂▄▆█ +12%   │  ← sparkline + delta
└──────────────┘
```
Money at risk · Recovered · Recovery rate · Cost per ₹ recovered · False nudges

**Below, two columns:**
- Left 60%: live case feed, newest first, streaming in
- Right 40%: policy summary — active gates, kill-switch toggle, `policy.yaml` version

**Bottom, full width:** guardrail exceptions table with status pills.

### Status pills

```
RECOVERED   green bg 12%, green text, 999px, 11px, 0.04em
PENDING     amber
BLOCKED     red
STOPPED     grey
EXCEPTION   red outline, no fill
SYNTHETIC   muted outline  ← always label the data lane
```

The `SYNTHETIC` pill is a product decision, not a debug affordance. Judges must be able to tell the lanes apart at a glance without reading the README.

### Cases

Dense table. Columns: case id (mono, truncated) · source · amount · root cause · `cause_by` badge · status · attempts · age.
Filters: source, root cause, status, synthetic/live. Row click → detail.

### Case detail — the money shot

A **left-to-right node timeline** — this is the view that carries the video.

```
 ┌────────┐   ┌──────────┐   ┌────────┐   ┌───────┐   ┌────────┐   ┌─────────┐
 │INGESTED│──▶│DIAGNOSED │──▶│PLANNED │──▶│ GATED │──▶│EXECUTED│──▶│RECOVERED│
 └────────┘   └──────────┘   └────────┘   └───────┘   └────────┘   └─────────┘
  webhook      issuer_down    delayed_    8/8 pass    lag 12s      ₹2,400
  02:14:03     rule · 0.98    retry 2h                              04:16:11
```

- Fixed horizontal layout. **No React Flow, no drag-and-drop.** A static flex row with connectors is 90% of the value at 10% of the cost.
- Each node: title, one metric, timestamp. Click to expand raw payload.
- Failed gates render red with the reason inline.
- Below: full audit log, mono, with a chain-verified badge.

### Policy

Renders `policy.yaml` read-only with syntax highlighting. Kill switch as the only interactive element, with a confirm dialog.

Showing the raw config file is the point — it proves "bounded and gated" in twenty seconds rather than claiming it.

### Eval

Renders `RESULTS.md`: three-arm comparison, diagnosis precision/recall, cost model. A prominent note on which lane produced the numbers.

---

## Components

shadcn: `card` `table` `badge` `button` `dialog` `select` `tabs` `switch` `tooltip` `skeleton` `scroll-area`

Custom: `KpiTile` · `Sparkline` (inline SVG, no chart lib) · `StatusPill` · `CaseTimeline` · `GateResultList` · `AuditTrail` · `FlowDiagram` (landing)

**States are mandatory for every view:**
- Loading → skeleton, never a spinner
- Empty → one line of text plus what to do next
- Error → what failed and a retry

An empty state a judge hits with no copy in it reads as unfinished.

---

## Motion

Sparingly. 150ms `ease-out` on hover/state. 300ms fade-slide for new rows. Landing diagram draws once over 1.2s.

Respect `prefers-reduced-motion`. No loading spinners anywhere — skeletons only.

---

## Accessibility

Body text hits AA on `--bg`. `--text-muted` is for secondary content only, never body copy. Never colour alone for state — pills carry text. Keyboard nav works; focus rings visible in `--accent`.
