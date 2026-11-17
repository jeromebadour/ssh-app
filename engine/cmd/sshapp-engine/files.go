package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path"
	"strings"
	"sync"
	"syscall"
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
	Do   string `json:"do"`   // "list", "stat", "space", "read", "get", "put", "hash", "cancel"
	Path string `json:"path"` // the folder or file it is about
	// "get" only, and main's own: a tab's view never names a place on the PC (plan B2.7). Main works out the
	// folder everything lands in and the one name this file may land under, and the engine takes both as
	// given, checking only that the name really is a name and nothing else.
	Into    string `json:"into,omitempty"`
	Name    string `json:"name,omitempty"`
	Replace bool   `json:"replace,omitempty"`
	// "get" and "put": take up what a broken transfer left where it stopped, rather than starting again.
	Resume bool `json:"resume,omitempty"`
	// "put" only, and main's own: the whole path of the file on the PC to send. A view never names one.
	From string `json:"from,omitempty"`
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
	// "get": how it is going and how it ended.
	Got       uint64    `json:"got,omitempty"`       // bytes written to the PC so far
	Of        uint64    `json:"of,omitempty"`        // how big the box said the file is
	Landed    string    `json:"landed,omitempty"`    // the name it was given on the PC, once it is really there
	Mark      string    `json:"mark,omitempty"`      // "checked", "changed" or "not-checked": what its hash proved
	MarkWhy   string    `json:"markWhy,omitempty"`   // why it could not be checked, where it could not
	Replaced  bool      `json:"replaced,omitempty"`  // "put": it went in over a file that was already there
	There     *fileRow  `json:"there,omitempty"`     // "put": what is already at that name on the box
	Hash      string    `json:"hash,omitempty"`      // "hash": the box's own hash of the file, as it printed it
	Which     string    `json:"which,omitempty"`     // "hash": which hash it is
	ResumedAt uint64    `json:"resumedAt,omitempty"` // a transfer taken up again: how much was already there
	Trashed   *trashed  `json:"trashed,omitempty"`   // "delete" and "restore": the one thing that moved
	Trash     []trashed `json:"trash,omitempty"`     // "trash": what is in it now, newest first
	Emptied   int       `json:"emptied,omitempty"`   // "empty": how many things went
	Freed     uint64    `json:"freed,omitempty"`     // "empty": how much they were holding
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
	trashNo  uint64 // counts the things this engine has put in a trash, so two in one second differ
}

