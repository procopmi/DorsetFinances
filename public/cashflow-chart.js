// The Income vs. expenses chart: for each month, a "money in" column and a
// "money out" column side by side. Drawn as plain SVG (the browser's own
// vector drawing), so there's no charting library.
//
// The table under the chart has the same numbers, so the chart is only a
// picture of them. Hover a column for its exact amount.
//
// Sizes are real pixels, not scaled to fit: with many months the chart gets
// wider and scrolls sideways, rather than shrinking its text.

import { formatCents } from '/money.js';

const SVG = 'http://www.w3.org/2000/svg';

// Layout, in pixels.
const HEIGHT = 240;
const LEFT = 52;    // room for the amounts on the left
const BOTTOM = 22;  // room for the month names
const TOP = 10;
const BAR = 20;     // each column's width (thin, with air between months)
const GAP = 2;      // between a month's two columns
const SLOT = 64;    // width given to each month
const ROUND = 4;    // rounded top corners

function svgElement(name, attributes = {}) {
  const element = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
}

// A "nice" gap between axis lines (1, 2 or 5 times a power of ten, in
// cents) so there are about four of them up to the largest amount.
function niceStep(largestCents) {
  const rough = largestCents / 4;
  const power = 10 ** Math.floor(Math.log10(rough));
  return [1, 2, 5, 10].map((m) => m * power).find((step) => step >= rough);
}

// Axis labels are short: 250000 cents -> "2.5K", 50000 -> "500".
function axisLabel(cents) {
  const dollars = cents / 100;
  return dollars >= 1000 ? `${dollars / 1000}K` : String(dollars);
}

// A column standing on the baseline: square at the bottom, rounded at the top.
function column(x, top, baseline, className, tooltip) {
  const r = Math.min(ROUND, baseline - top);
  const path = svgElement('path', {
    class: className,
    d: `M${x},${baseline} V${top + r} A${r},${r} 0 0 1 ${x + r},${top} ` +
      `H${x + BAR - r} A${r},${r} 0 0 1 ${x + BAR},${top + r} V${baseline} Z`,
  });
  // <title> inside an SVG shape is shown by the browser as a tooltip on hover.
  const title = svgElement('title');
  title.textContent = tooltip;
  path.append(title);
  return path;
}

// months: [{ month, inCents, outCents }]; label(month) gives "Jan 26".
// Returns the <svg> element.
export function cashFlowChart(months, label) {
  const width = LEFT + months.length * SLOT;
  const svg = svgElement('svg', { width, height: HEIGHT, role: 'img', 'aria-label': 'Money in and money out by month' });

  const largest = Math.max(1, ...months.flatMap((m) => [m.inCents, m.outCents]));
  const step = niceStep(largest);
  const topValue = Math.ceil(largest / step) * step;
  const baseline = HEIGHT - BOTTOM;
  // Cents -> height on screen. Only for drawing; amounts stay exact cents.
  const y = (cents) => baseline - (Math.max(0, cents) / topValue) * (baseline - TOP);

  // Faint horizontal lines with their amounts, behind the columns.
  for (let value = step; value <= topValue; value += step) {
    svg.append(svgElement('line', { class: 'gridline', x1: LEFT, x2: width, y1: y(value), y2: y(value) }));
    const text = svgElement('text', { x: LEFT - 6, y: y(value) + 4, 'text-anchor': 'end' });
    text.textContent = axisLabel(value);
    svg.append(text);
  }
  svg.append(svgElement('line', { class: 'baseline', x1: LEFT, x2: width, y1: baseline, y2: baseline }));
  const zero = svgElement('text', { x: LEFT - 6, y: baseline + 4, 'text-anchor': 'end' });
  zero.textContent = '0';
  svg.append(zero);

  months.forEach((m, i) => {
    // The pair of columns is centred in the month's slot.
    const x = LEFT + i * SLOT + (SLOT - (2 * BAR + GAP)) / 2;
    const name = label(m.month);
    if (m.inCents > 0) svg.append(column(x, y(m.inCents), baseline, 'bar-in', `${name} · Money in ${formatCents(m.inCents)}`));
    if (m.outCents > 0) {
      svg.append(column(x + BAR + GAP, y(m.outCents), baseline, 'bar-out', `${name} · Money out ${formatCents(m.outCents)}`));
    }
    const text = svgElement('text', { x: LEFT + i * SLOT + SLOT / 2, y: HEIGHT - 6, 'text-anchor': 'middle' });
    text.textContent = name;
    svg.append(text);
  });

  return svg;
}
