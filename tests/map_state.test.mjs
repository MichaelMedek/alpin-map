import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  markerHasCategoryImage,
  markerStyle,
  newsPageState,
  validateFeatureCollection,
} from "../map_state.mjs";

const imageUrl = "https://example.com/news.jpg";
const sourceUrl = "https://example.com/forum/page-3";

const expectedStyles = {
  "breaking-false": { color: "#8f211b", fillColor: "#d9483d", fillOpacity: 0.9, radius: 9, weight: 2 },
  "breaking-true": { color: "#7a120c", fillColor: "#ff3024", fillOpacity: 1, radius: 10, weight: 3 },
  "weekly-false": { color: "#184f75", fillColor: "#337dab", fillOpacity: 0.82, radius: 8, weight: 2 },
  "weekly-true": { color: "#053f73", fillColor: "#0788df", fillOpacity: 0.96, radius: 9, weight: 3 },
};

function item({ kind, withImage }) {
  const value = {
    status: kind === "breaking" ? "<strong>Breaking News (30.10.2026 04:15 Uhr)</strong>" : "<strong>This Week's News (29.10.2026 04:15 Uhr)</strong>",
    summary: "Test construction progress.",
    last_page_url: sourceUrl,
  };
  if (withImage) {
    value.image_url = imageUrl;
  }
  return value;
}

function collection({ kind, primaryImage, olderImage }) {
  const properties = {
    name: "Test resort",
    ...item({ kind: kind, withImage: primaryImage }),
  };
  if (olderImage !== null) {
    properties.older_news = [item({ kind: "weekly", withImage: olderImage })];
  }
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [11.0, 47.0] },
        properties: properties,
      },
    ],
  };
}

for (const scenario of [
  { id: "breaking-normal-single", kind: "breaking", primaryImage: false, olderImage: null, intense: false },
  { id: "breaking-intense-single", kind: "breaking", primaryImage: true, olderImage: null, intense: true },
  { id: "breaking-normal-carousel", kind: "breaking", primaryImage: false, olderImage: true, intense: false },
  { id: "breaking-intense-carousel", kind: "breaking", primaryImage: true, olderImage: false, intense: true },
  { id: "weekly-normal-single", kind: "weekly", primaryImage: false, olderImage: null, intense: false },
  { id: "weekly-intense-single", kind: "weekly", primaryImage: true, olderImage: null, intense: true },
  { id: "weekly-normal-carousel", kind: "weekly", primaryImage: false, olderImage: false, intense: false },
  { id: "weekly-intense-carousel", kind: "weekly", primaryImage: false, olderImage: true, intense: true },
]) {
  test(scenario.id, () => {
    const feature = validateFeatureCollection({
      value: collection({ kind: scenario.kind, primaryImage: scenario.primaryImage, olderImage: scenario.olderImage }),
    })[0];
    const hasImage = markerHasCategoryImage({ newsItems: feature.newsItems });
    assert.equal(hasImage, scenario.intense);
    assert.deepEqual(
      markerStyle({ kind: scenario.kind, hasImage: hasImage }),
      expectedStyles[scenario.kind + "-" + scenario.intense],
    );
    const first = newsPageState({ newsItems: feature.newsItems, activeIndex: 0 });
    assert.equal(first.pageCounterText, scenario.olderImage === null ? "Page 1 of 1" : "Page 1 of 2");
  });
}

test("static bundle uses only sibling map data", async () => {
  const script = await readFile(new URL("../map.js", import.meta.url), "utf8");
  const index = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(script, /const MAP_URL = "\.\/map\.geojson";/);
  assert.doesNotMatch(script, /raw\.githubusercontent\.com\/MichaelMedek\/alpin-api/);
  assert.match(index, /connect-src 'self'/);
  assert.match(index, /href="\.\/map\.geojson"/);
  assert.doesNotMatch(index, /github\.com\/MichaelMedek\/alpin-api/);
});
