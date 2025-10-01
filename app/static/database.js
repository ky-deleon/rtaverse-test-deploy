let dataTable = null;

// Global flag: friendly (true) vs raw (false)
let FRIENDLY_VIEW = true;

// Check if table exists and add Actions column if missing
if ($("#uploadedTable").length > 0) {
  let hasActionsHeader =
    $("#uploadedTable thead th").filter(function () {
      return $(this).text().trim().toLowerCase() === "actions";
    }).length > 0;

  if (!hasActionsHeader) {
    // Add Actions header
    $("#uploadedTable thead tr").append("<th>Actions</th>");

    // Add empty Actions cell for each row
    $("#uploadedTable tbody tr").each(function () {
      $(this).append("<td></td>");
    });
  }
}

const DISPLAY_RENDER_MAP = {
  // One-hot → labels
  GENDER_Male: (v) => (v === "1" || v === 1 ? "Male" : ""),
  GENDER_Unknown: (v) => (v === "1" || v === 1 ? "Unknown" : ""),

  ALCOHOL_USED_Yes: (v) => (v === "1" || v === 1 ? "Yes" : ""),
  ALCOHOL_USED_Unknown: (v) => (v === "1" || v === 1 ? "Unknown" : ""),

  TIME_CLUSTER_Morning: (v) => (v === "1" || v === 1 ? "Morning" : ""),
  TIME_CLUSTER_Midday: (v) => (v === "1" || v === 1 ? "Midday" : ""),
  TIME_CLUSTER_Midnight: (v) => (v === "1" || v === 1 ? "Midnight" : ""),
  // If you also have Evening later: "TIME_CLUSTER_Evening": (v)=> v==="1"||v===1? "Evening":"",

  // Hour → “HH:00” (display-only)
  HOUR_COMMITTED: (v) => {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0 && n <= 23) {
      return String(n).padStart(2, "0") + ":00";
    }
    return v ?? "";
  },

  // ACCIDENT_HOTSPOT (DBSCAN cluster) → readable (just an example)
  // -1 is “noise” in DBSCAN; everything else is a cluster id.
  ACCIDENT_HOTSPOT: (v) => {
    if (v === null || v === undefined || v === "") return "";
    const n = Number(v);
    if (Number.isNaN(n)) return String(v);
    return n === -1 ? "No cluster" : `Hotspot #${n}`;
  },

  // OFFENSE bucketed categories → nicer spacing
  OFFENSE: (v) => {
    if (!v) return "";
    // Map exact strings if needed
    const map = {
      Property_and_Person: "Property + Person",
      Person_Injury_Only: "Person Injury Only",
      Property_Damage_Only: "Property Damage Only",
      Other: "Other",
    };
    return map[v] || v;
  },

  // Example: AGE / VICTIM COUNT → show raw (but still allow formatting)
  AGE: (v) => v,
  "VICTIM COUNT": (v) => v,

  // If you want to hide the raw sin/cos by default, you can show a badge or blank:
  // Comment these out if you prefer to show the raw numbers.
  MONTH_SIN: (v) => v, // or: ()=>"—"
  MONTH_COS: (v) => v,
  DAYOWEEK_SIN: (v) => v,
  DAYOWEEK_COS: (v) => v,
};

// Utility: find column index by visible header text
function getColumnIndexByName(colName) {
  return $("#uploadedTable thead th")
    .toArray()
    .findIndex((th) => $(th).text().trim() === colName);
}

// Build columnDefs renderers from DISPLAY_RENDER_MAP dynamically
function buildDisplayRenderers() {
  const defs = [];
  Object.keys(DISPLAY_RENDER_MAP).forEach((colName) => {
    const idx = getColumnIndexByName(colName);
    if (idx > -1) {
      defs.push({
        targets: idx,
        render: function (data, type, row, meta) {
          // Only transform for display/filter; keep raw for sort/type = 'sort'/'type'
          if (!FRIENDLY_VIEW) return data; // raw mode
          if (type === "display" || type === "filter") {
            try {
              return DISPLAY_RENDER_MAP[colName](data);
            } catch {
              return data ?? "";
            }
          }
          return data;
        },
      });
    }
  });
  return defs;
}

if ($("#uploadedTable thead th:first").text().trim() !== "Select") {
  $("#uploadedTable thead tr").prepend(
    '<th><input type="checkbox" id="select-all"></th>'
  );
  $("#uploadedTable tbody tr").each(function () {
    $(this).prepend("<td></td>"); // placeholder for DataTables render
  });
}

// Select/Deselect all rows
$(document).on("change", "#select-all", function () {
  $(".row-select").prop("checked", this.checked);
});

