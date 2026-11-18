package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"sshapp/engine/internal/lab/hostile"
)

// The second of the two ways a delete keeps its promise, and the one nothing held until now.
//
// The name a delete picks inside the trash carries its own engine's letters, so no other tab picks the same
// one. But a name is a guess about the box, and only the box knows what is really in there: a trash carried
// over from an older build, a file put there by hand, the same engine started twice from a copied folder.
// If something is already under that name the move must refuse, because what it would write over is another
// file he asked to keep. A delete is the one thing in this app that promises the file is still there.
func TestADeleteRefusesToWriteOverWhatIsAlreadyInTheTrash(t *testing.T) {
	box := t.TempDir()
	r := newRig(t, rigOpt{folder: "/", box: func(c *hostile.Config) { c.FilesUnder = box }})
	r.wait("the link to be up", isUp)
	for i := 0; ; i++ {
		id := float64(800 + i)
		ask(t, r, map[string]any{"id": id, "do": "space", "path": "/"})
		if last(pages(r.wait("an answer", ended(id)), id), "error") != "no-link" {
			break
		}
		if i == 200 {
			t.Fatal("the tab's files never came up")
		}
		time.Sleep(20 * time.Millisecond)
	}
	del := func(id float64, at string) (name string, failed string) {
		ask(t, r, map[string]any{"id": id, "do": "delete", "path": at})
		ps := pages(r.wait("the delete", ended(id)), id)
		if e := last(ps, "error"); e != nil {
			return "", fmt.Sprint(e, " (", last(ps, "detail"), ")")
		}
		moved, _ := last(ps, "trashed").(map[string]any)
		if moved == nil {
			t.Fatalf("%s said nothing was deleted: %v", at, ps)
		}
		return moved["name"].(string), ""
	}

	writeOnTheBox(t, box, "a/notes.txt", 300)
	want := writeOnTheBox(t, box, "b/notes.txt", 500)
	bin := filepath.Join(box, ".berth-trash")

	// The engine's letters are its own and are made where it runs, so they are read off a delete rather than
	// guessed: one real delete first, whose name is "<second>-<count><letters>-<name>" with the count at one.
	first, failed := del(31, "/a/notes.txt")
	if failed != "" {
		t.Fatalf("the first delete failed: %s", failed)
	}
	parts := strings.SplitN(first, "-", 3)
	if len(parts) != 3 || !strings.HasPrefix(parts[1], "1") {
		t.Fatalf("a delete's name is not the shape this probe reads: %q", first)
	}
	letters := parts[1][1:]

	// Every name the next delete could pick: the count is two now, and only the second it lands in is
	// unknown, which is a window rather than a guess.
	const his = "a file of his that was already in the trash"
	taken := map[string]bool{}
	for s := int64(-1); s <= 5; s++ {
		name := fmt.Sprintf("%d-2%s-notes.txt", time.Now().Unix()+s, letters)
		if err := os.WriteFile(filepath.Join(bin, name), []byte(his), 0o644); err != nil {
			t.Fatal(err)
		}
		taken[name] = true
	}

	second, failed := del(32, "/b/notes.txt")

	// Nothing that was already in there may have been written over, whatever else happened.
	for name := range taken {
		b, err := os.ReadFile(filepath.Join(bin, name))
		if err != nil || string(b) != his {
			t.Fatalf("the delete wrote over %s, a file that was already in the trash (%v)", name, err)
		}
	}
	if failed == "" {
		t.Fatalf("the delete took a name it could not have: %q (the clock moved past the window, so this proved nothing)", second)
	}
	// Refusing is not the same as losing it: the file is left exactly where he had it.
	got, err := os.ReadFile(filepath.Join(box, "b", "notes.txt"))
	if err != nil || string(got) != string(want) {
		t.Fatalf("the delete refused and took the file with it anyway (%v)", err)
	}
}
