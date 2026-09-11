/**
 * Distinct navigation glyphs for this bundle's Settings pages.
 *
 * dsh's settings shell draws each nav row's glyph from a fixed map of shipped
 * section ids and gives every other section the same gear, so the Instructions
 * and Secrets rows were indistinguishable (`navIcon` in
 * ui-settings-general). A registration cannot supply an icon: the slot core
 * copies only `id`, `order`, and `label` out of the options. Until the shell
 * takes a glyph from the registrant, patch the two rows after render: hide
 * the shell's gear and put our own glyph in its place.
 *
 * Rows are matched by their registered label text, never by hashed class
 * names or nav position, so another section moving or appearing cannot be
 * given the wrong icon. React owns the row; this module only hides one child
 * and inserts a sibling, and repairs both whenever the row re-renders.
 */

/** Labels of the sections this bundle registers. The patcher matches rows by
 * these strings, so changing a label moves the registration and the patch in
 * one edit. */
export const SETTINGS_SECTION_LABELS = {
  instructions: "Instructions",
  secrets: "Secrets",
} as const;

/** One stroked glyph drawn in the shell's 16px nav box. */
interface NavGlyph {
  label: string;
  paths: readonly string[];
}

/** Hand-drawn 16px outline paths at the same stroke weight as the bundle's
 * other inline icons: a document for Instructions, a key for Secrets. */
const NAV_GLYPHS: readonly NavGlyph[] = [
  {
    label: SETTINGS_SECTION_LABELS.instructions,
    paths: [
      "M4.25 2.25h5l2.5 2.5v9h-7.5z",
      "M9.25 2.25v2.5h2.5",
      "M6.25 7.25h4.25",
      "M6.25 9.75h4.25",
      "M6.25 12.25h2.5",
    ],
  },
  {
    label: SETTINGS_SECTION_LABELS.secrets,
    paths: [
      "M8 1.75a2.75 2.75 0 1 0 0 5.5 2.75 2.75 0 0 0 0-5.5Z",
      "M8 7.25v6.5",
      "M8 10h2.25",
      "M8 12h1.5",
    ],
  },
];

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const ROW_MARKER = "data-dsh-workbench-nav";
const GLYPH_MARKER = "data-dsh-workbench-glyph";

/** Replace the fallback gear on this bundle's settings nav rows. Returns the
 * teardown that restores the shell's rows; both the install and every later
 * pass are idempotent. */
export function installSettingsNavIcons(): () => void {
  if (typeof document === "undefined") {
    return () => {};
  }
  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) {
      return;
    }
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      patchSettingsNavIcons();
    });
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  patchSettingsNavIcons();
  return () => {
    observer.disconnect();
    for (const row of document.querySelectorAll(`[${ROW_MARKER}]`)) {
      row.removeAttribute(ROW_MARKER);
      for (const child of row.querySelectorAll(":scope > svg")) {
        if (child.hasAttribute(GLYPH_MARKER)) {
          child.remove();
        } else {
          (child as SVGElement).style.removeProperty("display");
        }
      }
    }
  };
}

/** Give every marked label its glyph, repairing anything React re-rendered
 * underneath the marker. */
function patchSettingsNavIcons(): void {
  // The shell renders the section outlet only while the settings panel is
  // open, so its absence rules the nav out before the scan.
  if (document.querySelector('[data-slot="settings.section"]') === null) {
    return;
  }
  for (const glyph of NAV_GLYPHS) {
    for (const row of navRows(glyph.label)) {
      decorate(row, glyph);
    }
  }
}

/** The settings nav row for one label: the shell's row is a button holding
 * its glyph and the label span. */
function navRows(label: string): HTMLElement[] {
  const rows: HTMLElement[] = [];
  for (const button of document.querySelectorAll<HTMLElement>("nav button")) {
    if (
      button.textContent?.trim() === label &&
      button.querySelector(":scope > svg") !== null
    ) {
      rows.push(button);
    }
  }
  return rows;
}

function decorate(row: HTMLElement, glyph: NavGlyph): void {
  // Our own glyph is a direct svg child too; only the shell's gear is hidden.
  for (const child of row.querySelectorAll(":scope > svg")) {
    if (!child.hasAttribute(GLYPH_MARKER)) {
      (child as SVGElement).style.setProperty("display", "none", "important");
    }
  }
  if (row.querySelector(`:scope > [${GLYPH_MARKER}]`) !== null) {
    return;
  }
  row.setAttribute(ROW_MARKER, glyph.label);
  row.insertBefore(drawGlyph(glyph), row.firstChild);
}

function drawGlyph({ label, paths }: NavGlyph): SVGSVGElement {
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  svg.setAttribute(GLYPH_MARKER, label);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.3");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  // The nav cell is a flex row with an 8px gap, so spacing comes from the
  // cell: the glyph must not add a margin of its own.
  svg.style.flex = "none";
  for (const d of paths) {
    const path = document.createElementNS(SVG_NAMESPACE, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}
