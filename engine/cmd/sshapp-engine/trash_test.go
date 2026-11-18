package main

// Deleting on a box. Nothing is removed: a delete is a rename into a trash on the same disk, and what was
// deleted and where it came from is written down inside the trash itself, so Restore belongs to the box.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func trashOf(t *testing.T, box, disk string) string {
	t.Helper()
	return filepath.Join(box, filepath.FromSlash(disk), ".berth-trash")
}

// The whole of a delete and a restore: the file leaves its folder, it is in the trash, the trash says where it
// came from, and putting it back puts the same bytes in the same place.
func TestADeleteIsAMoveIntoTheTrashAndCanBePutBack(t *testing.T) {
	r, box := withFiles(t)
	want := writeOnTheBox(t, box, "srv/app/notes.txt", 400)

	ask(t, r, map[string]any{"id": 7, "do": "delete", "path": "/srv/app/notes.txt"})
	ps := pages(r.wait("the delete", ended(7)), 7)
	if e := last(ps, "error"); e != nil {
		t.Fatalf("it failed: %v", e)
	}
	moved, _ := last(ps, "trashed").(map[string]any)
	if moved == nil || moved["from"] != "/srv/app/notes.txt" || moved["kind"] != "file" {
		t.Fatalf("what it said was deleted: %v", last(ps, "trashed"))
	}
	if _, err := os.Stat(filepath.Join(box, "srv", "app", "notes.txt")); err == nil {
		t.Fatalf("it is still where it was")
	}
	inBin := filepath.Join(trashOf(t, box, "/"), moved["name"].(string))
	if got, err := os.ReadFile(inBin); err != nil || string(got) != string(want) {
		t.Fatalf("it is not in the trash as it was: %v", err)
	}
	// The record belongs to the box.
	line, err := os.ReadFile(filepath.Join(trashOf(t, box, "/"), "index"))
	if err != nil || !strings.Contains(string(line), "/srv/app/notes.txt") {
		t.Fatalf("the trash does not say where it came from: %v %s", err, line)
	}
	// And what is in the trash is said back.
	ask(t, r, map[string]any{"id": 8, "do": "trash", "path": "/srv/app"})
	ps = pages(r.wait("the trash", ended(8)), 8)
	held, _ := last(ps, "trash").([]any)
	if len(held) != 1 {
		t.Fatalf("the trash holds %v", last(ps, "trash"))
	}

	ask(t, r, map[string]any{"id": 9, "do": "restore", "path": "/srv/app", "name": moved["name"]})
	ps = pages(r.wait("the restore", ended(9)), 9)
	if e := last(ps, "error"); e != nil {
		t.Fatalf("putting it back failed: %v", e)
	}
	if got, err := os.ReadFile(filepath.Join(box, "srv", "app", "notes.txt")); err != nil || string(got) != string(want) {
		t.Fatalf("it did not come back as it was: %v", err)
	}
	if _, err := os.Stat(inBin); err == nil {
		t.Fatalf("it is still in the trash as well")
	}
}

// A folder goes the same way, whole, and comes back whole.
func TestAFolderIsDeletedWholeAndComesBackWhole(t *testing.T) {
	r, box := withFiles(t)
	writeOnTheBox(t, box, "srv/app/inside/one.txt", 10)
	writeOnTheBox(t, box, "srv/app/inside/two.txt", 20)

	ask(t, r, map[string]any{"id": 11, "do": "delete", "path": "/srv/app/inside"})
	ps := pages(r.wait("the delete", ended(11)), 11)
	moved, _ := last(ps, "trashed").(map[string]any)
	if moved == nil || moved["kind"] != "folder" {
		t.Fatalf("a folder was not said to be one: %v", last(ps, "trashed"))
	}
	if _, err := os.Stat(filepath.Join(box, "srv", "app", "inside")); err == nil {
		t.Fatalf("the folder is still there")
	}
	ask(t, r, map[string]any{"id": 12, "do": "restore", "path": "/srv/app", "name": moved["name"]})
	if e := last(pages(r.wait("the restore", ended(12)), 12), "error"); e != nil {
		t.Fatalf("putting it back failed: %v", e)
	}
	for _, name := range []string{"one.txt", "two.txt"} {
		if _, err := os.Stat(filepath.Join(box, "srv", "app", "inside", name)); err != nil {
			t.Fatalf("%s did not come back: %v", name, err)
		}
	}
}

