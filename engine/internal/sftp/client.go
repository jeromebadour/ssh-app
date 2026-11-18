package sftp

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"
)

// What a box may not make this client do, whatever it answers.
const (
	// A folder listing stops here. A box can answer a listing for ever; the window shows pages, and a folder
	// this large is already past anything a person reads (plan B9 names 200,000 as the case to survive).
	MaxEntries = 200_000
	// And the bytes a listing may take in all, whatever the entry count: names are the box's to choose.
	MaxListBytes = 64 << 20
	// One name. Longer than any filesystem allows, so a longer one is a box misbehaving.
	MaxNameLen = 4096
	// How long a request may go unanswered on a live link before it is given up. The window says "still
	// waiting" long before this (plan B4.1).
	Deadline = 60 * time.Second
)

// Errors a caller tells apart.
var (
	ErrNoSuchFile  = errors.New("sftp: no such file or folder")
	ErrDenied      = errors.New("sftp: the box refused it")
	ErrNotAFolder  = errors.New("sftp: not a folder")
	ErrUnsupported = errors.New("sftp: the box does not do that")
	ErrTooMany     = errors.New("sftp: more entries than this app will read from one folder")
	ErrClosed      = errors.New("sftp: the file channel is closed")
	ErrNoBytes     = errors.New("sftp: the box answered a read with no bytes and no end of file")
)

// Status is a box's refusal, with its own code and whatever words it gave.
type Status struct {
	Code uint32
	Say  string
}

func (s *Status) Error() string {
	if s.Say != "" {
		return fmt.Sprintf("sftp: the box said: %s", s.Say)
	}
	return fmt.Sprintf("sftp: the box refused it (%d)", s.Code)
}

// Unwrap turns a box's code into the error a caller tells apart.
func (s *Status) Unwrap() error {
	switch s.Code {
	case fxNoSuchFile:
		return ErrNoSuchFile
	case fxPermissionDenied:
		return ErrDenied
	case fxOpUnsupported:
		return ErrUnsupported
	}
	return nil
}

// Attrs is what a box says about one file. Only what this app uses is kept.
type Attrs struct {
	Size  uint64
	Mode  uint32 // the POSIX mode, when the box gave one
	MTime uint32
	Has   uint32 // which of the above the box actually gave
}

// IsDir and the rest read the mode, and say what they do not know rather than guessing.
func (a Attrs) known() bool  { return a.Has&attrPermissions != 0 }
func (a Attrs) IsDir() bool  { return a.known() && a.Mode&0o170000 == 0o040000 }
func (a Attrs) IsFile() bool { return a.known() && a.Mode&0o170000 == 0o100000 }
func (a Attrs) IsLink() bool { return a.known() && a.Mode&0o170000 == 0o120000 }

// Kind is what the file is, in one word, for a window to show. A thing that is neither a regular file nor a
// folder is named rather than opened (plan B4.1).
func (a Attrs) Kind() string {
	if !a.known() {
		return "unknown"
	}
	switch a.Mode & 0o170000 {
	case 0o040000:
		return "folder"
	case 0o100000:
		return "file"
	case 0o120000:
		return "link"
	case 0o010000:
		return "pipe"
	case 0o020000:
		return "device"
	case 0o060000:
		return "device"
	case 0o140000:
		return "socket"
	}
	return "unknown"
}

// Entry is one row of a listing.
type Entry struct {
	Name  string
	Attrs Attrs
}

// Space is what a box says about the disk a folder is on.
type Space struct {
	Total uint64
	Free  uint64 // what this user may actually use
	// Which filesystem this is, as the box names it. Two paths with the same id are on the same disk, which is
	// what decides whether a file can be moved into a trash folder by a rename rather than copied.
	Id uint64
	// The filesystem takes no writes at all, so nothing can be made on it, trash included.
	ReadOnly bool
}

// Client talks SFTP over one channel of an SSH link. One request is in flight at a time per call, but calls may
// be made from several goroutines: each takes a number of its own and waits only for its own answer.
type Client struct {
	rw  io.ReadWriteCloser
	mu  sync.Mutex // one writer at a time
	seq uint32

	waitMu    sync.Mutex
	waiting   map[uint32]chan answer
	abandoned map[uint32]bool // given up on, but still ours: a late answer to one of these is dropped
	closed    bool
	fault     error

	exts map[string]bool // what the box said it can do beyond the protocol itself
}

type answer struct {
	kind byte
	body []byte
}

// Start opens the protocol on an already-open channel: it says which version it speaks and reads the box's
// answer. A box that answers something else, or nothing in time, is refused here and not later.
func Start(ctx context.Context, rw io.ReadWriteCloser) (*Client, error) {
	c := &Client{rw: rw, waiting: map[uint32]chan answer{}, abandoned: map[uint32]bool{}, exts: map[string]bool{}}
	var w writer
	w.u32(3) // the version this client speaks
	if err := writePacket(rw, fxpInit, w.b); err != nil {
		return nil, err
	}

	// The box's answer, with the same deadline as any request: a box that never answers must not hold a tab.
	type first struct {
		kind byte
		body []byte
		err  error
	}
	got := make(chan first, 1)
	go func() {
		kind, body, err := readPacket(rw, nil)
		got <- first{kind, append([]byte(nil), body...), err}
	}()
	select {
	case f := <-got:
		if f.err != nil {
			return nil, f.err
		}
		if f.kind != fxpVersion {
			return nil, fmt.Errorf("sftp: the box answered %d, not a version", f.kind)
		}
		r := &reader{b: f.body}
		if v := r.u32(); v != 3 {
			return nil, fmt.Errorf("sftp: the box speaks version %d, not 3", v)
		}
		// What it can do beyond the protocol. Both of the ones this app uses are OpenSSH's.
		for r.ok() && len(r.b) > 0 {
			name := string(r.str())
			r.str() // its value, which neither extension this app uses has anything in
			if r.ok() && name != "" {
				c.exts[name] = true
			}
		}
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-time.After(Deadline):
		return nil, fmt.Errorf("sftp: the box did not say which version it speaks")
	}

	go c.read()
	return c, nil
}

