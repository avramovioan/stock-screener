import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const publicFile = (name: string) =>
  fileURLToPath(new URL(`../apps/web/public/${name}`, import.meta.url));

const TARGETS = [
  { source: "icon.svg", output: "icon-192.png", size: 192 },
  { source: "icon.svg", output: "icon-512.png", size: 512 },
  { source: "icon-maskable.svg", output: "icon-maskable-512.png", size: 512 },
  // iOS applies its own rounding: use the opaque full-bleed artwork
  { source: "icon-maskable.svg", output: "apple-touch-icon.png", size: 180 },
];

for (const { source, output, size } of TARGETS) {
  const svg = readFileSync(publicFile(source), "utf8");
  const png = new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();
  writeFileSync(publicFile(output), png);
  console.log(`wrote ${output} (${size}x${size}, ${png.length} bytes)`);
}
