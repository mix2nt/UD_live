type SaveMessage = {
  type: 'save-table';
  title: string;
  markerNumber: number | string;
};

type ActiveTag = {
  label: string;
  value: string;
};

type ActiveMarkerRecord = {
  nodeId: string;
  number: number;
  title: string;
  tags: ActiveTag[];
};

type DescriptionTableRow = {
  item: string;
  description: string;
  fontStyle: 'Bold' | 'Regular';
};

type TableFieldRecord = {
  kind: 'Title' | 'Dot' | 'Dash';
  label: string;
  value: string;
};

type TableEntryRecord = {
  number: number;
  title: string;
  fields: TableFieldRecord[];
};

type CommittedMarkerLink = {
  nodeId: string;
  tableId: string;
  kind: 'main' | 'sub';
  itemLabel: string;
};

type UiMessage =
  | SaveMessage
  | { type: 'create-marker'; markerLabel?: string }
  | { type: 'create-title-marker'; markerLabel: string; parentNodeId: string }
  | { type: 'delete-title-marker'; markerLabel: string; parentNodeId: string }
  | { type: 'build-table'; rows: DescriptionTableRow[]; entries?: TableEntryRecord[]; tableId?: string | null }
  | { type: 'reorder-markers'; order: string[] }
  | { type: 'reorder-title-markers'; parentNodeId: string; order: string[] }
  | { type: 'toggle-add-mode'; active: boolean }
  | { type: 'save-active-item'; nodeId: string; title: string; tags: ActiveTag[] }
  | { type: 'delete-active-item'; nodeId: string }
  | { type: 'marker-ready'; markerNumber: number | string; title: string; nodeId: string }
  | { type: 'table-created'; nodeId: string }
  | { type: 'load-table-data'; tableId: string; entries: TableEntryRecord[] }
  | { type: 'active-list-updated'; records: ActiveMarkerRecord[] };

/// <reference types="@figma/plugin-typings" />

let markerSequence = 1;
let subMarkerSequence = 1;
let activeMarker: FrameNode | null = null;
let activeMarkers: ActiveMarkerRecord[] = [];
let committedMarkerIds = new Set<string>();
let committedMarkerLinks: CommittedMarkerLink[] = [];
let subMarkerRegistry: { nodeId: string; parentNodeId: string }[] = [];
let nextNumber = 1;
let addModeActive = false;
let suppressSelectionLoad = false;
let lastMarkerNodeId: string | null = null;
let lastAnchorSelectionId: string | null = null;
let currentGroupScreenName: string | null = null;
let currentGroupScreenNodeId: string | null = null;
const MARKER_STACK_GAP = 16;
let watchedTableId: string | null = null;
let watchedTableSnapshot: string | null = null;

const subMarkerParentKey = 'subMarkerParentId';
const subMarkerNumberKey = 'subMarkerNumber';
const memoTableFlagKey = 'isMemoTable';
const memoTableDataKey = 'memoTableEntries';
const memoTableScreenNodeIdKey = 'memoTableScreenNodeId';
const coachMarkStorageKey = 'nwdaToolbarCoachMarkDismissedV2';

function getNextMarkerNumber(): number {
  const highestNumber = activeMarkers.reduce((max, record) => Math.max(max, record.number), 0);
  const next = highestNumber + 1;
  nextNumber = next;
  return next;
}

async function loadFonts(): Promise<void> {
  await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
  await figma.loadFontAsync({ family: 'Inter', style: 'Bold' });
  await figma.loadFontAsync({ family: 'Inter', style: 'Semi Bold' });
}

function getMarkerTextNode(marker: FrameNode): TextNode | null {
  const found = marker.findOne((child) => child.type === 'TEXT' && child.name === 'Number');
  return found && found.type === 'TEXT' ? found : null;
}

function centerMarkerText(marker: FrameNode, textNode: TextNode): void {
  textNode.textAlignHorizontal = 'CENTER';
  textNode.textAlignVertical = 'CENTER';
  textNode.textAutoResize = 'NONE';
  textNode.resize(marker.width, marker.height);
  textNode.x = 0;
  textNode.y = 0;
}

function updateMarkerNumberText(marker: FrameNode, number: number): void {
  const textNode = getMarkerTextNode(marker);
  if (!textNode) {
    return;
  }

  textNode.characters = String(number);
  textNode.fontSize = 18;
  textNode.fontName = { family: 'Inter', style: 'Bold' };
  centerMarkerText(marker, textNode);
}

function updateSubMarkerText(marker: FrameNode, markerLabel: string): void {
  const textNode = getMarkerTextNode(marker);
  if (!textNode) {
    return;
  }

  textNode.characters = markerLabel;
  textNode.fontSize = 14;
  textNode.fontName = { family: 'Inter', style: 'Bold' };
  centerMarkerText(marker, textNode);
}

function syncSubMarkers(parentNodeId: string, parentNumber: number): void {
  const subMarkers = figma.currentPage.findAll((node) => {
    return node.type === 'FRAME' && node.getPluginData(subMarkerParentKey) === parentNodeId;
  }) as FrameNode[];

  subMarkers.sort((first, second) => {
    const firstNumber = Number(first.getPluginData(subMarkerNumberKey));
    const secondNumber = Number(second.getPluginData(subMarkerNumberKey));
    return firstNumber - secondNumber;
  });

  subMarkers.forEach((marker, index) => {
    const nextLabel = `${parentNumber}-${index + 1}`;
    marker.setPluginData(subMarkerNumberKey, String(index + 1));
    marker.name = `Sub Marker ${nextLabel}`;
    updateSubMarkerText(marker, nextLabel);
  });

  figma.ui.postMessage({
    type: 'sub-markers-updated',
    parentNodeId,
    labels: subMarkers.map((marker) => getMarkerTextNode(marker)?.characters || '')
  });
}

