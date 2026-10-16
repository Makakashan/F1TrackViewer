import * as THREE from "three";

/** Tiling textures for race-view surfaces, drawn on a canvas so nothing ships in `public/`. */

/** One asphalt tile, in metres. */
export const ASPHALT_TILE_M = 7;
/** One tile of fence wire, in metres. */
export const FENCE_TILE_M = 0.5;

/** A fixed sequence, so the texture is the same on every load. */
function sequence(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Near-white with wear patches and aggregate speckle; the material colour sets the tone. */
export function createAsphaltTexture(size = 512): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#e4e4e4";
  ctx.fillRect(0, 0, size, size);

  const random = sequence(1929);
  // Broad patches are what the eye still reads from a helicopter; drawn nine
  // times over so the tile wraps without a seam.
  for (let i = 0; i < 46; i++) {
    const x = random() * size;
    const y = random() * size;
    const r = size * (0.06 + random() * 0.22);
    const tone = random() < 0.55 ? "0,0,0" : "255,255,255";
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, r);
    gradient.addColorStop(0, `rgba(${tone},0.045)`);
    gradient.addColorStop(1, `rgba(${tone},0)`);
    ctx.fillStyle = gradient;
    for (const dx of [-size, 0, size]) {
      for (const dy of [-size, 0, size]) {
        ctx.fillRect(x + dx - r, y + dy - r, r * 2, r * 2);
      }
    }
  }

  const image = ctx.getImageData(0, 0, size, size);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const grain = (random() - 0.5) * 24;
    data[i] += grain;
    data[i + 1] += grain;
    data[i + 2] += grain;
  }
  ctx.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

let shared: { asphalt: THREE.CanvasTexture; fence: THREE.CanvasTexture } | null = null;

/**
 * One pair for the page, never disposed. Two small tiles cost less to keep than
 * to rebuild, and a texture freed by the development double mount before its
 * first draw left the road black.
 */
export function surfaceTextures(anisotropy: number) {
  if (!shared) shared = { asphalt: createAsphaltTexture(), fence: createFenceTexture() };
  shared.asphalt.anisotropy = anisotropy;
  shared.fence.anisotropy = anisotropy;
  return shared;
}

/** Diamond wire on transparent; mipmapped down, it becomes the veil a fence is from far away. */
export function createFenceTexture(size = 64): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.strokeStyle = "rgba(52,56,61,1)";
  ctx.lineWidth = 2;
  const step = size / 2;
  for (let k = -size; k <= size * 2; k += step) {
    ctx.beginPath();
    ctx.moveTo(k, 0);
    ctx.lineTo(k + size, size);
    ctx.moveTo(k, size);
    ctx.lineTo(k + size, 0);
    ctx.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
