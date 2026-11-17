package main

// Sending a file from the PC to a box: the upload half of a transfer (plan B4.3).
//
// It mirrors the download. The file is written on the box under a short hidden name of this app's own in the
// same folder it is going to, so nothing on the box ever sees a half-written file under its real name, and a
// transfer that fails or is given up on takes its own temporary file with it. Only once the box's own hash of
// what arrived matches the hash of the bytes that were read here is it moved into place, in one step: on a box
// with OpenSSH's atomic rename that replaces whatever was there without a moment where neither exists.
//
// What is being replaced is looked at first. Its permissions are copied onto the new file before the rename, so
// a program on the box that was executable stays executable and a file that was private stays private. A name
// that is a link, or a folder, is not written to at all: the window asks about it instead, because following a
// link would write somewhere nobody chose.
//
// The view never names a file on the PC (plan B2.7). Main opens the system's own chooser and passes the whole
// path; the engine takes it as given, as it takes the landing name of a download.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"strings"
	"time"

	"sshapp/engine/internal/link"
	"sshapp/engine/internal/sftp"
)

// Room to leave on a box's disk beyond the file itself, so a transfer cannot be the thing that fills it.
const boxSpare = 16 << 20

var (
	// errNotAFolder is a place on the box that is not a folder to put a file in.
	errNotAFolder = errors.New("files: that is not a folder on the box")
	// errInTheWay is something already at that name on the box that this app will not write through: a folder,
	// or a link, which points somewhere nobody chose.
	errInTheWay = errors.New("files: something is already at that name that cannot be written through")
	// errNoRoomOnBox is a box whose disk cannot hold the file beside what is already there.
	errNoRoomOnBox = errors.New("files: the box's disk cannot hold it")
)

// What the name on the box may not hold. A name is a name: a separator would make it a path, and the protocol
// has no business carrying control characters in one.
func nameOnBox(name string) error {
	if name == "" || name == "." || name == ".." || len(name) > longestName {
		return errNotAName
	}
	if strings.ContainsAny(name, "/") || strings.ContainsRune(name, 0) {
		return errNotAName
	}
	for _, r := range name {
		if r < 0x20 || r == 0x7f {
			return errNotAName
		}
	}
	return nil
}

func (f *files) put(ctx context.Context, c *sftp.Client, a fileAsk) error {
	if err := nameOnBox(a.Name); err != nil {
		return err
	}
	// Where it is going: a folder on the box, as the box itself names it.
	into, err := c.Realpath(ctx, a.Path)
	if err != nil {
		return err
	}
	if at, err := c.Stat(ctx, into); err != nil {
		return err
	} else if !at.IsDir() {
		return errNotAFolder
	}
	from, err := os.Open(a.From)
	if err != nil {
		return err
	}
	defer func() { _ = from.Close() }()
	was, err := from.Stat()
	if err != nil {
		return err
	}
	if was.IsDir() {
		return errNotAName
	}
	size := uint64(was.Size())

	// What is already at that name, if anything. A folder or a link is never written through; a file is
	// replaced only when the ask says so, and its permissions are what the new file will wear.
	final := path.Join(into, a.Name)
	mode := uint32(0o644)
	replacing := false
	if there, err := c.Lstat(ctx, final); err == nil {
		if !there.IsFile() {
			return errInTheWay
		}
		if !a.Replace {
			// What is in the way, so the window can ask about it with the file in front of a person rather
			// than a bare name: how big it is and when it last changed.
			row := row(a.Name, there)
			f.page(filePage{ID: a.ID, There: &row, Of: size})
			return errAlreadyThere
		}
		replacing = true
		mode = there.Mode & 0o7777
	}

	// Room on the box for the whole of the new file beside everything already there, the file being replaced
	// included: it is still there while the new one is written.
	if sp, err := c.Space(ctx, into); err == nil && sp.Free > 0 && sp.Free < size+boxSpare {
		return errNoRoomOnBox
	}

	temp := path.Join(into, fmt.Sprintf(".berth-%d.part", a.ID))
	_ = c.Remove(ctx, temp) // one left by a run of ours that was killed outright
	to, err := c.Create(ctx, temp, 0o600)
	if err != nil {
		return err
	}
	moved := false
	defer func() {
		done, stop := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer stop()
		_ = to.Close(done)
		if !moved {
			_ = c.Remove(done, temp)
		}
	}()

	sum := sha256.New()
	buf := make([]byte, sftp.Block)
	var sent uint64
	said := time.Now()
	f.page(filePage{ID: a.ID, Got: 0, Of: size})
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		n, err := from.Read(buf)
		if n > 0 {
			if _, werr := to.WriteAt(ctx, buf[:n], sent); werr != nil {
				return werr
			}
			sum.Write(buf[:n])
			sent += uint64(n)
			if time.Since(said) >= sayEvery {
				said = time.Now()
				f.page(filePage{ID: a.ID, Got: sent, Of: size})
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
	// The permissions the file will wear, put on before it is in place, so it is never in place wearing the
	// wrong ones for even a moment.
	if err := to.Chmod(ctx, mode); err != nil {
		return err
	}
	if err := to.Close(ctx); err != nil {
		return err
	}

	// What the box says arrived, by its own hash, against the hash of what was read here.
	mark, why := "checked", ""
	here := hex.EncodeToString(sum.Sum(nil))
	there, err := f.l.Hash(ctx, link.SHA256, temp)
	switch {
	case errors.Is(err, link.ErrNameNotSafe):
		mark, why = "not-checked", "its name cannot be put in a command on a box"
	case errors.Is(err, link.ErrNoHash):
		mark, why = "not-checked", "the box answered with no hash"
	case err != nil:
		if ctx.Err() != nil {
			return err
		}
		mark, why = "not-checked", say(err)
	case there != here:
		// What arrived is not what was sent, and the file on the PC did not move under us: nothing is put in
		// place, and the temporary file goes.
		now, serr := os.Stat(a.From)
		if serr == nil && (now.Size() != was.Size() || !now.ModTime().Equal(was.ModTime())) {
			mark = "changed"
		} else {
			return errNotTheSame
		}
	}

	if err := c.Rename(ctx, temp, final); err != nil {
		return err
	}
	moved = true
	f.page(filePage{ID: a.ID, Got: sent, Of: size, Landed: a.Name, Mark: mark, MarkWhy: why, Replaced: replacing})
	return nil
}
