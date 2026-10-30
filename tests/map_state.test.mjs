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

function absoluteUrls({ value }) {
  return [...new Set(value.match(/https:\/\/[^\s\"'<>;]+/g) ?? [])].sort();
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

test("committed map data satisfies the production feature contract", async () => {
  const source = JSON.parse(await readFile(new URL("../map.geojson", import.meta.url), "utf8"));
  const features = validateFeatureCollection({ value: source });
  const sourceNewsItems = source.features.flatMap((feature) => [
    feature.properties,
    ...(feature.properties.older_news ?? []),
  ]);
  const validatedNewsItems = features.flatMap((feature) => feature.newsItems);

  assert.equal(features.length, source.features.length);
  assert.deepEqual(
    features.map((feature) => feature.name),
    source.features.map((feature) => feature.properties.name),
  );
  assert.deepEqual(
    features.map((feature) => feature.coordinates),
    source.features.map((feature) => [feature.geometry.coordinates[1], feature.geometry.coordinates[0]]),
  );
  assert.deepEqual(
    features.map((feature) => feature.newsItems.length),
    source.features.map((feature) => 1 + (feature.properties.older_news?.length ?? 0)),
  );
  assert.deepEqual(
    validatedNewsItems.map((newsItem) => newsItem.summary),
    sourceNewsItems.map((newsItem) => newsItem.summary),
  );
  assert.deepEqual(
    validatedNewsItems.map((newsItem) => newsItem.sourceUrl),
    sourceNewsItems.map((newsItem) => new URL(newsItem.last_page_url).href),
  );
  assert.deepEqual(
    validatedNewsItems.map((newsItem) => newsItem.imageUrl),
    sourceNewsItems.map((newsItem) =>
      Object.hasOwn(newsItem, "image_url") ? new URL(newsItem.image_url).href : null,
    ),
  );
  assert.deepEqual(
    validatedNewsItems.map((newsItem) => newsItem.status.text),
    sourceNewsItems.map((newsItem) => newsItem.status.slice("<strong>".length, -"</strong>".length)),
  );
  assert.deepEqual(
    validatedNewsItems.map((newsItem) => newsItem.status.kind),
    sourceNewsItems.map((newsItem) =>
      newsItem.status.startsWith("<strong>Breaking News (") ? "breaking" : "weekly",
    ),
  );
});

test("static bundle has the complete approved link inventory", async () => {
  const [readme, index, styles, script, state] = await Promise.all([
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../map.css", import.meta.url), "utf8"),
    readFile(new URL("../map.js", import.meta.url), "utf8"),
    readFile(new URL("../map_state.mjs", import.meta.url), "utf8"),
  ]);

  assert.deepEqual(
    [...script.matchAll(/const MAP_URL = "([^"]+)";/g)].map((match) => match[1]),
    ["./map.geojson"],
  );
  assert.deepEqual(
    [...index.matchAll(/\shref="([^"]+)"/g)].map((match) => match[1]),
    [
      "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
      "./map.css",
      "./map.geojson",
    ],
  );
  assert.deepEqual(
    [...index.matchAll(/\ssrc="([^"]+)"/g)].map((match) => match[1]),
    ["https://unpkg.com/leaflet@1.9.4/dist/leaflet.js", "./map.js"],
  );
  assert.deepEqual(
    [...index.matchAll(/http-equiv="Content-Security-Policy" content="([^"]+)"/g)].map((match) => match[1]),
    [
      "default-src 'none'; script-src 'self' https://unpkg.com; style-src 'self' https://unpkg.com; img-src data: https:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; upgrade-insecure-requests",
    ],
  );
  assert.deepEqual(
    {
      readme: absoluteUrls({ value: readme }),
      index: absoluteUrls({ value: index }),
      styles: absoluteUrls({ value: styles }),
      script: absoluteUrls({ value: script }),
      state: absoluteUrls({ value: state }),
    },
    {
      readme: ["https://michaelmedek.github.io/alpin-map/"],
      index: [
        "https://unpkg.com",
        "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
        "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
      ],
      styles: [],
      script: [
        "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
        "https://www.openstreetmap.org/copyright",
      ],
      state: [],
    },
  );
});