function reorderSubMarkers(parentNodeId: string, order: string[]): void {
  const subMarkers = figma.currentPage.findAll((node) => {
    return node.type === 'FRAME' && node.getPluginData(subMarkerParentKey) === parentNodeId;
  }) as FrameNode[];

  const indexMap = new Map(order.map((label, index) => [label, index]));

  subMarkers.forEach((marker) => {
    const currentLabel = getMarkerTextNode(marker)?.characters || '';
    const position = indexMap.has(currentLabel) ? indexMap.get(currentLabel)! : Number.MAX_SAFE_INTEGER;
    marker.setPluginData(subMarkerNumberKey, String(position + 1));
  });

  const parent = activeMarkers.find((item) => item.nodeId === parentNodeId);
  const parentNumber = parent ? parent.number : 1;
  syncSubMarkers(parentNodeId, parentNumber);
}

function removeSubMarker(parentNodeId: string, markerLabel: string): void {
  const target = figma.currentPage.findOne((node) => {
    if (node.type !== 'FRAME' || node.getPluginData(subMarkerParentKey) !== parentNodeId) {
      return false;
    }

    const textNode = getMarkerTextNode(node);
    return textNode !== null && textNode.characters === markerLabel;
  });

  if (target && target.type === 'FRAME') {
    subMarkerRegistry = subMarkerRegistry.filter((item) => item.nodeId !== target.id);
    target.remove();
  }

  const parent = activeMarkers.find((item) => item.nodeId === parentNodeId);
  if (parent) {
    syncSubMarkers(parentNodeId, parent.number);
  }
}

function syncActiveListToUi(): void {
  const sorted = [...activeMarkers].sort((a, b) => a.number - b.number);
  activeMarkers = sorted;
  figma.ui.postMessage({ type: 'active-list-updated', records: sorted });
}

function reindexActiveMarkers(): void {
  activeMarkers = [...activeMarkers]
    .sort((a, b) => a.number - b.number)
    .map((record, index) => ({ ...record, number: index + 1 }));

  nextNumber = activeMarkers.length > 0 ? Math.max(...activeMarkers.map((item) => item.number)) + 1 : 1;

  activeMarkers.forEach((item) => {
    const marker = figma.getNodeById(item.nodeId) as FrameNode | null;
    if (marker) {
      updateMarkerNumberText(marker, item.number);
      marker.name = `Marker ${item.number}`;
    }
    syncSubMarkers(item.nodeId, item.number);
  });

  syncActiveListToUi();
}

function reorderActiveMarkers(order: string[]): void {
  const indexMap = new Map(order.map((nodeId, index) => [nodeId, index]));

  activeMarkers = [...activeMarkers]
    .sort((a, b) => {
      const aIndex = indexMap.has(a.nodeId) ? indexMap.get(a.nodeId)! : Number.MAX_SAFE_INTEGER;
      const bIndex = indexMap.has(b.nodeId) ? indexMap.get(b.nodeId)! : Number.MAX_SAFE_INTEGER;
      return aIndex - bIndex;
    })
    .map((record, index) => ({ ...record, number: index + 1 }));

  nextNumber = activeMarkers.length > 0 ? Math.max(...activeMarkers.map((item) => item.number)) + 1 : 1;

  activeMarkers.forEach((item) => {
    const marker = figma.getNodeById(item.nodeId) as FrameNode | null;
    if (marker) {
      updateMarkerNumberText(marker, item.number);
      marker.name = `Marker ${item.number}`;
    }
    syncSubMarkers(item.nodeId, item.number);
  });

  syncActiveListToUi();
}

function registerActiveMarker(marker: FrameNode, assignedNumber: number): void {
  const existingIndex = activeMarkers.findIndex((item) => item.nodeId === marker.id);
  if (existingIndex >= 0) {
    activeMarkers[existingIndex] = { ...activeMarkers[existingIndex], number: assignedNumber };
  } else {
    activeMarkers.push({ nodeId: marker.id, number: assignedNumber, title: '', tags: [] });
  }

  const refresh = [...activeMarkers].sort((a, b) => a.number - b.number);
  activeMarkers = refresh;
  figma.ui.postMessage({ type: 'active-list-updated', records: refresh });
}

function removeActiveMarker(nodeId: string): void {
  const target = activeMarkers.find((item) => item.nodeId === nodeId);
  if (!target) {
    return;
  }

  const node = figma.getNodeById(nodeId) as FrameNode | null;
  if (node) {
    node.remove();
  }

  activeMarkers = activeMarkers.filter((item) => item.nodeId !== nodeId);
  reindexActiveMarkers();
}

async function createMarker(number: number | string, x: number, y: number): Promise<FrameNode> {
  await loadFonts();

  const marker = figma.createFrame();
  const markerText = String(number);

  marker.name = `Marker ${markerText}`;
  marker.resize(48, 48);
  marker.x = x - 24;
  marker.y = y - 24;
  marker.cornerRadius = 24;
  marker.fills = [{ type: 'SOLID', color: { r: 0.18, g: 0.46, b: 0.96 } }];
  marker.strokes = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 }, opacity: 1 }];
  marker.strokeWeight = 2;
  marker.clipsContent = false;

  const text = figma.createText();
  text.name = 'Number';
  text.characters = markerText;
  text.fontSize = markerText.includes('-') ? 14 : 18;
  text.fontName = { family: 'Inter', style: 'Bold' };
  text.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
  centerMarkerText(marker, text);
  text.visible = true;

  marker.appendChild(text);
  figma.currentPage.appendChild(marker);
  activeMarker = marker;

  marker.locked = false;
  marker.visible = true;
  text.visible = true;
  figma.viewport.scrollAndZoomIntoView([marker]);

  return marker;
}

function memoTableTitle(title: string): string {
  const cleaned = title.trim();
  return cleaned.length > 0 ? cleaned : 'Untitled';
}

