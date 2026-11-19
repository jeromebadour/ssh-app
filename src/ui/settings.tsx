// The settings. It is short on purpose: a setting exists here only where leaving it to a default would be
// wrong for him, never because an app of this kind usually has one. Two today, and both are things he named
// himself: where downloads land, and how big the list's text starts.
//
// It is built from the same dialog the rest of the app uses, not from a screen of its own (BUILD-RULES 2.13).

import { Button } from './button';
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
          {/* The folder itself, which is a value and not a sentence: it is what the setting is set to. */}
          <p class="said" id="settings-downloads" data-value="yes">{props.downloadsNow}</p>
          {/* One line a section. The warning is the half he cannot work out for himself, so it is the half
              that stays whole. */}
          <p class="said quiet" id="settings-downloads-why">
            {chosen ? 'Everything brought over lands here' : "Berth's own folder, made the first time something is brought over"}. A folder that syncs to the internet sends every file with it, and Berth cannot tell which folders those are.
          </p>
          <div class="dlg-actions settings-actions">
            <Button id="settings-downloads-default" glyph="back" disabled={!chosen} onClick={props.onDefault}>Use Berth's own folder</Button>
            <Button id="settings-downloads-pick" tone="go" glyph="folder" onClick={props.onPick}>Choose a folder</Button>
          </div>
        </section>

        <section class="sect">
          <SectionHead glyph="zoom" title="How big a new tab's file list starts" />
          <p class="said quiet" id="settings-size-why">
            Ctrl with plus, minus or nought still changes one tab on its own.
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
          <Button id="settings-close" tone="go" hold={close} onClick={props.onClose}>Done</Button>
        </div>
      </div>
    </div>
  );
}
