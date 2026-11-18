package sftp_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
	"sshapp/engine/internal/lab/faultproxy"
	"sshapp/engine/internal/lab/hostile"
	"sshapp/engine/internal/link"
	sshappsftp "sshapp/engine/internal/sftp"
)

func newSigner(t *testing.T) ssh.Signer {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	s, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// How fast the bulk path really is when the box is not next door. One request at a time means one round
// trip per block, so the distance, not the link, decides the speed. This is the measurement plan B4.1 asks
// for before the decision to write our own layer is kept.
func TestHowFastTheBulkPathIsAtADistance(t *testing.T) {
	if testing.Short() {
		t.Skip("short")
	}
	dir := t.TempDir()
	big := filepath.Join(dir, "big.bin")
	const size = 4 << 20
	b := make([]byte, size)
	if _, err := rand.Read(b[:1<<16]); err != nil {
		t.Fatal(err)
	}
	for at := 1 << 16; at < size; at += 1 << 16 {
		copy(b[at:], b[:1<<16])
	}
	if err := os.WriteFile(big, b, 0o600); err != nil {
		t.Fatal(err)
	}
	host, user := newSigner(t), newSigner(t)
	box, err := hostile.Start(hostile.Config{HostSigner: host, Accept: user.PublicKey(), Sessions: true, FilesUnder: dir})
	if err != nil {
		t.Fatal(err)
	}
	defer box.Close()
	proxy, err := faultproxy.Listen(box.Addr())
	if err != nil {
		t.Fatal(err)
	}
	defer proxy.Close()
	for _, oneWay := range []time.Duration{0, 25 * time.Millisecond} {
		proxy.Set(faultproxy.Faults{Delay: oneWay})
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Minute)
		l, err := link.Dial(ctx, link.Target{Addr: proxy.Addr(), User: "demo", HostKey: host.PublicKey()}, user, link.Options{})
		if err != nil {
			stop()
			t.Fatalf("delay %v: %v", oneWay, err)
		}
		files, err := l.OpenFiles(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		c, err := sshappsftp.Start(ctx, files)
		if err != nil {
			t.Fatal(err)
		}
		f, err := c.Open(ctx, "/big.bin")
		if err != nil {
			t.Fatal(err)
		}
		began := time.Now()
		var got uint64
		if err := f.ReadInOrder(ctx, 0, func(p []byte, at uint64) error {
			if at != got {
				t.Fatalf("a block arrived at %d where %d was due: the bytes must reach the hash in the order they sit in the file", at, got)
			}
			got += uint64(len(p))
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		if got != size {
			t.Fatalf("read %d bytes of %d", got, size)
		}
		took := time.Since(began)
		rate := float64(size>>20) / took.Seconds()
		t.Logf("%d MiB with %v each way: %v, %.2f MiB/s", size>>20, oneWay, took.Round(time.Millisecond), rate)
		// The gate the measurement exists for: at this distance a plain one-ask-at-a-time loop gives about
		// 0.6 MiB/s, which is most of a day for a 5 GB file. Anything near that number is the loop back.
		if oneWay > 0 && rate < 5 {
			t.Fatalf("the bulk path gives %.2f MiB/s at %v each way; one ask at a time gives about 0.6", rate, oneWay)
		}
		c.Close()
		l.Close()
		stop()
	}
}

// A box that answers a read with nothing at all, and never says the file has ended, used to be asked again
// from the same place for ever: tens of thousands of asks a second, going nowhere, until somebody pressed
// Stop. It is called not answering now, after a few rounds, and said as that.
func TestABoxThatAnswersWithNothingIsNotAskedForEver(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "x.bin"), make([]byte, 1<<20), 0o600); err != nil {
		t.Fatal(err)
	}
	host, user := newSigner(t), newSigner(t)
	box, err := hostile.Start(hostile.Config{HostSigner: host, Accept: user.PublicKey(), Sessions: true, FilesUnder: dir})
	if err != nil {
		t.Fatal(err)
	}
	defer box.Close()
	box.AnswerReadsWithNothing(true)
	ctx, stop := context.WithTimeout(context.Background(), 30*time.Second)
	defer stop()
	l, err := link.Dial(ctx, link.Target{Addr: box.Addr(), User: "demo", HostKey: host.PublicKey()}, user, link.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	files, err := l.OpenFiles(ctx)
	if err != nil {
		t.Fatal(err)
	}
	c, err := sshappsftp.Start(ctx, files)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	f, err := c.Open(ctx, "/x.bin")
	if err != nil {
		t.Fatal(err)
	}
	began := time.Now()
	err = f.ReadInOrder(ctx, 0, func([]byte, uint64) error { return nil })
	if !errors.Is(err, sshappsftp.ErrNotAnswering) {
		t.Fatalf("it gave %v where it should have said the box is not answering", err)
	}
	if took := time.Since(began); took > 20*time.Second {
		t.Fatalf("it took %v to say so", took)
	}
}
