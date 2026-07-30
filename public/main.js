// ===== Element refs =====
const plannerView = document.getElementById("planner-view");
const loadingView = document.getElementById("loading-view");
const resultsView = document.getElementById("results-view");

const form = document.getElementById("planner-form");
const formError = document.getElementById("form-error");
const backBtn = document.getElementById("back-btn");
const regenerateBtn = document.getElementById("regenerate-btn");
const chipGroup = document.getElementById("interest-chips");
const packingToggle = document.getElementById("packing-toggle");
const packingList = document.getElementById("packing-list");

const editToggleBtn = document.getElementById("edit-toggle-btn");
const saveTripBtn = document.getElementById("save-trip-btn");
const shareTripBtn = document.getElementById("share-trip-btn");
const exportTripBtn = document.getElementById("export-trip-btn");
const shareStatus = document.getElementById("share-status");
const currencySelect = document.getElementById("currency-select");

const quickFactsEl = document.getElementById("quick-facts");
const weatherRetryWrap = document.getElementById("weather-retry");
const weatherRetryBtn = document.getElementById("weather-retry-btn");

const myTripsBtn = document.getElementById("my-trips-btn");
const closeDrawerBtn = document.getElementById("close-drawer-btn");
const drawer = document.getElementById("my-trips-drawer");
const drawerOverlay = document.getElementById("drawer-overlay");
const postcardGrid = document.getElementById("postcard-grid");
const drawerEmpty = document.getElementById("drawer-empty");
const tripCountBadge = document.getElementById("trip-count-badge");

let selectedInterests = [];
let lastItinerary = null;
let lastPayload = null;
let editMode = false;
let currentWeatherDestination = "";
let currentTripStartDate = "";
let currentSavedId = null; // id of the currently-open trip within localStorage, if any
let currentTripSummary = { destination: "", days: 0 };
const routeMaps = {}; // day number -> Leaflet map instance
const geocodeCache = {}; // place name -> {lat, lon} | null
const DAY_ACCENTS = ["#ff6b5b", "#00c2a8", "#ffc93c", "#ff3e7f", "#8b5cf6"];

const STORAGE_KEY = "voyage_saved_trips_v1";
const PACKING_KEY_PREFIX = "voyage_packing_";
const GEOCODE_CACHE_KEY = "voyage_geocode_cache_v1";
const RATE_CACHE_KEY = "voyage_rate_cache_v1";
const RATE_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours — exchange rates don't need to be more frequent

function loadPersistedJson(key, fallback) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "null");
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch (err) {
    return fallback;
  }
}
function savePersistedJson(key, obj) {
  try {
    localStorage.setItem(key, JSON.stringify(obj));
  } catch (err) {
    /* storage full/unavailable — degrade gracefully, nothing to do */
  }
}

// Places don't move, so a geocode cache can live indefinitely across sessions.
Object.assign(geocodeCache, loadPersistedJson(GEOCODE_CACHE_KEY, {}));

// ===== View switching =====
function showView(view) {
  [plannerView, loadingView, resultsView].forEach((v) => v.classList.remove("active"));
  view.classList.add("active");
}

// ===== Interest chips =====
chipGroup.addEventListener("click", (e) => {
  const btn = e.target.closest(".chip");
  if (!btn) return;
  const value = btn.dataset.value;
  btn.classList.toggle("selected");
  if (selectedInterests.includes(value)) {
    selectedInterests = selectedInterests.filter((v) => v !== value);
  } else {
    selectedInterests.push(value);
  }
});

// ===== Packing checklist toggle =====
packingToggle.addEventListener("click", () => {
  const isHidden = packingList.hidden;
  packingList.hidden = !isHidden;
  packingToggle.classList.toggle("open", isHidden);
});

// ===== Form submit =====
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  formError.hidden = true;

  const payload = {
    destination: document.getElementById("destination").value.trim(),
    days: Number(document.getElementById("days").value),
    travelers: Number(document.getElementById("travelers").value),
    budget: document.getElementById("budget").value,
    pace: document.getElementById("pace").value,
    interests: selectedInterests,
    notes: document.getElementById("notes").value.trim(),
    startDate: document.getElementById("start-date").value || "",
  };

  if (!payload.destination) {
    showFormError("Please tell us where you're headed.");
    return;
  }
  if (!payload.days || payload.days < 1) {
    showFormError("Trip length must be at least 1 day.");
    return;
  }

  currentSavedId = null;
  await generateItinerary(payload);
});

