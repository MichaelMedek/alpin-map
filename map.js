import {
  formatRunTimestamp,
  markerHasCategoryImage,
  markerStyle,
  newsPageState,
  statusLabel,
  validateBriefing,
  validateFeatureCollection,
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
let activeRoute = null;
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
  // Create the Leaflet map once and reuse it across both map routes; toggling the container's hidden keeps the
  // single instance cheap and avoids leaking tile layers when the user switches pages repeatedly.
  if (map === null) {
    map = L.map(mapElement, { minZoom: 4 }).setView(DEFAULT_CENTER, DEFAULT_ZOOM);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
      maxZoom: 19,
    }).addTo(map);
    markerGroup = L.featureGroup().addTo(map);
  }
  return { map, markerGroup };
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

function popupElement({ feature, onContentChange }) {
  if (typeof onContentChange !== "function") throw new TypeError("onContentChange must be a function.");
  let activeIndex = 0;
  // The mutable nodes the carousel rewrites on every page; everything else is built once in the tree below.
  const title = el("h2");
  const status = el("p", { "aria-live": "polite", "aria-atomic": "true" });
  const summary = el("p", { class: "news-popup__summary" });
  const placeholder = el("div", { class: "news-popup__image-placeholder", "aria-hidden": "true" },
    el("span", { class: "news-popup__image-placeholder-icon", text: "🏔️" }),
    el("span", { class: "news-popup__image-placeholder-text", text: "No photo for this update" }));
  // A dead or blocked forum image falls back to the placeholder, so a broken-image icon never appears.
  const image = el("img", { class: "news-popup__image", loading: "lazy", decoding: "async", referrerPolicy: "no-referrer", hidden: true,
    on: { load: onContentChange, error: () => { image.hidden = true; placeholder.hidden = false; onContentChange(); } } });
  makeImageZoomable({ image });
  const pageCounter = el("span", { class: "news-popup__page-counter", "aria-live": "polite", "aria-atomic": "true" });
  const previousButton = el("button", { type: "button", text: "Previous", "aria-label": "Show newer news",
    on: { click: () => { if (activeIndex > 0) { activeIndex -= 1; renderNewsItem(); } } } });
  const nextButton = el("button", { type: "button", text: "Next", "aria-label": "Show older news",
    on: { click: () => { if (activeIndex < feature.newsItems.length - 1) { activeIndex += 1; renderNewsItem(); } } } });
  const sourceLink = linkElement({ href: feature.newsItems[0].sourceUrl, text: "Open source forum page", className: null });

  // The content is always two columns with a reserved image slot, so paging the carousel never reflows it.
  const popup = el("article", { class: "news-popup" },
    el("p", { class: "news-popup__kicker", text: feature.name }),
    title,
    status,
    el("div", { class: "news-popup__content" }, summary, el("div", { class: "news-popup__image-slot" }, image, placeholder)),
    el("div", { class: "news-popup__pagination" }, previousButton, pageCounter, nextButton),
    el("div", { class: "news-popup__actions" }, sourceLink));

  function renderNewsItem() {
    const pageState = newsPageState({ newsItems: feature.newsItems, activeIndex });
    const newsItem = pageState.newsItem;
    title.textContent = newsItem.headline;
    // Breaking (red) and weekly (blue) are both bold; the label text and emphasis are applied here, not in the data.
    status.className = "news-popup__status news-popup__status--" + newsItem.recency;
    status.replaceChildren(el("strong", { text: statusLabel({ recency: newsItem.recency }) + " (" + newsItem.timestamp + ")" }));
    summary.textContent = newsItem.summary;
    sourceLink.href = newsItem.sourceUrl;
    if (newsItem.imageUrl === null) {
      image.hidden = true;
      image.removeAttribute("src");
      image.alt = "";
      placeholder.hidden = false;
    } else if (typeof newsItem.imageUrl === "string") {
      image.hidden = false;
      image.src = newsItem.imageUrl;
      image.alt = "Selected forum image for " + feature.name + ".";
      placeholder.hidden = true;
    } else {
      throw new TypeError("Validated news image URL must be text or null.");
    }
    previousButton.disabled = pageState.previousDisabled;
    nextButton.disabled = pageState.nextDisabled;
    pageCounter.textContent = pageState.pageCounterText;
    onContentChange();
  }

  renderNewsItem();
  return popup;
}

function renderMapFeatures({ features }) {
  const { map: leaflet, markerGroup: group } = ensureMap();
  group.clearLayers();
  // Each feature owns one marker and one stateful carousel popup; the popup repositions as its image loads,
  // but only once Leaflet has bound and opened it.
  for (const feature of features) {
    const primaryNews = feature.newsItems[0];
    const marker = L.circleMarker(feature.coordinates,
      markerStyle({ kind: primaryNews.recency, hasImage: markerHasCategoryImage({ newsItems: feature.newsItems }) }));
    let popupBound = false;
    const popup = popupElement({ feature, onContentChange: () => { if (popupBound) marker.getPopup().update(); } });
    marker.bindTooltip(feature.name + ": " + statusLabel({ recency: primaryNews.recency }) + " (" + primaryNews.timestamp + ")");
    marker.bindPopup(popup, { maxWidth: 760 });
    popupBound = true;
    group.addLayer(marker);
  }
  leaflet.fitBounds(group.getBounds().pad(0.15), { maxZoom: 10, padding: [24, 24] });
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
  // One activation path for the closed set of view kinds: a map route renders Leaflet from a GeoJSON layer,
  // a doc route renders a section of the collapsed daily briefing, and the weekly route renders markdown.
  showView({ view: route.view === "map" ? "map" : "doc" });
  showMessage({ text: "Loading " + route.title + "…", kind: "loading" });
  try {
    if (route.view === "map") {
      const features = validateFeatureCollection({ value: await (await fetchNoStore(route.url)).json() });
      if (features.length === 0) {
        ensureMap().markerGroup.clearLayers();
        showMessage({ text: "There is no news in the retained run window for this page.", kind: "empty" });
        return;
      }
      renderMapFeatures({ features });
      map.invalidateSize();
    } else if (route.view === "doc") {
      route.render({ briefing: await loadBriefing() });
    } else if (route.view === "weekly") {
      docElement.replaceChildren(renderWeekly({ markdown: await (await fetchNoStore(route.url)).text() }));
    } else {
      throw new RangeError("Unsupported view: " + route.view);
    }
    messageElement.hidden = true;
  } catch (error) {
    // The map keeps its last features on failure; the doc and weekly views clear to avoid a stale page.
    if (route.view !== "map") docElement.replaceChildren();
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
  initRunTimestamp();
  handleRoute();
}

export { renderWeekly, openLightbox, closeLightbox };
