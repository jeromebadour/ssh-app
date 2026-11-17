package main

// Bringing a file from a box onto the PC: the download half of a transfer (plan B4.3).
//
// What arrives is never visible under its real name half-written. It is written beside where it is going, under
// a hidden temporary name of this app's own, and only a file that is whole and proved is moved into place, in
// one step the operating system cannot leave half done. A download that is given up on, or that fails, takes
// its own temporary file with it: the app knows which ones are its own and never touches another.
//
// Proved means the box's own hash of the file matches the hash of the bytes that were written here (plan B2.5,
// entry 3). Where the file changed on the box while it was being read, the two cannot match and that is not a
// fault of the link: the file is delivered and marked as changed while it was read, rather than thrown away
// (review 38). Where the box cannot be asked at all, it is delivered and marked as not checked. Nothing is ever
// marked checked that was not.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"sshapp/engine/internal/link"
	"sshapp/engine/internal/sftp"
)

var (
	// errNotAName is a landing name that is not a plain name. Main works the name out (src/common/landing.ts)
	// and this is the second pair of eyes on it, so that nothing a view ever said can become a path.
	errNotAName = errors.New("files: that is not a name a file may land under")
	// errAlreadyThere is a file already in the way, where the ask did not say to replace it.
	errAlreadyThere = errors.New("files: a file of that name is already there")
	// errNotTheSame is a box whose own hash of the file is not the hash of what arrived, with the file
	// unchanged on the box meanwhile. Something between the two ends altered it.
	errNotTheSame = errors.New("files: what arrived is not what the box has")
)

// How often the window is told how far a download has got: often enough to show a speed that moves, seldom
// enough that a fast link does not spend itself on saying so.
const sayEvery = 200 * time.Millisecond

// The longest name a file may land under, and the characters a name may never hold. Windows decides both; the
// name arrives already made safe, and this only refuses what could still become a path.
const longestName = 255

func landingName(name string) error {
	if name == "" || len(name) > longestName || name == "." || name == ".." {
		return errNotAName
	}
	if strings.ContainsAny(name, `/\`) || strings.ContainsRune(name, 0) {
		return errNotAName
	}
	return nil
}

// partName is what a file is called while it is still arriving: the same name every time, so a transfer that
// broke can be taken up where it stopped. A dot in front keeps it out of the way and .part says what it is.
func partName(name string) string { return ".berth-" + name + ".part" }

func (f *files) get(ctx context.Context, c *sftp.Client, a fileAsk) error {
	if err := landingName(a.Name); err != nil {
		return err
	}
	if !filepath.IsAbs(a.Into) {
		return errNotAName
	}
	was, err := c.Stat(ctx, a.Path)
	if err != nil {
		return err
	}
	if !was.IsFile() {
		return errors.New("only a regular file can be brought over")
	}
	final := filepath.Join(a.Into, a.Name)
	if !a.Replace {
		if _, err := os.Lstat(final); err == nil {
			return errAlreadyThere
		}
	}
	// The temporary name comes from the name the file will have, not from this ask, so the same file always
	// has the same half-written file waiting for it and a transfer that broke can be taken up again. It begins
	// with a dot and ends with .part, so it is this app's own and plainly unfinished.
	temp := filepath.Join(a.Into, partName(a.Name))
	// What is already there, when this is a second try at the same file. The bytes are read back and hashed
	// before the rest is asked for, so what is checked at the end is the whole file and not only the new part
	// of it: a file put together from two tries is still only delivered if the box agrees with all of it.
	var got uint64
	sum := sha256.New()
	if a.Resume {
		if had, err := os.Open(temp); err == nil {
			n, cerr := io.Copy(sum, had)
			_ = had.Close()
			if cerr == nil && n >= 0 && uint64(n) <= was.Size {
				got = uint64(n)
			} else {
				sum.Reset()
			}
		}
	}
	if got == 0 {
		_ = os.Remove(temp)
	}
	to, err := os.OpenFile(temp, os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if got > 0 {
		if err := to.Truncate(int64(got)); err != nil {
			return err
		}
		f.page(filePage{ID: a.ID, Got: got, Of: was.Size, ResumedAt: got})
	}
	// A clean finish moves the file into place. A transfer given up on by hand, or one whose bytes the box
	// disagrees with, takes its half-written file with it. Anything else leaves it where it is, because the
	// next try reads on from it rather than starting again from nothing.
	landed, binIt := false, false
	defer func() {
		_ = to.Close()
		if landed {
			return
		}
		if binIt || ctx.Err() != nil {
			_ = os.Remove(temp)
		}
	}()

	file, err := c.Open(ctx, a.Path)
	if err != nil {
		return err
	}
	defer func() {
		done, stop := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer stop()
		_ = file.Close(done)
	}()

	buf := make([]byte, sftp.Block)
	said := time.Now()
	if got == 0 {
		f.page(filePage{ID: a.ID, Got: 0, Of: was.Size})
	}
	for {
		n, err := file.ReadAt(ctx, buf, got)
		if n > 0 {
			if _, werr := to.WriteAt(buf[:n], int64(got)); werr != nil {
				return werr
			}
			sum.Write(buf[:n])
			got += uint64(n)
			if time.Since(said) >= sayEvery {
				said = time.Now()
				f.page(filePage{ID: a.ID, Got: got, Of: was.Size})
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
	if err := to.Sync(); err != nil {
		return err
	}
	if err := to.Close(); err != nil {
		return err
	}

	// What the box says the file is, by its own hash, against the hash of what was written here.
	mark, why := "checked", ""
	here := hex.EncodeToString(sum.Sum(nil))
	there, err := f.l.Hash(ctx, link.SHA256, a.Path)
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
		// Not the same. A file that changed on the box while it was read cannot match, and that is the file
		// moving, not the link lying: it is said as changed. Anything else is a real mismatch.
		now, serr := c.Stat(ctx, a.Path)
		if serr == nil && (now.Size != was.Size || now.MTime != was.MTime) {
			mark = "changed"
		} else {
			binIt = true
			return errNotTheSame
		}
	}

	if err := os.Rename(temp, final); err != nil {
		return err
	}
	landed = true
	f.page(filePage{ID: a.ID, Got: got, Of: was.Size, Landed: a.Name, Mark: mark, MarkWhy: why})
	return nil
}