regenerateBtn.addEventListener("click", async () => {
  if (!lastPayload) {
    showView(plannerView);
    return;
  }
  currentSavedId = null;
  await generateItinerary(lastPayload);
});

backBtn.addEventListener("click", () => {
  showView(plannerView);
});

function showFormError(msg) {
  formError.textContent = msg;
  formError.hidden = false;
}

async function generateItinerary(payload) {
  showView(loadingView);

  try {
    const res = await fetch("/api/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await res.json();

    if (!res.ok) {
      showView(plannerView);
      showFormError(data.error || "Something went wrong. Please try again.");
      return;
    }

    lastItinerary = data.itinerary;
    lastPayload = payload;
    setEditMode(false);
    renderItinerary(data.itinerary, payload);
    showView(resultsView);
  } catch (err) {
    console.error(err);
    showView(plannerView);
    showFormError("Couldn't reach the server. Is it still running?");
  }
}

// ===== Rendering =====
function renderItinerary(itinerary, payload) {
  const destinationName = itinerary.destination || payload.destination;
  currentTripSummary = { destination: destinationName, days: payload.days };
  currentTripStartDate = (payload && payload.startDate) || "";

  document.getElementById("result-destination").textContent = destinationName;
  document.getElementById("result-summary").textContent = itinerary.summary || "";

  renderQuickFacts(itinerary.quickFacts);

  shareStatus.hidden = true;
  currencySelect.value = "INR";
  currentCurrency = "INR";
  fetchRate("INR").then(() => {
    rerenderMoneyValues();
    document.getElementById("result-budget").textContent =
      typeof itinerary.totalBudgetEstimateUsd === "number"
        ? formatMoney(itinerary.totalBudgetEstimateUsd, currentCurrency)
        : "—";
  });

  // Packing checklist (persisted check-state per destination+days)
  const packingKey = PACKING_KEY_PREFIX + slugify(`${destinationName}-${payload.days}`);
  const checkedSet = new Set(JSON.parse(localStorage.getItem(packingKey) || "[]"));
  packingList.innerHTML = "";
  packingList.hidden = true;
  packingToggle.classList.remove("open");
  (itinerary.packingTips || []).forEach((tip, i) => {
    const li = document.createElement("li");
    const isChecked = checkedSet.has(i);
    if (isChecked) li.classList.add("checked");
    li.innerHTML = `<input type="checkbox" ${isChecked ? "checked" : ""} /><span></span>`;
    li.querySelector("span").textContent = tip;
    li.addEventListener("click", (e) => {
      if (e.target.tagName !== "INPUT") e.target.closest("li").querySelector("input").click();
    });
    li.querySelector("input").addEventListener("change", (e) => {
      li.classList.toggle("checked", e.target.checked);
      if (e.target.checked) checkedSet.add(i);
      else checkedSet.delete(i);
      localStorage.setItem(packingKey, JSON.stringify([...checkedSet]));
    });
    packingList.appendChild(li);
  });

  // Calculated running total from per-day cost breakdowns (stored in USD)
  updateBudgetTotals(itinerary);

  // Live weather (best-effort; never blocks the rest of the UI)
  currentWeatherDestination = destinationName;
  loadWeather(destinationName, currentTripStartDate, payload.days);

  // Day tabs + day cards
  const days = itinerary.days || [];
  const dayTabs = document.getElementById("day-tabs");
  const dayList = document.getElementById("day-list");
  dayTabs.innerHTML = "";
  dayList.innerHTML = "";
  Object.keys(routeMaps).forEach((k) => delete routeMaps[k]);

  days.forEach((day, idx) => {
    const accent = DAY_ACCENTS[idx % DAY_ACCENTS.length];

    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "day-tab";
    tab.style.borderColor = accent;
    tab.textContent = `Day ${day.day}`;
    tab.addEventListener("click", () => {
      document.getElementById(`day-card-${day.day}`).scrollIntoView({ behavior: "smooth", block: "start" });
    });
    dayTabs.appendChild(tab);

    const card = buildDayCard(day, destinationName, accent);
    dayList.appendChild(card);
  });

  applyEditModeToDom();
}

function renderQuickFacts(facts) {
  if (!facts || typeof facts !== "object") {
    quickFactsEl.hidden = true;
    quickFactsEl.innerHTML = "";
    return;
  }
  const items = [
    ["💱", "Local currency", facts.localCurrency],
    ["🗣️", "Language", facts.localLanguage],
    ["📅", "Best time to visit", facts.bestTimeToVisit],
    ["🙏", "Tipping", facts.tippingNorm],
  ].filter(([, , value]) => Boolean(value));

  if (!items.length) {
    quickFactsEl.hidden = true;
    quickFactsEl.innerHTML = "";
    return;
  }

  quickFactsEl.innerHTML = items
    .map(
      ([icon, label, value]) => `
      <div class="quick-fact">
        <span class="quick-fact-icon">${icon}</span>
        <div class="quick-fact-text">
          <span class="quick-fact-label">${escapeHtml(label)}</span>
          <span class="quick-fact-value">${escapeHtml(value)}</span>
        </div>
      </div>`
    )
    .join("");
  quickFactsEl.hidden = false;
}

function updateBudgetTotals(itinerary) {
  const days = itinerary.days || [];
  const calcTotal = days.reduce((sum, d) => sum + ((d.costBreakdown && d.costBreakdown.total) || 0), 0);
  itinerary.__calcTotalUsd = calcTotal;
  document.getElementById("result-total-calc").textContent = calcTotal ? formatMoney(calcTotal, currentCurrency) : "—";
}

function buildDayCard(day, destinationName, accent) {
  const card = document.createElement("article");
  card.className = "day-card";
  card.id = `day-card-${day.day}`;
  card.style.setProperty("--card-accent", accent);

  const stops = Array.isArray(day.stops) ? day.stops.filter(Boolean) : [];
  const cost = day.costBreakdown || {};
  const total = cost.total || (cost.accommodation || 0) + (cost.food || 0) + (cost.activities || 0) + (cost.transport || 0);
  const maxSeg = Math.max(1, total);

  const stopsHtml = stops
    .map((s, i) => `<span class="stop">${escapeHtml(s)}</span>${i < stops.length - 1 ? '<span class="arrow">→</span>' : ""}`)
    .join("");

  const mapsUrl = buildGoogleMapsUrl(stops, destinationName);
  const hotelUrl = `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(destinationName)}`;
  const flightUrl = `https://www.google.com/travel/flights?q=${encodeURIComponent("Flights to " + destinationName)}`;

  card.innerHTML = `
    <div class="day-card-head">
      <span class="day-number">DAY ${String(day.day).padStart(2, "0")}</span>
      <h3 class="day-title" data-field="title">${escapeHtml(day.title || "")}</h3>
      <span class="day-weather-chip" id="day-weather-${day.day}" hidden></span>
    </div>
    <div class="day-block">
      <span class="day-block-label">Morning</span>
      <span data-field="morning">${escapeHtml(day.morning || "")}</span>
    </div>
    <div class="day-block">
      <span class="day-block-label">Afternoon</span>
      <span data-field="afternoon">${escapeHtml(day.afternoon || "")}</span>
    </div>
    <div class="day-block">
      <span class="day-block-label">Evening</span>
      <span data-field="evening">${escapeHtml(day.evening || "")}</span>
    </div>
    <div class="day-footer">
      <span class="food-pick" data-field="foodPick">${escapeHtml(day.foodPick || "")}</span>
    </div>

    ${
      stops.length
        ? `
    <div class="route-section">
      <div class="route-header">
        <div class="route-stops">${stopsHtml}</div>
        <div class="route-actions">
          <button type="button" class="route-btn" data-action="toggle-map" data-day="${day.day}">Show route map</button>
          ${mapsUrl ? `<a class="route-btn" href="${mapsUrl}" target="_blank" rel="noopener">Open in Google Maps</a>` : ""}
        </div>
      </div>
      <div class="route-map hidden-map" id="map-day-${day.day}"></div>
      <p class="route-map-status" id="map-status-${day.day}" hidden></p>
    </div>`
        : ""
    }

    <div class="cost-section">
      <div class="cost-header">
        <span class="cost-label">Est. cost — Day ${day.day}</span>
        <span class="cost-total" data-cost-total>${formatMoney(total, currentCurrency)}</span>
      </div>
      <div class="cost-bar">
        ${costSeg("accommodation", cost.accommodation, maxSeg)}
        ${costSeg("food", cost.food, maxSeg)}
        ${costSeg("activities", cost.activities, maxSeg)}
        ${costSeg("transport", cost.transport, maxSeg)}
      </div>
      <div class="cost-legend" data-cost-legend>
        <span class="cost-legend-item"><span class="cost-swatch accommodation"></span>Stay ${formatMoney(cost.accommodation || 0, currentCurrency)}</span>
        <span class="cost-legend-item"><span class="cost-swatch food"></span>Food ${formatMoney(cost.food || 0, currentCurrency)}</span>
        <span class="cost-legend-item"><span class="cost-swatch activities"></span>Activities ${formatMoney(cost.activities || 0, currentCurrency)}</span>
        <span class="cost-legend-item"><span class="cost-swatch transport"></span>Transport ${formatMoney(cost.transport || 0, currentCurrency)}</span>
      </div>
    </div>

    <div class="booking-links">
      <a class="booking-link" href="${hotelUrl}" target="_blank" rel="noopener">🏨 Search hotels in ${escapeHtml(destinationName)}</a>
      <a class="booking-link" href="${flightUrl}" target="_blank" rel="noopener">🛫 Search flights to ${escapeHtml(destinationName)}</a>
    </div>
  `;

  // store raw USD amounts on the element for currency re-render
  card.dataset.accCost = cost.accommodation || 0;
  card.dataset.foodCost = cost.food || 0;
  card.dataset.actCost = cost.activities || 0;
  card.dataset.transCost = cost.transport || 0;
  card.dataset.totalCost = total;

  const toggleBtn = card.querySelector('[data-action="toggle-map"]');
  if (toggleBtn) {
    toggleBtn.addEventListener("click", () => onToggleRouteMap(day.day, stops, destinationName, toggleBtn));
  }

  // Keep the in-memory itinerary object in sync when a field is hand-edited
  card.querySelectorAll("[data-field]").forEach((el) => {
    el.addEventListener("input", () => {
      const field = el.dataset.field;
      const dayObj = (lastItinerary.days || []).find((d) => d.day === day.day);
      if (dayObj) dayObj[field] = el.textContent;
    });
  });

  return card;
}

function costSeg(type, value, maxSeg) {
  const v = value || 0;
  const pct = Math.max(0, Math.min(100, (v / maxSeg) * 100));
  return `<span class="cost-bar-seg ${type}" style="width:${pct}%"></span>`;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function slugify(str) {
  return String(str).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

// ===== Google Maps route link (no API key needed) =====
function buildGoogleMapsUrl(stops, destinationName) {
  if (!stops.length) return null;
  const withContext = stops.map((s) => `${s}, ${destinationName}`);
  const origin = encodeURIComponent(withContext[0]);
  const destination = encodeURIComponent(withContext[withContext.length - 1]);
  const waypoints = withContext.slice(1, -1).map(encodeURIComponent).join("|");
  let url = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}`;
  if (waypoints) url += `&waypoints=${waypoints}`;
  return url;
}

// ===== Free geocoding via Open-Meteo (no API key required) =====
async function geocodePlace(query) {
  const cacheKey = `city:${query}`;
  if (geocodeCache[cacheKey] !== undefined) return geocodeCache[cacheKey];
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=1&language=en&format=json`;
    const res = await fetch(url);
    const data = await res.json();
    const result = data && data.results && data.results[0];
    const value = result ? { lat: result.latitude, lon: result.longitude } : null;
    geocodeCache[cacheKey] = value;
    savePersistedJson(GEOCODE_CACHE_KEY, geocodeCache);
    return value;
  } catch (err) {
    return null;
  }
}

// ===== Nominatim geocoding for specific stops/landmarks (better POI accuracy
// than the city-level Open-Meteo geocoder used above) =====
let lastNominatimCallAt = 0;
async function nominatimSearch(query) {
  // Respect Nominatim's usage policy: max ~1 request/second.
  const waitMs = Math.max(0, 1100 - (Date.now() - lastNominatimCallAt));
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  lastNominatimCallAt = Date.now();

  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Nominatim returned ${res.status}`);
  const data = await res.json();
  const hit = Array.isArray(data) && data[0];
  return hit ? { lat: parseFloat(hit.lat), lon: parseFloat(hit.lon) } : null;
}

async function geocodeStop(stopName, destinationName) {
  const cacheKey = `stop:${stopName}|${destinationName}`;
  if (geocodeCache[cacheKey] !== undefined) return geocodeCache[cacheKey];

  let result = null;
  try {
    // Try with destination context first (disambiguates common landmark names)...
    result = await nominatimSearch(`${stopName}, ${destinationName}`);
    // ...then fall back to the stop name alone in case the combined query was too specific.
    if (!result) result = await nominatimSearch(stopName);
  } catch (err) {
    result = null;
  }

  geocodeCache[cacheKey] = result;
  savePersistedJson(GEOCODE_CACHE_KEY, geocodeCache);
  return result;
}

// ===== Route map (toggled per day) =====
async function onToggleRouteMap(dayNum, stops, destinationName, btn) {
  const mapEl = document.getElementById(`map-day-${dayNum}`);
  const statusEl = document.getElementById(`map-status-${dayNum}`);
  const isHidden = mapEl.classList.contains("hidden-map");

  if (!isHidden) {
    mapEl.classList.add("hidden-map");
    btn.textContent = "Show route map";
    return;
  }

  mapEl.classList.remove("hidden-map");
  btn.textContent = "Hide route map";

  if (routeMaps[dayNum]) {
    setTimeout(() => routeMaps[dayNum].invalidateSize(), 50);
    return;
  }

  statusEl.hidden = false;
  statusEl.textContent = "Looking up these places...";

  const points = [];
  const missed = [];
  for (const stop of stops) {
    const coords = await geocodeStop(stop, destinationName);
    if (coords) points.push({ name: stop, ...coords });
    else missed.push(stop);
  }

  if (!points.length) {
    statusEl.textContent = "Couldn't find map coordinates for these stops — try the Google Maps link instead.";
    return;
  }

  statusEl.hidden = missed.length === 0;
  if (missed.length) {
    statusEl.textContent = `Couldn't place ${missed.length === 1 ? `"${missed[0]}"` : `${missed.length} stops`} on the map — the rest are shown below.`;
  }

  const map = L.map(mapEl, { scrollWheelZoom: false }).setView([points[0].lat, points[0].lon], 13);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors",
    maxZoom: 19,
  }).addTo(map);

  const latLngs = points.map((p) => [p.lat, p.lon]);
  points.forEach((p, i) => {
    L.marker([p.lat, p.lon]).addTo(map).bindPopup(`${i + 1}. ${p.name}`);
  });

  if (latLngs.length > 1) {
    L.polyline(latLngs, { color: "#ff3e7f", weight: 3, dashArray: "6 8" }).addTo(map);
    map.fitBounds(latLngs, { padding: [30, 30] });
  }

  routeMaps[dayNum] = map;
  setTimeout(() => map.invalidateSize(), 50);
}

