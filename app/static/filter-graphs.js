// --- Add near the top (global) ---
let currentFilters = {
  location: "",
  gender: "",
  dayOfWeek: [], // ["1. Monday", "3. Wednesday"]
  alcohol: [], // ["Yes","No","Unknown"]
  hourFrom: 0,
  hourTo: 23,
  ageFrom: 0,
  ageTo: 100,
};

// Helper to read the modal’s current values
function getFilterState() {
  const location = document.getElementById("locationFilter").value || "";
  const gender = document.getElementById("genderFilter").value || "";
  const dayOfWeek = getCheckedValues("dowGroup");
  const alcohol = getCheckedValues("alcoholGroup");
  const hourFrom = +document.getElementById("hourFromBox").value;
  const hourTo = +document.getElementById("hourToBox").value;
  const ageFrom = +document.getElementById("ageFromBox").value;
  const ageTo = +document.getElementById("ageToBox").value;

  return {
    location,
    gender,
    dayOfWeek,
    alcohol,
    hourFrom,
    hourTo,
    ageFrom,
    ageTo,
  };
}

// Filter Modal Functions
function openFilterModal() {
  document.getElementById("filterModal").classList.remove("hidden");
}

function closeFilterModal() {
  document.getElementById("filterModal").classList.add("hidden");
}

function getCheckedValues(containerId) {
  return [
    ...document.querySelectorAll(
      `#${containerId} input[type="checkbox"]:checked`
    ),
  ].map((cb) => cb.value);
}

function clamp(n, lo, hi) {
  return Math.min(Math.max(n, lo), hi);
}

function initDualRange(min, max, fromId, toId, fillId, boxFromId, boxToId) {
  const from = document.getElementById(fromId);
  const to = document.getElementById(toId);
  const fill = document.getElementById(fillId);
  const boxF = document.getElementById(boxFromId);
  const boxT = document.getElementById(boxToId);

  // draw fill between thumbs
  function redraw() {
    const a = +from.value,
      b = +to.value;
    const lo = Math.min(a, b),
      hi = Math.max(a, b);
    const pctLo = ((lo - min) / (max - min)) * 100;
    const pctHi = ((hi - min) / (max - min)) * 100;
    fill.style.left = pctLo + "%";
    fill.style.right = 100 - pctHi + "%";
    boxF.value = lo;
    boxT.value = hi;
  }

  function syncFromBox() {
    from.value = clamp(+boxF.value, min, +to.value);
    redraw();
  }
  function syncToBox() {
    to.value = clamp(+boxT.value, +from.value, max);
    redraw();
  }

  from.addEventListener("input", redraw);
  to.addEventListener("input", redraw);
  boxF.addEventListener("input", syncFromBox);
  boxT.addEventListener("input", syncToBox);

  // first paint
  redraw();
}

function initializeHourRange() {
  initDualRange(
    0,
    23,
    "hourFrom",
    "hourTo",
    "hourFill",
    "hourFromBox",
    "hourToBox"
  );
}
function initializeAgeRange() {
  initDualRange(
    0,
    100,
    "ageFrom",
    "ageTo",
    "ageFill",
    "ageFromBox",
    "ageToBox"
  );
}

// small helper
function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

// Replace your existing applyFilters() with this:
function applyFilters() {
  currentFilters = getFilterState();

  // Update info cards (guarded)
  setText("cardTime", `${currentFilters.hourFrom}-${currentFilters.hourTo}h`);
  setText("cardAge", `${currentFilters.ageFrom}-${currentFilters.ageTo}`);
  setText(
    "cardGender",
    currentFilters.gender ? capFirst(currentFilters.gender) : "All"
  );

  // Reload the charts/cards
  loadHourlyChart(currentFilters);
  loadDayOfWeekChart(currentFilters);
  loadTopBarangaysChart(currentFilters);
  loadAlcoholByHourChart(currentFilters);
  loadVictimsByAgeChart(currentFilters);
  loadGenderChart(currentFilters);
  if (typeof loadKpiCards === "function") loadKpiCards(currentFilters);

  closeFilterModal();
}

