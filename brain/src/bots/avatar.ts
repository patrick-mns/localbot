/**
 * Bot avatars: a flat solid-color circle with a white face, assembled from a
 * small catalog of parts. A bot stores its avatar as a string:
 *   - "v1:<color>:<eyes>:<mouth>:<accessory>[:<shape>]"  chosen from the catalog
 *   - anything else                             a seed; parts are derived from it
 * Same string, same face. Flat on purpose: no gradients, highlights or glows.
 */

export const COLORS = {
  ember: { label: "Ember", fill: "#ef6b47", deep: "#7a1500" },
  sky: { label: "Sky", fill: "#4f9cf9", deep: "#08245c" },
  mint: { label: "Mint", fill: "#3fc380", deep: "#004d2b" },
  sun: { label: "Sun", fill: "#f4ae3d", deep: "#6b3a00" },
  violet: { label: "Violet", fill: "#9b5cff", deep: "#2b0a5c" },
  rose: { label: "Rose", fill: "#ec5a8b", deep: "#5c0a2a" },
  steel: { label: "Steel", fill: "#7b8794", deep: "#1f2933" },
  aqua: { label: "Aqua", fill: "#2cc4b3", deep: "#003d38" },
  indigo: { label: "Indigo", fill: "#5f6bf5", deep: "#141a5c" },
  lime: { label: "Lime", fill: "#a6db2f", deep: "#2a4d00" },
} as const;

export const EYES = ["dot", "pill", "visor", "ring", "happy", "spark"] as const;
export const MOUTHS = ["smile", "line", "dot", "o", "grin", "none"] as const;
export const ACCESSORIES = ["none", "cheeks"] as const;
/** Head silhouettes; the app draws the same ones in 3D (BlockShape). */
export const SHAPES = ["round", "egg", "wide", "bean", "star", "asterisk"] as const;
/** Extras that were removed; faces that used them keep everything else. */
const RETIRED_ACCESSORIES = ["antenna", "antennae", "orbit"];

type Color = keyof typeof COLORS;
export interface AvatarSpec {
  color: Color;
  eyes: (typeof EYES)[number];
  mouth: (typeof MOUTHS)[number];
  accessory: (typeof ACCESSORIES)[number];
  shape: (typeof SHAPES)[number];
}

const PART_LABELS: Record<string, string> = {
  dot: "Dots", pill: "Pills", visor: "Visor", ring: "Rings", happy: "Happy", spark: "Sparks",
  smile: "Smile", line: "Line", o: "Oh", grin: "Grin", none: "None",
  cheeks: "Cheeks",
  round: "Round", egg: "Egg", wide: "Wide", bean: "Bean", star: "Star", asterisk: "Asterisk",
};

/** mulberry32 seeded by an FNV-1a hash of the seed string. */
function rng(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: () => number, list: readonly T[]) => list[Math.floor(r() * list.length)];

export function parseAvatar(value: string): AvatarSpec {
  const [v, color, eyes, mouth, accessory, shape] = value.split(":");
  if (v === "v1" && color in COLORS && (EYES as readonly string[]).includes(eyes) && (MOUTHS as readonly string[]).includes(mouth)) {
    const extra = (ACCESSORIES as readonly string[]).includes(accessory) ? accessory
      : RETIRED_ACCESSORIES.includes(accessory) ? "none" : null;
    if (extra) {
      const spec = { color, eyes, mouth, accessory: extra } as Omit<AvatarSpec, "shape">;
      return { ...spec, shape: (SHAPES as readonly string[]).includes(shape) ? (shape as AvatarSpec["shape"]) : legacyShape(spec) };
    }
  }
  const r = rng(value);
  const spec = {
    color: pick(r, Object.keys(COLORS) as Color[]),
    eyes: pick(r, EYES),
    mouth: pick(r, MOUTHS),
    // Most random faces stay plain; accessories are a choice.
    accessory: r() < 0.75 ? "none" : "cheeks",
  } as Omit<AvatarSpec, "shape">;
  return { ...spec, shape: legacyShape(spec) };
}

