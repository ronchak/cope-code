import assert from "node:assert/strict";
import test from "node:test";

import { runtimeFloorDetail } from "../../src/cli/doctor.js";

test("macOS doctor remediation names observed and required Node/npm floors", () => {
  assert.equal(runtimeFloorDetail("Node.js", "v22.16.0", 24, false), "v22.16.0; requires Node.js 24+");
  assert.equal(runtimeFloorDetail("npm", "v10.9.2", 11, false), "v10.9.2; requires npm 11+");
  assert.equal(runtimeFloorDetail("Node.js", "v24.14.0", 24, true), "v24.14.0");
});