function updateGraphCards({ location, gender, ageFrom, ageTo }) {
  const locEl = document.getElementById("cardLocation");
  if (locEl) locEl.textContent = location?.trim() ? location : "All";

  const genderEl = document.getElementById("cardGender");
  if (genderEl) genderEl.textContent = gender ? capFirst(gender) : "All";

  const ageEl = document.getElementById("cardAge");
  if (ageEl) {
    if (ageFrom && ageTo) ageEl.textContent = `${ageFrom}-${ageTo}`;
    else if (ageFrom) ageEl.textContent = `${ageFrom}+`;
    else if (ageTo) ageEl.textContent = `0-${ageTo}`;
    else ageEl.textContent = "All";
  }
}

function capFirst(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

document.addEventListener("DOMContentLoaded", function () {
  initializeLocationFilter();
  initializeGenderFilter();
  initializeHourRange();
  initializeAgeRange();
  // NOTE: You asked to remove Date/Time filters earlier -> don't call initializeDateFilter()

  // Set initial card values
  updateGraphCards({ location: "", gender: "", ageFrom: "", ageTo: "" });
});

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

// Age Range Filter Initialization
function initializeAgeFilter() {
  const ageFromInput = document.getElementById("ageFrom");
  const ageToInput = document.getElementById("ageTo");
  const errorMessage = document.getElementById("ageError");

  // Age validation function
  function validateAge(value) {
    const age = parseInt(value);
    return !isNaN(age) && age >= 0 && age <= 100;
  }

  // Age range validation function
  function validateAgeRange() {
    const ageFrom = parseInt(ageFromInput.value);
    const ageTo = parseInt(ageToInput.value);

    if (isNaN(ageFrom) || isNaN(ageTo)) return true; // Allow empty values

    return ageFrom <= ageTo;
  }

  function showAgeError(
    message = 'Please enter valid ages (0-100) with "From" ≤ "To"'
  ) {
    ageFromInput.classList.add("error");
    ageToInput.classList.add("error");
    errorMessage.textContent = message;
    errorMessage.classList.remove("hidden");
  }

  function removeAgeError() {
    ageFromInput.classList.remove("error");
    ageToInput.classList.remove("error");
    errorMessage.classList.add("hidden");
  }

  // Restrict input to numbers only
  function restrictToNumbers(input) {
    input.addEventListener("input", function (e) {
      let value = e.target.value.replace(/[^\d]/g, "");

      // Limit to 3 digits (max age 100)
      if (value.length > 3) {
        value = value.slice(0, 3);
      }

      // Ensure max age is 100
      if (parseInt(value) > 100) {
        value = "100";
      }

      e.target.value = value;
    });

    input.addEventListener("keypress", function (e) {
      // Only allow numbers and control keys
      if (
        !/[\d]/.test(e.key) &&
        !["Backspace", "Delete", "ArrowLeft", "ArrowRight", "Tab"].includes(
          e.key
        )
      ) {
        e.preventDefault();
      }
    });
  }

  // Apply restrictions to both inputs
  restrictToNumbers(ageFromInput);
  restrictToNumbers(ageToInput);

  // Validate on blur
  ageFromInput.addEventListener("blur", function () {
    const value = this.value;
    if (value && !validateAge(value)) {
      showAgeError("Age must be between 0 and 100");
      return;
    }

    if (value && ageToInput.value && !validateAgeRange()) {
      showAgeError("Starting age must be less than or equal to ending age");
      return;
    }

    removeAgeError();
  });

  ageToInput.addEventListener("blur", function () {
    const value = this.value;
    if (value && !validateAge(value)) {
      showAgeError("Age must be between 0 and 100");
      return;
    }

    if (value && ageFromInput.value && !validateAgeRange()) {
      showAgeError("Starting age must be less than or equal to ending age");
      return;
    }

    removeAgeError();
  });

  // Real-time validation for range
  function handleRangeValidation() {
    if (ageFromInput.value && ageToInput.value) {
      if (!validateAgeRange()) {
        showAgeError("Starting age must be less than or equal to ending age");
      } else {
        removeAgeError();
      }
    }
  }

  ageFromInput.addEventListener("input", handleRangeValidation);
  ageToInput.addEventListener("input", handleRangeValidation);
}

// Initialize Gender Filter
function initializeGenderFilter() {
  const genderSelect = document.getElementById("genderFilter");

  // Add change event listener for any additional logic
  genderSelect.addEventListener("change", function () {
    console.log("Gender filter changed to:", this.value);
    // Add any additional logic here if needed
  });
}

// Enhanced filter application with validation
function applyFiltersWithValidation() {
  const hasAgeError = !document
    .getElementById("ageError")
    .classList.contains("hidden");
  if (hasAgeError) {
    alert("Please fix the validation errors before applying filters.");
    return;
  }

  applyFilters();
}

// Initialize all filters when DOM is loaded
document.addEventListener("DOMContentLoaded", function () {
  initializeLocationFilter();
  initializeAgeFilter();
  initializeGenderFilter();
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

function showNoData(elId, msg) {
  const host = document.getElementById(elId);
  host.innerHTML = `
    <div class="no-data-message">
      <svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" fill="#0437F2" viewBox="0 0 24 24">
        <path d="M12 2C6.486 2 2 6.49 2 12c0 5.51 4.486 10 10 10
                 s10-4.49 10-10C22 6.49 17.514 2 12 2zm0 15h-1v-6h2v6h-1zm0-8
                 c-.552 0-1-.447-1-1s.448-1 1-1c.553 0 1 .447 1 1s-.447 1-1 1z"/>
      </svg>
      <p>${msg || "No data available."}</p>
    </div>`;
}

async function loadHourlyChart(filters = currentFilters) {
  try {
    // Build querystring
    const params = new URLSearchParams();
    if (filters.location) params.set("location", filters.location);
    if (filters.gender) params.set("gender", filters.gender);
    if (filters.dayOfWeek?.length)
      params.set("day_of_week", filters.dayOfWeek.join(","));
    if (filters.alcohol?.length)
      params.set("alcohol", filters.alcohol.join(","));
    if (Number.isFinite(filters.hourFrom))
      params.set("hour_from", String(filters.hourFrom));
    if (Number.isFinite(filters.hourTo))
      params.set("hour_to", String(filters.hourTo));
    if (Number.isFinite(filters.ageFrom))
      params.set("age_from", String(filters.ageFrom));
    if (Number.isFinite(filters.ageTo))
      params.set("age_to", String(filters.ageTo));

    const res = await fetch(`/api/accidents_by_hour?${params.toString()}`);
    const j = await res.json();
    if (!j.success || !j.data) {
      showNoData("hourlyBar", j.message || "No data available.");
      return;
    }

    const { hours, counts, title_suffix } = j.data;

    // Title
    const titleEl = document.getElementById("hourlyTitle");
    if (titleEl) {
      titleEl.textContent = `Accidents by Hour of Day${title_suffix || ""}`;
    }

    // 👇 NEW: if nothing to show, render empty-state instead of a chart
    const hasData = Array.isArray(counts) && counts.some((v) => Number(v) > 0);
    if (!hours?.length || !hasData) {
      showNoData("hourlyBar", "No accidents found for the selected filters.");
      if (titleEl) titleEl.textContent += " — No Data";
      return;
    }

    // ...existing Plotly.newPlot code...
    const trace = {
      x: hours.map((h) => h.toString().padStart(2, "0")),
      y: counts,
      type: "bar",
      marker: { color: "#1f77b4" },
      text: counts.map(String),
      textposition: "outside",
      hovertemplate: "Hour=%{x}<br>Accidents=%{y}<extra></extra>",
    };

    const ymax = Math.max(...counts);
    const layout = {
      margin: { l: 60, r: 10, t: 10, b: 40 },
      xaxis: { title: "Hour of Day (0–23)" },
      yaxis: {
        title: { text: "Count of Accidents", standoff: 40 },
        gridcolor: "rgba(0,0,0,0.1)",
        rangemode: "tozero",
        range: [0, Math.max(1, ymax)], // avoids weird negative ticks
      },
    };

    Plotly.newPlot("hourlyBar", [trace], layout, {
      displayModeBar: false,
      responsive: true,
    });
  } catch (e) {
    console.error(e);
    showNoData("hourlyBar", "Error loading chart");
  }
}

// Initial load without constraints
document.addEventListener("DOMContentLoaded", () => {
  initializeLocationFilter();
  initializeGenderFilter();
  initializeHourRange();
  initializeAgeRange();

  // Set initial cards (optional)
  updateGraphCards({ location: "", gender: "", ageFrom: "", ageTo: "" });

  // First paint
  loadHourlyChart();
});

// Load on page ready
document.addEventListener("DOMContentLoaded", loadHourlyChart);

async function loadDayOfWeekChart(filters = currentFilters) {
  try {
    // Build querystring from current filters (same pattern as loadHourlyChart)
    const params = new URLSearchParams();
    if (filters.location) params.set("location", filters.location);
    if (filters.gender) params.set("gender", filters.gender);
    if (filters.dayOfWeek?.length)
      params.set("day_of_week", filters.dayOfWeek.join(","));
    if (filters.alcohol?.length)
      params.set("alcohol", filters.alcohol.join(","));
    if (Number.isFinite(filters.hourFrom))
      params.set("hour_from", String(filters.hourFrom));
    if (Number.isFinite(filters.hourTo))
      params.set("hour_to", String(filters.hourTo));
    if (Number.isFinite(filters.ageFrom))
      params.set("age_from", String(filters.ageFrom));
    if (Number.isFinite(filters.ageTo))
      params.set("age_to", String(filters.ageTo));

    const res = await fetch(`/api/accidents_by_day?${params.toString()}`);
    const j = await res.json();
    if (!j.success || !j.data) {
      showNoData("dayOfWeekCombo", j.message || "No data available.");
      return;
    }

    const { days, counts, avg_victims } = j.data;

    // If nothing to show, render graceful empty-state
    const hasCounts =
      Array.isArray(counts) && counts.some((v) => Number(v) > 0);
    const hasAvg =
      Array.isArray(avg_victims) &&
      avg_victims.some((v) => v != null && Number(v) > 0);

    if (!days?.length || (!hasCounts && !hasAvg)) {
      showNoData(
        "dayOfWeekCombo",
        "No accidents found for the selected filters."
      );
      return;
    }

    // Bar: total accidents per weekday
    const traceBar = {
      x: days,
      y: counts,
      type: "bar",
      name: "Accidents",
      marker: { color: "#1f77b4" }, // match your blue palette
      text: counts.map((v) => (Number.isFinite(v) ? String(v) : "")),
      textposition: "outside",
      hovertemplate: "Day=%{x}<br>Accidents=%{y}<extra></extra>",
      yaxis: "y1",
    };

    // Line: avg victims per accident (nullable values allowed)
    const traceLine = {
      x: days,
      y: avg_victims,
      type: "scatter",
      mode: "lines+markers",
      name: "Avg Victims/Accident",
      line: { width: 3 },
      marker: { size: 7 },
      hovertemplate: "Day=%{x}<br>Avg Victims=%{y:.2f}<extra></extra>",
      yaxis: "y2",
    };

    const layout = {
      barmode: "group",
      margin: { l: 60, r: 60, t: 10, b: 40 },
      xaxis: { title: "" },
      yaxis: {
        title: { text: "Count of Accidents", standoff: 40 },
        gridcolor: "rgba(0,0,0,0.1)",
        rangemode: "tozero",
      },
      yaxis2: {
        title: "Avg Victims per Accident",
        overlaying: "y",
        side: "right",
        rangemode: "tozero",
      },
      legend: { orientation: "h", x: 0, y: 1.15 },
      height: 420,
    };

    Plotly.newPlot("dayOfWeekCombo", [traceBar, traceLine], layout, {
      displayModeBar: false,
      responsive: true,
    });
  } catch (e) {
    console.error(e);
    showNoData("dayOfWeekCombo", "Error loading chart");
  }
}

document.addEventListener("DOMContentLoaded", loadDayOfWeekChart);

async function loadTopBarangaysChart(filters = currentFilters) {
  try {
    const params = new URLSearchParams();
    if (filters.location) params.set("location", filters.location);
    if (filters.gender) params.set("gender", filters.gender);
    if (filters.dayOfWeek?.length)
      params.set("day_of_week", filters.dayOfWeek.join(","));
    if (filters.alcohol?.length)
      params.set("alcohol", filters.alcohol.join(","));
    if (Number.isFinite(filters.hourFrom))
      params.set("hour_from", String(filters.hourFrom));
    if (Number.isFinite(filters.hourTo))
      params.set("hour_to", String(filters.hourTo));
    if (Number.isFinite(filters.ageFrom))
      params.set("age_from", String(filters.ageFrom));
    if (Number.isFinite(filters.ageTo))
      params.set("age_to", String(filters.ageTo));

    const res = await fetch(`/api/top_barangays?${params.toString()}`);
    const j = await res.json();
    if (
      !j.success ||
      !j.data ||
      !Array.isArray(j.data.names) ||
      j.data.names.length === 0
    ) {
      showNoData("topBarangays", j.message || "No data available.");
      return;
    }

    let { names, counts, title_suffix } = j.data;

    // Highest on top in a horizontal bar
    names = names.slice().reverse();
    counts = counts.slice().reverse();

    const trace = {
      x: counts,
      y: names,
      type: "bar",
      orientation: "h",
      marker: { color: "#1f77b4" },
      text: counts.map(String),
      textposition: "outside",
      hovertemplate: "%{y}<br>Accidents=%{x}<extra></extra>",
    };

    const layout = {
      margin: { l: 140, r: 30, t: 10, b: 40 },
      xaxis: {
        title: { text: "Count of Accidents", standoff: 20 },
        rangemode: "tozero",
        gridcolor: "rgba(0,0,0,0.1)",
      },
      yaxis: { automargin: true },
      height: 420,
      showlegend: false,
    };

    Plotly.newPlot("topBarangays", [trace], layout, {
      displayModeBar: false,
      responsive: true,
    });
  } catch (e) {
    console.error(e);
    showNoData("topBarangays", "Error loading chart");
  }
}

// add to your existing on-load hooks
document.addEventListener("DOMContentLoaded", () => {
  // ...your other loaders
  loadTopBarangaysChart();
});

// replace the old function
async function loadAlcoholByHourChart(filters = currentFilters) {
  try {
    const params = new URLSearchParams();
    if (filters.location) params.set("location", filters.location);
    if (filters.gender) params.set("gender", filters.gender);
    if (filters.dayOfWeek?.length)
      params.set("day_of_week", filters.dayOfWeek.join(","));
    if (filters.alcohol?.length)
      params.set("alcohol", filters.alcohol.join(","));
    if (Number.isFinite(filters.hourFrom))
      params.set("hour_from", String(filters.hourFrom));
    if (Number.isFinite(filters.hourTo))
      params.set("hour_to", String(filters.hourTo));
    if (Number.isFinite(filters.ageFrom))
      params.set("age_from", String(filters.ageFrom));
    if (Number.isFinite(filters.ageTo))
      params.set("age_to", String(filters.ageTo));

    const res = await fetch(`/api/alcohol_by_hour?${params.toString()}`);
    const j = await res.json();
    if (!j.success || !j.data) {
      showNoData("alcoholByHour", j.message || "No data available.");
      return;
    }

    const { hours, yes_pct, no_pct, unknown_pct } = j.data;
    if (!hours?.length) {
      showNoData("alcoholByHour", "No data available.");
      return;
    }

    const x = hours.map((h) => h.toString().padStart(2, "0"));

    const traceYes = {
      x,
      y: yes_pct,
      type: "bar",
      name: "Yes",
      marker: { color: "#ff7f0e" },
      hovertemplate: "Hour=%{x}<br>Yes=%{y:.2f}%<extra></extra>",
    };
    const traceNo = {
      x,
      y: no_pct,
      type: "bar",
      name: "No",
      marker: { color: "#1f77b4" },
      hovertemplate: "Hour=%{x}<br>No=%{y:.2f}%<extra></extra>",
    };
    const traceUnknown = {
      x,
      y: unknown_pct,
      type: "bar",
      name: "Unknown",
      marker: { color: "#00008b" },
      hovertemplate: "Hour=%{x}<br>Unknown=%{y:.2f}%<extra></extra>",
    };

    const layout = {
      barmode: "stack",
      barnorm: "percent",
      margin: { l: 60, r: 10, t: 10, b: 40 },
      xaxis: { title: "Hour of Day (0–23)" },
      yaxis: {
        title: { text: "Percentage of Accidents (%)", standoff: 40 },
        ticksuffix: "%",
        range: [0, 100],
        gridcolor: "rgba(0,0,0,0.1)",
      },
      legend: { orientation: "h", x: 0, y: 1.15 },
      height: 420,
    };

    Plotly.newPlot("alcoholByHour", [traceYes, traceNo, traceUnknown], layout, {
      displayModeBar: false,
      responsive: true,
    });
  } catch (e) {
    console.error(e);
    showNoData("alcoholByHour", "Error loading chart");
  }
}

// Add to your on-load hooks
document.addEventListener("DOMContentLoaded", () => {
  // ...existing initializers and chart loaders...
  loadAlcoholByHourChart();
});

async function loadVictimsByAgeChart(filters = currentFilters) {
  try {
    const params = new URLSearchParams();
    if (filters.location) params.set("location", filters.location);
    if (filters.gender) params.set("gender", filters.gender);
    if (filters.dayOfWeek?.length)
      params.set("day_of_week", filters.dayOfWeek.join(","));
    if (filters.alcohol?.length)
      params.set("alcohol", filters.alcohol.join(","));
    if (Number.isFinite(filters.hourFrom))
      params.set("hour_from", String(filters.hourFrom));
    if (Number.isFinite(filters.hourTo))
      params.set("hour_to", String(filters.hourTo));
    if (Number.isFinite(filters.ageFrom))
      params.set("age_from", String(filters.ageFrom));
    if (Number.isFinite(filters.ageTo))
      params.set("age_to", String(filters.ageTo));

    const res = await fetch(`/api/victims_by_age?${params.toString()}`);
    const j = await res.json();

    if (!j.success || !j.data || !j.data.labels?.length) {
      showNoData("victimsByAge", j.message || "No data available.");
      return;
    }

    const { labels, values } = j.data;

    const trace = {
      x: labels,
      y: values,
      type: "bar",
      name: "Total Victims",
      marker: { color: "#1f77b4" },
      hovertemplate: "Age Group=%{x}<br>Total=%{y:,}<extra></extra>",
      text: values.map((v) => (Number.isFinite(v) ? v.toString() : "")),
      textposition: "outside",
    };

    const layout = {
      margin: { l: 60, r: 10, t: 10, b: 60 },
      xaxis: { title: "Age / Age Group", automargin: true },
      yaxis: {
        title: { text: "Total Victims", standoff: 40 },
        gridcolor: "rgba(0,0,0,0.1)",
        rangemode: "tozero",
      },
      height: 420,
      showlegend: false,
    };

    Plotly.newPlot("victimsByAge", [trace], layout, {
      displayModeBar: false,
      responsive: true,
    });
  } catch (e) {
    console.error(e);
    showNoData("victimsByAge", "Error loading chart");
  }
}

// hook it up with others
document.addEventListener("DOMContentLoaded", () => {
  // ...your other initializers...
  loadVictimsByAgeChart();
});

async function loadGenderChart(filters = currentFilters) {
  try {
    const params = new URLSearchParams();
    if (filters.location) params.set("location", filters.location);
    if (filters.gender) params.set("gender", filters.gender);
    if (filters.dayOfWeek?.length)
      params.set("day_of_week", filters.dayOfWeek.join(","));
    if (filters.alcohol?.length)
      params.set("alcohol", filters.alcohol.join(","));
    if (Number.isFinite(filters.hourFrom))
      params.set("hour_from", String(filters.hourFrom));
    if (Number.isFinite(filters.hourTo))
      params.set("hour_to", String(filters.hourTo));
    if (Number.isFinite(filters.ageFrom))
      params.set("age_from", String(filters.ageFrom));
    if (Number.isFinite(filters.ageTo))
      params.set("age_to", String(filters.ageTo));

    const res = await fetch(`/api/gender_proportion?${params.toString()}`);
    const j = await res.json();
    if (!j.success || !j.data || !j.data.labels?.length) {
      showNoData("genderPie", j.message || "No data available.");
      return;
    }

    const { labels, values } = j.data;

    const trace = {
      type: "pie",
      labels,
      values,
      hole: 0.45,
      textinfo: "label+percent",
      hovertemplate: "%{label}: %{value:,} victims (%{percent})<extra></extra>",
      marker: {
        colors: ["#1f77b4", "#4da3ff", "#8fbaf2"],
      },
    };

    const layout = {
      margin: { l: 10, r: 10, t: 10, b: 10 },
      showlegend: true,
      legend: { orientation: "h", x: 0, y: 1.1 },
      height: 420,
    };

    Plotly.newPlot("genderPie", [trace], layout, {
      displayModeBar: false,
      responsive: true,
    });
  } catch (e) {
    console.error(e);
    showNoData("genderPie", "Error loading chart");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  // ...existing initializers and chart loaders...
  loadGenderChart();
});

async function loadKpiCards(filters = currentFilters) {
  try {
    const params = new URLSearchParams();
    if (filters.location) params.set("location", filters.location);
    if (filters.gender) params.set("gender", filters.gender);
    if (filters.dayOfWeek?.length)
      params.set("day_of_week", filters.dayOfWeek.join(","));
    if (filters.alcohol?.length)
      params.set("alcohol", filters.alcohol.join(","));
    if (Number.isFinite(filters.hourFrom))
      params.set("hour_from", String(filters.hourFrom));
    if (Number.isFinite(filters.hourTo))
      params.set("hour_to", String(filters.hourTo));
    if (Number.isFinite(filters.ageFrom))
      params.set("age_from", String(filters.ageFrom));
    if (Number.isFinite(filters.ageTo))
      params.set("age_to", String(filters.ageTo));

    const res = await fetch(`/api/kpis?${params.toString()}`);
    const j = await res.json();

    // Fallback to em dashes if no data
    const accEl = document.getElementById("kpiAccidents");
    const vicEl = document.getElementById("kpiVictims");
    const avgEl = document.getElementById("kpiAvgVictims");
    const alcEl = document.getElementById("kpiAlcoholPct");

    if (!j.success || !j.data) {
      accEl.textContent = "—";
      vicEl.textContent = "—";
      avgEl.textContent = "—";
      alcEl.textContent = "—";
      return;
    }

    const {
      total_accidents,
      total_victims,
      avg_victims_per_accident,
      alcohol_involvement_rate, // 0..1 if present
    } = j.data;

    accEl.textContent = Number.isFinite(total_accidents)
      ? total_accidents.toLocaleString()
      : "—";

    vicEl.textContent = Number.isFinite(total_victims)
      ? total_victims.toLocaleString()
      : "—";

    // Show to 2 dp like a card metric
    avgEl.textContent =
      total_accidents > 0 && Number.isFinite(avg_victims_per_accident)
        ? avg_victims_per_accident.toFixed(2)
        : "—";

    // Show as percent (including Unknown in denominator, per Power BI card behavior)
    alcEl.textContent =
      Number.isFinite(alcohol_involvement_rate) && total_accidents > 0
        ? (alcohol_involvement_rate * 100).toFixed(2) + "%"
        : "—";
  } catch (e) {
    console.error(e);
    // Soft-fail
    document.getElementById("kpiAccidents").textContent = "—";
    document.getElementById("kpiVictims").textContent = "—";
    document.getElementById("kpiAvgVictims").textContent = "—";
    document.getElementById("kpiAlcoholPct").textContent = "—";
  }
}

document.addEventListener("DOMContentLoaded", () => {
  // ... your initializers ...
  loadKpiCards(); // initial load (no constraints)
});

// Clear all filters and reset UI
function clearFilters() {
  // Reset text inputs/selects
  document.getElementById("locationFilter").value = "";
  document.getElementById("genderFilter").value = "";

  // Reset checkboxes
  document
    .querySelectorAll("#dowGroup input[type='checkbox']")
    .forEach((cb) => (cb.checked = false));
  document
    .querySelectorAll("#alcoholGroup input[type='checkbox']")
    .forEach((cb) => (cb.checked = false));

  // Reset hour range
  document.getElementById("hourFrom").value = 0;
  document.getElementById("hourTo").value = 23;
  document.getElementById("hourFromBox").value = 0;
  document.getElementById("hourToBox").value = 23;

  // Reset age range
  document.getElementById("ageFrom").value = 0;
  document.getElementById("ageTo").value = 100;
  document.getElementById("ageFromBox").value = 0;
  document.getElementById("ageToBox").value = 100;

  // Update global filter state
  currentFilters = {
    location: "",
    gender: "",
    dayOfWeek: [],
    alcohol: [],
    hourFrom: 0,
    hourTo: 23,
    ageFrom: 0,
    ageTo: 100,
  };

  // Reset info cards
  updateGraphCards({ location: "", gender: "", ageFrom: "", ageTo: "" });

  // Reload charts with cleared filters
  loadHourlyChart(currentFilters);
  loadDayOfWeekChart(currentFilters);
  loadTopBarangaysChart(currentFilters);
  loadAlcoholByHourChart(currentFilters);
  loadVictimsByAgeChart(currentFilters);
  loadGenderChart(currentFilters);
  if (typeof loadKpiCards === "function") loadKpiCards(currentFilters);

  // Close modal
  closeFilterModal();
}

// Attach the clear button
document.addEventListener("DOMContentLoaded", () => {
  const clearBtn = document.querySelector(".filter-clear-btn");
  if (clearBtn) {
    clearBtn.addEventListener("click", clearFilters);
  }
});
