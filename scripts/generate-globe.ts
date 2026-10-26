/**
 * Builds the globe's Earth maps from NASA public-domain sources:
 *   earth-day.jpg    Blue Marble Next Generation, July 2004 — land colour.
 *   earth-relief.png R = land elevation (GEBCO 2008), G = land mask.
 * Downloads are cached in .cache/globe/; pass --refresh to fetch them again.
 */
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

const ROOT = join(import.meta.dir, "..");
const CACHE = join(ROOT, ".cache", "globe");
const OUT = join(ROOT, "public", "textures", "earth");
const WIDTH = 4096;
const HEIGHT = WIDTH / 2;

const SOURCES = {
  day: "https://eoimages.gsfc.nasa.gov/images/imagerecords/74000/74092/world.200407.3x5400x2700.jpg",
  elevation:
    "https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73934/gebco_08_rev_elev_21600x10800.png",
  // Land is pure white in the bathymetry map, which makes it the coastline.
  bathymetry:
    "https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73963/gebco_08_rev_bath_21600x10800.png",
};

async function cached(url: string) {
  const file = join(CACHE, url.slice(url.lastIndexOf("/") + 1));
  if (existsSync(file)) return file;
  console.log(`fetch ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  await writeFile(file, new Uint8Array(await response.arrayBuffer()));
  return file;
}

async function grey(file: string) {
  const { data } = await sharp(file, { limitInputPixels: false })
    .extractChannel(0)
    .resize(WIDTH, HEIGHT, { kernel: "lanczos3" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return data;
}

async function main() {
  if (process.argv.includes("--refresh")) await rm(CACHE, { recursive: true, force: true });
  await mkdir(CACHE, { recursive: true });
  await mkdir(OUT, { recursive: true });

  const day = await cached(SOURCES.day);
  const elevationFile = await cached(SOURCES.elevation);
  const bathymetryFile = await cached(SOURCES.bathymetry);

  await sharp(day)
    .resize(WIDTH, HEIGHT, { kernel: "lanczos3" })
    .jpeg({ quality: 86, mozjpeg: true })
    .toFile(join(OUT, "earth-day.jpg"));

  // Threshold at full resolution so the coast keeps its shape, then let the resize antialias it.
  const { data: bath, info } = await sharp(bathymetryFile, { limitInputPixels: false })
    .extractChannel(0)
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (let i = 0; i < bath.length; i++) bath[i] = bath[i] === 255 ? 255 : 0;
  // A one-channel raw buffer comes back from resize as three; keep the first.
  const mask = await sharp(bath, { raw: { width: info.width, height: info.height, channels: 1 } })
    .resize(WIDTH, HEIGHT, { kernel: "lanczos3" })
    .extractChannel(0)
    .raw()
    .toBuffer();
  const elevation = await grey(elevationFile);

  const relief = Buffer.alloc(WIDTH * HEIGHT * 3);
  for (let i = 0; i < WIDTH * HEIGHT; i++) {
    relief[i * 3] = elevation[i];
    relief[i * 3 + 1] = mask[i];
  }
  await sharp(relief, { raw: { width: WIDTH, height: HEIGHT, channels: 3 } })
    .png({ compressionLevel: 9 })
    .toFile(join(OUT, "earth-relief.png"));

  console.log(`wrote earth-day.jpg and earth-relief.png (${WIDTH}x${HEIGHT}) to ${OUT}`);
}

await main();
