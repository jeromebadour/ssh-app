package sftp

import (
	"context"
	"errors"
	"fmt"
)

// Realpath asks the box what a path really is: where "." is, and what a path with ".." in it comes to. The
// answer is the box's own, and it is what every action after it names.
func (c *Client) Realpath(ctx context.Context, p string) (string, error) {
	a, err := c.ask(ctx, fxpRealpath, func(w *writer) { w.string(p) })
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

// Stat is what a box says about one path, following a link. Lstat does not follow one.
func (c *Client) Stat(ctx context.Context, p string) (Attrs, error)  { return c.stat(ctx, fxpStat, p) }
func (c *Client) Lstat(ctx context.Context, p string) (Attrs, error) { return c.stat(ctx, fxpLstat, p) }

func (c *Client) stat(ctx context.Context, kind byte, p string) (Attrs, error) {
	a, err := c.ask(ctx, kind, func(w *writer) { w.string(p) })
	if err != nil {
		return Attrs{}, err
	}
	if a.kind == fxpStatus {
		return Attrs{}, statusOf(a)
	}
	if a.kind != fxpAttrs {
		return Attrs{}, fmt.Errorf("sftp: the box answered %d where attributes were due", a.kind)
	}
	r := &reader{b: a.body}
	at := takeAttrs(r)
	if !r.ok() {
		return Attrs{}, ErrShort
	}
	return at, nil
}

// List reads a folder and hands each page to `page` as it arrives. Nothing is held whole: a folder of any size
// reaches the window as it is read, and a caller that stops wanting it stops the reading with its context.
//
// It stops at MaxEntries or MaxListBytes, whichever comes first, and says so, rather than growing without end
// for a box that answers a listing for ever.
func (c *Client) List(ctx context.Context, dir string, page func([]Entry) error) error {
	a, err := c.ask(ctx, fxpOpendir, func(w *writer) { w.string(dir) })
	if err != nil {
		return err
	}
	if a.kind == fxpStatus {
		return statusOf(a)
	}
	if a.kind != fxpHandle {
		return fmt.Errorf("sftp: the box answered %d where a handle was due", a.kind)
	}
	r := &reader{b: a.body}
	handle := append([]byte(nil), r.str()...)
	if !r.ok() || len(handle) > MaxNameLen {
		return ErrShort
	}
	// The folder is closed whatever happens, including when the caller gives up: a handle left open is one the
	// box keeps for ever.
	defer func() {
		done, cancel := context.WithTimeout(context.WithoutCancel(ctx), Deadline)
		defer cancel()
		_, _ = c.ask(done, fxpClose, func(w *writer) { w.str(handle) })
	}()

	entries, bytes := 0, 0
	for {
		a, err := c.ask(ctx, fxpReaddir, func(w *writer) { w.str(handle) })
		if err != nil {
			return err
		}
		if a.kind == fxpStatus {
			err := statusOf(a)
			if err == nil {
				return nil
			}
			var s *Status
			if errors.As(err, &s) && s.Code == fxEOF {
				return nil // the folder is read to its end
			}
			return err
		}
		if a.kind != fxpName {
			return fmt.Errorf("sftp: the box answered %d where names were due", a.kind)
		}
		r := &reader{b: a.body}
		n := r.u32()
		if !r.ok() || uint64(n) > MaxEntries {
			return ErrTooMany
		}
		out := make([]Entry, 0, n)
		for i := uint32(0); i < n; i++ {
			name := r.str()
			// The long form a box prints for `ls -l`. The app draws its own rows and never shows this line,
			// but it is the only place the owner's name is carried: the protocol itself has the owner as a
			// number alone.
			long := r.str()
			at := takeAttrs(r)
			if !r.ok() {
				return ErrShort
			}
			if len(name) > MaxNameLen {
				return ErrTooLong
			}
			owner := ownerOf(string(long))
			bytes += len(name) + len(owner) + 64
			entries++
			if entries > MaxEntries || bytes > MaxListBytes {
				return ErrTooMany
			}
			// "." and ".." are the folder itself and the one above it; the window offers its own way up.
			if s := string(name); s != "." && s != ".." {
				out = append(out, Entry{Name: s, Attrs: at, Owner: owner})
			}
		}
		if len(out) > 0 {
			if err := page(out); err != nil {
				return err
			}
		}
	}
}

// Space is what the box says about the disk a path is on. It is an OpenSSH extension, so a box that does not
// offer it is not a fault: the caller is told plainly that this box does not say.
func (c *Client) Space(ctx context.Context, p string) (Space, error) {
	const ext = "statvfs@openssh.com"
	if !c.Can(ext) {
		return Space{}, ErrUnsupported
	}
	a, err := c.ask(ctx, fxpExtended, func(w *writer) {
		w.string(ext)
		w.string(p)
	})
	if err != nil {
		return Space{}, err
	}
	if a.kind == fxpStatus {
		return Space{}, statusOf(a)
	}
	if a.kind != fxpExtendedReply {
		return Space{}, fmt.Errorf("sftp: the box answered %d where an extended reply was due", a.kind)
	}
	// The extension's answer, in the order OpenSSH's own server writes it: block size, fundamental block size,
	// blocks in all, blocks free, blocks this user may use, and then counts of files this app does not show.
	r := &reader{b: a.body}
	r.u64() // f_bsize
	unit := r.u64()
	blocks := r.u64()
	r.u64() // f_bfree: free to root, which is not what a person may use
	avail := r.u64()
	r.u64() // f_files
	r.u64() // f_ffree
	r.u64() // f_favail
	id := r.u64()
	flag := r.u64()
	if !r.ok() {
		return Space{}, ErrShort
	}
	// The one flag this app reads: a filesystem that takes no writes. The extension's own value, which is not
	// the operating system's: OpenSSH translates it on the way out.
	const readOnly = 0x1
	return Space{Total: times(unit, blocks), Free: times(unit, avail), Id: id, ReadOnly: flag&readOnly != 0}, nil
}

// Rename moves a file. It uses OpenSSH's own rename when the box offers it, which replaces the target in one
// step; the protocol's own rename refuses to replace anything, which is not what a move means here.
func (c *Client) Rename(ctx context.Context, from, to string) error {
	const ext = "posix-rename@openssh.com"
	if c.Can(ext) {
		a, err := c.ask(ctx, fxpExtended, func(w *writer) {
			w.string(ext)
			w.string(from)
			w.string(to)
		})
		if err != nil {
			return err
		}
		return statusOf(a)
	}
	a, err := c.ask(ctx, fxpRename, func(w *writer) {
		w.string(from)
		w.string(to)
	})
	if err != nil {
		return err
	}
	return statusOf(a)
}

// RenameNew gives a thing a new name and refuses to replace anything at that name. It is what a person's own
// rename uses: the protocol's own rename, which a box must fail when the new name is taken, and never
// OpenSSH's replacing one. A transfer's rename into place is the other kind and stays as it is.
func (c *Client) RenameNew(ctx context.Context, from, to string) error {
	a, err := c.ask(ctx, fxpRename, func(w *writer) {
		w.string(from)
		w.string(to)
	})
	if err != nil {
		return err
	}
	return statusOf(a)
}

// Mkdir makes one folder.
func (c *Client) Mkdir(ctx context.Context, p string) error {
	a, err := c.ask(ctx, fxpMkdir, func(w *writer) {
		w.string(p)
		w.u32(0) // no attributes of our choosing: the box's own default
	})
	if err != nil {
		return err
	}
	return statusOf(a)
}

// times multiplies a block size by a count without wrapping round: a box chooses both numbers, and a wrapped
// product would say a full disk is empty.
func times(unit, count uint64) uint64 {
	if unit == 0 || count == 0 {
		return 0
	}
	if count > ^uint64(0)/unit {
		return ^uint64(0)
	}
	return unit * count
}