async function buildMemoTable(title: string, markerNumber: number | string): Promise<FrameNode> {
  await loadFonts();
  const table = figma.createFrame();
  const safeTitle = memoTableTitle(title);

  table.name = 'Memo Table';
  table.resize(420, 230);
  table.x = figma.viewport.center.x - 210;
  table.y = figma.viewport.center.y - 115;
  table.cornerRadius = 12;
  table.fills = [{ type: 'SOLID', color: { r: 0.99, g: 0.99, b: 1 } }];
  table.strokes = [{ type: 'SOLID', color: { r: 0.84, g: 0.88, b: 0.95 }, opacity: 1 }];
  table.strokeWeight = 1;

  const header = figma.createFrame();
  header.name = 'Header';
  header.resize(420, 58);
  header.fills = [{ type: 'SOLID', color: { r: 0.9, g: 0.94, b: 1 } }];
  header.cornerRadius = 12;
  header.x = 0;
  header.y = 0;
  table.appendChild(header);

  const headerText = figma.createText();
  headerText.name = 'Title';
  headerText.characters = safeTitle;
  headerText.fontSize = 18;
  headerText.fontName = { family: 'Inter', style: 'Bold' };
  headerText.fills = [{ type: 'SOLID', color: { r: 0.09, g: 0.16, b: 0.3 } }];
  headerText.x = 18;
  headerText.y = 16;
  header.appendChild(headerText);

  const rows = [
    ['Number', String(markerNumber)],
    ['Title', safeTitle],
    ['Dot', '•'],
    ['Dash', '—'],
    ['Phrase', 'Summary phrase']
  ];

  for (let i = 0; i < rows.length; i += 1) {
    const [label, value] = rows[i];
    const row = figma.createFrame();
    row.name = `Row ${i + 1}`;
    row.resize(420, 34);
    row.x = 0;
    row.y = 62 + i * 34;
    row.fills = i % 2 === 0
      ? [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }]
      : [{ type: 'SOLID', color: { r: 0.97, g: 0.98, b: 1 } }];
    table.appendChild(row);

    const labelText = figma.createText();
    labelText.name = 'Label';
    labelText.characters = label;
    labelText.fontSize = 12;
    labelText.fontName = { family: 'Inter', style: 'Semi Bold' };
    labelText.fills = [{ type: 'SOLID', color: { r: 0.34, g: 0.38, b: 0.46 } }];
    labelText.x = 18;
    labelText.y = 8;
    row.appendChild(labelText);

    const valueText = figma.createText();
    valueText.name = 'Value';
    valueText.characters = value;
    valueText.fontSize = 13;
    valueText.fontName = { family: 'Inter', style: 'Regular' };
    valueText.fills = [{ type: 'SOLID', color: { r: 0.13, g: 0.17, b: 0.24 } }];
    valueText.x = 140;
    valueText.y = 8;
    row.appendChild(valueText);
  }

  figma.currentPage.appendChild(table);
  figma.currentPage.selection = [table];
  figma.viewport.scrollAndZoomIntoView([table]);

  return table;
}

function buildFallbackEntries(sorted: ActiveMarkerRecord[]): TableEntryRecord[] {
  return sorted.map((record) => ({
    number: record.number,
    title: record.title || 'Untitled',
    fields: record.tags.map((tag) => ({ kind: 'Dot' as const, label: tag.label, value: tag.value }))
  }));
}