// ===== Live weather via Open-Meteo (free, no API key) =====
async function loadWeather(destinationName, startDate, days) {
  const card = document.getElementById("weather-card");
  const fallback = document.getElementById("weather-fallback");
  card.hidden = true;
  fallback.hidden = true;
  weatherRetryWrap.hidden = true;

  try {
    const coords = await geocodePlace(destinationName);
    if (!coords) throw new Error("No geocoding match");

    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}` +
      `&current_weather=true&daily=temperature_2m_max,temperature_2m_min,weathercode` +
      `&timezone=auto&temperature_unit=celsius&forecast_days=16`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Weather API returned ${res.status}`);
    const data = await res.json();
    const current = data.current_weather;
    if (!current) throw new Error("No weather data");

    document.getElementById("weather-icon").textContent = weatherIcon(current.weathercode);
    document.getElementById("weather-temp").textContent = `${Math.round(current.temperature)}°C`;
    document.getElementById("weather-desc").textContent = weatherDescription(current.weathercode);
    document.querySelector(".weather-note").textContent = startDate
      ? "right now, at your destination — see each day for its forecast"
      : "right now, at your destination";
    card.hidden = false;

    applyDailyForecastToDayCards(data.daily, startDate, days);
  } catch (err) {
    fallback.hidden = false;
    weatherRetryWrap.hidden = false;
  }
}

