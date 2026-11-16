// Berth's main window in use, as if it were finished, in its chosen direction (A, Chart). Built from the components the
// screens will be made of; drawn with invented data. A lab page: it exists to be pictured and chosen from.
//   ?scene=dialog    the "close a tab with a running command" dialog is open
//   ?scene=paths     the path bar's pinned and recent folders are open
//   ?scene=boxes     the Boxes menu is open
// Step 2's screens (screens.tsx), and a tab in each connection state:
//   ?scene=addbox | trust | changed      Add box, the first-connection check, a changed identity
//   ?scene=connecting | fresh            a new tab opening, then just signed in (the sign-in text folded)
//   ?scene=noanswer | dropped            a silent link kept; a link that is gone, reconnecting
//   ?scene=mismatch | unreachable        the first-connection check: another box answered; the box cannot be reached
//   ?scene=seven | sevenopen             seven tabs in a small window: a box's tabs folded into one; that fold open
import { render } from 'preact';
import { blocks, files, groups, logCmd, logLines, pins, prompt, recent, tabGroups, type Box, type FileRow } from './data';
import { Glyph } from '../ui/glyphs';
import { Mark } from '../ui/marks';
import { AddBoxDialog, ChangedDialog, MismatchDialog, TrustDialog, UnreachableDialog } from './screens';

const q = new URLSearchParams(location.search);
const scene = q.get('scene') ?? '';
// In the logs picture the logs tab is the one in front.
if (scene === 'logs') for (const g of tabGroups) for (const t of g.tabs) t.active = g.box === 'relay-fra' && t.place === 'logs';
// A new tab on relay-fra, its staging place, opening and then just opened. Then one tab in each link state.
const tabOf = (box: string, place: string) => tabGroups.find((g) => g.box === box)?.tabs.find((t) => t.place === place);
if (scene === 'connecting' || scene === 'fresh') {
  for (const g of tabGroups) for (const t of g.tabs) t.active = false;
  tabGroups.find((g) => g.box === 'relay-fra')?.tabs.push(scene === 'connecting' ? { place: 'staging', active: true, state: 'connecting' } : { place: 'staging', active: true });
}
// Seven tabs, the most Kami opens: four boxes, four tabs on one of them.
const sevenScene = scene === 'seven' || scene === 'sevenopen';
if (sevenScene) {
  for (const g of tabGroups) for (const t of g.tabs) t.active = false;
  tabGroups.find((g) => g.box === 'relay-fra')?.tabs.push({ place: 'staging', active: true }, { place: 'releases', signal: 'done' });
  tabGroups.find((g) => g.box === 'build-sg')?.tabs.push({ place: 'artifacts' });
  tabGroups.push({ box: 'ledger-db', hue: 'var(--box-4)', state: 'connected', tabs: [{ place: 'db' }] });
}
const linkStates: Record<string, [string, string, 'silent' | 'gone' | 'stopped']> = { noanswer: ['relay-fra', 'deploy', 'silent'], dropped: ['relay-fra', 'deploy', 'gone'], changed: ['vault-ams', 'backups', 'stopped'] };
const ls = linkStates[scene];
if (ls) {
  const t = tabOf(ls[0], ls[1]);
  if (t) t.state = ls[2];
}
const activeTab = tabGroups.flatMap((g) => g.tabs).find((t) => t.active);
const tabState = activeTab?.state;

const stateWords: Record<string, string> = { connected: 'connected', reconnecting: 'reconnecting', idle: 'not open', connecting: 'connecting', silent: 'no answer', gone: 'gone', stopped: 'stopped' };

