package main

// Deleting a file on a box, in a way that can be undone (plan B4.4).
//
// Nothing is removed. A delete is one rename into a trash folder on the same disk, which is instant whatever
// the size, and which can be undone by renaming it back. What was deleted, where it came from and when are
// written down inside the trash itself, so Restore still works after this app is reinstalled or run from
// another PC: the record belongs to the box, not to us.
//
// One trash per disk, at the top of that disk. A rename cannot cross a filesystem, so a trash anywhere else
// would work for some files and not others, and the ones it did not work for would be the big ones. Which disk
// a path is on is asked of the box (the filesystem id it reports), never guessed from the path.
//
// Where no trash can be made, that is known before anything is deleted and said plainly, rather than found out
// half way through.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"strings"
	"time"

	"sshapp/engine/internal/sftp"
)

// The trash's name, at the top of each disk. It begins with a dot so it is out of the way, and it carries the
// app's name so nobody wonders what left it there.
const trashName = ".berth-trash"

// What is written down about each deleted thing, one JSON object per line inside the trash. A line is appended
// and never rewritten, so two tabs deleting at once cannot lose each other's record.
type trashed struct {
	Name  string `json:"name"` // what it is called inside the trash
	From  string `json:"from"` // the whole path it was deleted from
	When  int64  `json:"when"` // when it was deleted, as the PC saw it
	Size  uint64 `json:"size"` // what it was, for the dialog and for what the trash is holding
	Kind  string `json:"kind"` // file or folder
	Gone  bool   `json:"gone"` // it has been put back or emptied: the line stands, the thing does not
	Index string `json:"-"`
}

const (
	// How long something stays in the trash before it is emptied on connecting.
	trashDays = 7
	// The longest the record may grow before the oldest lines are dropped with what they describe.
	trashIndexMax = 4 << 20
)

var (
	// errNoTrash is a disk that cannot hold a trash at all, so a delete there would have to be forever.
	errNoTrash = errors.New("files: nothing can be deleted here, because this disk cannot hold a trash")
	// errRefused is a path the browser will not delete whatever is asked (refuse.go).
	errRefused = errors.New("files: that is not something this browser deletes")
)

// diskTop finds the top of the disk a path is on: the highest folder above it that is still the same
// filesystem, as the box itself reports. One step above that is another disk, which a rename cannot cross.
func diskTop(ctx context.Context, c *sftp.Client, where string) (string, sftp.Space, error) {
	here, err := c.Space(ctx, where)
	if err != nil {
		return "", sftp.Space{}, err
	}
	top := tidy(where)
	if top == "" {
		return "", sftp.Space{}, errNotAName
	}
	for top != "/" {
		up := path.Dir(top)
		at, err := c.Space(ctx, up)
		if err != nil || at.Id != here.Id {
			break
		}
		top = up
	}
	return top, here, nil
}

// trashOn makes sure the disk a path is on has a trash, and gives its whole path.
func trashOn(ctx context.Context, c *sftp.Client, where string) (string, error) {
	top, at, err := diskTop(ctx, c, where)
	if err != nil {
		return "", err
	}
	if at.ReadOnly {
		return "", errNoTrash
	}
	bin := path.Join(top, trashName)
	if got, err := c.Lstat(ctx, bin); err == nil {
		if !got.IsDir() {
			return "", errNoTrash
		}
		return bin, nil
	}
	if err := c.Mkdir(ctx, bin); err != nil {
		if got, lerr := c.Lstat(ctx, bin); lerr == nil && got.IsDir() {
			return bin, nil // another tab made it a moment ago
		}
		return "", errNoTrash
	}
	// Nobody but this account reads what has been deleted.
	if f, err := c.Open(ctx, bin); err == nil {
		_ = f.Chmod(ctx, 0o700)
		_ = f.Close(ctx)
	}
	return bin, nil
}