$(document).ready(function () {
  console.log("Document ready, looking for table...");

  // Check if the uploaded table exists
  if ($("#uploadedTable").length > 0) {
    console.log("Table found, initializing DataTable...");

    // Initialize DataTable without default pagination
    dataTable = $("#uploadedTable").DataTable({
      paging: false,
      lengthChange: false,
      ordering: true,
      searching: true,
      dom: "rtip",
      language: {
        emptyTable: "No data uploaded yet.",
        zeroRecords: "No matching records found.",
        info: "Showing _TOTAL_ entries",
        infoEmpty: "No entries",
        infoFiltered: "(filtered from _MAX_ total entries)",
      },
      columnDefs: [
        {
          targets: 0,
          orderable: false,
          className: "select-checkbox",
          render: function () {
            return '<input type="checkbox" class="row-select">';
          },
        },
        {
          targets: -1,
          data: null,
          defaultContent: `<button class="delete-btn">Delete</button>`,
        },
      ],
      order: [], // we'll set it dynamically in initComplete
      initComplete: function () {
        const api = this.api();
        // Move info text to custom container
        let info = $(this.api().table().container()).find(".dataTables_info");
        if ($("#customInfo").length === 0) {
          $(
            '<div id="customInfo" class="dataTables_info_container" style="margin-top:10px;"></div>'
          ).insertAfter(".table-container");
        }
        $("#customInfo").append(info);

        // Then force order by the DATE_COMMITTED column if present:
        const dateIdx = getDateColumnIndex(api); // you already have this helper
        if (dateIdx !== -1) {
          api.order([dateIdx, "asc"]).draw();
        }

        // Create year buttons after info text
        createYearButtons(this.api());
        filterEarliestOnLoad(this.api());
      },
    });

    // Add Edit and Save buttons outside table
    if ($("#editTableBtn").length === 0) {
      $(".main-content").append(`
        <div style="text-align: right; margin-top: 15px;">
            <button id="editTableBtn" class="edit-table-btn">Edit Table</button>
            <button id="saveTableBtn" class="save-btn" style="display:none;">Save Table</button>
        </div>
    `);
    }

    // Enable editing mode
    let isEditing = false;
    let undoStack = [];
    let redoStack = [];
    let hasUnsavedChanges = false;
    let originalDataCopy = [];

    function recordEdit(rowIdx, colIdx, oldValue, newValue) {
      undoStack.push({ rowIdx, colIdx, oldValue, newValue });
      redoStack = [];
      hasUnsavedChanges = true;
    }

    // --- UNDO / REDO implementation (paste inside $(document).ready, after recordEdit) ---
    function updateUndoRedoButtons() {
      $("#undoBtn").prop("disabled", undoStack.length === 0);
      $("#redoBtn").prop("disabled", redoStack.length === 0);
    }

    // apply an edit object to the table (use oldValue when isUndo true, otherwise newValue)
    function applyEdit(edit, isUndo) {
      try {
        let valueToApply = isUndo ? edit.oldValue : edit.newValue;
        // Ensure the cell still exists
        if (typeof dataTable.cell === "function") {
          dataTable
            .cell(edit.rowIdx, edit.colIdx)
            .data(valueToApply)
            .draw(false);
        }
      } catch (err) {
        console.warn("applyEdit failed (row may have changed):", err);
      }
    }

    // Undo
    $("#undoBtn").on("click", function () {
      if (undoStack.length === 0) return;
      let edit = undoStack.pop();
      applyEdit(edit, true); // apply oldValue
      redoStack.push(edit); // allow redo to re-apply newValue
      hasUnsavedChanges = true;
      updateUndoRedoButtons();
    });

    // Redo
    $("#redoBtn").on("click", function () {
      if (redoStack.length === 0) return;
      let edit = redoStack.pop();
      applyEdit(edit, false); // apply newValue
      undoStack.push(edit); // re-add to undo stack
      hasUnsavedChanges = true;
      updateUndoRedoButtons();
    });

    // Keyboard shortcuts: Ctrl+Z / Ctrl+Y (Cmd on Mac via metaKey)
    $(document).on("keydown", function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        $("#undoBtn").click();
      }
      if (
        (e.ctrlKey || e.metaKey) &&
        (e.key.toLowerCase() === "y" ||
          (e.shiftKey && e.key.toLowerCase() === "z"))
      ) {
        e.preventDefault();
        $("#redoBtn").click();
      }
    });

    // When we record a new edit, enable/disable buttons
    // (make sure your existing recordEdit still pushes to undoStack and clears redoStack)
    let originalRecordEdit = recordEdit;
    recordEdit = function (rowIdx, colIdx, oldValue, newValue) {
      originalRecordEdit(rowIdx, colIdx, oldValue, newValue);
      updateUndoRedoButtons();
    };

    $("#saveTableBtn").on("click", function () {
      console.log("=== SAVE BUTTON CLICKED ===");

      if (!dataTable) {
        alert("DataTable not initialized");
        return;
      }

      console.log("=== GETTING ALL DATA (INCLUDING HIDDEN/FILTERED ROWS) ===");

      let allData = [];
      let method = "";

      // Method 1: Clear any search/filter temporarily to get all rows
      try {
        // Store current search term
        let currentSearch = dataTable.search();

        // Temporarily clear search to reveal all rows
        dataTable.search("").draw();

        // Now get all visible rows from HTML
        $("#uploadedTable tbody tr").each(function (index) {
          let rowData = [];
          $(this)
            .find("td")
            .each(function () {
              let cellText = $(this).text().trim();
              rowData.push(cellText);
            });
          if (rowData.length > 0) {
            allData.push(rowData);
          }
        });

        // Restore the original search
        dataTable.search(currentSearch).draw();

        method = "Temporary search clear + HTML parsing";
        console.log("Method 1 - All rows extracted:", allData.length);
      } catch (e) {
        console.log("Method 1 failed:", e);
      }

      // Method 2: Try DataTables API with { search: 'removed' }
      if (allData.length === 0) {
        try {
          let dtData = dataTable.rows({ search: "removed" }).data().toArray();
          if (
            dtData &&
            dtData.length > 0 &&
            !dtData.every((row) => row === null)
          ) {
            allData = dtData;
            method = "DataTables API with search removed";
            console.log("Method 2 - DataTables API:", allData.length);
          }
        } catch (e) {
          console.log("Method 2 failed:", e);
        }
      }

      // Method 3: Access internal DataTables data storage
      if (allData.length === 0) {
        try {
          // Try to access the internal data array
          let internalData = dataTable
            .rows({ order: "current", search: "removed" })
            .data()
            .toArray();
          if (internalData && internalData.length > 0) {
            allData = internalData;
            method = "Internal DataTables storage";
            console.log("Method 3 - Internal storage:", allData.length);
          }
        } catch (e) {
          console.log("Method 3 failed:", e);
        }
      }

      // Method 4: Try jQuery DataTables fnGetData (legacy method)
      if (allData.length === 0) {
        try {
          if (typeof dataTable.fnGetData === "function") {
            let legacyData = dataTable.fnGetData();
            if (legacyData && legacyData.length > 0) {
              allData = legacyData;
              method = "Legacy fnGetData";
              console.log("Method 4 - Legacy method:", allData.length);
            }
          }
        } catch (e) {
          console.log("Method 4 failed:", e);
        }
      }

      // Method 5: Force show all rows by destroying and rebuilding filter
      if (allData.length === 0) {
        try {
          // Store current settings
          let currentSearch = dataTable.search();

          // Destroy current DataTable but keep the HTML
          dataTable.destroy(false);

          // Get all rows from raw HTML
          $("#uploadedTable tbody tr").each(function (index) {
            let rowData = [];
            $(this)
              .find("td")
              .each(function () {
                let cellText = $(this).text().trim();
                rowData.push(cellText);
              });
            if (rowData.length > 0) {
              allData.push(rowData);
            }
          });

          // Reinitialize DataTable
          dataTable = $("#uploadedTable").DataTable({
            paging: false,
            lengthChange: false,
            ordering: true,
            searching: true,
            dom: "rtip",
            language: {
              emptyTable: "No data uploaded yet.",
              zeroRecords: "No matching records found.",
              info: "Showing _TOTAL_ entries",
              infoEmpty: "No entries",
              infoFiltered: "(filtered from _MAX_ total entries)",
            },
            columnDefs: [
              {
                targets: 0,
                orderable: false,
                className: "select-checkbox",
                render: function () {
                  return '<input type="checkbox" class="row-select">';
                },
              },
              {
                targets: -1,
                data: null,
                defaultContent: `<button class="delete-btn">Delete</button>`,
              },
            ],
            order: [[1, "asc"]],
          });

          // Restore search
          if (currentSearch) {
            dataTable.search(currentSearch).draw();
          }

          method = "DataTable destroy/rebuild + HTML parsing";
          console.log("Method 5 - Destroy/rebuild:", allData.length);
        } catch (e) {
          console.log("Method 5 failed:", e);
        }
      }

      console.log("=== FINAL DATA EXTRACTION ===");
      console.log("Method used:", method);
      console.log("All data (first 2 rows):", allData.slice(0, 2));
      console.log("Total rows found:", allData.length);

      // Get headers
      let filteredHeaders = [];
      $("#uploadedTable thead th").each(function (index) {
        let headerText = $(this).text().trim();
        // Skip first (Select) and last (Actions) columns
        if (index !== 0 && index !== $("#uploadedTable thead th").length - 1) {
          if (headerText !== "Select" && headerText !== "Actions") {
            filteredHeaders.push(headerText);
          }
        }
      });

      // Process data - remove first (checkbox) and last (actions) columns
      let finalData = allData.map((row) => {
        if (Array.isArray(row)) {
          return row.slice(1, -1); // Remove first and last columns
        } else {
          // Handle object format
          let rowArray = [];
          filteredHeaders.forEach((header) => {
            rowArray.push(row[header] || "");
          });
          return rowArray;
        }
      });

      console.log("=== PROCESSED DATA ===");
      console.log("Headers:", filteredHeaders);
      console.log("Processed data (first 2 rows):", finalData.slice(0, 2));
      console.log("Final data length:", finalData.length);

      // Validation
      if (filteredHeaders.length === 0) {
        alert("No headers found! Check the table structure.");
        return;
      }

      if (finalData.length === 0) {
        alert("No data rows found! Check if the table has data.");
        return;
      }

      // Check data consistency
      if (
        finalData.length > 0 &&
        finalData[0].length !== filteredHeaders.length
      ) {
        console.log(
          `❌ Mismatch: Headers=${filteredHeaders.length}, Data columns=${finalData[0].length}`
        );
        alert(
          `Data mismatch: Found ${filteredHeaders.length} headers but ${finalData[0].length} data columns`
        );
        return;
      }

      console.log(`✅ Validation passed - Saving ${finalData.length} rows`);

      // Update UI
      isEditing = false;
      hasUnsavedChanges = false;
      $("#saveTableBtn, #cancelEditBtn, #undoBtn, #redoBtn").hide();
      $("#editTableBtn, #deleteSelectedBtn, #mergeFileBtn, #uploadForm").show();
      $("#uploadedTable").off("click.editMode");

      // Show loading state
      $("#saveTableBtn").prop("disabled", true).text("Saving...");

      fetch("/api/save_table", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          headers: filteredHeaders,
          data: finalData,
          debug_info: {
            total_rows: finalData.length,
            header_count: filteredHeaders.length,
            extraction_method: method,
            note: `All ${finalData.length} rows included - extracted using ${method}`,
          },
        }),
      })
        .then((response) => {
          console.log("Response status:", response.status);
          if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
          }
          return response.json();
        })
        .then((response) => {
          console.log("Save response:", response);

          if (response.success !== false) {
            alert(
              response.message ||
                `Table saved successfully! ${finalData.length} rows saved.`
            );
            originalDataCopy = JSON.parse(JSON.stringify(finalData));
          } else {
            alert("Error: " + response.message);
          }
        })
        .catch((err) => {
          console.error("Save error:", err);
          alert("Error saving table: " + err.message);
        })
        .finally(() => {
          // Reset UI
          $("#saveTableBtn").prop("disabled", false).text("Save Table").hide();
          $(
            "#editTableBtn, #deleteSelectedBtn, #mergeFileBtn, #uploadForm"
          ).show();
        });

      // Clear undo/redo stacks
      undoStack = [];
      redoStack = [];
      updateUndoRedoButtons();
    }); // This closes the $('#saveTableBtn').on('click', function() {

    $("#cancelEditBtn").on("click", function () {
      // If cancel restores originalDataCopy, also clear stacks
      undoStack = [];
      redoStack = [];
      updateUndoRedoButtons();
    });

    // Initialize button states at load
    updateUndoRedoButtons();

    // Helper: restore table to original data
    function restoreOriginalData() {
      dataTable.clear();
      dataTable.rows.add(originalDataCopy);
      dataTable.draw();
    }

    $("#editTableBtn").on("click", function () {
      isEditing = true;
      hasUnsavedChanges = false;
      undoStack = [];
      redoStack = [];

      // Store a deep copy of the current table data
      originalDataCopy = JSON.parse(
        JSON.stringify(dataTable.rows().data().toArray())
      );

      $("#editTableBtn, #deleteSelectedBtn, #mergeFileBtn, #uploadForm").hide();
      $("#saveTableBtn, #cancelEditBtn, #undoBtn, #redoBtn").show();

      // Enable editing
      $("#uploadedTable").on(
        "click.editMode",
        "td:not(:last-child)",
        function () {
          if (!isEditing) return;

          let cell = dataTable.cell(this);
          let originalValue = cell.data();
          let rowIdx = cell.index().row;
          let colIdx = cell.index().column;

          if ($(this).find("input").length > 0) return;

          let input = $('<input type="text">').val(originalValue);
          $(this).html(input);

          input
            .on("blur keyup", function (e) {
              if (e.type === "blur" || e.keyCode === 13) {
                let newValue = $(this).val();
                if (newValue !== originalValue) {
                  recordEdit(rowIdx, colIdx, originalValue, newValue);
                }
                cell.data(newValue).draw();
              }
            })
            .focus();
        }
      );
    });

    $("#cancelEditBtn").on("click", function () {
      if (hasUnsavedChanges) {
        let confirmExit = confirm(
          "You have unsaved changes. If you cancel, they will be lost. Continue?"
        );
        if (!confirmExit) return;
      }

      // Restore original data so nothing changes
      restoreOriginalData();

      isEditing = false;
      $("#saveTableBtn, #cancelEditBtn, #undoBtn, #redoBtn").hide();
      $("#editTableBtn, #deleteSelectedBtn, #mergeFileBtn, #uploadForm").show();
      $("#uploadedTable").off("click.editMode");

      undoStack = [];
      redoStack = [];
      hasUnsavedChanges = false;
    });

    // Bind custom search input with debouncing
    let searchTimeout;
    $("#customSearch").on("input", function () {
      const searchValue = this.value;
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(function () {
        if (dataTable) {
          dataTable.search(searchValue).draw();
        }
      }, 300);
    });

    // Clear search with ESC key
    $("#customSearch").on("keyup", function (e) {
      if (e.keyCode === 27) {
        // ESC
        this.value = "";
        if (dataTable) {
          dataTable.search("").draw();
        }
      }
    });
  } else {
    console.log('No table found with ID "uploadedTable"');
  }
});

