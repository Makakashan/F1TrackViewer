/**
 * What a wall looks like, and which wall it is.
 *
 * An extruded footprint is honest about where a building stands and says
 * nothing about what it is. Painting storeys as bands said "floors" and not
 * much else — a facade is a pattern of openings, and a pattern is what a
 * texture is for. So each kind of building gets a small tile: one bay wide and
 * one storey tall, repeated along the wall by the sampler, with a shop front
 * under it and a plain strip for the roof.
 *
 * Greyscale on purpose. The tile multiplies the palette's own building colour,
 * so the diorama stays the colour it is and the windows are holes in it.
 */

import { PNG } from "pngjs";

/** What a building is, as far as its walls are concerned. */
export type Facade = "tower" | "block" | "house" | "retail" | "plain";

export const FACADES: Facade[] = ["tower", "block", "house", "retail", "plain"];

/** One bay across and one storey up: the physical size of a tile. */
export const BAY_M = 2.7;
export const FACADE_STOREY_M = 3.1;

/**
 * Which of a facade's two tiles a wall is asking for.
 *
 * A storey tile repeats both ways — across the wall by the bay and up it by the
 * floor — so a wall of any height is one quad. The ground floor is its own tile
 * and its own quad, because a shop front is not a storey repeated.
 */
export type FacadeZone = "storey" | "shop";

const WIDTH = 96;
const HEIGHT = 96;

/** Wall, frame, glass. Nothing goes near black: the AO pass multiplies over it. */
const WALL = 1;
const FRAME = 0.84;
const GLASS = 0.52;
const SLAB = 0.7;

interface Plan {
  /** Window opening as a share of the bay and of the storey. */
  windowWidth: number;
  windowHeight: number;
  /** How many openings across one bay. */
  lights: number;
  /** A slab across the bottom of the storey: a balcony. */
  balcony: boolean;
  /** The shop front: how much of the ground floor is glass. */
  shopGlass: number;
}

const PLAN: Record<Facade, Plan> = {
  // Tall and repetitive: a ribbon of glass, no balconies.
  tower: { windowWidth: 0.72, windowHeight: 0.5, lights: 2, balcony: false, shopGlass: 0.8 },
  // Somebody lives here, so it has a balcony every floor and one window a room.
  block: { windowWidth: 0.5, windowHeight: 0.46, lights: 2, balcony: true, shopGlass: 0.55 },
  // A house has fewer, smaller openings and more wall between them.
  house: { windowWidth: 0.34, windowHeight: 0.4, lights: 1, balcony: false, shopGlass: 0.3 },
  // A shop is glass at the bottom and almost nothing above it.
  retail: { windowWidth: 0.3, windowHeight: 0.28, lights: 1, balcony: false, shopGlass: 0.92 },
  // A wall with a door in it somewhere: warehouses, plant rooms, car parks.
  plain: { windowWidth: 0.18, windowHeight: 0.22, lights: 1, balcony: false, shopGlass: 0.12 },
};

function fill(png: PNG, x0: number, y0: number, x1: number, y1: number, level: number): void {
  const value = Math.round(Math.max(0, Math.min(1, level)) * 255);
  for (let y = Math.max(0, Math.round(y0)); y < Math.min(HEIGHT, Math.round(y1)); y++) {
    for (let x = Math.max(0, Math.round(x0)); x < Math.min(WIDTH, Math.round(x1)); x++) {
      const at = (y * WIDTH + x) * 4;
      png.data[at] = value;
      png.data[at + 1] = value;
      png.data[at + 2] = value;
      png.data[at + 3] = 255;
    }
  }
}

/** One tile of one kind of building, as PNG bytes. */
export function facadeTexture(facade: Facade, zone: FacadeZone): Buffer {
  const plan = PLAN[facade];
  const png = new PNG({ width: WIDTH, height: HEIGHT });
  fill(png, 0, 0, WIDTH, HEIGHT, WALL);

  if (zone === "storey") {
    if (plan.balcony) {
      // A slab across the bottom of the floor, which is what a balcony is from
      // the street: a line under the windows rather than a box.
      fill(png, 0, HEIGHT * 0.84, WIDTH, HEIGHT, SLAB);
    }
    for (let light = 0; light < plan.lights; light++) {
      const centre = ((light + 0.5) / plan.lights) * WIDTH;
      const halfWidth = (plan.windowWidth / plan.lights) * WIDTH * 0.5;
      const height = HEIGHT * plan.windowHeight;
      const top = HEIGHT * 0.22;
      fill(png, centre - halfWidth - 2, top - 2, centre + halfWidth + 2, top + height + 2, FRAME);
      fill(png, centre - halfWidth, top, centre + halfWidth, top + height, GLASS);
    }
    return PNG.sync.write(png);
  }

  const glassHalf = (plan.shopGlass * WIDTH) / 2;
  fill(png, WIDTH / 2 - glassHalf - 2, HEIGHT * 0.16, WIDTH / 2 + glassHalf + 2, HEIGHT * 0.94, FRAME);
  fill(png, WIDTH / 2 - glassHalf, HEIGHT * 0.22, WIDTH / 2 + glassHalf, HEIGHT * 0.88, GLASS);
  return PNG.sync.write(png);
}

/** How a footprint is read as one kind of building or another. */
export interface FacadeEvidence {
  heightM: number;
  areaM2: number;
  /** The OSM `building` value, which is `yes` on two thirds of Monaco. */
  tag?: string;
}

/** Tall enough that a Monaco block is a tower rather than a house. */
const TOWER_M = 25;
const BLOCK_M = 10;
/** A plot this small is somebody's house whatever it says. */
const HOUSE_M2 = 150;
/** Low and wide is a shed, a shop or a car park, not a home. */
const WIDE_M2 = 900;

/**
 * The survey decides where it says anything, and the shape decides otherwise.
 *
 * Two thirds of Monaco's footprints are tagged `building=yes`, so a classifier
 * that trusted the tag would put one facade on the whole city. Height and area
 * are measured for every one of them.
 */
export function facadeOf({ heightM, areaM2, tag }: FacadeEvidence): Facade {
  switch (tag) {
    case "house":
    case "detached":
    case "bungalow":
    case "villa":
      return "house";
    case "retail":
    case "commercial":
    case "supermarket":
    case "kiosk":
    case "restaurant":
      return "retail";
    case "industrial":
    case "warehouse":
    case "garage":
    case "garages":
    case "parking":
    case "service":
    case "roof":
    case "construction":
      return "plain";
    case "apartments":
    case "residential":
      return heightM >= TOWER_M ? "tower" : "block";
    default:
      break;
  }
  if (heightM >= TOWER_M) return "tower";
  if (heightM < BLOCK_M && areaM2 >= WIDE_M2) return "retail";
  if (heightM < BLOCK_M && areaM2 <= HOUSE_M2) return "house";
  if (heightM < BLOCK_M) return "retail";
  return "block";
}