weatherRetryBtn.addEventListener("click", () => {
  if (!currentWeatherDestination) return;
  loadWeather(currentWeatherDestination, currentTripStartDate, currentTripSummary.days);
});

// Maps each trip day onto Open-Meteo's daily forecast (available up to ~16
// days out) so travelers see the actual forecast for their real dates,
// not just "current weather" as a rough proxy.
function applyDailyForecastToDayCards(daily, startDate, days) {
  if (!daily || !Array.isArray(daily.time) || !startDate || !days) return;
  const start = new Date(`${startDate}T00:00:00`);
  if (Number.isNaN(start.getTime())) return;

  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const iso = d.toISOString().slice(0, 10);
    const idx = daily.time.indexOf(iso);
    if (idx === -1) continue; // outside the forecast horizon (too far out, or in the past)

    const max = daily.temperature_2m_max[idx];
    const min = daily.temperature_2m_min[idx];
    const code = daily.weathercode[idx];
    const chip = document.getElementById(`day-weather-${i + 1}`);
    if (chip && typeof max === "number" && typeof min === "number") {
      chip.hidden = false;
      chip.textContent = `${weatherIcon(code)} ${Math.round(max)}°/${Math.round(min)}°C`;
      chip.title = `Forecast for ${iso}`;
    }
  }
}