function getDateColumnIndex(api) {
  return api
    .columns()
    .header()
    .toArray()
    .findIndex(
      (header) => $(header).text().trim().toUpperCase() === "DATE_COMMITTED"
    );
}

function createYearButtons(api) {
  let years = [];

  let dateColumnIndex = getDateColumnIndex(api);
  if (dateColumnIndex === -1) {
    console.warn("DATE_COMMITTED column not found!");
    return;
  }

  // Extract unique years
  api
    .column(dateColumnIndex)
    .data()
    .each(function (value) {
      let year = new Date(value).getFullYear();
      if (!isNaN(year) && !years.includes(year)) {
        years.push(year);
      }
    });

  years.sort((a, b) => a - b);

  let container = $(
    '<div class="year-buttons-container" style="display:flex;justify-content:space-between;align-items:center;width:100%;"></div>'
  ).insertAfter(".dataTables_info_container");

  let infoContainer = $("#customInfo").css({ margin: 0 });
  let yearNav = $(
    '<div class="year-buttons" style="display:flex;align-items:center;"></div>'
  );

  let visibleStart = 0;
  const maxVisible = 5;
  let selectedYear = null;

  function renderYears() {
    yearNav.empty();

    $('<button class="year-nav-btn">&lt;</button>')
      .prop("disabled", visibleStart === 0)
      .on("click", function () {
        if (visibleStart > 0) {
          visibleStart -= maxVisible;
          if (visibleStart < 0) visibleStart = 0;
          renderYears();
        }
      })
      .appendTo(yearNav);

    years
      .slice(visibleStart, visibleStart + maxVisible)
      .forEach(function (year) {
        let btn = $('<button class="year-btn">' + year + "</button>")
          .appendTo(yearNav)
          .on("click", function () {
            selectedYear = year;
            api.search(year).draw();
            $(".year-btn").removeClass("active");
            $(this).addClass("active");
            $("#currentYearDisplay").text(year);
          });

        if (selectedYear === year) {
          btn.addClass("active");
        }
      });

    $('<button class="year-nav-btn">&gt;</button>')
      .prop("disabled", visibleStart + maxVisible >= years.length)
      .on("click", function () {
        if (visibleStart + maxVisible < years.length) {
          visibleStart += maxVisible;
          renderYears();
        }
      })
      .appendTo(yearNav);
  }

  container.append(infoContainer).append(yearNav);
  renderYears();
}

