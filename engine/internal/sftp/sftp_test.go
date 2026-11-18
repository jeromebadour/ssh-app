package sftp

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"testing"
	"time"
)

// A stand-in box: it speaks the protocol back over a pipe and can be told to misbehave. The client is tested
// against what a box can really do, including the things a well-behaved one never does.
type box struct {
	t       *testing.T
	conn    net.Conn
	version []byte // what to answer the init with; nil means the usual
	onAsk   func(kind byte, id uint32, r *reader) (byte, []byte)
}

func (b *box) serve() {
	kind, body, err := readPacket(b.conn, nil)
	if err != nil || kind != fxpInit {
		return
	}
	_ = body
	if b.version != nil {
		_ = writePacket(b.conn, fxpVersion, b.version)
	} else {
		var w writer
		w.u32(3)
		w.string("posix-rename@openssh.com")
		w.string("1")
		w.string("statvfs@openssh.com")
		w.string("2")
		_ = writePacket(b.conn, fxpVersion, w.b)
	}
	for {
		kind, body, err := readPacket(b.conn, nil)
		if err != nil {
			return
		}
		r := &reader{b: body}
		id := r.u32()
		answerKind, answerBody := b.onAsk(kind, id, r)
		if answerKind == 0 {
			continue // say nothing at all, as a box that has stopped answering
		}
		var w writer
		w.u32(id)
		w.b = append(w.b, answerBody...)
		if err := writePacket(b.conn, answerKind, w.b); err != nil {
			return
		}
	}
}

