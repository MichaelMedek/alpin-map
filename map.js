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

// One registry drives the nav chrome and dispatch; the two map routes share renderMapFeatures(), so
// resort-news and snow stay byte-for-byte symmetric and differ only by data url and labels, while the
// three doc routes each render exactly one section of the shared briefing.
const ROUTES = {
  "resort-news": {
    title: "Resort news",
    subtitle: "Construction and infrastructure progress across the Alps.",
    view: "map",
    url: "./page1_resort_news.geojson",
  },
  snow: {
    title: "Snow & conditions",
    subtitle: "Current snow, slope and mountain conditions.",
    view: "map",
    url: "./page2_snow_conditions.geojson",
  },
  report: {
    title: "Report of the day",
    subtitle: "The forum story of the day.",
    view: "doc",
    render: renderReport,
  },
  tips: {
    title: "Tips",
    subtitle: "Three practical tips from the forums.",
    view: "doc",
    render: renderTips,
  },
  debates: {
    title: "Debates",
    subtitle: "Three pro and contra debates from the forums.",
    view: "doc",
    render: renderDebates,
  },
  weekly: {
    title: "Weekly briefing",
    subtitle: "The editor's condensed briefing of the week; updates weekly, not daily.",
    view: "weekly",
    url: WEEKLY_URL,
  },
};

const mapElement = document.getElementById("map");
const docElement = document.getElementById("doc");
const messageElement = document.getElementById("view-message");
const runTimestampElement = document.getElementById("run-timestamp");

let map = null;
let markerGroup = null;
let activeRoute = null;
let briefingPromise = null;

function loadBriefing() {
  // Fetch and validate page 3 at most once: the header date (every page) and the briefing view share it,
  // so there is a single source of truth and a single network request for the collapsed page.
  if (briefingPromise === null) {
    briefingPromise = fetch(BRIEFING_URL + "?loaded=" + Date.now(), { cache: "no-store" })
      .then((response) => {
        if (response.ok === false) {
          throw new Error("Request for " + BRIEFING_URL + " failed with HTTP " + response.status + ".");
        }
        return response.json();
      })
      .then((payload) => validateBriefing({ value: payload }));
  }
  return briefingPromise;
}

function ensureMap() {
  // Create the Leaflet map once and reuse it across both map routes; a hidden container keeps the single
  // instance cheap and avoids leaking tile layers when the user switches pages repeatedly.
  if (map === null) {
    map = L.map(mapElement, { minZoom: 4 }).setView(DEFAULT_CENTER, DEFAULT_ZOOM);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
      maxZoom: 19,
    }).addTo(map);
    markerGroup = L.featureGroup().addTo(map);
  }
  return { map: map, markerGroup: markerGroup };
}

function linkElement({ href, text, className }) {
  const link = document.createElement("a");
  link.href = href;
  link.textContent = text;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  if (className !== null) {
    link.className = className;
  }
  return link;
}