function filterEarliestOnLoad(api) {
  let years = [];

  let dateColumnIndex = getDateColumnIndex(api);
  if (dateColumnIndex === -1) {
    console.warn("DATE_COMMITTED column not found!");
    return;
  }

  api
    .column(dateColumnIndex)
    .data()
    .each(function (value) {
      let year = new Date(value).getFullYear();
      if (!isNaN(year)) years.push(year);
    });

  if (years.length > 0) {
    years = [...new Set(years)]; // unique
    let earliestYear = Math.min(...years);
    let targetYear = years.includes(2015) ? 2015 : earliestYear;

    api.search(targetYear).draw();

    $(".year-btn").removeClass("active");
    $(".year-btn")
      .filter(function () {
        return $(this).text() == targetYear;
      })
      .addClass("active");

    $("#currentYearDisplay").text(targetYear);
  }
}

// Function to reinitialize DataTable after new data is uploaded
function reinitializeTable() {
  console.log("Reinitializing table...");

  if (dataTable) {
    dataTable.destroy();
    dataTable = null;
  }

  setTimeout(function () {
    $(document).ready();
  }, 100);
}

// Logout modal functions
function openLogoutModal(event) {
  event.preventDefault();
  document.getElementById("logoutModal").classList.remove("hidden");
}