async function renderMemoTableFrame(
  table: FrameNode,
  isNewTable: boolean,
  x: number,
  y: number,
  rows: DescriptionTableRow[],
  persistedEntries: TableEntryRecord[]
): Promise<void> {
  await loadFonts();

  const tableWidth = 420;
  const itemX = 18;
  const itemSize = 28.8;
  const descriptionX = itemX + itemSize + 10;
  const descriptionRightPadding = 18;
  const descriptionWidth = tableWidth - descriptionX - descriptionRightPadding;
  const bulletDescriptionWidth = tableWidth - itemX - descriptionRightPadding;
  const minRowHeight = 44;
  const rowVerticalPadding = 30;
  const headerHeight = 62;

  if (!isNewTable) {
    [...table.children].forEach((child) => child.remove());
  }

  if (isNewTable) {
    table.name = currentGroupScreenName || 'Memo Table';
    table.setPluginData(memoTableScreenNodeIdKey, currentGroupScreenNodeId || '');
  }
  table.resize(tableWidth, headerHeight + rows.length * minRowHeight);
  table.cornerRadius = 12;
  table.fills = [{ type: 'SOLID', color: { r: 0.99, g: 0.99, b: 1 } }];
  table.strokes = [{ type: 'SOLID', color: { r: 0.84, g: 0.88, b: 0.95 }, opacity: 1 }];
  table.strokeWeight = 1;

  const header = figma.createFrame();
  header.name = 'Header';
  header.resize(420, 58);
  header.fills = [{ type: 'SOLID', color: { r: 0.9, g: 0.94, b: 1 } }];
  header.topLeftRadius = 12;
  header.topRightRadius = 12;
  header.bottomLeftRadius = 0;
  header.bottomRightRadius = 0;
  header.x = 0;
  header.y = 0;
  table.appendChild(header);

  const headerText = figma.createText();
  headerText.name = 'item';
  headerText.characters = 'item';
  headerText.fontSize = 18;
  headerText.fontName = { family: 'Inter', style: 'Bold' };
  headerText.fills = [{ type: 'SOLID', color: { r: 0.09, g: 0.16, b: 0.3 } }];
  headerText.x = itemX;
  headerText.y = 16;
  header.appendChild(headerText);

  const descriptionHeader = figma.createText();
  descriptionHeader.name = 'UX Description';
  descriptionHeader.characters = 'UX Description';
  descriptionHeader.fontSize = 18;
  descriptionHeader.fontName = { family: 'Inter', style: 'Bold' };
  descriptionHeader.fills = [{ type: 'SOLID', color: { r: 0.09, g: 0.16, b: 0.3 } }];
  descriptionHeader.x = descriptionX;
  descriptionHeader.y = 16;
  header.appendChild(descriptionHeader);

  let currentY = headerHeight;

  rows.forEach((record, index) => {
    const row = figma.createFrame();
    row.name = `Row ${index + 1}`;
    row.x = 0;
    row.fills = index % 2 === 0
      ? [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }]
      : [{ type: 'SOLID', color: { r: 0.97, g: 0.98, b: 1 } }];
    table.appendChild(row);

    const isBulletRow = record.item === '·' || record.item === '-' || record.item === '—';

    const descriptionText = figma.createText();
    descriptionText.name = 'UX Description';
    descriptionText.fontSize = 14;
    descriptionText.fontName = { family: 'Inter', style: record.fontStyle };
    descriptionText.characters = record.description;
    descriptionText.fills = [{ type: 'SOLID', color: { r: 0.13, g: 0.17, b: 0.24 } }];
    descriptionText.textAutoResize = 'HEIGHT';
    descriptionText.resize(isBulletRow ? bulletDescriptionWidth : descriptionWidth, descriptionText.height);

    const rowHeight = Math.max(minRowHeight, descriptionText.height + rowVerticalPadding);
    row.resize(tableWidth, rowHeight);
    row.y = currentY;

    const itemMarker = figma.createFrame();
    itemMarker.name = 'item';
    itemMarker.resize(itemSize, itemSize);
    itemMarker.x = itemX;
    itemMarker.y = (rowHeight - itemSize) / 2;
    itemMarker.cornerRadius = itemSize / 2;
    itemMarker.fills = [{ type: 'SOLID', color: { r: 0.58, g: 0.77, b: 1 } }];
    itemMarker.strokes = [{ type: 'SOLID', color: { r: 0.75, g: 0.86, b: 1 }, opacity: 1 }];
    itemMarker.strokeWeight = 1;
    itemMarker.visible = !isBulletRow;
    row.appendChild(itemMarker);

    const itemText = figma.createText();
    itemText.name = 'item number';
    itemText.characters = record.item;
    itemText.fontSize = 12.8;
    itemText.fontName = { family: 'Inter', style: 'Bold' };
    itemText.fills = [{ type: 'SOLID', color: { r: 0.12, g: 0.23, b: 0.54 } }];
    itemText.x = record.item.length > 2 ? 3 : 8;
    itemText.y = 8;
    itemMarker.appendChild(itemText);

    descriptionText.x = isBulletRow ? itemX : descriptionX;
    descriptionText.y = (rowHeight - descriptionText.height) / 2;
    row.appendChild(descriptionText);

    currentY += rowHeight;
  });

  table.resize(tableWidth, currentY + 8);
  if (isNewTable) {
    table.x = x - table.width / 2;
    table.y = y - table.height / 2;
  }

  table.setPluginData(memoTableFlagKey, 'true');
  table.setPluginData(memoTableDataKey, JSON.stringify(persistedEntries));

  if (isNewTable) {
    figma.currentPage.appendChild(table);
  }
}

function linkMarkersToTable(sorted: ActiveMarkerRecord[], tableId: string): void {
  sorted.forEach((record) => {
    committedMarkerIds.add(record.nodeId);

    committedMarkerLinks = committedMarkerLinks.filter((link) => link.nodeId !== record.nodeId);
    committedMarkerLinks.push({ nodeId: record.nodeId, tableId, kind: 'main', itemLabel: String(record.number) });

    const subMarkers = figma.currentPage.findAll((node) => {
      return node.type === 'FRAME' && node.getPluginData(subMarkerParentKey) === record.nodeId;
    }) as FrameNode[];

    subMarkers.forEach((sub) => {
      const label = getMarkerTextNode(sub)?.characters || '';
      committedMarkerLinks = committedMarkerLinks.filter((link) => link.nodeId !== sub.id);
      committedMarkerLinks.push({ nodeId: sub.id, tableId, kind: 'sub', itemLabel: label });
    });
  });
}

async function buildUnifiedMemoTable(
  x: number,
  y: number,
  descriptionRows: DescriptionTableRow[] = [],
  entries: TableEntryRecord[] = [],
  existingTableId?: string
): Promise<FrameNode | null> {
  const existing = existingTableId ? (figma.getNodeById(existingTableId) as FrameNode | null) : null;

  if (!existing && activeMarkers.length === 0 && descriptionRows.length === 0) {
    return null;
  }

  const sorted = [...activeMarkers].sort((a, b) => a.number - b.number);
  const rows = descriptionRows.length > 0
    ? descriptionRows
    : sorted.map((record) => ({
      item: String(record.number),
      description: record.title || 'Untitled',
      fontStyle: 'Bold' as const
    }));
  const persistedEntries = entries.length > 0 ? entries : buildFallbackEntries(sorted);

  const table = existing && existing.type === 'FRAME' ? existing : figma.createFrame();
  const isNewTable = table !== existing;

  await renderMemoTableFrame(table, isNewTable, x, y, rows, persistedEntries);

  suppressSelectionLoad = true;
  figma.currentPage.selection = [table];
  figma.viewport.scrollAndZoomIntoView([table]);

  linkMarkersToTable(sorted, table.id);

  activeMarkers = [];
  lastMarkerNodeId = null;
  lastAnchorSelectionId = null;
  currentGroupScreenName = null;
  currentGroupScreenNodeId = null;
  figma.ui.postMessage({ type: 'active-list-updated', records: [] });
  figma.ui.postMessage({ type: 'table-created', nodeId: table.id });

  return table;
}

async function initializePlugin(): Promise<void> {
  figma.ui.postMessage({ type: 'active-list-updated', records: [] });
  figma.ui.postMessage({ type: 'idle' });
  figma.ui.postMessage({ type: 'selection-state', hasSelection: isCreatableSelection() });
  const coachMarkDismissed = await figma.clientStorage.getAsync(coachMarkStorageKey);
  figma.ui.postMessage({ type: 'coachmark-state', dismissed: Boolean(coachMarkDismissed) });
}

