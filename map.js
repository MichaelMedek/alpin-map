import {
  compareFeaturesForNav,
  formatRunTimestamp,
  markerHasCategoryImage,
  markerStyle,
  pagerState,
  reportDotPoints,
  reportWedgePoints,
  statusLabel,
  validateBriefing,
  validateFeatureCollection,
  validateReportArtifact,
} from "./map_state.mjs";

const DEFAULT_CENTER = [46.8, 10.2];
const DEFAULT_ZOOM = 5;
const DEFAULT_ROUTE = "resort-news";
const BRIEFING_URL = "./page3_briefing.json";
const WEEKLY_URL = "./weekly_briefing.md";

// One registry drives the nav chrome and dispatch; the two map routes share renderMapFeatures() (symmetric,
// differing only by data url and labels), the three doc routes each render one section of the shared briefing,
// and the weekly route renders the published markdown.
const ROUTES = {
  "resort-news": { title: "Resort news", subtitle: "Construction and infrastructure progress across the Alps.", view: "map", url: "./page1_resort_news.geojson" },
  snow: { title: "Snow & conditions", subtitle: "Current snow, slope and mountain conditions.", view: "map", url: "./page2_snow_conditions.geojson" },
  report: { title: "Report of the day", subtitle: "The forum story of the day.", view: "doc", render: renderReport },
  "report-map": { title: "Report on map", subtitle: "The report of the day, mapped to its lifts and slopes.", view: "report-map", url: "./page4_report_of_day.json" },
  tips: { title: "Tips", subtitle: "Practical tips from the forums.", view: "doc", render: renderTips },
  debates: { title: "Debates", subtitle: "Pro and contra debates from the forums.", view: "doc", render: renderDebates },
  weekly: { title: "Weekly briefing", subtitle: "The editor's condensed briefing of the week; updates weekly, not daily.", view: "weekly", url: WEEKLY_URL },
};

const mapElement = document.getElementById("map");
const docElement = document.getElementById("doc");
const messageElement = document.getElementById("view-message");
const runTimestampElement = document.getElementById("run-timestamp");

let map = null;
let markerGroup = null;
let reportLegend = null;
let reportOffset = null;
let activeRoute = null;
let activation = 0;
let briefingPromise = null;
let lightbox = null;

// A tiny declarative element builder — the single helper that removes this file's create-assign-append
// repetition. `class`/`text` map to the matching DOM property, `on` registers listeners, hyphenated keys and
// `role` become attributes, everything else is a direct property (src, href, hidden…). It builds only through
// createElement/append/textContent, never innerHTML, so the strict CSP holds.
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "on") for (const [type, handler] of Object.entries(value)) node.addEventListener(type, handler);
    else if (key === "role" || key.includes("-")) node.setAttribute(key, value);
    else node[key] = value;
  }
  for (const child of children) if (child !== null && child !== undefined) node.append(child);
  return node;
}

function linkElement({ href, text, className }) {
  return el("a", { href, text, target: "_blank", rel: "noopener noreferrer", class: className });
}

async function fetchNoStore(url) {
  // A cache-busting no-store GET shared by every data route; a non-2xx is surfaced rather than rendered.
  const response = await fetch(url + "?loaded=" + Date.now(), { cache: "no-store" });
  if (response.ok === false) throw new Error("Request for " + url + " failed with HTTP " + response.status + ".");
  return response;
}

function loadBriefing() {
  // Fetch and validate page 3 at most once: the header date (every page) and the briefing view share it, so
  // there is a single source of truth and a single request for the collapsed page.
  if (briefingPromise === null) {
    briefingPromise = fetchNoStore(BRIEFING_URL)
      .then((response) => response.json())
      .then((payload) => validateBriefing({ value: payload }));
  }
  return briefingPromise;
}

function ensureMap() {
  // Create the Leaflet map once and reuse it across every map route; toggling the container's hidden keeps the
  // single instance cheap. The base is our approved pair: OpenTopoMap relief plus the OpenSnowMap pistes
  // overlay, so lifts and slopes are visible on all map pages, matching the report-on-map view's own map.
  if (map === null) {
    map = L.map(mapElement, { minZoom: 4 }).setView(DEFAULT_CENTER, DEFAULT_ZOOM);
    // Move attribution to the bottom-left so the right-docked detail panel never covers it.
    map.attributionControl.setPosition("bottomleft");
    L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA) &middot; map data &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>, SRTM',
      // OpenTopoMap only renders to z17; allow z18 by upscaling its z17 tiles so the pistes overlay (which goes
      // to z18) never sits over a blank base at maximum zoom.
      maxNativeZoom: 17,
      maxZoom: 18,
    }).addTo(map);
    L.tileLayer("https://www.opensnowmap.org/pistes/{z}/{x}/{y}.png", {
      attribution: 'Pisten &copy; <a href="https://www.opensnowmap.org">OpenSnowMap.org</a>',
      maxZoom: 18,
      opacity: 0.95,
    }).addTo(map);
    markerGroup = L.featureGroup().addTo(map);
  }
  return { map, markerGroup };
}

function clearReportLegend() {
  // The lift legend and the view-direction control belong only to the report-on-map view; drop both when any
  // other route takes the map.
  if (reportLegend !== null) {
    reportLegend.remove();
    reportLegend = null;
  }
  if (reportOffset !== null) {
    reportOffset.remove();
    reportOffset = null;
  }
}