// Every disk has its own trash, because a rename cannot cross a filesystem.
func TestEachDiskHasItsOwnTrash(t *testing.T) {
	r, box := withFiles(t)
	writeOnTheBox(t, box, "mnt/data/dump.sql", 100)

	ask(t, r, map[string]any{"id": 21, "do": "delete", "path": "/mnt/data/dump.sql"})
	ps := pages(r.wait("the delete", ended(21)), 21)
	if e := last(ps, "error"); e != nil {
		t.Fatalf("it failed: %v", e)
	}
	moved, _ := last(ps, "trashed").(map[string]any)
	if _, err := os.Stat(filepath.Join(trashOf(t, box, "mnt/data"), moved["name"].(string))); err != nil {
		t.Fatalf("it did not go to that disk's own trash: %v", err)
	}
	if _, err := os.Stat(filepath.Join(trashOf(t, box, "/"), moved["name"].(string))); err == nil {
		t.Fatalf("it went to the wrong disk's trash")
	}
}

// A disk that takes no writes cannot hold a trash, and that is known before anything is deleted.
func TestADiskThatTakesNoWritesIsSaidBeforeAnythingIsDeleted(t *testing.T) {
	r, box := withFiles(t)
	writeOnTheBox(t, box, "mnt/stone/held.txt", 50)

	ask(t, r, map[string]any{"id": 31, "do": "delete", "path": "/mnt/stone/held.txt"})
	ps := pages(r.wait("the refusal", ended(31)), 31)
	if last(ps, "error") != "no-trash" {
		t.Fatalf("it was not refused for want of a trash: %v", ps)
	}
	if _, err := os.Stat(filepath.Join(box, "mnt", "stone", "held.txt")); err != nil {
		t.Fatalf("it was deleted anyway: %v", err)
	}
}

