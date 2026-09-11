// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import {
  installSettingsNavIcons,
  SETTINGS_SECTION_LABELS,
} from "../src/client/settings-nav-icons.js";

/** The settings shell's markup for one nav row: the shell's glyph and the
 * label span, keyed by nothing but the label text. */
function shellMarkup(): string {
  const row = (label: string) =>
    `<button type="button"><svg class="hash_navIcon"><path d="M0 0h1"/></svg><span class="hash_navLabel">${label}</span></button>`;
  return `
    <div role="dialog" aria-modal="true">
      <nav>
        <div class="navTitle">Settings</div>
        <div class="navList">
          ${row("General")}
          ${row(SETTINGS_SECTION_LABELS.instructions)}
          ${row(SETTINGS_SECTION_LABELS.secrets)}
        </div>
      </nav>
      <div class="content">
        <div class="options"><div data-slot="settings.section"></div></div>
      </div>
    </div>`;
}

function renderShell(): void {
  document.body.innerHTML = shellMarkup();
}

function rowFor(label: string): HTMLElement {
  const row = [...document.querySelectorAll<HTMLElement>("nav button")].find(
    (button) => button.textContent?.trim() === label,
  );
  if (row === undefined) {
    throw new Error(`no nav row labelled ${label}`);
  }
  return row;
}

function gearOf(row: HTMLElement): SVGElement {
  const gear = row.querySelector<SVGElement>(
    ":scope > svg:not([data-dsh-workbench-glyph])",
  );
  if (gear === null) {
    throw new Error("row has no shell glyph");
  }
  return gear;
}

function glyphOf(row: HTMLElement, label: string): Element | null {
  return row.querySelector(`[data-dsh-workbench-glyph="${label}"]`);
}

/** MutationObserver callbacks and the patch they schedule are microtasks, so
 * one macrotask turn flushes both. */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

describe("settings nav glyphs", () => {
  it("replaces the shell's gear on the two contributed rows only", async () => {
    renderShell();
    dispose = installSettingsNavIcons();
    await settle();

    for (const label of [
      SETTINGS_SECTION_LABELS.instructions,
      SETTINGS_SECTION_LABELS.secrets,
    ]) {
      const row = rowFor(label);
      expect(gearOf(row).style.display).toBe("none");
      expect(row.firstElementChild).toBe(glyphOf(row, label));
      expect(row.textContent?.trim()).toBe(label);
    }
    expect(gearOf(rowFor("General")).style.display).not.toBe("none");
    expect(glyphOf(rowFor("General"), "General")).toBeNull();
  });

  it("repairs the row after React re-renders its children", async () => {
    renderShell();
    dispose = installSettingsNavIcons();
    await settle();

    const row = rowFor(SETTINGS_SECTION_LABELS.secrets);
    const gear = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const label = document.createElement("span");
    label.textContent = SETTINGS_SECTION_LABELS.secrets;
    row.replaceChildren(gear, label);
    await settle();

    expect(gearOf(row).style.display).toBe("none");
    expect(row.querySelectorAll("[data-dsh-workbench-glyph]")).toHaveLength(1);
  });

  it("patches the rows when the panel mounts later", async () => {
    dispose = installSettingsNavIcons();
    await settle();
    expect(document.querySelector("[data-dsh-workbench-glyph]")).toBeNull();

    renderShell();
    await settle();

    for (const label of [
      SETTINGS_SECTION_LABELS.instructions,
      SETTINGS_SECTION_LABELS.secrets,
    ]) {
      expect(glyphOf(rowFor(label), label)).not.toBeNull();
    }
  });

  it("puts the shell's rows back on teardown", async () => {
    renderShell();
    dispose = installSettingsNavIcons();
    await settle();
    dispose();
    dispose = undefined;

    for (const label of [
      SETTINGS_SECTION_LABELS.instructions,
      SETTINGS_SECTION_LABELS.secrets,
    ]) {
      const row = rowFor(label);
      expect(glyphOf(row, label)).toBeNull();
      expect(gearOf(row).style.display).toBe("");
    }

    // The observer is disconnected: a later remount stays untouched.
    renderShell();
    await settle();
    expect(document.querySelector("[data-dsh-workbench-glyph]")).toBeNull();
  });
});