function getTopLevelFrame(node: SceneNode): SceneNode | null {
  let current: SceneNode = node;
  while (current.parent && current.parent.type !== 'PAGE' && 'absoluteBoundingBox' in current.parent) {
    current = current.parent as SceneNode;
  }
  return current.parent && current.parent.type === 'PAGE' ? current : null;
}

function resolveMarkerAnchor(selected: SceneNode | null): { x: number; y: number } {
  const bounds = selected && 'absoluteBoundingBox' in selected ? selected.absoluteBoundingBox : null;
  const selectionChanged = !!selected && selected.id !== lastAnchorSelectionId;

  if (selectionChanged && bounds) {
    lastAnchorSelectionId = selected!.id;
    return { x: bounds.x, y: bounds.y };
  }

  const previous = lastMarkerNodeId ? figma.getNodeById(lastMarkerNodeId) : null;
  if (previous && previous.type === 'FRAME') {
    return {
      x: previous.x + previous.width / 2,
      y: previous.y + previous.height + MARKER_STACK_GAP + previous.height / 2
    };
  }

  if (bounds) {
    lastAnchorSelectionId = selected!.id;
    return { x: bounds.x, y: bounds.y };
  }

  return { x: figma.viewport.center.x, y: figma.viewport.center.y };
}

async function createMarkerAtPosition(x: number, y: number, label?: string): Promise<void> {
  const resolvedNumber = getNextMarkerNumber();
  const marker = await createMarker(resolvedNumber, x, y);
  registerActiveMarker(marker, resolvedNumber);
  lastMarkerNodeId = marker.id;
  figma.ui.postMessage({
    type: 'marker-ready',
    markerNumber: resolvedNumber,
    title: '',
    nodeId: marker.id
  });

  if (label && label.trim().length > 0) {
    const record = activeMarkers.find((item) => item.nodeId === marker.id);
    if (record) {
      record.title = label.trim();
    }
  }
}

async function createTitleMarkerFromSelection(markerLabel: string, parentNodeId: string): Promise<void> {
  const targetNode = figma.currentPage.selection[0] || null;
  const anchor = resolveMarkerAnchor(targetNode);

  const marker = await createMarker(markerLabel, anchor.x, anchor.y);
  marker.name = `Sub Marker ${markerLabel}`;
  marker.setPluginData(subMarkerParentKey, parentNodeId);
  marker.setPluginData(subMarkerNumberKey, markerLabel.split('-')[1] || '1');
  lastMarkerNodeId = marker.id;

  subMarkerRegistry.push({ nodeId: marker.id, parentNodeId });
  figma.ui.postMessage({
    type: 'sub-marker-ready',
    parentNodeId,
    markerLabel,
    nodeId: marker.id
  });
}

function createMarkerFromSelection(markerLabel?: string): Promise<void> {
  const targetNode = figma.currentPage.selection[0] || null;
  if (activeMarkers.length === 0 && targetNode) {
    const topFrame = getTopLevelFrame(targetNode);
    currentGroupScreenName = topFrame ? topFrame.name : null;
    currentGroupScreenNodeId = topFrame ? topFrame.id : null;
  }
  const anchor = resolveMarkerAnchor(targetNode);

  return createMarkerAtPosition(anchor.x, anchor.y, markerLabel);
}

function shouldCreateMarkerOnCanvasClick(): boolean {
  return addModeActive && figma.currentPage.selection.length > 0;
}

function isCreatableSelection(): boolean {
  const selected = figma.currentPage.selection[0];
  if (!selected) {
    return false;
  }
  if (selected.type === 'FRAME' && selected.getPluginData(memoTableFlagKey) === 'true') {
    return false;
  }
  if (selected.type === 'FRAME' && selected.name.startsWith('Marker ')) {
    return false;
  }
  if (selected.type === 'FRAME' && selected.name.startsWith('Sub Marker ')) {
    return false;
  }
  return true;
}

figma.showUI(__html__, {
  width: 480,
  height: 720
});

function readRowsFromTable(table: FrameNode): DescriptionTableRow[] {
  const rowFrames = table.children.filter(
    (child): child is FrameNode => child.type === 'FRAME' && /^Row \d+$/.test(child.name)
  );

  rowFrames.sort((a, b) => a.y - b.y);

  const rows: DescriptionTableRow[] = [];

  rowFrames.forEach((row) => {
    const itemFrame = row.children.find(
      (child): child is FrameNode => child.type === 'FRAME' && child.name === 'item'
    );
    const itemText = itemFrame?.children.find(
      (child): child is TextNode => child.type === 'TEXT' && child.name === 'item number'
    );
    const descriptionText = row.children.find(
      (child): child is TextNode => child.type === 'TEXT' && child.name === 'UX Description'
    );

    if (!itemText || !descriptionText) {
      return;
    }

    const fontName = descriptionText.fontName;
    const fontStyle: 'Bold' | 'Regular' =
      typeof fontName === 'object' && fontName.style === 'Bold' ? 'Bold' : 'Regular';

    rows.push({
      item: itemText.characters,
      description: descriptionText.characters,
      fontStyle
    });
  });

  return rows;
}

function rowsToEntries(rows: DescriptionTableRow[]): TableEntryRecord[] {
  const entries: TableEntryRecord[] = [];
  let current: TableEntryRecord | null = null;

  rows.forEach((row) => {
    const item = row.item.trim();

    if (item === '·') {
      current?.fields.push({ kind: 'Dot', label: '·', value: row.description });
      return;
    }

    if (item === '-' || item === '—') {
      current?.fields.push({ kind: 'Dash', label: '-', value: row.description });
      return;
    }

    if (/^\d+-\d+$/.test(item)) {
      current?.fields.push({ kind: 'Title', label: item, value: row.description });
      return;
    }

    const number = Number(item);
    if (Number.isFinite(number) && number > 0) {
      current = { number, title: row.description, fields: [] };
      entries.push(current);
    }
  });

  return entries;
}

