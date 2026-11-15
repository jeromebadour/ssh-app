// Berth's main window in use, as if it were finished, in one of three directions. Built from the components the
// screens will be made of; drawn with invented data. A lab page: it exists to be pictured and chosen from.
//   ?d=a|b|c         the direction
//   ?scene=dialog    the "close a tab with a running command" dialog is open
//   ?scene=paths     the path bar's pinned and recent folders are open
import { render } from 'preact';
import { blocks, files, groups, pins, prompt, recent, tabGroups, type Box, type FileRow } from './data';
import { Glyph } from './glyphs';
import { marks } from './marks';

const q = new URLSearchParams(location.search);
const d = (['a', 'b', 'c'].includes(q.get('d') ?? '') ? q.get('d') : 'a') as 'a' | 'b' | 'c';
const scene = q.get('scene') ?? '';
document.documentElement.dataset['d'] = d;
const Mark = marks[d];

const stateWords: Record<Box['state'], string> = { connected: 'connected', reconnecting: 'reconnecting', idle: 'not open' };

function BoxList() {
  return (
    <nav class="boxes" aria-label="Boxes">
      <div class="side-switch" role="tablist">
        <button class="switch on" role="tab" aria-selected="true"><Glyph name="boxes" />Boxes</button>
        <button class="switch" role="tab" aria-selected="false"><Glyph name="search" />Find</button>
      </div>
      {groups.map((g) => (
        <section class="group" key={g.name}>
          <h2 class="group-name">{g.name}</h2>
          {g.boxes.map((b, i) => (
            <div class={`box st-${b.state}`} key={b.name} style={{ '--hue': b.hue }}>
              <div class="box-row">
                <span class="berth-no">{d === 'c' ? `P-${String(i + 1 + (g.name === 'Studio' ? 3 : 0)).padStart(2, '0')}` : ''}</span>
                <span class="box-dot" />
                <span class="box-name">{b.name}</span>
                <span class="box-state">{b.state === 'reconnecting' ? b.detail?.replace('retry in ', '') : b.places.some((p) => p.open) ? `${b.places.filter((p) => p.open).length} open` : ''}</span>
              </div>
              <div class="box-host">{b.host}</div>
              {b.places.length > 0 && (
                <ul class="places">
                  {b.places.map((p) => (
                    <li class={`place ${p.open ? 'open' : ''}`} key={p.name}>
                      <span class="place-mark" />
                      {p.name}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </section>
      ))}
      <button class="add-box"><Glyph name="plus" />Add box</button>
    </nav>
  );
}

function TabBar() {
  return (
    <header class="tabbar">
      <div class="brand">
        <Mark />
        <span class="wordmark">Berth</span>
      </div>
      <div class="tab-groups">
        {tabGroups.map((g) => (
          <div class={`tab-group st-${g.state}`} key={g.box} style={{ '--hue': g.hue }}>
            <span class="group-label"><span class="box-dot" />{g.box}</span>
            {g.tabs.map((t) => (
              <span class={`tab ${t.active ? 'active' : ''}`} key={t.place}>
                <span class={`conn conn-${g.state}`} title={stateWords[g.state]} />
                {t.place}
                {t.signal === 'running' && <span class="sig sig-running">1:42</span>}
                {t.signal === 'output' && <span class="sig sig-output" title="new output" />}
                {t.signal === 'done' && <Glyph name="check" class="sig sig-done" label="command finished" />}
                {t.active && <Glyph name="close" class="tab-x" label="Close tab" />}
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
      <div class="file-rows">
        {files.map((f) => (
          <div class={`file ${f.selected ? 'selected' : ''} ${f.fresh ? 'fresh' : ''} k-${f.kind}`} key={f.name}>
            <FileIcon row={f} />
            <span class="f-name"><span class="f-text">{f.name}</span>{f.fresh && <span class="f-new">new</span>}</span>
            <span class="f-size">{f.size ?? ''}</span>
            <span class="f-date">{f.modified ?? ''}</span>
          </div>
        ))}
      </div>
      <div class="transfers">
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
      </div>
      <div class="file-foot">
        <span>9 items, 1 selected, 48.6 MB</span>
        <span class="free">61.2 GB free</span>
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

function Terminal() {
  return (
    <section class="term" aria-label="Terminal on relay-fra">
      <div class="term-frame">
        <div class="scrolled-out">older output scrolled out</div>
        {blocks.map((b, i) => (
          <div class={`block ${b.running ? 'running' : ''}`} key={i}>
            <div class="gutter">
              <span class="g-mark" />
              <span class="g-time">{b.running ?? b.took}</span>
            </div>
            <div class="block-body">
              <div class="line cmd"><Prompt />{b.cmd}</div>
              {b.out.map(([cls, text], j) => (
                <div class={`line ${cls}`} key={j}>{text}</div>
              ))}
              {b.running && <div class="line"><span class="cursor" /></div>}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function StatusBar() {
  return (
    <footer class="status">
      <span class="s-conn"><span class="conn conn-connected" />relay-fra, deploy</span>
      <span class="s-rtt">round trip 248 ms</span>
      <span class="s-key"><Glyph name="key" />key made by Berth, ed25519</span>
      <span class="s-last"><Glyph name="check" class="act-checked" />Uploaded ledger-4f2c1a9.tar.gz, sha-256 match, 4.2 s</span>
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
      <div class="atmosphere" aria-hidden="true" />
      <TabBar />
      <div class="body">
        <BoxList />
        <FilePanel />
        <Terminal />
      </div>
      <StatusBar />
      {scene === 'dialog' && <CloseDialog />}
    </div>
  );
}

render(<Window />, document.getElementById('app')!);
document.documentElement.classList.add('drawn');