function closeLogoutModal() {
  document.getElementById("logoutModal").classList.add("hidden");
}

function confirmLogout() {
  window.location.href = "/logout";
}

function checkIfTableEmpty() {
  if (dataTable && dataTable.rows().count() === 0) {
    // Destroy DataTable
    dataTable.destroy();
    dataTable = null;

    // Clear the table container
    $("#tableView").empty();

    // Remove custom info and pagination if any
    $("#customInfo").remove();
    $(".year-buttons-container").remove();

    // Show "no data" state
    $(".file-selection-container").show();
  }
}

function removeTableCompletely() {
  if (dataTable) {
    dataTable.destroy(); // kill DataTable instance
    dataTable = null;
  }

  // Clear the table container
  $("#tableView").empty();

  // Remove info/pagination/year buttons
  $("#customInfo").remove();
  $(".year-buttons-container").remove();

  // Clear year title
  $("#currentYearDisplay").text("");

  // Show the "no data" file selection UI again
  $(".file-selection-container").show();
}

// Single row delete
$("#uploadedTable").on("click", ".delete-btn", function () {
  let row = dataTable.row($(this).parents("tr"));
  if (confirm("Are you sure you want to delete this row?")) {
    row.remove().draw();
    if (dataTable.rows().count() === 0) {
      removeTableCompletely();
    }
  }
});

