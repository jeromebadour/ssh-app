package keys

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"time"

	"sshapp/engine/internal/vault"
)

// The list on disk (plan B2.4, B6): one sealed file, replaced whole or not at all, with the copy it replaced
// kept beside it, and a second copy written to the backup folder at every save.

const (
	previousSuffix = ".previous"
	newSuffix      = ".new"
	// BackupName is the file a backup folder holds.
	BackupName = "Berth list backup.berth"
	maxFile    = 16 * 1024 * 1024
)

var (
	ErrNoList     = errors.New("keys: there is no list yet")
	ErrListExists = errors.New("keys: a list already exists here")
)

// Unlocked is the list open in memory together with the key that seals it. It exists from a right password
// until the process ends.
type Unlocked struct {
	*List
	path    string
	key     *vault.Key
	SavedAt time.Time // when the copy that was opened had been saved
}

// Exists says whether a list is there to unlock.
func Exists(path string) (bool, error) {
	_, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}

// Create makes the first, empty list under a new password. It refuses to replace one that is there.
func Create(path string, password []byte, p vault.Params, now time.Time) (*Unlocked, error) {
	if there, err := Exists(path); err != nil {
		return nil, err
	} else if there {
		return nil, ErrListExists
	}
	k, err := vault.NewKey(password, p)
	if err != nil {
		return nil, err
	}
	u := &Unlocked{List: New(), path: path, key: k, SavedAt: now}
	if _, err := u.Save(now); err != nil {
		k.Wipe()
		return nil, err
	}
	return u, nil
}

// Unlock opens the list at path. The errors are the vault's: a wrong password, a damaged file, and so on.
// Restoring is the same call on a backup file, followed by SaveAs.
func Unlock(path string, password []byte) (*Unlocked, error) {
	sealed, err := readCapped(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNoList
	}
	if err != nil {
		return nil, err
	}
	contents, k, info, err := vault.Open(password, sealed)
	if err != nil {
		return nil, err
	}
	l, err := Parse(contents)
	clear(contents)
	if err != nil {
		k.Wipe()
		return nil, err
	}
	return &Unlocked{List: l, path: path, key: k, SavedAt: info.SavedAt}, nil
}

func readCapped(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, maxFile+1))
	if err != nil {
		return nil, err
	}
	if len(b) > maxFile {
		return nil, vault.ErrTooBig
	}
	return b, nil
}

// HasPrevious says whether the copy replaced by the last save is there.
func HasPrevious(path string) bool {
	_, err := os.Stat(path + previousSuffix)
	return err == nil
}

// PreviousPath is where that copy is.
func PreviousPath(path string) string { return path + previousSuffix }

// Save seals the list and replaces the file on disk, keeping the copy it replaces, then writes the backup.
// The two results are apart on purpose: err means the list was not saved; backupErr means it was saved and
// only the backup copy failed, which is said to the person and never stops the save.
func (u *Unlocked) Save(now time.Time) (backupErr, err error) {
	contents, err := u.Contents()
	if err != nil {
		return nil, err
	}
	sealed, err := u.key.Seal(contents, now)
	clear(contents)
	if err != nil {
		return nil, err
	}
	if old, rerr := readCapped(u.path); rerr == nil {
		if err := writeWhole(u.path+previousSuffix, old); err != nil {
			return nil, err
		}
	} else if !errors.Is(rerr, os.ErrNotExist) {
		return nil, rerr
	}
	if err := writeWhole(u.path, sealed); err != nil {
		return nil, err
	}
	u.SavedAt = now
	if dir := u.BackupDir(); dir != "" {
		backupErr = writeWhole(filepath.Join(dir, BackupName), sealed)
	}
	return backupErr, nil
}

// SaveAs moves the open list to another path and saves it there: how a restored backup becomes the list.
func (u *Unlocked) SaveAs(path string, now time.Time) (backupErr, err error) {
	old := u.path
	u.path = path
	if backupErr, err = u.Save(now); err != nil {
		u.path = old
	}
	return backupErr, err
}

// ChangePassword seals the list under a new password from now on, and saves it.
func (u *Unlocked) ChangePassword(password []byte, p vault.Params, now time.Time) (backupErr, err error) {
	k, err := vault.NewKey(password, p)
	if err != nil {
		return nil, err
	}
	old := u.key
	u.key = k
	if backupErr, err = u.Save(now); err != nil {
		u.key = old
		k.Wipe()
		return nil, err
	}
	old.Wipe()
	return backupErr, nil
}

// Close wipes the keys and the sealing key.
func (u *Unlocked) Close() {
	u.Wipe()
	u.key.Wipe()
}

// writeWhole puts data at path so that the file there is always either the old one or the new one, whole:
// written beside it under another name, pushed to the disk, then renamed over it in one step.
func writeWhole(path string, data []byte) error {
	tmp := path + newSuffix
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	_, err = f.Write(data)
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		// Something else may hold the file for a moment (an antivirus that has just seen it): try again briefly.
		for attempt := 0; ; attempt++ {
			if err = os.Rename(tmp, path); err == nil || attempt == 9 {
				break
			}
			time.Sleep(100 * time.Millisecond)
		}
	}
	if err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if d, derr := os.Open(filepath.Dir(path)); derr == nil { // make the rename itself last a power cut, where the system can
		_ = d.Sync()
		_ = d.Close()
	}
	return nil
}
