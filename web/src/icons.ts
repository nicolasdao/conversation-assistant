// The drawn icons a label set's markers can use: one `<symbol id="i-<name>">` each in index.html, 16 × 16, currentColor.
// The engine's label-set schema and the Create with AI prompt read this list too, so an icon exists everywhere or nowhere.

export const ICONS = [
  "bolt", "smile", "flame", "trend", "star", "scissors",
  "question", "lightbulb", "check", "cross", "warning", "money", "clock", "calendar", "target", "flag",
  "quote", "heart", "thumbs-up", "thumbs-down", "shield", "lock", "link", "chart", "people", "handshake",
  "book", "megaphone", "pin", "sparkle",
] as const;

export type IconName = (typeof ICONS)[number];