// --- Click-to-enlarge lightbox (native <dialog> modal) ------------------------------------------
// showModal() gives focus trapping, Escape, background inertness and focus-return for free; only backdrop
// light-dismiss and the body-scroll lock are ours. Only one overlay exists at a time.
function closeLightbox() {
  if (lightbox !== null) lightbox.close();
}

function openLightbox({ src, alt }) {
  closeLightbox();
  // A click on the image must not reach the backdrop, so viewing it never closes the overlay.
  const image = el("img", { class: "lightbox__image", src, alt, decoding: "async", referrerPolicy: "no-referrer", on: { click: (event) => event.stopPropagation() } });
  const closeButton = el("button", { type: "button", class: "lightbox__close", "aria-label": "Close enlarged image", text: "×", autofocus: true, on: { click: closeLightbox } });
  lightbox = el("dialog", {
    class: "lightbox",
    "aria-label": "Enlarged image",
    on: {
      // A click on the dialog itself (outside the image) is a light dismiss; close() fires "close" below.
      click: (event) => { if (event.target === lightbox) lightbox.close(); },
      close: () => { lightbox.remove(); document.body.classList.remove("lightbox-open"); lightbox = null; },
    },
  }, image, closeButton);
  document.body.append(lightbox);
  document.body.classList.add("lightbox-open");
  lightbox.showModal();
  return lightbox;
}

function makeImageZoomable({ image }) {
  // Turn a thumbnail into a pointer- and keyboard-operable control; read src at activation time so a popup
  // image whose src changes as the carousel pages stays correct, and ignore the hidden (no-photo) slot.
  image.setAttribute("role", "button");
  image.tabIndex = 0;
  const open = () => {
    if (image.hidden !== true && typeof image.src === "string" && image.src.length > 0) openLightbox({ src: image.src, alt: image.alt });
  };
  image.addEventListener("click", open);
  image.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); }
  });
}

// --- Split-view detail panel ---------------------------------------------------------------------
// One right-docked panel every map page fills, replacing per-marker popups: the map stays visible on the left,
// a click opens the panel (image + description) on the right, it pages in place, and closing it reveals the
// full map with the selection still highlighted so the reader can see where they are.
const detailElement = document.getElementById("detail");
let detailPager = null;
let detailWidth = null;

function closeDetail({ restoreFocus = false } = {}) {
  // Hide the panel and let Leaflet remeasure the now-uncovered map; the map keeps its last selection highlight.
  detailElement.hidden = true;
  detailElement.replaceChildren();
  detailPager = null;
  if (map !== null) {
    map.invalidateSize();
    // A user-initiated close (× or Escape) returns focus to the map container so keyboard focus never falls to
    // document.body; the opener was a marker or wedge, not a DOM control. Programmatic closes during route
    // changes pass restoreFocus=false, since the destination view owns focus then.
    if (restoreFocus === true && mapElement.hidden !== true) map.getContainer().focus();
  }
}

function relocateSelection() {
  // After the panel's width changes (drag or viewport resize), re-run the current selection's locate so the
  // highlighted marker or wedge is re-centered in the resized visible map area instead of left under the panel.
  if (detailPager !== null) detailPager.locate(detailPager.index);
}

function focusOnMap({ latlng }) {
  // Pan so the selected point lands in the visible map area to the LEFT of the overlay panel, not behind it:
  // shift the centre east by half the panel's width (0 when the panel is closed), in projected pixels at the
  // current zoom. The map stays full-width under the panel, so this keeps the highlighted marker in view.
  if (map === null) return;
  const panelWidth = detailElement.hidden ? 0 : detailElement.getBoundingClientRect().width;
  const zoom = map.getZoom();
  map.panTo(map.unproject(map.project(latlng, zoom).add([panelWidth / 2, 0]), zoom), { animate: true });
}

function reconcileDetailWidth() {
  // Keep a dragged width sane across viewport changes: below the mobile breakpoint the panel is full-width via
  // CSS, so drop the inline override there; on desktop clamp a stored width to the current viewport so a width
  // chosen on a wide screen can never push the panel's left edge off-screen.
  if (window.matchMedia("(max-width: 44rem)").matches) {
    detailElement.style.width = "";
  } else if (detailWidth !== null) {
    detailWidth = Math.max(300, Math.min(window.innerWidth * 0.75, detailWidth));
    detailElement.style.width = detailWidth + "px";
  }
}