// The refusal list, through the whole path the box resolves: a link into /etc is still /etc.
func TestWhatTheBrowserRefusesIsJudgedOnWhatTheBoxResolves(t *testing.T) {
	r, box := withFiles(t)
	if err := os.MkdirAll(filepath.Join(box, "etc"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(box, "etc", "passwd"), []byte("root:x:0:0\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(box, "srv", "app"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../../etc/passwd", filepath.Join(box, "srv", "app", "innocent.txt")); err != nil {
		t.Fatal(err)
	}

	// A folder that is a link into a refused place: what is inside it is judged on where it really is, so
	// the folders above a thing are still resolved and the refusal still holds.
	if err := os.Symlink(filepath.Join(box, "etc"), filepath.Join(box, "srv", "theirs")); err != nil {
		t.Fatal(err)
	}
	for i, where := range []string{"/etc/passwd", "/srv/app/../../etc/passwd", "/srv/theirs/passwd"} {
		id := float64(41 + i)
		ask(t, r, map[string]any{"id": id, "do": "delete", "path": where})
		ps := pages(r.wait("the refusal", ended(id)), id)
		if last(ps, "error") != "refused" {
			t.Fatalf("%q was not refused: %v", where, ps)
		}
	}
	// A link that points at a refused place is a link, and his own: deleting it takes the link and leaves
	// what it points at exactly where it is. Judging it by where it pointed would have refused him a stray
	// link in his own folder, and following it would have taken the system file instead.
	ask(t, r, map[string]any{"id": float64(49), "do": "delete", "path": "/srv/app/innocent.txt"})
	ps := pages(r.wait("the delete", ended(49)), 49)
	if e := last(ps, "error"); e != nil {
		t.Fatalf("deleting a link of his own was refused: %v", e)
	}
	if _, err := os.Lstat(filepath.Join(box, "srv", "app", "innocent.txt")); err == nil {
		t.Fatalf("the link is still there")
	}
	if _, err := os.Stat(filepath.Join(box, "etc", "passwd")); err != nil {
		t.Fatalf("the system file went: %v", err)
	}
}

// Emptying takes only what has been in the trash longer than it keeps things, and only inside the trash.
func TestEmptyingTakesOnlyWhatIsOldEnough(t *testing.T) {
	r, box := withFiles(t)
	writeOnTheBox(t, box, "srv/old.txt", 10)
	writeOnTheBox(t, box, "srv/new.txt", 10)
	ask(t, r, map[string]any{"id": 51, "do": "delete", "path": "/srv/old.txt"})
	old, _ := last(pages(r.wait("the delete", ended(51)), 51), "trashed").(map[string]any)
	ask(t, r, map[string]any{"id": 52, "do": "delete", "path": "/srv/new.txt"})
	fresh, _ := last(pages(r.wait("the delete", ended(52)), 52), "trashed").(map[string]any)

	// The older one is made to look like it was deleted long ago, by rewriting its line in the record.
	bin := trashOf(t, box, "/")
	body, err := os.ReadFile(filepath.Join(bin, "index"))
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, one := range strings.Split(strings.TrimSpace(string(body)), "\n") {
		var l map[string]any
		if json.Unmarshal([]byte(one), &l) == nil && l["name"] == old["name"] {
			l["when"] = time.Now().Add(-30 * 24 * time.Hour).Unix()
			b, _ := json.Marshal(l)
			out = append(out, string(b))
			continue
		}
		out = append(out, one)
	}
	if err := os.WriteFile(filepath.Join(bin, "index"), []byte(strings.Join(out, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	ask(t, r, map[string]any{"id": 53, "do": "empty", "path": "/srv"})
	ps := pages(r.wait("the emptying", ended(53)), 53)
	if last(ps, "emptied") != float64(1) {
		t.Fatalf("it emptied %v", last(ps, "emptied"))
	}
	if _, err := os.Stat(filepath.Join(bin, old["name"].(string))); err == nil {
		t.Fatalf("the old one is still in the trash")
	}
	if _, err := os.Stat(filepath.Join(bin, fresh["name"].(string))); err != nil {
		t.Fatalf("the new one was emptied too: %v", err)
	}
}

// Putting something back where something else now is does not write over it.
func TestPuttingBackOverSomethingElseIsRefused(t *testing.T) {
	r, box := withFiles(t)
	writeOnTheBox(t, box, "srv/notes.txt", 30)
	ask(t, r, map[string]any{"id": 61, "do": "delete", "path": "/srv/notes.txt"})
	moved, _ := last(pages(r.wait("the delete", ended(61)), 61), "trashed").(map[string]any)
	writeOnTheBox(t, box, "srv/notes.txt", 70) // something else of the same name is there now

	ask(t, r, map[string]any{"id": 62, "do": "restore", "path": "/srv", "name": moved["name"]})
	ps := pages(r.wait("the refusal", ended(62)), 62)
	if last(ps, "error") != "already-there" {
		t.Fatalf("it was not refused: %v", ps)
	}
	if at, err := os.Stat(filepath.Join(box, "srv", "notes.txt")); err != nil || at.Size() != 70 {
		t.Fatalf("what was there was changed: %v", err)
	}
}

// Emptying never follows a name out of the trash, however the record got there: a line naming something
// outside the trash takes nothing with it.
func TestEmptyingNeverReachesOutsideTheTrash(t *testing.T) {
	r, box := withFiles(t)
	writeOnTheBox(t, box, "srv/keep.txt", 40)
	writeOnTheBox(t, box, "srv/bait.txt", 40)
	// A trash with a record that points back out of it, as a box that has been got at would have.
	bin := trashOf(t, box, "/")
	if err := os.MkdirAll(bin, 0o700); err != nil {
		t.Fatal(err)
	}
	line := `{"name":"../srv/bait.txt","from":"/srv/bait.txt","when":1,"size":40,"kind":"file"}` + "\n"
	if err := os.WriteFile(filepath.Join(bin, "index"), []byte(line), 0o600); err != nil {
		t.Fatal(err)
	}

	ask(t, r, map[string]any{"id": 71, "do": "empty", "path": "/srv"})
	ps := pages(r.wait("the emptying", ended(71)), 71)
	if e := last(ps, "error"); e != nil && e != "refused" {
		t.Fatalf("it failed in some other way: %v", e)
	}
	if _, err := os.Stat(filepath.Join(box, "srv", "bait.txt")); err != nil {
		t.Fatalf("emptying the trash took a file outside it: %v", err)
	}
	if _, err := os.Stat(filepath.Join(box, "srv", "keep.txt")); err != nil {
		t.Fatalf("it took something else as well: %v", err)
	}
}

// Deleting a link takes the link, never what it points at. Before this, the path was resolved whole before
// anything was moved, so standing on /var/www/current and pressing Delete moved the release it pointed to
// into the trash and left the link dangling: one press, and the thing he meant to keep was the thing that
// went. A person deleting a link means the link.
func TestDeletingALinkTakesTheLinkAndNotWhatItPointsAt(t *testing.T) {
	r, box := withFiles(t)
	want := writeOnTheBox(t, box, "srv/releases/42/app.conf", 300)
	if err := os.MkdirAll(filepath.Join(box, "srv", "www"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(box, "srv", "releases", "42", "app.conf"), filepath.Join(box, "srv", "www", "current")); err != nil {
		t.Fatal(err)
	}

	ask(t, r, map[string]any{"id": 9, "do": "delete", "path": "/srv/www/current"})
	ps := pages(r.wait("the delete", ended(9)), 9)
	if e := last(ps, "error"); e != nil {
		t.Fatalf("it failed: %v", e)
	}
	moved, _ := last(ps, "trashed").(map[string]any)
	if moved == nil || moved["from"] != "/srv/www/current" {
		t.Fatalf("what it said was deleted: %v", last(ps, "trashed"))
	}
	// What it pointed at is untouched, bytes and all.
	if got, err := os.ReadFile(filepath.Join(box, "srv", "releases", "42", "app.conf")); err != nil || string(got) != string(want) {
		t.Fatalf("what the link pointed at was taken away: %v", err)
	}
	// And the link itself is gone from where it stood.
	if _, err := os.Lstat(filepath.Join(box, "srv", "www", "current")); err == nil {
		t.Fatalf("the link is still there, so something else went instead")
	}
}
