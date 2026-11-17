package main

// Naming things on a box: a new name for one that is there, and one new folder. Both work on a name alone,
// never a path, and neither may ever write over something that is already there.

import (
	"os"
	"path/filepath"
	"testing"
)

// A new name, in the folder it was already in, and the same bytes under it.
func TestANewNameMovesNothingButTheName(t *testing.T) {
	r, box := withFiles(t)
	want := writeOnTheBox(t, box, "srv/app/notes.txt", 400)

	ask(t, r, map[string]any{"id": 3, "do": "rename", "path": "/srv/app/notes.txt", "name": "kept notes.txt"})
	ps := pages(r.wait("the rename", ended(3)), 3)
	if e := last(ps, "error"); e != nil {
		t.Fatalf("it failed: %v", e)
	}
	at, _ := last(ps, "attrs").(map[string]any)
	if at == nil || at["name"] != "/srv/app/kept notes.txt" || at["kind"] != "file" {
		t.Fatalf("what it said it made: %v", last(ps, "attrs"))
	}
	if got, err := os.ReadFile(filepath.Join(box, "srv", "app", "kept notes.txt")); err != nil || string(got) != string(want) {
		t.Fatalf("the bytes under the new name: %v", err)
	}
	if _, err := os.Stat(filepath.Join(box, "srv", "app", "notes.txt")); err == nil {
		t.Fatalf("the old name is still there as well")
	}
}

// A name already taken is refused, and the thing that was there is untouched. This is the one that matters: a
// rename that replaces is a rename that loses a file.
func TestANameAlreadyTakenIsRefusedAndNothingIsLost(t *testing.T) {
	r, box := withFiles(t)
	writeOnTheBox(t, box, "srv/app/notes.txt", 400)
	held := writeOnTheBox(t, box, "srv/app/other.txt", 120)

	ask(t, r, map[string]any{"id": 4, "do": "rename", "path": "/srv/app/notes.txt", "name": "other.txt"})
	ps := pages(r.wait("the rename", ended(4)), 4)
	if e := last(ps, "error"); e != "already-there" {
		t.Fatalf("it said %v, not that the name is taken", e)
	}
	if got, err := os.ReadFile(filepath.Join(box, "srv", "app", "other.txt")); err != nil || string(got) != string(held) {
		t.Fatalf("what was already at that name changed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(box, "srv", "app", "notes.txt")); err != nil {
		t.Fatalf("the file being renamed is gone: %v", err)
	}
}

// A name that is really a path is refused, whichever way it is written, so nothing can be moved out of its
// folder through a rename.
func TestANameThatIsAPathIsRefused(t *testing.T) {
	r, box := withFiles(t)
	writeOnTheBox(t, box, "srv/app/notes.txt", 10)
	for i, name := range []any{"../notes.txt", "sub/notes.txt", "/etc/passwd", "..", ".", "", "a\nb"} {
		id := float64(20 + i)
		ask(t, r, map[string]any{"id": id, "do": "rename", "path": "/srv/app/notes.txt", "name": name})
		ps := pages(r.wait("the rename", ended(id)), id)
		if e := last(ps, "error"); e != "not-a-name" {
			t.Fatalf("%q was answered with %v, not refused as a name", name, e)
		}
	}
	if _, err := os.Stat(filepath.Join(box, "srv", "app", "notes.txt")); err != nil {
		t.Fatalf("the file moved anyway: %v", err)
	}
}

// A folder named with a slash on the end is renamed, and not given a folder inside itself.
func TestAFolderKeepsItsPlaceWhenRenamed(t *testing.T) {
	r, box := withFiles(t)
	writeOnTheBox(t, box, "srv/app/inside/one.txt", 30)

	ask(t, r, map[string]any{"id": 5, "do": "rename", "path": "/srv/app/inside/", "name": "renamed"})
	ps := pages(r.wait("the rename", ended(5)), 5)
	if e := last(ps, "error"); e != nil {
		t.Fatalf("it failed: %v", e)
	}
	if _, err := os.Stat(filepath.Join(box, "srv", "app", "renamed", "one.txt")); err != nil {
		t.Fatalf("the folder is not where it should be: %v", err)
	}
	if _, err := os.Stat(filepath.Join(box, "srv", "app", "inside", "renamed")); err == nil {
		t.Fatalf("it made a folder inside the one being renamed")
	}
}

// One new folder, inside the folder named, with the box's own permissions.
func TestANewFolderIsMadeWhereItWasAsked(t *testing.T) {
	r, box := withFiles(t)
	writeOnTheBox(t, box, "srv/app/one.txt", 10)

	ask(t, r, map[string]any{"id": 6, "do": "folder", "path": "/srv/app", "name": "new things"})
	ps := pages(r.wait("the folder", ended(6)), 6)
	if e := last(ps, "error"); e != nil {
		t.Fatalf("it failed: %v", e)
	}
	at, _ := last(ps, "attrs").(map[string]any)
	if at == nil || at["name"] != "/srv/app/new things" || at["kind"] != "folder" {
		t.Fatalf("what it said it made: %v", last(ps, "attrs"))
	}
	st, err := os.Stat(filepath.Join(box, "srv", "app", "new things"))
	if err != nil || !st.IsDir() {
		t.Fatalf("the folder is not there: %v", err)
	}

	// The same name again is refused, and the folder that is there keeps what is in it.
	writeOnTheBox(t, box, "srv/app/new things/kept.txt", 20)
	ask(t, r, map[string]any{"id": 7, "do": "folder", "path": "/srv/app", "name": "new things"})
	ps = pages(r.wait("the folder", ended(7)), 7)
	if e := last(ps, "error"); e != "already-there" {
		t.Fatalf("it said %v, not that the name is taken", e)
	}
	if _, err := os.Stat(filepath.Join(box, "srv", "app", "new things", "kept.txt")); err != nil {
		t.Fatalf("what was in the folder is gone: %v", err)
	}
}

// A new folder's name goes through the same refusals, so a folder cannot be made outside the folder named.
func TestANewFolderCannotBeNamedAsAPath(t *testing.T) {
	r, _ := withFiles(t)
	for i, name := range []any{"../out", "a/b", "/tmp/out", "..", ""} {
		id := float64(40 + i)
		ask(t, r, map[string]any{"id": id, "do": "folder", "path": "/srv/app", "name": name})
		ps := pages(r.wait("the folder", ended(id)), id)
		if e := last(ps, "error"); e != "not-a-name" {
			t.Fatalf("%q was answered with %v, not refused as a name", name, e)
		}
	}
}
