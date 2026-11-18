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
	var owner *[2]uint32 // the owner of the file being replaced, when there is one and the box said who
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
		if there.Has&sftp.AttrUIDGID != 0 {
			owner = &[2]uint32{there.UID, there.GID}
		}
	}

	// Room on the box for the whole of the new file beside everything already there, the file being replaced
	// included: it is still there while the new one is written.
	if sp, err := c.Space(ctx, into); err == nil && sp.Free > 0 && sp.Free < size+boxSpare {
		return errNoRoomOnBox
	}

	// The same half-written name every time, taken from the name the file will have, so a send that broke can
	// be taken up where it stopped rather than started again from nothing.
	temp := path.Join(into, partName(a.Name))
	var sent uint64
	if a.Resume {
		if had, err := c.Lstat(ctx, temp); err == nil && had.IsFile() && had.Size <= size {
			// Not the size it reached: the size of the last whole round below it. A round puts several
			// blocks on the wire at once, and they land in whatever order the box answers them, so a link
			// that died in the middle of one leaves a file as long as the furthest block that landed with
			// gaps below it. Taking the size at its word would have left those gaps in the file for good,
			// and on a box that cannot hash, that file would have been renamed into place over the old one
			// and called "not checked" rather than wrong. Every round begins at a multiple of its own size
			// counted from the start of the file, so everything below the last such mark is whole.
			// The mark must be STRICTLY below the size. A round's last block can be the only one of it that
			// landed, and then the file ends exactly on that round's own mark: dividing by the round size
			// and multiplying back gave that same mark, so the resume began above the hole instead of below
			// it. The round a size ends on is as unfinished as the round it falls inside.
			const round = uint64(sftp.AtOnce) * sftp.Block
			if had.Size > 0 {
				sent = (had.Size - 1) / round * round
			}
		}
	}
	if sent == 0 {
		_ = c.Remove(ctx, temp) // one left by a try of ours that will not be taken up
	}
	var to *sftp.File
	if sent > 0 {
		to, err = c.WriteOn(ctx, temp)
		if err != nil {
			sent = 0 // it cannot be written on after all: start again from nothing
		}
	}
	if sent == 0 {
		_ = c.Remove(ctx, temp)
		to, err = c.Create(ctx, temp, 0o600)
	}
	if err != nil {
		return err
	}
	if sent > 0 {
		f.page(filePage{ID: a.ID, Got: sent, Of: size, ResumedAt: sent})
	}
	// A clean finish moves it into place. One given up on by hand, or one the box disagrees with, takes its
	// half-written file with it; anything else leaves it for the next try to read on from.
	moved, binIt := false, false
	defer func() {
		done, stop := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer stop()
		_ = to.Close(done)
		if moved {
			return
		}
		if binIt || ctx.Err() != nil {
			_ = c.Remove(done, temp)
		}
	}()

	// The whole of the file on the PC is read and hashed, however much of it has already gone over: what is
	// compared at the end covers the whole file, so one put together from two tries is checked as one file.
	sum := sha256.New()
	buf := make([]byte, sftp.Block)
	var read uint64
	said := time.Now()
	if sent == 0 {
		f.page(filePage{ID: a.ID, Got: 0, Of: size})
	}
	// What has already gone over is read and hashed here and sent nowhere: the hash at the end covers the
	// whole file, so a put made of two tries is checked as one file.
	for read < sent {
		want := uint64(len(buf))
		if left := sent - read; left < want {
			want = left
		}
		n, err := io.ReadFull(from, buf[:want])
		if n > 0 {
			sum.Write(buf[:n])
			read += uint64(n)
		}
		if err != nil {
			return err
		}
	}
	// And the rest goes over with several blocks of it on the way at once. One block an ask means one round
	// trip a block, which makes the distance to the box decide the speed: 0.6 MiB/s at a 50 ms round trip,
	// where this gives 13. The blocks are filled here, in order, which is what lets the hash be taken as it
	// goes.
	wrote, werr := to.WriteInOrder(ctx, sent, func(p []byte) (int, error) {
		if err := ctx.Err(); err != nil {
			return 0, err
		}
		n, err := from.Read(p)
		if n > 0 {
			sum.Write(p[:n])
			read += uint64(n)
			if time.Since(said) >= sayEvery {
				said = time.Now()
				f.page(filePage{ID: a.ID, Got: read, Of: size})
			}
		}
		if err == nil && n == 0 {
			return 0, io.EOF
		}
		return n, err
	})
	sent += wrote
	if werr != nil {
		return werr
	}
	// The permissions the file will wear, put on before it is in place, so it is never in place wearing the
	// wrong ones for even a moment.
	if err := to.Chmod(ctx, mode); err != nil {
		return err
	}
	// And its owner, when it is replacing a file that had one. Only the account that may do it can, so a box
	// that refuses is not a failure of the send: the file goes over, and the row says plainly that it is
	// wearing a different owner than the file it replaced. Saying nothing was the fault: a config owned by a
	// service came back owned by whoever sent it, and the service could no longer read its own file.
	ownerKept := true
	if owner != nil {
		if err := to.Chown(ctx, owner[0], owner[1]); err != nil {
			ownerKept = false
		}
	}
	if err := to.Close(ctx); err != nil {
		return err
	}

	// What the box says arrived, by its own hash, against the hash of what was read here.
	mark, why := "checked", ""
	if !ownerKept {
		why = "it is wearing a different owner than the file it replaced: this account may not set one"
	}
	// Whatever the hash says is said as well as the owner and never instead of it: a send that could
	// neither keep the owner nor be checked has two things worth knowing, and overwriting the first with
	// the second left the owner it is now wearing unsaid.
	alsoWhy := func(reason string) string {
		if why == "" {
			return reason
		}
		return why + "; " + reason
	}
	here := hex.EncodeToString(sum.Sum(nil))
	there, err := f.l.Hash(ctx, link.SHA256, temp)
	switch {
	case errors.Is(err, link.ErrNameNotSafe):
		mark, why = "not-checked", alsoWhy("its name cannot be put in a command on a box")
	case errors.Is(err, link.ErrNoHash):
		mark, why = "not-checked", alsoWhy("the box answered with no hash")
	case err != nil:
		if ctx.Err() != nil {
			return err
		}
		mark, why = "not-checked", alsoWhy(say(err))
	case there != here:
		// What arrived is not what was sent, and the file on the PC did not move under us: nothing is put in
		// place, and the temporary file goes.
		now, serr := os.Stat(a.From)
		if serr == nil && (now.Size() != was.Size() || !now.ModTime().Equal(was.ModTime())) {
			mark = "changed"
		} else {
			binIt = true
			return errNotTheSame
		}
	}

	if err := c.Rename(ctx, temp, final); err != nil {
		return err
	}
	moved = true
	f.page(filePage{ID: a.ID, Got: read, Of: size, Landed: a.Name, Mark: mark, MarkWhy: why, Replaced: replacing})
	return nil
}