function startDetailResize(event) {
  // Drag the left boundary to resize the panel (desktop); clamp to a readable min and at most three quarters of
  // the viewport, and remeasure the map live so the left map area tracks the drag.
  event.preventDefault();
  const onMove = (moveEvent) => {
    detailWidth = Math.max(300, Math.min(window.innerWidth * 0.75, window.innerWidth - moveEvent.clientX));
    detailElement.style.width = detailWidth + "px";
    if (map !== null) map.invalidateSize();
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    // Re-center the selection in the resized map area so the highlighted marker never ends up under the panel.
    relocateSelection();
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function renderDetail({ focus }) {
  const { kicker, list, index, buildBody, locate, countLabel, outer } = detailPager;
  // The inner per-item pager's counter text and boundary-disabled flags come from the shared pagerState, the
  // one place that logic lives, so the rendered pager and its unit test can never diverge.
  const inner = pagerState({ count: list.length, index: index, label: countLabel });
  const resizeHandle = el("div", { class: "detail__resize", "aria-hidden": "true", on: { mousedown: startDetailResize } });
  const closeButton = el("button", { type: "button", class: "detail__close", "aria-label": "Close detail panel", text: "×", on: { click: () => closeDetail({ restoreFocus: true }) } });
  const previousButton = el("button", { type: "button", class: "detail__nav", text: "‹ " + countLabel, "aria-label": "Previous " + countLabel.toLowerCase(),
    disabled: inner.previousDisabled, on: { click: () => goToDetail(index - 1, "inner-prev") } });
  const nextButton = el("button", { type: "button", class: "detail__nav", text: countLabel + " ›", "aria-label": "Next " + countLabel.toLowerCase(),
    disabled: inner.nextDisabled, on: { click: () => goToDetail(index + 1, "inner-next") } });
  const counter = el("span", { class: "detail__counter", "aria-live": "polite", "aria-atomic": "true", text: inner.counterText });
  const children = [
    el("div", { class: "detail__header" }, el("p", { class: "detail__kicker", text: kicker }), closeButton),
    el("div", { class: "detail__body" }, buildBody(list[index])),
    el("div", { class: "detail__footer" }, previousButton, counter, nextButton),
  ];
  // The focusable controls keyed so that after a re-render focus returns to the control the user was operating,
  // instead of falling to document.body (which would stop keyboard paging after one press).
  const focusable = { close: closeButton, "inner-prev": previousButton, "inner-next": nextButton };
  // An optional second (global) navigator steps across the outer set — resorts — orthogonally to the inner
  // per-item pager above. Each button names its own axis (WCAG 2.4.6/2.4.4) and the global row is set apart by
  // bolder, green buttons AND that text, not colour alone (WCAG 1.4.1), so the two axes never look alike.
  if (outer !== undefined) {
    // The global navigator shares the same pager-state source; its boundary disables match onPrevious/onNext.
    const outerNav = pagerState({ count: outer.count, index: outer.index, label: outer.label });
    const outerPrevious = el("button", { type: "button", class: "detail__nav detail__nav--global", text: "‹ " + outer.label, "aria-label": "Previous " + outer.label.toLowerCase(),
      disabled: outerNav.previousDisabled, on: { click: () => { if (outer.onPrevious !== null) outer.onPrevious(); } } });
    const outerNext = el("button", { type: "button", class: "detail__nav detail__nav--global", text: outer.label + " ›", "aria-label": "Next " + outer.label.toLowerCase(),
      disabled: outerNav.nextDisabled, on: { click: () => { if (outer.onNext !== null) outer.onNext(); } } });
    const outerCounter = el("span", { class: "detail__counter detail__counter--global", "aria-live": "polite", "aria-atomic": "true", text: outerNav.counterText });
    children.push(el("div", { class: "detail__footer detail__footer--global" }, outerPrevious, outerCounter, outerNext));
    focusable["outer-prev"] = outerPrevious;
    focusable["outer-next"] = outerNext;
  }
  detailElement.replaceChildren(resizeHandle, el("div", { class: "detail__inner" }, ...children));
  // Re-locate the selection on the map (highlight + pan) on open and on every page change.
  locate(index);
  // Restore focus to the control the user acted on (so Enter keeps paging); fall back to Close — always present
  // and never disabled — when that control is gone or now disabled at a boundary, never dropping focus to body.
  const target = focusable[focus];
  if (target !== undefined && target.disabled !== true) target.focus();
  else closeButton.focus();
}

function goToDetail(index, focus) {
  if (detailPager === null) return;
  detailPager.index = Math.max(0, Math.min(detailPager.list.length - 1, index));
  renderDetail({ focus });
}

function openDetailPanel({ kicker, list, index, buildBody, locate, countLabel, outer, focus = "close" }) {
  detailPager = { kicker, list, index, buildBody, locate, countLabel, outer };
  detailElement.hidden = false;
  // Apply/clamp the dragged width for the current viewport (and drop it on mobile where CSS owns full width).
  reconcileDetailWidth();
  renderDetail({ focus });
  if (map !== null) map.invalidateSize();
}

function preloadAround({ urls, index }) {
  // Warm only the selected image and its immediate neighbours into the browser cache so paging the panel stays
  // instant without firing every full-size request on route entry (a report can carry dozens of photos most
  // readers never open). Fire-and-forget: a failed warm simply leaves that one image to load on demand.
  for (const offset of [0, -1, 1]) {
    const neighbour = index + offset;
    if (neighbour < 0 || neighbour >= urls.length) continue;
    const url = urls[neighbour];
    if (url === null || url === undefined) continue;
    const image = new Image();
    image.referrerPolicy = "no-referrer";
    image.src = url;
  }
}

function mediaSlot({ imageUrl, alt }) {
  // The single media area every panel photo (news and report) renders, with three explicit states and never a
  // broken, still-focusable control left behind:
  //   - no photo supplied (imageUrl null): a short note; the fixed panel needs no image-sized placeholder box;
  //   - image unavailable (load error): the dead image is hidden (so it leaves the tab order) and the note
  //     replaces it, instead of a broken but zoomable thumbnail;
  //   - loaded: the image is click- and keyboard-enlargeable.
  const note = el("p", { class: "detail__nophoto", hidden: imageUrl !== null, text: imageUrl === null ? "No photo for this update." : "" });
  const image = el("img", { class: "detail__image", loading: "lazy", decoding: "async", referrerPolicy: "no-referrer",
    hidden: imageUrl === null, alt: imageUrl === null ? "" : alt,
    on: { error: () => { image.hidden = true; note.textContent = "Image unavailable."; note.hidden = false; } } });
  if (imageUrl !== null) {
    makeImageZoomable({ image });
    image.src = imageUrl;
  }
  return el("div", { class: "detail__media" }, image, note);
}

function newsDetailBody({ feature, newsItem }) {
  // One resort-news item: breaking/weekly status, headline, image, summary and its source link.
  return el("div", { class: "detail__content" },
    el("p", { class: "detail__status detail__status--" + newsItem.recency },
      el("strong", { text: statusLabel({ recency: newsItem.recency }) + " (" + newsItem.timestamp + ")" })),
    el("h2", { class: "detail__headline", text: newsItem.headline }),
    mediaSlot({ imageUrl: newsItem.imageUrl, alt: "Selected forum image for " + feature.name + "." }),
    el("p", { class: "detail__summary", text: newsItem.summary }),
    el("div", { class: "detail__actions" }, linkElement({ href: newsItem.sourceUrl, text: "Open source forum page", className: "button-link" })));
}

function highlightMarker({ markers, selectedIndex }) {
  // Reset every marker to its base style, then enlarge, outline and raise the selected one so the selection
  // stays findable on the map after the panel is closed.
  for (const { marker, baseStyle } of markers) { marker.setStyle(baseStyle); marker.setRadius(baseStyle.radius); }
  const selected = markers[selectedIndex];
  selected.marker.setStyle({ color: "#15251d", weight: 4 });
  selected.marker.setRadius(selected.baseStyle.radius + 4);
  selected.marker.bringToFront();
}

function renderMapFeatures({ features }) {
  const { map: leaflet, markerGroup: group } = ensureMap();
  group.clearLayers();
  closeDetail();
  // Each feature owns one marker; a click opens the shared detail panel with that feature's news carousel and
  // highlights the marker, so the reader sees where on the map the story is. News maps start with nothing open.
  // Resorts are ordered newest DAY first, then west-to-east within a day, so the global navigator glides across
  // the map; this order is orthogonal to the per-resort sub-page pager (breaking first, then older).
  const ordered = features.slice().sort((a, b) => compareFeaturesForNav({ a, b }));
  const markers = [];
  const openFeature = (featureIndex, focus = "close") => {
    const feature = ordered[featureIndex];
    const imageUrls = feature.newsItems.map((newsItem) => newsItem.imageUrl);
    openDetailPanel({
      kicker: feature.name,
      list: feature.newsItems,
      index: 0,
      countLabel: "Update",
      focus,
      buildBody: (newsItem) => newsDetailBody({ feature, newsItem }),
      // Offset the pan to the still-visible map area so the panel never hides the selected marker. The locate
      // receives the inner sub-page index, so warming the current image and its neighbours stays bounded.
      locate: (innerIndex) => { highlightMarker({ markers, selectedIndex: featureIndex }); focusOnMap({ latlng: feature.coordinates }); preloadAround({ urls: imageUrls, index: innerIndex }); },
      // The global (cross-resort) navigator; its prev/next re-open the neighbouring resort in the sorted order,
      // restoring focus to the matching global button so keyboard paging never drops to the document body.
      outer: {
        label: "Resort",
        index: featureIndex,
        count: ordered.length,
        onPrevious: featureIndex > 0 ? () => openFeature(featureIndex - 1, "outer-prev") : null,
        onNext: featureIndex < ordered.length - 1 ? () => openFeature(featureIndex + 1, "outer-next") : null,
      },
    });
  };
  ordered.forEach((feature, featureIndex) => {
    const primaryNews = feature.newsItems[0];
    const baseStyle = markerStyle({ kind: primaryNews.recency, hasImage: markerHasCategoryImage({ newsItems: feature.newsItems }) });
    const marker = L.circleMarker(feature.coordinates, baseStyle);
    marker.bindTooltip(el("span", { text: feature.name + ": " + statusLabel({ recency: primaryNews.recency }) + " (" + primaryNews.timestamp + ")" }));
    marker.on("click", () => openFeature(featureIndex));
    markers.push({ marker, baseStyle });
    group.addLayer(marker);
  });
  leaflet.fitBounds(group.getBounds().pad(0.15), { maxZoom: 10, padding: [24, 24] });
}

// OSM piste-difficulty colours (green/blue/red/black), with yellow for ski-tour/freeride; grey when unknown.
const SLOPE_COLORS = { novice: "#2ec27e", easy: "#1f6feb", intermediate: "#d1242f", advanced: "#111111", expert: "#111111", freeride: "#f5c518" };

function slopeColor(piste) {
  // Ski-tour routes and explicit freeride pistes read as yellow; otherwise map the OSM difficulty, else grey.
  if (piste.ptype === "skitour" || piste.diff === "freeride") return "#f5c518";
  return SLOPE_COLORS[piste.diff] || "#8b949e";
}

function reportFacts({ artifact, photo }) {
  // One compact facts line per photo: capture time, elevation, and the snapped lift/piste. The lift carries its
  // class colour swatch and the piste its difficulty-colour dot, matching the legend and the lift lines on the map.
  const facts = el("div", { class: "detail__facts" });
  if (photo.capturedAt !== null) facts.append(el("span", { text: photo.capturedAt.slice(0, 16).replace("T", " ") }));
  if (photo.elevation !== null) facts.append(el("span", { text: Math.round(photo.elevation) + " m" }));
  if (photo.lift !== null) {
    const distance = photo.lift.dist === null ? "" : " (" + photo.lift.dist + " m)";
    const swatch = el("span", { class: "report-legend__swatch" });
    // CSSOM assignment (not a markup style attribute), so the strict style-src CSP is not violated.
    swatch.style.backgroundColor = artifact.liftCats[photo.lift.cat].color;
    facts.append(el("span", { class: "detail__fact" }, swatch,
      el("span", { text: photo.lift.cat + " · " + (photo.lift.name === "" ? "Lift" : photo.lift.name) + distance })));
  }
  if (photo.piste !== null && photo.piste.name !== "") {
    const dot = el("span", { class: "report-facts__dot" });
    dot.style.backgroundColor = slopeColor(photo.piste);
    // The piste carries its snap distance in metres exactly as the lift above does, so both snaps read alike.
    facts.append(el("span", { class: "detail__fact" }, dot, el("span", { text: "Piste: " + photo.piste.name + " (" + photo.piste.dist + " m)" })));
  }
  return facts;
}

function reportDetailBody({ artifact, photo }) {
  // One report photo in the detail panel: the enlargeable image (via the shared media slot, so a failed load
  // degrades to an "image unavailable" note rather than a broken zoom control), its caption, the snap facts,
  // and the source link.
  return el("div", { class: "detail__content" },
    mediaSlot({ imageUrl: photo.url, alt: photo.description === null ? "Report photo." : photo.description }),
    el("p", { class: "detail__caption", text: photo.description === null ? "(no caption)" : photo.description }),
    reportFacts({ artifact, photo }),
    el("div", { class: "detail__actions" }, linkElement({ href: artifact.report.sourceUrl, text: "Open source forum page", className: "button-link" })));
}

function reportLegendControl({ artifact }) {
  // A bottom-left legend of the lift classes present plus the photo wedge, built as CSP-safe DOM (no innerHTML).
  const control = L.control({ position: "bottomleft" });
  control.onAdd = () => {
    const box = el("div", { class: "report-legend" }, el("p", { class: "report-legend__title", text: "Lifts" }));
    for (const [code, category] of Object.entries(artifact.liftCats)) {
      const swatch = el("span", { class: "report-legend__swatch" });
      // CSSOM assignment (not a markup style attribute), so the strict style-src CSP is not violated.
      swatch.style.backgroundColor = category.color;
      box.append(el("div", { class: "report-legend__row" }, swatch, el("span", { text: category.label + " (" + code + ")" })));
    }
    box.append(el("div", { class: "report-legend__row" },
      el("span", { class: "report-legend__swatch report-legend__swatch--photo" }), el("span", { text: "Photo + view direction" })));
    L.DomEvent.disableClickPropagation(box);
    return box;
  };
  return control;
}

function reportOffsetControl({ initial, derived, onChange }) {
  // The view-direction rotation lives at the very bottom-left, added after the legend so it renders directly
  // below it (and stays there when the legend is hidden on mobile). Bottom-left keeps it clear of the right-side
  // detail panel and its top-right close button, so a click on × can never land on this dropdown. CSP-safe DOM.
  const control = L.control({ position: "bottomleft" });
  control.onAdd = () => {
    const box = el("div", { class: "report-offset" },
      el("span", { class: "report-offset__label", text: derived ? "Rotate view" : "Rotate view (unverified)" }));
    const select = el("select", { class: "report-offset__select" });
    for (const [value, label] of [["none", "none"], ["-90", "−90°"], ["0", "0°"], ["90", "+90°"], ["180", "180°"]]) {
      const option = el("option", { value: value, text: label });
      // Pre-select the active correction so the control opens reflecting what the map is already showing.
      if ((initial === null && value === "none") || String(initial) === value) option.selected = true;
      select.append(option);
    }
    select.addEventListener("change", (event) => onChange(event.target.value === "none" ? null : Number(event.target.value)));
    box.append(select);
    L.DomEvent.disableClickPropagation(box);
    return box;
  };
  return control;
}

function renderReportMap({ artifact }) {
  const { map: leaflet, markerGroup: group } = ensureMap();
  group.clearLayers();
  closeDetail();
  clearReportLegend();
  // Report photos are warmed only around the selected one as the reader pages (see selectWedge), never all at
  // once on route entry — a long report can carry dozens of full-size photos most readers never open.
  const photoUrls = artifact.photos.map((photo) => photo.url);
  // The chrome subtitle names the exact report this map shows (title, author, date).
  document.getElementById("page-subtitle").textContent =
    artifact.report.title + " · " + artifact.report.author + " · " + artifact.report.date;
  // Each lift a photo snapped to is drawn, coloured by its class, so the drawn lines read as the itinerary.
  for (const lift of artifact.lifts) {
    // Lift names are raw public OSM text; build the tooltip (its class and name) as a textContent node so a name can never inject markup.
    const line = L.polyline(lift.coords, { color: artifact.liftCats[lift.cat].color, weight: 4, opacity: 0.9 })
      .bindTooltip(el("span", { text: lift.cat + " · " + (lift.name === "" ? "Lift" : lift.name) }))
      .addTo(group);
    // Clicking a drawn lift opens the first photo snapped to it, matched by OSM way id (openReportAt is in scope
    // by click time); a lift with no snapped photo in this report stays a non-interactive line.
    const firstSnapped = artifact.photos.findIndex((photo) => photo.lift !== null && photo.lift.id === lift.id);
    if (firstSnapped >= 0) line.on("click", () => openReportAt(firstSnapped));
  }
  // Every photo is one wedge pointing in its view direction (a dot when it has no bearing). A click opens the
  // shared detail panel at that photo; the panel's Previous/Next re-select the neighbouring wedge in place.
  const baseWedge = { color: "#d96a00", weight: 1, fillColor: "#ff8c00", fillOpacity: 0.7 };
  const selectedWedge = { color: "#ffffff", weight: 2.5, fillColor: "#ff2d2d", fillOpacity: 0.95 };
  const wedges = [];
  // The correction defaults to the producer's derived offset (270 shown as its equivalent -90); null means no
  // direction was derivable, so wedges are drawn as dots until the viewer chooses a quarter-turn.
  let activeOffset = artifact.bearingOffsetDeg === null ? null : (artifact.bearingOffsetDeg === 270 ? -90 : artifact.bearingOffsetDeg);
  let selectedIndex = 0;
  const correctedBearing = (photo) =>
    activeOffset === null || photo.bearing === null ? null : (((photo.bearing - activeOffset) % 360) + 360) % 360;
  function selectWedge(index) {
    selectedIndex = index;
    wedges.forEach((wedge, wedgeIndex) => wedge.setStyle(wedgeIndex === index ? selectedWedge : baseWedge));
    wedges[index].bringToFront();
    // Offset the pan to the still-visible map area so the panel never hides the selected wedge.
    focusOnMap({ latlng: [artifact.photos[index].latitude, artifact.photos[index].longitude] });
    // Warm only the selected photo and its neighbours, so paging stays instant without 67 upfront requests.
    preloadAround({ urls: photoUrls, index: index });
  }
  const openReportAt = (index) =>
    openDetailPanel({
      kicker: artifact.report.title,
      list: artifact.photos,
      index: index,
      countLabel: "Photo",
      buildBody: (photo) => reportDetailBody({ artifact, photo }),
      locate: selectWedge,
    });
  function buildWedges() {
    // Rebuilt whenever the active correction changes; removes only the wedge markers, never the drawn lift lines.
    wedges.forEach((wedge) => group.removeLayer(wedge));
    wedges.length = 0;
    artifact.photos.forEach((photo, index) => {
      // A photo with a (corrected) bearing is a triangle; one without is an equal-area round polygon in the
      // identical wedge style, so both read as the same marker family and share the selected/base styling.
      const points = reportWedgePoints({ latitude: photo.latitude, longitude: photo.longitude, bearing: correctedBearing(photo) })
        ?? reportDotPoints({ latitude: photo.latitude, longitude: photo.longitude });
      const marker = L.polygon(points, baseWedge);
      marker.on("click", () => openReportAt(index));
      wedges.push(marker);
      group.addLayer(marker);
    });
  }
  buildWedges();
  reportLegend = reportLegendControl({ artifact });
  reportLegend.addTo(leaflet);
  reportOffset = reportOffsetControl({
    initial: activeOffset,
    derived: artifact.bearingOffsetDeg !== null,
    onChange: (value) => {
      activeOffset = value;
      buildWedges();
      selectWedge(selectedIndex);
    },
  });
  reportOffset.addTo(leaflet);
  leaflet.setView(artifact.center, 13);
  leaflet.fitBounds(group.getBounds().pad(0.15), { maxZoom: 15, padding: [24, 24] });
  // The report-on-map view opens with its first photo already selected, so the reader lands on content.
  openReportAt(0);
}

// Every doc page is one centered column headed by an h2; only the heading text and body vary.
function docSection(headingText, ...children) {
  return el("section", { class: "doc-section" }, el("h2", { class: "doc-section__heading", text: headingText }), ...children);
}

function reportSection({ report }) {
  const article = el("article", { class: "report" },
    el("h3", { class: "report__headline", text: report.headline }),
    el("p", { class: "report__summary", text: report.summary }));
  if (report.imageUrls.length > 0) {
    const gallery = el("div", { class: "report__gallery" });
    // Each forum photo is a cropped thumbnail that opens full-size in the lightbox; no-referrer avoids hotlink blocks.
    for (const [index, url] of report.imageUrls.entries()) {
      const image = el("img", { class: "report__image", loading: "lazy", decoding: "async", referrerPolicy: "no-referrer", src: url, alt: "Report photo " + (index + 1) + "." });
      makeImageZoomable({ image });
      gallery.append(image);
    }
    article.append(gallery);
  }
  article.append(el("div", { class: "report__actions" }, linkElement({ href: report.sourceUrl, text: "Open source forum page", className: "button-link" })));
  return docSection("Report of the day", article);
}

function tipsSection({ tips }) {
  // One stacked panel per tip (one to three); the source link is mandatory, so every tip renders one.
  const list = el("div", { class: "tips" });
  for (const tip of tips) {
    list.append(el("article", { class: "tip" },
      el("h3", { class: "tip__headline", text: tip.headline }),
      el("p", { class: "tip__summary", text: tip.summary }),
      linkElement({ href: tip.sourceUrl, text: "Open source forum page", className: "button-link" })));
  }
  return docSection("Tips", list);
}

function debateColumn({ heading, side, args }) {
  // Render every validated argument as its own bullet so the pro/contra weight stays visible.
  return el("div", { class: "debate__column debate__column--" + side },
    el("h4", { class: "debate__column-heading", text: heading }),
    el("ul", { class: "debate__list" }, ...args.map((argument) => el("li", { text: argument }))));
}

function controversialSection({ controversial }) {
  // One debate row per subject (one to three); pro renders blue on the left, contra red on the right.
  const list = el("div", { class: "debates" });
  for (const debate of controversial) {
    list.append(el("article", { class: "debate" },
      el("h3", { class: "debate__headline", text: debate.headline }),
      el("div", { class: "debate__columns" },
        debateColumn({ heading: "For", side: "pro", args: debate.pro }),
        debateColumn({ heading: "Against", side: "contra", args: debate.contra })),
      el("div", { class: "debate__actions" }, linkElement({ href: debate.sourceUrl, text: "Open discussion", className: "button-link" }))));
  }
  return docSection("Debates", list);
}

// A daily run carries exactly one report, but reports is an array; render one section per report.
function renderReport({ briefing }) {
  docElement.replaceChildren(...briefing.reports.map((report) => reportSection({ report })));
}

function renderTips({ briefing }) {
  docElement.replaceChildren(tipsSection({ tips: briefing.tips }));
}

function renderDebates({ briefing }) {
  docElement.replaceChildren(controversialSection({ controversial: briefing.controversial }));
}

function showMessage({ text, kind }) {
  messageElement.textContent = text;
  messageElement.dataset.kind = kind;
  messageElement.hidden = false;
}

function showView({ view }) {
  // Map and doc views are mutually exclusive; toggling hidden keeps a single Leaflet instance alive.
  mapElement.hidden = view !== "map";
  docElement.hidden = view === "map";
  if (view !== "map") docElement.replaceChildren();
}

function setChrome({ routeName, route }) {
  document.getElementById("page-title").textContent = route.title;
  document.getElementById("page-subtitle").textContent = route.subtitle;
  // Mark exactly the active nav link so the current page is announced and visibly selected.
  for (const link of document.querySelectorAll(".site-nav a")) {
    if (link.dataset.route === routeName) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

async function activateRoute({ route }) {
  // One activation path for the closed set of view kinds: a map route renders Leaflet from a GeoJSON layer, the
  // report-on-map route renders the page-4 spatial artifact, a doc route renders a briefing section, and the
  // weekly route renders markdown. The lift legend belongs only to report-on-map, so drop it for every other.
  // An activation token makes every async request abortable: a response that arrives after the user has
  // navigated on is stale and must neither render nor overwrite the newly selected view.
  const token = (activation += 1);
  const stale = () => token !== activation;
  const isMapView = route.view === "map" || route.view === "report-map";
  // Every navigation closes any open detail panel so it never lingers over the next page (map or doc).
  closeDetail();
  if (route.view !== "report-map") clearReportLegend();
  // Drop the previous page's markers before the new fetch resolves, so a stale marker can never be clicked
  // (and open a panel for the page the user just left) during a slow route switch.
  if (isMapView) ensureMap().markerGroup.clearLayers();
  showView({ view: isMapView ? "map" : "doc" });
  showMessage({ text: "Loading " + route.title + "…", kind: "loading" });
  try {
    if (route.view === "map") {
      const payload = await (await fetchNoStore(route.url)).json();
      if (stale()) return;
      const features = validateFeatureCollection({ value: payload });
      if (features.length === 0) {
        ensureMap().markerGroup.clearLayers();
        showMessage({ text: "There is no news in the retained run window for this page.", kind: "empty" });
        return;
      }
      renderMapFeatures({ features });
      map.invalidateSize();
    } else if (route.view === "report-map") {
      const payload = await (await fetchNoStore(route.url)).json();
      if (stale()) return;
      const artifact = validateReportArtifact({ value: payload });
      // A report of the day with no geotagged on-piste photos has nothing to map: hide the map, show a plain hint.
      if (artifact === null) {
        ensureMap().markerGroup.clearLayers();
        clearReportLegend();
        mapElement.hidden = true;
        showMessage({ text: "The report of the day has no geotagged images and cannot be shown on the map.", kind: "empty" });
        return;
      }
      renderReportMap({ artifact });
      map.invalidateSize();
    } else if (route.view === "doc") {
      const briefing = await loadBriefing();
      if (stale()) return;
      route.render({ briefing });
    } else if (route.view === "weekly") {
      const markdown = await (await fetchNoStore(route.url)).text();
      if (stale()) return;
      docElement.replaceChildren(renderWeekly({ markdown }));
    } else {
      throw new RangeError("Unsupported view: " + route.view);
    }
    messageElement.hidden = true;
  } catch (error) {
    // A stale failure belongs to a page the user already left, so it must not overwrite the current view.
    if (stale()) return;
    // The map keeps its last features on failure; the doc and weekly views clear to avoid a stale page.
    if (!isMapView) docElement.replaceChildren();
    showMessage({ text: "The " + route.title + " page could not be loaded.", kind: "error" });
    console.error("Could not load the " + route.title + " page.", error);
  }
}

function weeklyInlineNodes({ text }) {
  // Parse the two inline forms our weekly markdown uses — **bold** and [label](url) — into safe DOM nodes
  // (textContent and createElement only, never innerHTML); any other run of characters stays literal text. The
  // label can carry inner brackets ("Alpinforum [1]"), so match non-greedily up to the "](" that starts the URL.
  const nodes = [];
  const pattern = /\*\*([^*]+)\*\*|\[(.+?)\]\(([^)]+)\)/g;
  let lastIndex = 0;
  let match = pattern.exec(text);
  while (match !== null) {
    if (match.index > lastIndex) nodes.push(document.createTextNode(text.slice(lastIndex, match.index)));
    // Group 1 is a bold run; otherwise groups 2/3 are a link's label and href.
    if (match[1] !== undefined) nodes.push(el("strong", { text: match[1] }));
    else nodes.push(linkElement({ href: match[3], text: match[2], className: null }));
    lastIndex = pattern.lastIndex;
    match = pattern.exec(text);
  }
  if (lastIndex < text.length) nodes.push(document.createTextNode(text.slice(lastIndex)));
  return nodes;
}

function renderWeekly({ markdown }) {
  // Render the published weekly markdown line by line into safe DOM: a cover image, its caption, the five
  // section headings and their bullet lists. The producer owns this exact shape, so a small line scanner
  // suffices and avoids a markdown dependency. Consecutive "- " bullets accumulate into one <ul>.
  const section = el("section", { class: "doc-section weekly" });
  let list = null;
  const closeList = () => { if (list !== null) { section.append(list); list = null; } };
  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();
    // Skip blanks, the markdown H1 (the chrome shows the title), and the promo line that links back here.
    if (line === "" || line.startsWith("# ") || line.includes("michaelmedek.github.io/alpin-map")) continue;
    if (line.startsWith("<img")) {
      // The one raw <img> line carries the cover; read its src/alt and build a fresh element (no innerHTML).
      closeList();
      const srcMatch = line.match(/src="([^"]*)"/);
      if (srcMatch !== null) {
        const altMatch = line.match(/alt="([^"]*)"/);
        section.append(el("img", { class: "weekly__cover", loading: "lazy", decoding: "async", referrerPolicy: "no-referrer", src: srcMatch[1], alt: altMatch === null ? "Weekly briefing cover image." : altMatch[1] }));
      }
    } else if (line.startsWith("## ")) {
      closeList();
      section.append(el("h2", { class: "weekly__heading", text: line.slice(3).trim() }));
    } else if (line.startsWith("- ")) {
      if (list === null) list = el("ul", { class: "weekly__list" });
      list.append(el("li", {}, ...weeklyInlineNodes({ text: line.slice(2) })));
    } else if (line.length > 2 && line.startsWith("*") && line.endsWith("*")) {
      closeList();
      section.append(el("p", { class: "weekly__caption" }, el("em", { text: line.slice(1, -1) })));
    } else {
      // Any remaining line is a paragraph that may carry inline bold and a link.
      closeList();
      section.append(el("p", { class: "weekly__text" }, ...weeklyInlineNodes({ text: line })));
    }
  }
  closeList();
  return section;
}

