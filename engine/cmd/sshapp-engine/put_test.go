package main

// Sending a file to a box. Each test is one rule of put.go: what is written where, what is never written
// through, what the box is left holding when it goes wrong, and what may be called proved.

import (
	"crypto/rand"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"sshapp/engine/internal/frame"
	"sshapp/engine/internal/lab/hostile"
)

func writeOnThePC(t *testing.T, size int) (string, []byte) {
	t.Helper()
	b := make([]byte, size)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(t.TempDir(), "from-the-pc.bin")
	if err := os.WriteFile(p, b, 0o644); err != nil {
		t.Fatal(err)
	}
	return p, b
}

// The whole of an upload: the bytes arrive, the box's own hash agrees with them, the file is in place under
// the name it was given, and nothing of the app's is left in the folder on the box.
func TestAFileGoesToTheBoxWholeAndIsCheckedAgainstTheBoxsOwnHash(t *testing.T) {
	r, box := withFiles(t)
	if err := os.MkdirAll(filepath.Join(box, "var", "log"), 0o755); err != nil {
		t.Fatal(err)
	}
	from, want := writeOnThePC(t, 400_000)

	ask(t, r, map[string]any{"id": 7, "do": "put", "path": "/var/log", "name": "sent.bin", "from": from})
	ps := pages(r.wait("the upload to end", ended(7)), 7)
	if e := last(ps, "error"); e != nil {
		t.Fatalf("it failed: %v (%v)", e, last(ps, "detail"))
	}
	if last(ps, "landed") != "sent.bin" || last(ps, "mark") != "checked" {
		t.Fatalf("landed: %v %v %v", last(ps, "landed"), last(ps, "mark"), last(ps, "markWhy"))
	}
	got, err := os.ReadFile(filepath.Join(box, "var", "log", "sent.bin"))
	if err != nil || string(got) != string(want) {
		t.Fatalf("what the box holds is not what was sent (%v, %d of %d)", err, len(got), len(want))
	}
	left, _ := os.ReadDir(filepath.Join(box, "var", "log"))
	if len(left) != 1 {
		t.Fatalf("something of the app's was left on the box: %v", names(left))
	}
}

