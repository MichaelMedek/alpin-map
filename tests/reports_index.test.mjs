import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { computeReports } from "../reindex.mjs";

// The highlight-reports overview loads the committed data/reports/index.json directly (GitHub Pages has no build
// step), so a stale or hand-edited manifest would ship wrong markers. This gate recomputes the manifest from the
// report files and fails if the committed one differs, forcing a reindex before merge. Only the `reports` array
// is compared; the top-level `generated_at` is a free-running timestamp and is intentionally ignored.
test("committed data/reports/index.json is up to date with the report files", async () => {
  const committed = JSON.parse(await readFile(new URL("../data/reports/index.json", import.meta.url), "utf8"));
  const expected = await computeReports();
  assert.deepEqual(
    committed.reports,
    expected,
    "data/reports/index.json is stale or hand-edited; regenerate it with `node reindex.mjs` (or start serve.mjs).",
  );
});

test("each index centroid is the mean of its report's published photos", async () => {
  // The overview marker must sit at the published photo set's own centre, not a pre-snap cluster mean, so a new
  // report of the same resort (a few metres shifted) lands at its true average rather than a stale fixed point.
  const base = new URL("../data/reports/", import.meta.url);
  const committed = JSON.parse(await readFile(new URL("index.json", base), "utf8"));
  for (const entry of committed.reports) {
    const report = JSON.parse(await readFile(new URL(entry.id + ".json", base), "utf8"));
    const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
    const expected = [mean(report.photos.map((p) => p.geo.latitude)), mean(report.photos.map((p) => p.geo.longitude))];
    assert.ok(Math.abs(entry.centroid[0] - expected[0]) < 1e-9, entry.id + " centroid latitude must be the photo mean");
    assert.ok(Math.abs(entry.centroid[1] - expected[1]) < 1e-9, entry.id + " centroid longitude must be the photo mean");
  }
});