function weatherIcon(code) {
  if (code === 0) return "☀️";
  if ([1, 2].includes(code)) return "🌤️";
  if (code === 3) return "☁️";
  if ([45, 48].includes(code)) return "🌫️";
  if ([51, 53, 55, 56, 57].includes(code)) return "🌦️";
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "🌧️";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "❄️";
  if ([95, 96, 99].includes(code)) return "⛈️";
  return "🌡️";
}

function weatherDescription(code) {
  const map = {
    0: "Clear sky", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Foggy", 48: "Foggy", 51: "Light drizzle", 53: "Drizzle", 55: "Dense drizzle",
    56: "Freezing drizzle", 57: "Freezing drizzle", 61: "Light rain", 63: "Rain",
    65: "Heavy rain", 66: "Freezing rain", 67: "Freezing rain", 71: "Light snow",
    73: "Snow", 75: "Heavy snow", 77: "Snow grains", 80: "Rain showers", 81: "Rain showers",
    82: "Violent showers", 85: "Snow showers", 86: "Snow showers", 95: "Thunderstorm",
    96: "Thunderstorm w/ hail", 99: "Thunderstorm w/ hail",
  };
  return map[code] || "Current conditions";
}

// ===== EDIT MODE =====
function setEditMode(on) {
  editMode = on;
  editToggleBtn.classList.toggle("active", on);
  editToggleBtn.querySelector("span").textContent = on ? "Editing" : "Edit";
  applyEditModeToDom();
}

