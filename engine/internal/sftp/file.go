package sftp

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sync"
)

// The most this client asks for in one read or write. The protocol allows more, but OpenSSH's own server
// answers at most 256 KiB and a larger ask is cut short anyway; this leaves room for the packet around it.
const Block = 32 << 10

// File is one open file on a box. Every read and write names where in the file it goes, so nothing depends on
// a position the box keeps: a transfer that is taken up again after a drop asks for the byte it needs.
type File struct {
	c      *Client
	handle []byte
	closed bool
}

// Open opens a file for reading.
func (c *Client) Open(ctx context.Context, p string) (*File, error) {
	return c.open(ctx, p, openRead, 0)
}

// Create makes a file and opens it for writing, refusing to replace one that is already there. A transfer
// writes to a name of its own and moves it into place, so replacing is never done by this call.
func (c *Client) Create(ctx context.Context, p string, mode uint32) (*File, error) {
	return c.open(ctx, p, openWrite|openCreat|openExcl|openTrunc, mode)
}

// WriteOn opens a file that is already there for writing, without emptying it. It is how a transfer that
// broke is taken up where it stopped: what is already in the file stays, and the rest is written after it.
func (c *Client) WriteOn(ctx context.Context, p string) (*File, error) {
	return c.open(ctx, p, openRead|openWrite, 0)
}

func (c *Client) open(ctx context.Context, p string, flags, mode uint32) (*File, error) {
	a, err := c.ask(ctx, fxpOpen, func(w *writer) {
		w.string(p)
		w.u32(flags)
		if mode == 0 {
			w.u32(0)
			return
		}
		w.u32(attrPermissions)
		w.u32(mode)
	})
	if err != nil {
		return nil, err
	}
	if a.kind == fxpStatus {
		return nil, statusOf(a)
	}
	if a.kind != fxpHandle {
		return nil, fmt.Errorf("sftp: the box answered %d where a handle was due", a.kind)
	}
	r := &reader{b: a.body}
	h := append([]byte(nil), r.str()...)
	if !r.ok() || len(h) > MaxNameLen {
		return nil, ErrShort
	}
	return &File{c: c, handle: h}, nil
}

// ReadAt fills p from this place in the file. It returns io.EOF at the end, as a reader does, and never more
// bytes than were asked for however much a box sends.
func (f *File) ReadAt(ctx context.Context, p []byte, at uint64) (int, error) {
	if f.closed {
		return 0, ErrClosed
	}
	want := len(p)
	if want > Block {
		want = Block
	}
	a, err := f.c.ask(ctx, fxpRead, func(w *writer) {
		w.str(f.handle)
		w.u64(at)
		w.u32(uint32(want))
	})
	if err != nil {
		return 0, err
	}
	if a.kind == fxpStatus {
		err := statusOf(a)
		var s *Status
		if errors.As(err, &s) && s.Code == fxEOF {
			return 0, io.EOF
		}
		if err == nil {
			return 0, io.EOF
		}
		return 0, err
	}
	if a.kind != fxpData {
		return 0, fmt.Errorf("sftp: the box answered %d where data was due", a.kind)
	}
	r := &reader{b: a.body}
	data := r.str()
	if !r.ok() {
		return 0, ErrShort
	}
	// A box may answer with less than was asked for, which is allowed; more than was asked for is not, and is
	// not quietly cut to fit either, because a box doing that is not doing its job.
	if len(data) > want {
		return 0, fmt.Errorf("%w: %d bytes where %d were asked for", ErrTooLong, len(data), want)
	}
	return copy(p, data), nil
}

// WriteAt puts p at this place in the file. A box answers one status for each write, so a failure is known at
// once rather than at the end.
func (f *File) WriteAt(ctx context.Context, p []byte, at uint64) (int, error) {
	if f.closed {
		return 0, ErrClosed
	}
	if len(p) > Block {
		return 0, fmt.Errorf("%w: a write of %d bytes", ErrTooLong, len(p))
	}
	a, err := f.c.ask(ctx, fxpWrite, func(w *writer) {
		w.str(f.handle)
		w.u64(at)
		w.str(p)
	})
	if err != nil {
		return 0, err
	}
	if err := statusOf(a); err != nil {
		return 0, err
	}
	return len(p), nil
}

// Chmod sets the mode of an open file. A transfer uses it to put the replaced file's own mode on the new one
// before it is moved into place, so a file does not quietly change what may be done with it.
func (f *File) Chmod(ctx context.Context, mode uint32) error {
	if f.closed {
		return ErrClosed
	}
	a, err := f.c.ask(ctx, fxpFsetstat, func(w *writer) {
		w.str(f.handle)
		w.u32(attrPermissions)
		w.u32(mode)
	})
	if err != nil {
		return err
	}
	return statusOf(a)
}

// Close lets the box forget the file. A handle never closed is one the box keeps for ever, so this is called
// even when everything else has gone wrong.
func (f *File) Close(ctx context.Context) error {
	if f.closed {
		return nil
	}
	f.closed = true
	a, err := f.c.ask(ctx, fxpClose, func(w *writer) { w.str(f.handle) })
	if err != nil {
		return err
	}
	return statusOf(a)
}

