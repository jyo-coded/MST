import type { MarkerState, Tone } from "@astra/shared";

/** Tone → classes. Colour always travels with a label or an icon, never alone. */
export const TONE: Record<Tone, { text: string; bg: string; line: string; dot: string; hex: string }> = {
  neutral: { text: "text-ink-2", bg: "bg-sunken", line: "border-line", dot: "bg-ink-4", hex: "#b4b2ac" },
  info: { text: "text-ink-2", bg: "bg-sunken", line: "border-line", dot: "bg-ink-3", hex: "#8a8883" },
  progress: { text: "text-prog", bg: "bg-prog-bg", line: "border-prog-line", dot: "bg-prog-dot", hex: "#2a78d6" },
  warning: { text: "text-warn", bg: "bg-warn-bg", line: "border-warn-line", dot: "bg-warn-dot", hex: "#d4961c" },
  success: { text: "text-good", bg: "bg-good-bg", line: "border-good-line", dot: "bg-good-dot", hex: "#3e9a62" },
  danger: { text: "text-bad", bg: "bg-bad-bg", line: "border-bad-line", dot: "bg-bad-dot", hex: "#cc4a40" },
};

/** Map markers: five colour families; the glyph inside tells states apart. */
export const MARKER_STYLE: Record<MarkerState, { fill: string; ring: string; glyph: string; hollow?: boolean; pulse?: boolean }> = {
  NORMAL: { fill: "#8a8883", ring: "#ffffff", glyph: "" },
  MONITORING: { fill: "#d4961c", ring: "#ffffff", glyph: "" },
  FULL: { fill: "#cc4a40", ring: "#ffffff", glyph: "!", pulse: true },
  AI_VERIFICATION: { fill: "#2a78d6", ring: "#ffffff", glyph: "AI", pulse: true },
  AWAITING_ASSIGNMENT: { fill: "#d4961c", ring: "#ffffff", glyph: "?" },
  EN_ROUTE: { fill: "#2a78d6", ring: "#ffffff", glyph: "→" },
  COLLECTING: { fill: "#2a78d6", ring: "#ffffff", glyph: "↓", pulse: true },
  AWAITING_APPROVAL: { fill: "#d4961c", ring: "#ffffff", glyph: "✓" },
  INVESTIGATION: { fill: "#cc4a40", ring: "#ffffff", glyph: "?" },
  COMPLETED: { fill: "#3e9a62", ring: "#ffffff", glyph: "✓" },
  OFFLINE: { fill: "#ffffff", ring: "#8a8883", glyph: "", hollow: true },
};

export const SEVERITY_TONE: Record<string, Tone> = { info: "info", success: "success", warning: "warning", critical: "danger" };
