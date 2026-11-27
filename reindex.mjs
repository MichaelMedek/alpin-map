// Regenerate data/reports/index.json from the report files present in data/reports/.
//
// The highlight-reports overview needs a small manifest (centroid + title + who/when) because a static site has
// no directory listing and must not download every full report just to place markers. This rebuilds that
// manifest from whatever <id>.json report files are in data/reports/, so the index is never hand-edited: to add
// a report, drop its JSON there and run `node reindex.mjs` (the local server also runs this on start). A report
// file missing `generated_at` (the bare standalone output) is wrapped in place first, so it becomes a valid
// page-4 document the viewer loads.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateReportArtifact } from "./map_state.mjs";

const DIR = fileURLToPath(new URL("./data/reports/", import.meta.url));

export async function computeReports() {
  // Pure: read every <id>.json report file and return the sorted index entries, writing nothing. Each file is run
  // through the SAME validateReportArtifact the viewer uses, so the generator cannot diverge from the viewer:
  // a malformed report fails loudly here (and in the CI freshness check) instead of silently dropping photos or
  // emitting an invalid URL/count, and every index field is derived from the validated artifact.
  const names = (await readdir(DIR)).filter((name) => name.endsWith(".json") && name !== "index.json").sort();
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const reports = [];
  for (const name of names) {
    const artifact = validateReportArtifact({ value: JSON.parse(await readFile(DIR + name, "utf8")) });
    // Every file in data/reports MUST be a fully mapped report. The standalone never writes an unmapped report
    // (no centre / no placed photos is skipped at the source), so an empty or timestamp-only payload here is
    // corruption: validateReportArtifact throws on a null-centre body, and a timestamp-only payload (which it
    // returns null for) is rejected explicitly. Nothing empty is tolerated.
    if (artifact === null) throw new Error("Report file is not a mapped report (empty/timestamp-only): " + name);
    // Every field comes from the validated artifact: the centroid is the mean of the validated photos (so it is by
    // definition the published set's own mean), the count is the validated photo count, and source_url is the
    // HTTP-checked report URL.
    reports.push({
      id: name.replace(/\.json$/, ""),
      forum: artifact.report.forum,
      author: artifact.report.author,
      date: artifact.report.date,
      title: artifact.report.title,
      source_url: artifact.report.sourceUrl,
      centroid: [mean(artifact.photos.map((photo) => photo.latitude)), mean(artifact.photos.map((photo) => photo.longitude))],
      photo_count: artifact.photos.length,
    });
  }
  reports.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));
  return reports;
}

export async function reindex() {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  // A bare report (no generated_at) is wrapped in place first, so the served file validates as a page-4 document.
  const names = (await readdir(DIR)).filter((name) => name.endsWith(".json") && name !== "index.json");
  for (const name of names) {
    const path = DIR + name;
    const data = JSON.parse(await readFile(path, "utf8"));
    if (!Object.hasOwn(data, "generated_at")) {
      await writeFile(path, JSON.stringify({ generated_at: now, ...data }, null, 2) + "\n");
    }
  }
  const reports = await computeReports();
  await writeFile(DIR + "index.json", JSON.stringify({ generated_at: now, reports: reports }, null, 2) + "\n");
  return reports.length;
}

// Run as a standalone command: `node reindex.mjs`. The argv guard avoids a crash when the module is imported in
// a context with no entry script (e.g. `node -e` or a REPL), where process.argv[1] is undefined.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log("wrote index.json with " + (await reindex()) + " reports");
}