/**
 * Faces saved before the shape was a choice keep the head they had: the app
 * used to derive it from the other parts with this hash.
 */
function legacyShape(s: Omit<AvatarSpec, "shape">): AvatarSpec["shape"] {
  let sum = 0n;
  for (const byte of Buffer.from(COLORS[s.color].fill + s.eyes + s.mouth + s.accessory, "utf8")) {
    sum = (sum * 31n + BigInt(byte)) & 0xffffffffffffffffn;
  }
  // Only the original four existed back then.
  return SHAPES[Number(sum % 4n)];
}

export const formatAvatar = (s: AvatarSpec) => `v1:${s.color}:${s.eyes}:${s.mouth}:${s.accessory}:${s.shape}`;

/** Superellipse exponent and half sizes in the 64×64 space, as in the app. */
const SHAPE_GEOMETRY: Record<Exclude<AvatarSpec["shape"], "star" | "asterisk">, { n: number; a: number; b: number }> = {
  round: { n: 2, a: 27, b: 27 },
  egg: { n: 2.2, a: 23, b: 27 },
  wide: { n: 3.4, a: 29, b: 21 },
  bean: { n: 2.8, a: 27, b: 23 },
};

/** The head as an SVG path, scaled so it fills the 64×64 tile like the old circle. */
function headPath(shape: AvatarSpec["shape"]) {
  if (shape === "star" || shape === "asterisk") return pointedPath(shape);
  const { n, a, b } = SHAPE_GEOMETRY[shape];
  const k = 31 / Math.max(a, b);
  const pts = Array.from({ length: 72 }, (_, i) => {
    const t = (i / 72) * 2 * Math.PI, c = Math.cos(t), s = Math.sin(t);
    const x = 32 + k * a * Math.sign(c) * Math.abs(c) ** (2 / n);
    const y = 32 + k * b * Math.sign(s) * Math.abs(s) ** (2 / n);
    return `${x.toFixed(2)} ${y.toFixed(2)}`;
  });
  return `M${pts.join("L")}Z`;
}

/** Star and asterisk: radius as a function of the angle, one point up (as in the app). */
function pointedPath(shape: "star" | "asterisk") {
  const base = shape === "star" ? 0.62 : 0.6;
  const k = 31 / 29;
  const pts = Array.from({ length: 240 }, (_, i) => {
    const t = (i / 240) * 2 * Math.PI;
    const wave = shape === "star" ? (1 + Math.cos(5 * (t + Math.PI / 2))) / 2 : Math.abs(Math.cos(3 * (t + Math.PI / 2))) ** 4;
    const r = 29 * k * (base + (1 - base) * wave);
    return `${(32 + r * Math.cos(t)).toFixed(2)} ${(32 + r * Math.sin(t)).toFixed(2)}`;
  });
  return `M${pts.join("L")}Z`;
}

const INK = "#fff";
const EYE_Y = 31;
const [L, R] = [22, 42];

function eyes(kind: AvatarSpec["eyes"]) {
  switch (kind) {
    case "dot":
      return `<circle cx="${L}" cy="${EYE_Y}" r="3.6" fill="${INK}"/><circle cx="${R}" cy="${EYE_Y}" r="3.6" fill="${INK}"/>`;
    case "pill":
      return [L, R].map((x) => `<rect x="${x - 2.6}" y="${EYE_Y - 5.5}" width="5.2" height="11" rx="2.6" fill="${INK}"/>`).join("");
    case "visor":
      return `<rect x="${L - 5}" y="${EYE_Y - 2.5}" width="${R - L + 10}" height="5" rx="2.5" fill="${INK}"/>`;
    case "ring":
      return [L, R].map((x) => `<circle cx="${x}" cy="${EYE_Y}" r="3.8" fill="none" stroke="${INK}" stroke-width="2.4"/>`).join("");
    case "happy":
      return [L, R].map((x) =>
        `<path d="M${x - 4} ${EYE_Y + 1.5} Q${x} ${EYE_Y - 4.5} ${x + 4} ${EYE_Y + 1.5}" fill="none" stroke="${INK}" stroke-width="2.6" stroke-linecap="round"/>`).join("");
    case "spark":
      return [L, R].map((x) => {
        const y = EYE_Y;
        return `<path d="M${x} ${y - 5} L${x + 1.4} ${y - 1.4} L${x + 5} ${y} L${x + 1.4} ${y + 1.4} L${x} ${y + 5} L${x - 1.4} ${y + 1.4} L${x - 5} ${y} L${x - 1.4} ${y - 1.4} Z" fill="${INK}"/>`;
      }).join("");
  }
}

