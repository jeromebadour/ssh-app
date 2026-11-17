// The settings. It is short on purpose: a setting exists here only where leaving it to a default would be
// wrong for him, never because an app of this kind usually has one. Two today, and both are things he named
// himself: where downloads land, and how big the list's text starts.
//
// It is built from the same dialog the rest of the app uses, not from a screen of its own (BUILD-RULES 2.13).

import { useEffect, useRef } from 'preact/hooks';
import type { AppSettings } from '../common/ipc';
import { SectionHead } from './boxdialogs';
import { Glyph } from './glyphs';

export function SettingsDialog(props: {
  settings: AppSettings;
  downloadsNow: string;
  onPick(): void;
  onDefault(): void;
  onSize(size: number): void;
  onClose(): void;
}) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => close.current?.focus(), []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  const chosen = props.settings.downloads !== '';
  const sizes = [0.85, 1, 1.15, 1.3, 1.5];
  const size = props.settings.paneSize || 1;
  return (
    <div class="scrim">
      <div class="dialog dlg-settings" id="settings" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <h1 id="settings-title"><Glyph name="settings" />Settings</h1>

        <section class="sect">
          <SectionHead glyph="bring" title="Where downloads land" />
          <p class="said" id="settings-downloads">{props.downloadsNow}</p>
          <p class="said quiet" id="settings-downloads-why">
            {chosen
              ? 'Your own folder. Everything brought over from a box lands here, under a name this PC can hold.'
              : "Berth's own folder, made the first time something is brought over. Choose another if you would rather it landed elsewhere."}
          </p>
          <p class="said quiet" id="settings-downloads-warn">
            A folder that syncs to the internet would send every file you bring over with it. Berth cannot tell which folders those are, so that one is yours to think about.
          </p>
          <div class="dlg-actions settings-actions">
            <button type="button" class="btn keep-plain" id="settings-downloads-default" disabled={!chosen} onClick={props.onDefault}>
              <Glyph name="back" />Use Berth's own folder
            </button>
            <button type="button" class="btn primary" id="settings-downloads-pick" onClick={props.onPick}>
              <Glyph name="folder" />Choose a folder
            </button>
          </div>
        </section>

        <section class="sect">
          <SectionHead glyph="zoom" title="How big a new tab's file list starts" />
          <p class="said quiet" id="settings-size-why">
            Every tab can still be changed on its own with Ctrl and plus, minus or nought. This is only where a new one starts.
          </p>
          <div class="size-row" id="settings-sizes" role="group" aria-label="How big a new tab's file list starts">
            {sizes.map((s) => (
              <button
                key={s}
                type="button"
                class={`size-btn ${Math.abs(size - s) < 0.001 ? 'on' : ''}`}
                id={`settings-size-${Math.round(s * 100)}`}
                aria-pressed={Math.abs(size - s) < 0.001}
                onClick={() => props.onSize(s)}
              >
                {Math.round(s * 100)}%
              </button>
            ))}
          </div>
        </section>

        <div class="dlg-actions">
          <button type="button" class="btn primary" id="settings-close" ref={close} onClick={props.onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
