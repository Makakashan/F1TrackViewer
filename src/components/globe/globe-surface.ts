import * as THREE from "three";

export const EARTH_RADIUS = 2;
/** How far land stands above the sea at the coast, and how much the highest peak adds — both far past real scale, so the relief reads at globe distance. */
const LAND_STEP = 0.006;
const RELIEF_HEIGHT = 0.06;
const RELIEF_GAMMA = 0.8;
/** How much steeper the shading reads than the displaced height, so hills too small for a vertex still cast light and shade. */
const BUMP = 5;
/** The mip the vertex shader reads, so a vertex sees the average of the texels between it and its neighbours instead of one of them. */
const VERTEX_LOD = 2;
/** The CPU copy matches that mip: 4096 >> VERTEX_LOD. */
const SAMPLER_WIDTH = 1024;

export const EARTH_DAY_URL = "/textures/earth/earth-day.jpg";
export const EARTH_RELIEF_URL = "/textures/earth/earth-relief.png";

export function latLonToVector3(lat: number, lon: number, radius: number) {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lon + 180) * (Math.PI / 180);
  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  );
}

function surfaceHeight(elevation: number, land: number) {
  return land * (LAND_STEP + Math.pow(elevation, RELIEF_GAMMA) * RELIEF_HEIGHT);
}

/** Reads the relief map on the CPU, so markers and borders stand on the same surface the vertex shader draws. */
export class ReliefSampler {
  private readonly data: Uint8ClampedArray;
  private readonly width: number;
  private readonly height: number;

  constructor(image: CanvasImageSource) {
    this.width = SAMPLER_WIDTH;
    this.height = SAMPLER_WIDTH / 2;
    const canvas = document.createElement("canvas");
    canvas.width = this.width;
    canvas.height = this.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(image, 0, 0, this.width, this.height);
    this.data = ctx.getImageData(0, 0, this.width, this.height).data;
  }

  /** Distance from the globe's centre to its surface at a point. */
  radiusAt(lat: number, lon: number) {
    const x = ((lon + 180) / 360) * this.width - 0.5;
    const y = ((90 - lat) / 180) * this.height - 0.5;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    let elevation = 0;
    let land = 0;
    for (const [dx, dy, w] of [
      [0, 0, (1 - fx) * (1 - fy)],
      [1, 0, fx * (1 - fy)],
      [0, 1, (1 - fx) * fy],
      [1, 1, fx * fy],
    ]) {
      const px = (((x0 + dx) % this.width) + this.width) % this.width;
      const py = THREE.MathUtils.clamp(y0 + dy, 0, this.height - 1);
      const i = (py * this.width + px) * 4;
      elevation += (this.data[i] / 255) * w;
      land += (this.data[i + 1] / 255) * w;
    }
    return EARTH_RADIUS + surfaceHeight(elevation, land);
  }
}

export function createEarthMaterial(day: THREE.Texture, relief: THREE.Texture) {
  const { width, height } = relief.image as HTMLImageElement;
  return new THREE.ShaderMaterial({
    uniforms: {
      dayMap: { value: day },
      reliefMap: { value: relief },
      texel: { value: new THREE.Vector2(1 / width, 1 / height) },
    },
    defines: {
      EARTH_RADIUS: EARTH_RADIUS.toFixed(4),
      LAND_STEP: LAND_STEP.toFixed(4),
      RELIEF_HEIGHT: RELIEF_HEIGHT.toFixed(4),
      RELIEF_GAMMA: RELIEF_GAMMA.toFixed(4),
      VERTEX_LOD: VERTEX_LOD.toFixed(1),
      BUMP: BUMP.toFixed(1),
    },
    vertexShader: /* glsl */ `
      uniform sampler2D reliefMap;
      varying vec2 vUv;
      varying vec3 vObjectPosition;
      varying vec3 vViewPosition;
      varying vec3 vNormal;
      varying vec3 vEast;
      varying vec3 vNorth;

      void main() {
        vec2 relief = textureLod(reliefMap, uv, VERTEX_LOD).rg;
        float height = relief.g * (LAND_STEP + pow(relief.r, RELIEF_GAMMA) * RELIEF_HEIGHT);
        vec3 n = normalize(position);
        vec3 displaced = n * (EARTH_RADIUS + height);
        vec3 east = normalize(vec3(n.z, 0.0, -n.x) + vec3(1e-5, 0.0, 0.0));
        vUv = uv;
        vObjectPosition = displaced;
        vNormal = normalMatrix * n;
        vEast = normalMatrix * east;
        vNorth = normalMatrix * cross(n, east);
        vec4 viewPosition = modelViewMatrix * vec4(displaced, 1.0);
        vViewPosition = viewPosition.xyz;
        gl_Position = projectionMatrix * viewPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D dayMap;
      uniform sampler2D reliefMap;
      uniform vec2 texel;
      varying vec2 vUv;
      varying vec3 vObjectPosition;
      varying vec3 vViewPosition;
      varying vec3 vNormal;
      varying vec3 vEast;
      varying vec3 vNorth;

      const vec3 OCEAN = vec3(0.008, 0.03, 0.2);
      const vec3 OCEAN_LIT = vec3(0.02, 0.075, 0.38);
      const vec3 AIR = vec3(0.32, 0.58, 1.0);
      // Key light from the upper left, in view space, so the face the visitor looks at is always lit.
      const vec3 KEY = normalize(vec3(-0.45, 0.55, 0.72));

      float heightAt(vec2 uv) {
        vec2 relief = texture2D(reliefMap, uv).rg;
        return relief.g * (LAND_STEP + pow(relief.r, RELIEF_GAMMA) * RELIEF_HEIGHT);
      }

      void main() {
        vec3 n = normalize(vNormal);
        float coslat = max(length(normalize(vObjectPosition).xz), 0.05);

        // Height slope across one and a half texels, in world units on both axes.
        vec2 step = texel * 1.5;
        float dx = BUMP * (heightAt(vUv + vec2(step.x, 0.0)) - heightAt(vUv - vec2(step.x, 0.0)))
          / (2.0 * step.x * 6.2831853 * EARTH_RADIUS * coslat);
        float dy = BUMP * (heightAt(vUv + vec2(0.0, step.y)) - heightAt(vUv - vec2(0.0, step.y)))
          / (2.0 * step.y * 3.1415927 * EARTH_RADIUS);
        vec2 relief = texture2D(reliefMap, vUv).rg;
        float land = smoothstep(0.3, 0.7, relief.g);

        vec3 normal = normalize(n - dx * normalize(vEast) - dy * normalize(vNorth));
        vec3 viewDir = normalize(-vViewPosition);

        float diffuse = max(dot(normal, KEY), 0.0);
        float facing = max(dot(n, viewDir), 0.0);

        vec3 dayColor = texture2D(dayMap, vUv).rgb;
        float luma = dot(dayColor, vec3(0.2126, 0.7152, 0.0722));
        vec3 landColor = mix(vec3(luma), dayColor, 1.15) * 1.35;
        vec3 oceanColor = mix(OCEAN, OCEAN_LIT, pow(facing, 3.0));

        vec3 albedo = mix(oceanColor, landColor, land);
        vec3 color = albedo * (0.22 + diffuse * 1.05);

        // Atmosphere thickening toward the limb.
        float limb = pow(1.0 - facing, 2.6);
        color = mix(color, AIR * (0.35 + diffuse * 0.65), limb * 0.7);

        gl_FragColor = vec4(color, 1.0);
        #include <colorspace_fragment>
      }
    `,
  });
}