function mouth(kind: AvatarSpec["mouth"]) {
  switch (kind) {
    case "smile":
      return `<path d="M25 42 Q32 48 39 42" fill="none" stroke="${INK}" stroke-width="2.4" stroke-linecap="round"/>`;
    case "line":
      return `<rect x="26" y="42" width="12" height="2.4" rx="1.2" fill="${INK}"/>`;
    case "dot":
      return `<circle cx="32" cy="43.5" r="1.9" fill="${INK}"/>`;
    case "o":
      return `<ellipse cx="32" cy="43.5" rx="2.6" ry="3.2" fill="none" stroke="${INK}" stroke-width="2"/>`;
    case "grin":
      return `<path d="M25 41 Q32 49 39 41 Z" fill="${INK}"/>`;
    case "none":
      return "";
  }
}

function accessory(kind: AvatarSpec["accessory"], deep: string) {
  if (kind !== "cheeks") return "";
  return `<circle cx="17" cy="40" r="3" fill="${deep}" opacity="0.3"/><circle cx="47" cy="40" r="3" fill="${deep}" opacity="0.3"/>`;
}

export function renderAvatar(spec: AvatarSpec): string {
  const c = COLORS[spec.color];
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<path d="${headPath(spec.shape)}" fill="${c.fill}"/>` +
    accessory(spec.accessory, c.deep) +
    eyes(spec.eyes) +
    mouth(spec.mouth) +
    `</svg>`
  );
}

/** SVG for a stored avatar string (catalog spec or legacy seed). */
export const avatarSVG = (value: string) => renderAvatar(parseAvatar(value));

/** Face parts plus colors, so shells can draw (and animate) the face natively. */
export function faceOf(value: string) {
  const spec = parseAvatar(value);
  return { ...spec, fill: COLORS[spec.color].fill, deep: COLORS[spec.color].deep };
}

/**
 * The catalog for a picker: every option of every part, each rendered on top
 * of the current face so the user sees exactly what they'd get.
 */
export function avatarOptions(value: string) {
  const base = parseAvatar(value);
  const option = (patch: Partial<AvatarSpec>, id: string, label: string) => {
    const spec = { ...base, ...patch };
    return { id, label, value: formatAvatar(spec), svg: renderAvatar(spec) };
  };
  return {
    value: formatAvatar(base),
    svg: renderAvatar(base),
    face: { ...base, fill: COLORS[base.color].fill, deep: COLORS[base.color].deep },
    colors: (Object.keys(COLORS) as Color[]).map((id) => ({ ...option({ color: id }, id, COLORS[id].label), fill: COLORS[id].fill })),
    eyes: EYES.map((id) => option({ eyes: id }, id, PART_LABELS[id])),
    mouths: MOUTHS.map((id) => option({ mouth: id }, id, PART_LABELS[id])),
    accessories: ACCESSORIES.map((id) => option({ accessory: id }, id, PART_LABELS[id])),
    shapes: SHAPES.map((id) => option({ shape: id }, id, PART_LABELS[id])),
  };
}

/** A random face, as a catalog spec (so it can be tweaked afterwards). */
export function randomAvatar(): string {
  return formatAvatar(parseAvatar(Math.random().toString(36)));
}