// toTrash moves one thing into its disk's trash and writes down where it came from.
func (f *files) toTrash(ctx context.Context, c *sftp.Client, where string) (trashed, error) {
	real, err := realButNotTheLast(ctx, c, where)
	if err != nil {
		return trashed{}, err
	}
	if why := refuseReason(real); why != "" {
		return trashed{}, fmt.Errorf("%w: %s", errRefused, why)
	}
	at, err := c.Lstat(ctx, real)
	if err != nil {
		return trashed{}, err
	}
	bin, err := trashOn(ctx, c, path.Dir(real))
	if err != nil {
		return trashed{}, err
	}
	// A name of its own inside the trash, so two files called the same from different folders can both be in
	// there, and so nothing in the trash is ever written over.
	line := trashed{From: real, When: time.Now().Unix(), Size: at.Size, Kind: at.Kind()}
	line.Name = fmt.Sprintf("%d-%d-%s", line.When, f.nextTrash(), path.Base(real))
	if err := c.Rename(ctx, real, path.Join(bin, line.Name)); err != nil {
		return trashed{}, err
	}
	if err := writeRecord(ctx, c, bin, line); err != nil {
		// The thing is in the trash but nothing says where it came from: it is put back, so the box is left
		// exactly as it was rather than holding a file nobody can find again.
		_ = c.Rename(ctx, path.Join(bin, line.Name), real)
		return trashed{}, err
	}
	line.Index = path.Join(bin, "index")
	return line, nil
}

// realButNotTheLast works out where a path really is, without following the thing at the end of it. The
// folders above it are resolved, because that is what the refusal list has to judge and what decides which
// disk the thing is on; the last part is left exactly as it was written.
//
// Following it was a real way to lose a file: standing on a link and pressing Delete moved what the link
// pointed at into the trash and left the link dangling, so deleting /var/www/current took away the release
// it pointed to. A person deleting a link means the link.
func realButNotTheLast(ctx context.Context, c *sftp.Client, where string) (string, error) {
	clean := path.Clean(where)
	if !path.IsAbs(clean) || clean == "/" {
		return "", fmt.Errorf("%w: %s", errRefused, "that is not a path on the box")
	}
	dir, base := path.Split(clean)
	if base == "" || base == "." || base == ".." {
		return "", fmt.Errorf("%w: %s", errRefused, "that is not a thing to delete")
	}
	realDir, err := c.Realpath(ctx, path.Clean(dir))
	if err != nil {
		return "", err
	}
	return path.Join(realDir, base), nil
}

// fromTrash puts one thing back where it came from.
func (f *files) fromTrash(ctx context.Context, c *sftp.Client, bin, name string) (trashed, error) {
	lines, err := readIndex(ctx, c, bin)
	if err != nil {
		return trashed{}, err
	}
	for i := len(lines) - 1; i >= 0; i-- {
		if lines[i].Name != name || lines[i].Gone {
			continue
		}
		back := lines[i]
		if _, err := c.Lstat(ctx, back.From); err == nil {
			return trashed{}, errAlreadyThere
		}
		if _, err := c.Lstat(ctx, path.Dir(back.From)); err != nil {
			return trashed{}, errors.New("the folder it came from is not there any more")
		}
		if err := c.Rename(ctx, path.Join(bin, name), back.From); err != nil {
			return trashed{}, err
		}
		back.Gone = true
		// Its record goes with it: the thing is back where it came from, so nothing in the trash stands for
		// it any more. A record that stayed behind saying "gone" was only ever a way of saying this.
		_ = c.Remove(ctx, path.Join(bin, recordsIn, name+".json"))
		if old, err := readOldIndex(ctx, c, bin); err == nil && len(old) > 0 {
			_ = appendLine(ctx, c, path.Join(bin, "index"), back)
		}
		return back, nil
	}
	return trashed{}, sftp.ErrNoSuchFile
}

