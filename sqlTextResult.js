(function () {
  var parser = window.SqlTextParser;

  if (!parser) {
    return;
  }

  var state = {
    files: [],
    nextId: 1,
  };

  var fileInput = document.getElementById("file-input");
  var exportAllButton = document.getElementById("export-all-btn");
  var clearButton = document.getElementById("clear-btn");
  var summary = document.getElementById("summary");
  var results = document.getElementById("results");
  var dropZone = document.getElementById("drop-zone");
  var cellDialog = document.getElementById("cell-dialog");
  var cellDialogTitle = document.getElementById("cell-dialog-title");
  var cellDialogContent = document.getElementById("cell-dialog-content");
  var closeDialogButton = document.getElementById("close-dialog-btn");

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function sanitizeFileName(name) {
    return name.replace(/[<>:\"/\\|?*]+/g, "-");
  }

  function isLikelyJsonText(value) {
    var trimmed = value.trim();
    return (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    );
  }

  function previewValue(value) {
    if (!value) {
      return "";
    }

    return value.length > 140 ? value.slice(0, 140) + "..." : value;
  }

  function totalRowsForFile(file) {
    return file.tables.reduce(function (sum, table) {
      return sum + table.rows.length;
    }, 0);
  }

  function renderSummary() {
    if (!state.files.length) {
      summary.hidden = true;
      summary.innerHTML = "";
      return;
    }

    summary.hidden = false;

    var totalTables = state.files.reduce(function (sum, file) {
      return sum + file.tables.length;
    }, 0);

    var totalRows = state.files.reduce(function (sum, file) {
      return sum + totalRowsForFile(file);
    }, 0);

    var mismatchCount = state.files.reduce(function (sum, file) {
      return (
        sum +
        file.tables.filter(function (table) {
          return !table.rowCountMatches;
        }).length
      );
    }, 0);

    summary.innerHTML = [
      renderSummaryCard("已导入文件", String(state.files.length), "支持一次拖入多个 TXT 文件。"),
      renderSummaryCard("识别结果集", String(totalTables), "每个结果集会单独显示为一个表。"),
      renderSummaryCard("总数据行数", String(totalRows), "统计的是页面真正解析出来的行数。"),
      renderSummaryCard("校验状态", mismatchCount ? String(mismatchCount) + " 个异常" : "通过", mismatchCount ? "页脚行数和解析行数存在不一致，请重点检查。" : "SQL 标注行数与解析结果一致。"),
    ].join("");
  }

  function renderSummaryCard(title, value, description) {
    return [
      '<article class="summary-card">',
      '<h2>' + escapeHtml(title) + '</h2>',
      '<span class="summary-card__value">' + escapeHtml(value) + '</span>',
      '<p>' + escapeHtml(description) + '</p>',
      '</article>',
    ].join("");
  }

  function renderResults() {
    if (!state.files.length) {
      results.innerHTML = "";
      return;
    }

    results.innerHTML = state.files.map(renderFileCard).join("");
  }

  function renderFileCard(file) {
    var mismatchCount = file.tables.filter(function (table) {
      return !table.rowCountMatches;
    }).length;

    var notes = file.notes.filter(function (note) {
      return !note.startsWith("Completion time:");
    });

    return [
      '<article class="file-card">',
      '<div class="file-card__header">',
      '<div>',
      '<p class="eyebrow">Source File</p>',
      '<h2>' + escapeHtml(file.name) + '</h2>',
      '<p class="file-card__meta">' + escapeHtml(String(file.tables.length) + ' 个结果集，' + String(totalRowsForFile(file)) + ' 行数据') + '</p>',
      '</div>',
      '<button class="button button--secondary" type="button" data-action="export-file" data-file-id="' + String(file.id) + '">导出这个文件为 XLSX</button>',
      '</div>',
      '<div class="pill-row">',
      '<span class="pill">列宽解析: 固定宽度</span>',
      '<span class="pill">结果集: ' + String(file.tables.length) + '</span>',
      '<span class="pill">数据行: ' + String(totalRowsForFile(file)) + '</span>',
      mismatchCount ? '<span class="pill pill--warn">行数异常: ' + String(mismatchCount) + '</span>' : '<span class="pill">行数校验: 通过</span>',
      '</div>',
      notes.length ? '<div class="pill-row"><span class="pill">忽略的非表格文本: ' + String(notes.length) + '</span></div>' : '',
      file.tables.map(function (table, tableIndex) {
        return renderTable(file, table, tableIndex);
      }).join(''),
      '</article>',
    ].join("");
  }

  function renderTable(file, table, tableIndex) {
    var headerCells = table.columns
      .map(function (column) {
        return '<th>' + escapeHtml(column) + '</th>';
      })
      .join('');

    var bodyRows = table.rows.length
      ? table.rows
          .map(function (row, rowIndex) {
            return (
              '<tr>' +
              row
                .map(function (cell, columnIndex) {
                  return renderCell(file.id, tableIndex, rowIndex, columnIndex, cell);
                })
                .join('') +
              '</tr>'
            );
          })
          .join('')
      : '<tr><td class="empty-cell" colspan="' + String(table.columns.length) + '">这个结果集没有数据行。</td></tr>';

    var metaPills = [
      '<span class="pill">列数: ' + String(table.columns.length) + '</span>',
      '<span class="pill">解析行数: ' + String(table.rows.length) + '</span>',
    ];

    if (table.reportedRowCount !== null) {
      metaPills.push('<span class="pill">SQL 标注行数: ' + String(table.reportedRowCount) + '</span>');
    }

    if (!table.rowCountMatches) {
      metaPills.push('<span class="pill pill--warn">页脚行数和解析行数不一致</span>');
    }

    return [
      '<details class="result-set" open>',
      '<summary>',
      '<span>' + escapeHtml(table.title) + '</span>',
      '<span class="pill">' + String(table.rows.length) + ' 行</span>',
      '</summary>',
      '<div class="result-set__body">',
      '<div class="result-set__meta">' + metaPills.join('') + '</div>',
      '<div class="table-wrap">',
      '<table>',
      '<thead><tr>' + headerCells + '</tr></thead>',
      '<tbody>' + bodyRows + '</tbody>',
      '</table>',
      '</div>',
      '</div>',
      '</details>',
    ].join("");
  }

  function renderCell(fileId, tableIndex, rowIndex, columnIndex, value) {
    var text = value || "";
    var likelyJson = isLikelyJsonText(text);
    var expandable = likelyJson || text.length > 140;
    var content = previewValue(text);

    if (!expandable) {
      return '<td>' + (content ? escapeHtml(content) : '&nbsp;') + '</td>';
    }

    var className = likelyJson ? 'cell-button cell-button--json' : 'cell-button';

    return [
      '<td>',
      '<button type="button" class="' + className + '" data-action="inspect-cell" data-file-id="' + String(fileId) + '" data-table-index="' + String(tableIndex) + '" data-row-index="' + String(rowIndex) + '" data-column-index="' + String(columnIndex) + '">',
      escapeHtml(content || '查看内容'),
      '</button>',
      '</td>',
    ].join("");
  }

  function updateButtons() {
    var hasData = state.files.length > 0;
    exportAllButton.disabled = !hasData;
    clearButton.disabled = !hasData;
  }

  function render() {
    renderSummary();
    renderResults();
    updateButtons();
  }

  function readFile(file) {
    return file.text().then(function (text) {
      var parsed = parser.parseSqlServerExport(text, file.name);

      return {
        id: state.nextId++,
        name: file.name,
        tables: parsed.tables,
        notes: parsed.notes,
      };
    });
  }

  function loadFiles(fileList) {
    var files = Array.from(fileList).filter(function (file) {
      return file.name.toLowerCase().endsWith('.txt');
    });

    if (!files.length) {
      return;
    }

    Promise.all(files.map(readFile)).then(function (entries) {
      state.files = state.files.concat(entries);
      fileInput.value = '';
      render();
    });
  }

  function downloadBlob(blob, fileName) {
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');

    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();

    window.setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 0);
  }

  function exportWorkbook(files, fileName) {
    var workbook = parser.buildWorkbookXlsx(
      files.map(function (file) {
        return {
          name: file.name,
          tables: file.tables,
        };
      })
    );

    var blob = new Blob([workbook], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    downloadBlob(blob, sanitizeFileName(fileName) + '.xlsx');
  }

  function openCellDialog(value, label) {
    var displayValue = value;

    if (isLikelyJsonText(value)) {
      try {
        displayValue = JSON.stringify(JSON.parse(value), null, 2);
      } catch (error) {
        displayValue = value;
      }
    }

    cellDialogTitle.textContent = label;
    cellDialogContent.textContent = displayValue;
    cellDialog.showModal();
  }

  function handleResultsClick(event) {
    var actionTarget = event.target.closest('[data-action]');

    if (!actionTarget) {
      return;
    }

    var action = actionTarget.getAttribute('data-action');

    if (action === 'export-file') {
      var fileId = Number(actionTarget.getAttribute('data-file-id'));
      var file = state.files.find(function (entry) {
        return entry.id === fileId;
      });

      if (file) {
        exportWorkbook([file], sanitizeFileName(file.name.replace(/\.[^.]+$/, '')));
      }

      return;
    }

    if (action === 'inspect-cell') {
      var targetFileId = Number(actionTarget.getAttribute('data-file-id'));
      var tableIndex = Number(actionTarget.getAttribute('data-table-index'));
      var rowIndex = Number(actionTarget.getAttribute('data-row-index'));
      var columnIndex = Number(actionTarget.getAttribute('data-column-index'));
      var targetFile = state.files.find(function (entry) {
        return entry.id === targetFileId;
      });

      if (!targetFile) {
        return;
      }

      var table = targetFile.tables[tableIndex];

      if (!table || !table.rows[rowIndex]) {
        return;
      }

      openCellDialog(table.rows[rowIndex][columnIndex] || '', targetFile.name + ' / ' + table.title + ' / ' + table.columns[columnIndex]);
    }
  }

  function setDropZoneActive(active) {
    dropZone.classList.toggle('drop-zone--active', active);
  }

  fileInput.addEventListener('change', function (event) {
    loadFiles(event.target.files);
  });

  exportAllButton.addEventListener('click', function () {
    exportWorkbook(state.files, 'sql-text-export');
  });

  clearButton.addEventListener('click', function () {
    state.files = [];
    fileInput.value = '';
    render();
  });

  results.addEventListener('click', handleResultsClick);

  closeDialogButton.addEventListener('click', function () {
    cellDialog.close();
  });

  cellDialog.addEventListener('click', function (event) {
    if (event.target === cellDialog) {
      cellDialog.close();
    }
  });

  ['dragenter', 'dragover'].forEach(function (eventName) {
    dropZone.addEventListener(eventName, function (event) {
      event.preventDefault();
      setDropZoneActive(true);
    });
  });

  ['dragleave', 'dragend', 'drop'].forEach(function (eventName) {
    dropZone.addEventListener(eventName, function (event) {
      event.preventDefault();
      if (eventName !== 'drop') {
        setDropZoneActive(false);
      }
    });
  });

  dropZone.addEventListener('drop', function (event) {
    setDropZoneActive(false);
    if (event.dataTransfer && event.dataTransfer.files) {
      loadFiles(event.dataTransfer.files);
    }
  });

  render();
})();