function handleRoute() {
  const requested = window.location.hash.replace(/^#\/?/, "");
  // Fall back to the default page for an empty or unknown hash so a stray link never shows a blank view.
  const routeName = Object.hasOwn(ROUTES, requested) ? requested : DEFAULT_ROUTE;
  const route = ROUTES[routeName];
  setChrome({ routeName, route });
  if (routeName !== activeRoute) {
    activeRoute = routeName;
    activateRoute({ route });
  }
}

async function initRunTimestamp() {
  // The latest-run instant lives only in page 3; show it in the header on every page as a single source of truth.
  try {
    const briefing = await loadBriefing();
    runTimestampElement.textContent = "Latest run: " + formatRunTimestamp({ value: briefing.generatedAt });
  } catch (error) {
    runTimestampElement.textContent = "";
    console.error("Could not read the latest run time.", error);
  }
}

// Browser bootstrap. Skipped under the Node render test, which imports the render helpers and drives them
// directly so the suite actually loads and exercises this file instead of only validating data.
if (globalThis.__ALPIN_VIEWER_TEST__ !== true) {
  window.addEventListener("hashchange", handleRoute);
  // Reconcile a dragged panel width whenever the viewport changes, so a desktop width is dropped below the
  // mobile breakpoint (CSS owns full width there) and clamped back into range on a smaller desktop window, then
  // re-center the selection in the resized map so the highlighted marker is never left under the panel.
  window.addEventListener("resize", () => { reconcileDetailWidth(); relocateSelection(); });
  // Escape closes the detail panel (unless the lightbox is open, which handles its own Escape first), returning
  // focus to the map rather than letting it drop to document.body.
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && detailPager !== null && lightbox === null) closeDetail({ restoreFocus: true });
  });
  initRunTimestamp();
  handleRoute();
}

export { renderWeekly, openLightbox, closeLightbox, newsDetailBody, reportDetailBody };
