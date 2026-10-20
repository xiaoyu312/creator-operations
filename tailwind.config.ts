/** Portable mapping of the existing UI's CSS tokens; no hosted template runtime. */
const colors = Object.fromEntries([
  'background', 'foreground', 'card', 'popover', 'primary', 'secondary',
  'muted', 'accent', 'info', 'destructive', 'success', 'warning',
  'border', 'input', 'ring', 'sidebar',
].flatMap((name) => [
  [name, `var(--${name})`],
  [`${name}-foreground`, `var(--${name}-foreground)`],
]));
export default {
  content: ['./client/src/**/*.{ts,tsx,css}'],
  theme: { extend: {
    colors,
    borderRadius: { lg: 'var(--radius)', md: 'calc(var(--radius) - 2px)', sm: 'calc(var(--radius) - 4px)' },
    fontFamily: { sans: ['var(--font-sans)'], mono: ['var(--font-mono)'] },
  } },
  plugins: [],
};
