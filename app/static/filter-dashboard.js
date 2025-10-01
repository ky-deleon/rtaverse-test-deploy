// Filter Modal Functions
function openFilterModal() {
  document.getElementById("filterModal").classList.remove("hidden");
}

function closeFilterModal() {
  document.getElementById("filterModal").classList.add("hidden");
}

async function loadBarangaysIntoSelect() {
  const sel = document.getElementById("locationFilter");
  if (!sel) return;
  try {
    const res = await fetch("/api/barangays");
    const { success, barangays } = await res.json();
    if (!success) return;
    sel.innerHTML =
      `<option value="">All locations</option>` +
      barangays.map((b) => `<option value="${b}">${b}</option>`).join("");
  } catch (e) {
    /* silent */
  }
}

document.addEventListener("DOMContentLoaded", () => {
  loadBarangaysIntoSelect();
});

function applyFilters() {
  const location = document.getElementById("locationFilter").value;

  // Month range (YYYY-MM)
  const monthFrom = document.getElementById("monthFrom").value;
  const monthTo = document.getElementById("monthTo").value;
  const dateError = document.getElementById("dateError");

  // Time range (HH:MM, 24h)
  const timeFrom = document.getElementById("timeFrom").value; // "07:00"
  const timeTo = document.getElementById("timeTo").value; // "10:00"

  // ---- Validate month range ----
  function validBounds(ym) {
    if (!ym) return true;
    const [y, m] = ym.split("-").map(Number);
    return y >= 2015 && y <= 2025 && m >= 1 && m <= 12;
  }
  function fmtMonth(ym) {
    const d = new Date(ym + "-01T00:00:00");
    return d.toLocaleDateString("en-PH", { month: "short", year: "numeric" });
  }

  dateError.classList.add("hidden");
  if (
    !validBounds(monthFrom) ||
    !validBounds(monthTo) ||
    (monthFrom && monthTo && monthFrom > monthTo)
  ) {
    dateError.classList.remove("hidden");
    return;
  }

  // ---- Update cards ----
  const dateEl = document.getElementById("cardDate");
  if (monthFrom && monthTo)
    dateEl.textContent = `${fmtMonth(monthFrom)} – ${fmtMonth(monthTo)}`;
  else if (monthFrom) dateEl.textContent = `from ${fmtMonth(monthFrom)}`;
  else if (monthTo) dateEl.textContent = `until ${fmtMonth(monthTo)}`;
  else dateEl.textContent = "—";

  const timeEl = document.getElementById("cardTime");
  const fmtTime = (t) => {
    if (!t) return "";
    const [h, m] = t.split(":").map(Number);
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };
  let timeLabel = "—";
  if (timeFrom && timeTo)
    timeLabel = `${fmtTime(timeFrom)} – ${fmtTime(timeTo)}`;
  else if (timeFrom) timeLabel = `from ${fmtTime(timeFrom)}`;
  else if (timeTo) timeLabel = `until ${fmtTime(timeTo)}`;
  timeEl.textContent = timeLabel;

  // Stop live clock overwrite
  dateEl.removeAttribute("data-live");
  timeEl.removeAttribute("data-live");

  // ---- NEW: Push filters to backend and refresh iframe map ----
  // Build query
  const params = new URLSearchParams();
  if (monthFrom) params.set("start", monthFrom);
  if (monthTo) params.set("end", monthTo);
  if (timeFrom) params.set("time_from", timeFrom);
  if (timeTo) params.set("time_to", timeTo);
  if (location) params.set("barangay", location);

  // NEW: read the correct endpoint from the DOM (avoids hardcoding /folium_map vs /api/folium_map)
  const baseUrl = document.getElementById("map-endpoint").dataset.url;

  const iframe = document.querySelector(".map-frame");
  iframe.src = `${baseUrl}?${params.toString()}`;

  closeFilterModal && closeFilterModal();
}