// Delete selected rows
$("#deleteSelectedBtn").on("click", function () {
  let selectedRows = $(".row-select:checked").closest("tr");
  if (selectedRows.length === 0) {
    alert("No rows selected.");
    return;
  }

  if (
    confirm(`Are you sure you want to delete ${selectedRows.length} row(s)?`)
  ) {
    selectedRows.each(function () {
      dataTable.row($(this)).remove().draw();
    });
    if (dataTable.rows().count() === 0) {
      removeTableCompletely();
    }
  }
});

// Auto open file picker and submit
$("#triggerFileUpload").on("click", function (e) {
  e.preventDefault();
  openUploadModal(); // just open modal
});

$("#hiddenFileInput").on("change", function () {
  if (this.files.length > 0) {
    $(this).closest("form").submit();
  }
});

$("#deleteSelectedBtn").on("click", function () {
  let selectedRows = $(".row-select:checked").closest("tr");

  if (selectedRows.length === 0) {
    alert("No rows selected.");
    return;
  }

  if (
    confirm(
      `Are you sure you want to delete ${selectedRows.length} selected row(s)?`
    )
  ) {
    selectedRows.each(function () {
      dataTable.row($(this)).remove().draw();
    });
  }
});

// Highlight selected rows
$(document).on("change", ".row-select", function () {
  $(this).closest("tr").toggleClass("row-selected", this.checked);
});

// Select/Deselect all rows
$(document).on("change", "#select-all", function () {
  const isChecked = this.checked;
  $(".row-select").prop("checked", isChecked).trigger("change");
});

$("#mergeFileBtn").on("click", function () {
  alert("Merge file feature coming soon!");
});

$("#retrainBtn").on("click", function () {
  if (
    confirm(
      "Are you sure you want to retrain the model with the current uploaded data?"
    )
  ) {
    fetch("/api/retrain_model", { method: "POST" })
      .then((res) => res.json())
      .then((data) => {
        alert(data.message || "Model retraining started successfully!");
      })
      .catch((err) => {
        console.error(err);
        alert("Error retraining model.");
      });
  }
});

function selectFile(tableName) {
  // Hit your Flask endpoint with ?table=...
  window.location.href = `/database?table=${tableName}`;
}

let currentFile = null;

document.addEventListener("contextmenu", function (e) {
  // Check if right click happened on a file card
  let card = e.target.closest(".file-card-big");
  if (card) {
    e.preventDefault(); // Stop default right-click menu

    currentFile = card.querySelector("p").innerText; // store file name

    let menu = document.getElementById("fileContextMenu");
    menu.classList.remove("hidden");

    // Position the menu where the mouse is
    menu.style.top = `${e.pageY}px`;
    menu.style.left = `${e.pageX}px`;
  } else {
    document.getElementById("fileContextMenu").classList.add("hidden");
  }
});

// Hide menu when clicking elsewhere
document.addEventListener("click", function () {
  document.getElementById("fileContextMenu").classList.add("hidden");
});

// Functions for menu options
function editFile() {
  if (currentFile) {
    // ✅ Redirect straight to your Flask endpoint
    window.location.href = `/database?table=${currentFile}`;
  }
}

let fileToDelete = null;

function deleteFile() {
  if (currentFile) {
    fileToDelete = currentFile; // store filename
    document.getElementById(
      "deleteFileMessage"
    ).innerText = `Are you sure you want to delete "${fileToDelete}"?`;
    document.getElementById("deleteFileModal").classList.remove("hidden");
  }
}