function applyEditModeToDom() {
  document.getElementById("result-destination").contentEditable = editMode ? "true" : "false";
  document.getElementById("result-summary").contentEditable = editMode ? "true" : "false";
  document.querySelectorAll("#day-list [data-field]").forEach((el) => {
    el.contentEditable = editMode ? "true" : "false";
  });
}

editToggleBtn.addEventListener("click", () => setEditMode(!editMode));

document.getElementById("result-destination").addEventListener("input", (e) => {
  if (lastItinerary) lastItinerary.destination = e.target.textContent;
});
document.getElementById("result-summary").addEventListener("input", (e) => {
  if (lastItinerary) lastItinerary.summary = e.target.textContent;
});

// ===== CURRENCY CONVERSION (free, keyless Frankfurter API) =====
const currencyRateCache = {}; // code -> { rate, fetchedAt }
Object.assign(currencyRateCache, loadPersistedJson(RATE_CACHE_KEY, {}));
let currentCurrency = "INR";

const CURRENCY_SYMBOLS = { USD: "$", EUR: "€", GBP: "£", JPY: "¥", INR: "₹", AUD: "$", CAD: "$" };

function formatMoney(amountUsd, code) {
  const cached = code === "USD" ? { rate: 1 } : currencyRateCache[code];
  const rate = cached && cached.rate;
  if (code !== "USD" && !rate) return `~$${Math.round(amountUsd).toLocaleString()} USD`;
  const converted = amountUsd * (rate || 1);
  const symbol = CURRENCY_SYMBOLS[code] || code + " ";
  return `~${symbol}${Math.round(converted).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

async function fetchRate(code) {
  if (code === "USD") return;
  const cached = currencyRateCache[code];
  const isFresh = cached && Date.now() - cached.fetchedAt < RATE_CACHE_TTL_MS;
  if (isFresh) return;
  try {
    const res = await fetch(`https://api.frankfurter.app/latest?from=USD&to=${code}`);
    const data = await res.json();
    if (data && data.rates && data.rates[code]) {
      currencyRateCache[code] = { rate: data.rates[code], fetchedAt: Date.now() };
      savePersistedJson(RATE_CACHE_KEY, currencyRateCache);
    }
  } catch (err) {
    console.error("Currency lookup failed:", err);
  }
}