// Enhanced Location Filter with Search Functionality
function initializeLocationFilter() {
  const locationInput = document.getElementById("locationFilter");
  const dropdownList = document.getElementById("locationDropdownList");

  // Store all location options
  const locations = [
    "Agapito Del Rosario",
    "Amsic",
    "Anunas",
    "Balibago",
    "Capaya",
    "Claro M. Recto",
    "Cuayan",
    "Cutcut",
    "Cutud",
    "Lourdes North West",
    "Lourdes Sur",
    "Lourdes Sur East",
    "Malabanas",
    "Margot",
    "Marisol",
    "Mining",
    "Pampang",
    "Pandan",
    "Pulung Bulu",
    "Pulung Cacutud",
    "Pulung Maragul",
    "Salapungan",
    "San Jose",
    "San Nicolas",
    "Santa Teresita",
    "Santa Trinidad",
    "Santo Cristo",
    "Santo Domingo",
    "Sapalibutad",
    "Sapangbato",
    "Tabun",
    "Virgen Delos Remedios",
  ];

  // Show dropdown when input is focused
  locationInput.addEventListener("focus", function () {
    showLocationDropdown(locations);
  });

  // Filter locations as user types
  locationInput.addEventListener("input", function () {
    const searchTerm = this.value.toLowerCase();
    const filteredLocations = locations.filter((location) =>
      location.toLowerCase().includes(searchTerm)
    );
    showLocationDropdown(filteredLocations);
  });

  // Hide dropdown when clicking outside
  document.addEventListener("click", function (e) {
    if (!locationInput.parentElement.contains(e.target)) {
      hideLocationDropdown();
    }
  });

  function showLocationDropdown(locationList) {
    dropdownList.innerHTML = "";
    dropdownList.style.display = "block";

    if (locationList.length === 0) {
      const noResultsItem = document.createElement("div");
      noResultsItem.className = "dropdown-item no-results";
      noResultsItem.textContent = "No locations found";
      dropdownList.appendChild(noResultsItem);
      return;
    }

    locationList.forEach((location) => {
      const item = document.createElement("div");
      item.className = "dropdown-item";
      item.textContent = location;
      item.addEventListener("click", function () {
        locationInput.value = location;
        hideLocationDropdown();
      });
      dropdownList.appendChild(item);
    });
  }

  function hideLocationDropdown() {
    dropdownList.style.display = "none";
  }
}

function initializeMonthRange() {
  const from = document.getElementById("monthFrom");
  const to = document.getElementById("monthTo");
  const err = document.getElementById("dateError");

  function enforceMinMax(el) {
    if (!el.value) return;
    const min = el.getAttribute("min"); // "2015-01"
    const max = el.getAttribute("max"); // "2025-12"
    if (min && el.value < min) el.value = min;
    if (max && el.value > max) el.value = max;
  }

  [from, to].forEach((el) => {
    el?.addEventListener("change", () => {
      enforceMinMax(el);
      // hide error once user edits
      err.classList.add("hidden");
    });
  });
}

document.addEventListener("DOMContentLoaded", function () {
  initializeLocationFilter();
  initializeMonthRange(); // NEW
});

// Initialize enhanced filters when DOM is loaded
document.addEventListener("DOMContentLoaded", function () {
  initializeLocationFilter();
  initializeDateFilter();
});

// Close modal when clicking outside
document.addEventListener("click", function (event) {
  const modal = document.getElementById("filterModal");
  if (event.target === modal) {
    closeFilterModal();
  }
});

// Close modal with Escape key
document.addEventListener("keydown", function (event) {
  if (event.key === "Escape") {
    closeFilterModal();
  }
});

function populateYears(start, end) {
  const yearDropdowns = [
    document.getElementById("monthFromYear"),
    document.getElementById("monthToYear"),
  ];
  yearDropdowns.forEach((dropdown) => {
    dropdown.innerHTML = '<option value="">Year</option>';
    for (let y = start; y <= end; y++) {
      const opt = document.createElement("option");
      opt.value = y;
      opt.textContent = y;
      dropdown.appendChild(opt);
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  populateYears(2015, 2025);
});

function clearFilters() {
  const locationEl = document.getElementById("locationFilter");
  const monthFromEl = document.getElementById("monthFrom");
  const monthToEl = document.getElementById("monthTo");
  const timeFromEl = document.getElementById("timeFrom");
  const timeToEl = document.getElementById("timeTo");
  const dateError = document.getElementById("dateError");

  // 1) Reset form fields
  if (locationEl) locationEl.value = "";
  if (monthFromEl) monthFromEl.value = "";
  if (monthToEl) monthToEl.value = "";
  if (timeFromEl) timeFromEl.value = ""; // leave blank after clear
  if (timeToEl) timeToEl.value = ""; // leave blank after clear

  dateError?.classList.add("hidden");

  // 2) Restore the Date/Time cards to "live" now
  const dateEl = document.getElementById("cardDate");
  const timeEl = document.getElementById("cardTime");
  if (dateEl && timeEl) {
    // re-enable live mode so your minute-tick updater can take over again
    dateEl.setAttribute("data-live", "true");
    timeEl.setAttribute("data-live", "true");

    // paint current values immediately (no refresh needed)
    const now = new Date();
    const dateFmt = new Intl.DateTimeFormat("en-PH", {
      month: "long",
      day: "2-digit",
      year: "numeric",
      timeZone: "Asia/Manila",
    });
    const timeFmt = new Intl.DateTimeFormat("en-PH", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
      timeZone: "Asia/Manila",
    });
    dateEl.textContent = dateFmt.format(now);
    timeEl.textContent = timeFmt.format(now).toLowerCase();
  }

  // 3) Reset the map iframe to the base URL (no params)
  const baseUrl = document.getElementById("map-endpoint")?.dataset?.url;
  const iframe = document.querySelector(".map-frame");
  if (baseUrl && iframe) iframe.src = baseUrl;

  // 4) Close the modal
  typeof closeFilterModal === "function" && closeFilterModal();
}

// After you set dateEl/timeEl textContent:
dateEl?.removeAttribute("data-live");
timeEl?.removeAttribute("data-live");
