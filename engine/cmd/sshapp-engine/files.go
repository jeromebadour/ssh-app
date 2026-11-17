package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"time"

	"sshapp/engine/internal/frame"
	"sshapp/engine/internal/link"
	"sshapp/engine/internal/sftp"
)

// What main may ask about a box's files, and what comes back. One channel of the link carries all of it, so a
// listing of a folder with thousands of files never holds up what is typed in the same tab.
//
// Every ask carries its own number and every page says which ask it belongs to, because a person moving quickly
// through folders leaves earlier listings still arriving: the window keeps the newest and drops the rest, and
// an ask that is given up is stopped here rather than read to its end for nobody.
type fileAsk struct {
	ID   uint64 `json:"id"`
	Do   string `json:"do"`   // "list", "stat", "space", "read", "cancel"
	Path string `json:"path"` // the folder or file it is about
}

type filePage struct {
	ID    uint64      `json:"id"`
	Rows  []fileRow   `json:"rows,omitempty"`
	Data  string      `json:"data,omitempty"`  // "read": a piece of a file, base64, in order from its start
	More  bool        `json:"more,omitempty"`  // "read": the file goes on past what was read
	Done  bool        `json:"done,omitempty"`  // this ask is finished, whether it gave rows or not
	Error string      `json:"error,omitempty"` // why it stopped, in words for the window to show
	Where string      `json:"where,omitempty"` // "list": the folder as the box itself names it
	Space *spaceShown `json:"space,omitempty"`
	Attrs *fileRow    `json:"attrs,omitempty"` // "stat": what one path is
}

type fileRow struct {
	Name  string `json:"name"`
	Kind  string `json:"kind"` // file, folder, link, pipe, device, socket, unknown
	Size  uint64 `json:"size"`
	Mode  uint32 `json:"mode"`
	MTime uint32 `json:"mtime"`
}

type spaceShown struct {
	Total uint64 `json:"total"`
	Free  uint64 `json:"free"`
}

// How many rows go in one page. Small enough that the first rows reach the window at once, large enough that a
// folder of thousands does not become thousands of messages.
const rowsPerPage = 200

// How much of a file the viewer reads at most, and how much travels in one page. The cap is what a person
// reads: a config file, a log, a script. Past it the file is not read at all and the window says so.
const (
	readCap   = 2 << 20 // 2 MiB
	readPiece = 128 << 10
)

// files is the engine's side of a tab's files: one channel, opened the first time anything is asked, and the
// asks running on it.
type files struct {
	o        *out
	l        *link.Link
	mu       sync.Mutex
	c        *sftp.Client
	failedAt time.Time // when the last try to open the channel failed
	failed   error     // and what it said, for asks inside the quiet time after it
	jobs     map[uint64]context.CancelFunc
}

// How long after a failed opening the same answer is given without asking the box again.
const quietAfterFail = 2 * time.Second

func newFiles(o *out, l *link.Link) *files {
	return &files{o: o, l: l, jobs: map[uint64]context.CancelFunc{}}
}

// client opens the file channel the first time it is wanted, and keeps it.
//
// A try that fails is not the end of it. The first ask can land in the moment before the link is really ready,
// and a box can be busy; treating one failure as final leaves the browser dead for as long as that tab lives,
// with nothing a person can do but close it. So the next ask tries again. What a failure does buy is a short
// quiet time, so a run of asks cannot turn one refusal into a storm of channel openings at a box.
func (f *files) client(ctx context.Context) (*sftp.Client, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.c != nil {
		return f.c, nil
	}
	if !f.failedAt.IsZero() && time.Since(f.failedAt) < quietAfterFail {
		return nil, f.failed
	}
	ch, err := f.l.OpenFiles()
	if err != nil {
		f.failedAt, f.failed = time.Now(), err
		return nil, err
	}
	c, err := sftp.Start(ctx, ch)
	if err != nil {
		_ = ch.Close()
		f.failedAt, f.failed = time.Now(), err
		return nil, err
	}
	f.c = c
	f.failedAt, f.failed = time.Time{}, nil
	return c, nil
}

// ask runs one thing main asked for, and sends back pages until it is done. It runs on its own goroutine, so
// one slow listing never holds up the next ask or anything else the engine is doing.
func (f *files) ask(a fileAsk) {
	if a.Do == "cancel" {
		f.mu.Lock()
		if stop, there := f.jobs[a.ID]; there {
			stop()
		}
		f.mu.Unlock()
		return
	}
	ctx, stop := context.WithCancel(context.Background())
	f.mu.Lock()
	// An id already running is not started again: main numbers them, and a repeat is a mistake somewhere.
	if _, there := f.jobs[a.ID]; there {
		f.mu.Unlock()
		stop()
		return
	}
	f.jobs[a.ID] = stop
	f.mu.Unlock()

	go func() {
		defer func() {
			f.mu.Lock()
			delete(f.jobs, a.ID)
			f.mu.Unlock()
			stop()
		}()
		if err := f.run(ctx, a); err != nil {
			if ctx.Err() != nil {
				f.page(filePage{ID: a.ID, Done: true}) // given up: said as finished, not as a failure
				return
			}
			f.page(filePage{ID: a.ID, Done: true, Error: say(err)})
			return
		}
		f.page(filePage{ID: a.ID, Done: true})
	}()
}

