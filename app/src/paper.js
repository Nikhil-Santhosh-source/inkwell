// Paper styles: templates (line patterns) and colors, drawn in page units.

export const PAPER_TEMPLATES = [
  { id: 'blank', label: 'Blank' },
  { id: 'lined', label: 'Lined' },
  { id: 'grid', label: 'Grid' },
  { id: 'dotted', label: 'Dotted' },
  { id: 'cornell', label: 'Cornell' },
];

export const PAPER_COLORS = [
  { id: 'white', label: 'White', fill: '#ffffff', line: '#c9d3e3', accent: '#efa7a7', dark: false },
  { id: 'cream', label: 'Cream', fill: '#fbf6e9', line: '#d9cfb5', accent: '#e8a49a', dark: false },
  { id: 'yellow', label: 'Legal', fill: '#fdf3b8', line: '#c8d4e6', accent: '#e59a9a', dark: false },
  { id: 'mint', label: 'Mint', fill: '#e9f5ec', line: '#b9d6c1', accent: '#e3a5a5', dark: false },
  { id: 'sky', label: 'Sky', fill: '#e8f1fb', line: '#b7cbe5', accent: '#e3a5a5', dark: false },
  { id: 'gray', label: 'Gray', fill: '#ececec', line: '#c8c8c8', accent: '#d9a0a0', dark: false },
  { id: 'dark', label: 'Dark', fill: '#1f2125', line: '#3a3e46', accent: '#7a4a4a', dark: true },
];

const LINE_SPACING = 32;
const GRID_SPACING = 24;
const TOP_MARGIN = 96;
const LEFT_MARGIN = 80;
const CORNELL_CUE_WIDTH = 216;
const CORNELL_SUMMARY_HEIGHT = 192;

export function paperColor(id) {
  return PAPER_COLORS.find((c) => c.id === id) ?? PAPER_COLORS[0];
}

// Describes what to draw for a paper, so the layout can be tested without a canvas.
// Returns { fill, lines: [{x1, y1, x2, y2, color}], dots: [{x, y}], dotColor }.
export function paperLayout(paper, width, height) {
  const color = paperColor(paper.color);
  const lines = [];
  const dots = [];
  const horizontal = (y, c = color.line) => lines.push({ x1: 0, y1: y, x2: width, y2: y, color: c });
  const vertical = (x, y1, y2, c = color.line) => lines.push({ x1: x, y1, x2: x, y2, color: c });

  switch (paper.template) {
    case 'lined':
      for (let y = TOP_MARGIN; y < height; y += LINE_SPACING) horizontal(y);
      vertical(LEFT_MARGIN, 0, height, color.accent);
      break;
    case 'grid':
      for (let y = GRID_SPACING; y < height; y += GRID_SPACING) horizontal(y);
      for (let x = GRID_SPACING; x < width; x += GRID_SPACING) vertical(x, 0, height);
      break;
    case 'dotted':
      for (let y = GRID_SPACING; y < height; y += GRID_SPACING) {
        for (let x = GRID_SPACING; x < width; x += GRID_SPACING) dots.push({ x, y });
      }
      break;
    case 'cornell': {
      const summaryTop = height - CORNELL_SUMMARY_HEIGHT;
      for (let y = TOP_MARGIN; y < summaryTop; y += LINE_SPACING) {
        lines.push({ x1: CORNELL_CUE_WIDTH, y1: y, x2: width, y2: y, color: color.line });
      }
      horizontal(TOP_MARGIN - LINE_SPACING, color.accent);
      vertical(CORNELL_CUE_WIDTH, TOP_MARGIN - LINE_SPACING, summaryTop, color.accent);
      horizontal(summaryTop, color.accent);
      break;
    }
    default:
      break;
  }
  return { fill: color.fill, lines, dots, dotColor: color.line };
}

// lineWidth is in page units; small previews pass a thicker one so lines stay visible.
export function drawPaper(ctx, paper, width, height, lineWidth = 1) {
  const layout = paperLayout(paper, width, height);
  ctx.fillStyle = layout.fill;
  ctx.fillRect(0, 0, width, height);
  ctx.lineWidth = lineWidth;
  let current = null;
  for (const line of layout.lines) {
    if (line.color !== current) {
      if (current) ctx.stroke();
      current = line.color;
      ctx.strokeStyle = current;
      ctx.beginPath();
    }
    ctx.moveTo(line.x1, line.y1);
    ctx.lineTo(line.x2, line.y2);
  }
  if (current) ctx.stroke();
  if (layout.dots.length) {
    ctx.fillStyle = layout.dotColor;
    ctx.beginPath();
    const r = 1.4 * lineWidth;
    for (const { x, y } of layout.dots) {
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, Math.PI * 2);
    }
    ctx.fill();
  }
}
