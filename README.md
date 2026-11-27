# Alpine ski briefing

Map link: https://michaelmedek.github.io/alpin-map/

Public static viewer for the daily Alpine ski briefing:

- **Resort news** — map of current construction and infrastructure progress (`data/day/page1_resort_news.geojson`).
- **Snow & conditions** — map of current snow, slope and mountain conditions (`data/day/page2_snow_conditions.geojson`).
- **Report of the day** — the non-map page with the forum story of the day (`data/day/page3_briefing.json`).
- **Report on map** — the report of the day mapped to its lifts, slopes and photo view-directions (`data/day/page4_report_of_day.json`); shows a plain hint when the report has no geotagged images.
- **Tips** — the non-map page with three practical tips from the forums (`data/day/page3_briefing.json`).
- **Debates** — the non-map page with three pro/contra debates from the forums (`data/day/page3_briefing.json`).
- **Weekly briefing** — the non-map page with the editor's condensed briefing of the week (`data/week/weekly_briefing.md`); it updates once per week, not daily.
- **Highlight reports** — an overview map of hand-picked forum trip reports (`data/reports/index.json`), one centroid marker per report; selecting one opens it on its own map (`data/reports/<id>.json`), rendered by the same report-on-map view.

Data layout: `data/day/` holds the daily-published pages, `data/week/` the weekly digest, and `data/reports/` the forever collection of highlight reports plus its `index.json`.

Every map page uses one shared marker-and-detail base — OpenTopoMap relief with the OpenSnowMap pistes overlay, so lifts and slopes are visible throughout. On the resort-news and snow pages a red marker is this run's breaking news and a blue marker is the weekly carousel; on the highlight-reports overview a red marker is one collected report.


## View locally

Run `node serve.mjs` (Node only) and open the printed localhost link; it serves these files just like GitHub Pages. Starting it also regenerates `data/reports/index.json` via `reindex.mjs`.
