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

type UiMessage =
  | SaveMessage
  | { type: 'create-marker'; markerLabel?: string }
  | { type: 'toggle-add-mode'; active: boolean }
  | { type: 'save-active-item'; nodeId: string; title: string; tags: ActiveTag[] }
  | { type: 'delete-active-item'; nodeId: string }
  | { type: 'marker-ready'; markerNumber: number | string; title: string; nodeId: string }
  | { type: 'table-created'; nodeId: string }
  | { type: 'active-list-updated'; records: ActiveMarkerRecord[] };

/// <reference types="@figma/plugin-typings" />

let markerSequence = 1;
let subMarkerSequence = 1;
let activeMarker: FrameNode | null = null;
let activeMarkers: ActiveMarkerRecord[] = [];
let committedMarkerIds = new Set<string>();
let nextNumber = 1;
let addModeActive = false;

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
  const found = marker.findOne((child) => child.type === 'TEXT' && child.name === '번호');
  return found && found.type === 'TEXT' ? found : null;
}

function updateMarkerNumberText(marker: FrameNode, number: number): void {
  const textNode = getMarkerTextNode(marker);
  if (!textNode) {
    return;
  }

  textNode.characters = String(number);
  textNode.fontSize = 18;
  textNode.fontName = { family: 'Inter', style: 'Bold' };
  textNode.x = 14;
  textNode.y = 11;
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
      marker.name = `마커 ${item.number}`;
    }
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

  marker.name = `마커 ${markerText}`;
  marker.resize(48, 48);
  marker.x = x - 24;
  marker.y = y - 24;
  marker.cornerRadius = 24;
  marker.fills = [{ type: 'SOLID', color: { r: 0.18, g: 0.46, b: 0.96 } }];
  marker.strokes = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 }, opacity: 1 }];
  marker.strokeWeight = 2;
  marker.clipsContent = false;

  const text = figma.createText();
  text.name = '번호';
  text.characters = markerText;
  text.fontSize = markerText.includes('-') ? 14 : 18;
  text.fontName = { family: 'Inter', style: 'Bold' };
  text.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
  text.x = markerText.includes('-') ? 9 : 14;
  text.y = 11;
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
  return cleaned.length > 0 ? cleaned : '제목 없음';
}

async function buildMemoTable(title: string, markerNumber: number | string): Promise<FrameNode> {
  await loadFonts();
  const table = figma.createFrame();
  const safeTitle = memoTableTitle(title);

  table.name = '메모 표';
  table.resize(420, 230);
  table.x = figma.viewport.center.x - 210;
  table.y = figma.viewport.center.y - 115;
  table.cornerRadius = 12;
  table.fills = [{ type: 'SOLID', color: { r: 0.99, g: 0.99, b: 1 } }];
  table.strokes = [{ type: 'SOLID', color: { r: 0.84, g: 0.88, b: 0.95 }, opacity: 1 }];
  table.strokeWeight = 1;

  const header = figma.createFrame();
  header.name = '헤더';
  header.resize(420, 58);
  header.fills = [{ type: 'SOLID', color: { r: 0.9, g: 0.94, b: 1 } }];
  header.cornerRadius = 12;
  header.x = 0;
  header.y = 0;
  table.appendChild(header);

  const headerText = figma.createText();
  headerText.name = '제목';
  headerText.characters = safeTitle;
  headerText.fontSize = 18;
  headerText.fontName = { family: 'Inter', style: 'Bold' };
  headerText.fills = [{ type: 'SOLID', color: { r: 0.09, g: 0.16, b: 0.3 } }];
  headerText.x = 18;
  headerText.y = 16;
  header.appendChild(headerText);

  const rows = [
    ['번호', String(markerNumber)],
    ['제목', safeTitle],
    ['점', '•'],
    ['대시', '—'],
    ['문구', '요약 문구']
  ];

  for (let i = 0; i < rows.length; i += 1) {
    const [label, value] = rows[i];
    const row = figma.createFrame();
    row.name = `행 ${i + 1}`;
    row.resize(420, 34);
    row.x = 0;
    row.y = 62 + i * 34;
    row.fills = i % 2 === 0
      ? [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }]
      : [{ type: 'SOLID', color: { r: 0.97, g: 0.98, b: 1 } }];
    table.appendChild(row);

    const labelText = figma.createText();
    labelText.name = '라벨';
    labelText.characters = label;
    labelText.fontSize = 12;
    labelText.fontName = { family: 'Inter', style: 'Semi Bold' };
    labelText.fills = [{ type: 'SOLID', color: { r: 0.34, g: 0.38, b: 0.46 } }];
    labelText.x = 18;
    labelText.y = 8;
    row.appendChild(labelText);

    const valueText = figma.createText();
    valueText.name = '값';
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

async function buildUnifiedMemoTable(x: number, y: number): Promise<FrameNode | null> {
  if (activeMarkers.length === 0) {
    return null;
  }

  const sorted = [...activeMarkers].sort((a, b) => a.number - b.number);
  const table = figma.createFrame();
  table.name = '메모 표';
  table.resize(420, 70 + sorted.length * 36);
  table.x = x - table.width / 2;
  table.y = y - table.height / 2;
  table.cornerRadius = 12;
  table.fills = [{ type: 'SOLID', color: { r: 0.99, g: 0.99, b: 1 } }];
  table.strokes = [{ type: 'SOLID', color: { r: 0.84, g: 0.88, b: 0.95 }, opacity: 1 }];
  table.strokeWeight = 1;

  const header = figma.createFrame();
  header.name = '헤더';
  header.resize(420, 58);
  header.fills = [{ type: 'SOLID', color: { r: 0.9, g: 0.94, b: 1 } }];
  header.cornerRadius = 12;
  header.x = 0;
  header.y = 0;
  table.appendChild(header);

  const headerText = figma.createText();
  headerText.name = '제목';
  headerText.characters = '활성 마커 목록';
  headerText.fontSize = 18;
  headerText.fontName = { family: 'Inter', style: 'Bold' };
  headerText.fills = [{ type: 'SOLID', color: { r: 0.09, g: 0.16, b: 0.3 } }];
  headerText.x = 18;
  headerText.y = 16;
  header.appendChild(headerText);

  sorted.forEach((record, index) => {
    const row = figma.createFrame();
    row.name = `행 ${index + 1}`;
    row.resize(420, 36);
    row.x = 0;
    row.y = 62 + index * 36;
    row.fills = index % 2 === 0
      ? [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }]
      : [{ type: 'SOLID', color: { r: 0.97, g: 0.98, b: 1 } }];
    table.appendChild(row);

    const noLabel = figma.createText();
    noLabel.name = '번호';
    noLabel.characters = String(record.number);
    noLabel.fontSize = 12;
    noLabel.fontName = { family: 'Inter', style: 'Semi Bold' };
    noLabel.fills = [{ type: 'SOLID', color: { r: 0.34, g: 0.38, b: 0.46 } }];
    noLabel.x = 18;
    noLabel.y = 10;
    row.appendChild(noLabel);

    const titleLabel = figma.createText();
    titleLabel.name = '제목';
    titleLabel.characters = record.title || '제목 없음';
    titleLabel.fontSize = 13;
    titleLabel.fontName = { family: 'Inter', style: 'Regular' };
    titleLabel.fills = [{ type: 'SOLID', color: { r: 0.13, g: 0.17, b: 0.24 } }];
    titleLabel.x = 120;
    titleLabel.y = 10;
    row.appendChild(titleLabel);

    if (record.tags.length > 0) {
      const values = record.tags.map((tag) => `${tag.label}: ${tag.value || ''}`).join(' / ');
      const tagText = figma.createText();
      tagText.name = '태그';
      tagText.characters = values;
      tagText.fontSize = 11;
      tagText.fontName = { family: 'Inter', style: 'Regular' };
      tagText.fills = [{ type: 'SOLID', color: { r: 0.38, g: 0.42, b: 0.52 } }];
      tagText.x = 120;
      tagText.y = 20;
      row.appendChild(tagText);
    }
  });

  figma.currentPage.appendChild(table);
  figma.currentPage.selection = [table];
  figma.viewport.scrollAndZoomIntoView([table]);

  sorted.forEach((record) => {
    committedMarkerIds.add(record.nodeId);
  });

  activeMarkers = [];
  figma.ui.postMessage({ type: 'active-list-updated', records: [] });
  figma.ui.postMessage({ type: 'table-created', nodeId: table.id });

  return table;
}