// Pick this file (DB table) for the dashboard map forecasting model
async function useForForecast() {
  if (!currentFile) return;

  try {
    const res = await fetch("/api/set_forecast_source", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ table: currentFile }),
    });

    const payload = await res.json();
    if (!res.ok || payload.success === false) {
      throw new Error(payload.message || "Failed to set forecast source.");
    }

    alert(
      `✓ "${currentFile}" will be used by the Dashboard map forecasting model.`
    );
    // Optional: jump straight to the Dashboard so they see it
    if (confirm("Open Dashboard now to view the forecast?")) {
      window.location.href = "/dashboard";
    }
  } catch (err) {
    console.error(err);
    alert("Error: " + err.message);
  } finally {
    document.getElementById("fileContextMenu").classList.add("hidden");
  }
}

function closeDeleteFileModal() {
  document.getElementById("deleteFileModal").classList.add("hidden");
  fileToDelete = null;
}

function confirmDeleteFile() {
  if (!fileToDelete) return;

  fetch("/api/delete_file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ table: fileToDelete }),
  })
    .then((response) => response.json())
    .then((data) => {
      if (data.success) {
        alert(data.message);
        location.reload();
      } else {
        alert("Error: " + data.message);
      }
    })
    .catch((err) => {
      console.error("Delete error:", err);
      alert("Error deleting file.");
    })
    .finally(() => {
      closeDeleteFileModal();
    });
}

function openUploadModal() {
  document.getElementById("uploadModal").classList.remove("hidden");
}

function closeUploadModal() {
  document.getElementById("uploadModal").classList.add("hidden");
}

function triggerHiddenInput(num) {
  document.getElementById(`fileInput${num}`).click();
}

// Show the selected file name without expanding slot size
["fileInput1", "fileInput2"].forEach((id) => {
  const input = document.getElementById(id);
  input.addEventListener("change", function () {
    const slot = this.closest(".upload-slot");
    const plusIcon = slot.querySelector(".plus-icon");
    const placeholder = slot.querySelector(".file-placeholder");
    const fileIcon = slot.querySelector(".file-icon");
    const fileNameEl = slot.querySelector(".file-name");

    if (this.files.length > 0) {
      plusIcon.style.display = "none";
      placeholder.style.display = "none";
      fileIcon.style.display = "block";
      fileNameEl.textContent = this.files[0].name;
      fileNameEl.style.display = "block";
    } else {
      plusIcon.style.display = "block";
      placeholder.style.display = "block";
      fileIcon.style.display = "none";
      fileNameEl.style.display = "none";
    }
  });
});

// Show/hide target selector
document.addEventListener("click", (e) => {
  if (e.target?.id === "appendToggle") {
    const wrap = document.getElementById("appendTargetWrap");
    const fileNameField = document.getElementById("fileNameInput");
    const fileNameLabel = document.querySelector("label[for='fileNameInput']");

    if (wrap) wrap.style.display = e.target.checked ? "block" : "none";

    if (fileNameField && fileNameLabel) {
      if (e.target.checked) {
        fileNameField.style.display = "none";
        fileNameLabel.style.display = "none";
      } else {
        fileNameField.style.display = "block";
        fileNameLabel.style.display = "block";
      }
    }
  }
});

const REQUIRED_FILE1_COLUMNS = [
  "STATION",
  "BARANGAY",
  "DATE COMMITTED",
  "TIME COMMITTED",
  "OFFENSE",
  "LATITUDE",
  "LONGITUDE",
  "VICTIM COUNT",
  "SUSPECT COUNT",
  "VEHICLE KIND",
];

const REQUIRED_FILE2_VARIANTS = [
  [
    "Date Committed",
    "Station",
    "Barangay",
    "Offense",
    "Age",
    "Gender",
    "Alcohol_Used",
  ],
  [
    "DATE COMMITTED",
    "STATION",
    "BARANGAY",
    "OFFENSE",
    "AGE",
    "GENDER",
    "ALCOHOL_USED",
  ],
];