// Can says whether the box offered one of the extensions by name.
func (c *Client) Can(ext string) bool { return c.exts[ext] }

// read takes every answer from the box and hands it to whoever is waiting for that number. It is the only
// reader: nothing else touches the channel.
func (c *Client) read() {
	var buf []byte
	for {
		kind, body, err := readPacket(c.rw, buf)
		if err != nil {
			c.stop(err)
			return
		}
		// The number is the first value of every answer this client waits for.
		r := &reader{b: body}
		id := r.u32()
		if !r.ok() {
			c.stop(ErrShort)
			return
		}
		c.waitMu.Lock()
		ch, ours := c.waiting[id]
		if ours {
			delete(c.waiting, id)
		}
		late := c.abandoned[id]
		if late {
			delete(c.abandoned, id)
		}
		c.waitMu.Unlock()
		if late {
			// An answer to something that was given up on. It is still ours, so it is dropped and the link
			// goes on: a person moving quickly through folders leaves these behind constantly, and ending the
			// link for one would make the file browser unusable exactly when it is being used hardest.
			continue
		}
		if !ours {
			// An answer to nothing. A box that does this is not one to keep talking to: it has either lost
			// track or is trying something, and either way the next answers cannot be trusted to be ours.
			c.stop(ErrNotOurs)
			return
		}
		// The body is copied, because the buffer is used again by the next read.
		ch <- answer{kind: kind, body: append([]byte(nil), r.b...)}
	}
}

func (c *Client) stop(err error) {
	c.waitMu.Lock()
	if c.closed {
		c.waitMu.Unlock()
		return
	}
	c.closed = true
	c.fault = err
	waiting := c.waiting
	c.waiting = map[uint32]chan answer{}
	c.waitMu.Unlock()
	for _, ch := range waiting {
		close(ch)
	}
	_ = c.rw.Close()
}

// Close ends the protocol and everything waiting on it.
func (c *Client) Close() error {
	c.stop(ErrClosed)
	return nil
}

// ask sends one request and waits for its answer, for no longer than the deadline and no longer than the
// caller wants. A caller that gives up stops waiting at once; the number is left behind so that a late answer
// is still recognised as ours rather than ending the link.
func (c *Client) ask(ctx context.Context, kind byte, build func(w *writer)) (answer, error) {
	c.waitMu.Lock()
	if c.closed {
		err := c.fault
		c.waitMu.Unlock()
		if err == nil {
			err = ErrClosed
		}
		return answer{}, err
	}
	c.seq++
	id := c.seq
	ch := make(chan answer, 1)
	c.waiting[id] = ch
	c.waitMu.Unlock()

	var w writer
	w.u32(id)
	build(&w)

	c.mu.Lock()
	err := writePacket(c.rw, kind, w.b)
	c.mu.Unlock()
	if err != nil {
		c.forget(id)
		return answer{}, err
	}

	timer := time.NewTimer(Deadline)
	defer timer.Stop()
	select {
	case a, open := <-ch:
		if !open {
			c.waitMu.Lock()
			err := c.fault
			c.waitMu.Unlock()
			if err == nil {
				err = ErrClosed
			}
			return answer{}, err
		}
		return a, nil
	case <-ctx.Done():
		c.forget(id)
		return answer{}, ctx.Err()
	case <-timer.C:
		c.forget(id)
		return answer{}, fmt.Errorf("sftp: the box did not answer within %s", Deadline)
	}
}

// forget stops waiting for an answer but remembers that its number was ours, so the answer that arrives later
// is dropped rather than taken for an answer to nothing. The set is bounded: a box that never answers at all
// must not make this grow without end, and once it is full the oldest are let go, which at worst ends a link
// that was already not answering.
const mostAbandoned = 4096

func (c *Client) forget(id uint32) {
	c.waitMu.Lock()
	delete(c.waiting, id)
	if len(c.abandoned) >= mostAbandoned {
		for old := range c.abandoned {
			delete(c.abandoned, old)
			if len(c.abandoned) < mostAbandoned {
				break
			}
		}
	}
	c.abandoned[id] = true
	c.waitMu.Unlock()
}

// status reads an answer that can only be a status, and turns a refusal into an error.
func statusOf(a answer) error {
	if a.kind != fxpStatus {
		return fmt.Errorf("sftp: the box answered %d where a status was due", a.kind)
	}
	r := &reader{b: a.body}
	code := r.u32()
	say := string(r.str())
	if !r.ok() {
		return ErrShort
	}
	if code == fxOK {
		return nil
	}
	return &Status{Code: code, Say: say}
}

func takeAttrs(r *reader) Attrs {
	var a Attrs
	a.Has = r.u32()
	if a.Has&attrSize != 0 {
		a.Size = r.u64()
	}
	if a.Has&attrUIDGID != 0 {
		r.u32()
		r.u32()
	}
	if a.Has&attrPermissions != 0 {
		a.Mode = r.u32()
	}
	if a.Has&attrACModTime != 0 {
		r.u32()
		a.MTime = r.u32()
	}
	if a.Has&attrExtended != 0 {
		n := r.u32()
		// A box chooses how many of these there are, so it is bounded before anything is read.
		if n > 1024 {
			r.bad = true
			return a
		}
		for i := uint32(0); i < n && r.ok(); i++ {
			r.str()
			r.str()
		}
	}
	return a
}