currencySelect.addEventListener("change", async () => {
  const code = currencySelect.value;
  currentCurrency = code;
  if (code !== "USD") {
    shareStatus.hidden = false;
    shareStatus.textContent = "Converting currency…";
    await fetchRate(code);
    shareStatus.hidden = true;
  }
  rerenderMoneyValues();
});

function rerenderMoneyValues() {
  if (!lastItinerary) return;
  const code = currentCurrency;
  document.getElementById("result-total-calc").textContent = lastItinerary.__calcTotalUsd
    ? formatMoney(lastItinerary.__calcTotalUsd, code)
    : "—";

  document.querySelectorAll(".day-card").forEach((card) => {
    const total = Number(card.dataset.totalCost || 0);
    const acc = Number(card.dataset.accCost || 0);
    const food = Number(card.dataset.foodCost || 0);
    const act = Number(card.dataset.actCost || 0);
    const trans = Number(card.dataset.transCost || 0);
    card.querySelector("[data-cost-total]").textContent = formatMoney(total, code);
    const legendSpans = card.querySelectorAll("[data-cost-legend] .cost-legend-item");
    if (legendSpans.length === 4) {
      legendSpans[0].innerHTML = `<span class="cost-swatch accommodation"></span>Stay ${formatMoney(acc, code)}`;
      legendSpans[1].innerHTML = `<span class="cost-swatch food"></span>Food ${formatMoney(food, code)}`;
      legendSpans[2].innerHTML = `<span class="cost-swatch activities"></span>Activities ${formatMoney(act, code)}`;
      legendSpans[3].innerHTML = `<span class="cost-swatch transport"></span>Transport ${formatMoney(trans, code)}`;
    }
  });
}

// ===== SAVE / MY TRIPS (localStorage) =====
function getSavedTrips() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch (err) {
    return [];
  }
}

function setSavedTrips(list) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  refreshTripCount();
}

function refreshTripCount() {
  const n = getSavedTrips().length;
  tripCountBadge.hidden = n === 0;
  tripCountBadge.textContent = n;
}