// --- REPLACE the entire submitUpload() in database.js with this ---
async function submitUpload() {
  const fileName = document.getElementById("fileNameInput").value?.trim();
  const file1 = document.getElementById("fileInput1").files[0] || null;
  const file2 = document.getElementById("fileInput2").files[0] || null;

  if (!file1 || !file2) {
    alert("Please choose two files.");
    return;
  }

  // 🚨 Duplicate file check
  if (file1.name === file2.name) {
    alert(
      "Error: You uploaded the same Excel file twice. Please choose different files."
    );
    return;
  }

  try {
    const [cols1, cols2] = await Promise.all([
      getFileHeaders(file1),
      getFileHeaders(file2),
    ]);

    // File1 check
    const missingInFile1 = REQUIRED_FILE1_COLUMNS.filter(
      (col) => !cols1.includes(col)
    );
    if (missingInFile1.length > 0) {
      alert(
        `Error: The first Excel file is missing required columns: ${missingInFile1.join(
          ", "
        )}`
      );
      return;
    }

    // File2 check → must match at least one variant fully
    const file2Valid = REQUIRED_FILE2_VARIANTS.some((variant) =>
      variant.every((col) => cols2.includes(col))
    );

    if (!file2Valid) {
      alert(
        "Error: The second Excel file does not match the required schema. It must have either:\n" +
          "• Date Committed, Station, Barangay, Offense, Age, Gender, Alcohol_Used\n" +
          "or\n" +
          "• DATE COMMITTED, STATION, BARANGAY, OFFENSE, AGE, GENDER, ALCOHOL_USED"
      );
      return;
    }
  } catch (err) {
    console.error("Excel header validation failed:", err);
    alert("Error reading Excel headers. Please check your files.");
    return;
  }

  const fd = new FormData();
  fd.append("file_name", fileName || "accidents_processed");
  fd.append("file1", file1);
  fd.append("file2", file2);

  const appendMode = !!document.getElementById("appendToggle")?.checked;
  const appendTarget = document.getElementById("appendTarget")?.value || "";
  fd.append("append_mode", appendMode ? "1" : "0");
  if (appendMode && appendTarget) fd.append("append_target", appendTarget);

  const btn = document.querySelector(".done-btn");
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Processing…";

  openProgressModal();
  setStep("merge"); // Start at 25%

  try {
    // wait a little so the merge step animates
    await new Promise((r) => setTimeout(r, 1000));

    const res = await fetch("/api/upload_files", { method: "POST", body: fd });
    const out = await res.json();

    if (!res.ok || !out.success) {
      throw new Error(out.message || "Upload failed.");
    }

    // show preprocessing stage
    setStep("preprocess");
    await new Promise((r) => setTimeout(r, 1000));

    // show complete stage
    setStep("complete");

    // wait until the bar visually hits 100% before alert
    await new Promise((r) => setTimeout(r, 600));

    alert(out.message);

    // refresh list / redirect
    window.location.reload();
  } catch (err) {
    console.error(err);
    alert(`Error: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

function getFileHeaders(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = function (e) {
      try {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: "array" });

        // read the first sheet
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];

        // convert to JSON with header mapping
        const headers = [];
        const range = XLSX.utils.decode_range(firstSheet["!ref"]);
        const firstRow = range.s.r; // first row index

        for (let c = range.s.c; c <= range.e.c; ++c) {
          const cell = firstSheet[XLSX.utils.encode_cell({ r: firstRow, c })];
          let header = cell ? cell.v : `Column${c + 1}`;
          headers.push(String(header).trim());
        }

        resolve(headers);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file); // important for Excel
  });
}

// Override old upload click
document
  .getElementById("triggerFileUpload")
  .addEventListener("click", function (e) {
    e.preventDefault();
    openUploadModal();
  });

// --- Modal open/close
function openProgressModal() {
  resetProgressUI();
  document.getElementById("progressModal").classList.remove("hidden");
}
function closeProgressModal() {
  document.getElementById("progressModal").classList.add("hidden");
}

// --- Progress UI control
function setPercent(pct) {
  const fill = document.getElementById("pbFill");
  const badge = document.getElementById("pbBadge");
  fill.style.width = `${pct}%`;
  badge.textContent = `${Math.round(pct)}%`;
}

function setStep(state) {
  // state: "merge" | "preprocess" | "complete"
  const map = {
    merge: { pct: 25, active: "dot-merge", done: [] },
    preprocess: { pct: 65, active: "dot-preprocess", done: ["dot-merge"] },
    complete: {
      pct: 100,
      active: "dot-complete",
      done: ["dot-merge", "dot-preprocess"],
    },
  };
  const conf = map[state];
  if (!conf) return;

  // percent bar
  setPercent(conf.pct);

  // step states
  ["dot-merge", "dot-preprocess", "dot-complete"].forEach((id) => {
    const el = document.getElementById(id);
    el.classList.remove("active", "done");
  });
  conf.done.forEach((id) => document.getElementById(id).classList.add("done"));
  document.getElementById(conf.active).classList.add("active");

  // button state
  const btn = document.getElementById("pbActionBtn");
  if (state === "complete") {
    btn.disabled = false;
    btn.textContent = "Finish";
  } else {
    btn.disabled = true;
    btn.textContent = "Save Progress";
  }
}

function resetProgressUI() {
  setPercent(0);
  ["dot-merge", "dot-preprocess", "dot-complete"].forEach((id) => {
    const el = document.getElementById(id);
    el.classList.remove("active", "done");
  });
  setStep("merge");
  document.getElementById("pbNote").textContent =
    "Please keep this window open.";
}

document.getElementById("pbActionBtn")?.addEventListener("click", () => {
  // what happens after finish (close + refresh)
  closeProgressModal();
  window.location.reload();
});