function popupElement({ feature, onContentChange }) {
  if (typeof onContentChange !== "function") {
    throw new TypeError("onContentChange must be a function.");
  }

  let activeIndex = 0;
  // The popup is pinned to one large size with a reserved image slot, so paging the carousel never reflows it.
  const popup = document.createElement("article");
  popup.className = "news-popup";

  // The resort name is constant across the carousel, so it is the eyebrow; the per-page headline is the title.
  const kicker = document.createElement("p");
  kicker.className = "news-popup__kicker";
  kicker.textContent = feature.name;
  popup.append(kicker);

  const title = document.createElement("h2");
  popup.append(title);

  const status = document.createElement("p");
  status.setAttribute("aria-live", "polite");
  status.setAttribute("aria-atomic", "true");
  popup.append(status);

  const content = document.createElement("div");
  content.className = "news-popup__content";

  const summary = document.createElement("p");
  summary.className = "news-popup__summary";

  // The image slot is always present at a fixed size; a real photo or a muted placeholder keeps the layout steady.
  const imageSlot = document.createElement("div");
  imageSlot.className = "news-popup__image-slot";
  const image = document.createElement("img");
  image.className = "news-popup__image";
  image.loading = "lazy";
  image.decoding = "async";
  image.referrerPolicy = "no-referrer";
  image.hidden = true;
  image.addEventListener("load", onContentChange);
  const placeholder = document.createElement("div");
  placeholder.className = "news-popup__image-placeholder";
  placeholder.setAttribute("aria-hidden", "true");
  // A visible, friendly icon plus explicit text so an absent photo reads as intentional, not a failed load.
  const placeholderIcon = document.createElement("span");
  placeholderIcon.className = "news-popup__image-placeholder-icon";
  placeholderIcon.textContent = "🏔️";
  const placeholderText = document.createElement("span");
  placeholderText.className = "news-popup__image-placeholder-text";
  placeholderText.textContent = "No photo for this update";
  placeholder.append(placeholderIcon, placeholderText);
  // A present URL that fails to load (a dead or blocked forum image) also falls back to the placeholder,
  // so a broken image icon never replaces it; renderNewsItem resets this state on every page.
  image.addEventListener("error", () => {
    image.hidden = true;
    placeholder.hidden = false;
    onContentChange();
  });
  imageSlot.append(image, placeholder);
  content.append(summary, imageSlot);
  popup.append(content);

  const pagination = document.createElement("div");
  pagination.className = "news-popup__pagination";

  const previousButton = document.createElement("button");
  previousButton.type = "button";
  previousButton.textContent = "Previous";
  previousButton.setAttribute("aria-label", "Show newer news");

  const pageCounter = document.createElement("span");
  pageCounter.className = "news-popup__page-counter";
  pageCounter.setAttribute("aria-live", "polite");
  pageCounter.setAttribute("aria-atomic", "true");

  const nextButton = document.createElement("button");
  nextButton.type = "button";
  nextButton.textContent = "Next";
  nextButton.setAttribute("aria-label", "Show older news");
  pagination.append(previousButton, pageCounter, nextButton);
  popup.append(pagination);

  const actions = document.createElement("div");
  actions.className = "news-popup__actions";
  const sourceLink = linkElement({ href: feature.newsItems[0].sourceUrl, text: "Open source forum page", className: null });
  actions.append(sourceLink);
  popup.append(actions);

  function renderNewsItem() {
    const pageState = newsPageState({ newsItems: feature.newsItems, activeIndex: activeIndex });
    const newsItem = pageState.newsItem;
    title.textContent = newsItem.headline;
    // Breaking (red) and weekly (blue) are both bold; the label text and emphasis are applied here, not in the data.
    status.className = "news-popup__status news-popup__status--" + newsItem.recency;
    const strong = document.createElement("strong");
    strong.textContent = statusLabel({ recency: newsItem.recency }) + " (" + newsItem.timestamp + ")";
    status.replaceChildren(strong);

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

  function showPreviousNews() {
    if (activeIndex > 0) {
      activeIndex -= 1;
      renderNewsItem();
    }
  }

  function showNextNews() {
    if (activeIndex < feature.newsItems.length - 1) {
      activeIndex += 1;
      renderNewsItem();
    }
  }

  previousButton.addEventListener("click", showPreviousNews);
  nextButton.addEventListener("click", showNextNews);
  renderNewsItem();
  return popup;
}

function renderMapFeatures({ features }) {
  const { map: leaflet, markerGroup: group } = ensureMap();
  group.clearLayers();
  // Each feature owns one marker and one stateful carousel popup.
  for (const feature of features) {
    const primaryNews = feature.newsItems[0];
    const marker = L.circleMarker(
      feature.coordinates,
      markerStyle({ kind: primaryNews.recency, hasImage: markerHasCategoryImage({ newsItems: feature.newsItems }) }),
    );
    let popupBound = false;
    function updatePopupPosition() {
      if (popupBound) {
        marker.getPopup().update();
      }
    }
    const popup = popupElement({ feature: feature, onContentChange: updatePopupPosition });
    marker.bindTooltip(feature.name + ": " + statusLabel({ recency: primaryNews.recency }) + " (" + primaryNews.timestamp + ")");
    marker.bindPopup(popup, { maxWidth: 760 });
    popupBound = true;
    group.addLayer(marker);
  }
  leaflet.fitBounds(group.getBounds().pad(0.15), { maxZoom: 10, padding: [24, 24] });
}

function reportSection({ report }) {
  const section = document.createElement("section");
  section.className = "doc-section";

  const heading = document.createElement("h2");
  heading.className = "doc-section__heading";
  heading.textContent = "Report of the day";
  section.append(heading);

  const article = document.createElement("article");
  article.className = "report";

  const reportHeadline = document.createElement("h3");
  reportHeadline.className = "report__headline";
  reportHeadline.textContent = report.headline;
  article.append(reportHeadline);

  const summary = document.createElement("p");
  summary.className = "report__summary";
  summary.textContent = report.summary;
  article.append(summary);

  if (report.imageUrls.length > 0) {
    const gallery = document.createElement("div");
    gallery.className = "report__gallery";
    // Up to four forum images; no-referrer keeps the forum image hosts from rejecting the hotlink.
    for (const [imageIndex, imageUrl] of report.imageUrls.entries()) {
      const image = document.createElement("img");
      image.className = "report__image";
      image.loading = "lazy";
      image.decoding = "async";
      image.referrerPolicy = "no-referrer";
      image.src = imageUrl;
      image.alt = "Report photo " + (imageIndex + 1) + ".";
      gallery.append(image);
    }
    article.append(gallery);
  }

  const actions = document.createElement("div");
  actions.className = "report__actions";
  actions.append(linkElement({ href: report.sourceUrl, text: "Open source forum page", className: "button-link" }));
  article.append(actions);
  section.append(article);
  return section;
}

function tipsSection({ tips }) {
  const section = document.createElement("section");
  section.className = "doc-section";

  const heading = document.createElement("h2");
  heading.className = "doc-section__heading";
  heading.textContent = "Three tips";
  section.append(heading);

  const list = document.createElement("div");
  list.className = "tips";
  // Three stacked tip panels; the source link is mandatory, so every tip renders one.
  for (const tip of tips) {
    const panel = document.createElement("article");
    panel.className = "tip";

    const tipHeadline = document.createElement("h3");
    tipHeadline.className = "tip__headline";
    tipHeadline.textContent = tip.headline;
    panel.append(tipHeadline);

    const tipSummary = document.createElement("p");
    tipSummary.className = "tip__summary";
    tipSummary.textContent = tip.summary;
    panel.append(tipSummary);

    // The source link is mandatory on every tip, so it is rendered unconditionally.
    panel.append(linkElement({ href: tip.sourceUrl, text: "Open source forum page", className: "button-link" }));
    list.append(panel);
  }
  section.append(list);
  return section;
}

function debateColumn({ heading, side, arguments_ }) {
  const column = document.createElement("div");
  column.className = "debate__column debate__column--" + side;

  const columnHeading = document.createElement("h4");
  columnHeading.className = "debate__column-heading";
  columnHeading.textContent = heading;
  column.append(columnHeading);

  const list = document.createElement("ul");
  list.className = "debate__list";
  // Render every validated argument as its own bullet so the pro/contra weight stays visible.
  for (const argument of arguments_) {
    const item = document.createElement("li");
    item.textContent = argument;
    list.append(item);
  }
  column.append(list);
  return column;
}

function controversialSection({ controversial }) {
  const section = document.createElement("section");
  section.className = "doc-section";

  const heading = document.createElement("h2");
  heading.className = "doc-section__heading";
  heading.textContent = "Three debates";
  section.append(heading);

  const list = document.createElement("div");
  list.className = "debates";
  // Three debate rows; pro renders blue on the left, contra red on the right, with the discussion link.
  for (const debate of controversial) {
    const row = document.createElement("article");
    row.className = "debate";

    const debateHeadline = document.createElement("h3");
    debateHeadline.className = "debate__headline";
    debateHeadline.textContent = debate.headline;
    row.append(debateHeadline);

    const columns = document.createElement("div");
    columns.className = "debate__columns";
    columns.append(
      debateColumn({ heading: "For", side: "pro", arguments_: debate.pro }),
      debateColumn({ heading: "Against", side: "contra", arguments_: debate.contra }),
    );
    row.append(columns);

    // The discussion thread is mandatory, so every debate renders its discussion link.
    const actions = document.createElement("div");
    actions.className = "debate__actions";
    actions.append(linkElement({ href: debate.sourceUrl, text: "Open discussion", className: "button-link" }));
    row.append(actions);
    list.append(row);
  }
  section.append(list);
  return section;
}

function renderReport({ briefing }) {
  // A daily run carries exactly one report, but reports is an array; render one section per report.
  docElement.replaceChildren(...briefing.reports.map((report) => reportSection({ report: report })));
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

function hideMessage() {
  messageElement.hidden = true;
}

function showView({ view }) {
  // Map and doc views are mutually exclusive; toggling hidden keeps a single Leaflet instance alive.
  if (view === "map") {
    mapElement.hidden = false;
    docElement.hidden = true;
  } else if (view === "doc") {
    mapElement.hidden = true;
    docElement.hidden = false;
    docElement.replaceChildren();
  } else {
    throw new RangeError("Unsupported view: " + view);
  }
}

function setChrome({ routeName, route }) {
  document.getElementById("page-title").textContent = route.title;
  document.getElementById("page-subtitle").textContent = route.subtitle;
  // Mark exactly the active nav link so the current page is announced and visibly selected.
  for (const link of document.querySelectorAll(".site-nav a")) {
    if (link.dataset.route === routeName) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  }
}

async function activateMapRoute({ route }) {
  showView({ view: "map" });
  showMessage({ text: "Loading " + route.title + "…", kind: "loading" });
  try {
    const response = await fetch(route.url + "?loaded=" + Date.now(), { cache: "no-store" });
    if (response.ok === false) {
      throw new Error("Request for " + route.url + " failed with HTTP " + response.status + ".");
    }
    const features = validateFeatureCollection({ value: await response.json() });
    if (features.length > 0) {
      renderMapFeatures({ features: features });
      map.invalidateSize();
      hideMessage();
    } else {
      ensureMap().markerGroup.clearLayers();
      showMessage({ text: "There is no news in the retained run window for this page.", kind: "empty" });
    }
  } catch (error) {
    showMessage({ text: "The " + route.title + " page could not be loaded.", kind: "error" });
    console.error("Could not load the " + route.title + " page.", error);
  }
}

async function activateBriefingRoute({ route }) {
  showView({ view: "doc" });
  showMessage({ text: "Loading " + route.title + "…", kind: "loading" });
  try {
    const briefing = await loadBriefing();
    route.render({ briefing: briefing });
    hideMessage();
  } catch (error) {
    docElement.replaceChildren();
    showMessage({ text: "The " + route.title + " page could not be loaded.", kind: "error" });
    console.error("Could not load the " + route.title + " page.", error);
  }
}

function weeklyInlineNodes({ text }) {
  // Parse the two inline forms our weekly markdown uses — **bold** and [label](url) — into safe DOM nodes
  // (textContent and createElement only, never innerHTML); any other run of characters stays literal text.
  const nodes = [];
  // The link label can contain inner brackets (e.g. "Alpinforum [1]"), so match it non-greedily up to the
  // "](" that starts the URL rather than up to the first "]".
  const pattern = /\*\*([^*]+)\*\*|\[(.+?)\]\(([^)]+)\)/g;
  let lastIndex = 0;
  let match = pattern.exec(text);
  while (match !== null) {
    if (match.index > lastIndex) {
      nodes.push(document.createTextNode(text.slice(lastIndex, match.index)));
    }
    // Group 1 is a bold run; otherwise groups 2/3 are a link's label and href.
    if (match[1] !== undefined) {
      const strong = document.createElement("strong");
      strong.textContent = match[1];
      nodes.push(strong);
    } else {
      nodes.push(linkElement({ href: match[3], text: match[2], className: null }));
    }
    lastIndex = pattern.lastIndex;
    match = pattern.exec(text);
  }
  if (lastIndex < text.length) {
    nodes.push(document.createTextNode(text.slice(lastIndex)));
  }
  return nodes;
}

function renderWeekly({ markdown }) {
  // Render the published weekly briefing markdown line by line into safe DOM: a cover image, its caption, the
  // five section headings, and their bullet lists. The producer owns this exact shape, so a small line scanner
  // is enough and avoids pulling in a markdown dependency.
  const section = document.createElement("section");
  section.className = "doc-section weekly";
  let list = null;
  function closeList() {
    // Consecutive "- " bullets accumulate into one <ul>; any other line flushes and appends it first.
    if (list !== null) {
      section.append(list);
      list = null;
    }
  }
  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();
    // Blank lines and the markdown H1 are skipped: the header chrome already shows the page title.
    if (line === "" || line.startsWith("# ")) {
      continue;
    }
    // The email's promo paragraph links back to this very site, so the viewer drops it (it is here already).
    if (line.includes("michaelmedek.github.io/alpin-map")) {
      continue;
    }
    if (line.startsWith("<img")) {
      // The one raw <img> line carries the cover; read its src/alt and build a fresh element (no innerHTML).
      closeList();
      const srcMatch = line.match(/src="([^"]*)"/);
      if (srcMatch !== null) {
        const image = document.createElement("img");
        image.className = "weekly__cover";
        image.loading = "lazy";
        image.decoding = "async";
        image.referrerPolicy = "no-referrer";
        image.src = srcMatch[1];
        const altMatch = line.match(/alt="([^"]*)"/);
        image.alt = altMatch === null ? "Weekly briefing cover image." : altMatch[1];
        section.append(image);
      }
    } else if (line.startsWith("## ")) {
      closeList();
      const heading = document.createElement("h2");
      heading.className = "weekly__heading";
      heading.textContent = line.slice(3).trim();
      section.append(heading);
    } else if (line.startsWith("- ")) {
      if (list === null) {
        list = document.createElement("ul");
        list.className = "weekly__list";
      }
      const item = document.createElement("li");
      item.append(...weeklyInlineNodes({ text: line.slice(2) }));
      list.append(item);
    } else if (line.length > 2 && line.startsWith("*") && line.endsWith("*")) {
      closeList();
      const caption = document.createElement("p");
      caption.className = "weekly__caption";
      const emphasis = document.createElement("em");
      emphasis.textContent = line.slice(1, -1);
      caption.append(emphasis);
      section.append(caption);
    } else {
      // Any remaining line (the live-map promo) is a paragraph that may carry inline bold and a link.
      closeList();
      const paragraph = document.createElement("p");
      paragraph.className = "weekly__text";
      paragraph.append(...weeklyInlineNodes({ text: line }));
      section.append(paragraph);
    }
  }
  closeList();
  return section;
}