// nextTrash gives each thing put in a trash a number of its own within this engine.
func (f *files) nextTrash() uint64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.trashNo++
	return f.trashNo
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
	case "hash":
		// A box's own hash of one of its files, asked for because a person asked for it (plan B2.5, entry 3).
		// md5 is here only because people still paste md5 at each other; sha256 is what a transfer uses.
		which := link.SHA256
		if a.Name == "md5" {
			which = link.MD5
		} else if a.Name != "sha256" {
			return errors.New("only sha256 and md5 can be asked of a box")
		}
		sum, err := f.l.Hash(ctx, which, a.Path)
		if err != nil {
			return err
		}
		f.page(filePage{ID: a.ID, Hash: sum, Which: string(which)})
		return nil
	case "delete":
		// Nothing is removed: it is moved into the trash on its own disk, and what it was is said back so the
		// window can show what the trash now holds (plan B4.4).
		line, err := f.toTrash(ctx, c, a.Path)
		if err != nil {
			return err
		}
		f.page(filePage{ID: a.ID, Trashed: &line})
		return nil
	case "trash":
		bin, err := trashOn(ctx, c, a.Path)
		if err != nil {
			return err
		}
		lines, err := inTheTrash(ctx, c, bin)
		if err != nil {
			return err
		}
		f.page(filePage{ID: a.ID, Where: bin, Trash: lines})
		return nil
	case "restore":
		bin, err := trashOn(ctx, c, a.Path)
		if err != nil {
			return err
		}
		line, err := f.fromTrash(ctx, c, bin, a.Name)
		if err != nil {
			return err
		}
		f.page(filePage{ID: a.ID, Trashed: &line})
		return nil
	case "empty":
		// Everything older than the days this trash keeps things. It runs on connecting and can be asked for
		// by hand; either way it only ever removes inside the trash folder itself.
		bin, err := trashOn(ctx, c, a.Path)
		if err != nil {
			return err
		}
		took, freed, err := emptyOld(ctx, c, bin, trashDays)
		if err != nil {
			return err
		}
		f.page(filePage{ID: a.ID, Emptied: took, Freed: freed})
		return nil
	case "get":
		return f.get(ctx, c, a)
	case "put":
		return f.put(ctx, c, a)
	case "rename":
		// A new name for one thing, in the folder it is already in. The name arrives on its own and the path
		// it goes to is worked out here, so nothing a view sends can move a thing into another folder.
		// Nothing is ever replaced: the name is looked at first, and the rename itself is the kind a box must
		// refuse when the name is taken, so the gap between the two cannot cost a file either.
		if err := boxName(a.Name); err != nil {
			return err
		}
		// The path is tidied first and has to be a whole path from the box's root. A folder named with a
		// slash on the end would otherwise have its parent read as itself, and the rename would make a folder
		// inside the very thing being renamed.
		from := path.Clean(a.Path)
		if !path.IsAbs(from) || from == "/" {
			return errNotAName
		}
		to := path.Join(path.Dir(from), a.Name)
		if to == from {
			return errNotAName
		}
		if _, err := c.Lstat(ctx, to); err == nil {
			return errAlreadyThere
		} else if !errors.Is(err, sftp.ErrNoSuchFile) {
			return err
		}
		if err := c.RenameNew(ctx, from, to); err != nil {
			return err
		}
		at, err := c.Lstat(ctx, to)
		if err != nil {
			return err
		}
		r := row(to, at)
		f.page(filePage{ID: a.ID, Attrs: &r})
		return nil
	case "folder":
		// One new folder inside the folder named. Its permissions are the box's own: the same as a person
		// typing mkdir there, because a folder Berth makes must be no different from one they made.
		if err := boxName(a.Name); err != nil {
			return err
		}
		made := path.Join(a.Path, a.Name)
		if _, err := c.Lstat(ctx, made); err == nil {
			return errAlreadyThere
		} else if !errors.Is(err, sftp.ErrNoSuchFile) {
			return err
		}
		if err := c.Mkdir(ctx, made); err != nil {
			return err
		}
		at, err := c.Lstat(ctx, made)
		if err != nil {
			return err
		}
		r := row(made, at)
		f.page(filePage{ID: a.ID, Attrs: &r})
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

// boxName is what a thing on a box may be called when a person names it here: one plain name, and not a path.
// A slash would make it a step into another folder, and a control character would let a name lie in anything
// that is ever drawn or written as lines. The length is the one every box this app meets holds to.
func boxName(name string) error {
	if name == "" || len(name) > longestName || name == "." || name == ".." {
		return errNotAName
	}
	if strings.ContainsRune(name, '/') {
		return errNotAName
	}
	for _, r := range name {
		if r < 0x20 || r == 0x7f {
			return errNotAName
		}
	}
	return nil
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
	case errors.Is(err, errNotAName):
		return "not-a-name"
	case errors.Is(err, errAlreadyThere):
		return "already-there"
	case errors.Is(err, errNotTheSame):
		return "not-the-same"
	case errors.Is(err, errNotAFolder):
		return "not-a-folder"
	case errors.Is(err, errInTheWay):
		return "in-the-way"
	case errors.Is(err, errNoRoomOnBox):
		return "box-full"
	case errors.Is(err, errNoTrash):
		return "no-trash"
	case errors.Is(err, errRefused):
		return "refused"
	case errors.Is(err, os.ErrPermission):
		return "pc-denied"
	}
	if errors.Is(err, syscall.ENOSPC) {
		return "pc-full"
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