// The Boxes menu: your saved boxes, one line each, like a sessions menu. A box with places shows an arrow; its
// places open beside it on hover. Typing while the menu is open filters it (no field until you type).
function BoxMenu() {
  const all = groups.flatMap((g) => g.boxes);
  return (
    <div class="box-menu" role="menu" aria-label="Boxes">
      {all.map((b) => (
        <div class={`bm-row st-${b.state}`} key={b.name} role="menuitem" style={{ '--hue': b.hue }}>
          <span class="box-dot" />
          <span class="bm-name">{b.name}</span>
          {b.state !== 'idle' && <span class={`conn conn-${b.state}`} title={b.state} />}
          {b.places.length > 0 && <Glyph name="chevron" class="bm-more" />}
        </div>
      ))}
      <div class="bm-foot"><button class="bm-add"><Glyph name="plus" />Add box</button></div>
    </div>
  );
}

// When the tabs would not fit, a box with several tabs folds into one: its tab in front (or the last used),
// and how many it holds. The count opens the box's tabs as a list. A box with one tab never folds.
function Folded(props: { g: (typeof tabGroups)[number] }) {
  const g = props.g;
  const front = g.tabs.find((t) => t.active) ?? g.tabs[0]!;
  const others = g.tabs.filter((t) => t !== front);
  const busy = others.some((t) => t.signal === 'output' || t.signal === 'done' || t.signal === 'running');
  const open = scene === 'sevenopen' && g.box === 'relay-fra';
  return (
    <div class={`tab-group folded st-${g.state}`} style={{ '--hue': g.hue }}>
      <span class={`tab ${front.active ? 'active' : ''}`}>
        <span class={`conn conn-${front.state ?? g.state}`} />
        <span class="tab-box">{g.box}</span>
        <span class="tab-place">{front.place}</span>
        <span class="tab-end">
          {front.signal === 'running' && <span class="sig sig-running">1:42</span>}
          <button class={`fold-n ${open ? 'open' : ''}`} aria-haspopup="menu" aria-expanded={open} aria-label={`${g.tabs.length} tabs on ${g.box}`}>
            {busy && <span class="fold-dot" />}
            {g.tabs.length}
            <Glyph name="chevron" class="caret" />
          </button>
          {front.active && <Glyph name="close" class="tab-x" label="Close tab" />}
        </span>
      </span>
      {open && (
        <div class="fold-menu" role="menu" aria-label={`Tabs on ${g.box}`}>
          {g.tabs.map((t) => (
            <div class={`fm-row ${t === front ? 'front' : ''}`} key={t.place} role="menuitem">
              <span class={`conn conn-${t.state ?? g.state}`} />
              <Glyph name="place" class="fm-glyph" />
              <span class="fm-place">{t.place}</span>
              {t.signal === 'running' && <span class="sig sig-running">1:42</span>}
              {t.signal === 'output' && <span class="sig sig-output" title="new output" />}
              {t.signal === 'done' && <Glyph name="check" class="sig sig-done" label="command finished" />}
              <Glyph name="close" class="fm-x" label={`Close ${t.place}`} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TabBar() {
  return (
    <header class="tabbar">
      <div class="brand">
        <Mark />
        <span class="wordmark">Berth</span>
      </div>
      <button class={`boxes-btn ${scene === 'boxes' ? 'open' : ''}`} aria-haspopup="menu" aria-expanded={scene === 'boxes'}>
        <Glyph name="boxes" />Boxes<Glyph name="chevron" class="caret" />
      </button>
      <div class="tab-groups" style={{ '--n': tabGroups.reduce((n, g) => n + (sevenScene ? 1 : g.tabs.length), 0) }}>
        {tabGroups.map((g) => sevenScene && g.tabs.length > 1 ? <Folded g={g} key={g.box} /> : (
          <div class={`tab-group st-${g.state}`} key={g.box} style={{ '--hue': g.hue }}>
            {g.tabs.map((t) => (
              <span class={`tab ${t.active ? 'active' : ''}`} key={t.place}>
                <span class={`conn conn-${t.state ?? g.state}`} title={stateWords[t.state ?? g.state]} />
                <span class="tab-box">{g.box}</span>
                <span class="tab-place">{t.place}</span>
                <span class="tab-end">
                  {t.state === 'silent' && <span class="sig sig-silent">14 s</span>}
                  {t.state === 'gone' && <span class="sig sig-silent">4 s</span>}
                  {t.state === 'stopped' && <Glyph name="identityBroken" class="sig sig-stopped" label="identity changed" />}
                  {!t.state && t.signal === 'running' && <span class="sig sig-running">1:42</span>}
                  {t.signal === 'output' && <span class="sig sig-output" title="new output" />}
                  {t.signal === 'done' && <Glyph name="check" class="sig sig-done" label="command finished" />}
                  <Glyph name="close" class="tab-x" label="Close tab" />
                </span>
              </span>
            ))}
          </div>
        ))}
        <button class="new-tab" aria-label="Open a box"><Glyph name="plus" /></button>
      </div>
      <div class="bar-tools">
        <button class="tool" aria-label="Reopen last session"><Glyph name="reopen" /></button>
        <button class="tool" aria-label="Settings"><Glyph name="settings" /></button>
      </div>
    </header>
  );
}

function FileIcon(props: { row: FileRow }) {
  const k = props.row.kind;
  return <Glyph name={k === 'up' ? 'up' : k} class={`ft ft-${k}`} />;
}

function PathMenu() {
  return (
    <div class="path-menu" role="menu">
      <div class="pm-head"><Glyph name="pin" />Pinned on relay-fra</div>
      {pins.map((p, i) => (
        <div class={`pm-row ${i === 0 ? 'here' : ''}`} key={p} role="menuitem">
          <Glyph name="pin" class="pm-pin on" />
          <span class="pm-path">{p}</span>
          {i === 0 && <span class="pm-note">here</span>}
        </div>
      ))}
      <div class="pm-head">Recent in this tab<span class="pm-aside">not saved</span></div>
      {recent.map((p) => (
        <div class="pm-row" key={p} role="menuitem">
          <Glyph name="pin" class="pm-pin" />
          <span class="pm-path">{p}</span>
        </div>
      ))}
    </div>
  );
}

function FilePanel() {
  return (
    <section class="files" aria-label="Files on relay-fra">
      <div class="pathbar">
        <div class={`crumbs ${scene === 'paths' ? 'open' : ''}`}>
          <Glyph name="home" class="crumb-home" />
          <span class="crumb">srv</span>
          <Glyph name="chevron" class="crumb-sep" />
          <span class="crumb last">staging</span>
          <Glyph name="pin" class="crumb-pin on" label="Pinned" />
        </div>
        <span class="follow on" title="Following the terminal"><Glyph name="follow" /></span>
        {scene === 'paths' && <PathMenu />}
      </div>
      <div class="file-tools">
        <button class="ft-btn act-input"><Glyph name="upload" />Upload</button>
        <button class="ft-btn act-main"><Glyph name="download" />Download</button>
        <button class="ft-btn"><Glyph name="newFolder" />New folder</button>
        <button class="ft-btn icon-only" aria-label="Refresh"><Glyph name="refresh" /></button>
        <span class="chip"><Glyph name="hidden" />Hidden</span>
      </div>
      <div class="file-head">
        <span class="fh-name">Name</span>
        <span class="fh-size">Size</span>
        <span class="fh-date sorted">Modified</span>
      </div>
      {scene === 'connecting' ? (
        <div class="file-rows waiting-rows"><span class="op-spin" />Lists /srv/staging as soon as the sign-in is done</div>
      ) : <div class="file-rows">
        {files.map((f) => (
          <div class={`file ${f.selected ? 'selected' : ''} ${f.fresh ? 'fresh' : ''} k-${f.kind}`} key={f.name}>
            <FileIcon row={f} />
            <span class="f-name"><span class="f-text">{f.name}</span>{f.target && <span class="f-target">{f.target}</span>}{f.fresh && <span class="f-new">new</span>}</span>
            <span class="f-size">{f.size ?? ''}</span>
            <span class="f-date">{f.modified ?? ''}</span>
          </div>
        ))}
      </div>}
      {!['connecting', 'fresh', 'dropped'].includes(scene) && <div class="transfers">
        <div class="xfer done">
          <Glyph name="upload" class="x-dir act-input" />
          <div class="x-main">
            <div class="x-line"><span class="x-name">ledger-4f2c1a9.tar.gz</span><span class="x-size">48.6 MB</span></div>
            <div class="x-bar"><span style={{ width: '100%' }} /></div>
            <div class="x-line small"><span class="x-ok"><Glyph name="check" />sha-256 match</span><span class="x-md5">md5 3e7f…a91c</span><button class="x-copy" aria-label="Copy md5"><Glyph name="copy" /></button></div>
          </div>
        </div>
        <div class="xfer">
          <Glyph name="download" class="x-dir act-main" />
          <div class="x-main">
            <div class="x-line"><span class="x-name">deploy-4f2c1a9.log</span><span class="x-size">137 of 214 KB</span></div>
            <div class="x-bar"><span style={{ width: '64%' }} /></div>
            <div class="x-line small"><span>3.1 MB/s</span><span>under a second left</span><button class="x-stop" aria-label="Cancel"><Glyph name="stop" /></button></div>
          </div>
        </div>
      </div>}
      <div class="file-foot">
        {scene === 'connecting' ? <span>waiting for the link</span> : scene === 'dropped' ? <span class="held">as it was at 19:44:07, read only until the new session</span> : <span>{files.length - 1} items, 1 selected, 48.6 MB</span>}
        {scene !== 'connecting' && scene !== 'dropped' && <span class="free">61.2 GB free</span>}
      </div>
    </section>
  );
}

function Prompt() {
  return (
    <span class="prompt">
      <span class="p-user">{prompt.user}@</span>
      <span class="p-box">{prompt.box}</span>
      <span class="p-path">:{prompt.path}</span>
      <span class="p-sigil"># </span>
    </span>
  );
}

// Word colouring, as offered: a small fixed set of rules, in the app's muted meaning colours, on top of whatever
// colours the box itself sends. Times and tags go quiet; failures and refusals take the problem colour; success
// and 2xx answers the checked colour; addresses the input colour. Nothing else is touched.
const RULES: [RegExp, string][] = [
  [/^\d{4}-\d{2}-\d{2}T[\d:.]+Z/, 'w-time'],
  [/\[[a-z]+\]/, 'w-tag'],
  [/\b(?:refused|failure|failed|error|timeout|disconnected|denied)\b|\b[45]\d\d(?= \d+ms)|\b(?:451|503)\b/i, 'w-bad'],
  [/\b(?:ok|verified|done|connected)\b|\b2\d\d(?= \d+ms)/i, 'w-good'],
  [/\b\d{1,3}(?:\.\d{1,3}){3}\b/, 'w-addr'],
];

function paint(line: string) {
  const parts: preact.JSX.Element[] = [];
  let rest = line;
  let key = 0;
  while (rest.length) {
    let best: { at: number; len: number; cls: string } | null = null;
    for (const [re, cls] of RULES) {
      const m = re.exec(rest);
      if (m && (best === null || m.index < best.at)) best = { at: m.index, len: m[0].length, cls };
    }
    if (!best) {
      parts.push(<span key={key++}>{rest}</span>);
      break;
    }
    if (best.at > 0) parts.push(<span key={key++}>{rest.slice(0, best.at)}</span>);
    parts.push(<span key={key++} class={best.cls}>{rest.slice(best.at, best.at + best.len)}</span>);
    rest = rest.slice(best.at + best.len);
  }
  return parts;
}

// What the tab says about its link, inside the terminal, above the output. The output itself stays as it was:
// readable and copyable whatever the link does.
function LinkBar() {
  if (tabState === 'silent') {
    return (
      <div class="linkbar problem">
        <Glyph name="silent" />
        <span class="lb-main"><b>No answer for 14 s.</b> The link is kept: the shell and the deploy are still running on the box.</span>
        <span class="lb-aside">ends by itself only after 10 min of silence</span>
        <button class="lb-btn"><Glyph name="reconnect" />Reconnect<kbd>R</kbd></button>
      </div>
    );
  }
  if (tabState === 'gone') {
    return (
      <div class="linkbar problem">
        <Glyph name="reconnect" />
        <span class="lb-main"><b>The link is gone:</b> the connection was reset at 19:44:07. The deploy running in this tab ended with it. A new session opens in 4 s, in /srv/staging.</span>
        <button class="lb-btn"><Glyph name="reconnect" />Now<kbd>R</kbd></button>
        <button class="lb-btn quiet"><Glyph name="stop" />Cancel</button>
      </div>
    );
  }
  return null;
}

// A tab opening: each stage as it happens, with what was agreed; nothing typed, nothing guessed.
function Opening() {
  return (
    <div class="opening">
      <div class="op-title"><span class="box-dot" style={{ '--hue': 'var(--box-1)' }} />Opening relay-fra, staging</div>
      <div class="op-row done"><Glyph name="check" /><span class="op-what">Connected to 203.0.113.24:22</span><span class="op-detail">38 ms</span></div>
      <div class="op-row done"><Glyph name="check" /><span class="op-what">Identity matches the one pinned for relay-fra</span><span class="op-detail">ED25519</span></div>
      <div class="op-row done"><Glyph name="check" /><span class="op-what">Keys agreed, post-quantum</span><span class="op-detail">mlkem768x25519, aes256-gcm</span></div>
      <div class="op-row now"><span class="op-spin" /><span class="op-what">Signing in as root with Berth's key for relay-fra</span><span class="op-detail">0.2 s</span></div>
      <div class="op-row later"><span class="op-dot" /><span class="op-what">Shell in /srv/staging</span></div>
    </div>
  );
}

// The sign-in text a box prints, folded into one quiet line: nothing a box says is lost, and a real notice in
// it (a restart needed) is lifted out onto the line.
function SaysLine() {
  return (
    <div class="says">
      <Glyph name="says" />
      <span class="says-main">relay-fra said 18 lines at sign-in</span>
      <span class="says-flag">*** System restart required ***</span>
      <Glyph name="chevron" class="says-open" />
    </div>
  );
}

function Terminal() {
  if (scene === 'connecting') {
    return (
      <section class="term" aria-label="Terminal on relay-fra">
        <div class="term-frame waiting"><Opening /></div>
      </section>
    );
  }
  if (scene === 'fresh') {
    return (
      <section class="term" aria-label="Terminal on relay-fra">
        <div class="term-frame top">
          <SaysLine />
          <div class="block">
            <div class="gutter"><span class="g-mark" /><span class="g-time">0.0 s</span></div>
            <div class="block-body">
              <div class="line cmd"><Prompt />ls</div>
              <div class="line">current  deploy-4f2c1a9.log  ledger-4e91b07.tar.gz  ledger-4f2c1a9.tar.gz  releases  rollback</div>
            </div>
          </div>
          <div class="block">
            <div class="gutter"><span class="g-mark now" /></div>
            <div class="block-body"><div class="line cmd"><Prompt /><span class="cursor" /></div></div>
          </div>
        </div>
      </section>
    );
  }
  if (scene === 'logs') {
    return (
      <section class="term" aria-label="Terminal on relay-fra">
        <div class={`term-frame ${tabState ? 'linked-' + tabState : ''}`}>
          <LinkBar />
          <div class="scrolled-out">older output scrolled out</div>
          <div class="block running">
            <div class="gutter"><span class="g-mark" /><span class="g-time">6:10</span></div>
            <div class="block-body">
              <div class="line cmd"><Prompt />{logCmd}</div>
              {logLines.map((l, i) => <div class="line" key={i}>{paint(l)}</div>)}
            </div>
          </div>
        </div>
      </section>
    );
  }
  return (
    <section class="term" aria-label="Terminal on relay-fra">
      <div class={`term-frame ${tabState ? 'linked-' + tabState : ''}`}>
        <LinkBar />
        <div class="scrolled-out">older output scrolled out</div>
        {blocks.map((b, i) => (
          <div class={`block ${b.running ? (tabState === 'gone' ? 'ended' : 'running') : ''}`} key={i}>
            <div class="gutter">
              <span class="g-mark" />
              <span class="g-time">{b.running && tabState === 'gone' ? 'ended 4:09' : b.running ?? b.took}</span>
            </div>
            <div class="block-body">
              <div class="line cmd"><Prompt />{b.cmd}</div>
              {b.out.map(([cls, text], j) => (
                <div class={`line ${cls}`} key={j}>{text}</div>
              ))}
              {b.running && tabState !== 'gone' && <div class="line"><span class="cursor" /></div>}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function StatusBar() {
  const place = activeTab?.place ?? 'deploy';
  const conn = tabState === 'silent' ? 'silent' : tabState === 'gone' ? 'gone' : tabState === 'connecting' ? 'connecting' : 'connected';
  const rtt = tabState === 'silent' ? 'no answer for 14 s' : tabState === 'gone' ? 'reset at 19:44:07' : tabState === 'connecting' ? 'signing in' : scene === 'fresh' ? 'round trip 251 ms, post-quantum' : 'round trip 248 ms';
  const last = scene === 'fresh' ? 'Opened relay-fra, staging, in 0.9 s' : scene === 'dropped' ? 'relay-fra, deploy: the link was reset, new session in 4 s' : 'Uploaded ledger-4f2c1a9.tar.gz, sha-256 match, 4.2 s';
  return (
    <footer class="status">
      <span class={`s-conn st-${conn}`}><span class={`conn conn-${conn}`} />relay-fra, {place}</span>
      <span class={`s-rtt ${tabState === 'silent' || tabState === 'gone' ? 'problem' : ''}`}>{rtt}</span>
      <span class="s-key"><Glyph name="key" />key made by Berth, ed25519</span>
      <span class="s-last">{scene !== 'dropped' && <Glyph name="check" class="act-checked" />}{last}</span>
      <span class="s-size">132 x 38</span>
    </footer>
  );
}

function CloseDialog() {
  return (
    <div class="scrim">
      <div class="dialog act-remove" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
        <h1 id="dlg-title">Close deploy on relay-fra?</h1>
        <p class="dlg-lead">A command is still running in this tab. Closing it ends the command on the box.</p>
        <div class="dlg-cmd">
          <span class="dlg-cmd-text">deploy.sh 4f2c1a9 2&gt;&amp;1 | tee deploy-4f2c1a9.log</span>
          <span class="dlg-cmd-time">running 1:42</span>
        </div>
        <div class="dlg-actions">
          <button class="btn keep" autofocus>Keep it open</button>
          <button class="btn danger"><Glyph name="close" />Close tab</button>
        </div>
      </div>
    </div>
  );
}

function Window() {
  return (
    <div class="window">
      <TabBar />
      {scene === 'boxes' && <BoxMenu />}
      <div class="body">
        <FilePanel />
        <Terminal />
      </div>
      <StatusBar />
      {scene === 'dialog' && <CloseDialog />}
      {scene === 'addbox' && <AddBoxDialog />}
      {scene === 'trust' && <TrustDialog />}
      {scene === 'changed' && <ChangedDialog />}
      {scene === 'mismatch' && <MismatchDialog />}
      {scene === 'unreachable' && <UnreachableDialog />}
    </div>
  );
}

render(<Window />, document.getElementById('app')!);
document.documentElement.classList.add('drawn');