saveTripBtn.addEventListener("click", () => {
  if (!lastItinerary) return;
  const trips = getSavedTrips();
  const record = {
    id: currentSavedId || `trip_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    savedAt: Date.now(),
    payload: lastPayload,
    itinerary: lastItinerary,
  };
  const existingIdx = trips.findIndex((t) => t.id === record.id);
  if (existingIdx >= 0) trips[existingIdx] = record;
  else trips.unshift(record);
  currentSavedId = record.id;
  setSavedTrips(trips);
  flashStatus("Saved to My trips ✓");
});

function flashStatus(msg) {
  shareStatus.hidden = false;
  shareStatus.textContent = msg;
  setTimeout(() => { shareStatus.hidden = true; }, 2500);
}

function renderPostcards() {
  const trips = getSavedTrips();
  postcardGrid.innerHTML = "";
  drawerEmpty.hidden = trips.length > 0;
  trips.forEach((t, idx) => {
    const accent = DAY_ACCENTS[idx % DAY_ACCENTS.length];
    const el = document.createElement("div");
    el.className = "postcard";
    el.style.setProperty("--card-accent", accent);
    const dest = (t.itinerary && t.itinerary.destination) || (t.payload && t.payload.destination) || "Trip";
    const days = (t.payload && t.payload.days) || (t.itinerary && t.itinerary.days && t.itinerary.days.length) || "—";
    el.innerHTML = `
      <p class="postcard-dest">🗺️ ${escapeHtml(dest)}</p>
      <p class="postcard-meta">${days}-day trip · saved ${new Date(t.savedAt).toLocaleDateString()}</p>
      <div class="postcard-actions">
        <button type="button" class="postcard-open">Open</button>
        <button type="button" class="postcard-delete">Delete</button>
      </div>
    `;
    el.querySelector(".postcard-open").addEventListener("click", () => {
      currentSavedId = t.id;
      lastItinerary = t.itinerary;
      lastPayload = t.payload;
      setEditMode(false);
      renderItinerary(t.itinerary, t.payload);
      showView(resultsView);
      closeDrawer();
    });
    el.querySelector(".postcard-delete").addEventListener("click", (e) => {
      e.stopPropagation();
      const remaining = getSavedTrips().filter((x) => x.id !== t.id);
      setSavedTrips(remaining);
      renderPostcards();
    });
    postcardGrid.appendChild(el);
  });
}

function openDrawer() {
  renderPostcards();
  drawer.classList.add("open");
  drawer.setAttribute("aria-hidden", "false");
  drawerOverlay.hidden = false;
}
function closeDrawer() {
  drawer.classList.remove("open");
  drawer.setAttribute("aria-hidden", "true");
  drawerOverlay.hidden = true;
}
myTripsBtn.addEventListener("click", openDrawer);
closeDrawerBtn.addEventListener("click", closeDrawer);
drawerOverlay.addEventListener("click", closeDrawer);

// ===== SHARE (backend-stored link) =====
shareTripBtn.addEventListener("click", async () => {
  if (!lastItinerary) return;
  flashStatus("Creating share link…");
  try {
    const res = await fetch("/api/trips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itinerary: lastItinerary }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to create link");

    const url = `${window.location.origin}${window.location.pathname}?trip=${data.id}`;
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(url);
      flashStatus("Link copied to clipboard 🔗");
    } else {
      shareStatus.hidden = false;
      shareStatus.textContent = url;
    }
  } catch (err) {
    console.error(err);
    flashStatus("Couldn't create a share link. Please try again.");
  }
});

// ===== EXPORT / PRINT =====
exportTripBtn.addEventListener("click", () => {
  window.print();
});

// ===== Load a shared trip from the URL, if present =====
async function loadSharedTripFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const id = params.get("trip");
  if (!id) return;

  showView(loadingView);
  try {
    const res = await fetch(`/api/trips/${encodeURIComponent(id)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Trip not found");

    lastItinerary = data.itinerary;
    lastPayload = { destination: data.itinerary.destination, days: (data.itinerary.days || []).length };
    currentSavedId = null;
    setEditMode(false);
    renderItinerary(lastItinerary, lastPayload);
    showView(resultsView);
  } catch (err) {
    console.error(err);
    showView(plannerView);
    showFormError("That shared trip link couldn't be loaded — it may have expired.");
  }
}

// ===== Init =====
refreshTripCount();
loadSharedTripFromUrl();
