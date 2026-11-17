package main

// Bringing a file from a box onto the PC. Each test is one rule of get.go, and together they say what a
// download may and may not do: where it may write, what it leaves behind, and what it is allowed to call
// proved.

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"sshapp/engine/internal/frame"
	"sshapp/engine/internal/lab/hostile"
)

// a box with real files under a folder of the test's own, and a tab's engine signed in to it.
func withFiles(t *testing.T) (*rig, string) {
	t.Helper()
	box := t.TempDir()
	r := newRig(t, rigOpt{box: func(c *hostile.Config) { c.FilesUnder = box }})
	r.wait("the link to be up", isUp)
	// The tab's files ride the same link but are only there once the shell session is open, a moment after the
	// link says it is up. Asked before that, the engine answers "no-link", which is true and is not what any of
	// these tests are about: they wait for the files to be there by asking for something small.
	for i := 0; i < 200; i++ {
		id := float64(900 + i)
		ask(t, r, map[string]any{"id": id, "do": "space", "path": "/"})
		ps := pages(r.wait("an answer", ended(id)), id)
		if last(ps, "error") != "no-link" {
			return r, box
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("the tab's files never came up")
	return nil, ""
}

func writeOnTheBox(t *testing.T, box, name string, size int) []byte {
	t.Helper()
	b := make([]byte, size)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(filepath.Join(box, name)), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(box, name), b, 0o644); err != nil {
		t.Fatal(err)
	}
	return b
}

func ask(t *testing.T, r *rig, a map[string]any) {
	t.Helper()
	body, err := json.Marshal(a)
	if err != nil {
		t.Fatal(err)
	}
	r.p.send(t, frame.TypeFileAsk, body)
}

// pages returns every page of one ask so far, oldest first.
func pages(fs []frame.Frame, id float64) []map[string]any {
	var out []map[string]any
	for _, f := range fs {
		if f.Type != frame.TypeFilePage {
			continue
		}
		var p map[string]any
		if json.Unmarshal(f.Body, &p) == nil && p["id"] == id {
			out = append(out, p)
		}
	}
	return out
}

func ended(id float64) func([]frame.Frame) bool {
	return func(fs []frame.Frame) bool {
		ps := pages(fs, id)
		return len(ps) > 0 && ps[len(ps)-1]["done"] == true
	}
}

func last(ps []map[string]any, key string) any {
	for i := len(ps) - 1; i >= 0; i-- {
		if v, there := ps[i][key]; there {
			return v
		}
	}
	return nil
}

// The whole of a download: the bytes arrive, the box's own hash agrees with them, the file is in place under
// the name it was given, and nothing of the app's is left in the folder.
func TestAFileComesOverWholeAndIsCheckedAgainstTheBoxsOwnHash(t *testing.T) {
	r, box := withFiles(t)
	want := writeOnTheBox(t, box, "notes.txt", 600_000)
	onto := t.TempDir()
	// The box answers each piece slowly, so the download has a middle: without one it is over before there is
	// anything to say about how far it has got, and this would prove nothing.
	hostile.Pace(30)
	t.Cleanup(func() { hostile.Pace(0) })

	ask(t, r, map[string]any{"id": 7, "do": "get", "path": "/notes.txt", "into": onto, "name": "notes.txt"})
	ps := pages(r.wait("the download to end", ended(7)), 7)
	if e := last(ps, "error"); e != nil {
		t.Fatalf("it failed: %v", e)
	}
	if last(ps, "landed") != "notes.txt" || last(ps, "mark") != "checked" {
		t.Fatalf("landed: %v %v", last(ps, "landed"), last(ps, "mark"))
	}
	got, err := os.ReadFile(filepath.Join(onto, "notes.txt"))
	if err != nil || string(got) != string(want) {
		t.Fatalf("what arrived is not what the box has (%v, %d bytes of %d)", err, len(got), len(want))
	}
	// Said as it went, not only at the end, so a window can show a speed that moves and a time that falls.
	moving := 0
	for _, p := range ps {
		if g, ok := p["got"].(float64); ok && g > 0 && g < float64(len(want)) {
			moving++
		}
	}
	if moving == 0 {
		t.Fatalf("it never said how far it had got while it was going: %v", ps)
	}
	left, _ := os.ReadDir(onto)
	if len(left) != 1 {
		t.Fatalf("something of the app's was left behind: %v", names(left))
	}
}

func names(es []os.DirEntry) []string {
	var out []string
	for _, e := range es {
		out = append(out, e.Name())
	}
	return out
}

// A name that is not a name. Main works the landing name out, and this is the second pair of eyes: nothing a
// view ever said may become a path on the PC (plan B2.7).
func TestANameThatCouldBeAPathIsRefusedAndNothingIsWritten(t *testing.T) {
	r, box := withFiles(t)
	writeOnTheBox(t, box, "notes.txt", 10)
	onto := t.TempDir()
	keep := filepath.Join(filepath.Dir(onto), "outside.txt")
	_ = os.Remove(keep)

	for i, name := range []string{"../outside.txt", "a/b.txt", `a\b.txt`, "", ".", "..", strings.Repeat("x", 256)} {
		id := float64(100 + i)
		ask(t, r, map[string]any{"id": id, "do": "get", "path": "/notes.txt", "into": onto, "name": name})
		ps := pages(r.wait("the refusal", ended(id)), id)
		if last(ps, "error") != "not-a-name" {
			t.Fatalf("%q was not refused as a name: %v", name, ps)
		}
	}
	if _, err := os.Stat(keep); err == nil {
		t.Fatalf("a file landed outside the folder it was given")
	}
	if left, _ := os.ReadDir(onto); len(left) != 0 {
		t.Fatalf("something was written for a refused name: %v", names(left))
	}
}

// A folder that is not named from its root. The ask carries a whole folder or it carries nothing.
func TestAFolderThatIsNotAWholePathIsRefused(t *testing.T) {
	r, box := withFiles(t)
	writeOnTheBox(t, box, "notes.txt", 10)
	ask(t, r, map[string]any{"id": 11, "do": "get", "path": "/notes.txt", "into": "somewhere", "name": "notes.txt"})
	ps := pages(r.wait("the refusal", ended(11)), 11)
	if last(ps, "error") != "not-a-name" {
		t.Fatalf("a folder that is not a whole path was taken: %v", ps)
	}
}

// A file already there is not written over unless the ask says so, and the one that is there is untouched.
func TestAFileAlreadyThereIsNotWrittenOverUnlessItIsAskedFor(t *testing.T) {
	r, box := withFiles(t)
	want := writeOnTheBox(t, box, "notes.txt", 5_000)
	onto := t.TempDir()
	there := filepath.Join(onto, "notes.txt")
	if err := os.WriteFile(there, []byte("the one that was here first"), 0o644); err != nil {
		t.Fatal(err)
	}

	ask(t, r, map[string]any{"id": 21, "do": "get", "path": "/notes.txt", "into": onto, "name": "notes.txt"})
	ps := pages(r.wait("the refusal", ended(21)), 21)
	if last(ps, "error") != "already-there" {
		t.Fatalf("it was not refused: %v", ps)
	}
	if b, _ := os.ReadFile(there); string(b) != "the one that was here first" {
		t.Fatalf("the file that was there was changed")
	}

	ask(t, r, map[string]any{"id": 22, "do": "get", "path": "/notes.txt", "into": onto, "name": "notes.txt", "replace": true})
	ps = pages(r.wait("the download to end", ended(22)), 22)
	if e := last(ps, "error"); e != nil {
		t.Fatalf("asked to replace, it failed: %v", e)
	}
	if b, _ := os.ReadFile(there); string(b) != string(want) {
		t.Fatalf("asked to replace, what is there is not the box's file")
	}
}

// A box whose hash does not agree with what arrived, with the file unchanged on the box: nothing is delivered
// and nothing is left behind. This is the one case where a download is thrown away.
func TestAFileTheBoxDoesNotAgreeWithIsNeverDelivered(t *testing.T) {
	r, box := withFiles(t)
	writeOnTheBox(t, box, "notes.txt", 4_000)
	onto := t.TempDir()
	// The box is made to answer every command with a hash of the right shape that is not this file's.
	r.box.AnswerCommandsWith(strings.Repeat("0", 64) + "  /notes.txt\n")

	ask(t, r, map[string]any{"id": 31, "do": "get", "path": "/notes.txt", "into": onto, "name": "notes.txt"})
	ps := pages(r.wait("the refusal", ended(31)), 31)
	if last(ps, "error") != "not-the-same" {
		t.Fatalf("a file the box disagrees with was delivered: %v", ps)
	}
	if left, _ := os.ReadDir(onto); len(left) != 0 {
		t.Fatalf("it left something behind: %v", names(left))
	}
}

// A box that answers nothing of the right shape cannot prove the file, and the file is still delivered: it is
// marked as not checked, which is true, rather than thrown away or called checked.
func TestAFileABoxCannotHashIsDeliveredAndSaidToBeUnchecked(t *testing.T) {
	r, box := withFiles(t)
	want := writeOnTheBox(t, box, "notes.txt", 2_000)
	onto := t.TempDir()
	r.box.AnswerCommandsWith("this box prints no hash at all\n")

	ask(t, r, map[string]any{"id": 41, "do": "get", "path": "/notes.txt", "into": onto, "name": "notes.txt"})
	ps := pages(r.wait("the download to end", ended(41)), 41)
	if e := last(ps, "error"); e != nil {
		t.Fatalf("it failed: %v", e)
	}
	if last(ps, "mark") != "not-checked" {
		t.Fatalf("it was not marked as unchecked: %v", ps)
	}
	if b, _ := os.ReadFile(filepath.Join(onto, "notes.txt")); string(b) != string(want) {
		t.Fatalf("what arrived is not what the box has")
	}
}

// The hash that is compared is the hash of the bytes that were written, worked out as they were written.
func TestTheHashComparedIsOfTheBytesThatWereWritten(t *testing.T) {
	r, box := withFiles(t)
	want := writeOnTheBox(t, box, "notes.txt", 70_000)
	onto := t.TempDir()
	sum := sha256.Sum256(want)
	r.box.AnswerCommandsWith(hex.EncodeToString(sum[:]) + "  /notes.txt\n")

	ask(t, r, map[string]any{"id": 51, "do": "get", "path": "/notes.txt", "into": onto, "name": "notes.txt"})
	ps := pages(r.wait("the download to end", ended(51)), 51)
	if last(ps, "mark") != "checked" || last(ps, "error") != nil {
		t.Fatalf("the hash of what was written was not what was compared: %v", ps)
	}
}

// Giving up on a download: it stops, and it takes its own half-written file with it.
func TestADownloadGivenUpOnLeavesNothingBehind(t *testing.T) {
	r, box := withFiles(t)
	writeOnTheBox(t, box, "big.bin", 8<<20)
	onto := t.TempDir()
	hostile.Pace(40) // each piece of the file is answered slowly, so there is a middle to stop in
	t.Cleanup(func() { hostile.Pace(0) })

	ask(t, r, map[string]any{"id": 61, "do": "get", "path": "/big.bin", "into": onto, "name": "big.bin"})
	r.wait("it to be under way", func(fs []frame.Frame) bool {
		for _, p := range pages(fs, 61) {
			if g, ok := p["got"].(float64); ok && g > 0 {
				return true
			}
		}
		return false
	})
	// While it is still arriving, there is no file under the name it will have: what is in the folder is one
	// hidden thing of the app's own, so nothing else can open a half-written file or mistake it for whole.
	left, _ := os.ReadDir(onto)
	if len(left) != 1 || !strings.HasPrefix(left[0].Name(), ".berth-") || !strings.HasSuffix(left[0].Name(), ".part") {
		t.Fatalf("while it was arriving the folder held: %v", names(left))
	}
	if _, err := os.Stat(filepath.Join(onto, "big.bin")); err == nil {
		t.Fatalf("a file that is still arriving was visible under the name it will have")
	}
	ask(t, r, map[string]any{"id": 61, "do": "cancel", "path": ""})
	ps := pages(r.wait("it to stop", ended(61)), 61)
	if last(ps, "landed") != nil {
		t.Fatalf("a download that was given up on still delivered: %v", ps)
	}
	// The file is removed as the download unwinds, which is a moment after the end is said.
	for i := 0; i < 100; i++ {
		if left, _ := os.ReadDir(onto); len(left) == 0 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	stayed, _ := os.ReadDir(onto)
	t.Fatalf("it left its half-written file behind: %v", names(stayed))
}

// A file that changes on the box while it is being read. The two hashes cannot agree, and that is the file
// moving, not the link lying: it is delivered and marked as changed, never silently called checked and never
// thrown away (plan B4.3, review 38).
func TestAFileThatChangedOnTheBoxWhileItWasReadIsDeliveredAndSaidToHaveChanged(t *testing.T) {
	r, box := withFiles(t)
	writeOnTheBox(t, box, "moving.bin", 2<<20)
	onto := t.TempDir()
	hostile.Pace(30)
	t.Cleanup(func() { hostile.Pace(0) })

	ask(t, r, map[string]any{"id": 71, "do": "get", "path": "/moving.bin", "into": onto, "name": "moving.bin"})
	r.wait("it to be under way", func(fs []frame.Frame) bool {
		for _, p := range pages(fs, 71) {
			if g, ok := p["got"].(float64); ok && g > 0 {
				return true
			}
		}
		return false
	})
	// The box's file is written again, a different size: what the box will hash is no longer what was read.
	writeOnTheBox(t, box, "moving.bin", (2<<20)+4096)

	ps := pages(r.wait("the download to end", ended(71)), 71)
	if e := last(ps, "error"); e != nil {
		t.Fatalf("a file that changed on the box was thrown away: %v", e)
	}
	if last(ps, "mark") != "changed" {
		t.Fatalf("it was not said to have changed: %v", ps)
	}
	if _, err := os.Stat(filepath.Join(onto, "moving.bin")); err != nil {
		t.Fatalf("it was not delivered: %v", err)
	}
}
