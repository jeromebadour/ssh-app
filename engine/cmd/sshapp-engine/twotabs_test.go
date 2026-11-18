package main

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"sshapp/engine/internal/lab/hostile"
)

// Two tabs on one box, deleting a file of the same name from two different folders in the same second. Each
// tab is its own engine with its own count, so the name a delete is given inside the trash
// ("<when>-<count>-<name>") is the same from both, and a rename that replaces what is there would lose one
// of his files with its record. A delete is the one thing in this app that promises the file is still there.
func TestTwoTabsDeletingOneNameAtOnceKeepBoth(t *testing.T) {
	box := t.TempDir()
	start := func() *rig {
		r := newRig(t, rigOpt{folder: "/var/log", box: func(c *hostile.Config) { c.FilesUnder = box }})
		r.wait("the link to be up", isUp)
		for i := 0; i < 200; i++ {
			id := float64(900 + i)
			ask(t, r, map[string]any{"id": id, "do": "space", "path": "/"})
			if last(pages(r.wait("an answer", ended(id)), id), "error") != "no-link" {
				return r
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatal("the tab's files never came up")
		return nil
	}
	oneTab, twoTab := start(), start()
	first := writeOnTheBox(t, box, "a/notes.txt", 300)
	second := writeOnTheBox(t, box, "b/notes.txt", 500)

	del := func(r *rig, id float64, at string) (map[string]any, string) {
		ask(t, r, map[string]any{"id": id, "do": "delete", "path": at})
		ps := pages(r.wait("the delete", ended(id)), id)
		if e := last(ps, "error"); e != nil {
			return nil, fmt.Sprint(e, " (", last(ps, "detail"), ")")
		}
		moved, _ := last(ps, "trashed").(map[string]any)
		if moved == nil {
			t.Fatalf("%s said nothing was deleted: %v", at, ps)
		}
		return moved, ""
	}
	// As close together as the two can be: the name carries the second it happened in, so this is the case.
	a, aFailed := del(oneTab, 11, "/a/notes.txt")
	b, bFailed := del(twoTab, 12, "/b/notes.txt")

	bin := filepath.Join(box, ".berth-trash")
	// What a second delete must never do: lose the first one's file. Before the names were made to differ,
	// both were called the same inside the trash, the second's bytes replaced the first's there, and then its
	// own record could not be written, so it was put back where it came from and took the first file with it.
	if _, err := os.Stat(filepath.Join(box, "a", "notes.txt")); err != nil {
		if _, inBin := os.Stat(filepath.Join(bin, fmt.Sprint(a["name"]))); inBin != nil {
			t.Fatalf("the first file is neither where it was nor in the trash: the second delete took it (first said %q, second said %q)", a["name"], b["name"])
		}
	}
	if aFailed != "" || bFailed != "" {
		t.Fatalf("a delete failed: first %q, second %q", aFailed, bFailed)
	}
	if a["name"] == b["name"] {
		t.Fatalf("both deletes were given the same name inside the trash: %q", a["name"])
	}
	got1, err1 := os.ReadFile(filepath.Join(bin, a["name"].(string)))
	got2, err2 := os.ReadFile(filepath.Join(bin, b["name"].(string)))
	if err1 != nil || err2 != nil {
		t.Fatalf("one of them is not in the trash: %v / %v", err1, err2)
	}
	if string(got1) != string(first) || string(got2) != string(second) {
		t.Fatal("what is in the trash is not what was deleted")
	}
	for _, name := range []string{a["name"].(string), b["name"].(string)} {
		if _, err := os.Stat(filepath.Join(bin, "records", name+".json")); err != nil {
			t.Fatalf("no record for %q: %v", name, err)
		}
	}
}