function readStoredEntries(node: FrameNode): TableEntryRecord[] {
  const raw = node.getPluginData(memoTableDataKey);
  if (!raw) {
    return [];
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    return [];
  }
}

function readCurrentTableEntries(node: FrameNode): TableEntryRecord[] {
  const liveRows = readRowsFromTable(node);
  return liveRows.length > 0 ? rowsToEntries(liveRows) : readStoredEntries(node);
}

const CIRCLED_NUMBERS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳'];

function formatItemNumber(n: number): string {
  return n >= 1 && n <= CIRCLED_NUMBERS.length ? CIRCLED_NUMBERS[n - 1] : `${n})`;
}

function buildFigmaUrl(nodeId: string): string {
  const fileName = encodeURIComponent(figma.root.name);
  return `https://www.figma.com/file/${figma.fileKey}/${fileName}?node-id=${encodeURIComponent(nodeId)}`;
}

function buildTableMarkdown(table: FrameNode, entries: TableEntryRecord[]): string {
  const lines: string[] = [];

  lines.push(`# ${table.name}`);
  lines.push('');

  const screenNodeId = table.getPluginData(memoTableScreenNodeIdKey);
  if (screenNodeId && figma.getNodeById(screenNodeId)) {
    lines.push(`> **Figma:** [View in Figma ↗](${buildFigmaUrl(screenNodeId)})`);
    lines.push('');
  }

  lines.push('---');

  entries.forEach((entry) => {
    lines.push('');
    const mainLink = committedMarkerLinks.find(
      (link) => link.tableId === table.id && link.kind === 'main' && link.itemLabel === String(entry.number)
    );
    lines.push(`#### ${formatItemNumber(entry.number)} ${entry.title}`);
    if (mainLink) {
      lines.push(`[View in Figma ↗](${buildFigmaUrl(mainLink.nodeId)})`);
    }
    lines.push('');

    let indentActive = false;
    entry.fields.forEach((field) => {
      if (field.kind === 'Title') {
        const subLink = committedMarkerLinks.find(
          (link) => link.tableId === table.id && link.kind === 'sub' && link.itemLabel === field.label
        );
        lines.push(`- **Sub ${field.label}:** ${field.value}`);
        if (subLink) {
          lines.push(`  [↗](${buildFigmaUrl(subLink.nodeId)})`);
        }
        indentActive = true;
      } else {
        const indent = indentActive ? '  ' : '';
        lines.push(`${indent}- ${field.value}`);
      }
    });
  });

  return lines.join('\n');
}

function notifyTableSelection(node: FrameNode): void {
  const entries = readCurrentTableEntries(node);
  watchedTableId = node.id;
  watchedTableSnapshot = JSON.stringify(entries);
  figma.ui.postMessage({ type: 'load-table-data', tableId: node.id, entries });
}

function removeMarkersForVanishedRows(
  tableId: string,
  previousEntries: TableEntryRecord[],
  currentEntries: TableEntryRecord[]
): void {
  const currentNumbers = new Set(currentEntries.map((entry) => entry.number));
  const currentSubLabels = new Set(
    currentEntries.flatMap((entry) => entry.fields.filter((field) => field.kind === 'Title').map((field) => field.label))
  );

  previousEntries.forEach((entry) => {
    const mainRemoved = !currentNumbers.has(entry.number);

    if (mainRemoved) {
      const link = committedMarkerLinks.find(
        (item) => item.tableId === tableId && item.kind === 'main' && item.itemLabel === String(entry.number)
      );
      const marker = link ? (figma.getNodeById(link.nodeId) as FrameNode | null) : null;
      if (marker) {
        marker.remove();
      }
      return;
    }

    entry.fields.forEach((field) => {
      if (field.kind !== 'Title' || currentSubLabels.has(field.label)) {
        return;
      }
      const subLink = committedMarkerLinks.find(
        (item) => item.tableId === tableId && item.kind === 'sub' && item.itemLabel === field.label
      );
      const marker = subLink ? (figma.getNodeById(subLink.nodeId) as FrameNode | null) : null;
      if (marker) {
        marker.remove();
      }
    });
  });
}

function entriesToFlatRows(entries: TableEntryRecord[]): DescriptionTableRow[] {
  const flatRows: DescriptionTableRow[] = [];
  entries.forEach((entry) => {
    flatRows.push({ item: String(entry.number), description: entry.title, fontStyle: 'Bold' });
    entry.fields.forEach((field) => {
      flatRows.push({
        item: field.label,
        description: field.value,
        fontStyle: field.kind === 'Title' ? 'Bold' : 'Regular'
      });
    });
  });
  return flatRows;
}

function syncWatchedTableLive(): void {
  if (!watchedTableId) {
    return;
  }

  const table = figma.getNodeById(watchedTableId) as FrameNode | null;
  if (!table || table.type !== 'FRAME') {
    watchedTableId = null;
    watchedTableSnapshot = null;
    return;
  }

  const entries = readCurrentTableEntries(table);
  const snapshot = JSON.stringify(entries);
  if (snapshot === watchedTableSnapshot) {
    return;
  }

  const previousEntries: TableEntryRecord[] = watchedTableSnapshot ? JSON.parse(watchedTableSnapshot) : [];
  removeMarkersForVanishedRows(table.id, previousEntries, entries);

  watchedTableSnapshot = snapshot;
  figma.ui.postMessage({ type: 'load-table-data', tableId: table.id, entries });

  void renderMemoTableFrame(
    table,
    false,
    table.x + table.width / 2,
    table.y + table.height / 2,
    entriesToFlatRows(entries),
    entries
  );
}