async function activateWeeklyRoute({ route }) {
  // The weekly briefing is published as markdown, not JSON, so fetch it as text and render it into the doc view.
  showView({ view: "doc" });
  showMessage({ text: "Loading " + route.title + "…", kind: "loading" });
  try {
    const response = await fetch(route.url + "?loaded=" + Date.now(), { cache: "no-store" });
    if (response.ok === false) {
      throw new Error("Request for " + route.url + " failed with HTTP " + response.status + ".");
    }
    docElement.replaceChildren(renderWeekly({ markdown: await response.text() }));
    hideMessage();
  } catch (error) {
    docElement.replaceChildren();
    showMessage({ text: "The " + route.title + " page could not be loaded.", kind: "error" });
    console.error("Could not load the " + route.title + " page.", error);
  }
}

function activateRoute({ route }) {
  // The view kind is a closed set: a map route renders Leaflet, a doc route renders the collapsed daily
  // briefing, and the weekly route renders the published weekly markdown.
  if (route.view === "map") {
    return activateMapRoute({ route: route });
  } else if (route.view === "doc") {
    return activateBriefingRoute({ route: route });
  } else if (route.view === "weekly") {
    return activateWeeklyRoute({ route: route });
  } else {
    throw new RangeError("Unsupported view: " + route.view);
  }
}

function routeNameFromHash() {
  const requested = window.location.hash.replace(/^#\/?/, "");
  // Fall back to the default page for an empty or unknown hash so a stray link never shows a blank view.
  if (Object.hasOwn(ROUTES, requested)) {
    return requested;
  } else {
    return DEFAULT_ROUTE;
  }
}

function handleRoute() {
  const routeName = routeNameFromHash();
  const route = ROUTES[routeName];
  setChrome({ routeName: routeName, route: route });
  if (routeName !== activeRoute) {
    activeRoute = routeName;
    activateRoute({ route: route });
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

// Browser bootstrap. Skipped under the Node render test, which imports renderWeekly and drives it directly so
// the suite actually loads and exercises this file instead of only validating data.
if (globalThis.__ALPIN_VIEWER_TEST__ !== true) {
  window.addEventListener("hashchange", handleRoute);
  initRunTimestamp();
  handleRoute();
}

export { renderWeekly };