// A name that is not a name on the box: it would be a path, and a path is not the view's to choose.
func TestANameThatCouldBeAPathOnTheBoxIsRefused(t *testing.T) {
	r, box := withFiles(t)
	if err := os.MkdirAll(filepath.Join(box, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	from, _ := writeOnThePC(t, 10)
	for i, name := range []string{"../escaped.bin", "sub/inside.bin", "", ".", "..", "with\nnewline", strings.Repeat("x", 256)} {
		id := float64(100 + i)
		ask(t, r, map[string]any{"id": id, "do": "put", "path": "/", "name": name, "from": from})
		ps := pages(r.wait("the refusal", ended(id)), id)
		if last(ps, "error") != "not-a-name" {
			t.Fatalf("%q was not refused as a name: %v", name, ps)
		}
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(box), "escaped.bin")); err == nil {
		t.Fatalf("a file landed outside the box's own files")
	}
	if left, _ := os.ReadDir(filepath.Join(box, "sub")); len(left) != 0 {
		t.Fatalf("something was written for a refused name: %v", names(left))
	}
}

// A place on the box that is not a folder.
func TestAPlaceOnTheBoxThatIsNotAFolderIsRefused(t *testing.T) {
	r, box := withFiles(t)
	writeOnTheBox(t, box, "notes.txt", 10)
	from, _ := writeOnThePC(t, 10)
	ask(t, r, map[string]any{"id": 11, "do": "put", "path": "/notes.txt", "name": "sent.bin", "from": from})
	ps := pages(r.wait("the refusal", ended(11)), 11)
	if last(ps, "error") != "not-a-folder" {
		t.Fatalf("a file was sent into something that is not a folder: %v", ps)
	}
}

// A file already there is not replaced unless the ask says so, and what is there is untouched.
func TestAFileAlreadyOnTheBoxIsNotReplacedUnlessItIsAskedFor(t *testing.T) {
	r, box := withFiles(t)
	if err := os.WriteFile(filepath.Join(box, "there.bin"), []byte("the one that was here first"), 0o644); err != nil {
		t.Fatal(err)
	}
	from, want := writeOnThePC(t, 3_000)

	ask(t, r, map[string]any{"id": 21, "do": "put", "path": "/", "name": "there.bin", "from": from})
	ps := pages(r.wait("the refusal", ended(21)), 21)
	if last(ps, "error") != "already-there" {
		t.Fatalf("it was not refused: %v", ps)
	}
	if b, _ := os.ReadFile(filepath.Join(box, "there.bin")); string(b) != "the one that was here first" {
		t.Fatalf("the file on the box was changed")
	}

	ask(t, r, map[string]any{"id": 22, "do": "put", "path": "/", "name": "there.bin", "from": from, "replace": true})
	ps = pages(r.wait("the upload to end", ended(22)), 22)
	if e := last(ps, "error"); e != nil {
		t.Fatalf("asked to replace, it failed: %v", e)
	}
	if last(ps, "replaced") != true {
		t.Fatalf("it did not say it went in over a file: %v", ps)
	}
	if b, _ := os.ReadFile(filepath.Join(box, "there.bin")); string(b) != string(want) {
		t.Fatalf("asked to replace, what the box holds is not what was sent")
	}
}

// The permissions of the file being replaced are what the new one wears: a program on the box that was
// executable stays executable, and a file that was private stays private.
func TestWhatIsReplacedKeepsItsOwnPermissions(t *testing.T) {
	// The one test of these that a Windows filesystem cannot hold: it has no executable bit and no owner-only
	// bit to keep, so the lab box there can only ever answer -rw-rw-rw-. A real box is Linux, and what this
	// claims is proven on Linux here and against real OpenSSH 8.9 and 10.5 in CI, where the file written in
	// place is checked for the mode it had before (engine/internal/link/openssh_test.go).
	if runtime.GOOS == "windows" {
		t.Skip("a Windows filesystem has no permissions of this kind to keep: proven on Linux and against real OpenSSH")
	}
	r, box := withFiles(t)
	script := filepath.Join(box, "run.sh")
	if err := os.WriteFile(script, []byte("#!/bin/sh\necho old\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	private := filepath.Join(box, "secret.conf")
	if err := os.WriteFile(private, []byte("old\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	from, _ := writeOnThePC(t, 1_000)

	ask(t, r, map[string]any{"id": 31, "do": "put", "path": "/", "name": "run.sh", "from": from, "replace": true})
	if e := last(pages(r.wait("the upload to end", ended(31)), 31), "error"); e != nil {
		t.Fatalf("it failed: %v", e)
	}
	ask(t, r, map[string]any{"id": 32, "do": "put", "path": "/", "name": "secret.conf", "from": from, "replace": true})
	if e := last(pages(r.wait("the upload to end", ended(32)), 32), "error"); e != nil {
		t.Fatalf("it failed: %v", e)
	}
	a, err := os.Stat(script)
	if err != nil || a.Mode().Perm() != 0o755 {
		t.Fatalf("the program it replaced is no longer executable: %v %v", err, a.Mode().Perm())
	}
	b, err := os.Stat(private)
	if err != nil || b.Mode().Perm() != 0o600 {
		t.Fatalf("the private file it replaced is no longer private: %v %v", err, b.Mode().Perm())
	}
}

// A link at that name is never written through: it points somewhere nobody chose. Nor is a folder.
func TestALinkOrAFolderAtThatNameIsNeverWrittenThrough(t *testing.T) {
	r, box := withFiles(t)
	if err := os.WriteFile(filepath.Join(box, "real.conf"), []byte("the file the link points at\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("real.conf", filepath.Join(box, "a-link")); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(box, "a-folder"), 0o755); err != nil {
		t.Fatal(err)
	}
	from, _ := writeOnThePC(t, 100)

	for i, name := range []string{"a-link", "a-folder"} {
		id := float64(41 + i)
		ask(t, r, map[string]any{"id": id, "do": "put", "path": "/", "name": name, "from": from, "replace": true})
		ps := pages(r.wait("the refusal", ended(id)), id)
		if last(ps, "error") != "in-the-way" {
			t.Fatalf("%q was written through: %v", name, ps)
		}
	}
	if b, _ := os.ReadFile(filepath.Join(box, "real.conf")); string(b) != "the file the link points at\n" {
		t.Fatalf("what the link pointed at was written over")
	}
}

// A box that does not agree about what arrived: nothing is put in place, and nothing of the app's is left on
// the box to be found later.
func TestAFileTheBoxDoesNotAgreeWithIsNeverPutInPlace(t *testing.T) {
	r, box := withFiles(t)
	from, _ := writeOnThePC(t, 2_000)
	r.box.AnswerCommandsWith(strings.Repeat("0", 64) + "  /tmp/whatever\n")

	ask(t, r, map[string]any{"id": 51, "do": "put", "path": "/", "name": "sent.bin", "from": from})
	ps := pages(r.wait("the refusal", ended(51)), 51)
	if last(ps, "error") != "not-the-same" {
		t.Fatalf("a file the box disagrees with was put in place: %v", ps)
	}
	left, _ := os.ReadDir(box)
	if len(left) != 0 {
		t.Fatalf("it left something on the box: %v", names(left))
	}
}

// A box that cannot hash at all: the file is still delivered, and said to be unchecked rather than checked.
func TestAFileABoxCannotHashIsStillSentAndSaidToBeUnchecked(t *testing.T) {
	r, box := withFiles(t)
	from, want := writeOnThePC(t, 1_500)
	r.box.AnswerCommandsWith("this box prints no hash at all\n")

	ask(t, r, map[string]any{"id": 61, "do": "put", "path": "/", "name": "sent.bin", "from": from})
	ps := pages(r.wait("the upload to end", ended(61)), 61)
	if e := last(ps, "error"); e != nil {
		t.Fatalf("it failed: %v (%v)", e, last(ps, "detail"))
	}
	if last(ps, "mark") != "not-checked" {
		t.Fatalf("it was not marked as unchecked: %v", ps)
	}
	if b, _ := os.ReadFile(filepath.Join(box, "sent.bin")); string(b) != string(want) {
		t.Fatalf("what the box holds is not what was sent")
	}
}

// Giving up on an upload: it stops, and the box is left with nothing of ours.
func TestAnUploadGivenUpOnLeavesNothingOnTheBox(t *testing.T) {
	r, box := withFiles(t)
	from, _ := writeOnThePC(t, 6<<20)
	hostile.Pace(40)
	t.Cleanup(func() { hostile.Pace(0) })

	ask(t, r, map[string]any{"id": 71, "do": "put", "path": "/", "name": "big.bin", "from": from})
	r.wait("it to be under way", func(fs []frame.Frame) bool {
		for _, p := range pages(fs, 71) {
			if g, ok := p["got"].(float64); ok && g > 0 {
				return true
			}
		}
		return false
	})
	// While it is still going, the box holds one hidden thing of the app's own and no file under the name it
	// will have: nothing on the box can open a half-written file or mistake it for whole.
	mid, _ := os.ReadDir(box)
	if len(mid) != 1 || !strings.HasPrefix(mid[0].Name(), ".berth-") || !strings.HasSuffix(mid[0].Name(), ".part") {
		t.Fatalf("while it was going the box held: %v", names(mid))
	}
	ask(t, r, map[string]any{"id": 71, "do": "cancel", "path": ""})
	ps := pages(r.wait("it to stop", ended(71)), 71)
	if last(ps, "landed") != nil {
		t.Fatalf("an upload that was given up on still said it landed: %v", ps)
	}
	for i := 0; i < 150; i++ {
		if left, _ := os.ReadDir(box); len(left) == 0 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	stayed, _ := os.ReadDir(box)
	t.Fatalf("it left its half-written file on the box: %v", names(stayed))
}

// A send that broke leaves what had arrived on the box, and the next try writes on from there. The hash still
// covers the whole file, so one put together from two tries is only put in place if the box agrees about all
// of it.
func TestASendThatBrokeIsTakenUpWhereItStopped(t *testing.T) {
	r, box := withFiles(t)
	const round = 32 * 32 * 1024 // one round of blocks: what a resume is held to
	from, want := writeOnThePC(t, 5*round)
	// Two whole rounds of it and a little of the third are already on the box, under the name a half-written
	// send has. A little of the third, and not two rounds exactly: a file that ends exactly on a round's own
	// mark says nothing about whether that round was whole, so the resume there is a round lower on purpose
	// (TestASendIsTakenUpBelowTheRoundItEndsOnNotAboveIt). What this one is about is writing on from where it
	// stopped rather than from the start.
	if err := os.WriteFile(filepath.Join(box, ".berth-sent.bin.part"), want[:2*round+100_000], 0o600); err != nil {
		t.Fatal(err)
	}

	ask(t, r, map[string]any{"id": 81, "do": "put", "path": "/", "name": "sent.bin", "from": from, "resume": true})
	ps := pages(r.wait("the upload to end", ended(81)), 81)
	if e := last(ps, "error"); e != nil {
		t.Fatalf("it failed: %v (%v)", e, last(ps, "detail"))
	}
	if last(ps, "resumedAt") != float64(2*round) {
		t.Fatalf("it did not say where it was taken up: %v", ps)
	}
	if last(ps, "mark") != "checked" {
		t.Fatalf("a file put together from two tries was not checked: %v", ps)
	}
	got, err := os.ReadFile(filepath.Join(box, "sent.bin"))
	if err != nil || string(got) != string(want) {
		t.Fatalf("what the box holds is not what was sent (%v, %d of %d)", err, len(got), len(want))
	}
	if left, _ := os.ReadDir(box); len(left) != 1 {
		t.Fatalf("the half-written file was left on the box: %v", names(left))
	}
}

// Half of something else on the box under the same name: the hash covers the whole file, so it is never put
// in place, and the wrong bytes are not kept.
func TestASendTakenUpFromTheWrongBytesIsNeverPutInPlace(t *testing.T) {
	r, box := withFiles(t)
	const round = 32 * 32 * 1024
	from, _ := writeOnThePC(t, 3*round)
	// A round of someone else's bytes and a little more: enough that the resume keeps a whole round of them
	// rather than writing over all of them, which is what leaves the hash with something to catch.
	if err := os.WriteFile(filepath.Join(box, ".berth-sent.bin.part"), make([]byte, round+100_000), 0o600); err != nil {
		t.Fatal(err)
	}

	ask(t, r, map[string]any{"id": 82, "do": "put", "path": "/", "name": "sent.bin", "from": from, "resume": true})
	ps := pages(r.wait("the refusal", ended(82)), 82)
	if last(ps, "error") != "not-the-same" {
		t.Fatalf("a file taken up from the wrong bytes was put in place: %v", ps)
	}
	if left, _ := os.ReadDir(box); len(left) != 0 {
		t.Fatalf("bytes known to be wrong were kept on the box: %v", names(left))
	}
}

// A send cut in the middle of a round leaves a file as long as the furthest block that landed, with gaps
// below it: the blocks of a round go on the wire at once and land in whatever order the box answers them.
// So a resume is held to the last whole round below that size, never to the size itself. Taking the size at
// its word left those gaps in the file for good, and on a box that cannot hash they would have been renamed
// into place and called "not checked" rather than wrong.
func TestASendIsTakenUpAtAWholeRoundAndNeverOverAHole(t *testing.T) {
	r, box := withFiles(t)
	const round = 32 * 32 * 1024
	from, want := writeOnThePC(t, 5*round)
	// What a cut round leaves: two whole rounds, then a stretch of the third with a hole in the middle of
	// it. The file is as long as the furthest block that landed.
	part := make([]byte, 2*round+300_000)
	copy(part, want[:2*round])
	copy(part[2*round+200_000:], want[2*round+200_000:2*round+300_000])
	if err := os.WriteFile(filepath.Join(box, ".berth-sent.bin.part"), part, 0o600); err != nil {
		t.Fatal(err)
	}

	ask(t, r, map[string]any{"id": 83, "do": "put", "path": "/", "name": "sent.bin", "from": from, "resume": true})
	ps := pages(r.wait("the upload to end", ended(83)), 83)
	if e := last(ps, "error"); e != nil {
		t.Fatalf("it failed: %v (%v)", e, last(ps, "detail"))
	}
	if last(ps, "resumedAt") != float64(2*round) {
		t.Fatalf("it was taken up at %v, which is not the last whole round: %v", last(ps, "resumedAt"), ps)
	}
	if last(ps, "mark") != "checked" {
		t.Fatalf("what was put together was not checked: %v", ps)
	}
	got, err := os.ReadFile(filepath.Join(box, "sent.bin"))
	if err != nil || string(got) != string(want) {
		t.Fatalf("the hole was left in the file (%v, %d of %d)", err, len(got), len(want))
	}
}

// A file being replaced keeps its own owner, not only its own mode. Only the mode was put back, so replacing
// a config owned by a service left it owned by whoever sent it and the service could no longer read its own
// file; a file owned by a user and carrying setuid became setuid root with the new contents. Only root may
// really set an owner, so what is proven here is that the box is asked, and asked for the owner the file it
// replaced had.
func TestAFileBeingReplacedKeepsItsOwner(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("a box reports no owner of this shape on Windows, so there is none to put back")
	}
	hostile.ForgetOwnerAsked()
	r, box := withFiles(t)
	writeOnTheBox(t, box, "conf.txt", 40)
	st, err := os.Stat(filepath.Join(box, "conf.txt"))
	if err != nil {
		t.Fatal(err)
	}
	uid, gid, have := hostileOwnerOf(st)
	if !have {
		t.Skip("this machine does not say who owns a file")
	}
	from, _ := writeOnThePC(t, 1000)

	ask(t, r, map[string]any{"id": 71, "do": "put", "path": "/", "name": "conf.txt", "from": from, "replace": true})
	ps := pages(r.wait("the send", ended(71)), 71)
	if e := last(ps, "error"); e != nil {
		t.Fatalf("it failed: %v (%v)", e, last(ps, "detail"))
	}
	name, askedUID, askedGID, asked := hostile.OwnerAsked()
	if !asked {
		t.Fatal("the box was never asked to put the owner back")
	}
	if askedUID != uid || askedGID != gid {
		t.Fatalf("it asked for %d:%d where the file it replaced was %d:%d (on %q)", askedUID, askedGID, uid, gid, name)
	}
}

// And the one size where "the last whole round below it" is not below it: a round's blocks land in whatever
// order the box answers them, so the round that was cut can leave its LAST block landed and the ones before
// it missing. The file is then exactly as long as the end of that round. Dividing by the round size and
// multiplying back gives that same size, so the resume began above a hole instead of below it, and the gap
// stayed in the file: thrown away at the end on a box that can hash, renamed into place and called "not
// checked" on one that cannot. The round a size falls on is as unfinished as the round it falls inside.
func TestASendIsTakenUpBelowTheRoundItEndsOnNotAboveIt(t *testing.T) {
	r, box := withFiles(t)
	const round = 32 * 32 * 1024
	from, want := writeOnThePC(t, 5*round)
	// What a round cut after its last block alone landed leaves: two whole rounds, then a third round whose
	// only real bytes are its final block. The file ends exactly on the round's own mark.
	part := make([]byte, 3*round)
	copy(part, want[:2*round])
	copy(part[3*round-32*1024:], want[3*round-32*1024:3*round])
	if err := os.WriteFile(filepath.Join(box, ".berth-sent.bin.part"), part, 0o600); err != nil {
		t.Fatal(err)
	}

	ask(t, r, map[string]any{"id": 84, "do": "put", "path": "/", "name": "sent.bin", "from": from, "resume": true})
	ps := pages(r.wait("the upload to end", ended(84)), 84)
	if at := last(ps, "resumedAt"); at != float64(2*round) {
		t.Fatalf("it was taken up at %v, above the hole: the round a size ends on is as unfinished as one it falls inside", at)
	}
	if e := last(ps, "error"); e != nil {
		t.Fatalf("it failed: %v (%v)", e, last(ps, "detail"))
	}
	got, err := os.ReadFile(filepath.Join(box, "sent.bin"))
	if err != nil || string(got) != string(want) {
		t.Fatalf("the hole was left in the file (%v, %d of %d)", err, len(got), len(want))
	}
}