async function syncTableAfterMarkerRemoval(tableId: string, removedLinks: CommittedMarkerLink[]): Promise<void> {
  const table = figma.getNodeById(tableId) as FrameNode | null;
  if (!table || table.type !== 'FRAME') {
    return;
  }

  const liveRows = readRowsFromTable(table);
  const entries = liveRows.length > 0 ? rowsToEntries(liveRows) : readStoredEntries(table);

  const removedNumbers = new Set(
    removedLinks.filter((link) => link.kind === 'main').map((link) => Number(link.itemLabel))
  );
  const removedSubLabels = new Set(
    removedLinks.filter((link) => link.kind === 'sub').map((link) => link.itemLabel)
  );

  let nextEntries = entries
    .filter((entry) => !removedNumbers.has(entry.number))
    .map((entry) => ({
      ...entry,
      fields: entry.fields.filter((field) => !(field.kind === 'Title' && removedSubLabels.has(field.label)))
    }));

  removedLinks.forEach((link) => {
    if (link.kind !== 'main') {
      return;
    }
    const orphanSubMarkers = figma.currentPage.findAll((node) => {
      return node.type === 'FRAME' && node.getPluginData(subMarkerParentKey) === link.nodeId;
    }) as FrameNode[];
    orphanSubMarkers.forEach((sub) => {
      committedMarkerLinks = committedMarkerLinks.filter((item) => item.nodeId !== sub.id);
      sub.remove();
    });
  });

  const remainingMainLinks = committedMarkerLinks
    .filter((link) => link.tableId === tableId && link.kind === 'main')
    .sort((a, b) => Number(a.itemLabel) - Number(b.itemLabel));

  const numberMap = new Map<number, number>();
  const subLabelRenameMap = new Map<string, string>();

  remainingMainLinks.forEach((link, index) => {
    const oldNumber = Number(link.itemLabel);
    const newNumber = index + 1;
    numberMap.set(oldNumber, newNumber);

    const marker = figma.getNodeById(link.nodeId) as FrameNode | null;
    const subMarkers = figma.currentPage.findAll((node) => {
      return node.type === 'FRAME' && node.getPluginData(subMarkerParentKey) === link.nodeId;
    }) as FrameNode[];
    const oldSubLabels = new Map(subMarkers.map((sub) => [sub.id, getMarkerTextNode(sub)?.characters || '']));

    if (marker && oldNumber !== newNumber) {
      updateMarkerNumberText(marker, newNumber);
      marker.name = `Marker ${newNumber}`;
    }
    link.itemLabel = String(newNumber);

    syncSubMarkers(link.nodeId, newNumber);

    subMarkers.forEach((sub) => {
      const oldLabel = oldSubLabels.get(sub.id) || '';
      const newLabel = getMarkerTextNode(sub)?.characters || oldLabel;
      if (oldLabel && oldLabel !== newLabel) {
        subLabelRenameMap.set(oldLabel, newLabel);
      }
      const subLink = committedMarkerLinks.find((item) => item.nodeId === sub.id);
      if (subLink) {
        subLink.itemLabel = newLabel;
      }
    });
  });

  nextEntries = nextEntries
    .map((entry) => ({
      ...entry,
      number: numberMap.get(entry.number) ?? entry.number,
      fields: entry.fields.map((field) => {
        if (field.kind !== 'Title') {
          return field;
        }
        return { ...field, label: subLabelRenameMap.get(field.label) || field.label };
      })
    }))
    .sort((a, b) => a.number - b.number);

  await renderMemoTableFrame(
    table,
    false,
    table.x + table.width / 2,
    table.y + table.height / 2,
    entriesToFlatRows(nextEntries),
    nextEntries
  );
}

function notifyMarkerSelectionForPanel(mainNodeId: string, selectedNodeId: string): void {
  const isActiveDraft = activeMarkers.some((item) => item.nodeId === mainNodeId);
  if (isActiveDraft) {
    figma.ui.postMessage({ type: 'activate-marker', nodeId: mainNodeId });
    return;
  }

  const link = committedMarkerLinks.find((item) => item.nodeId === selectedNodeId);
  if (link) {
    figma.ui.postMessage({
      type: 'activate-marker-by-label',
      tableId: link.tableId,
      kind: link.kind,
      itemLabel: link.itemLabel
    });
  }
}