func (f *files) run(ctx context.Context, a fileAsk) error {
	c, err := f.client(ctx)
	if err != nil {
		return err
	}
	switch a.Do {
	case "list":
		// Where the folder really is, as the box itself works it out: every row after this is under that name
		// and not under what was typed, so "." and ".." are already settled when the window shows it.
		where, err := c.Realpath(ctx, a.Path)
		if err != nil {
			return err
		}
		f.page(filePage{ID: a.ID, Where: where})
		buf := make([]fileRow, 0, rowsPerPage)
		if err := c.List(ctx, where, func(e []sftp.Entry) error {
			for _, x := range e {
				buf = append(buf, row(x.Name, x.Attrs))
				if len(buf) >= rowsPerPage {
					f.page(filePage{ID: a.ID, Rows: buf})
					buf = make([]fileRow, 0, rowsPerPage)
				}
			}
			return nil
		}); err != nil {
			return err
		}
		if len(buf) > 0 {
			f.page(filePage{ID: a.ID, Rows: buf})
		}
		// What is left of the disk, when the box says. A box that does not is not a fault: the window simply
		// has nothing to show there.
		if sp, err := c.Space(ctx, where); err == nil {
			f.page(filePage{ID: a.ID, Space: &spaceShown{Total: sp.Total, Free: sp.Free}})
		}
		return nil
	case "read":
		// A file read for the window to show. It is read-only and it is capped: a viewer exists to look at a
		// config file or a log, and reading a ten-gigabyte file into a window is not that. What is past the
		// cap is not read at all, and the window is told the file goes on.
		at, err := c.Stat(ctx, a.Path)
		if err != nil {
			return err
		}
		if !at.IsFile() {
			return errors.New("only a regular file can be read")
		}
		file, err := c.Open(ctx, a.Path)
		if err != nil {
			return err
		}
		defer func() {
			done, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			defer cancel()
			_ = file.Close(done)
		}()
		buf := make([]byte, sftp.Block)
		piece := make([]byte, 0, readPiece)
		var read uint64
		for read < readCap {
			n, err := file.ReadAt(ctx, buf, read)
			if n > 0 {
				read += uint64(n)
				piece = append(piece, buf[:n]...)
				if len(piece) >= readPiece {
					f.pageData(a.ID, piece)
					piece = piece[:0]
				}
			}
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				return err
			}
			if n == 0 {
				break
			}
		}
		if len(piece) > 0 {
			f.pageData(a.ID, piece)
		}
		if read >= readCap && at.Size > read {
			f.page(filePage{ID: a.ID, More: true})
		}
		return nil
	case "stat":
		at, err := c.Stat(ctx, a.Path)
		if err != nil {
			return err
		}
		r := row(a.Path, at)
		f.page(filePage{ID: a.ID, Attrs: &r})
		return nil
	case "space":
		sp, err := c.Space(ctx, a.Path)
		if err != nil {
			return err
		}
		f.page(filePage{ID: a.ID, Space: &spaceShown{Total: sp.Total, Free: sp.Free}})
		return nil
	}
	return errors.New("the engine was asked something it does not do with files")
}

func row(name string, a sftp.Attrs) fileRow {
	return fileRow{Name: name, Kind: a.Kind(), Size: a.Size, Mode: a.Mode, MTime: a.MTime}
}

// say turns a refusal into the words a window shows. A box's own words are never passed through as they are:
// they are a box's to choose, and the window draws its own rows.
func say(err error) string {
	switch {
	case errors.Is(err, sftp.ErrNoSuchFile):
		return "no-such-file"
	case errors.Is(err, sftp.ErrDenied):
		return "denied"
	case errors.Is(err, sftp.ErrTooMany):
		return "too-many"
	case errors.Is(err, sftp.ErrUnsupported):
		return "unsupported"
	case errors.Is(err, context.DeadlineExceeded):
		return "no-answer"
	}
	return "failed"
}

// pageData sends one piece of a file, base64 so it travels in the same JSON page everything else does.
func (f *files) pageData(id uint64, b []byte) {
	f.page(filePage{ID: id, Data: base64.StdEncoding.EncodeToString(b)})
}

func (f *files) page(p filePage) {
	body, err := json.Marshal(p)
	if err != nil {
		return
	}
	f.o.send(frame.TypeFilePage, body)
}

// close ends every ask and the channel with them.
func (f *files) close() {
	f.mu.Lock()
	for _, stop := range f.jobs {
		stop()
	}
	f.jobs = map[uint64]context.CancelFunc{}
	c := f.c
	f.c = nil
	f.mu.Unlock()
	if c != nil {
		done := make(chan struct{})
		go func() {
			_ = c.Close()
			close(done)
		}()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
		}
	}
}