async function initializePlugin(): Promise<void> {
  figma.ui.postMessage({ type: 'active-list-updated', records: [] });
  figma.ui.postMessage({ type: 'idle' });
}

async function createMarkerAtPosition(x: number, y: number, label?: string): Promise<void> {
  const resolvedNumber = getNextMarkerNumber();
  const marker = await createMarker(resolvedNumber, x, y);
  registerActiveMarker(marker, resolvedNumber);
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

function createMarkerFromSelection(markerLabel?: string): Promise<void> {
  const targetNode = figma.currentPage.selection[0];
  const centerX = targetNode && 'absoluteBoundingBox' in targetNode && targetNode.absoluteBoundingBox
    ? targetNode.absoluteBoundingBox.x + targetNode.absoluteBoundingBox.width / 2
    : figma.viewport.center.x;
  const centerY = targetNode && 'absoluteBoundingBox' in targetNode && targetNode.absoluteBoundingBox
    ? targetNode.absoluteBoundingBox.y + targetNode.absoluteBoundingBox.height / 2
    : figma.viewport.center.y;

  return createMarkerAtPosition(centerX, centerY, markerLabel);
}

function shouldCreateMarkerOnCanvasClick(): boolean {
  return addModeActive && figma.currentPage.selection.length > 0;
}

figma.showUI(__html__, {
  width: 360,
  height: 560
});

figma.on('selectionchange', async () => {
  if (!shouldCreateMarkerOnCanvasClick()) {
    return;
  }

  const selected = figma.currentPage.selection[0];
  if (!selected) {
    return;
  }

  if (selected.type === 'FRAME' && selected.name.startsWith('마커 ')) {
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
  if (missing.length === 0) {
    return;
  }

  activeMarkers = activeMarkers.filter((item) => figma.getNodeById(item.nodeId) !== null);
  reindexActiveMarkers();
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
    target.title = payload.title.trim().length > 0 ? payload.title.trim() : '제목 없음';
    target.tags = payload.tags ?? [];

    const node = figma.getNodeById(payload.nodeId) as FrameNode | null;
    if (node) {
      updateMarkerNumberText(node, target.number);
      node.name = `마커 ${target.number}`;
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
    await buildUnifiedMemoTable(figma.viewport.center.x, figma.viewport.center.y);
    return;
  }

  if (msg.type === 'create-marker') {
    const markerLabel = typeof msg.markerLabel === 'string' && msg.markerLabel.trim().length > 0
      ? msg.markerLabel
      : undefined;
    await createMarkerFromSelection(markerLabel);
  }
};
