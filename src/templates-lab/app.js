(function () {
  "use strict";

  const state = {
    categories: [],
    pendingSuggestions: [],
    selectedId: null,
    dirty: false
  };

  const categoryPrefixes = {
    "Word Accuracy": "word_accuracy",
    "Timestamp Accuracy": "timestamp_accuracy",
    "Punctuation & Formatting": "punctuation_formatting",
    "Tags & Emphasis": "tags_emphasis",
    "Segmentation": "segmentation"
  };

  const cyrillicToLatin = {
    а: "a",
    б: "b",
    в: "v",
    г: "g",
    д: "d",
    е: "e",
    ё: "yo",
    ж: "zh",
    з: "z",
    и: "i",
    й: "y",
    к: "k",
    л: "l",
    м: "m",
    н: "n",
    о: "o",
    п: "p",
    р: "r",
    с: "s",
    т: "t",
    у: "u",
    ф: "f",
    х: "kh",
    ц: "ts",
    ч: "ch",
    ш: "sh",
    щ: "shch",
    ъ: "",
    ы: "y",
    ь: "",
    э: "e",
    ю: "yu",
    я: "ya"
  };

  const els = {
    registryVersion: document.getElementById("registryVersion"),
    status: document.getElementById("status"),
    saveDraftBtn: document.getElementById("saveDraftBtn"),
    discardDraftBtn: document.getElementById("discardDraftBtn"),
    refreshBtn: document.getElementById("refreshBtn"),
    csvFile: document.getElementById("csvFile"),
    csvIgnoreHeader: document.getElementById("csvIgnoreHeader"),
    csvOverwriteRegistry: document.getElementById("csvOverwriteRegistry"),
    importBtn: document.getElementById("importBtn"),
    exportBtn: document.getElementById("exportBtn"),
    templateList: document.getElementById("templateList"),
    pendingSuggestions: document.getElementById("pendingSuggestions"),
    categoryFilter: document.getElementById("categoryFilter"),
    searchInput: document.getElementById("searchInput"),
    newTemplateBtn: document.getElementById("newTemplateBtn"),
    editorTitle: document.getElementById("editorTitle"),
    createForm: document.getElementById("createForm"),
    createCategory: document.getElementById("createCategory"),
    createName: document.getElementById("createName"),
    createIdPreview: document.getElementById("createIdPreview"),
    createDescription: document.getElementById("createDescription"),
    createReportTexts: document.getElementById("createReportTexts"),
    createAddVariantBtn: document.getElementById("createAddVariantBtn"),
    createResetBtn: document.getElementById("createResetBtn"),
    editForm: document.getElementById("editForm"),
    editId: document.getElementById("editId"),
    editCategory: document.getElementById("editCategory"),
    editPriority: document.getElementById("editPriority"),
    editName: document.getElementById("editName"),
    editDescription: document.getElementById("editDescription"),
    editReportTexts: document.getElementById("editReportTexts"),
    editAddVariantBtn: document.getElementById("editAddVariantBtn"),
    editEnabled: document.getElementById("editEnabled"),
    editDeleteBtn: document.getElementById("editDeleteBtn"),
    editCancelBtn: document.getElementById("editCancelBtn")
  };

  function setStatus(message, isError) {
    els.status.textContent = message;
    els.status.classList.toggle("error", !!isError);
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function transliterateChar(char) {
    if (/[a-z0-9]/.test(char)) {
      return char;
    }
    if (Object.prototype.hasOwnProperty.call(cyrillicToLatin, char)) {
      return cyrillicToLatin[char];
    }
    if (/\s/.test(char) || /[.,/#!$%^&*;:{}=\-`~()"'?<>@[\]+\\|]/.test(char)) {
      return "_";
    }
    const codePoint = char.codePointAt(0);
    return typeof codePoint === "number" ? "u" + codePoint.toString(16) : "_";
  }

  function slugifyName(name) {
    const raw = Array.from(String(name || "").trim().toLowerCase())
      .map((char) => transliterateChar(char))
      .join("");

    return raw
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "");
  }

  function buildIdPreview() {
    const category = els.createCategory.value;
    const prefix = categoryPrefixes[category];
    const slug = slugifyName(els.createName.value);
    els.createIdPreview.value = prefix && slug ? prefix + "." + slug : "";
  }

  function createVariantRow(index, value) {
    const row = document.createElement("div");
    row.className = "variant-item";

    const head = document.createElement("div");
    head.className = "variant-item-head";
    const label = document.createElement("span");
    label.textContent = "Variant " + (index + 1);
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "secondary variant-remove";
    removeBtn.textContent = "Remove";

    const textarea = document.createElement("textarea");
    textarea.rows = 3;
    textarea.className = "variant-text";
    textarea.value = value || "";
    textarea.placeholder = "User-facing template text";

    head.appendChild(label);
    head.appendChild(removeBtn);
    row.appendChild(head);
    row.appendChild(textarea);
    return row;
  }

  function renderVariantList(container, values) {
    container.className = "variant-list";
    container.innerHTML = "";
    const normalized = Array.isArray(values) && values.length ? values : [""];
    normalized.forEach((value, index) => {
      container.appendChild(createVariantRow(index, value));
    });
  }

  function addVariantRow(container, value) {
    const nextIndex = container.querySelectorAll(".variant-item").length;
    container.appendChild(createVariantRow(nextIndex, value || ""));
  }

  function renumberVariantRows(container) {
    const rows = container.querySelectorAll(".variant-item");
    rows.forEach((row, index) => {
      const label = row.querySelector(".variant-item-head span");
      if (label) {
        label.textContent = "Variant " + (index + 1);
      }
    });
  }

  function collectVariantTexts(container, fieldName) {
    const values = Array.from(container.querySelectorAll("textarea"))
      .map((textarea) => String(textarea.value || "").trim())
      .filter(Boolean);
    if (!values.length) {
      throw new Error(fieldName + " must include at least one non-empty variant.");
    }
    return values;
  }

  function cloneCategories(categories) {
    return (Array.isArray(categories) ? categories : []).map((group) => ({
      category: group.category,
      fileVersion: group.fileVersion,
      defaultText: group.defaultText,
      templates: Array.isArray(group.templates)
        ? group.templates.map((template) => ({
            id: template.id,
            title: template.title,
            description: template.description,
            reportTexts: Array.isArray(template.reportTexts)
              ? template.reportTexts.map((item) => String(item))
              : [],
            priority: template.priority,
            enabled: !!template.enabled
          }))
        : []
    }));
  }

  function createEmptyDraftFromCurrentCategories() {
    return state.categories.map((group) => ({
      category: group.category,
      fileVersion: group.fileVersion,
      defaultText: group.defaultText,
      templates: []
    }));
  }

  function compareTemplates(left, right) {
    if (left.priority !== right.priority) {
      return right.priority - left.priority;
    }
    return String(left.id).localeCompare(String(right.id));
  }

  function sortDraftTemplates() {
    state.categories.forEach((group) => {
      group.templates.sort(compareTemplates);
    });
  }

  function getAllTemplates() {
    return state.categories.flatMap((group) =>
      group.templates.map((template) => ({
        id: template.id,
        title: template.title,
        description: template.description,
        reportTexts: Array.isArray(template.reportTexts)
          ? template.reportTexts.map((item) => String(item))
          : [],
        priority: template.priority,
        enabled: template.enabled,
        category: group.category
      }))
    );
  }

  function getTemplateById(id) {
    if (!id) {
      return null;
    }

    for (const group of state.categories) {
      const template = group.templates.find((item) => item.id === id);
      if (template) {
        return {
          group: group,
          template: template
        };
      }
    }

    return null;
  }

  function updateDraftControls() {
    const dirty = !!state.dirty;
    els.saveDraftBtn.disabled = !dirty;
    els.discardDraftBtn.disabled = !dirty;
  }

  function markDirty() {
    state.dirty = true;
    updateDraftControls();
  }

  function clearDirty() {
    state.dirty = false;
    updateDraftControls();
  }

  function setCreateMode() {
    state.selectedId = null;
    els.editorTitle.textContent = "Create Template";
    els.createForm.classList.remove("hidden");
    els.editForm.classList.add("hidden");
    renderList();
  }

  function setEditMode(template) {
    state.selectedId = template.id;
    els.editorTitle.textContent = "Edit Template";
    els.createForm.classList.add("hidden");
    els.editForm.classList.remove("hidden");
    els.editId.value = template.id;
    els.editCategory.value = template.category;
    els.editPriority.value = String(template.priority);
    els.editName.value = template.title;
    els.editDescription.value = template.description;
    renderVariantList(els.editReportTexts, template.reportTexts);
    els.editEnabled.checked = !!template.enabled;
    renderList();
  }

  function resetCreateForm() {
    els.createForm.reset();
    if (els.createCategory.options.length) {
      els.createCategory.selectedIndex = 0;
    }
    buildIdPreview();
    renderVariantList(els.createReportTexts, [""]);
  }

  function renderCategoryOptions() {
    const options = ['<option value="__all__">All Categories</option>']
      .concat(
        state.categories.map((group) =>
          '<option value="' + escapeHtml(group.category) + '">' + escapeHtml(group.category) + "</option>"
        )
      )
      .join("");
    const existingValue = els.categoryFilter.value;
    els.categoryFilter.innerHTML = options;
    if (
      existingValue &&
      Array.from(els.categoryFilter.options).some((option) => option.value === existingValue)
    ) {
      els.categoryFilter.value = existingValue;
    }

    const createOptions = state.categories
      .map((group) =>
        '<option value="' + escapeHtml(group.category) + '">' + escapeHtml(group.category) + "</option>"
      )
      .join("");
    const createValue = els.createCategory.value;
    els.createCategory.innerHTML = createOptions;
    if (
      createValue &&
      Array.from(els.createCategory.options).some((option) => option.value === createValue)
    ) {
      els.createCategory.value = createValue;
    }
    buildIdPreview();
  }

  function getVisibleTemplates() {
    const categoryFilter = els.categoryFilter.value;
    const searchValue = String(els.searchInput.value || "").trim().toLowerCase();
    const allTemplates = getAllTemplates();

    return allTemplates.filter((template) => {
      if (categoryFilter && categoryFilter !== "__all__" && template.category !== categoryFilter) {
        return false;
      }
      if (!searchValue) {
        return true;
      }
      const haystack = [
        template.title,
        template.id,
        template.description,
        (template.reportTexts || []).join(" "),
        template.category
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(searchValue);
    });
  }

  function renderList() {
    const visible = getVisibleTemplates();
    if (!visible.length) {
      els.templateList.innerHTML = '<div class="empty-state">No templates match the current filters.</div>';
      return;
    }

    els.templateList.innerHTML = visible
      .map((template) => {
        const isActive = template.id === state.selectedId;
        return [
          '<article class="list-item' + (isActive ? " active" : "") + '" data-id="' + escapeHtml(template.id) + '">',
          '<div class="list-item-head">',
          '<div class="list-item-title">' + escapeHtml(template.title) + "</div>",
          '<span class="pill ' + (template.enabled ? "enabled" : "disabled") + '">',
          template.enabled ? "Enabled" : "Disabled",
          "</span>",
          "</div>",
          '<div class="list-item-meta">' + escapeHtml(template.category) + " | " + escapeHtml(template.id) + "</div>",
          '<div class="list-item-desc">' + escapeHtml(template.description) + "</div>",
          "</article>"
        ].join("");
      })
        .join("");
  }

  function renderPendingSuggestions() {
    if (!Array.isArray(state.pendingSuggestions) || !state.pendingSuggestions.length) {
      els.pendingSuggestions.innerHTML =
        '<div class="empty-state">No approved reviewer suggestions are waiting in the queue.</div>';
      return;
    }

    els.pendingSuggestions.innerHTML = state.pendingSuggestions
      .map((item) => {
        const proposal = item.proposal || {};
        const reportTexts = Array.isArray(proposal.reportTexts) ? proposal.reportTexts : [];
        const preview = reportTexts.slice(0, 2).join(" | ");
        return [
          '<article class="pending-item" data-queue-id="' + escapeHtml(item.queueId) + '">',
          '<div class="pending-item-head">',
          '<div>',
          '<div class="pending-item-title">' + escapeHtml(proposal.title || item.queueId) + "</div>",
          '<div class="pending-item-meta">' +
            escapeHtml((proposal.category || "Unknown") + " | " + (proposal.operation || "pending")) +
            "</div>",
          "</div>",
          '<span class="decision-state">Already staged in draft</span>',
          "</div>",
          '<div class="pending-item-desc">' + escapeHtml(proposal.description || "") + "</div>",
          '<div class="pending-item-reason">' + escapeHtml(proposal.reason || "") + "</div>",
          (preview
            ? '<div class="pending-item-reason"><strong>Texts:</strong> ' + escapeHtml(preview) + "</div>"
            : ""),
          "</article>"
        ].join("");
      })
      .join("");
  }

  async function request(path, options) {
    const response = await fetch(path, options);
    const text = await response.text();
    let payload = null;

    if (text) {
      try {
        payload = JSON.parse(text);
      } catch (_) {
        throw new Error("Server returned non-JSON: " + text.slice(0, 220));
      }
    }

    if (!response.ok) {
      throw new Error(payload && payload.error ? payload.error : "HTTP " + response.status);
    }

    return payload;
  }

  async function refreshTemplates(options) {
    const force = !!(options && options.force);
    if (state.dirty && !force) {
      const shouldDiscard = window.confirm(
        "Discard unsaved draft changes and reload templates from disk?"
      );
      if (!shouldDiscard) {
        return false;
      }
    }

      setStatus("Loading templates...", false);
      const payload = await request("/api/templates-lab/templates");
      state.categories = cloneCategories(payload.categories);
      state.pendingSuggestions = Array.isArray(payload.pendingSuggestions)
        ? payload.pendingSuggestions
        : [];
      sortDraftTemplates();
      els.registryVersion.textContent = payload.registryVersion || "-";
      renderCategoryOptions();
      renderPendingSuggestions();
      clearDirty();
    if (state.selectedId) {
      const selected = getTemplateById(state.selectedId);
      if (selected) {
        setEditMode({
          category: selected.group.category,
          id: selected.template.id,
          title: selected.template.title,
          description: selected.template.description,
          reportTexts: selected.template.reportTexts,
          priority: selected.template.priority,
          enabled: selected.template.enabled
        });
      } else {
        setCreateMode();
      }
    } else {
      setCreateMode();
    }
    setStatus(
      state.pendingSuggestions.length
        ? "Templates loaded. Approved suggestions are already staged in the draft."
        : "Templates loaded.",
      false
    );
    return true;
  }

  function getNextPriority(group) {
    if (!group || !Array.isArray(group.templates) || !group.templates.length) {
      return 100;
    }

    return Math.min.apply(
      Math,
      group.templates.map((template) => Number(template.priority))
      ) - 1;
  }

  function applyPendingSuggestionToDraft(queueId) {
    const item = (Array.isArray(state.pendingSuggestions) ? state.pendingSuggestions : []).find(
      (entry) => entry && entry.queueId === queueId
    );
    if (!item || !item.proposal) {
      throw new Error("Pending suggestion not found: " + queueId);
    }

    const proposal = item.proposal;
    const category = proposal.category;
    const group = state.categories.find((entry) => entry.category === category);
    if (!group) {
      throw new Error("Unknown category for pending suggestion: " + category);
    }

    if (proposal.operation === "create_template") {
      let id = String(proposal.targetTemplateId || "").trim();
      if (!id) {
        const prefix = categoryPrefixes[category];
        const slug = slugifyName(proposal.title || proposal.description || queueId);
        id = prefix + "." + slug;
      }
      if (getTemplateById(id)) {
        throw new Error("Draft already contains template " + id + ".");
      }

      group.templates.push({
        id: id,
        title: proposal.title,
        description: proposal.description,
        reportTexts: Array.isArray(proposal.reportTexts) ? proposal.reportTexts.slice() : [],
        priority: getNextPriority(group),
        enabled: true
      });
    } else {
      const found = proposal.targetTemplateId ? getTemplateById(proposal.targetTemplateId) : null;
      if (!found) {
        throw new Error("Target template not found in draft: " + proposal.targetTemplateId);
      }

      found.template.title = proposal.title;
      found.template.description = proposal.description;
      found.template.reportTexts = Array.isArray(proposal.reportTexts)
        ? proposal.reportTexts.slice()
        : [];
      if (proposal.operation === "disable_template") {
        found.template.enabled = false;
      }
    }

    sortDraftTemplates();
    markDirty();
    renderList();
    setStatus("Applied pending suggestion " + queueId + " into the draft.", false);
  }

  function assertNonEmpty(value, field) {
    const trimmed = String(value || "").trim();
    if (!trimmed) {
      throw new Error(field + " is required.");
    }
    return trimmed;
  }

  function addTemplateToDraft(event) {
    event.preventDefault();

    const category = assertNonEmpty(els.createCategory.value, "Category");
    const name = assertNonEmpty(els.createName.value, "Name");
    const description = assertNonEmpty(els.createDescription.value, "Error description");
    const reportTexts = collectVariantTexts(els.createReportTexts, "Template text variants");
    const id = assertNonEmpty(els.createIdPreview.value, "Generated ID");
    const existing = getTemplateById(id);

    if (existing) {
      throw new Error("Template id already exists in the draft: " + id);
    }

    const group = state.categories.find((item) => item.category === category);
    if (!group) {
      throw new Error("Unknown category: " + category);
    }

    const created = {
      id: id,
      title: name,
      description: description,
      reportTexts: reportTexts,
      priority: getNextPriority(group),
      enabled: true
    };

    group.templates.push(created);
    sortDraftTemplates();
    markDirty();
    setEditMode({
      category: category,
      id: created.id,
      title: created.title,
      description: created.description,
      reportTexts: created.reportTexts,
      priority: created.priority,
      enabled: created.enabled
    });
    setStatus("Added template " + id + " to the draft.", false);
  }

  function applyEditToDraft(event) {
    event.preventDefault();

    const id = assertNonEmpty(els.editId.value, "Template id");
    const found = getTemplateById(id);
    if (!found) {
      throw new Error("Template not found in draft: " + id);
    }

    found.template.title = assertNonEmpty(els.editName.value, "Name");
    found.template.description = assertNonEmpty(els.editDescription.value, "Error description");
    found.template.reportTexts = collectVariantTexts(els.editReportTexts, "Template text variants");
    found.template.enabled = !!els.editEnabled.checked;

    sortDraftTemplates();
    markDirty();
    setEditMode({
      category: found.group.category,
      id: found.template.id,
      title: found.template.title,
      description: found.template.description,
      reportTexts: found.template.reportTexts,
      priority: found.template.priority,
      enabled: found.template.enabled
    });
    setStatus("Updated draft for " + id + ".", false);
  }

  function deleteSelectedTemplate() {
    const id = els.editId.value;
    if (!id) {
      setStatus("No template selected.", true);
      return;
    }

    const found = getTemplateById(id);
    if (!found) {
      setStatus("Template not found in draft.", true);
      return;
    }

    const shouldDelete = window.confirm(
      'Remove template "' + found.template.title + '" from the draft? It will be deleted on save.'
    );
    if (!shouldDelete) {
      return;
    }

    found.group.templates = found.group.templates.filter((template) => template.id !== id);
    markDirty();
    resetCreateForm();
    setCreateMode();
    setStatus("Marked template " + id + " for deletion. Save the draft to persist it.", false);
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let cell = "";
    let inQuotes = false;

    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      const next = text[index + 1];

      if (inQuotes) {
        if (char === '"' && next === '"') {
          cell += '"';
          index += 1;
          continue;
        }
        if (char === '"') {
          inQuotes = false;
          continue;
        }
        cell += char;
        continue;
      }

      if (char === '"') {
        inQuotes = true;
        continue;
      }
      if (char === ",") {
        row.push(cell);
        cell = "";
        continue;
      }
      if (char === "\n") {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = "";
        continue;
      }
      if (char === "\r") {
        continue;
      }
      cell += char;
    }

    if (inQuotes) {
      throw new Error("CSV contains an unclosed quoted field.");
    }

    if (cell.length > 0 || row.length > 0) {
      row.push(cell);
      rows.push(row);
    }

    return rows;
  }

  function escapeCsvCell(value) {
    const text = String(value == null ? "" : value);
    if (!/[",\r\n]/.test(text)) {
      return text;
    }
    return '"' + text.replace(/"/g, '""') + '"';
  }

  function buildExportRows() {
    const allTemplates = getAllTemplates();
    const maxVariants = Math.max(
      1,
      ...allTemplates.map((template) =>
        Array.isArray(template.reportTexts) && template.reportTexts.length
          ? template.reportTexts.length
          : 1
      )
    );
    const rows = [
      [
        "category",
        "name",
        "error description",
        ...Array.from({ length: maxVariants }, (_, index) => "template text " + (index + 1))
      ]
    ];

    for (const group of state.categories) {
      for (const template of group.templates) {
        const variants = (Array.isArray(template.reportTexts) ? template.reportTexts : [])
          .map((value) => String(value || "").trim())
          .filter(Boolean);
        rows.push([
          group.category,
          template.title,
          template.description,
          ...variants,
          ...Array.from({ length: maxVariants - variants.length }, () => "")
        ]);
      }
    }

    return rows;
  }

  function buildExportFileName() {
    const now = new Date();
    const parts = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
      "-",
      String(now.getHours()).padStart(2, "0"),
      String(now.getMinutes()).padStart(2, "0"),
      String(now.getSeconds()).padStart(2, "0")
    ];
    return "templates-lab-" + parts.join("") + ".csv";
  }

  function exportCsv() {
    const rows = buildExportRows();
    const csvText = rows
      .map((row) => row.map((cell) => escapeCsvCell(cell)).join(","))
      .join("\r\n");
    const blob = new Blob([csvText], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = buildExportFileName();
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);

    setStatus("Exported " + (rows.length - 1) + " templates to CSV from the current draft.", false);
  }

  function normalizeCsvHeader(value) {
    return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
  }

  async function onImportClick() {
    const file = els.csvFile.files && els.csvFile.files[0];
    if (!file) {
      setStatus("Choose a CSV file first.", true);
      return;
    }

    const ignoreHeader = !!els.csvIgnoreHeader.checked;
    const overwriteRegistry = !!els.csvOverwriteRegistry.checked;

    if (overwriteRegistry) {
      const confirmed = window.confirm(
        "Replace the current draft with templates from this CSV? Categories missing from the CSV will become empty after save."
      );
      if (!confirmed) {
        return;
      }
    }

    setStatus("Importing CSV into the draft...", false);
    const csvText = await file.text();
    const rows = parseCsv(csvText);
    if (!rows.length) {
      throw new Error("CSV is empty.");
    }

    const expectedHeaders = ["category", "name", "error description"];
    let startRowIndex = 0;

    if (ignoreHeader) {
      startRowIndex = 1;
    } else {
      const headers = rows[0].map(normalizeCsvHeader);
      if (headers.length < expectedHeaders.length + 1) {
        throw new Error(
          "CSV header must include category,name,error description and at least one template text column."
        );
      }
      if (
        headers.some(
          (value, index) => index < expectedHeaders.length && value !== expectedHeaders[index]
        )
      ) {
        throw new Error("CSV header must start with: " + expectedHeaders.join(", "));
      }
      const variantHeaders = headers.slice(expectedHeaders.length);
      const invalidVariantHeader = variantHeaders.find(
        (value, index) => value !== "template text " + (index + 1)
      );
      if (invalidVariantHeader) {
        throw new Error(
          "Template text headers must be named in order: template text 1, template text 2, ..."
        );
      }
      startRowIndex = 1;
    }

    const nextCategories = overwriteRegistry
      ? createEmptyDraftFromCurrentCategories()
      : cloneCategories(state.categories);

    let created = 0;
    let updated = 0;

    for (let index = startRowIndex; index < rows.length; index += 1) {
      const row = rows[index];
      if (!row.some((value) => String(value || "").trim())) {
        continue;
      }
      if (row.length < 4) {
        throw new Error("CSV row " + (index + 1) + " must have at least 4 columns.");
      }

      const category = assertNonEmpty(row[0], "CSV row " + (index + 1) + " category");
      const name = assertNonEmpty(row[1], "CSV row " + (index + 1) + " name");
      const description = assertNonEmpty(
        row[2],
        "CSV row " + (index + 1) + " error description"
      );
      const reportTexts = row
        .slice(3)
        .map((value) => String(value || "").trim())
        .filter(Boolean);
      if (!reportTexts.length) {
        throw new Error(
          "CSV row " + (index + 1) + " must include at least one non-empty template text."
        );
      }
      const prefix = categoryPrefixes[category];
      if (!prefix) {
        throw new Error("CSV row " + (index + 1) + " has unknown category: " + category);
      }

      const slug = slugifyName(name);
      if (!slug) {
        throw new Error("CSV row " + (index + 1) + " name does not produce a usable template id.");
      }

      const id = prefix + "." + slug;
      let found = null;
      for (const group of nextCategories) {
        const template = group.templates.find((item) => item.id === id);
        if (template) {
          found = {
            group: group,
            template: template
          };
          break;
        }
      }

      if (found) {
        found.template.title = name;
        found.template.description = description;
        found.template.reportTexts = reportTexts;
        updated += 1;
      } else {
        const group = nextCategories.find((item) => item.category === category);
        if (!group) {
          throw new Error("Unknown category: " + category);
        }
        group.templates.push({
          id: id,
          title: name,
          description: description,
          reportTexts: reportTexts,
          priority: getNextPriority(group),
          enabled: true
        });
        created += 1;
      }
    }

    state.categories = nextCategories;
    sortDraftTemplates();
    markDirty();
    renderList();
    if (state.selectedId && !getTemplateById(state.selectedId)) {
      setCreateMode();
    } else if (state.selectedId) {
      const selected = getTemplateById(state.selectedId);
      if (selected) {
        setEditMode({
          category: selected.group.category,
          id: selected.template.id,
          title: selected.template.title,
          description: selected.template.description,
          reportTexts: selected.template.reportTexts,
          priority: selected.template.priority,
          enabled: selected.template.enabled
        });
      }
    }
    setStatus(
      "CSV import applied to draft. Created " +
        created +
        ", updated " +
        updated +
        (overwriteRegistry ? ". The draft now mirrors the imported CSV." : "."),
      false
    );
    els.csvFile.value = "";
  }

  async function saveDraft() {
    if (!state.dirty) {
      setStatus("No draft changes to save.", false);
      return;
    }

    setStatus("Saving draft to JSON...", false);
    const payload = await request("/api/templates-lab/save", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        categories: state.categories.map((group) => ({
          category: group.category,
          fileVersion: group.fileVersion,
          defaultText: group.defaultText,
          templates: group.templates.map((template) => ({
            id: template.id,
            title: template.title,
            description: template.description,
            reportTexts: template.reportTexts,
            priority: template.priority,
            enabled: !!template.enabled
          }))
        }))
      })
    });

    await refreshTemplates({ force: true });
    if (payload && Array.isArray(payload.touchedCategories) && payload.touchedCategories.length) {
      setStatus(
        "Saved draft to JSON. Updated " + payload.touchedCategories.join(", ") + ".",
        false
      );
      return;
    }
    setStatus("Draft already matched disk. Nothing changed.", false);
  }

  async function discardDraft() {
    if (!state.dirty) {
      setStatus("No draft changes to discard.", false);
      return;
    }

    await refreshTemplates({ force: true });
    setStatus("Discarded unsaved draft changes.", false);
  }

  function onListClick(event) {
    const target = event.target.closest(".list-item");
    if (!target) {
      return;
    }
    const id = target.getAttribute("data-id");
    const found = getTemplateById(id);
    if (found) {
      setEditMode({
        category: found.group.category,
        id: found.template.id,
        title: found.template.title,
        description: found.template.description,
        reportTexts: found.template.reportTexts,
        priority: found.template.priority,
        enabled: found.template.enabled
      });
    }
  }

  function onVariantListClick(event) {
    const button = event.target.closest(".variant-remove");
    if (!button) {
      return;
    }
    const row = button.closest(".variant-item");
    const container = button.closest(".variant-list");
    if (!row || !container) {
      return;
    }

    const rows = container.querySelectorAll(".variant-item");
    if (rows.length <= 1) {
      setStatus("At least one template text variant is required.", true);
      return;
    }

    row.remove();
    renumberVariantRows(container);
  }

  function handleError(error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  }

  els.saveDraftBtn.addEventListener("click", function () {
    saveDraft().catch(handleError);
  });
  els.discardDraftBtn.addEventListener("click", function () {
    discardDraft().catch(handleError);
  });
  els.refreshBtn.addEventListener("click", function () {
    refreshTemplates().catch(handleError);
  });
  els.importBtn.addEventListener("click", function () {
    onImportClick().catch(handleError);
  });
  els.exportBtn.addEventListener("click", function () {
    try {
      exportCsv();
    } catch (error) {
      handleError(error);
    }
  });
  els.categoryFilter.addEventListener("change", renderList);
  els.searchInput.addEventListener("input", renderList);
  els.newTemplateBtn.addEventListener("click", function () {
    resetCreateForm();
    setCreateMode();
  });
  els.createName.addEventListener("input", buildIdPreview);
  els.createCategory.addEventListener("change", buildIdPreview);
  els.createResetBtn.addEventListener("click", function () {
    resetCreateForm();
  });
  els.createAddVariantBtn.addEventListener("click", function () {
    addVariantRow(els.createReportTexts, "");
  });
  els.editAddVariantBtn.addEventListener("click", function () {
    addVariantRow(els.editReportTexts, "");
  });
  els.createForm.addEventListener("submit", function (event) {
    try {
      addTemplateToDraft(event);
    } catch (error) {
      handleError(error);
    }
  });
  els.editForm.addEventListener("submit", function (event) {
    try {
      applyEditToDraft(event);
    } catch (error) {
      handleError(error);
    }
  });
  els.editDeleteBtn.addEventListener("click", function () {
    deleteSelectedTemplate();
  });
  els.editCancelBtn.addEventListener("click", function () {
    setCreateMode();
  });
  els.createReportTexts.addEventListener("click", onVariantListClick);
  els.editReportTexts.addEventListener("click", onVariantListClick);
  els.templateList.addEventListener("click", onListClick);
  updateDraftControls();
  resetCreateForm();
  refreshTemplates().catch(handleError);
})();
