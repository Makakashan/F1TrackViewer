/// <reference types="bun-types" />
/**
 * Serves the baked GLBs to a bare three.js page, so a bake can be looked at
 * without waiting for the app to load it.
 *
 * The app is the real target, but a bake fails in ways a number does not show —
 * a hole in the terrain, a building through the road, a belt seam. This puts the
 * result on screen in one command.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const PORT = Number(process.env.PREVIEW_PORT ?? 4010);

const CONTENT_TYPE: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".glb": "model/gltf-binary",
  ".wasm": "application/wasm",
};

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  return CONTENT_TYPE[path.slice(dot)] ?? "application/octet-stream";
}

const server = Bun.serve({
  port: PORT,
  async fetch(request) {
    const { pathname, searchParams } = new URL(request.url);

    // The page posts its own canvas back here, so a screenshot lands on disk
    // without a megabyte of base64 passing through anything else.
    if (request.method === "POST" && pathname === "/shot") {
      const name = (searchParams.get("name") ?? "shot").replace(/[^a-z0-9-]/gi, "");
      const target = join(REPO_ROOT, "images", `${name}.png`);
      await mkdir(join(REPO_ROOT, "images"), { recursive: true });
      await writeFile(target, Buffer.from(await request.arrayBuffer()));
      console.log(`  wrote images/${name}.png`);
      return new Response("ok");
    }

    const path = pathname === "/" ? "/scripts/env/preview.html" : pathname;

    // Only the two trees the page needs, and no traversal out of them.
    const allowed =
      path.startsWith("/public/") ||
      path.startsWith("/node_modules/three/") ||
      path === "/scripts/env/preview.html";
    if (!allowed || path.includes("..")) return new Response("not found", { status: 404 });

    try {
      const body = await readFile(join(REPO_ROOT, path));
      return new Response(body, { headers: { "content-type": contentTypeFor(path) } });
    } catch {
      return new Response("not found", { status: 404 });
    }
  },
});

console.log(`preview on http://localhost:${server.port}/?circuit=mc-1929`);
console.log("  params: circuit, belts=far,city,core, az, el, dist, y");
