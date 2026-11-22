"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");

const geometry = require(process.env.GEOMETRY_JS || path.join(__dirname, ".build", "screenshot_geometry.js"));

const { planAxis, planTiles, calcOutputSize } = geometry;

assert.deepEqual(planAxis(0, 2000, 600, 1400), [0, 600, 1200, 1400]);
assert.deepEqual(planAxis(100, 500, 600, 2000), [100]);
assert.deepEqual(planAxis(2500, 1000, 600, 2000), [2000]);
assert.deepEqual(planAxis(0, 1200, 800, 400), [0, 400]);
assert.deepEqual(planAxis(-20, 100, 600, 1000), [0]);
assert.deepEqual(planAxis(0, 100, 0, 0), [0]);

assert.deepEqual(planTiles({ x: 50, y: 100, w: 300, h: 2000 }, { w: 600, h: 500 }, 1000, 5000, 400), [
  { x: 50, y: 100 },
  { x: 50, y: 600 },
  { x: 50, y: 1100 },
  { x: 50, y: 1600 },
]);
assert.deepEqual(planTiles({ x: 0, y: 0, w: 1200, h: 700 }, { w: 600, h: 500 }, 600, 200, 400), [
  { x: 0, y: 0 },
  { x: 600, y: 0 },
  { x: 0, y: 200 },
  { x: 600, y: 200 },
]);
assert.equal(planTiles({ x: 0, y: 0, w: 400, h: 400 }, { w: 100, h: 100 }, 300, 300, 3), null);
assert.equal(planTiles({ x: 0, y: 0, w: 0, h: 100 }, { w: 100, h: 100 }, 0, 0, 3), null);

assert.deepEqual(calcOutputSize(600, 1400, 2, 2, 32767, 64000000), { w: 1200, h: 2800 });
assert.deepEqual(calcOutputSize(1440, 900, 1, 1, 32767, 64000000), { w: 1440, h: 900 });
assert.equal(calcOutputSize(20000, 20000, 2, 2, 32767, 64000000), null);
assert.equal(calcOutputSize(10000, 10000, 1, 1, 32767, 64000000), null);
assert.equal(calcOutputSize(0, 10, 1, 1, 32767, 64000000), null);

console.log("geometry tests passed");
