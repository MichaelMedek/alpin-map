# Alpine ski briefing

Map link: https://michaelmedek.github.io/alpin-map/

Public static viewer for the daily Alpine ski briefing:

- **Resort news** — map of current construction and infrastructure progress (`page1_resort_news.geojson`).
- **Snow & conditions** — map of current snow, slope and mountain conditions (`page2_snow_conditions.geojson`).
- **Report of the day** — the non-map page with the forum story of the day (`page3_briefing.json`).
- **Tips** — the non-map page with three practical tips from the forums (`page3_briefing.json`).
- **Debates** — the non-map page with three pro/contra debates from the forums (`page3_briefing.json`).
- **Weekly briefing** — the non-map page with the editor's condensed briefing of the week (`weekly_briefing.md`); it updates once per week, not daily.

On the two map pages a red marker is this run's breaking news and a blue marker is the weekly carousel


## View locally

Run `node serve.mjs` (Node only) and open the printed localhost link; it serves these files just like GitHub Pages.