figma.on('selectionchange', async () => {
  const selected = figma.currentPage.selection[0];

  figma.ui.postMessage({ type: 'selection-state', hasSelection: isCreatableSelection() });

  if (selected && selected.type === 'FRAME' && selected.getPluginData(memoTableFlagKey) === 'true') {
    if (suppressSelectionLoad) {
      suppressSelectionLoad = false;
    } else {
      notifyTableSelection(selected);
    }
    return;
  }

  if (selected && selected.type === 'FRAME' && selected.name.startsWith('Marker ')) {
    notifyMarkerSelectionForPanel(selected.id, selected.id);
    return;
  }

  if (selected && selected.type === 'FRAME' && selected.name.startsWith('Sub Marker ')) {
    const parentId = selected.getPluginData(subMarkerParentKey) || selected.id;
    notifyMarkerSelectionForPanel(parentId, selected.id);
    return;
  }

  if (!shouldCreateMarkerOnCanvasClick()) {
    return;
  }

  if (!selected) {
    return;
  }

  if (selected.type === 'FRAME' && selected.name.startsWith('Marker ')) {
    return;
  }

  if (selected.type === 'FRAME' && selected.name.startsWith('Sub Marker ')) {
    return;
  }

  const bounds = selected.absoluteBoundingBox;
  if (!bounds) {
    return;
  }

  await createMarkerAtPosition(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
});

figma.on('documentchange', () => {
  const missing = activeMarkers.filter((item) => figma.getNodeById(item.nodeId) === null);
  if (missing.length > 0) {
    activeMarkers = activeMarkers.filter((item) => figma.getNodeById(item.nodeId) !== null);
    reindexActiveMarkers();
  }

  const missingSubMarkers = subMarkerRegistry.filter((item) => figma.getNodeById(item.nodeId) === null);
  if (missingSubMarkers.length > 0) {
    subMarkerRegistry = subMarkerRegistry.filter((item) => figma.getNodeById(item.nodeId) !== null);
    missingSubMarkers.forEach((item) => {
      figma.ui.postMessage({
        type: 'sub-marker-removed',
        parentNodeId: item.parentNodeId,
        nodeId: item.nodeId
      });
    });
  }

  activeMarkers.forEach((item) => syncSubMarkers(item.nodeId, item.number));

  const missingCommittedLinks = committedMarkerLinks.filter((link) => figma.getNodeById(link.nodeId) === null);
  if (missingCommittedLinks.length > 0) {
    committedMarkerLinks = committedMarkerLinks.filter((link) => figma.getNodeById(link.nodeId) !== null);

    const tableGroups = new Map<string, CommittedMarkerLink[]>();
    missingCommittedLinks.forEach((link) => {
      const list = tableGroups.get(link.tableId) || [];
      list.push(link);
      tableGroups.set(link.tableId, list);
    });

    tableGroups.forEach((links, tableId) => {
      syncTableAfterMarkerRemoval(tableId, links);
    });
  }

  syncWatchedTableLive();
});

figma.on('drop' as any, async (event: any) => {
  const metadata = event?.dropMetadata ?? {};
  const dragType = metadata.type ?? metadata.data ?? null;

  if (dragType === 'application/x-ud-marker') {
    await createMarkerAtPosition(event.absoluteX, event.absoluteY);
    return;
  }

  if (dragType === 'application/x-ud-table') {
    await buildUnifiedMemoTable(event.absoluteX, event.absoluteY);
  }
});

figma.on('run', () => {
  initializePlugin();
});

figma.ui.onmessage = async (msg) => {
  if (!msg || typeof msg !== 'object') {
    return;
  }

  if (msg.type === 'toggle-add-mode') {
    addModeActive = Boolean(msg.active);
    return;
  }

  if (msg.type === 'dismiss-coachmark') {
    await figma.clientStorage.setAsync(coachMarkStorageKey, true);
    return;
  }

  if (msg.type === 'reset-coachmark') {
    await figma.clientStorage.deleteAsync(coachMarkStorageKey);
    return;
  }

  if (msg.type === 'request-export-tables') {
    const tables = (figma.currentPage.findAll(
      (node) => node.type === 'FRAME' && node.getPluginData(memoTableFlagKey) === 'true'
    ) as FrameNode[]).map((node) => ({ id: node.id, name: node.name }));
    figma.ui.postMessage({ type: 'export-tables-list', tables });
    return;
  }

  if (msg.type === 'show-toast') {
    const payload = msg as { type: 'show-toast'; message: string; error?: boolean };
    figma.notify(payload.message, payload.error ? { error: true } : undefined);
    return;
  }

  if (msg.type === 'generate-export-markdown') {
    const payload = msg as { type: 'generate-export-markdown'; tableIds: string[] };
    const blocks = payload.tableIds
      .map((tableId) => figma.getNodeById(tableId))
      .filter((node): node is FrameNode => !!node && node.type === 'FRAME')
      .map((table) => buildTableMarkdown(table, readCurrentTableEntries(table)));
    figma.ui.postMessage({ type: 'export-markdown-ready', markdown: blocks.join('\n\n---\n\n') });
    return;
  }

  if (msg.type === 'save-table') {
    const payload = msg as SaveMessage;
    const table = await buildMemoTable(payload.title, payload.markerNumber);
    figma.ui.postMessage({ type: 'table-created', nodeId: table.id });
    return;
  }

  if (msg.type === 'save-active-item') {
    const payload = msg as {
      type: 'save-active-item';
      nodeId: string;
      title: string;
      tags: ActiveTag[];
      markerNumber?: number;
    };
    const target = activeMarkers.find((item) => item.nodeId === payload.nodeId);
    if (!target) {
      return;
    }

    const nextNumberValue = Number.isFinite(payload.markerNumber) && Number(payload.markerNumber) > 0
      ? Number(payload.markerNumber)
      : target.number;
    target.number = nextNumberValue;
    target.title = payload.title.trim().length > 0 ? payload.title.trim() : 'Untitled';
    target.tags = payload.tags ?? [];

    const node = figma.getNodeById(payload.nodeId) as FrameNode | null;
    if (node) {
      updateMarkerNumberText(node, target.number);
      node.name = `Marker ${target.number}`;
    }

    reindexActiveMarkers();
    return;
  }

  if (msg.type === 'delete-active-item') {
    const payload = msg as { type: 'delete-active-item'; nodeId: string };
    removeActiveMarker(payload.nodeId);
    return;
  }

  if (msg.type === 'build-table') {
    await buildUnifiedMemoTable(
      figma.viewport.center.x,
      figma.viewport.center.y,
      msg.rows,
      msg.entries ?? [],
      msg.tableId ?? undefined
    );
    return;
  }

  if (msg.type === 'reorder-markers') {
    reorderActiveMarkers(msg.order ?? []);
    return;
  }

  if (msg.type === 'reorder-title-markers') {
    reorderSubMarkers(msg.parentNodeId, msg.order ?? []);
    return;
  }

  if (msg.type === 'create-marker') {
    const markerLabel = typeof msg.markerLabel === 'string' && msg.markerLabel.trim().length > 0
      ? msg.markerLabel
      : undefined;
    await createMarkerFromSelection(markerLabel);
    return;
  }

  if (msg.type === 'create-title-marker') {
    await createTitleMarkerFromSelection(msg.markerLabel, msg.parentNodeId);
    return;
  }

  if (msg.type === 'delete-title-marker') {
    removeSubMarker(msg.parentNodeId, msg.markerLabel);
  }
};
