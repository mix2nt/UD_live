type SaveMessage = {
  type: 'save-table';
  title: string;
  markerNumber: number;
};

type UiMessage =
  | SaveMessage
  | { type: 'create-marker' }
  | { type: 'marker-ready'; markerNumber: number; title: string }
  | { type: 'table-created'; nodeId: string };

/// <reference types="@figma/plugin-typings" />

let markerSequence = 1;
let activeMarker: FrameNode | null = null;

async function loadFonts(): Promise<void> {
  await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
  await figma.loadFontAsync({ family: 'Inter', style: 'Bold' });
  await figma.loadFontAsync({ family: 'Inter', style: 'Semi Bold' });
}

async function createMarker(number: number, x: number, y: number): Promise<FrameNode> {
  await loadFonts();

  if (activeMarker && activeMarker.parent && activeMarker.parent.type === 'PAGE') {
    activeMarker.remove();
  }

  const marker = figma.createFrame();

  marker.name = `마커 ${number}`;
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
  text.characters = String(number);
  text.fontSize = 18;
  text.fontName = { family: 'Inter', style: 'Bold' };
  text.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
  text.x = 14;
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

async function buildMemoTable(title: string, markerNumber: number): Promise<FrameNode> {
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

async function initializePlugin(): Promise<void> {
  figma.ui.postMessage({ type: 'idle' });
}

function createMarkerFromSelection(): Promise<void> {
  const x = figma.viewport.center.x;
  const y = figma.viewport.center.y;

  return createMarker(markerSequence, x, y).then((marker) => {
    const number = Number(marker.name.match(/(\d+)$/)?.[0] ?? String(markerSequence));
    figma.ui.postMessage({ type: 'marker-ready', markerNumber: number, title: '' });
    markerSequence += 1;
  });
}

figma.showUI(__html__, {
  width: 360,
  height: 500
});

figma.on('selectionchange', async () => {
  await createMarkerFromSelection();
});

figma.on('run', () => {
  initializePlugin();
});

figma.ui.onmessage = async (msg) => {
  if (!msg || typeof msg !== 'object') {
    return;
  }

  if (msg.type === 'save-table') {
    const payload = msg as SaveMessage;
    const table = await buildMemoTable(payload.title, payload.markerNumber);
    figma.ui.postMessage({ type: 'table-created', nodeId: table.id });
    return;
  }

  if (msg.type === 'create-marker') {
    await createMarkerFromSelection();
  }
};