func dial(t *testing.T, onAsk func(kind byte, id uint32, r *reader) (byte, []byte)) *Client {
	t.Helper()
	ours, theirs := net.Pipe()
	b := &box{t: t, conn: theirs, onAsk: onAsk}
	go b.serve()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, err := Start(ctx, ours)
	if err != nil {
		t.Fatalf("the protocol did not start: %v", err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func status(code uint32, say string) []byte {
	var w writer
	w.u32(code)
	w.string(say)
	w.string("")
	return w.b
}

func TestWhatTheBoxSaysItCanDo(t *testing.T) {
	c := dial(t, func(byte, uint32, *reader) (byte, []byte) { return fxpStatus, status(fxOK, "") })
	if !c.Can("posix-rename@openssh.com") || !c.Can("statvfs@openssh.com") {
		t.Fatal("the extensions the box offered were not taken in")
	}
	if c.Can("something-else") {
		t.Fatal("an extension the box never offered is said to be there")
	}
}

func TestAListingArrivesInPagesAndIsNeverHeldWhole(t *testing.T) {
	const pages, perPage = 5, 40
	sent := 0
	c := dial(t, func(kind byte, id uint32, r *reader) (byte, []byte) {
		switch kind {
		case fxpOpendir:
			var w writer
			w.string("h")
			return fxpHandle, w.b
		case fxpReaddir:
			if sent >= pages {
				return fxpStatus, status(fxEOF, "")
			}
			sent++
			var w writer
			w.u32(perPage + 2)
			// Every page carries "." and ".." too, as a real box does.
			for _, n := range []string{".", ".."} {
				w.string(n)
				w.string("")
				w.u32(attrPermissions)
				w.u32(0o040755)
			}
			for i := 0; i < perPage; i++ {
				w.string("file")
				w.string("")
				w.u32(attrSize | attrPermissions)
				w.u64(123)
				w.u32(0o100644)
			}
			return fxpName, w.b
		}
		return fxpStatus, status(fxOK, "")
	})

	got, pagesSeen := 0, 0
	err := c.List(context.Background(), "/x", func(e []Entry) error {
		pagesSeen++
		got += len(e)
		return nil
	})
	if err != nil {
		t.Fatalf("the listing failed: %v", err)
	}
	if pagesSeen != pages {
		t.Fatalf("the listing arrived in %d pages, not %d: it was not streamed", pagesSeen, pages)
	}
	if got != pages*perPage {
		t.Fatalf("%d entries, not %d (\".\" and \"..\" must not be among them)", got, pages*perPage)
	}
}

func TestAListingThatNeverEndsIsStopped(t *testing.T) {
	c := dial(t, func(kind byte, id uint32, r *reader) (byte, []byte) {
		switch kind {
		case fxpOpendir:
			var w writer
			w.string("h")
			return fxpHandle, w.b
		case fxpReaddir:
			var w writer
			w.u32(500)
			for i := 0; i < 500; i++ {
				w.string("f")
				w.string("")
				w.u32(0)
			}
			return fxpName, w.b
		}
		return fxpStatus, status(fxOK, "")
	})
	err := c.List(context.Background(), "/x", func([]Entry) error { return nil })
	if !errors.Is(err, ErrTooMany) {
		t.Fatalf("a listing that never ends gave %v, not ErrTooMany", err)
	}
}

func TestACallerThatGivesUpStopsWaiting(t *testing.T) {
	c := dial(t, func(byte, uint32, *reader) (byte, []byte) { return 0, nil }) // never answers
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(50 * time.Millisecond)
		cancel()
	}()
	start := time.Now()
	_, err := c.Realpath(ctx, ".")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("giving up gave %v, not a cancellation", err)
	}
	if took := time.Since(start); took > 5*time.Second {
		t.Fatalf("giving up took %s: the deadline, not the caller, ended it", took)
	}
}

func TestARefusalIsSaidAsItself(t *testing.T) {
	for _, c := range []struct {
		code uint32
		want error
	}{
		{fxNoSuchFile, ErrNoSuchFile},
		{fxPermissionDenied, ErrDenied},
		{fxOpUnsupported, ErrUnsupported},
	} {
		cl := dial(t, func(byte, uint32, *reader) (byte, []byte) { return fxpStatus, status(c.code, "no") })
		_, err := cl.Stat(context.Background(), "/x")
		if !errors.Is(err, c.want) {
			t.Fatalf("code %d gave %v, not %v", c.code, err, c.want)
		}
	}
}

func TestAnAnswerToNothingEndsIt(t *testing.T) {
	ours, theirs := net.Pipe()
	go func() {
		_, _, _ = readPacket(theirs, nil)
		var w writer
		w.u32(3)
		_ = writePacket(theirs, fxpVersion, w.b)
		// An answer to a request nobody made.
		var a writer
		a.u32(9999)
		a.u32(fxOK)
		a.string("")
		a.string("")
		_ = writePacket(theirs, fxpStatus, a.b)
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, err := Start(ctx, ours)
	if err != nil {
		t.Fatal(err)
	}
	// The link is given up, so the next thing asked fails at once rather than hanging.
	done := make(chan error, 1)
	go func() {
		_, err := c.Realpath(context.Background(), ".")
		done <- err
	}()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("a box that answers requests nobody made was kept")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("an answer to nothing left the client waiting")
	}
}

func TestAPacketLargerThanThisClientReadsIsRefused(t *testing.T) {
	ours, theirs := net.Pipe()
	go func() {
		_, _, _ = readPacket(theirs, nil)
		var head [4]byte
		binary.BigEndian.PutUint32(head[:], maxPacket+1)
		_, _ = theirs.Write(head[:])
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := Start(ctx, ours); !errors.Is(err, ErrTooLong) {
		t.Fatalf("a packet of %d bytes gave %v, not ErrTooLong", maxPacket+1, err)
	}
}

func TestFreeSpaceIsWhatThisUserMayUse(t *testing.T) {
	c := dial(t, func(kind byte, id uint32, r *reader) (byte, []byte) {
		if kind != fxpExtended {
			return fxpStatus, status(fxOK, "")
		}
		var w writer
		w.u64(4096) // f_bsize
		w.u64(4096) // f_frsize
		w.u64(1000) // f_blocks
		w.u64(500)  // f_bfree, free to root
		w.u64(100)  // f_bavail, free to this user
		w.u64(0)
		w.u64(0)
		w.u64(0)
		w.u64(0)
		w.u64(0)
		w.u64(255)
		return fxpExtendedReply, w.b
	})
	s, err := c.Space(context.Background(), "/x")
	if err != nil {
		t.Fatal(err)
	}
	if s.Total != 4096*1000 || s.Free != 4096*100 {
		t.Fatalf("total %d free %d: free must be what this user may use, not what root may", s.Total, s.Free)
	}
}

// A box choosing enormous numbers must not make this client say a full disk is empty.
func TestSpaceNumbersDoNotWrapRound(t *testing.T) {
	if got := times(^uint64(0), 2); got != ^uint64(0) {
		t.Fatalf("a product that cannot be held came out as %d", got)
	}
	if got := times(0, 5); got != 0 {
		t.Fatalf("a block size of nothing came out as %d", got)
	}
}

// Whatever a box sends, reading it never panics and never asks for memory it was not given.
func FuzzReadPacket(f *testing.F) {
	f.Add([]byte{0, 0, 0, 5, fxpStatus, 0, 0, 0, 0})
	f.Add([]byte{0, 0, 0, 1, fxpVersion})
	f.Fuzz(func(t *testing.T, in []byte) {
		kind, body, err := readPacket(newReaderOf(in), nil)
		if err != nil {
			return
		}
		r := &reader{b: body}
		switch kind {
		case fxpName:
			n := r.u32()
			for i := uint32(0); i < n && r.ok() && i < MaxEntries; i++ {
				r.str()
				r.str()
				takeAttrs(r)
			}
		case fxpAttrs:
			takeAttrs(r)
		default:
			r.u32()
			r.str()
		}
	})
}

func newReaderOf(b []byte) io.Reader { return &slow{b: b} }

// slow hands bytes over a few at a time, as a network does, so the reading is tested the way it is really used.
type slow struct{ b []byte }

func (s *slow) Read(p []byte) (int, error) {
	if len(s.b) == 0 {
		return 0, io.EOF
	}
	n := 1
	if len(p) < n {
		n = len(p)
	}
	copy(p, s.b[:n])
	s.b = s.b[n:]
	return n, nil
}

// A box that answers a read with more than was asked for is not quietly trusted: a client that copied whatever
// arrived into a caller's buffer would be writing past what the caller sized for.
func TestABoxCannotAnswerAReadWithMoreThanWasAsked(t *testing.T) {
	c := dial(t, func(kind byte, id uint32, r *reader) (byte, []byte) {
		switch kind {
		case fxpOpen:
			var w writer
			w.string("h")
			return fxpHandle, w.b
		case fxpRead:
			r.str()
			r.u64()
			want := r.u32()
			var w writer
			w.str(make([]byte, want+16)) // more than was asked for
			return fxpData, w.b
		}
		return fxpStatus, status(fxOK, "")
	})
	f, err := c.Open(context.Background(), "/x")
	if err != nil {
		t.Fatal(err)
	}
	p := make([]byte, 64)
	if _, err := f.ReadAt(context.Background(), p, 0); !errors.Is(err, ErrTooLong) {
		t.Fatalf("a read answered with too much gave %v, not ErrTooLong", err)
	}
}

// Reading and writing name the place in the file, so nothing rests on a position the box keeps.
func TestReadsAndWritesNameTheirPlace(t *testing.T) {
	var readAt, wroteAt uint64
	var wrote []byte
	c := dial(t, func(kind byte, id uint32, r *reader) (byte, []byte) {
		switch kind {
		case fxpOpen:
			var w writer
			w.string("h")
			return fxpHandle, w.b
		case fxpRead:
			r.str()
			readAt = r.u64()
			want := r.u32()
			var w writer
			w.str(make([]byte, want/2)) // less than asked for, which a box may do
			return fxpData, w.b
		case fxpWrite:
			r.str()
			wroteAt = r.u64()
			wrote = append([]byte(nil), r.str()...)
			return fxpStatus, status(fxOK, "")
		}
		return fxpStatus, status(fxOK, "")
	})
	f, err := c.Open(context.Background(), "/x")
	if err != nil {
		t.Fatal(err)
	}
	p := make([]byte, 100)
	n, err := f.ReadAt(context.Background(), p, 4096)
	if err != nil || n != 50 {
		t.Fatalf("read gave %d, %v", n, err)
	}
	if readAt != 4096 {
		t.Fatalf("the read asked at %d, not 4096", readAt)
	}
	if _, err := f.WriteAt(context.Background(), []byte("hello"), 8192); err != nil {
		t.Fatal(err)
	}
	if wroteAt != 8192 || string(wrote) != "hello" {
		t.Fatalf("the write went to %d with %q", wroteAt, wrote)
	}
}

// The end of a file is the end, not a failure.
func TestTheEndOfAFileIsSaidAsTheEnd(t *testing.T) {
	c := dial(t, func(kind byte, id uint32, r *reader) (byte, []byte) {
		if kind == fxpOpen {
			var w writer
			w.string("h")
			return fxpHandle, w.b
		}
		if kind == fxpRead {
			return fxpStatus, status(fxEOF, "")
		}
		return fxpStatus, status(fxOK, "")
	})
	f, err := c.Open(context.Background(), "/x")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.ReadAt(context.Background(), make([]byte, 8), 0); !errors.Is(err, io.EOF) {
		t.Fatalf("the end of the file gave %v, not io.EOF", err)
	}
}

// A write larger than one block is refused here rather than cut to fit, because a caller that sent one is
// wrong about what it is doing and silently writing part of it would be worse.
func TestAWriteLargerThanOneBlockIsRefused(t *testing.T) {
	c := dial(t, func(kind byte, id uint32, r *reader) (byte, []byte) {
		if kind == fxpOpen {
			var w writer
			w.string("h")
			return fxpHandle, w.b
		}
		return fxpStatus, status(fxOK, "")
	})
	f, err := c.Open(context.Background(), "/x")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteAt(context.Background(), make([]byte, Block+1), 0); !errors.Is(err, ErrTooLong) {
		t.Fatalf("an oversized write gave %v, not ErrTooLong", err)
	}
}

// A request given up on is still ours: the answer that arrives later is dropped, and the link goes on. A
// person moving quickly through folders leaves these behind constantly, and ending the link for one would
// break the file browser exactly when it is being used hardest.
func TestAnAnswerToSomethingGivenUpOnDoesNotEndTheLink(t *testing.T) {
	answer := make(chan struct{})
	c := dial(t, func(kind byte, id uint32, r *reader) (byte, []byte) {
		if kind == fxpRealpath {
			// Answer only once released, which is after the caller has given up.
			<-answer
			var w writer
			w.u32(1)
			w.string("/somewhere")
			w.string("/somewhere")
			w.u32(0)
			return fxpName, w.b
		}
		return fxpStatus, status(fxOK, "")
	})

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(50 * time.Millisecond)
		cancel()
	}()
	if _, err := c.Realpath(ctx, "."); !errors.Is(err, context.Canceled) {
		t.Fatalf("giving up gave %v", err)
	}
	close(answer) // the box answers the request that was given up on
	time.Sleep(100 * time.Millisecond)

	// The link is still usable: the next thing asked is answered.
	done, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	if _, err := c.Stat(done, "/x"); err != nil {
		t.Fatalf("after a late answer to a request given up on, the link gave %v", err)
	}
}

// The owner's name comes out of the long form a box prints for `ls -l`, which is the only place the protocol
// carries it in words. That line is a convention and not a promise, so what matters as much as reading it is
// giving nothing back when the line is not that shape: a word taken from the wrong field would be shown to a
// person as the owner of his file, and he would have no way of knowing it was guessed.
func TestOwnerOfTheLongForm(t *testing.T) {
	for _, c := range []struct {
		long, want string
	}{
		{"-rw-r--r--   1 root     wheel          28 Nov 19 02:00 syslog", "root"},
		{"drwxr-xr-x   4 ubuntu   ubuntu       4096 Oct 15 11:20 ledger", "ubuntu"},
		{"lrwxrwxrwx   1 1000     1000           11 Oct 15 11:20 current -> syslog", "1000"},
		{"-rw-------   1 www-data www-data    198411 Jan  3  2025 access.log", "www-data"},
		// Not that shape, so nothing: a box that answers its own way is not read as if it were OpenSSH.
		{"", ""},
		{"syslog", ""},
		{"a line a box made up with plenty of fields in it but no mode", ""},
		{"-rw-r--r-- root wheel 28 syslog", ""},
		{"?rw-r--r--   1 root     wheel          28 Nov 19 02:00 syslog", ""},
		{"-rw-r--r-   1 root     wheel          28 Nov 19 02:00 syslog", ""},
		{"-rw-r--r--   1 ro\x01ot    wheel          28 Nov 19 02:00 syslog", ""},
	} {
		if got := ownerOf(c.long); got != c.want {
			t.Errorf("ownerOf(%q) = %q, wanted %q", c.long, got, c.want)
		}
	}
}