// Remove takes away one file. Folders go through Rmdir, which only removes an empty one: this app never
// removes a folder's contents by itself (plan B2.5).
func (c *Client) Remove(ctx context.Context, p string) error {
	a, err := c.ask(ctx, fxpRemove, func(w *writer) { w.string(p) })
	if err != nil {
		return err
	}
	return statusOf(a)
}

// Rmdir takes away one empty folder.
func (c *Client) Rmdir(ctx context.Context, p string) error {
	a, err := c.ask(ctx, fxpRmdir, func(w *writer) { w.string(p) })
	if err != nil {
		return err
	}
	return statusOf(a)
}

// Readlink says where a link points. Where it points is shown and never followed by itself.
func (c *Client) Readlink(ctx context.Context, p string) (string, error) {
	a, err := c.ask(ctx, fxpReadlink, func(w *writer) { w.string(p) })
	if err != nil {
		return "", err
	}
	if a.kind == fxpStatus {
		return "", statusOf(a)
	}
	if a.kind != fxpName {
		return "", fmt.Errorf("sftp: the box answered %d where a name was due", a.kind)
	}
	r := &reader{b: a.body}
	if n := r.u32(); n != 1 {
		return "", fmt.Errorf("sftp: the box gave %d names where one was due", n)
	}
	name := r.str()
	if !r.ok() {
		return "", ErrShort
	}
	if len(name) > MaxNameLen {
		return "", ErrTooLong
	}
	return string(name), nil
}

// AtOnce is how many blocks a bulk transfer asks for at the same time. One ask per round trip is what a
// plain loop does, and it makes the distance to the box, not the link, decide the speed: measured at a
// 50 ms round trip, 32 KiB an ask came to 0.6 MiB/s, so a 5 GB file would have taken most of a day. Asking
// for this many at once turns that into one round trip per megabyte. The memory it costs is fixed and
// small: this many blocks, for one transfer at a time per tab.
const AtOnce = 32

// ReadInOrder reads the file from `at` to its end, asking for AtOnce blocks at a time, and hands each one
// to `take` in order and exactly once. In order matters: the hash of a transfer is taken as it goes, and a
// hash is only a hash if the bytes reach it in the order they sit in the file.
//
// A box is allowed to answer with less than was asked for in the middle of a file. When that happens the
// blocks after it are dropped unseen and the next round asks again from the end of what really arrived, so
// a short answer can leave no hole and can cost nothing but the one wasted round.
func (f *File) ReadInOrder(ctx context.Context, at uint64, take func(p []byte, at uint64) error) error {
	if f.closed {
		return ErrClosed
	}
	bufs := make([][]byte, AtOnce)
	for i := range bufs {
		bufs[i] = make([]byte, Block)
	}
	ns := make([]int, AtOnce)
	errs := make([]error, AtOnce)
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		var wg sync.WaitGroup
		for i := range bufs {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				ns[i], errs[i] = f.ReadAt(ctx, bufs[i], at+uint64(i)*Block)
			}(i)
		}
		wg.Wait()
		next := at + uint64(len(bufs))*Block
		for i := range bufs {
			if ns[i] > 0 {
				if err := take(bufs[i][:ns[i]], at+uint64(i)*Block); err != nil {
					return err
				}
			}
			if errs[i] != nil {
				if errors.Is(errs[i], io.EOF) {
					return nil
				}
				return errs[i]
			}
			if ns[i] < Block {
				// Short, and not the end of the file: whatever came after it in this round is dropped
				// unseen, and the next round asks again from where this block really stopped. So a short
				// answer can leave no hole and costs nothing but the rest of one round.
				next = at + uint64(i)*Block + uint64(ns[i])
				break
			}
		}
		at = next
	}
}

// WriteInOrder writes what `next` gives it, AtOnce blocks at a time, starting at `at`. `next` fills a block
// and says how many bytes it put there; it is called in order, once per block, which is what lets whoever
// gives the bytes hash them as they go. It returns io.EOF when there is no more.
//
// Nothing is written twice and nothing is skipped: a round is sent only after its blocks have been filled,
// and a round that fails stops the transfer rather than going on to the next.
func (f *File) WriteInOrder(ctx context.Context, at uint64, next func(p []byte) (int, error)) (uint64, error) {
	if f.closed {
		return 0, ErrClosed
	}
	bufs := make([][]byte, AtOnce)
	for i := range bufs {
		bufs[i] = make([]byte, Block)
	}
	held := make([][]byte, AtOnce)
	errs := make([]error, AtOnce)
	var wrote uint64
	for {
		if err := ctx.Err(); err != nil {
			return wrote, err
		}
		have, round := 0, uint64(0)
		var end error
		for i := range bufs {
			n, err := next(bufs[i][:Block])
			if n > 0 {
				held[i] = bufs[i][:n]
				round += uint64(n)
				have++
			}
			if err != nil {
				end = err
				break
			}
			if n < Block {
				break // only the last block of a round is ever short, so the offsets below hold
			}
		}
		var wg sync.WaitGroup
		for i := 0; i < have; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				_, errs[i] = f.WriteAt(ctx, held[i], at+uint64(i)*Block)
			}(i)
		}
		wg.Wait()
		for i := 0; i < have; i++ {
			if errs[i] != nil {
				return wrote, errs[i]
			}
		}
		wrote += round
		at += round
		if end != nil {
			if errors.Is(end, io.EOF) {
				return wrote, nil
			}
			return wrote, end
		}
		if have == 0 {
			return wrote, nil
		}
	}
}