// what is in the trash now: the newest first, with anything already put back left out.
func inTheTrash(ctx context.Context, c *sftp.Client, bin string) ([]trashed, error) {
	lines, err := readIndex(ctx, c, bin)
	if err != nil {
		return nil, err
	}
	gone := map[string]bool{}
	for _, l := range lines {
		if l.Gone {
			gone[l.Name] = true
		}
	}
	out := make([]trashed, 0, len(lines))
	for i := len(lines) - 1; i >= 0; i-- {
		if lines[i].Gone || gone[lines[i].Name] {
			continue
		}
		if _, err := c.Lstat(ctx, path.Join(bin, lines[i].Name)); err != nil {
			continue // emptied, or taken away by something else: the line stands, the thing does not
		}
		out = append(out, lines[i])
	}
	return out, nil
}

// emptyOld removes what has been in the trash longer than it keeps things. It only ever removes inside the
// trash folder itself and never follows a link out of it.
func emptyOld(ctx context.Context, c *sftp.Client, bin string, days int) (int, uint64, error) {
	lines, err := inTheTrash(ctx, c, bin)
	if err != nil {
		return 0, 0, err
	}
	cut := time.Now().Add(-time.Duration(days) * 24 * time.Hour).Unix()
	var took int
	var freed uint64
	for _, l := range lines {
		if l.When > cut {
			continue
		}
		where := path.Join(bin, l.Name)
		if err := removeInTrash(ctx, c, bin, where); err != nil {
			continue
		}
		l.Gone = true
		_ = c.Remove(ctx, path.Join(bin, recordsIn, l.Name+".json"))
		if old, err := readOldIndex(ctx, c, bin); err == nil && len(old) > 0 {
			_ = appendLine(ctx, c, path.Join(bin, "index"), l)
		}
		took++
		freed += l.Size
	}
	return took, freed, nil
}

// removeInTrash removes one thing that is inside the trash, and refuses anything that is not. A folder is
// walked and emptied from the inside out; a link is removed as the link it is and never followed.
func removeInTrash(ctx context.Context, c *sftp.Client, bin, where string) error {
	if where != bin && !strings.HasPrefix(where, bin+"/") {
		return errRefused
	}
	at, err := c.Lstat(ctx, where)
	if err != nil {
		return err
	}
	if !at.IsDir() {
		return c.Remove(ctx, where)
	}
	var inside []string
	if err := c.List(ctx, where, func(e []sftp.Entry) error {
		for _, x := range e {
			inside = append(inside, x.Name)
		}
		return nil
	}); err != nil {
		return err
	}
	for _, name := range inside {
		if err := removeInTrash(ctx, c, bin, path.Join(where, name)); err != nil {
			return err
		}
	}
	return c.Rmdir(ctx, where)
}

// writeRecord writes down where one thing came from, in a file of its own named after it. One file per
// thing, rather than a line added to one record: that record was read, added to and written back, under one
// temporary name shared by every delete, so two deletes at the same moment lost one another's lines and the
// thing whose line went sat in the trash with nothing listing it and nothing ever emptying it. A file of its
// own cannot collide with anything, because the name it is given is the name the thing itself was given.
func writeRecord(ctx context.Context, c *sftp.Client, bin string, line trashed) error {
	folder := path.Join(bin, recordsIn)
	if err := c.Mkdir(ctx, folder); err != nil {
		// A box says "already there" in its own words, and not every box the same way, so what is asked is
		// whether the folder is there now. Without the record the thing would be in the trash and
		// unlistable, which is the fault this is here to prevent, so a folder that is really missing stops
		// the delete rather than letting it happen unrecorded.
		if at, serr := c.Stat(ctx, folder); serr != nil || !at.IsDir() {
			return err
		}
	}
	body, err := json.Marshal(line)
	if err != nil {
		return err
	}
	body = append(body, '\n')
	f, err := c.Create(ctx, path.Join(folder, line.Name+".json"), 0o600)
	if err != nil {
		return err
	}
	if _, err := f.WriteAt(ctx, body, 0); err != nil {
		_ = f.Close(ctx)
		return err
	}
	return f.Close(ctx)
}

// recordsIn is the folder inside a trash that holds one record per thing in it.
const recordsIn = "records"

