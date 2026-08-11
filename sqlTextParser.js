(function (root, factory) {
  var api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.SqlTextParser = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var textEncoder = new TextEncoder();
  var crc32Table = createCrc32Table();

  function normalizeLineEndings(text) {
    return text.replace(/\r\n?/g, "\n");
  }

  function parseRowCount(line) {
    var match = line.trim().match(/^\((\d+)\s+rows?\s+affected\)$/i);
    return match ? Number(match[1]) : null;
  }

  function isDividerLine(line) {
    return /^[\s-]+$/.test(line) && /-/.test(line);
  }

  function getColumnSpans(dividerLine) {
    return Array.from(dividerLine.matchAll(/-+/g)).map(function (match) {
      return {
        start: match.index,
        width: match[0].length,
      };
    });
  }

  function buildColumns(headerLine, dividerLine) {
    var spans = getColumnSpans(dividerLine);

    return spans.map(function (span, index) {
      var nextSpan = spans[index + 1];
      var end = nextSpan ? nextSpan.start : Math.max(dividerLine.length, headerLine.length);
      var name = headerLine.slice(span.start, end).trim() || "Column" + String(index + 1);

      return {
        name: name,
        start: span.start,
        end: end,
      };
    });
  }

  function isTableStart(headerLine, dividerLine) {
    if (!headerLine || !headerLine.trim()) {
      return false;
    }

    if (!dividerLine || !isDividerLine(dividerLine)) {
      return false;
    }

    return buildColumns(headerLine, dividerLine).length > 0;
  }

  function parseDataLine(line, columns) {
    return columns.map(function (column, index) {
      var end = index < columns.length - 1 ? columns[index + 1].start : line.length;
      return line.slice(column.start, end).trim();
    });
  }

  function stripExtension(fileName) {
    return fileName.replace(/\.[^.]+$/, "");
  }

  function sanitizeSheetName(name) {
    return name
      .replace(/[\\/?*\[\]:]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 31) || "Sheet";
  }

  function makeUniqueSheetName(baseName, counts) {
    var base = sanitizeSheetName(baseName);
    var nextCount = (counts[base] || 0) + 1;
    counts[base] = nextCount;

    if (nextCount === 1) {
      return base;
    }

    var suffix = "_" + String(nextCount);
    var clipped = base.slice(0, Math.max(1, 31 - suffix.length));
    return clipped + suffix;
  }

  function sanitizeXmlText(value) {
    return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
  }

  function escapeXml(value) {
    return sanitizeXmlText(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  function toColumnName(columnIndex) {
    var dividend = columnIndex + 1;
    var label = "";

    while (dividend > 0) {
      var modulo = (dividend - 1) % 26;
      label = String.fromCharCode(65 + modulo) + label;
      dividend = Math.floor((dividend - modulo) / 26);
    }

    return label;
  }

  function buildCellReference(rowIndex, columnIndex) {
    return toColumnName(columnIndex) + String(rowIndex + 1);
  }

  function createXmlDocument(innerXml) {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + innerXml;
  }

  function encodeUtf8(text) {
    return textEncoder.encode(text);
  }

  function writeUint16(view, offset, value) {
    view.setUint16(offset, value, true);
  }

  function writeUint32(view, offset, value) {
    view.setUint32(offset, value >>> 0, true);
  }

  function concatUint8Arrays(parts) {
    var totalLength = parts.reduce(function (sum, part) {
      return sum + part.length;
    }, 0);
    var merged = new Uint8Array(totalLength);
    var offset = 0;

    parts.forEach(function (part) {
      merged.set(part, offset);
      offset += part.length;
    });

    return merged;
  }

  function createCrc32Table() {
    var table = new Uint32Array(256);

    for (var i = 0; i < 256; i += 1) {
      var current = i;

      for (var bit = 0; bit < 8; bit += 1) {
        if ((current & 1) === 1) {
          current = 0xedb88320 ^ (current >>> 1);
        } else {
          current = current >>> 1;
        }
      }

      table[i] = current >>> 0;
    }

    return table;
  }

  function computeCrc32(bytes) {
    var crc = 0xffffffff;

    for (var i = 0; i < bytes.length; i += 1) {
      crc = crc32Table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }

    return (crc ^ 0xffffffff) >>> 0;
  }

  function getDosDateTime(date) {
    var year = Math.max(1980, date.getFullYear());

    return {
      time: ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | Math.floor(date.getSeconds() / 2),
      date: (((year - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f),
    };
  }

  function createZip(entries) {
    var fileParts = [];
    var centralDirectoryParts = [];
    var offset = 0;
    var now = getDosDateTime(new Date());

    entries.forEach(function (entry) {
      var nameBytes = encodeUtf8(entry.name);
      var dataBytes = entry.data;
      var crc32 = computeCrc32(dataBytes);
      var localHeader = new Uint8Array(30 + nameBytes.length);
      var localView = new DataView(localHeader.buffer);

      writeUint32(localView, 0, 0x04034b50);
      writeUint16(localView, 4, 20);
      writeUint16(localView, 6, 0x0800);
      writeUint16(localView, 8, 0);
      writeUint16(localView, 10, now.time);
      writeUint16(localView, 12, now.date);
      writeUint32(localView, 14, crc32);
      writeUint32(localView, 18, dataBytes.length);
      writeUint32(localView, 22, dataBytes.length);
      writeUint16(localView, 26, nameBytes.length);
      writeUint16(localView, 28, 0);
      localHeader.set(nameBytes, 30);

      fileParts.push(localHeader, dataBytes);

      var centralHeader = new Uint8Array(46 + nameBytes.length);
      var centralView = new DataView(centralHeader.buffer);

      writeUint32(centralView, 0, 0x02014b50);
      writeUint16(centralView, 4, 20);
      writeUint16(centralView, 6, 20);
      writeUint16(centralView, 8, 0x0800);
      writeUint16(centralView, 10, 0);
      writeUint16(centralView, 12, now.time);
      writeUint16(centralView, 14, now.date);
      writeUint32(centralView, 16, crc32);
      writeUint32(centralView, 20, dataBytes.length);
      writeUint32(centralView, 24, dataBytes.length);
      writeUint16(centralView, 28, nameBytes.length);
      writeUint16(centralView, 30, 0);
      writeUint16(centralView, 32, 0);
      writeUint16(centralView, 34, 0);
      writeUint16(centralView, 36, 0);
      writeUint32(centralView, 38, 0);
      writeUint32(centralView, 42, offset);
      centralHeader.set(nameBytes, 46);
      centralDirectoryParts.push(centralHeader);

      offset += localHeader.length + dataBytes.length;
    });

    var centralDirectory = concatUint8Arrays(centralDirectoryParts);
    var endRecord = new Uint8Array(22);
    var endView = new DataView(endRecord.buffer);

    writeUint32(endView, 0, 0x06054b50);
    writeUint16(endView, 4, 0);
    writeUint16(endView, 6, 0);
    writeUint16(endView, 8, entries.length);
    writeUint16(endView, 10, entries.length);
    writeUint32(endView, 12, centralDirectory.length);
    writeUint32(endView, 16, offset);
    writeUint16(endView, 20, 0);

    return concatUint8Arrays(fileParts.concat([centralDirectory, endRecord]));
  }

  function parseSqlServerExport(text, sourceName) {
    var lines = normalizeLineEndings(text).split("\n");
    var tables = [];
    var notes = [];
    var cursor = 0;
    var tableIndex = 1;

    while (cursor < lines.length) {
      var headerLine = lines[cursor] || "";
      var dividerLine = lines[cursor + 1] || "";

      if (!isTableStart(headerLine, dividerLine)) {
        if (headerLine.trim()) {
          notes.push(headerLine.trim());
        }

        cursor += 1;
        continue;
      }

      var columns = buildColumns(headerLine, dividerLine);
      var rows = [];
      var reportedRowCount = null;

      cursor += 2;

      while (cursor < lines.length) {
        var currentLine = lines[cursor] || "";
        var currentRowCount = parseRowCount(currentLine);

        if (currentRowCount !== null) {
          reportedRowCount = currentRowCount;
          cursor += 1;
          break;
        }

        if (!currentLine.trim()) {
          cursor += 1;
          continue;
        }

        if (currentLine.trim().startsWith("Completion time:")) {
          break;
        }

        if (isTableStart(currentLine, lines[cursor + 1] || "")) {
          break;
        }

        rows.push(parseDataLine(currentLine, columns));
        cursor += 1;
      }

      while (cursor < lines.length && !lines[cursor].trim()) {
        cursor += 1;
      }

      tables.push({
        index: tableIndex,
        title: "结果集 " + String(tableIndex),
        columns: columns.map(function (column) {
          return column.name;
        }),
        rows: rows,
        reportedRowCount: reportedRowCount,
        rowCountMatches: reportedRowCount === null || reportedRowCount === rows.length,
      });

      tableIndex += 1;
    }

    return {
      sourceName: sourceName || "",
      tables: tables,
      notes: notes,
    };
  }

  function buildSectionCellXml(rowNumber, columnIndex, styleIndex, value) {
    return '<c r="' + buildCellReference(rowNumber - 1, columnIndex) + '" t="inlineStr" s="' + String(styleIndex) + '"><is><t xml:space="preserve">' + escapeXml(value) + '</t></is></c>';
  }

  function buildWorksheetXml(sections) {
    var rowNumber = 1;
    var maxColumnCount = 1;
    var sheetRows = [];

    sections.forEach(function (section, sectionIndex) {
      if (sectionIndex > 0) {
        rowNumber += 2;
      }

      maxColumnCount = Math.max(maxColumnCount, section.columns.length);

      sheetRows.push(
        '<row r="' +
          String(rowNumber) +
          '">' +
          section.columns
            .map(function (columnName, columnIndex) {
              return buildSectionCellXml(rowNumber, columnIndex, 1, columnName);
            })
            .join("") +
          '</row>'
      );

      rowNumber += 1;

      section.rows.forEach(function (row) {
        sheetRows.push(
          '<row r="' +
            String(rowNumber) +
            '">' +
            row
              .map(function (cellValue, columnIndex) {
                return buildSectionCellXml(rowNumber, columnIndex, 2, cellValue);
              })
              .join("") +
            '</row>'
        );

        rowNumber += 1;
      });
    });

    var lastRowNumber = Math.max(rowNumber - 1, 1);
    var rangeEnd = buildCellReference(lastRowNumber - 1, maxColumnCount - 1);
    var columnsXml = Array.from({ length: maxColumnCount }, function (_, columnIndex) {
      return '<col min="' + String(columnIndex + 1) + '" max="' + String(columnIndex + 1) + '" width="24" customWidth="1"/>';
    }).join("");
    var sheetViews = sections.length
      ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>'
      : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';

    return createXmlDocument(
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<dimension ref="A1:' + rangeEnd + '"/>' +
        sheetViews +
        '<sheetFormatPr defaultRowHeight="18"/>' +
        '<cols>' + columnsXml + '</cols>' +
        '<sheetData>' + sheetRows.join("") + '</sheetData>' +
        '<pageMargins left="0.5" right="0.5" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' +
      '</worksheet>'
    );
  }

  function buildWorkbookXml(sheets) {
    return createXmlDocument(
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<fileVersion appName="Copilot"/>' +
        '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="28800" windowHeight="15840"/></bookViews>' +
        '<sheets>' +
        sheets
          .map(function (sheet, index) {
            return '<sheet name="' + escapeXml(sheet.name) + '" sheetId="' + String(index + 1) + '" r:id="rId' + String(index + 1) + '"/>';
          })
          .join("") +
        '</sheets>' +
      '</workbook>'
    );
  }

  function buildWorkbookRelationshipsXml(sheetCount) {
    return createXmlDocument(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        Array.from({ length: sheetCount }, function (_, index) {
          return '<Relationship Id="rId' + String(index + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + String(index + 1) + '.xml"/>';
        }).join("") +
        '<Relationship Id="rId' + String(sheetCount + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '</Relationships>'
    );
  }

  function buildPackageRelationshipsXml() {
    return createXmlDocument(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
      '</Relationships>'
    );
  }

  function buildContentTypesXml(sheetCount) {
    var worksheetOverrides = Array.from({ length: sheetCount }, function (_, index) {
      return '<Override PartName="/xl/worksheets/sheet' + String(index + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
    }).join("");

    return createXmlDocument(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        worksheetOverrides +
      '</Types>'
    );
  }

  function buildStylesXml() {
    return createXmlDocument(
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<fonts count="2">' +
          '<font><sz val="11"/><name val="Aptos"/><family val="2"/></font>' +
          '<font><b/><sz val="11"/><name val="Aptos"/><family val="2"/></font>' +
        '</fonts>' +
        '<fills count="3">' +
          '<fill><patternFill patternType="none"/></fill>' +
          '<fill><patternFill patternType="gray125"/></fill>' +
          '<fill><patternFill patternType="solid"><fgColor rgb="FFF3D7BF"/><bgColor indexed="64"/></patternFill></fill>' +
        '</fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="3">' +
          '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' +
          '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' +
          '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' +
        '</cellXfs>' +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '</styleSheet>'
    );
  }

  function buildCorePropertiesXml() {
    var timestamp = new Date().toISOString();

    return createXmlDocument(
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
        '<dc:creator>GitHub Copilot</dc:creator>' +
        '<cp:lastModifiedBy>GitHub Copilot</cp:lastModifiedBy>' +
        '<dcterms:created xsi:type="dcterms:W3CDTF">' + timestamp + '</dcterms:created>' +
        '<dcterms:modified xsi:type="dcterms:W3CDTF">' + timestamp + '</dcterms:modified>' +
      '</cp:coreProperties>'
    );
  }

  function buildAppPropertiesXml(sheets) {
    return createXmlDocument(
      '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
        '<Application>GitHub Copilot</Application>' +
        '<DocSecurity>0</DocSecurity>' +
        '<ScaleCrop>false</ScaleCrop>' +
        '<HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>' + String(sheets.length) + '</vt:i4></vt:variant></vt:vector></HeadingPairs>' +
        '<TitlesOfParts><vt:vector size="' + String(sheets.length) + '" baseType="lpstr">' +
          sheets
            .map(function (sheet) {
              return '<vt:lpstr>' + escapeXml(sheet.name) + '</vt:lpstr>';
            })
            .join("") +
        '</vt:vector></TitlesOfParts>' +
      '</Properties>'
    );
  }

  function buildSingleSheetName(files) {
    if (files.length === 1) {
      return sanitizeSheetName(stripExtension(files[0].name || "查询结果"));
    }

    return sanitizeSheetName("查询结果");
  }

  function buildWorkbookXlsx(files) {
    var combinedSheet = {
      name: buildSingleSheetName(files),
    };
    var sheets = [combinedSheet];
    var sections = files.flatMap(function (file) {
      return file.tables.map(function (table) {
        return {
          columns: table.columns,
          rows: table.rows,
        };
      });
    });

    var entries = [
      {
        name: "[Content_Types].xml",
        data: encodeUtf8(buildContentTypesXml(sheets.length)),
      },
      {
        name: "_rels/.rels",
        data: encodeUtf8(buildPackageRelationshipsXml()),
      },
      {
        name: "docProps/app.xml",
        data: encodeUtf8(buildAppPropertiesXml(sheets)),
      },
      {
        name: "docProps/core.xml",
        data: encodeUtf8(buildCorePropertiesXml()),
      },
      {
        name: "xl/workbook.xml",
        data: encodeUtf8(buildWorkbookXml(sheets)),
      },
      {
        name: "xl/_rels/workbook.xml.rels",
        data: encodeUtf8(buildWorkbookRelationshipsXml(sheets.length)),
      },
      {
        name: "xl/styles.xml",
        data: encodeUtf8(buildStylesXml()),
      },
    ];

    entries.push({
      name: "xl/worksheets/sheet1.xml",
      data: encodeUtf8(buildWorksheetXml(sections)),
    });

    return createZip(entries);
  }

  return {
    parseSqlServerExport: parseSqlServerExport,
    buildWorkbookXlsx: buildWorkbookXlsx,
  };
});
