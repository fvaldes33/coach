import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readBarcodes } from "zxing-wasm/reader";

const FOOD_FORMATS = ["EAN13", "EAN8", "UPCA", "UPCE", "DataBar", "DataBarExpanded", "QRCode"];

/** Decode product barcodes in a photo. Local (wasm), no network. */
export async function scanImage(file: string): Promise<{ text: string; format: string }[]> {
  const bytes = fs.readFileSync(file);
  const results = await readBarcodes(new Blob([bytes]), {
    tryHarder: true,
    tryRotate: true,
    tryInvert: true,
    tryDownscale: true,
    maxNumberOfSymbols: 4,
    formats: FOOD_FORMATS,
  } as never);
  const seen = new Set<string>();
  return results
    .filter((r) => r.isValid && r.text && !seen.has(r.text) && seen.add(r.text))
    .map((r) => ({ text: r.text, format: r.format }));
}

/**
 * iPhone photos arrive as HEIC, which neither the barcode decoder nor every
 * worker model can read. `sips` ships with macOS; convert to a JPEG sibling.
 */
export function toJpegIfNeeded(file: string): string {
  if (!/\.(heic|heif|tiff?)$/i.test(file)) return file;
  const out = file.replace(/\.[^.]+$/, ".jpg");
  const r = spawnSync("sips", ["-s", "format", "jpeg", "-Z", "2400", file, "--out", out], { stdio: "ignore" });
  return r.status === 0 && fs.existsSync(out) ? out : file;
}

export const isImage = (file: string) => /\.(jpe?g|png|gif|webp|heic|heif)$/i.test(path.basename(file));
