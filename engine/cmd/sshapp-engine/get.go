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
	"fmt"
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
	// The temporary name carries this ask's own number, so two downloads at once in one tab cannot collide,
	// and it begins with a dot and ends with .part so it is this app's own and recognisable as unfinished.
	temp := filepath.Join(a.Into, fmt.Sprintf(".berth-%d.part", a.ID))
	_ = os.Remove(temp)
	to, err := os.OpenFile(temp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	// Anything but a clean finish takes the half-written file with it.
	landed := false
	defer func() {
		_ = to.Close()
		if !landed {
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

	sum := sha256.New()
	buf := make([]byte, sftp.Block)
	var got uint64
	said := time.Now()
	f.page(filePage{ID: a.ID, Got: 0, Of: was.Size})
	for {
		n, err := file.ReadAt(ctx, buf, got)
		if n > 0 {
			if _, werr := to.Write(buf[:n]); werr != nil {
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