// appendLine adds one line to the trash's record. It is read, added to and written back under a temporary
// name, then renamed into place, so a record is never left half written.
func appendLine(ctx context.Context, c *sftp.Client, where string, line trashed) error {
	had, err := readFileAt(ctx, c, where)
	if err != nil && !errors.Is(err, sftp.ErrNoSuchFile) {
		return err
	}
	body, err := json.Marshal(line)
	if err != nil {
		return err
	}
	out := append(had, body...)
	out = append(out, '\n')
	if len(out) > trashIndexMax {
		out = out[len(out)-trashIndexMax:]
		if cut := strings.IndexByte(string(out), '\n'); cut >= 0 {
			out = out[cut+1:]
		}
	}
	temp := where + ".new"
	_ = c.Remove(ctx, temp)
	to, err := c.Create(ctx, temp, 0o600)
	if err != nil {
		return err
	}
	for at := 0; at < len(out); at += sftp.Block {
		end := at + sftp.Block
		if end > len(out) {
			end = len(out)
		}
		if _, err := to.WriteAt(ctx, out[at:end], uint64(at)); err != nil {
			_ = to.Close(ctx)
			return err
		}
	}
	if err := to.Close(ctx); err != nil {
		return err
	}
	return c.Rename(ctx, temp, where)
}

func readIndex(ctx context.Context, c *sftp.Client, bin string) ([]trashed, error) {
	out, err := readRecords(ctx, c, bin)
	if err != nil {
		return nil, err
	}
	// And the one-file record that trashes made before this: a trash already on a box goes on listing.
	older, err := readOldIndex(ctx, c, bin)
	if err != nil {
		return nil, err
	}
	have := map[string]bool{}
	for _, l := range out {
		have[l.Name] = true
	}
	for _, l := range older {
		if !have[l.Name] {
			out = append(out, l)
		}
	}
	return out, nil
}

// readRecords reads the file-per-thing records.
func readRecords(ctx context.Context, c *sftp.Client, bin string) ([]trashed, error) {
	var names []string
	err := c.List(ctx, path.Join(bin, recordsIn), func(e []sftp.Entry) error {
		for _, x := range e {
			if strings.HasSuffix(x.Name, ".json") {
				names = append(names, x.Name)
			}
		}
		return nil
	})
	if errors.Is(err, sftp.ErrNoSuchFile) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []trashed
	for _, name := range names {
		body, err := readFileAt(ctx, c, path.Join(bin, recordsIn, name))
		if errors.Is(err, sftp.ErrNoSuchFile) {
			continue // taken away between the listing and the reading: it is simply not there
		}
		if err != nil {
			return nil, err
		}
		var l trashed
		if json.Unmarshal([]byte(strings.TrimSpace(string(body))), &l) == nil && l.Name != "" {
			out = append(out, l)
		}
	}
	return out, nil
}

func readOldIndex(ctx context.Context, c *sftp.Client, bin string) ([]trashed, error) {
	body, err := readFileAt(ctx, c, path.Join(bin, "index"))
	if errors.Is(err, sftp.ErrNoSuchFile) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []trashed
	for _, one := range strings.Split(string(body), "\n") {
		if strings.TrimSpace(one) == "" {
			continue
		}
		var l trashed
		if json.Unmarshal([]byte(one), &l) == nil && l.Name != "" {
			out = append(out, l)
		}
	}
	return out, nil
}

func readFileAt(ctx context.Context, c *sftp.Client, where string) ([]byte, error) {
	f, err := c.Open(ctx, where)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close(ctx) }()
	var out []byte
	buf := make([]byte, sftp.Block)
	for uint64(len(out)) < trashIndexMax {
		n, err := f.ReadAt(ctx, buf, uint64(len(out)))
		if n > 0 {
			out = append(out, buf[:n]...)
		}
		if errors.Is(err, io.EOF) || (err == nil && n == 0) {
			break
		}
		// A read that failed is not the end of a file. Treating it as one made a record that could not be
		// read in full look like a shorter record, and what was written back then held fewer lines than it
		// had: the things whose lines went are still in the trash, and nothing lists them.
		if err != nil {
			return nil, err
		}
	}
	return out, nil
}
